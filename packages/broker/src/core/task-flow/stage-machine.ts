// Lane L6a, task flow core: the stage machine's driver. The transitions themselves are the pure functions in `@agentx/contracts`
// (`task-workflow-node.ts`: `startWorkflowUnderstand`, `recordIntentAssessment`, `submitWorkflowArtifact`, ...). This module is what Cloud's
// `developer-tasks/workflow-starts.ts` and the broker's result hook do around them: read the task, apply one transition, and write the new
// snapshot (fenced on the revision it was computed from) in the same transaction as the operation that carries the step out.
//
// A step is: [task.workflow := next (if revision = r)] + [workspace := BUSY under a new fence] + [the operation and its staged message]
// + [whatever else must commit with it, such as resolving the dispatch row]. If the transaction does not apply, nothing happened.
import { createHash } from "node:crypto";
import {
  AgentXError,
  agentXError,
  ROVARA_CODE_AGENT_ID,
  WORKFLOW_BLOCK_REASONS,
  WorkflowSnapshotSchema,
  WorkflowTransitionError,
  answerWorkflowIntent,
  blockWorkflow,
  change,
  isContextSourceStage,
  recordIntentAssessment,
  startWorkflowPlanAfterUnderstand,
  startWorkflowPlanWithoutUnderstand,
  startWorkflowUnderstand,
  submitWorkflowArtifact,
  when,
  workflowRequestId,
  type DesignReviewBinding,
  type DocumentKey,
  type JsonValue,
  type Operation,
  type PlanDocument,
  type RunEstimate,
  type TransactItem,
  type WorkflowDependencyInvocation,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { workflowDocumentType } from "../../developer/workflow-messages.js";
import { estimatePathOf, estimateRun } from "../cost/estimate.js";
import { estimateTier, recordTier } from "../decisions/change-tier.js";
import { planFiles } from "../decisions/plan-facts.js";
import { isReapprovalStop, settleLiveSteerReapproval } from "../sessions/live-steer-reapproval.js";
import { clearLiveDeliveredSince } from "../sessions/steer.js";
import { notesFedUpdate, stepNotes, type NotesForStep } from "../sessions/notes.js";
import { textReaderOf } from "../build-step/plan-input.js";
import { buildOperation, assertPromptFits } from "./accept.js";
import type { TaskFlowDeps } from "./deps.js";
import { dispatchRowItem, dueDispatchRows, rescheduleRowItem, resolveRowItem } from "./dispatch-rows.js";
import { dispatchRowKey, operationRequestKey, taskKey, taskPointerKey, workspaceKey } from "./keys.js";
import { structuredPlanContextOf } from "../plan/context.js";
import { planUnreadablePrompt } from "../plan/process.js";
import { readTask } from "./reads.js";
import { fromDocument, READING_DISPATCH_KINDS, toDocument, type DispatchRowRecord, type DispatchSpec, type MaintenanceExpectation, type OperationRecord, type PublicationExpectation, type TaskPointerRecord, type TaskRecord, type WorkspaceRecord } from "./records.js";
import type { SecondReviewOperationPlan } from "../second-review/store.js";
import { DEFAULT_PROMPTS, iso, log } from "./support.js";
import { workflowWriteOps } from "./flow-guard.js";
import { UNDERSTAND_SKIPS, afterUnderstand, restoredForPlanning, smallPlanRoute, toFull } from "./stage-selection.js";
import { isExplicitPath } from "../../rovara-code/explicit-path.js";
import type { StepOutcome } from "./outcome.js";
import { knowledgeCommitToStore } from "../meta-repo/prepare-meta.js";
import { SETUP_AGENT_FEATURE } from "@agentx/contracts";
import { setupAgentWireOf } from "../setup-agent/agent.js";
import { endSetupAgentTask } from "../setup-agent/end.js";
import { closeSetupCheck } from "../setup-agent/check.js";

type ChangeOp = ReturnType<typeof change.set>;

export type StepStart = "STARTED" | "DUPLICATE" | "STALE" | "WAITING";

const WAIT_SECONDS = 15;
/** A row that has waited this long for the workspace is given up on (the worker that holds it is not going to answer). */
export const WAIT_ROW_MAX_SECONDS = 3_600;
/** After this many failed tries a row's step is given up on and the task blocks, naming the step. */
export const DISPATCH_ROW_ATTEMPTS_MAX = 8;
const backoffSeconds = (attempts: number): number => Math.min(15 * 60, 15 * 2 ** Math.max(0, attempts - 1));
const later = (deps: Pick<TaskFlowDeps, "now">, seconds: number): string => new Date((deps.now?.() ?? new Date()).getTime() + seconds * 1_000).toISOString();

export async function readWorkspace(deps: Pick<TaskFlowDeps, "store">, workspaceId: string): Promise<WorkspaceRecord | undefined> {
  return fromDocument<WorkspaceRecord>(await deps.store.get(workspaceKey(workspaceId)));
}

/** The workspace steps that hand it to one operation: BUSY, held by it, under the next fence. Applies only to a ready workspace nobody holds, at the fence read. */
export function holdWorkspaceItem(workspace: WorkspaceRecord, operationId: string, now: string): TransactItem {
  return {
    kind: "update",
    key: workspaceKey(workspace.id),
    ops: [change.set("status", "BUSY"), change.set("activeOperationId", operationId), change.set("fence", workspace.fence + 1), change.set("updatedAt", now)],
    condition: when.and(when.eq("status", "READY"), when.eq("activeOperationId", null), when.eq("fence", workspace.fence)),
  };
}

export interface StepInput {
  task: TaskRecord;
  workspace: WorkspaceRecord;
  /** The idempotency name of this step: the same request id answers with the operation it made the first time. */
  requestId: string;
  prompt: string;
  /** The server-selected tool boundary of the step; absent for a plain task's. */
  workflowMode?: Operation["workflowMode"];
  /** The workflow after this step's transition, and the revision it was computed from (a plain task has neither). */
  workflow?: { current: WorkflowSnapshot; next: WorkflowSnapshot };
  /** Rows and records that must commit with the step. */
  extra?: readonly TransactItem[];
  /** Worker features the step cannot run without. */
  requires?: readonly string[];
  /**
   * What kind of operation the step is: a workflow task step (the default), or the publication of the checked code (lane L10), which carries its own payload and no prompt. A workflow task's
   * workspace takes a publication without a workflow mode, since a publication is the flow's own step and not an ordinary run.
   */
  kind?: "task" | "publish" | "maintain";
  /** More of the worker's payload (a coding run's check commands and base, a publication's branch and tree). Never a secret: grants and capabilities are issued at delivery. */
  payload?: Record<string, JsonValue>;
  /** A publication's expectation, kept on the operation for the pull request callback to be held to. */
  publication?: PublicationExpectation;
  /** A push to an open pull request's expectation, kept on the operation for the update callback to be held to. */
  maintenance?: MaintenanceExpectation;
  /** Callback actions beyond the three every operation has. */
  extraActions?: readonly string[];
  /** The id the operation is made with, when the caller needs it before the operation exists (a publication names its branch after it). */
  operationId?: string;
  /** The program step the operation runs (the plan check's), recorded on it. */
  programStepId?: string;
  /** A conversation of the step's own (the plan check never shares the planner's); the caller writes its record with the step. Default: the task's conversation. */
  conversationId?: string;
  /** An ordered coding run's binding (spec 059), kept on the operation record. Its payload copy is in `payload.workflowDependencies`. */
  workflowDependencies?: WorkflowDependencyInvocation;
  /** A line for the operation's timeline (why parts run one after another, say), written with it as its first event. */
  firstEvent?: string;
  /** The people's messages this step was given (`acceptStepWithNotes` reads them): the task's mark moves past them in the step's own transaction, which holds only while the note count is the one read. */
  notes?: NotesForStep;
  /** A REVIEW step's second-review plan, kept on the operation for the review end. */
  secondReviewPlan?: SecondReviewOperationPlan;
  /** Design review: the round's binding and the source that serves its model, kept on the operation. */
  designReview?: DesignReviewBinding;
  modelSourceId?: string;
}

/** Accepts the operation for one step. `STALE` and `WAITING` write nothing. */
export async function acceptStep(deps: TaskFlowDeps, input: StepInput): Promise<{ result: StepStart; operation?: OperationRecord }> {
  assertPromptFits(input.prompt);
  const { task, workspace } = input;
  // A workflow task's workspace takes only the workflow's own steps, each with its server-selected tool boundary: a plain write-capable run is refused
  // (Cloud's GATED_TASK_TURN_REFUSAL).
  const operationKind = input.kind ?? "task";
  if (task.workflow !== undefined && input.workflowMode === undefined && operationKind === "task") throw agentXError("TASK_BUSY", "this task runs as a workflow: its steps are started by the workflow, not as ordinary runs");
  const existing = await deps.store.get(operationRequestKey(workspace.ownerKey, workspace.id, input.requestId));
  if (existing !== undefined) return { result: "DUPLICATE" };
  if (workspace.status !== "READY" || workspace.activeOperationId !== null) return { result: "WAITING" };
  // The person the step runs for must still be allowed to have it run, asked now and fenced into the step's own transaction.
  const permitted = await deps.access.checkStep(task);
  if (!permitted.allowed) {
    if (task.workflow !== undefined) await blockTaskWorkflow(deps, task.taskId, task.workflow.revision, permitted.message);
    return { result: "STALE" };
  }
  // A stage that may read the project's sources and has some gets the capability to ask for them, and only on a worker that can use them. Build never does.
  // (A design review reviewer reads its packet, which already holds the project's source items, so it gets no capability of its own.)
  const withSources = operationKind === "task" && input.workflowMode !== undefined && deps.contextSources !== undefined && isContextSourceStage(input.workflowMode)
    && input.designReview === undefined
    && await deps.contextSources.stageHasSources({ project: task.project }, input.workflowMode);
  const now = iso(deps);
  const fed = input.notes === undefined ? undefined : notesFedUpdate(input.notes);
  const workflowRevision = input.workflow?.next.revision ?? task.workflow?.revision;
  const built = buildOperation(deps, {
    workspace: { id: workspace.id, ownerKey: workspace.ownerKey, fence: workspace.fence + 1 },
    kind: operationKind, requestId: input.requestId, now, ...(input.operationId === undefined ? {} : { operationId: input.operationId }), ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
    conversationId: input.conversationId ?? task.conversationId,
    ...(input.programStepId === undefined ? {} : { programStepId: input.programStepId }),
    ...(workflowRevision === undefined ? {} : { workflowRevision }),
    ...(input.publication === undefined ? {} : { publication: input.publication }),
    ...(input.maintenance === undefined ? {} : { maintenance: input.maintenance }),
    ...(input.workflowDependencies === undefined ? {} : { workflowDependencies: input.workflowDependencies }),
    ...(input.firstEvent === undefined ? {} : { firstEvent: input.firstEvent }),
    ...(input.secondReviewPlan === undefined ? {} : { secondReviewPlan: input.secondReviewPlan }),
    ...(input.designReview === undefined ? {} : { designReview: input.designReview }),
    ...(input.modelSourceId === undefined ? {} : { modelSourceId: input.modelSourceId }),
    dispatch: {
      kind: operationKind, projectRevision: workspace.projectRevision,
      payload: operationKind !== "task"
        ? { ...input.payload }
        : { conversationId: input.conversationId ?? task.conversationId, prompt: input.prompt, ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }), ...input.payload, ...(withSources ? { contextSources: true } : {}) },
      ...(input.requires === undefined && !withSources ? {} : { requires: [...(input.requires ?? []), ...(withSources ? ["task.contextSources.v1"] : [])] }),
      ...(input.extraActions === undefined && !withSources ? {} : { extraActions: [...(input.extraActions ?? []), ...(withSources ? ["context-tools"] : [])] }),
    },
    requester: { personId: task.developerId, provider: task.provider },
  });
  const workflowWrite = input.workflow === undefined ? undefined : workflowWriteOps(input.workflow.current, input.workflow.next, { ownsFlow: true });
  const items: TransactItem[] = [
    {
      kind: "update",
      key: taskKey(task.taskId),
      ops: [...(workflowWrite === undefined ? [] : workflowWrite.ops), change.set("updatedAt", now), ...(fed === undefined ? [] : fed.ops)],
      condition: when.and(when.notExists("closedAt"), ...(input.workflow === undefined ? [] : [when.eq(["workflow", "revision"], input.workflow.current.revision), ...(workflowWrite?.guard ?? [])]), ...(fed === undefined ? [] : [fed.condition])),
    },
    holdWorkspaceItem(workspace, built.operation.id, now),
    ...built.items,
    ...(permitted.items ?? []),
    ...(input.extra ?? []),
  ];
  const applied = await deps.store.transact(items);
  if (applied.applied) {
    // Handed to its queue now; a relay from a timer does it too if this one is lost, so a failure here never fails the step.
    await deps.outbox.relay({ companyId: deps.companyId, ids: [built.operation.id] }).catch((error: unknown) => log(deps, { event: "task_flow.relay_failed", error: error instanceof Error ? error.name : "unknown" }));
    return { result: "STARTED", operation: built.operation };
  }
  // Why it did not apply: the same request committed first, the workspace is taken, or the task moved on.
  if (await deps.store.get(operationRequestKey(workspace.ownerKey, workspace.id, input.requestId)) !== undefined) return { result: "DUPLICATE" };
  const fresh = await readWorkspace(deps, workspace.id);
  if (fresh !== undefined && (fresh.status !== "READY" || fresh.activeOperationId !== null || fresh.fence !== workspace.fence) && fresh.status !== "CLOSED" && fresh.status !== "PREPARATION_FAILED") return { result: "WAITING" };
  return { result: "STALE" };
}

