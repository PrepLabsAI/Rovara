import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { workflowSendBackOffered } from "@agentx/contracts";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { startApplicationRound, type RoundCore } from "../support/e2e-application-round-harness.js";
import { FAIL, PASS, runRound } from "../support/e2e-application-round-run.js";
import { call } from "../support/slack-broker.js";
import { MAYA } from "../support/developer-task-broker.js";
import { failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import type { DurableOutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { startTaskWorkflowE2EReplayFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { replayStartItem, requestWorkflowE2EReplay } from "../../packages/broker/src/aws/workflow-e2e-replay.js";

// M1.4 Task 4.6b (tests 16 and 17) on the real broker: the operator's request to replay a task's qualified round refuses before a runner is started or anything is recorded, for each of its
// reasons; and a replay round, whatever its result, changes nothing in the workflow, the qualification, send-back or publication.

afterEach(() => { vi.useRealTimers(); return disposeRealCandidates(); });
const ADMIN = { subject: "admin-subject", admin: true };
const replayCall = (round: RoundCore, method: "POST" | "GET", options: { body?: unknown; query?: string; user?: { subject: string; admin?: boolean } } = {}) => call(round.harness.handler, {
  method, path: `/v1/admin/tasks/${round.taskId}/e2e-replay${options.query ?? ""}`, user: options.user ?? ADMIN, ...(options.body === undefined ? {} : { body: options.body }) });
const e2eOf = (round: RoundCore) => round.workflowNow().e2e as { qualifiedRound?: Record<string, unknown>; failedRound?: Record<string, unknown>; currentRoundId?: string; required?: boolean };
const messageOf = (response: { body: Record<string, unknown> }) => String((response.body.error as { message?: string } | undefined)?.message ?? "");
const replayRows = (round: RoundCore) => round.harness.db.find((item) => item.pk === `DEVTASK#${round.taskId}` && String(item.sk).startsWith("E2E_REPLAY#"));
const qualified = async () => {
  const round = await startApplicationRound({ baseline: "off" });
  await runRound(round, [PASS]);
  expect(e2eOf(round).qualifiedRound, JSON.stringify(round.workflowNow())).toBeDefined();
  return round;
};
const roundIdOf = (round: RoundCore) => String(e2eOf(round).qualifiedRound!.roundId);
const record = (round: RoundCore, attempt: number, overrides: Record<string, unknown> = {}) => round.harness.db.set({ pk: `DEVTASK#${round.taskId}`, sk: `E2E_REPLAY#${roundIdOf(round)}#${attempt}`,
  entityType: "WORKFLOW_E2E_REPLAY", schemaVersion: 1, taskId: round.taskId, sourceRoundId: roundIdOf(round), purpose: "replay", attempt, state: "RECORDED",
  requestedAt: "2026-10-22T10:00:00.000Z", replay: { status: "PASS", reproduced: true, downloadSha256Match: true }, ...overrides });

describe("the operator's request to replay a qualified round refuses before anything is started or recorded", () => {
  it("test 17a: a round that is not the task's qualified round (none yet, or another id) is refused, and nothing is created", async () => {
    const round = await startApplicationRound({ baseline: "off" });
    const before = round.checksOperations().length;
    const early = await replayCall(round, "POST", { body: { roundId: round.admissionRef.roundId } });
    expect(early.status, JSON.stringify(early.body)).toBe(400);
    expect(messageOf(early)).toMatch(/^replay-not-qualified/);
    await runRound(round, [PASS]);
    const other = await replayCall(round, "POST", { body: { roundId: randomUUID() } });
    expect(messageOf(other)).toMatch(/^replay-not-qualified/);
    expect(round.checksOperations()).toHaveLength(before);
    expect(replayRows(round)).toEqual([]);
  });

  it("test 17b / Q3: a qualified round that left no recording (every round from before the recordings, and every round with no AI navigation step) is refused replay-no-recording: the source was verified again, no operation is created and nothing is recorded", async () => {
    const round = await qualified();
    const operations = round.harness.db.find((item) => item.pk === `WORKSPACE#${round.workspaceId}` && item.entityType === "OPERATION").length;
    const response = await replayCall(round, "POST", { body: { roundId: roundIdOf(round) } });
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(messageOf(response)).toMatch(/^replay-no-recording/);
    expect(round.harness.db.find((item) => item.pk === `WORKSPACE#${round.workspaceId}` && item.entityType === "OPERATION")).toHaveLength(operations);
    expect(replayRows(round)).toEqual([]);
    expect(round.workflowNow()).toMatchObject({ stage: "REVIEW" });
  });

  it("test 17c: a source the broker cannot verify as PASS now is refused replay-source-not-pass: a round claimed qualified over evidence of a failure", async () => {
    const round = await startApplicationRound({ baseline: "off" });
    await runRound(round, [FAIL]);
    const failed = e2eOf(round).failedRound!;
    const task = round.taskNow() as { workflow: { e2e: Record<string, unknown>; candidate: { digest: string } } };
    // The record claims the failed round qualified (nothing in the broker writes this; the replay does not rely on the claim).
    const claimed = { candidateDigest: task.workflow.candidate.digest, contractDigest: String(task.workflow.e2e.contractDigest), policyDigest: "a".repeat(64), bundleDigest: "b".repeat(64),
      executionPlanDigest: "c".repeat(64), roundId: failed.roundId, groupRunIds: failed.groupRunIds, admissionSha256: failed.admissionSha256, evidenceSha256: failed.evidenceSha256 };
    round.harness.db.set({ ...task, workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, qualifiedRound: claimed } } });
    const response = await replayCall(round, "POST", { body: { roundId: String(failed.roundId) } });
    expect(messageOf(response)).toMatch(/^replay-source-not-pass/);
    expect(replayRows(round)).toEqual([]);
  });

  it("test 17d / R5: a source that cannot be read (its evidence is gone), or a task whose candidate is no longer the qualified one, is refused replay-source-unavailable before any spend", async () => {
    const gone = await qualified();
    const aggregateKey = (gone.operationNow().workflowE2EEvidenceRef as { key: string }).key;
    gone.harness.s3.objects.delete(aggregateKey);
    expect(messageOf(await replayCall(gone, "POST", { body: { roundId: roundIdOf(gone) } }))).toMatch(/^replay-source-unavailable/);
    const moved = await qualified();
    const task = moved.taskNow() as { workflow: { candidate: { digest: string } } };
    moved.harness.db.set({ ...task, workflow: { ...task.workflow, candidate: { ...task.workflow.candidate, digest: "f".repeat(64) } } });
    expect(messageOf(await replayCall(moved, "POST", { body: { roundId: roundIdOf(moved) } }))).toMatch(/^replay-source-unavailable/);
    expect(replayRows(gone)).toEqual([]);
    expect(replayRows(moved)).toEqual([]);
  });

  it("test 17e: a closed task is refused replay-task-closed", async () => {
    const round = await qualified();
    const task = round.taskNow();
    round.harness.db.set({ ...task, closedAt: new Date().toISOString() });
    expect(messageOf(await replayCall(round, "POST", { body: { roundId: roundIdOf(round) } }))).toMatch(/^replay-task-closed/);
  });

  it("test 17f: a replay that is still running holds the next one back (409), and a round is replayed at most five times", async () => {
    const running = await qualified();
    record(running, 1, { state: "STARTED", operationId: "op", roundId: randomUUID(), admissionSha256: "a".repeat(64), startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 600_000).toISOString(), replay: undefined });
    const busy = await replayCall(running, "POST", { body: { roundId: roundIdOf(running) } });
    expect(busy.status).toBe(409);
    expect(messageOf(busy)).toMatch(/^replay-in-progress/);
    const exhausted = await qualified();
    for (const attempt of [1, 2, 3, 4, 5]) record(exhausted, attempt);
    expect(messageOf(await replayCall(exhausted, "POST", { body: { roundId: roundIdOf(exhausted) } }))).toMatch(/^replay-attempts-exhausted/);
  });

  it("REPLAYCAP: a start that was refused before anything ran does not count toward the five-attempt cap, and a round whose attempts all ran does", async () => {
    const failedStart = { state: "UNAVAILABLE", reason: "start-failed", replay: undefined };
    // Five attempts that never started (a busy workspace, a fault): the next request goes on to the source checks instead of being refused as exhausted.
    const neverStarted = await qualified();
    for (const attempt of [1, 2, 3, 4, 5]) record(neverStarted, attempt, failedStart);
    expect(messageOf(await replayCall(neverStarted, "POST", { body: { roundId: roundIdOf(neverStarted) } }))).toMatch(/^replay-no-recording/);
    // Four that ran and one that never started: four count.
    const four = await qualified();
    for (const attempt of [1, 2, 3, 4]) record(four, attempt);
    record(four, 5, failedStart);
    expect(messageOf(await replayCall(four, "POST", { body: { roundId: roundIdOf(four) } }))).toMatch(/^replay-no-recording/);
    // A request that was made and lapsed before it started is one that never ran, too.
    const lapsed = await qualified();
    for (const attempt of [1, 2, 3, 4]) record(lapsed, attempt);
    record(lapsed, 5, { state: "REQUESTED", requestedAt: "2026-10-22T10:00:00.000Z", replay: undefined });
    expect(messageOf(await replayCall(lapsed, "POST", { body: { roundId: roundIdOf(lapsed) } }))).toMatch(/^replay-no-recording/);
    expect(lapsed.harness.db.get(`DEVTASK#${lapsed.taskId}`, `E2E_REPLAY#${roundIdOf(lapsed)}#5`)).toMatchObject({ state: "UNAVAILABLE", reason: "start-failed" });
    // Five that ran (recorded, or timed out and so did run) are the cap, whatever else is there.
    const ran = await qualified();
    for (const attempt of [1, 2, 3, 4]) record(ran, attempt);
    record(ran, 5, { state: "UNAVAILABLE", reason: "timed-out", replay: undefined });
    record(ran, 6, failedStart);
    expect(messageOf(await replayCall(ran, "POST", { body: { roundId: roundIdOf(ran) } }))).toMatch(/^replay-attempts-exhausted/);
    // The records that never-started attempts leave are bounded on their own: twenty of them end the requests.
    const many = await qualified();
    for (let attempt = 1; attempt <= 20; attempt += 1) record(many, attempt, failedStart);
    expect(messageOf(await replayCall(many, "POST", { body: { roundId: roundIdOf(many) } }))).toMatch(/^replay-attempts-exhausted/);
    const nineteen = await qualified();
    for (let attempt = 1; attempt <= 19; attempt += 1) record(nineteen, attempt, failedStart);
    expect(messageOf(await replayCall(nineteen, "POST", { body: { roundId: roundIdOf(nineteen) } }))).toMatch(/^replay-no-recording/);
  });

  it("a replay that never answered (past its deadline and the grace) does not hold the next one: it is marked timed-out and the request goes on to the source checks", async () => {
    const round = await qualified();
    record(round, 1, { state: "STARTED", operationId: "op", roundId: randomUUID(), admissionSha256: "a".repeat(64), startedAt: "2026-10-22T10:00:00.000Z", deadlineAt: "2026-10-22T10:25:00.000Z", replay: undefined });
    const response = await replayCall(round, "POST", { body: { roundId: roundIdOf(round) } });
    expect(messageOf(response)).toMatch(/^replay-no-recording/);
    expect(round.harness.db.get(`DEVTASK#${round.taskId}`, `E2E_REPLAY#${roundIdOf(round)}#1`)).toMatchObject({ state: "UNAVAILABLE", reason: "timed-out" });
  });

  it("is an administrator's: a caller without the claim, and a malformed request, are refused", async () => {
    const round = await qualified();
    expect((await replayCall(round, "POST", { body: { roundId: roundIdOf(round) }, user: { subject: "someone" } })).status).toBe(403);
    expect((await replayCall(round, "POST", { body: { roundId: "not-a-uuid" } })).status).toBe(400);
    expect((await replayCall(round, "POST", { body: { roundId: roundIdOf(round), extra: true } })).status).toBe(400);
    expect(replayRows(round)).toEqual([]);
  });

  it("reads the record of each attempt for the operator, and nothing else about it: state, times, the broker's result and a reason; never an operation or object id", async () => {
    const round = await qualified();
    record(round, 2, { operationId: "operation-secret-id", admissionSha256: "e".repeat(64), roundId: "round-secret-id" });
    record(round, 1, { state: "UNAVAILABLE", reason: "run-failed", replay: undefined });
    const read = await replayCall(round, "GET", { query: "" });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const replays = read.body.replays as Array<Record<string, unknown>>;
    expect(replays.map((item) => [item.attempt, item.state])).toEqual([[1, "UNAVAILABLE"], [2, "RECORDED"]]);
    expect(replays[1]!.replay).toEqual({ status: "PASS", reproduced: true, downloadSha256Match: true });
    expect(JSON.stringify(read.body)).not.toMatch(/secret-id|eeeeeeee/);
    expect((await replayCall(round, "GET", { query: "", user: { subject: "someone" } })).status).toBe(403);
  });
});

