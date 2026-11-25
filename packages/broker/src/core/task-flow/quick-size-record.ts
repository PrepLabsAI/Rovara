// SF-1a: the task row's `quickSize` attribute, worked out ONCE at plan write and committed in the SAME transaction as the plan (stage-machine.ts). Record first, offer later: version 0 writes every code and count and
// nothing reads it for a button; the version with the buttons is written by SF-2. Best effort like the run estimate: a fault here logs and writes no record (no record is "nothing to offer"), it never holds the plan up.
import { isHighRiskDesign, readQuickSize, type JsonValue, type PlanDocument, type WorkflowArtifact, type WorkflowSnapshot, change } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { quickSizeInputOf, quickSizeOf, quickSizeRecordOf } from "../decisions/quick-size.js";
import { workflowDocumentType } from "../../developer/workflow-messages.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { TaskFlowDeps } from "./deps.js";
import type { TaskRecord } from "./records.js";
import { iso, log } from "./support.js";

type ChangeOp = ReturnType<typeof change.set>;

/**
 * Whether a plan just written is one a person will decide at a Quick gate: the path is QUICK and the plan waits for its check or for the person. A plan the lighter flow sent straight to coding is not offered, so it gets no record.
 * A Full-path plan is never recorded here (Full already has its layers).
 */
export const quickPlanAtGate = (workflow: WorkflowSnapshot): boolean =>
  workflow.path === "QUICK" && workflowDocumentType(workflow) === "plan"
  && ((workflow.stage === "PLAN_CRITIQUE" && workflow.state === "READY") || (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING"));

/** The longest the two reads before the plan's commit (the stored plan, the project's design review setting) may take together each: a slow store never holds the plan up; a read that is late is read as "not seen". */
export const QUICK_SIZE_READ_TIMEOUT_MS = 3_000;

/** The promise's value, or undefined when it has not answered in `ms` (its timer is always cleared; the late answer is dropped). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The plan as a document: the one the planner's answer handed on (it cites code), else read back from the stored copy. Undefined: not a structured plan, or not readable. */
async function planOf(deps: TaskFlowDeps, artifact: WorkflowArtifact, cited: PlanDocument | undefined, timeoutMs: number): Promise<PlanDocument | undefined> {
  if (cited !== undefined) return cited;
  const loaded = await within(loadWorkflowDocument(textReaderOf(deps.artifacts), artifact, {}).catch(() => undefined), timeoutMs);
  return loaded?.format === "structured" ? loaded.plan : undefined;
}

/** The record of an earlier plan, taken off the row: this plan has none, and an old one would say something about a plan that no longer waits. Nothing to do when the row has none. */
const staleRecordOps = (task: TaskRecord): ChangeOp[] => (task.quickSize === undefined ? [] : [change.remove("quickSize")]);

/**
 * The task attribute to commit with the plan: `quickSize` for a Quick plan at its gate; the removal of an earlier plan's record for a Quick plan that is not at a gate (the lighter flow sent it to coding) or whose record
 * could not be worked out; nothing for a Full-path plan (the record then is the history of the switch, and it is bound to its own plan digest). A person's `kept` carries over to the new record. The project's
 * design-review setting is asked only when Understand read a high-risk design need, the one case where it changes the answer.
 */
export async function quickSizeOps(deps: TaskFlowDeps, task: TaskRecord, next: WorkflowSnapshot, written: { artifact: WorkflowArtifact; plan?: PlanDocument | undefined }, options: { timeoutMs?: number } = {}): Promise<ChangeOp[]> {
  const timeoutMs = options.timeoutMs ?? QUICK_SIZE_READ_TIMEOUT_MS;
  try {
    if (!quickPlanAtGate(next)) return next.path === "QUICK" ? staleRecordOps(task) : [];
    const plan = await planOf(deps, written.artifact, written.plan, timeoutMs);
    const assessment = next.intent?.assessment;
    const reading = assessment?.kind === "ready" ? assessment.design : undefined;
    let designReviewOff = false;
    let settingUnread = false;
    if (reading?.needed === true && isHighRiskDesign(reading.reasons)) {
      if (deps.designReview?.reviewCanRun === undefined) designReviewOff = true;
      else {
        // A read that fails is "not seen", never "off": the project's setting is not guessed (nothing is offered from the reading this time, and the record says why).
        const answer = await within(deps.designReview.reviewCanRun(deps, task).catch((error: unknown) => {
          log(deps, { event: "quick_size.setting_not_read", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
          return undefined;
        }), timeoutMs);
        settingUnread = answer === undefined;
        designReviewOff = answer !== true;
      }
    }
    const result = quickSizeOf(quickSizeInputOf({ plan, workflow: next, designReviewOff, settingUnread }));
    const kept = readQuickSize(task.quickSize)?.kept;
    const record = quickSizeRecordOf(result, { planDigest: written.artifact.sha256, workflowRevision: next.revision, at: iso(deps), ...(kept === undefined ? {} : { kept }) });
    return [change.set("quickSize", record as unknown as JsonValue)];
  } catch (error) {
    log(deps, { event: "quick_size.not_recorded", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return staleRecordOps(task);
  }
}