/**
 * `acceptStep` for a step that reads the people's messages (understanding, planning, coding): the notes no step has been given are put after the prompt, and the task's mark moves past them in the step's own
 * transaction. A note saved between the read and the commit fails that transaction on the note count, and the step is then read again with it (up to three times); any other refusal is `acceptStep`'s.
 */
export async function acceptStepWithNotes(deps: TaskFlowDeps, input: StepInput): Promise<{ result: StepStart; operation?: OperationRecord }> {
  // The flip-back setting: with step notes off a step reads none (the notes are still saved), exactly as before notes were read.
  if (deps.stepNotes === false) return acceptStep(deps, input);
  let task = input.task;
  for (let attempt = 1; ; attempt += 1) {
    const notes = await stepNotes(deps.store, task, input.requestId);
    const accepted = await acceptStep(deps, { ...input, task, prompt: `${input.prompt}${notes.suffix}`, notes });
    if (accepted.result !== "STALE" || attempt >= 3) return accepted;
    const fresh = await readTask(deps, task.taskId);
    // Only a note saved meanwhile is worth another read: the workflow is as it was and the count moved.
    if (fresh?.workflow === undefined || fresh.workflow.revision !== task.workflow?.revision || fresh.threadNoteCount === notes.noteCount) return accepted;
    task = fresh;
  }
}

