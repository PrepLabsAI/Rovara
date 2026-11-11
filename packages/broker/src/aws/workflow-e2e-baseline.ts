import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EDisplayBaselineSchema, INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt, type E2EDisplayBaseline } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { isConditional } from "./broker-shared.js";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts, type WorkflowE2EArtifactStore } from "./workflow-e2e-artifacts.js";
import {
  E2E_BASELINE_PURPOSE, E2E_BASELINE_ATTEMPT, SkippedAiScenariosSchema, baselinePlanDigestOf, VERIFIED_BASELINE, workflowE2EBaselineView, type BaselineUnavailableReason, type SkippedAiScenarios, type BaselineRecord, type VerifiedBaseline,
} from "../e2e/baseline-round.js";
export {
  E2E_BASELINE_PURPOSE, E2E_BASELINE_ATTEMPT, E2E_BASELINE_RUN_GRACE_MS, baselineStartFailureReason, baselinePlanDigestOf, projectE2EBaselineWanted, VERIFIED_BASELINE, verifyBaselineEvidence, workflowE2EBaselineView,
  type BaselineState, type BaselineUnavailableReason, type SkippedAiScenarios, type BaselineRecord, type VerifiedBaseline,
} from "../e2e/baseline-round.js";

/**
 * M1.3 Task 3.7b, owner decision D2: the baseline round. When a plan with browser and API scenarios is approved, the approved scenarios run once on the unchanged code (the task's
 * base commit), so a reader can see what the change fixed. It is for information only and never gates (Review Focus 6):
 *
 *  - It is a round of its own kind: its admission and its operation sign `purpose: "baseline"`, the base commit and the attempt, and the candidate's verification refuses it.
 *  - Its outcome is one record beside the task, keyed by the approved plan, and nowhere in the workflow snapshot: it can never be a `qualifiedRound` or a `failedRound`, satisfy or
 *    block publication, or trigger send-back.
 *  - The record says when the round started and by when it must have ended, and is written conditionally (the plan, the base commit, the attempt, the operation and the round must
 *    all be the record's own), so a late or older result never overwrites a newer one. A round that never answers is shown as one that could not be run.
 *  - What it records is the broker's own verification of the evidence it accepted (`verifyBaselineEvidence`), never rows a caller supplies.
 *  - The record expires with the table's time to live, 30 days after it was last written (owner decision D4).
 *
 * If the round cannot be asked for, started or run, the display says "Couldn't run the checks on the unchanged code" and nothing else changes: not APPROVE, not the candidate's CHECKS.
 */

export type WorkflowE2EBaselineStore = Readonly<{ documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }>;

const keyOf = (taskId: string, contractDigest: string) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_BASELINE#${contractDigest}` });
const expiryOf = (at: string) => indexExpiresAt(at);

/**
 * Asks for the baseline round of a just-approved application plan, at most once per approved plan: the REQUESTED record is written only if there is none. Never changes the task. A
 * project that switched the baseline off, or a plan that is not an application plan, is asked for nothing and leaves nothing.
 */
export async function requestWorkflowE2EBaselineRound(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, options: { enabled: boolean }):
  Promise<"NOT_REQUESTED" | "REQUESTED" | "ALREADY"> {
  const contractDigest = baselinePlanDigestOf(task);
  if (!options.enabled || contractDigest === undefined) return "NOT_REQUESTED";
  const requestedAt = new Date().toISOString();
  try {
    await store.documentClient.send(new PutCommand({ TableName: store.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { ...keyOf(task.taskId, contractDigest), entityType: "WORKFLOW_E2E_BASELINE", schemaVersion: 2, taskId: task.taskId, contractDigest, purpose: E2E_BASELINE_PURPOSE,
        attempt: E2E_BASELINE_ATTEMPT, state: "REQUESTED", requestedAt, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) } }));
    return "REQUESTED";
  } catch (error) {
    if (isConditional(error)) return "ALREADY";
    throw error;
  }
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the base commit, the admission and the deadline, as one item of the transaction that
 * accepts the operation. A record that is not this plan's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function baselineStartItem(store: Pick<WorkflowE2EBaselineStore, "tableName">, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">,
  started: { baseCommitSha: string; operationId: string; roundId: string; admissionSha256: string; startedAt: string; deadlineAt: string; skippedAiScenarios?: SkippedAiScenarios }) {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) throw new Error("the task has no approved application plan for a baseline to belong to");
  // The AI-navigated scenarios the round leaves out ride on the record (Task 4.4c); a round that leaves none out writes the record exactly as it was.
  const skipped = started.skippedAiScenarios === undefined || started.skippedAiScenarios.length === 0 ? undefined : SkippedAiScenariosSchema.parse(started.skippedAiScenarios);
  return { Update: { TableName: store.tableName, Key: keyOf(task.taskId, contractDigest),
    UpdateExpression: `SET #state = :started, baseCommitSha = :base, operationId = :operation, roundId = :round, admissionSha256 = :admission, startedAt = :startedAt, deadlineAt = :deadline, #expires = :expires${skipped === undefined ? "" : ", skippedAiScenarios = :skipped"}`,
    ConditionExpression: "attribute_exists(pk) AND #state = :requested AND attempt = :attempt AND contractDigest = :digest",
    ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: { ":started": "STARTED", ":requested": "REQUESTED", ":attempt": E2E_BASELINE_ATTEMPT, ":digest": contractDigest, ":base": started.baseCommitSha,
      ":operation": started.operationId, ":round": started.roundId, ":admission": started.admissionSha256, ":startedAt": started.startedAt, ":deadline": started.deadlineAt,
      ":expires": expiryOf(started.startedAt), ...(skipped === undefined ? {} : { ":skipped": skipped }) } } };
}

