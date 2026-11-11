// The audit replay of a verified AI-navigated round, on the document store. An operator asks for it; it runs the same candidate, scenarios and accounts with no model, a read-only store that
// serves only the recordings the verified round left, and an executor that holds no model. It is an operator's check and nothing else:
//
//  - It is a round of its own kind: its admission and its operation sign `purpose: "replay"`, the round it replays and the attempt, and the candidate's verification refuses it.
//  - Its outcome is one record beside the task, `E2E_REPLAY#<source round>#<attempt>`, and nowhere in the workflow snapshot: it can never be a qualified or a failed round, satisfy or
//    block publication, trigger a send-back, or change the task page.
//  - The record says when the round started and by when it must have ended, and is written conditionally (the source round, the attempt, the operation, the round and the admission must
//    all be the record's own), so a late or older result never overwrites a newer one.
//  - What it records is the broker's own verification of the evidence it accepted, never rows a caller supplies. The record expires 30 days after it was last written.
//
// The key (`DEVTASK#<task>` / `E2E_REPLAY#<source round>#<attempt>`) and every attribute are Cloud's: no stored-key difference. The pure parts are the ones in `aws/workflow-e2e-replay.ts`.
import { E2EReplayResultSchema, INDEX_EXPIRY_ATTRIBUTE, change, indexExpiresAt, queryAll, when, type TransactItem } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { E2E_REPLAY_PURPOSE, type ReplayRecord, type ReplayUnavailableReason, type VerifiedReplay } from "../../e2e/replay-round.js";
import { asDocument, isVerifiedBy, stampOf, type E2EStateStore } from "./state.js";

export {
  E2E_REPLAY_PURPOSE, E2E_REPLAY_RUN_GRACE_MS, replayResultOf, replaySourceCasesOf, verifyReplayEvidence,
  type ReplayRecord, type ReplayState, type ReplayUnavailableReason, type VerifiedReplay,
} from "../../e2e/replay-round.js";

export type WorkflowE2EReplayStore = E2EStateStore;

const keyOf = (taskId: string, sourceRoundId: string, attempt: number) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_REPLAY#${sourceRoundId}#${attempt}` });
const expiryOf = (at: string) => indexExpiresAt(at);

/** Asks for the replay: the REQUESTED record is written only if there is none for this round and attempt. */
export async function requestWorkflowE2EReplay(store: WorkflowE2EReplayStore, task: Pick<DeveloperTaskRecord, "taskId">,
  input: { sourceRoundId: string; attempt: number; requestedBy?: string }): Promise<"REQUESTED" | "ALREADY"> {
  const requestedAt = stampOf(store);
  const written = await store.store.put({ condition: when.absent(),
    item: asDocument({ ...keyOf(task.taskId, input.sourceRoundId, input.attempt), entityType: "WORKFLOW_E2E_REPLAY", schemaVersion: 1, taskId: task.taskId, sourceRoundId: input.sourceRoundId,
      purpose: E2E_REPLAY_PURPOSE, attempt: input.attempt, state: "REQUESTED", requestedAt, ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(requestedAt) }) });
  return written.applied ? "REQUESTED" : "ALREADY";
}

/**
 * The write that starts the round: REQUESTED to STARTED with the operation, the round, the admission and the deadline, as one item of the transaction that accepts the operation. A record
 * that is not this round's and attempt's REQUESTED one (never asked for, already started) fails the condition and so does the transaction: at most one start.
 */
export function replayStartItem(task: Pick<DeveloperTaskRecord, "taskId">,
  started: { sourceRoundId: string; attempt: number; operationId: string; roundId: string; admissionSha256: string; startedAt: string; deadlineAt: string }): TransactItem {
  return { kind: "update", key: keyOf(task.taskId, started.sourceRoundId, started.attempt),
    ops: [change.set("state", "STARTED"), change.set("operationId", started.operationId), change.set("roundId", started.roundId), change.set("admissionSha256", started.admissionSha256),
      change.set("startedAt", started.startedAt), change.set("deadlineAt", started.deadlineAt), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(started.startedAt))],
    condition: when.and(when.present(), when.eq("state", "REQUESTED"), when.eq("attempt", started.attempt), when.eq("sourceRoundId", started.sourceRoundId)) };
}

/**
 * Marks the replay as one that could not be run, only if the record is still in one of the states named (and, when an operation is named, still that operation's). A recorded result
 * is never replaced, and neither is a round another operation owns. Returns whether the record was changed.
 */