/** Applies one workflow transition with no operation (a result recorded, a block), fenced on the revision it was computed from. False when the task moved on. */
export async function commitWorkflow(deps: TaskFlowDeps, task: TaskRecord, next: WorkflowSnapshot, extra: readonly TransactItem[] = [], taskOps: readonly ChangeOp[] = []): Promise<boolean> {
  const current = task.workflow;
  if (current === undefined) return false;
  const write = workflowWriteOps(current, next, { ownsFlow: true });
  const result = await deps.store.transact([
    {
      kind: "update", key: taskKey(task.taskId), ops: [...write.ops, ...taskOps, change.set("updatedAt", iso(deps))],
      condition: when.and(when.notExists("closedAt"), when.eq(["workflow", "revision"], current.revision), ...write.guard),
    },
    ...extra,
  ]);
  return result.applied;
}

/** The workflow, blocked with a reason the owner reads. A task that moved on is left alone. */
export async function blockTaskWorkflow(deps: TaskFlowDeps, taskId: string, expectedRevision: number, reason: string): Promise<void> {
  const task = await readTask(deps, taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== expectedRevision || workflow.state === "COMPLETE") return;
  try {
    await commitWorkflow(deps, task, blockWorkflow(workflow, reason, iso(deps)));
  } catch (error) {
    if (!(error instanceof WorkflowTransitionError)) throw error;
  }
}

// ---- The dispatch rows: the steps that start with no one asking ----

/** The changes the owner asked for in earlier plans of this task, oldest first (`PLAN_FEEDBACK#<revision>` items written with the decision). */
export const PLAN_FEEDBACK_SK_PREFIX = "PLAN_FEEDBACK#";
export const planFeedbackKey = (taskId: string, revision: number): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: `${PLAN_FEEDBACK_SK_PREFIX}${String(revision).padStart(8, "0")}` });
export const PLAN_FEEDBACK_MAX = 20;
/** The newest `PLAN_FEEDBACK_MAX` requests for changes, oldest first: after a long back-and-forth the latest words are never the ones left out. */
export async function planFeedbackOf(deps: Pick<TaskFlowDeps, "store">, taskId: string): Promise<string[]> {
  const page = await deps.store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: PLAN_FEEDBACK_SK_PREFIX }, descending: true, limit: PLAN_FEEDBACK_MAX });
  return page.items.reverse().flatMap((item) => (typeof item["text"] === "string" ? [item["text"]] : []));
}

