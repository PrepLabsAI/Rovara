import { GetCommand, QueryCommand, UpdateCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EReplayResultSchema, INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { isConditional } from "./broker-shared.js";
import {
  E2E_REPLAY_PURPOSE, VERIFIED_REPLAY, type ReplayUnavailableReason, type ReplayRecord, type VerifiedReplay,
} from "../e2e/replay-round.js";
export {
  E2E_REPLAY_PURPOSE, E2E_REPLAY_RUN_GRACE_MS, VERIFIED_REPLAY, replaySourceCasesOf, replayResultOf, verifyReplayEvidence,
  type ReplayState, type ReplayUnavailableReason, type ReplayRecord, type VerifiedReplay,
} from "../e2e/replay-round.js";

/**
 * M1.4 Task 4.6b: the audit replay of a verified AI-navigated round. An operator asks for it; it runs the same candidate, scenarios and accounts with no model, a read-only store that
 * serves only the recordings the verified round left (each bound by digest to the ledger the broker verified), and an executor that holds no model. It is an operator's check and nothing
 * else (Review Focus 6):
 *
 *  - It is a round of its own kind: its admission and its operation sign `purpose: "replay"`, the round it replays and the attempt, and the candidate's verification refuses it.
 *  - Its outcome is one record beside the task, `E2E_REPLAY#<sourceRoundId>#<attempt>`, and nowhere in the workflow snapshot: it can never be a `qualifiedRound` or a `failedRound`,
 *    satisfy or block publication, trigger send-back, or change the task page. The page does not show it in M1.4.
 *  - The record says when the round started and by when it must have ended, and is written conditionally (the source round, the attempt, the operation, the round and the admission
 *    must all be the record's own), so a late or older result never overwrites a newer one.
 *  - What it records is the broker's own verification of the evidence it accepted (`verifyReplayEvidence`), never rows a caller supplies.
 *  - The record expires with the table's time to live, 30 days after it was last written (owner decision D4).
 */

export type WorkflowE2EReplayStore = Readonly<{ documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }>;

const keyOf = (taskId: string, sourceRoundId: string, attempt: number) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_REPLAY#${sourceRoundId}#${attempt}` });
const expiryOf = (at: string) => indexExpiresAt(at);

/** Asks for the replay: the REQUESTED record is written only if there is none for this round and attempt. */
export async function requestWorkflowE2EReplay(store: WorkflowE2EReplayStore, task: Pick<DeveloperTaskRecord, "taskId">,
  input: { sourceRoundId: string; attempt: number; requestedBy?: string }): Promise<"REQUESTED" | "ALREADY"> {
  const requestedAt = new Date().toISOString();
  try {
    await store.documentClient.send(new PutCommand({ TableName: store.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { ...keyOf(task.taskId, input.sourceRoundId, input.attempt), entityType: "WORKFLOW_E2E_REPLAY", schemaVersion: 1, taskId: task.taskId, sourceRoundId: input.sourceRoundId,
        purpose: E2E_REPLAY_PURPOSE, attempt: input.attempt, state: "REQUESTED", requestedAt, ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
        [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) } }));
    return "REQUESTED";
  } catch (error) {
    if (isConditional(error)) return "ALREADY";
    throw error;
  }
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the admission and the deadline, as one item of the transaction that accepts the operation. A record
 * that is not this round's and attempt's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function replayStartItem(store: Pick<WorkflowE2EReplayStore, "tableName">, task: Pick<DeveloperTaskRecord, "taskId">,
  started: { sourceRoundId: string; attempt: number; operationId: string; roundId: string; admissionSha256: string; startedAt: string; deadlineAt: string }) {
  return { Update: { TableName: store.tableName, Key: keyOf(task.taskId, started.sourceRoundId, started.attempt),
    UpdateExpression: "SET #state = :started, operationId = :operation, roundId = :round, admissionSha256 = :admission, startedAt = :startedAt, deadlineAt = :deadline, #expires = :expires",
    ConditionExpression: "attribute_exists(pk) AND #state = :requested AND attempt = :attempt AND sourceRoundId = :source",
    ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: { ":started": "STARTED", ":requested": "REQUESTED", ":attempt": started.attempt, ":source": started.sourceRoundId, ":operation": started.operationId,
      ":round": started.roundId, ":admission": started.admissionSha256, ":startedAt": started.startedAt, ":deadline": started.deadlineAt, ":expires": expiryOf(started.startedAt) } } };
}

/**
 * Marks the replay as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A recorded result
 * is never replaced, and neither is a round another operation owns. Returns whether the record was changed.
 */
export async function markWorkflowE2EReplayUnavailable(store: WorkflowE2EReplayStore, task: Pick<DeveloperTaskRecord, "taskId">, round: { sourceRoundId: string; attempt: number },
  reason: ReplayUnavailableReason, options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  const at = new Date().toISOString();
  const from = options.from.map((_, index) => `:from${index}`);
  try {
    await store.documentClient.send(new UpdateCommand({ TableName: store.tableName, Key: keyOf(task.taskId, round.sourceRoundId, round.attempt),
      UpdateExpression: "SET #state = :unavailable, #reason = :reason, recordedAt = :at, #expires = :expires",
      ConditionExpression: `attribute_exists(pk) AND (${from.map((name) => `#state = ${name}`).join(" OR ")})${options.operationId === undefined ? "" : " AND operationId = :operation"}`,
      ExpressionAttributeNames: { "#state": "state", "#reason": "reason", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":unavailable": "UNAVAILABLE", ":reason": reason, ":at": at, ":expires": expiryOf(at),
        ...Object.fromEntries(options.from.map((state, index) => [`:from${index}`, state])), ...(options.operationId === undefined ? {} : { ":operation": options.operationId }) } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/**
 * Records the verified result for the round that was started, and writes it conditionally: only if the record still says this source round, this attempt, this operation, this round
 * and this admission, and is still STARTED. Returns whether it was written; a record that moved on (timed out, stopped) is left as it is.
 */
export async function recordWorkflowE2EReplay(store: WorkflowE2EReplayStore, task: Pick<DeveloperTaskRecord, "taskId">,
  input: { verified: VerifiedReplay; expected: { sourceRoundId: string; attempt: number; operationId: string; roundId: string; admissionSha256: string } }): Promise<boolean> {
  const { verified, expected } = input;
  if (verified[VERIFIED_REPLAY] !== true || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) throw new Error("the verification is not of the round that was started");
  const at = new Date().toISOString();
  try {
    await store.documentClient.send(new UpdateCommand({ TableName: store.tableName, Key: keyOf(task.taskId, expected.sourceRoundId, expected.attempt),
      UpdateExpression: "SET #state = :recorded, replay = :replay, recordedAt = :at, #expires = :expires",
      ConditionExpression: "attribute_exists(pk) AND #state = :started AND attempt = :attempt AND sourceRoundId = :source AND operationId = :operation AND roundId = :round AND admissionSha256 = :admission",
      ExpressionAttributeNames: { "#state": "state", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":recorded": "RECORDED", ":started": "STARTED", ":replay": verified.replay, ":at": at, ":expires": expiryOf(at), ":attempt": expected.attempt,
        ":source": expected.sourceRoundId, ":operation": expected.operationId, ":round": expected.roundId, ":admission": expected.admissionSha256 } }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

function recordOf(item: Record<string, unknown> | undefined, taskId: string): ReplayRecord | undefined {
  if (item === undefined || item.entityType !== "WORKFLOW_E2E_REPLAY" || item.taskId !== taskId || item.purpose !== E2E_REPLAY_PURPOSE) return undefined;
  const state = item.state;
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  if (typeof item.sourceRoundId !== "string" || typeof item.attempt !== "number" || typeof item.requestedAt !== "string") return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const replay = item.replay === undefined ? undefined : E2EReplayResultSchema.safeParse(item.replay);
  // A recorded result that is not a result of the contract is no record: nothing is shown of part of one.
  if (state === "RECORDED" && replay?.success !== true) return undefined;
  return { taskId, sourceRoundId: item.sourceRoundId, attempt: item.attempt, state, requestedAt: item.requestedAt, ...text("requestedBy"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"),
    ...text("startedAt"), ...text("deadlineAt"), ...text("recordedAt"), ...text("reason"), ...(replay?.success === true ? { replay: replay.data } : {}) };
}

/** The record of one attempt, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EReplayRecord(store: WorkflowE2EReplayStore, taskId: string, round: { sourceRoundId: string; attempt: number }): Promise<ReplayRecord | undefined> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: keyOf(taskId, round.sourceRoundId, round.attempt), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return recordOf(response.Item, taskId);
}

/** The records of every attempt for one source round, oldest attempt first (at most the attempt cap, so one page). */
export async function listWorkflowE2EReplayRecords(store: WorkflowE2EReplayStore, taskId: string, sourceRoundId: string): Promise<ReplayRecord[]> {
  const response = await store.documentClient.send(new QueryCommand({ TableName: store.tableName, ConsistentRead: true,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": `E2E_REPLAY#${sourceRoundId}#` } })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).flatMap((item) => recordOf(item, taskId) ?? []).sort((left, right) => left.attempt - right.attempt);
}