// Task FU2 (REPLAYACTOR): a replay is the administrator's request, and the task's own turn log says so. The task's developer stays the owner of the turn; the administrator who asked is its
// `admin`. (Started directly: a round with a recording to replay needs a real agent run, which the Docker journeys make.)
describe("who a replay is recorded under (Task FU2)", () => {
  it("the turn of a started replay names the requesting administrator as its admin, keeps the task's developer as its owner, and the record keeps the administrator's owner key", async () => {
    const round = await qualified();
    const sourceRoundId = roundIdOf(round);
    const task = round.taskNow() as { developerId: string; workflow: { revision: number; candidate: { digest: string } } };
    const base = round.operationNow().workflowE2EAdmission as Record<string, unknown>;
    const replayRoundId = randomUUID();
    const operationId = randomUUID();
    // The checks have ended; the workspace is idle for the next operation.
    const workspace = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, "META")!;
    const { activeOperationId: _active, ...idle } = workspace; void _active;
    round.harness.db.set({ ...idle, status: "READY" });
    const store = { documentClient: round.harness.db as never, tableName: "state" };
    expect(await requestWorkflowE2EReplay(store, task as never, { sourceRoundId, attempt: 1, requestedBy: "owner-key-of-the-admin" })).toBe("REQUESTED");
    const deps = { documentClient: round.harness.db, tableName: "state", now: Date.now, actions: round.harness.actions };
    const admin = { issuer: "https://admin.example", subject: "admin-subject", displayName: "Ada Administrator" };
    const outcome = await startTaskWorkflowE2EReplayFromSystem(deps as never, round.taskId, { sourceRoundId, candidateDigest: task.workflow.candidate.digest },
      { ...base, roundId: replayRoundId, workflowRevision: task.workflow.revision, purpose: "replay", sourceRoundId, attempt: 1 } as never, operationId,
      [replayStartItem(store, task as never, { sourceRoundId, attempt: 1, operationId, roundId: replayRoundId, admissionSha256: String((base.admissionRef as { sha256: string }).sha256),
        startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 600_000).toISOString() })], admin);
    expect(outcome).toBe("STARTED");
    const turns = round.harness.db.find((item) => item.requestText === "Run audit replay of a verified round");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ origin: "ai_tool", admin: { issuer: admin.issuer, subject: admin.subject, displayName: admin.displayName }, developer: { developerId: task.developerId } });
    expect(turns[0]!.developer).not.toMatchObject({ developerId: admin.subject });
    expect(round.harness.db.get(`DEVTASK#${round.taskId}`, `E2E_REPLAY#${sourceRoundId}#1`)).toMatchObject({ state: "STARTED", requestedBy: "owner-key-of-the-admin" });
  });

  it("a request refused before anything starts records nobody and logs nobody as the requester", async () => {
    const round = await qualified();
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
    try {
      // Past the source checks the request stops at the missing recording, before anything is requested: no record, and no line saying who asked.
      expect(messageOf(await replayCall(round, "POST", { body: { roundId: roundIdOf(round) } }))).toMatch(/^replay-no-recording/);
    } finally { log.mockRestore(); }
    expect(replayRows(round)).toEqual([]);
    expect(logs.filter((line) => line.includes("workflow.e2e_replay_requested"))).toEqual([]);
  });
});