type PlanKind = "requirements" | "design" | "plan";

/**
 * What a planning run is given besides the request: the documents of the earlier phases the owner approved (a Full task's design is written from its requirements), and the earlier version of
 * the document being written again after a request for changes. A document that cannot be read (missing, or no longer matching its digest) is left out; the run then plans without it.
 */
export async function planContextOf(deps: Pick<TaskFlowDeps, "artifacts">, workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase" | "artifacts">): Promise<{ earlier: Array<{ kind: PlanKind; markdown: string }>; previous?: string }> {
  if (deps.artifacts === undefined) return { earlier: [] };
  const current: PlanKind = workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan" : workflow.reviewPhase === "DESIGN" ? "design" : "requirements";
  const order: PlanKind[] = ["requirements", "design", "plan"];
  const read = async (kind: PlanKind): Promise<string | undefined> => {
    const artifact = workflow.artifacts.filter((entry) => entry.type === kind).at(-1);
    if (artifact === undefined) return undefined;
    try {
      return (await loadWorkflowDocument(textReaderOf(deps.artifacts), artifact, { answers: "recommended" }))?.markdown;
    } catch {
      return undefined;
    }
  };
  const earlier: Array<{ kind: PlanKind; markdown: string }> = [];
  if (workflow.path === "FULL") {
    for (const kind of order.slice(0, order.indexOf(current))) {
      const markdown = await read(kind);
      if (markdown !== undefined) earlier.push({ kind, markdown });
    }
  }
  const previous = await read(current);
  return { earlier, ...(previous === undefined ? {} : { previous }) };
}

/** Cloud's `startTaskWorkflowUnderstandFromSystem` and `startTaskWorkflowPlanFromSystem`, on the ports. */
export async function runDispatchRow(deps: TaskFlowDeps, row: Pick<DispatchRowRecord, "taskId" | "workflowRevision" | "kind">): Promise<StepStart> {
  // Any step after the plan (coding, reviews, the publication, a sync of the branch, Rovara's own fix of a block) is the build step's (lane L10).
  if (!READING_DISPATCH_KINDS.includes(row.kind)) {
    if (deps.buildSteps === undefined) throw agentXError("CONFIG_INVALID", "this install has no steps after the plan");
    return deps.buildSteps.runRow(deps, row);
  }
  const resolve = (): TransactItem => resolveRowItem(deps, row.taskId, row.workflowRevision);
  const task = await readTask(deps, row.taskId);
  const workflow = task?.workflow;
  const stale = async (): Promise<StepStart> => {
    await deps.store.transact([resolve()]);
    return "STALE";
  };
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== row.workflowRevision) return stale();
  // Only the Understand step needs a 1.1.0 workflow: with Understand off (1.0.0) the owner's request for changes still plans again, from the request and their words (below).
  if (workflow.definitionVersion !== "1.1.0" && !(workflow.definitionVersion === "1.0.0" && (row.kind === "PLAN" || row.kind === "REPLAN"))) return stale();
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return stale();
  const prompts = deps.prompts ?? DEFAULT_PROMPTS;
  let next: WorkflowSnapshot;
  let prompt: string;
  let mode: "UNDERSTAND" | "PLAN";
  let requestId: string;
  /** A structured planning run says so in its payload, so the worker reads its answer as a plan document and the broker reads the same. */
  let planPayload: Record<string, JsonValue> | undefined;
  try {
    if (row.kind === "UNDERSTAND") {
      if (workflow.stage !== "UNDERSTAND" || workflow.state !== "READY") return stale();
      next = startWorkflowUnderstand(workflow, iso(deps));
      prompt = prompts.understand({ requestText: task.requestText ?? "", intent: workflow.intent });
      mode = "UNDERSTAND";
      requestId = workflowRequestId("agentx-understand", task.taskId, workflow.revision);
    } else if (row.kind === "REPLAN") {
      // The planner's automatic second run: planning is RUNNING with no live run, one revision on; the row carries what the planner is told (the plan's problems, or what could not be read).
      const planPrompt = (row as Partial<DispatchRowRecord>).planPrompt ?? fromDocument<DispatchRowRecord>(await deps.store.get(dispatchRowKey(deps.companyId, row.taskId, row.workflowRevision)))?.planPrompt;
      // With Understand off there is no assessment to wait for: the run is told the request and the owner's words.
      if (planPrompt === undefined || workflow.stage !== "PLAN" || workflow.state !== "RUNNING" || (workflow.definitionVersion === "1.1.0" && workflow.intent?.assessment?.kind !== "ready")) return stale();
      const structured = await structuredPlanContextOf(deps, task, workflow);
      // The second run is told the owner's change notes again: the plan it revises was written after them, and the run may be a new conversation.
      const feedback = await planFeedbackOf(deps, task.taskId);
      next = { ...workflow, revision: workflow.revision + 1, updatedAt: iso(deps) };
      prompt = prompts.plan({
        requestText: task.requestText ?? "", path: workflow.path, phase: workflow.reviewPhase, intent: workflow.intent, revision: planPrompt,
        ...(feedback.length === 0 ? {} : { feedback }),
        ...(structured === undefined ? {} : { structured }),
      });
      planPayload = structured === undefined ? undefined : { planFormat: "structured", ...(workflow.path === "FULL" && workflow.reviewPhase !== undefined ? { workflowPhase: workflow.reviewPhase } : {}) };
      mode = "PLAN";
      requestId = workflowRequestId("agentx-auto-plan-revision", task.taskId, workflow.revision, createHash("sha256").update(planPrompt, "utf8").digest("hex"));
    } else {
      const assessment = workflow.intent?.assessment;
      if (workflow.stage !== "PLAN" || workflow.state !== "READY") return stale();
      // Understand on: planning reads its assessment. Understand off (a 1.0.0 task, where the owner asked for changes to a plan): there is none, so the planner gets the request and what the owner asked to change.
      const understood = assessment?.kind === "ready" ? assessment : undefined;
      if (understood === undefined && workflow.definitionVersion !== "1.0.0") return stale();
      next = understood === undefined ? startWorkflowPlanWithoutUnderstand(workflow, iso(deps)) : startWorkflowPlanAfterUnderstand(workflow, iso(deps));
      const feedback = await planFeedbackOf(deps, task.taskId);
      const context = await planContextOf(deps, workflow);
      const structured = await structuredPlanContextOf(deps, task, workflow);
      prompt = prompts.plan({
        requestText: task.requestText ?? "", path: workflow.path, phase: workflow.reviewPhase, ...(understood === undefined ? {} : { restatement: understood.restatement, assumptions: understood.assumptions }), intent: workflow.intent,
        ...(feedback.length === 0 ? {} : { feedback }), ...(context.earlier.length === 0 ? {} : { earlier: context.earlier }), ...(context.previous === undefined ? {} : { previous: context.previous }),
        ...(structured === undefined ? {} : { structured }),
        // Retry planning after an answer Rovara could not read: the planner is told what was wrong with it.
        ...(structured === undefined || task.planUnreadable === undefined ? {} : { revision: planUnreadablePrompt(task.planUnreadable.errors) }),
      });
      planPayload = structured === undefined ? undefined : { planFormat: "structured", ...(workflow.path === "FULL" && workflow.reviewPhase !== undefined ? { workflowPhase: workflow.reviewPhase } : {}) };
      const designInstructions = deps.designReview?.planInstructions(workflow);
      if (designInstructions !== undefined) prompt = `${prompt}\n\n${designInstructions}`;
      mode = "PLAN";
      requestId = workflowRequestId(understood === undefined ? "agentx-plan-after-changes" : "agentx-plan-after-understand", task.taskId, workflow.revision);
    }
  } catch (error) {
    if (error instanceof WorkflowTransitionError) return stale();
    throw error;
  }
  // The machine is still being set up (or another step holds the workspace): the step runs when it is ready, not before.
  if (workspace.status === "PREPARING") return "WAITING";
  const accepted = await acceptStepWithNotes(deps, {
    task, workspace, requestId, prompt, workflowMode: mode, workflow: { current: workflow, next }, extra: [resolve()],
    requires: ["task.workflowMode", ...(planPayload === undefined ? [] : ["task.structuredPlans"])], ...(planPayload === undefined ? {} : { payload: planPayload }),
  });
  if (accepted.result === "DUPLICATE") await deps.store.transact([resolve()]);
  return accepted.result;
}

