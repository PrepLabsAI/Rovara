// The plan check (Cloud's plan critic), on the ports. A Rovara Code coding plan is read by a second step before a person sees it: it is an ordinary read-only step that
// answers with one block (a verdict and points), and what it writes is untrusted advice: it reaches a planner only inside a labelled block, bounded and redacted, and it can never approve a plan. A
// blocking point sends the plan back to the planner once; every other result, and the second check whatever it says, goes to the person with the critique. A check that cannot run is never a reason to
// hold a plan back: the person is told it was not checked. Cloud's `workflow-starts.ts` (`startTaskWorkflowPlanCritiqueFromSystem`, `startTaskWorkflowCriticRevisionFromSystem`) and `plan-answers.ts`
// (`planCritiqueOutcome`).
import { createHash } from "node:crypto";
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, blockWorkflow, closePlanCritique, readPlanCritique, redactText,
  retryPlanCritique, submitPlanCritique, workflowIsDesignReviewing, workflowRequestId, when, WorkflowTransitionError,
  type ModelIdentifier, type WorkflowSnapshot,
} from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { PLAN_REVISION_REQUEST, critiqueModelOf, planCriticBlock, planCritiquePrompt } from "../../rovara-code/critic.js";
import { recordCatch } from "../decisions/change-tier.js";
import { textReaderOf } from "../build-step/plan-input.js";
import { locate, settled, type RowRef } from "../build-step/start.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import { conversationKey } from "../task-flow/keys.js";
import { readTask, workspaceOperations } from "../task-flow/reads.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import { acceptStep, blockTaskWorkflow, commitWorkflow, planFeedbackOf, runDispatchRow, type StepStart } from "../task-flow/stage-machine.js";
import { DEFAULT_PROMPTS, iso, log } from "../task-flow/support.js";
import { planDocumentKindOf } from "./answer.js";
import { retriesPlanCheck } from "./check-retry.js";
import { earlierPlans, structuredPlanContextOf } from "./context.js";

/** The file the critic's answer is saved as. */
export const PLAN_CRITIQUE_ARTIFACT_NAME = "plan-critique.md";
/** The most bytes of a plan check's answer that are read. */
const PLAN_CRITIQUE_ANSWER_MAX_BYTES = 65_536;
/** The most of the person's words (the request) a plan check is given beside the plan. */
const PLAN_CHECK_REQUEST_MAX_CHARS = 4_000;