// Test 16: a replay that is FAILED, UNKNOWN or lost changes nothing. The replay's operation is a CHECKS operation signed as a replay (purpose, source round, attempt); the workflow is
// made to look as hostile as it can (running its checks, with the replay's round as the current round), and the result is still only the replay's own record.
describe("test 16: a replay never gates", () => {
  /**
   * A running replay operation on a round of the API fixture. By default the task is past its checks (qualified, in review). With `looksCurrent` the task is still running its checks (a
   * retry after a send-back, say) and the replay's round is made the workflow's current round: as hostile a setup as there is.
   */
  async function replayOperation(options: { looksCurrent?: boolean; signedAs?: "replay" | "candidate" } = {}) {
    const round = options.looksCurrent === true ? await startApplicationRound({ baseline: "off" }) : await qualified();
    const sourceRoundId = options.looksCurrent === true ? round.admissionRef.roundId : roundIdOf(round);
    const checks = round.operationNow();
    const operationId = randomUUID();
    const replayRoundId = randomUUID();
    const base = checks.workflowE2EAdmission as Record<string, unknown> & { admissionRef: Record<string, unknown>; groupRunIds: string[] };
    const ref = options.signedAs === "candidate" ? { ...base, roundId: replayRoundId } : { ...base, roundId: replayRoundId, purpose: "replay", sourceRoundId, attempt: 1 };
    const workspace = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, "META")!;
    const { activeOperationId: _active, ...rest } = workspace; void _active;
    round.harness.db.set({ ...rest, status: "BUSY", activeOperationId: operationId, fence: Number(checks.fence) + 1 });
    round.harness.db.set({ ...checks, id: operationId, sk: `OPERATION#${operationId}`, status: "RUNNING", fence: Number(checks.fence) + 1, workflowE2EAdmission: ref,
      workflowE2EEvidenceRef: undefined, workflowE2EGroupEvidenceRefs: undefined, workflowE2EGroupRunIds: undefined });
    // The worker is told of the replay through an outbox row of its own (the callbacks are authorized by the capability it carries).
    const outbox = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === round.operationId)[0]!;
    const outboxId = randomUUID();
    const fence = Number(checks.fence) + 1;
    const callbackCapability = issueCapability(round.harness.brokerInput as { callbackSigningKey: string }, round.workspaceId, operationId, fence, false, false, false, false, false, true, false);
    round.harness.db.set({ ...outbox, pk: `OUTBOX#${outboxId}`, id: outboxId, operationId, invocation: { ...(outbox.invocation as object), operationId, fence, callbackCapability } });
    round.harness.db.set({ pk: `DEVTASK#${round.taskId}`, sk: `E2E_REPLAY#${sourceRoundId}#1`, entityType: "WORKFLOW_E2E_REPLAY", schemaVersion: 1, taskId: round.taskId, sourceRoundId,
      purpose: "replay", attempt: 1, state: "STARTED", requestedAt: new Date().toISOString(), operationId, roundId: replayRoundId, admissionSha256: String(ref.admissionRef.sha256),
      startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 600_000).toISOString() });
    if (options.looksCurrent === true) {
      const task = round.taskNow() as { workflow: Record<string, unknown> & { e2e: Record<string, unknown> } };
      round.harness.db.set({ ...task, workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, currentRoundId: replayRoundId, currentGroupRunIds: base.groupRunIds } } });
    }
    return { round, operationId, sourceRoundId, replayRoundId };
  }
  const key = (round: RoundCore, sourceRoundId: string) => ({ pk: `DEVTASK#${round.taskId}`, sk: `E2E_REPLAY#${sourceRoundId}#1` });
  const snapshot = (round: RoundCore) => JSON.stringify(round.workflowNow());

  it("a replay that ends FAILED, CANCELLED or SUCCEEDED with nothing to verify records only its own state, and leaves the workflow, the qualification, send-back and publication as they were", async () => {
    for (const [status, state, reason] of [["FAILED", "UNAVAILABLE", "run-failed"], ["CANCELLED", "UNAVAILABLE", "stopped"], ["SUCCEEDED", "UNAVAILABLE", "unverified"]] as const) {
      const { round, operationId, sourceRoundId } = await replayOperation();
      const before = snapshot(round);
      await round.harness.finish(round.workspaceId, operationId, status, status === "FAILED" ? { error: "the runner died" } : undefined);
      const stored = round.harness.db.get(key(round, sourceRoundId).pk, key(round, sourceRoundId).sk)!;
      expect(stored, status).toMatchObject({ state, reason });
      expect(snapshot(round), status).toBe(before);
      expect(e2eOf(round).qualifiedRound, status).toBeDefined();
      expect(e2eOf(round).failedRound, status).toBeUndefined();
      expect(workflowSendBackOffered(round.workflowNow() as never), status).toBe(false);
    }
  });

  it("cannot be mistaken for the candidate's round even when the workflow looks as if it were running it: no qualification, no failure, no block", async () => {
    for (const status of ["FAILED", "SUCCEEDED"] as const) {
      const { round, operationId, sourceRoundId, replayRoundId } = await replayOperation({ looksCurrent: true });
      const before = snapshot(round);
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
      await round.harness.finish(round.workspaceId, operationId, status, status === "FAILED" ? { error: "the runner died" } : undefined);
      expect(snapshot(round), status).toBe(before);
      expect(e2eOf(round).currentRoundId).toBe(replayRoundId);
      expect(e2eOf(round).failedRound, status).toBeUndefined();
      expect(round.harness.db.get(key(round, sourceRoundId).pk, key(round, sourceRoundId).sk), status).toMatchObject({ state: "UNAVAILABLE" });
    }
  });

  it("control: the same hostile setup with the operation signed as a candidate's CHECKS does move the workflow (so the refusals above are the purpose, not the setup)", async () => {
    const { round, operationId } = await replayOperation({ looksCurrent: true, signedAs: "candidate" });
    const before = snapshot(round);
    await round.harness.finish(round.workspaceId, operationId, "FAILED", { error: "the runner died" });
    expect(snapshot(round)).not.toBe(before);
    expect(round.workflowNow().state).toBe("BLOCKED");
  });

  it("a lost candidate CHECKS (the outbox gave up) does block the workflow, which is what a lost replay must not do", async () => {
    const { round, operationId } = await replayOperation({ looksCurrent: true, signedAs: "candidate" });
    const op = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!;
    round.harness.db.set({ ...op, status: "ACCEPTED" });
    const lost = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as unknown as DurableOutboxRecord;
    const before = snapshot(round);
    await failOutboxOperation(round.harness.db as never, "state", lost, "delivery gave up");
    expect(snapshot(round)).not.toBe(before);
    expect(round.workflowNow().state).toBe("BLOCKED");
  });

  it("serves the replay's admission to its running operation while the workflow is somewhere else, and refuses it once the record no longer says this operation is the replay's started round", async () => {
    const { round, operationId, sourceRoundId } = await replayOperation();
    const capability = String((round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string }).callbackCapability);
    const ref = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!.workflowE2EAdmission as { admissionRef: { sha256: string } };
    const read = () => call(round.harness.handler, { method: "POST", path: `/v1/internal/workspaces/${round.workspaceId}/operations/${operationId}/e2e-admission`,
      headers: { "x-agentx-callback-capability": capability }, body: { stage: "read", offset: 0, sha256: ref.admissionRef.sha256 } });
    const served = await read();
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const stored = round.harness.db.get(key(round, sourceRoundId).pk, key(round, sourceRoundId).sk)!;
    for (const edit of [{ state: "UNAVAILABLE", reason: "timed-out" }, { operationId: "someone-else" }, { admissionSha256: "9".repeat(64) }, { roundId: randomUUID() }]) {
      round.harness.db.set({ ...stored, ...edit });
      expect((await read()).status, JSON.stringify(edit)).toBe(409);
    }
    round.harness.db.set(stored);
    round.harness.db.set({ ...(round.taskNow()), closedAt: new Date().toISOString() });
    expect((await read()).status).toBe(409);
  });

  it("a replay lost before it reached the worker (the outbox gave up) blocks nothing, even when the workflow looks as if it were running it", async () => {
    const { round, operationId, sourceRoundId } = await replayOperation({ looksCurrent: true });
    const op = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!;
    round.harness.db.set({ ...op, status: "ACCEPTED" });
    const lost = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as unknown as DurableOutboxRecord;
    const before = snapshot(round);
    await failOutboxOperation(round.harness.db as never, "state", lost, "delivery gave up");
    expect(round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "FAILED" });
    expect(snapshot(round)).toBe(before);
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    void sourceRoundId;
  });

  it("the owner's Stop of a running replay stops the replay and nothing else, even when the workflow looks as if it were running it: the record says it was stopped, and the workflow is as it was", async () => {
    const { round, operationId, sourceRoundId } = await replayOperation({ looksCurrent: true });
    const before = snapshot(round);
    const stopped = await round.harness.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/cancel`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!.status).toBe("CANCEL_REQUESTED");
    // The cancel operation the Stop made reaches the worker, and its success is what ends the replay's operation.
    const cancels = round.operationRows((row) => row.kind === "cancel");
    expect(cancels).toHaveLength(1);
    await round.harness.finish(round.workspaceId, String(cancels[0]!.id), "SUCCEEDED");
    expect(round.harness.db.get(`WORKSPACE#${round.workspaceId}`, `OPERATION#${operationId}`)!.status).toBe("CANCELLED");
    expect(snapshot(round)).toBe(before);
    expect(round.harness.db.get(key(round, sourceRoundId).pk, key(round, sourceRoundId).sk)).toMatchObject({ state: "UNAVAILABLE", reason: "stopped" });
  });
});
