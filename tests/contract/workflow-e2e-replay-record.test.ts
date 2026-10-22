import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { indexExpiresAt } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import {
  E2E_REPLAY_PURPOSE, listWorkflowE2EReplayRecords, markWorkflowE2EReplayUnavailable, readWorkflowE2EReplayRecord, recordWorkflowE2EReplay, replayStartItem, requestWorkflowE2EReplay,
  type VerifiedReplay,
} from "../../packages/broker/src/aws/workflow-e2e-replay.js";

// M1.4 Task 4.6b: the replay's record, E2E_REPLAY#<sourceRoundId>#<attempt>, beside the task. Conditional writes, the same 30-day TTL as the baseline's, and nothing of the task changed.

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const task = { taskId: TASK_ID } as never;
const store = () => { const db = new FakeDynamoDb(); return { db, documentClient: db as never, tableName: "state" }; };
const key = (attempt = 1, source = SOURCE) => ({ pk: `DEVTASK#${TASK_ID}`, sk: `E2E_REPLAY#${source}#${attempt}` });
const started = (overrides: Record<string, unknown> = {}) => ({ sourceRoundId: SOURCE, attempt: 1, operationId: "op-1", roundId: "round-1", admissionSha256: "c".repeat(64),
  startedAt: "2026-10-22T10:00:00.000Z", deadlineAt: "2026-10-22T10:25:00.000Z", ...overrides });
const start = (s: ReturnType<typeof store>, overrides: Record<string, unknown> = {}) => s.db.send(new TransactWriteCommand({ TransactItems: [replayStartItem(s, task, started(overrides))] }));
const verified = (overrides: Record<string, unknown> = {}) => ({ roundId: "round-1", admissionSha256: "c".repeat(64), replay: { status: "PASS", reproduced: true, downloadSha256Match: true },
  // Only the broker's own verification makes one: a test makes one the way verifyReplayEvidence does, by the symbol it keeps.
  ...overrides }) as unknown as VerifiedReplay;
const expectedOf = (overrides: Record<string, unknown> = {}) => ({ sourceRoundId: SOURCE, attempt: 1, operationId: "op-1", roundId: "round-1", admissionSha256: "c".repeat(64), ...overrides });

describe("asking for a replay (once per round and attempt)", () => {
  it("writes a REQUESTED record for the round and attempt, with the purpose and an expiry 30 days out", async () => {
    const s = store();
    expect(await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 })).toBe("REQUESTED");
    const stored = s.db.get(key().pk, key().sk);
    expect(stored).toMatchObject({ entityType: "WORKFLOW_E2E_REPLAY", taskId: TASK_ID, sourceRoundId: SOURCE, purpose: E2E_REPLAY_PURPOSE, attempt: 1, state: "REQUESTED" });
    expect(stored!.indexExpiresAt).toBe(indexExpiresAt(String(stored!.requestedAt)));
  });
  it("asks at most once for a round and attempt: the second ask finds the record and changes nothing; another attempt or another round is its own record", async () => {
    const s = store();
    await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 });
    const before = JSON.stringify(await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 }));
    expect(await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 })).toBe("ALREADY");
    expect(JSON.stringify(await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 }))).toBe(before);
    expect(await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 2 })).toBe("REQUESTED");
    expect(await requestWorkflowE2EReplay(s, task, { sourceRoundId: "44444444-4444-4444-8444-444444444444", attempt: 1 })).toBe("REQUESTED");
  });
});

describe("starting the replay writes a started record, once", () => {
  it("moves REQUESTED to STARTED with the operation, the round, the admission and the deadline", async () => {
    const s = store();
    await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 });
    await start(s);
    expect(await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 })).toMatchObject({ state: "STARTED", attempt: 1, sourceRoundId: SOURCE, operationId: "op-1",
      roundId: "round-1", admissionSha256: "c".repeat(64), deadlineAt: "2026-10-22T10:25:00.000Z" });
  });
  it("fails the whole transaction when the record is not this round's REQUESTED one: never asked for, already started, or another attempt (at most one start)", async () => {
    const never = store();
    await expect(start(never)).rejects.toThrow();
    const twice = store();
    await requestWorkflowE2EReplay(twice, task, { sourceRoundId: SOURCE, attempt: 1 });
    await start(twice);
    await expect(start(twice, { operationId: "op-2" })).rejects.toThrow();
    expect((await readWorkflowE2EReplayRecord(twice, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 }))?.operationId).toBe("op-1");
    const other = store();
    await requestWorkflowE2EReplay(other, task, { sourceRoundId: SOURCE, attempt: 1 });
    await expect(start(other, { attempt: 2 })).rejects.toThrow();
  });
});