const STEP_NAMES: Record<DispatchRowRecord["kind"], string> = {
  UNDERSTAND: "step that reads the request", PLAN: "planning step", REPLAN: "planning step", CRITIQUE: "plan check", CRITIC_REPLAN: "revision of the plan", IMPLEMENT: "coding step", REVIEW: "reviews", PUBLISH: "pull request", SYNC: "merge of the base branch", AUTOFIX: "automatic fix",
};

export interface DispatchSweepReport { started: number; waiting: number; stale: number; failed: number; blocked: number }

/** The recovery sweep for rows left behind (and the way a row becomes due after a backoff). Safe to run from a timer; a repeat of a step is the first one's duplicate. */
export async function runDueDispatches(deps: TaskFlowDeps, options: { limit?: number } = {}): Promise<DispatchSweepReport> {
  const report: DispatchSweepReport = { started: 0, waiting: 0, stale: 0, failed: 0, blocked: 0 };
  const rows = await dueDispatchRows(deps.store, deps.companyId, iso(deps), options.limit ?? 20);
  for (const row of rows) {
    try {
      const result = await runDispatchRow(deps, row);
      if (result === "STARTED" || result === "DUPLICATE") report.started += 1;
      else if (result === "STALE") report.stale += 1;
      else if (Date.parse(iso(deps)) - Date.parse(row.createdAt) > WAIT_ROW_MAX_SECONDS * 1_000) {
        // The workspace never became free for this step: it is not going to without help, so the owner is told instead of the row waiting for ever.
        await blockTaskWorkflow(deps, row.taskId, row.workflowRevision, "Rovara could not start the next step because the workspace did not become ready; retry it.");
        await deps.store.transact([resolveRowItem(deps, row.taskId, row.workflowRevision)]);
        report.blocked += 1;
      } else {
        report.waiting += 1;
        await deps.store.transact([rescheduleRowItem(row, later(deps, WAIT_SECONDS), row.attempts)]);
      }
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message : "unknown";
      log(deps, { event: "task_flow.dispatch_row_failed", taskId: row.taskId, kind: row.kind, attempts, error: error instanceof AgentXError ? error.code : "unknown" });
      try {
        if (attempts >= DISPATCH_ROW_ATTEMPTS_MAX) {
          await blockTaskWorkflow(deps, row.taskId, row.workflowRevision, `Rovara could not start the ${STEP_NAMES[row.kind]}: ${message}`.slice(0, 500));
          await deps.store.transact([resolveRowItem(deps, row.taskId, row.workflowRevision)]);
          report.blocked += 1;
        } else {
          await deps.store.transact([rescheduleRowItem(row, later(deps, backoffSeconds(attempts)), attempts, message)]);
          report.failed += 1;
        }
      } catch (storeError) {
        // The store is failing too: this row is tried again by the next sweep; the rest of this sweep goes on.
        log(deps, { event: "task_flow.dispatch_row_bookkeeping_failed", taskId: row.taskId, error: storeError instanceof Error ? storeError.name : "unknown" });
        report.failed += 1;
      }
    }
  }
  return report;
}

