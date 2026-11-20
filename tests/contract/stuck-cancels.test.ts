// tests/contract/stuck-cancels.test.ts
// Issue 195: a task left CANCEL_REQUESTED because its cancel never reached the worker is retried
// once, or ended, so its workspace is never held for good.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FAILED_CANCEL_GRACE_MS, FAILED_CANCEL_RELEASED_MESSAGE, STUCK_CANCEL_INTERRUPTED_MESSAGE, STUCK_CANCEL_MS, STUCK_CANCEL_RETRY_MS, stuckCancelRetrier, sweepStuckCancels, type StuckCancelCandidate, type StuckCancelDependencies } from "../../packages/broker/src/aws/stuck-cancels.js";
import { agentXError } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const minutesLater = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

type Retry = NonNullable<StuckCancelDependencies["retryCancel"]>;

type PostNote = NonNullable<StuckCancelDependencies["postNote"]>;

function setup(options: { retry?: Retry | false; postNote?: PostNote; workspaces?: StuckCancelDependencies["workspaces"]; slackLegacyTeamId?: string } = {}) {
  const db = new FakeDynamoDb();
  const logs: Array<Record<string, unknown>> = [];
  const retryCancel = vi.fn<Retry>(options.retry === false || options.retry === undefined ? async () => ({ outcome: "REQUEUED", cancelOperationId: randomUUID() }) : options.retry);
  const dependencies: StuckCancelDependencies = {
    client: db,
    tableName: "state",
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.slackLegacyTeamId === undefined ? {} : { slackLegacyTeamId: options.slackLegacyTeamId }),
    ...(options.retry === false ? {} : { retryCancel }),
    ...(options.postNote === undefined ? {} : { postNote: options.postNote }),
    log: (entry) => { logs.push(entry); },
  };
  const sweep = (candidates: StuckCancelCandidate[], at: Date = NOW) => sweepStuckCancels(dependencies, candidates, at);
  return { db, logs, retryCancel, sweep };
}

/** A workspace whose active operation is a task in `status`, last changed `minutes` ago. */
function seedTask(db: FakeDynamoDb, status: string, minutes: number, fields: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "BUSY", activeOperationId: operationId, fence: 3, deploymentMode: "ec2-ebs", ...workspace });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "task", status, fence: 3, createdAt: minutesAgo(minutes + 5), updatedAt: minutesAgo(minutes), ...fields });
  const operation = () => db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
  const meta = () => db.get(`WORKSPACE#${workspaceId}`, "META")!;
  return { workspaceId, operationId, operation, meta };
}

const empty = { retried: [], ended: [], interrupted: [], unretried: [], failed: [] };

describe("the limits (issue 195)", () => {
  it("are 30 minutes each", () => {
    expect(STUCK_CANCEL_MS).toBe(30 * 60_000);
    expect(STUCK_CANCEL_RETRY_MS).toBe(30 * 60_000);
  });
});

describe("a stuck cancel whose compute is gone", () => {

  it("frees a close's workspace back to the status it had, as the lost-compute path does", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31, { kind: "close", closePreviousStatus: "STOPPED" });
    await sweep([{ workspaceId: task.workspaceId, compute: "gone" }]);
    expect(task.meta()).toMatchObject({ status: "STOPPED" });
  });

});