describe("a replay that could not be run", () => {
  it("is marked only from the states named, and only for the operation named; a recorded result is never replaced", async () => {
    const s = store();
    await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 });
    await start(s);
    const round = { sourceRoundId: SOURCE, attempt: 1 };
    expect(await markWorkflowE2EReplayUnavailable(s, task, round, "run-failed", { from: ["STARTED"], operationId: "another" })).toBe(false);
    expect(await markWorkflowE2EReplayUnavailable(s, task, round, "run-failed", { from: ["REQUESTED"] })).toBe(false);
    expect(await markWorkflowE2EReplayUnavailable(s, task, round, "run-failed", { from: ["STARTED"], operationId: "op-1" })).toBe(true);
    expect(await readWorkflowE2EReplayRecord(s, TASK_ID, round)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    // Marking again from STARTED finds an UNAVAILABLE record and changes nothing.
    expect(await markWorkflowE2EReplayUnavailable(s, task, round, "timed-out", { from: ["STARTED"] })).toBe(false);
    expect((await readWorkflowE2EReplayRecord(s, TASK_ID, round))?.reason).toBe("run-failed");
  });
});

describe("recording the result", () => {
  it("refuses a verification that is not the broker's own, or is of another round or admission", async () => {
    const s = store();
    await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 });
    await start(s);
    // A plain object (what a caller could build) is not a verification: only verifyReplayEvidence makes one.
    await expect(recordWorkflowE2EReplay(s, task, { verified: verified(), expected: expectedOf() })).rejects.toThrow(/not of the round/);
    await expect(recordWorkflowE2EReplay(s, task, { verified: verified({ roundId: "another" }), expected: expectedOf() })).rejects.toThrow(/not of the round/);
    expect((await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 }))?.state).toBe("STARTED");
  });
  it("reads nothing from a record that is not a replay record of this task, or a recorded state with no result of the contract", async () => {
    const s = store();
    s.db.set({ ...key(), entityType: "WORKFLOW_E2E_BASELINE", taskId: TASK_ID, purpose: "baseline", state: "STARTED", sourceRoundId: SOURCE, attempt: 1, requestedAt: "2026-10-22T10:00:00.000Z" });
    expect(await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 })).toBeUndefined();
    s.db.set({ ...key(), entityType: "WORKFLOW_E2E_REPLAY", taskId: TASK_ID, purpose: E2E_REPLAY_PURPOSE, state: "RECORDED", sourceRoundId: SOURCE, attempt: 1, requestedAt: "2026-10-22T10:00:00.000Z",
      replay: { status: "PASS", reproduced: true, downloadSha256Match: true, free: "text" } });
    expect(await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 })).toBeUndefined();
    s.db.set({ ...key(), entityType: "WORKFLOW_E2E_REPLAY", taskId: "another-task", purpose: E2E_REPLAY_PURPOSE, state: "STARTED", sourceRoundId: SOURCE, attempt: 1, requestedAt: "2026-10-22T10:00:00.000Z" });
    expect(await readWorkflowE2EReplayRecord(s, TASK_ID, { sourceRoundId: SOURCE, attempt: 1 })).toBeUndefined();
  });
  it("lists the attempts of one source round, oldest first, and no other round's", async () => {
    const s = store();
    for (const attempt of [2, 1, 3]) await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt });
    await requestWorkflowE2EReplay(s, task, { sourceRoundId: "44444444-4444-4444-8444-444444444444", attempt: 1 });
    expect((await listWorkflowE2EReplayRecords(s, TASK_ID, SOURCE)).map((item) => item.attempt)).toEqual([1, 2, 3]);
  });
  it("is a record of its own, beside the task: nothing of it is written into the task's own item", async () => {
    const s = store();
    s.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "TASK", entityType: "DEVELOPER_TASK", workflow: { revision: 5 } });
    await requestWorkflowE2EReplay(s, task, { sourceRoundId: SOURCE, attempt: 1 });
    await start(s);
    expect(s.db.get(`DEVTASK#${TASK_ID}`, "TASK")).toEqual({ pk: `DEVTASK#${TASK_ID}`, sk: "TASK", entityType: "DEVELOPER_TASK", workflow: { revision: 5 } });
  });
});