export async function markWorkflowE2EReplayUnavailable(store: WorkflowE2EReplayStore, task: Pick<DeveloperTaskRecord, "taskId">, round: { sourceRoundId: string; attempt: number },
  reason: ReplayUnavailableReason, options: { from: ReadonlyArray<"REQUESTED" | "STARTED" | "UNAVAILABLE">; operationId?: string }): Promise<boolean> {
  const at = stampOf(store);
  const written = await store.store.update({ key: keyOf(task.taskId, round.sourceRoundId, round.attempt),
    ops: [change.set("state", "UNAVAILABLE"), change.set("reason", reason), change.set("recordedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(at))],
    condition: when.and(when.present(), when.or(...options.from.map((state) => when.eq("state", state))), ...(options.operationId === undefined ? [] : [when.eq("operationId", options.operationId)])) });
  return written.applied;
}

/**
 * Records the verified result for the round that was started, and writes it conditionally: only if the record still says this source round, this attempt, this operation, this round
 * and this admission, and is still STARTED. Returns whether it was written; a record that moved on (timed out, stopped) is left as it is.
 */
export async function recordWorkflowE2EReplay(store: WorkflowE2EReplayStore, task: Pick<DeveloperTaskRecord, "taskId">,
  input: { verified: VerifiedReplay; expected: { sourceRoundId: string; attempt: number; operationId: string; roundId: string; admissionSha256: string } }): Promise<boolean> {
  const { verified, expected } = input;
  if (!isVerifiedBy(verified, "verified-replay") || verified.roundId !== expected.roundId || verified.admissionSha256 !== expected.admissionSha256) throw new Error("the verification is not of the round that was started");
  const at = stampOf(store);
  const written = await store.store.update({ key: keyOf(task.taskId, expected.sourceRoundId, expected.attempt),
    ops: [change.set("state", "RECORDED"), change.set("replay", verified.replay as never), change.set("recordedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(at))],
    condition: when.and(when.present(), when.eq("state", "STARTED"), when.eq("attempt", expected.attempt), when.eq("sourceRoundId", expected.sourceRoundId), when.eq("operationId", expected.operationId),
      when.eq("roundId", expected.roundId), when.eq("admissionSha256", expected.admissionSha256)) });
  return written.applied;
}

function recordOf(item: Record<string, unknown> | undefined, taskId: string): ReplayRecord | undefined {
  if (item === undefined || item["entityType"] !== "WORKFLOW_E2E_REPLAY" || item["taskId"] !== taskId || item["purpose"] !== E2E_REPLAY_PURPOSE) return undefined;
  const state = item["state"];
  if (state !== "REQUESTED" && state !== "STARTED" && state !== "RECORDED" && state !== "UNAVAILABLE") return undefined;
  const sourceRoundId = item["sourceRoundId"];
  const attempt = item["attempt"];
  const requestedAt = item["requestedAt"];
  if (typeof sourceRoundId !== "string" || typeof attempt !== "number" || typeof requestedAt !== "string") return undefined;
  const text = (name: string) => (typeof item[name] === "string" ? { [name]: item[name] } : {});
  const replay = item["replay"] === undefined ? undefined : E2EReplayResultSchema.safeParse(item["replay"]);
  // A recorded result that is not a result of the contract is no record: nothing is shown of part of one.
  if (state === "RECORDED" && replay?.success !== true) return undefined;
  return { taskId, sourceRoundId, attempt, state, requestedAt, ...text("requestedBy"), ...text("operationId"), ...text("roundId"), ...text("admissionSha256"),
    ...text("startedAt"), ...text("deadlineAt"), ...text("recordedAt"), ...text("reason"), ...(replay?.success === true ? { replay: replay.data } : {}) };
}

/** The record of one attempt, or undefined when there is none (or what is stored is not what it should be). */
export async function readWorkflowE2EReplayRecord(store: WorkflowE2EReplayStore, taskId: string, round: { sourceRoundId: string; attempt: number }): Promise<ReplayRecord | undefined> {
  return recordOf(await store.store.get(keyOf(taskId, round.sourceRoundId, round.attempt)), taskId);
}

/** The records of every attempt for one source round, oldest attempt first. */
export async function listWorkflowE2EReplayRecords(store: WorkflowE2EReplayStore, taskId: string, sourceRoundId: string): Promise<ReplayRecord[]> {
  const items = await queryAll(store.store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: `E2E_REPLAY#${sourceRoundId}#` } });
  return items.flatMap((item) => recordOf(item, taskId) ?? []).sort((left, right) => left.attempt - right.attempt);
}