describe("a stuck cancel whose compute is alive", () => {

  it("ends a retried cancel still stuck after the retry limit as interrupted, and frees the workspace, when the worker answers idle", async () => {
    const { db, sweep, logs, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const, worker: "idle" as const }];
    await sweep(candidate);
    logs.length = 0;
    expect(await sweep(candidate, minutesLater(29))).toEqual(empty);
    const later = minutesLater(31);
    expect(await sweep(candidate, later)).toEqual({ ...empty, interrupted: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "INTERRUPTED", error: STUCK_CANCEL_INTERRUPTED_MESSAGE, result: null, updatedAt: later.toISOString() });
    expect(task.meta()).toMatchObject({ status: "READY" });
    expect(task.meta()).not.toHaveProperty("activeOperationId");
    expect(retryCancel).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ event: "stuck_cancel.interrupted", workspaceId: task.workspaceId, operationId: task.operationId }]);
    // Ended for good: nothing more on the next run.
    expect(await sweep(candidate, minutesLater(60))).toEqual(empty);
  });

  it("PR 255 owner decision 1: never ends a retried cancel while the worker answers busy, however old, and counts it for the alarm", async () => {
    const { db, sweep, logs } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31, { cancelRetriedAt: minutesAgo(31) });
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const, worker: "busy" as const }];
    expect(await sweep(candidate)).toEqual({ ...empty, failed: [task.operationId] });
    expect(await sweep(candidate, minutesLater(600))).toEqual({ ...empty, failed: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
    expect(logs).toEqual([
      { event: "stuck_cancel.held_busy", workspaceId: task.workspaceId, operationId: task.operationId, status: "CANCEL_REQUESTED" },
      { event: "stuck_cancel.held_busy", workspaceId: task.workspaceId, operationId: task.operationId, status: "CANCEL_REQUESTED" },
    ]);
  });

  it("PR 255 owner decision 1: a busy worker whose cancel is still progressing is neither ended nor counted", async () => {
    const { db, sweep, logs } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31, { cancelRetriedAt: minutesAgo(31) });
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${randomUUID()}`, kind: "cancel", targetOperationId: task.operationId, status: "RUNNING", fence: 3, updatedAt: minutesAgo(2) });
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive", worker: "busy" }])).toEqual(empty);
    expect(logs).toEqual([]);
  });

  it("PR 255 owner decision 1: an AI tool's developer task on a busy worker keeps today's rule: never ended nor counted while compute is alive", async () => {
    const { db, sweep, logs } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 600, { cancelRetriedAt: minutesAgo(600) });
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive", worker: "busy" }])).toEqual(empty);
    expect(logs).toEqual([]);
  });

  it("logs and counts a retry that could not be queued, and never retries it again", async () => {
    const failure = Object.assign(new Error("secret-bearing message"), { name: "StuckCancelRetryFailed" });
    const { db, sweep, logs, retryCancel } = setup({ retry: async () => { throw failure; } });
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const, worker: "idle" as const }];
    expect(await sweep(candidate)).toEqual({ ...empty, failed: [task.operationId] });
    expect(logs).toEqual([{ event: "stuck_cancel.retry_failed", workspaceId: task.workspaceId, operationId: task.operationId, errorName: "StuckCancelRetryFailed" }]);
    expect(JSON.stringify(logs)).not.toContain("secret-bearing");
    expect(await sweep(candidate, minutesLater(10))).toEqual(empty);
    expect(retryCancel).toHaveBeenCalledTimes(1);
    // The retry limit still ends it.
    expect((await sweep(candidate, minutesLater(31))).interrupted).toEqual([task.operationId]);
  });

  it("logs the error code of a retry the cancel path refused (a fixed code, never the message)", async () => {
    const { db, sweep, logs } = setup({ retry: async () => { throw agentXError("STALE_FENCE", "PLANTED-STALE-MESSAGE"); } });
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual({ ...empty, failed: [task.operationId] });
    expect(logs).toEqual([{ event: "stuck_cancel.retry_failed", workspaceId: task.workspaceId, operationId: task.operationId, errorName: "AgentXError", errorCode: "STALE_FENCE" }]);
    expect(JSON.stringify(logs)).not.toContain("PLANTED-STALE-MESSAGE");
  });

  it("counts a retry skipped for a reason that should never happen as a failure, so the alarm sees it", async () => {
    for (const reason of ["fence-changed", "not-claimed"]) {
      const { db, sweep, logs } = setup({ retry: async () => ({ outcome: "SKIPPED", reason }) });
      const task = seedTask(db, "CANCEL_REQUESTED", 31);
      expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual({ ...empty, failed: [task.operationId] });
      expect(logs).toEqual([{ event: "stuck_cancel.retry_skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason }]);
    }
  });

  it("without a way to re-queue (the legacy deployment), only logs and counts it", async () => {
    const { db, sweep, logs } = setup({ retry: false });
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual({ ...empty, unretried: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(task.operation()).not.toHaveProperty("cancelRetriedAt");
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
    expect(logs).toEqual([{ event: "stuck_cancel.retry_unavailable", workspaceId: task.workspaceId, operationId: task.operationId }]);
  });
});

describe("a retried cancel that failed", () => {
  it("frees the workspace its INTERRUPTED task still holds, only after the retry limit, when the worker answers idle", async () => {
    const { db, sweep, logs } = setup();
    const task = seedTask(db, "INTERRUPTED", 1, { cancelRetriedAt: minutesAgo(10) });
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const, worker: "idle" as const }];
    expect(await sweep(candidate)).toEqual(empty);
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
    expect(await sweep(candidate, minutesLater(31))).toEqual({ ...empty, interrupted: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "worker-idle", workspaceReleasedAt: minutesLater(31).toISOString() });
    expect(task.meta()).toMatchObject({ status: "READY" });
    expect(task.meta()).not.toHaveProperty("activeOperationId");
    expect(logs).toEqual([{ event: "stuck_cancel.released", workspaceId: task.workspaceId, operationId: task.operationId, reason: "worker-idle" }]);
  });

});

describe("a failed first cancel (issue 202)", () => {
  /** A task whose first cancel failed `minutes` ago: INTERRUPTED, but still holding its workspace. */
  const failedCancel = (db: FakeDynamoDb, minutes: number, fields: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) => seedTask(db, "INTERRUPTED", minutes, fields, workspace);

  it("waits 10 minutes for an idle worker", () => {
    expect(FAILED_CANCEL_GRACE_MS).toBe(10 * 60_000);
  });

  it("does nothing when the worker's ping failed, or its compute is starting or stopping", async () => {
    const { db, sweep, logs } = setup();
    const noAnswer = failedCancel(db, 600);
    const unknown = failedCancel(db, 600);
    expect(await sweep([{ workspaceId: noAnswer.workspaceId, compute: "alive" }, { workspaceId: unknown.workspaceId, compute: "unknown" }])).toEqual(empty);
    expect(noAnswer.meta()).toMatchObject({ status: "BUSY", activeOperationId: noAnswer.operationId });
    expect(unknown.meta()).toMatchObject({ status: "BUSY", activeOperationId: unknown.operationId });
    expect(logs).toEqual([]);
  });

  it("keeps an error the operation already carries", async () => {
    const { db, sweep } = setup();
    const task = failedCancel(db, 1, { error: "the worker said no" });
    await sweep([{ workspaceId: task.workspaceId, compute: "gone" }]);
    expect(task.operation()).toMatchObject({ error: "the worker said no", workspaceReleaseReason: "compute-gone" });
  });

  it("a release that lost a race to a result or a new operation is logged as skipped and not counted", async () => {
    for (const change of ["new-operation", "new-fence"] as const) {
      const { db, logs } = setup();
      const task = failedCancel(db, 20);
      const send = db.send;
      const racing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === "TransactWriteCommand") {
          db.set(change === "new-operation" ? { ...task.meta(), activeOperationId: randomUUID(), fence: 4 } : { ...task.meta(), fence: 4 });
        }
        return send(command);
      } } as unknown as FakeDynamoDb;
      const result = await sweepStuckCancels({ client: racing, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId: task.workspaceId, compute: "alive", worker: "idle" }], NOW);
      expect(result).toEqual(empty);
      expect(task.meta()).toMatchObject({ status: "BUSY", fence: 4 });
      expect(task.operation()).not.toHaveProperty("workspaceReleasedAt");
      expect(logs).toEqual([{ event: "stuck_cancel.skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "changed" }]);
    }
  });

  it("tells a Slack thread in plain words that its workspace is free again", async () => {
    const postNote = vi.fn<PostNote>(async () => undefined);
    const { db, sweep } = setup({ postNote });
    const task = failedCancel(db, 1, {}, { ownerKey: "owner-1" });
    db.set({ pk: "SLACK_THREAD#owner-1", sk: "META", workspaceId: task.workspaceId, thread: "T1/C1/1695500000.000001" });
    await sweep([{ workspaceId: task.workspaceId, compute: "gone" }]);
    expect(postNote).toHaveBeenCalledExactlyOnceWith({ channelId: "C1", threadTs: "1695500000.000001" }, FAILED_CANCEL_RELEASED_MESSAGE);
    expect(FAILED_CANCEL_RELEASED_MESSAGE).not.toMatch(/[\u2013\u2014]/u);
    // Once only: the next run releases nothing, so it posts nothing.
    await sweep([{ workspaceId: task.workspaceId, compute: "gone" }], minutesLater(10));
    expect(postNote).toHaveBeenCalledTimes(1);
  });

  it("posts no note for a workspace with no Slack thread, or a thread that moved to another workspace, or when nothing was freed", async () => {
    const postNote = vi.fn<PostNote>(async () => undefined);
    const { db, sweep } = setup({ postNote });
    const noThread = failedCancel(db, 1, {}, { ownerKey: "owner-none" });
    const rebound = failedCancel(db, 1, {}, { ownerKey: "owner-rebound" });
    db.set({ pk: "SLACK_THREAD#owner-rebound", sk: "META", workspaceId: randomUUID(), thread: "T1/C1/1695500000.000002" });
    const held = failedCancel(db, 600, {}, { ownerKey: "owner-held" });
    db.set({ pk: "SLACK_THREAD#owner-held", sk: "META", workspaceId: held.workspaceId, thread: "T1/C1/1695500000.000003" });
    const result = await sweep([
      { workspaceId: noThread.workspaceId, compute: "gone" },
      { workspaceId: rebound.workspaceId, compute: "gone" },
      { workspaceId: held.workspaceId, compute: "alive", worker: "busy" },
    ]);
    expect(result.interrupted).toEqual([noThread.operationId, rebound.operationId]);
    expect(postNote).not.toHaveBeenCalled();
  });

  it("leaves alone an operation with no recorded change time, which cannot be judged", async () => {
    const { db, sweep } = setup();
    const task = failedCancel(db, 1, { updatedAt: undefined });
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive", worker: "idle" }, { workspaceId: task.workspaceId, compute: "alive", worker: "busy" }])).toEqual(empty);
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
  });

});

describe("what the sweep never touches", () => {
  it("a cancel still within the limit, whatever the compute", async () => {
    const { db, sweep, retryCancel } = setup();
    const alive = seedTask(db, "CANCEL_REQUESTED", 29);
    const gone = seedTask(db, "CANCEL_REQUESTED", 29);
    expect(await sweep([{ workspaceId: alive.workspaceId, compute: "alive" }, { workspaceId: gone.workspaceId, compute: "gone" }])).toEqual(empty);
    expect(alive.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(gone.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(retryCancel).not.toHaveBeenCalled();
  });

  it("an operation whose cancel landed after it was read", async () => {
    const { db, logs } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    // The worker's cancel result lands between the sweep's reads and its write.
    const send = db.send;
    const racing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "TransactWriteCommand") {
        db.set({ ...task.operation(), status: "CANCELLED" });
        db.set({ ...task.meta(), status: "READY", activeOperationId: undefined });
      }
      return send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: racing, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId: task.workspaceId, compute: "gone" }], NOW);
    expect(result).toEqual(empty);
    expect(logs).toEqual([{ event: "stuck_cancel.skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "changed" }]);
    expect(task.operation()).toMatchObject({ status: "CANCELLED" });
    expect(task.meta()).toMatchObject({ status: "READY" });
  });
});

describe("races", () => {
  it("does not retry when the cancel was asked again between the read and the claim", async () => {
    const { db, logs, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const send = db.send;
    const racing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "UpdateCommand") db.set({ ...task.operation(), updatedAt: NOW.toISOString() });
      return send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: racing, tableName: "state", retryCancel, log: (entry) => { logs.push(entry); } }, [{ workspaceId: task.workspaceId, compute: "alive" }], NOW);
    expect(result).toEqual(empty);
    expect(retryCancel).not.toHaveBeenCalled();
    expect(task.operation()).not.toHaveProperty("cancelRetriedAt");
    expect(logs).toEqual([{ event: "stuck_cancel.skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "changed" }]);
  });
});

describe("failures", () => {
  it("are logged by name and counted per workspace, and the sweep goes on to the next", async () => {
    const { db, logs } = setup();
    const broken = seedTask(db, "CANCEL_REQUESTED", 31);
    const fine = seedTask(db, "CANCEL_REQUESTED", 31);
    const failing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand" && JSON.stringify(command.input.Key).includes(broken.workspaceId)) {
        throw Object.assign(new Error("throttled with details"), { name: "ProvisionedThroughputExceededException" });
      }
      return db.send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: failing, tableName: "state", log: (entry) => { logs.push(entry); } }, [
      { workspaceId: broken.workspaceId, compute: "gone" }, { workspaceId: fine.workspaceId, compute: "gone" },
    ], NOW);
    expect(result).toEqual({ ...empty, ended: [fine.operationId], failed: [broken.workspaceId] });
    expect(logs).toContainEqual({ event: "stuck_cancel.check_failed", workspaceId: broken.workspaceId, errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("throttled with details");
  });
});

describe("where the retry is wired", () => {
  it("only where the reconciler holds the callback signing key (named environments), as #173's backstop", () => {
    const state = { client: new FakeDynamoDb(), tableName: "state" };
    // The key is the one the reconciler read from Secrets Manager; none read (the legacy reconciler, or an unreadable secret) means no retry.
    expect(stuckCancelRetrier("k".repeat(64), state)).toBeTypeOf("function");
    expect(stuckCancelRetrier(undefined, state)).toBeUndefined();
    expect(stuckCancelRetrier("", state)).toBeUndefined();
  });
});

it("L2-2 18d: in company mode the install's own thread keeps today's unscoped note, another team's (or a company record's) is scoped", async () => {
  const IMPLICIT = "org_00000000000000000000", B = "org_bbbbbbbbbbbbbbbbbbbb";
  for (const [teamId, orgId, scoped] of [["T0INSTALL0", undefined, false], ["T0BBBBBBB", B, true], ["T0INSTALL0", B, true], ["T0BBBBBBB", undefined, true]] as const) {
    const postNote = vi.fn<PostNote>(async () => undefined);
    const lookup = vi.fn(async (team: string) => (team === "T0INSTALL0" ? IMPLICIT : B));
    const { db, sweep } = setup({ postNote, workspaces: { requireCompany: lookup }, slackLegacyTeamId: "T0INSTALL0" });
    const task = seedTask(db, "INTERRUPTED", 1, {}, { ownerKey: "owner-1" });
    if (orgId !== undefined) db.get(`WORKSPACE#${task.workspaceId}`, "META")!.orgId = orgId;
    db.set({ pk: "SLACK_THREAD#owner-1", sk: "META", workspaceId: task.workspaceId, thread: `${teamId}/C0SHARED/1695500000.000001` });
    await sweep([{ workspaceId: task.workspaceId, compute: "gone" }]);
    const place = postNote.mock.calls[0]?.[0];
    if (scoped && (teamId === "T0INSTALL0" || orgId === undefined)) {
      // A record whose company disagrees with the team's binding (another company on the install's team, the implicit company on B's): nothing is posted (fail closed).
      expect(postNote, `${teamId} ${orgId}`).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalled();
    } else if (scoped) {
      expect(place, `${teamId} ${orgId}`).toMatchObject({ workspace: { teamId } });
      expect(lookup).toHaveBeenCalled();
    } else {
      // The install's own thread: scoped to the implicit company and its team (the poster posts it as today), with no binding read.
      expect(postNote).toHaveBeenCalledExactlyOnceWith({ channelId: "C0SHARED", threadTs: "1695500000.000001", workspace: { companyId: IMPLICIT, teamId } }, FAILED_CANCEL_RELEASED_MESSAGE);
      expect(lookup).not.toHaveBeenCalled();
    }
  }
});