/** The plan check works in a conversation of its own, one for each check: it never sees the planner's session, and the planner never holds its turn. */
export function planCheckConversationId(taskId: string, revision: number): string {
  const hex = createHash("sha256").update(`agentx-plan-check-conversation:${taskId}:${String(revision)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Whether the row is the design review's: the same stage and rows serve a design that is being reviewed (the review's own step) and a coding plan (the plan check). */
async function isDesignReviewRow(deps: TaskFlowDeps, row: RowRef): Promise<boolean> {
  const workflow = (await readTask(deps, row.taskId))?.workflow;
  return workflow !== undefined && workflowIsDesignReviewing(workflow);
}

/** The design review's step for the row, or a stale answer where the install has no design review. */
async function startDesignReviewRow(deps: TaskFlowDeps, row: RowRef, kind: "CRITIQUE" | "CRITIC_REPLAN"): Promise<StepStart> {
  return deps.designReview === undefined ? settled(deps, row, "STALE") : deps.designReview.runRow(deps, { ...row, kind });
}

/**
 * The plan check of a version 2 coding plan, started with no one asking. STALE unless the task is open and still waiting for exactly this check at the row's revision. PLAN_CRITIQUE/READY becomes
 * RUNNING and the check's operation is accepted in one transaction; its request id comes from the task and the revision, so a repeated row is the first one's duplicate. The critic is given the plan
 * the planner wrote as data, and the person's request, redacted and cut: Rovara's own words come first, and nothing in either can approve the plan.
 */
export async function startPlanCritique(deps: TaskFlowDeps, row: RowRef): Promise<StepStart> {
  if (await isDesignReviewRow(deps, row)) return startDesignReviewRow(deps, row, "CRITIQUE");
  const found = await locate(deps, row, (workflow) => workflow.stage === "PLAN_CRITIQUE" && workflow.state === "READY" && !workflowIsDesignReviewing(workflow)
    && workflow.program?.steps.some((step) => step.kind === "plan_critic") === true);
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  const step = workflow.program!.steps.find((candidate) => candidate.kind === "plan_critic")!;
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  const loaded = artifact === undefined || deps.artifacts === undefined ? undefined : await loadWorkflowDocument(textReaderOf(deps.artifacts), artifact, {}).catch(() => undefined);
  // A plan that cannot be read back is not shown to the check; the person is told it was not checked, and decides on the plan as it stands (which then fails its own digest check where it is shown).
  if (loaded === undefined) {
    await commitWorkflow(deps, task, closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now: iso(deps) }));
    return settled(deps, row, "STALE");
  }
  const now = iso(deps);
  const conversationId = planCheckConversationId(task.taskId, workflow.revision);
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: now };
  const request = task.requestText === undefined ? undefined : Array.from(redactText(task.requestText)).slice(0, PLAN_CHECK_REQUEST_MAX_CHARS).join("");
  const accepted = await acceptStep(deps, {
    task, workspace, requestId: workflowRequestId("agentx-plan-critique", task.taskId, workflow.revision), prompt: planCritiquePrompt({ plan: loaded.markdown, request }),
    workflowMode: "PLAN_CRITIQUE", programStepId: step.id, conversationId, workflow: { current: workflow, next },
    // The check's conversation is its own record, written with the step.
    extra: [{ kind: "put", item: { ...conversationKey(workspace.id, conversationId), entityType: "CONVERSATION", id: conversationId, workspaceId: workspace.id, createdAt: now, updatedAt: now }, condition: when.absent() }],
    requires: ["task.workflowMode", "task.workflowPlanCritique"],
  });
  return settled(deps, row, accepted.result);
}

/**
 * The one revision a blocking point of the plan check asks for, started with no one asking: PLAN/READY (the check sent the plan back) becomes RUNNING and a planning operation is accepted. The planner
 * is given the plan it wrote as data, to write back whole, and the critic's points in the labelled block after Rovara's own words; it decides what to change.
 */
export async function startCriticRevision(deps: TaskFlowDeps, row: RowRef): Promise<StepStart> {
  if (await isDesignReviewRow(deps, row)) return startDesignReviewRow(deps, row, "CRITIC_REPLAN");
  const found = await locate(deps, row, (workflow) => workflow.stage === "PLAN" && workflow.state === "READY" && workflow.critique?.critiques.at(-1)?.points.some((point) => point.severity === "blocking") === true);
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  const points = workflow.critique!.critiques.at(-1)!.points;
  const structured = await structuredPlanContextOf(deps, task, workflow);
  const kind = planDocumentKindOf(workflow);
  const current = (await earlierPlans(deps, workflow)).filter((entry) => entry.kind === kind).at(-1);
  // The plan to revise is handed over as data; a plan that cannot be read back cannot be revised, so the person decides on it as it is (the critique is kept).
  if (structured === undefined || current === undefined) {
    await commitWorkflow(deps, task, closePlanRevision(workflow, iso(deps)));
    return settled(deps, row, "STALE");
  }
  const now = iso(deps);
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: now };
  const prompts = deps.prompts ?? DEFAULT_PROMPTS;
  // The owner's earlier change notes are repeated: the plan being revised was written after them.
  const feedback = await planFeedbackOf(deps, task.taskId);
  const prompt = prompts.plan({
    requestText: task.requestText ?? "", path: workflow.path, phase: workflow.reviewPhase, intent: workflow.intent,
    ...(feedback.length === 0 ? {} : { feedback }),
    structured: { rules: structured.rules, previous: { kind: current.kind, version: current.version, plan: current.plan } },
    revision: `${PLAN_REVISION_REQUEST}\n\n${planCriticBlock(points)}`,
  });
  const accepted = await acceptStep(deps, {
    task, workspace, requestId: workflowRequestId("agentx-plan-revision", task.taskId, workflow.revision), prompt, workflowMode: "PLAN", workflow: { current: workflow, next },
    requires: ["task.workflowMode", "task.structuredPlans"],
    payload: { planFormat: "structured", ...(workflow.path === "FULL" && workflow.reviewPhase !== undefined ? { workflowPhase: workflow.reviewPhase } : {}) },
  });
  return settled(deps, row, accepted.result);
}

/** The revision cannot be made: the plan goes to the person as it was written, with the critic's points. */
function closePlanRevision(workflow: WorkflowSnapshot, now: string): WorkflowSnapshot {
  const critique = workflow.critique;
  return { ...workflow, revision: workflow.revision + 1, stage: "PLAN_REVIEW", state: "WAITING", ...(critique === undefined ? {} : { critique: { ...critique, notRevised: true, limit: "other" as const } }), updatedAt: now };
}

/** The critic's saved answer, read back and checked against the digest recorded with it; undefined when it is missing, too big or changed. */
async function criticAnswerOf(deps: TaskFlowDeps, operation: OperationRecord): Promise<string | undefined> {
  if (deps.artifacts === undefined) return undefined;
  const rows = await deps.store.query({ pk: `WORKSPACE#${operation.workspaceId}`, sk: { op: "beginsWith", prefix: `ARTIFACT#${operation.id}#` } });
  const row = rows.items.find((item) => item["name"] === PLAN_CRITIQUE_ARTIFACT_NAME);
  if (row === undefined || typeof row["objectKey"] !== "string" || typeof row["sha256"] !== "string") return undefined;
  const bytes = await deps.artifacts.get(row["objectKey"], PLAN_CRITIQUE_ANSWER_MAX_BYTES + 1);
  if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== row["sha256"]) return undefined;
  return new TextDecoder().decode(bytes);
}