// ---- The first run of a task that has no Understand ----

/**
 * After the preparation: the task's first instructions are queued as a run (Cloud's pointer `pendingPrompt`, R3). A workflow task's is a PLAN-mode
 * run of the workflow that already started RUNNING at PLAN; a task with no workflow runs the instructions plainly.
 */
export async function queueFirstRun(deps: TaskFlowDeps, task: TaskRecord): Promise<StepStart> {
  const pointer = fromDocument<TaskPointerRecord>(await deps.store.get(taskPointerKey(task.workspaceId)));
  if (pointer === undefined || pointer.pendingPrompt === undefined || pointer.cancelledAt !== undefined) return "STALE";
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const mode = pointer.pendingWorkflowMode === "PLAN" ? "PLAN" as const : undefined;
  // A setup run's first step carries the limits it started with and the commits the preparation reported (read again now: the task passed in was read before the preparation's report was kept).
  const setup = pointer.pendingWorkflowMode === "SETUP_AGENT" ? await readTask(deps, task.taskId) : undefined;
  const accepted = await acceptStep(deps, {
    task, workspace, requestId: pointer.firstRequestId, prompt: pointer.pendingPrompt,
    ...(mode === undefined ? {} : { workflowMode: mode, requires: ["task.workflowMode"] }),
    ...(setup === undefined ? {} : {
      workflowMode: "SETUP_AGENT" as const, requires: ["task.workflowMode", SETUP_AGENT_FEATURE], extraActions: ["setup-agent"],
      payload: { setupAgent: JSON.parse(JSON.stringify(setupAgentWireOf(setup))) as JsonValue },
    }),
    extra: [{ kind: "update", key: taskPointerKey(task.workspaceId), ops: [change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")], condition: when.exists("pendingPrompt") }],
  });
  if (accepted.result === "DUPLICATE") {
    // The first run was accepted and only the pointer was not cleared (or it was, by a repeat): clear it so the task no longer reads as starting.
    await deps.store.update({ key: taskPointerKey(task.workspaceId), ops: [change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")], condition: when.exists("pendingPrompt") });
  }
  return accepted.result;
}

// ---- What an ended operation moves ----

/**
 * After an operation's terminal result committed: the next move of the task. Idempotent: a repeat finds the step already taken (its request id is
 * the first one's) and does nothing. Never throws for a task that moved on.
 */
export async function onOperationEnded(deps: TaskFlowDeps, operation: OperationRecord, ended: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined; outcome?: StepOutcome | undefined }): Promise<void> {
  const pointer = fromDocument<TaskPointerRecord>(await deps.store.get(taskPointerKey(operation.workspaceId)));
  if (pointer === undefined) {
    // A workspace with no task is a project's setup check: its preparation ended, so its workspace and machine are closed.
    if (operation.kind === "prepare") await closeSetupCheck(deps, operation.workspaceId);
    return;
  }
  const task = await readTask(deps, pointer.taskId);
  if (task === undefined || task.closedAt !== undefined) return;
  const succeeded = ended.status === "SUCCEEDED";

  // A setup run's own operation, or its preparation failing, ends the run with what the broker reads of the worker's answer (idempotent: a repeat finds the result kept and changes nothing).
  if (task.purpose === "setup_agent" && ((operation.kind === "task" && operation.workflowMode === "SETUP_AGENT") || (operation.kind === "prepare" && !succeeded))) {
    await endSetupAgentTask(deps, task, operation, ended);
    return;
  }

  if (operation.kind === "prepare") {
    if (!succeeded) return;
    // The meta repository's commit is the one the broker chose for this preparation, kept only when the worker reports exactly it (a worker or an old manifest never decides it).
    if (ended.outcome?.kind === "prepared" && task.knowledgeCommit === undefined) {
      const chosen = (operation.dispatch.payload["meta"] as { commit?: unknown } | undefined)?.commit;
      const keep = knowledgeCommitToStore(typeof chosen === "string" ? chosen : undefined, { knowledgeCommit: ended.outcome.knowledgeCommit });
      if (keep !== undefined) await deps.store.update({ key: taskKey(task.taskId), ops: [change.set("knowledgeCommit", keep), change.set("updatedAt", iso(deps))], condition: when.notExists("knowledgeCommit") });
    }
    if (ended.outcome?.kind === "prepared" && ended.outcome.base !== undefined && task.preparedBase === undefined) {
      await deps.store.update({ key: taskKey(task.taskId), ops: [change.set("preparedBase", toDocument(ended.outcome.base)), change.set("updatedAt", iso(deps))], condition: when.notExists("preparedBase") });
    }
    if (pointer.pendingPrompt !== undefined) await queueFirstRun(deps, task);
    else if (task.workflow !== undefined) {
      const row = await deps.store.get(dispatchRowKey(deps.companyId, task.taskId, task.workflow.revision));
      if (row !== undefined) await runDispatchRow(deps, row as unknown as DispatchRowRecord);
    }
    return;
  }

  // A step that took live messages and did not succeed runs again without them: their notes stop saying "already given" so the re-run reads them as new (scoped to this attempt; never throws).
  if (!succeeded && operation.kind === "task") await clearLiveDeliveredSince({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.log === undefined ? {} : { log: deps.log }) }, task.taskId, operation.createdAt);
  // The design review's own operations: a round of reviewers (plan-check mode), and the planner's answer to their findings.
  if (deps.designReview !== undefined && (operation.workflowMode === "PLAN_CRITIQUE" || deps.designReview.isResolveRun(task.workflow, operation))) {
    if (await deps.designReview.onEnded(deps, task, operation, ended)) return;
  }

  // The steps after the plan: coding, a rerun of the checks, the reviews, the publication and the push of a fix (lane L10).
  if (operation.kind === "publish" || operation.kind === "maintain" || operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS" || operation.workflowMode === "REVIEW" || operation.workflowMode === "PLAN_CRITIQUE") {
    if (deps.buildSteps !== undefined) await deps.buildSteps.onEnded(deps, task, operation, ended);
    return;
  }

  const workflow = task.workflow;
  if (workflow === undefined || operation.workflowMode === undefined || operation.workflowRevision === undefined || workflow.revision !== operation.workflowRevision) return;

  if (!succeeded) {
    if (ended.status === "CANCELLED") return;
    const what = operation.workflowMode === "UNDERSTAND" ? "reading the request" : "planning";
    // The step stopped because the owner's live message asks for a change outside the approved plan: the owner decides (Retry plans again with that message), and each message says so on its row.
    const reapproval = isReapprovalStop(ended.error);
    await blockTaskWorkflow(deps, task.taskId, workflow.revision, reapproval ? WORKFLOW_BLOCK_REASONS.liveSteerReapproval : `Rovara stopped while ${what}${ended.error === undefined ? "" : `: ${ended.error}`}`.slice(0, 500));
    if (reapproval) await settleLiveSteerReapproval({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.log === undefined ? {} : { log: deps.log }) }, task, ended.error);
    return;
  }
  const outcome = ended.outcome;
  try {
    if (operation.workflowMode === "UNDERSTAND" && outcome?.kind === "understood") {
      const now = iso(deps);
      const isAnswer = typeof outcome.assessment === "object" && outcome.assessment !== null && (outcome.assessment as { kind?: unknown }).kind === "answer";
      if (isAnswer) {
        if (outcome.answerArtifact === undefined) throw new WorkflowTransitionError("an answer needs the file it was read from");
        await commitWorkflow(deps, task, answerWorkflowIntent(workflow, { expectedRevision: workflow.revision, assessment: outcome.assessment, artifact: outcome.answerArtifact, now }));
        return;
      }
      const assessed = recordIntentAssessment(workflow, { expectedRevision: workflow.revision, assessment: outcome.assessment, now });
      let next = assessed;
      // The design review: a ready reading that needs a design (or that the person asked to have reviewed) switches it on, which forces the Full path.
      if (deps.designReview !== undefined) next = await deps.designReview.afterUnderstand(deps, task, next, outcome.assessment, now);
      // The lighter flow: a request whose named files make it exactly small does not get the design review (or the Full path) a project default would give it; the skip and its record are in this commit.
      if (deps.lighterFlow === true && assessed.intent?.assessment !== undefined) {
        next = afterUnderstand({ assessed, considered: next, requestText: task.requestText, assessment: assessed.intent.assessment, explicitPath: isExplicitPath(workflow), at: now });
      }
      // A ready request goes on to planning with no one asking: the row commits with the transition, and is run right after.
      const toPlan = next.stage === "PLAN" && next.state === "READY";
      const committed = await commitWorkflow(deps, task, next, toPlan ? [dispatchRowItem(deps, task.taskId, next.revision, "PLAN", now)] : []);
      if (committed && toPlan) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "PLAN" });
      return;
    }
    if (operation.workflowMode === "PLAN" && outcome?.kind === "planned") {
      const submitted = submitWorkflowArtifact(workflow, {
        expectedRevision: workflow.revision, artifact: outcome.artifact, now: iso(deps),
        ...(outcome.proposal === undefined ? {} : { proposal: outcome.proposal }),
        ...(outcome.noChangeNeeded === true ? { noChangeNeeded: true } : {}),
      });
      // The change tier's ESTIMATE, before any code exists: from the files the plan names and the words of the request. It is replaced by the diff's tier after the build.
      // With the lighter flow on it also picks the steps: exactly small (the files of the plan, the request and Understand's reading) skips the plan check and the approval, in this same commit.
      const lighter = workflowDocumentType(submitted) === "plan" && (deps.lighterFlow === true || (workflow.flow?.skippedSteps ?? []).some((step) => UNDERSTAND_SKIPS.includes(step)));
      const planText = lighter ? (await loadWorkflowDocument(textReaderOf(deps.artifacts), outcome.artifact, {}).catch(() => undefined))?.markdown : undefined;
      const costHighUsd = lighter ? (await planRunEstimate(deps, task, submitted))?.highUsd : undefined;
      const routed = lighter
        ? smallPlanRoute({ submitted, plan: outcome.cites?.plan, requestText: task.requestText, noChangeNeeded: outcome.noChangeNeeded === true, at: iso(deps), planText, costHighUsd }) : undefined;
      // The plan skips its own steps only with the switch on; steps Understand skipped for a change the plan shows is not small come back (whatever the switch says now).
      const skippedHere = deps.lighterFlow === true && (routed?.skipped.length ?? 0) > 0;
      if (lighter && !skippedHere) {
        const restore = restoredForPlanning(workflow, routed?.workflow.flow ?? workflow.flow, iso(deps));
        if (restore !== undefined) {
          let ready = restore.workflow;
          if (restore.restored.includes("design_review") && deps.designReview !== undefined && ready.intent?.assessment !== undefined) ready = await deps.designReview.afterUnderstand(deps, task, ready, ready.intent.assessment, iso(deps));
          if (ready.designReview === undefined && restore.restored.includes("requirements_approval")) ready = toFull(ready);
          const committedRestore = await commitWorkflow(deps, task, ready, [dispatchRowItem(deps, task.taskId, ready.revision, "PLAN", iso(deps))]);
          log(deps, { event: "task_flow.planning_restored", taskId: task.taskId, level: ready.flow?.tier?.level, restored: restore.restored, designReview: ready.designReview !== undefined });
          if (committedRestore) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: ready.revision, kind: "PLAN" });
          return;
        }
      }
      const next = (skippedHere || deps.lighterFlow === true ? routed?.workflow : undefined) ?? withTierEstimate(submitted, outcome.cites?.plan, task.requestText, iso(deps));
      const toCode = skippedHere && next.stage === "IMPLEMENT" && next.state === "READY";
      // A version 2 coding plan is read by a second step before a person sees it: the check is a row like every automatic step, written with the plan.
      const toCheck = next.stage === "PLAN_CRITIQUE" && next.state === "READY";
      // What the run is expected to cost, from the cost of the project's earlier runs (or the default for the path), kept on the task beside the plan: the plan page, the decision card's risk, the session and the tools read it.
      const estimate = await planRunEstimate(deps, task, next);
      const row = toCheck ? dispatchRowItem(deps, task.taskId, next.revision, "CRITIQUE", iso(deps)) : toCode ? dispatchRowItem(deps, task.taskId, next.revision, "IMPLEMENT", iso(deps)) : undefined;
      const committed = await commitWorkflow(deps, task, next, row === undefined ? [] : [row], [...(task.planUnreadable === undefined ? [] : [change.remove("planUnreadable")]), ...(estimate === undefined ? [] : [change.set("runEstimate", estimate as unknown as JsonValue)])]);
      if (committed && toCheck) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "CRITIQUE" });
      if (committed && toCode) {
        log(deps, { event: "task_flow.planning_skipped", taskId: task.taskId, level: next.flow?.tier?.level, kinds: next.flow?.tier?.kinds, skipped: next.flow?.skippedSteps, reasons: next.flow?.tier?.reasons.map((reason) => reason.code) });
        await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "IMPLEMENT" });
      }
      // The code the plan cites is read after the plan is committed, so a slow or failing code host never holds the plan up.
      if (committed && outcome.cites !== undefined) {
        await deps.afterPlanStored?.({ task, workflow: next, artifactId: outcome.artifact.id, artifactSha256: outcome.artifact.sha256, plan: outcome.cites.plan, prefix: outcome.cites.prefix })
          .catch((error: unknown) => log(deps, { event: "task_flow.after_plan_stored_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
      }
      return;
    }
    if (operation.workflowMode === "PLAN" && outcome?.kind === "plan_unreadable") {
      // The answer could not be read and the automatic second run is spent: planning blocks, with the problems kept for Retry planning (and a fixed category for the owner's message).
      const next = blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.planUnreadable, iso(deps));
      await commitWorkflow(deps, task, next, [], [change.set("planUnreadable", toDocument({ workflowRevision: next.revision, errors: outcome.errors, category: outcome.category, ...(outcome.autoRetried === true ? { autoRetried: true } : {}) }))]);
      return;
    }
    if (operation.workflowMode === "PLAN" && outcome?.kind === "plan_again") {
      // Nothing is shown to the owner: planning stays RUNNING one revision on, and a row starts the planner again with what was wrong (Cloud's REPLAN row).
      const now = iso(deps);
      const next = WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, updatedAt: now });
      const committed = await commitWorkflow(deps, task, next, [dispatchRowItem(deps, task.taskId, next.revision, "REPLAN", now, now, undefined, outcome.prompt)], [change.set("planSelfCheck", toDocument(outcome.selfCheck))]);
      if (committed) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "REPLAN" });
      return;
    }
  } catch (error) {
    if (!(error instanceof WorkflowTransitionError)) throw error;
    await blockTaskWorkflow(deps, task.taskId, workflow.revision, "Rovara could not read the result of this step; retry it.");
    return;
  }
  // A result with no outcome the step understands: the step ended without what it was asked for.
  if (operation.workflowMode === "UNDERSTAND" || operation.workflowMode === "PLAN") {
    await blockTaskWorkflow(deps, task.taskId, workflow.revision, "Rovara could not read the result of this step; retry it.");
  }
}

