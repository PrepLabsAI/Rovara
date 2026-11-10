// Lane L6a, task flow core: the stage machine's driver. The transitions themselves are the pure functions in `@agentx/contracts`
// (`task-workflow-node.ts`: `startWorkflowUnderstand`, `recordIntentAssessment`, `submitWorkflowArtifact`, ...). This module is what Cloud's
// `developer-tasks/workflow-starts.ts` and the broker's result hook do around them: read the task, apply one transition, and write the new
// snapshot (fenced on the revision it was computed from) in the same transaction as the operation that carries the step out.
//
// A step is: [task.workflow := next (if revision = r)] + [workspace := BUSY under a new fence] + [the operation and its staged message]
// + [whatever else must commit with it, such as resolving the dispatch row]. If the transaction does not apply, nothing happened.
import {
  AgentXError,
  agentXError,
  WorkflowTransitionError,
  answerWorkflowIntent,
  blockWorkflow,
  change,
  recordIntentAssessment,
  startWorkflowPlanAfterUnderstand,
  startWorkflowUnderstand,
  submitWorkflowArtifact,
  when,
  workflowRequestId,
  type DocumentKey,
  type JsonValue,
  type Operation,
  type TransactItem,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import { buildOperation, assertPromptFits } from "./accept.js";
import type { TaskFlowDeps } from "./deps.js";
import { dispatchRowItem, dueDispatchRows, rescheduleRowItem, resolveRowItem } from "./dispatch-rows.js";
import { dispatchRowKey, operationRequestKey, taskKey, taskPointerKey, workspaceKey } from "./keys.js";
import { readTask } from "./reads.js";
import { fromDocument, READING_DISPATCH_KINDS, toDocument, type DispatchRowRecord, type DispatchSpec, type MaintenanceExpectation, type OperationRecord, type PublicationExpectation, type TaskPointerRecord, type TaskRecord, type WorkspaceRecord } from "./records.js";
import { DEFAULT_PROMPTS, iso, log } from "./support.js";
import type { StepOutcome } from "./outcome.js";

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
  const now = iso(deps);
  const workflowRevision = input.workflow?.next.revision ?? task.workflow?.revision;
  const built = buildOperation(deps, {
    workspace: { id: workspace.id, ownerKey: workspace.ownerKey, fence: workspace.fence + 1 },
    kind: operationKind, requestId: input.requestId, now, ...(input.operationId === undefined ? {} : { operationId: input.operationId }), ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
    conversationId: task.conversationId,
    ...(workflowRevision === undefined ? {} : { workflowRevision }),
    ...(input.publication === undefined ? {} : { publication: input.publication }),
    ...(input.maintenance === undefined ? {} : { maintenance: input.maintenance }),
    dispatch: {
      kind: operationKind, projectRevision: workspace.projectRevision,
      payload: operationKind !== "task"
        ? { ...input.payload }
        : { conversationId: task.conversationId, prompt: input.prompt, ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }), ...input.payload },
      ...(input.requires === undefined ? {} : { requires: input.requires }),
      ...(input.extraActions === undefined ? {} : { extraActions: input.extraActions }),
    },
    requester: { personId: task.developerId, provider: task.provider },
  });
  const items: TransactItem[] = [
    {
      kind: "update",
      key: taskKey(task.taskId),
      ops: [...(input.workflow === undefined ? [] : [change.set("workflow", toDocument(input.workflow.next))]), change.set("updatedAt", now)],
      condition: when.and(when.notExists("closedAt"), ...(input.workflow === undefined ? [] : [when.eq(["workflow", "revision"], input.workflow.current.revision)])),
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

/** Applies one workflow transition with no operation (a result recorded, a block), fenced on the revision it was computed from. False when the task moved on. */
export async function commitWorkflow(deps: TaskFlowDeps, task: TaskRecord, next: WorkflowSnapshot, extra: readonly TransactItem[] = []): Promise<boolean> {
  const current = task.workflow;
  if (current === undefined) return false;
  const result = await deps.store.transact([
    {
      kind: "update", key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(next)), change.set("updatedAt", iso(deps))],
      condition: when.and(when.notExists("closedAt"), when.eq(["workflow", "revision"], current.revision)),
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
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.definitionVersion !== "1.1.0" || workflow.revision !== row.workflowRevision) return stale();
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return stale();
  const prompts = deps.prompts ?? DEFAULT_PROMPTS;
  let next: WorkflowSnapshot;
  let prompt: string;
  let mode: "UNDERSTAND" | "PLAN";
  let requestId: string;
  try {
    if (row.kind === "UNDERSTAND") {
      if (workflow.stage !== "UNDERSTAND" || workflow.state !== "READY") return stale();
      next = startWorkflowUnderstand(workflow, iso(deps));
      prompt = prompts.understand({ requestText: task.requestText ?? "", intent: workflow.intent });
      mode = "UNDERSTAND";
      requestId = workflowRequestId("agentx-understand", task.taskId, workflow.revision);
    } else {
      const assessment = workflow.intent?.assessment;
      if (workflow.stage !== "PLAN" || workflow.state !== "READY" || assessment?.kind !== "ready") return stale();
      next = startWorkflowPlanAfterUnderstand(workflow, iso(deps));
      const feedback = await planFeedbackOf(deps, task.taskId);
      const context = await planContextOf(deps, workflow);
      prompt = prompts.plan({
        requestText: task.requestText ?? "", path: workflow.path, phase: workflow.reviewPhase, restatement: assessment.restatement, assumptions: assessment.assumptions, intent: workflow.intent,
        ...(feedback.length === 0 ? {} : { feedback }), ...(context.earlier.length === 0 ? {} : { earlier: context.earlier }), ...(context.previous === undefined ? {} : { previous: context.previous }),
      });
      mode = "PLAN";
      requestId = workflowRequestId("agentx-plan-after-understand", task.taskId, workflow.revision);
    }
  } catch (error) {
    if (error instanceof WorkflowTransitionError) return stale();
    throw error;
  }
  // The machine is still being set up (or another step holds the workspace): the step runs when it is ready, not before.
  if (workspace.status === "PREPARING") return "WAITING";
  const accepted = await acceptStep(deps, { task, workspace, requestId, prompt, workflowMode: mode, workflow: { current: workflow, next }, extra: [resolve()], requires: ["task.workflowMode"] });
  if (accepted.result === "DUPLICATE") await deps.store.transact([resolve()]);
  return accepted.result;
}

const STEP_NAMES: Record<DispatchRowRecord["kind"], string> = {
  UNDERSTAND: "step that reads the request", PLAN: "planning step", IMPLEMENT: "coding step", REVIEW: "reviews", PUBLISH: "pull request", SYNC: "merge of the base branch", AUTOFIX: "automatic fix",
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
  const accepted = await acceptStep(deps, {
    task, workspace, requestId: pointer.firstRequestId, prompt: pointer.pendingPrompt, ...(mode === undefined ? {} : { workflowMode: mode, requires: ["task.workflowMode"] }),
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
  if (pointer === undefined) return;
  const task = await readTask(deps, pointer.taskId);
  if (task === undefined || task.closedAt !== undefined) return;
  const succeeded = ended.status === "SUCCEEDED";

  if (operation.kind === "prepare") {
    if (!succeeded) return;
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

  // The steps after the plan: coding, a rerun of the checks, the reviews, the publication and the push of a fix (lane L10).
  if (operation.kind === "publish" || operation.kind === "maintain" || operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS" || operation.workflowMode === "REVIEW") {
    if (deps.buildSteps !== undefined) await deps.buildSteps.onEnded(deps, task, operation, ended);
    return;
  }

  const workflow = task.workflow;
  if (workflow === undefined || operation.workflowMode === undefined || operation.workflowRevision === undefined || workflow.revision !== operation.workflowRevision) return;

  if (!succeeded) {
    if (ended.status === "CANCELLED") return;
    const what = operation.workflowMode === "UNDERSTAND" ? "reading the request" : "planning";
    await blockTaskWorkflow(deps, task.taskId, workflow.revision, `Rovara stopped while ${what}${ended.error === undefined ? "" : `: ${ended.error}`}`.slice(0, 500));
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
      const next = recordIntentAssessment(workflow, { expectedRevision: workflow.revision, assessment: outcome.assessment, now });
      // A ready request goes on to planning with no one asking: the row commits with the transition, and is run right after.
      const toPlan = next.stage === "PLAN" && next.state === "READY";
      const committed = await commitWorkflow(deps, task, next, toPlan ? [dispatchRowItem(deps, task.taskId, next.revision, "PLAN", now)] : []);
      if (committed && toPlan) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "PLAN" });
      return;
    }
    if (operation.workflowMode === "PLAN" && outcome?.kind === "planned") {
      await commitWorkflow(deps, task, submitWorkflowArtifact(workflow, {
        expectedRevision: workflow.revision, artifact: outcome.artifact, now: iso(deps),
        ...(outcome.proposal === undefined ? {} : { proposal: outcome.proposal }),
        ...(outcome.noChangeNeeded === true ? { noChangeNeeded: true } : {}),
      }));
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

export type { DispatchSpec, DocumentKey };
