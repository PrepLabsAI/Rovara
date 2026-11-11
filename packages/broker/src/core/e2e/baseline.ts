// The baseline round of an approved application plan, on the document store: when a plan with browser and API scenarios is approved, its scenarios run once on the unchanged code (the
// task's base commit), so a reader can see what the change fixed. It is for information only and never gates:
//
//  - It is a round of its own kind: its admission and its operation sign `purpose: "baseline"`, the base commit and the attempt, and the candidate's verification refuses it.
//  - Its outcome is one record beside the task, keyed by the approved plan, and nowhere in the workflow snapshot: it can never be a qualified or a failed round, satisfy or block
//    publication, or trigger a send-back.
//  - The record says when the round started and by when it must have ended, and is written conditionally (the plan, the base commit, the attempt, the operation and the round must all be
//    the record's own), so a late or older result never overwrites a newer one. A round that never answers is shown as one that could not be run.
//  - What it records is the broker's own verification of the evidence it accepted, never rows a caller supplies.
//  - The record expires with the store's time to live, 30 days after it was last written.
//
// The record, its key (`DEVTASK#<task>` / `E2E_BASELINE#<plan digest>`) and its attributes are Cloud's: no stored-key difference. The pure parts (the verification of evidence, the view of a
// record, the reasons) are the ones in `aws/workflow-e2e-baseline.ts`, imported here.
import { E2EDisplayBaselineSchema, INDEX_EXPIRY_ATTRIBUTE, change, indexExpiresAt, when, type TransactItem } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import {
  E2E_BASELINE_ATTEMPT, E2E_BASELINE_PURPOSE, baselinePlanDigestOf, workflowE2EBaselineView, type BaselineRecord, type BaselineUnavailableReason, type SkippedAiScenarios, type VerifiedBaseline,
} from "../../e2e/baseline-round.js";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts, type WorkflowE2EArtifactStore } from "./artifacts.js";
import { asDocument, isVerifiedBy, stampOf, type E2EStateStore } from "./state.js";
import { z } from "zod";

export {
  E2E_BASELINE_ATTEMPT, E2E_BASELINE_PURPOSE, E2E_BASELINE_RUN_GRACE_MS, baselinePlanDigestOf, baselineStartFailureReason, projectE2EBaselineWanted, verifyBaselineEvidence, workflowE2EBaselineView,
  type BaselineRecord, type BaselineState, type BaselineUnavailableReason, type SkippedAiScenarios, type VerifiedBaseline,
} from "../../e2e/baseline-round.js";

export type WorkflowE2EBaselineStore = E2EStateStore;

const SkippedAiScenariosSchema = z.array(z.object({ scenarioId: z.string().min(1).max(120), title: z.string().min(1).max(120) }).strict()).max(64);
const keyOf = (taskId: string, contractDigest: string) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_BASELINE#${contractDigest}` });
const expiryOf = (at: string) => indexExpiresAt(at);
type TaskForBaseline = Pick<DeveloperTaskRecord, "taskId" | "workflow">;

/**
 * Asks for the baseline round of a just-approved application plan, at most once per approved plan: the REQUESTED record is written only if there is none. Never changes the task. A
 * project that switched the baseline off, or a plan that is not an application plan, is asked for nothing and leaves nothing.
 */
export async function requestWorkflowE2EBaselineRound(store: WorkflowE2EBaselineStore, task: TaskForBaseline, options: { enabled: boolean }): Promise<"NOT_REQUESTED" | "REQUESTED" | "ALREADY"> {
  const contractDigest = baselinePlanDigestOf(task);
  if (!options.enabled || contractDigest === undefined) return "NOT_REQUESTED";
  const requestedAt = stampOf(store);
  const written = await store.store.put({ condition: when.absent(),
    item: asDocument({ ...keyOf(task.taskId, contractDigest), entityType: "WORKFLOW_E2E_BASELINE", schemaVersion: 2, taskId: task.taskId, contractDigest, purpose: E2E_BASELINE_PURPOSE,
      attempt: E2E_BASELINE_ATTEMPT, state: "REQUESTED", requestedAt, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) }) });
  return written.applied ? "REQUESTED" : "ALREADY";
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the base commit, the admission and the deadline, as one item of the transaction that
 * accepts the operation. A record that is not this plan's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function baselineStartItem(task: TaskForBaseline,
  started: { baseCommitSha: string; operationId: string; roundId: string; admissionSha256: string; startedAt: string; deadlineAt: string; skippedAiScenarios?: SkippedAiScenarios }): TransactItem {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) throw new Error("the task has no approved application plan for a baseline to belong to");
  // The AI-navigated scenarios the round leaves out ride on the record; a round that leaves none out writes the record exactly as it was.
  const skipped = started.skippedAiScenarios === undefined || started.skippedAiScenarios.length === 0 ? undefined : SkippedAiScenariosSchema.parse(started.skippedAiScenarios);
  return { kind: "update", key: keyOf(task.taskId, contractDigest),
    ops: [change.set("state", "STARTED"), change.set("baseCommitSha", started.baseCommitSha), change.set("operationId", started.operationId), change.set("roundId", started.roundId),
      change.set("admissionSha256", started.admissionSha256), change.set("startedAt", started.startedAt), change.set("deadlineAt", started.deadlineAt),
      change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(started.startedAt)), ...(skipped === undefined ? [] : [change.set("skippedAiScenarios", skipped)])],
    condition: when.and(when.present(), when.eq("state", "REQUESTED"), when.eq("attempt", E2E_BASELINE_ATTEMPT), when.eq("contractDigest", contractDigest)) };
}