/**
 * What a plan check's result does to the workflow. A readable answer is the critic's advice: it is kept for the person (or, with a blocking point, sent to the planner once) and can do nothing else.
 * A check that could not run (it failed, was stopped, or gave no readable block) goes on to the person, who is told the plan was not checked; except a check that could not read the rules it is to
 * apply, or could not first stop the programs earlier work left running, which stops here with its own reason and the owner's Retry plan check. The critique's model is the one the operation ran on.
 */
export async function recordCritiqued(
  deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord,
  ended: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined },
): Promise<void> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.stage !== "PLAN_CRITIQUE" || workflow.state !== "RUNNING" || operation.workflowRevision !== workflow.revision || workflowIsDesignReviewing(workflow)) return;
  // The owner stopped the check: the task stays where the stop left it.
  if (ended.status === "CANCELLED") return;
  const now = iso(deps);
  const move = async (next: WorkflowSnapshot, rows: Parameters<typeof commitWorkflow>[3] = []): Promise<boolean> => commitWorkflow(deps, task, next, rows);
  try {
    if (ended.status !== "SUCCEEDED") {
      // The check is advice: whatever goes wrong with it, the plan goes on to the person, who is told it was not checked.
      if (ended.error === BUDGET_EXHAUSTED_FAILURE_MESSAGE) { await move(closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "stopped_at_limit", limit: "other", now })); return; }
      if (ended.error?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true) { await move(blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified, now)); return; }
      if (ended.error?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true) { await move(blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.leftoverProcesses, now)); return; }
      // The model could not serve this account: the check is made again on the next model the install's rule ranks, by a row of its own, while tries are left (`check-retry.ts`). A check on the install's
      // one model (its choice says INSTALL_MODEL), or one with no choice recorded, has no next model to ask: it closes as unavailable at once.
      if (ended.status === "FAILED" && retriesPlanCheck(operation, ended.error, (await workspaceOperations(deps, operation.workspaceId)).filter((other) => other.id !== operation.id))) {
        const next = retryPlanCritique(workflow, { expectedRevision: workflow.revision, now });
        if (await move(next, [dispatchRowItem(deps, task.taskId, next.revision, "CRITIQUE", now)])) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "CRITIQUE" });
        return;
      }
      await move(closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now }));
      return;
    }
    const text = await criticAnswerOf(deps, operation).catch(() => undefined);
    const read = text === undefined ? undefined : readPlanCritique(text);
    if (read === undefined || !read.ok) { await move(closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now })); return; }
    // The model the install's rule chose for the check (kept on the operation), else the install's one model, which also wrote the plan.
    const model: ModelIdentifier = operation.modelChoice?.model ?? (await deps.installModel?.()) ?? { provider: "unknown", modelId: "unknown" };
    const submitted = submitPlanCritique(workflow, {
      expectedRevision: workflow.revision, now,
      critique: { verdict: read.verdict, points: read.points, model: critiqueModelOf(model) },
      // With one model for every step the plan was checked by the model that wrote it, and the plan says so; a check the rule gave a model of its own says whether it is the planner's.
      ...(operation.modelChoice === undefined || operation.modelChoice.sameModelAsChecked === true ? { sameModelAsPlanner: true as const } : {}),
    });
    // The catch counters: how many points the plan check made, and how many block.
    const next = { ...submitted, flow: recordCatch(submitted.flow, { step: "plan_check", findings: read.points.length, mustFix: read.points.filter((point) => point.severity === "blocking").length }) };
    // A blocking point sends the plan back to the planner once, by a row of its own; anything else is the person's now.
    const revise = next.stage === "PLAN" && next.state === "READY";
    if (await move(next, revise ? [dispatchRowItem(deps, task.taskId, next.revision, "CRITIC_REPLAN", now)] : []) && revise) {
      await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "CRITIC_REPLAN" });
    }
  } catch (error) {
    if (!(error instanceof WorkflowTransitionError)) throw error;
    log(deps, { event: "plan_check.unreadable_result", taskId: task.taskId });
    await blockTaskWorkflow(deps, task.taskId, workflow.revision, "Rovara could not read the result of the plan check; retry it.");
  }
}