/** The workflow with the change tier's estimate written, for a coding plan; a task whose tier already comes from a diff keeps it (the estimate never replaces a real tier). */
function withTierEstimate(workflow: WorkflowSnapshot, plan: PlanDocument | undefined, requestText: string | undefined, at: string): WorkflowSnapshot {
  if (workflowDocumentType(workflow) !== "plan") return workflow;
  const kept = workflow.flow?.tier;
  if (kept !== undefined && kept.source !== "estimate") return workflow;
  const estimate = estimateTier({ plannedPaths: plan === undefined ? undefined : planFiles(plan), requestText }, { at });
  return { ...workflow, flow: recordTier(workflow.flow, estimate).flow };
}

/**
 * The expected cost of the run a coding plan starts: from the project's earlier runs once there are enough, else the default for the path (`core/cost/estimate.ts`). Undefined when the plan is not a coding plan or the history
 * cannot be read: the task then shows no estimate, which is never read as a cheap one. Best effort; it never holds the plan up.
 */
async function planRunEstimate(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot): Promise<RunEstimate | undefined> {
  if (workflowDocumentType(workflow) !== "plan") return undefined;
  try {
    return await estimateRun({ store: deps.store }, {
      orgId: deps.companyId, project: task.project, agentId: ROVARA_CODE_AGENT_ID, path: estimatePathOf({ workflow }),
    });
  } catch {
    return undefined;
  }
}

export type { DispatchSpec, DocumentKey };