/**
 * Marks the plan's baseline as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A
 * recorded result is never replaced, and neither is a round another operation owns. Returns whether the record was changed.
 */
export async function markWorkflowE2EBaselineUnavailable(store: WorkflowE2EBaselineStore, task: TaskForBaseline, reason: BaselineUnavailableReason,
  options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) return false;
  const at = stampOf(store);
  const written = await store.store.update({ key: keyOf(task.taskId, contractDigest),
    ops: [change.set("state", "UNAVAILABLE"), change.set("reason", reason), change.set("recordedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(at))],
    condition: when.and(when.present(), when.eq("contractDigest", contractDigest), when.or(...options.from.map((state) => when.eq("state", state))),
      ...(options.operationId === undefined ? [] : [when.eq("operationId", options.operationId)])) });
  return written.applied;
}

/**
 * Records the verified baseline for the round that was started, stores the screenshots behind its rows (a row whose screenshot was not stored loses its link) and writes the
 * record conditionally: only if the record still says this plan, this base commit, this attempt, this operation, this round and this admission, and is still STARTED. Returns
 * whether it was written; a record that moved on (timed out, another attempt) is left as it is.
 */
export async function recordWorkflowE2EBaseline(deps: WorkflowE2EBaselineStore & WorkflowE2EArtifactStore, task: Pick<DeveloperTaskRecord, "taskId" | "ownerKey" | "workspaceId" | "workflow">,
  input: { verified: VerifiedBaseline; expected: { operationId: string; roundId: string; admissionSha256: string; baseCommitSha: string; attempt: number } }): Promise<boolean> {
  const contractDigest = baselinePlanDigestOf(task);
  const { verified, expected } = input;
  if (contractDigest === undefined) throw new Error("the task has no approved application plan for a baseline to belong to");
  if (!isVerifiedBy(verified, "verified-baseline") || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) {
    throw new Error("the verification is not of the round that was started");
  }
  const stored = await storeWorkflowE2EArtifacts(deps, task, verified.artifacts);
  const baseline = resultsWithStoredArtifacts({ scenarios: [], baseline: verified.baseline }, stored).baseline!;
  const at = stampOf(deps);
  const written = await deps.store.update({ key: keyOf(task.taskId, contractDigest),
    ops: [change.set("state", "RECORDED"), change.set("baseline", baseline as never), change.set("recordedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(at))],
    condition: when.and(when.present(), when.eq("state", "STARTED"), when.eq("contractDigest", contractDigest), when.eq("attempt", expected.attempt), when.eq("baseCommitSha", expected.baseCommitSha),
      when.eq("operationId", expected.operationId), when.eq("roundId", expected.roundId), when.eq("admissionSha256", expected.admissionSha256)) });
  return written.applied;
}

/** The record of the task's approved plan, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EBaselineRecord(store: WorkflowE2EBaselineStore, task: TaskForBaseline): Promise<BaselineRecord | undefined> {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) return undefined;
  const item = await store.store.get(keyOf(task.taskId, contractDigest));
  if (item === undefined || item["entityType"] !== "WORKFLOW_E2E_BASELINE" || item["taskId"] !== task.taskId || item["contractDigest"] !== contractDigest || item["purpose"] !== E2E_BASELINE_PURPOSE) return undefined;
  const state = item["state"];
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  const attempt = item["attempt"];
  const requestedAt = item["requestedAt"];
  if (typeof attempt !== "number" || typeof requestedAt !== "string") return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const baseline = item["baseline"] === undefined ? undefined : E2EDisplayBaselineSchema.safeParse(item["baseline"]);
  if (state === "RECORDED" && baseline?.success !== true) return undefined;
  // A list that is not a bounded list of ids and titles is no list: a baseline never shows part of one.
  const skipped = item["skippedAiScenarios"] === undefined ? undefined : SkippedAiScenariosSchema.safeParse(item["skippedAiScenarios"]);
  return { taskId: task.taskId, contractDigest, attempt, state, requestedAt, ...text("baseCommitSha"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"),
    ...text("startedAt"), ...text("deadlineAt"), ...text("recordedAt"), ...text("reason"), ...(baseline?.success === true ? { baseline: baseline.data } : {}),
    ...(skipped?.success === true && skipped.data.length > 0 ? { skippedAiScenarios: skipped.data } : {}) };
}

/** The baseline the task's page and Slack show for its approved plan, or undefined when there is nothing to show (yet). */
export async function readWorkflowE2EBaseline(store: WorkflowE2EBaselineStore, task: TaskForBaseline, nowMs: number = Date.now()) {
  const record = await readWorkflowE2EBaselineRecord(store, task);
  return record === undefined ? undefined : workflowE2EBaselineView(record, nowMs);
}