/**
 * Marks the plan's baseline as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A
 * recorded result is never replaced, and neither is a round another operation owns. Returns whether the record was changed.
 */
export async function markWorkflowE2EBaselineUnavailable(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, reason: BaselineUnavailableReason,
  options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) return false;
  const at = new Date().toISOString();
  const from = options.from.map((_, index) => `:from${index}`);
  try {
    await store.documentClient.send(new UpdateCommand({ TableName: store.tableName, Key: keyOf(task.taskId, contractDigest),
      UpdateExpression: "SET #state = :unavailable, #reason = :reason, recordedAt = :at, #expires = :expires",
      ConditionExpression: `attribute_exists(pk) AND contractDigest = :digest AND (${from.map((name) => `#state = ${name}`).join(" OR ")})${options.operationId === undefined ? "" : " AND operationId = :operation"}`,
      ExpressionAttributeNames: { "#state": "state", "#reason": "reason", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":unavailable": "UNAVAILABLE", ":reason": reason, ":at": at, ":expires": expiryOf(at), ":digest": contractDigest,
        ...Object.fromEntries(options.from.map((state, index) => [`:from${index}`, state])), ...(options.operationId === undefined ? {} : { ":operation": options.operationId }) } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
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
  if (verified[VERIFIED_BASELINE] !== true || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) throw new Error("the verification is not of the round that was started");
  const stored = await storeWorkflowE2EArtifacts(deps, task, verified.artifacts);
  const baseline = resultsWithStoredArtifacts({ scenarios: [], baseline: verified.baseline }, stored).baseline!;
  const at = new Date().toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: keyOf(task.taskId, contractDigest),
      UpdateExpression: "SET #state = :recorded, baseline = :baseline, recordedAt = :at, #expires = :expires",
      ConditionExpression: "attribute_exists(pk) AND #state = :started AND contractDigest = :digest AND attempt = :attempt AND baseCommitSha = :base AND operationId = :operation AND roundId = :round AND admissionSha256 = :admission",
      ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":recorded": "RECORDED", ":started": "STARTED", ":baseline": baseline, ":at": at, ":expires": expiryOf(at), ":digest": contractDigest, ":attempt": expected.attempt,
        ":base": expected.baseCommitSha, ":operation": expected.operationId, ":round": expected.roundId, ":admission": expected.admissionSha256 } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** The record of the task's approved plan, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EBaselineRecord(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">): Promise<BaselineRecord | undefined> {
  const contractDigest = baselinePlanDigestOf(task);
  if (contractDigest === undefined) return undefined;
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: keyOf(task.taskId, contractDigest), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined || item.entityType !== "WORKFLOW_E2E_BASELINE" || item.taskId !== task.taskId || item.contractDigest !== contractDigest || item.purpose !== E2E_BASELINE_PURPOSE) return undefined;
  const state = item.state;
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  if (typeof item.attempt !== "number" || typeof item.requestedAt !== "string") return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const baseline = item.baseline === undefined ? undefined : E2EDisplayBaselineSchema.safeParse(item.baseline);
  if (state === "RECORDED" && baseline?.success !== true) return undefined;
  // A list that is not a bounded list of ids and titles is no list: a baseline never shows part of one.
  const skipped = item.skippedAiScenarios === undefined ? undefined : SkippedAiScenariosSchema.safeParse(item.skippedAiScenarios);
  return { taskId: task.taskId, contractDigest, attempt: item.attempt, state, requestedAt: item.requestedAt, ...text("baseCommitSha"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"),
    ...text("startedAt"), ...text("deadlineAt"), ...text("recordedAt"), ...text("reason"), ...(baseline?.success === true ? { baseline: baseline.data } : {}),
    ...(skipped?.success === true && skipped.data.length > 0 ? { skippedAiScenarios: skipped.data } : {}) };
}

/** The baseline the task's page and Slack show for its approved plan, or undefined when there is nothing to show (yet). */
export async function readWorkflowE2EBaseline(store: WorkflowE2EBaselineStore, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, nowMs: number = Date.now()): Promise<E2EDisplayBaseline | undefined> {
  const record = await readWorkflowE2EBaselineRecord(store, task);
  return record === undefined ? undefined : workflowE2EBaselineView(record, nowMs);
}

