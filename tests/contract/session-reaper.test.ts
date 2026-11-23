import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/session.js";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import { createReaperHandler, holdsActiveOperation, type ReaperDependencies, type StopProgress } from "../../packages/broker/src/aws/session-reaper.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

type Start = (input: { stateMachineArn: string; name: string; input: string }) => Promise<string>;

function setup(overrides: Partial<ReaperDependencies> = {}) {
  const db = new FakeDynamoDb();
  const start = vi.fn<Start>(async ({ name }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
  const sessions = new SessionManager({
    documentClient: db,
    tableName: "state",
    executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start },
    now: () => NOW,
  });
  let progress: StopProgress = { instanceGone: false, instanceLive: false, volumeAvailable: false };
  const terminate = vi.fn<(instanceId: string) => Promise<void>>(async () => undefined);
  const emit = vi.fn<(metrics: Record<string, number>) => void>();
  const reap = createReaperHandler({
    sessions,
    activeOperation: async (workspaceId) => typeof db.get(`WORKSPACE#${workspaceId}`, "META")?.activeOperationId === "string",
    ping: async () => "Healthy",
    terminate,
    progress: async () => progress,
    binding: async () => binding,
    emit,
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  });
  return { db, sessions, start, terminate, emit, reap, setProgress: (next: StopProgress) => { progress = next; } };
}

/** A READY session and its workspace, last active `idleMinutes` ago. */
function seedReady(db: FakeDynamoDb, options: { idleMinutes: number; launchedMinutesAgo?: number; activeOperationId?: string | null }) {
  const workspaceId = randomUUID();
  db.set({
    pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 1, status: "READY",
    ...(options.activeOperationId === undefined ? {} : { activeOperationId: options.activeOperationId }),
  });
  db.set({
    pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 1,
    volumeId: "vol-0123456789abcdef0", availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa",
    instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10",
    launchedAt: minutesAgo(options.launchedMinutesAgo ?? 30), readyAt: minutesAgo(options.launchedMinutesAgo ?? 30), lastActivityAt: minutesAgo(options.idleMinutes),
  });
  return workspaceId;
}

const sessionOf = (db: FakeDynamoDb, workspaceId: string) => db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;

describe("idle reaper", () => {
  it("stops a session idle over five minutes, then marks it STOPPED once the instance is gone and the volume free", async () => {
    const { db, reap, terminate, emit, setProgress } = setup();
    const idle = seedReady(db, { idleMinutes: 6 });
    const active = seedReady(db, { idleMinutes: 1 });

    const first = await reap();
    expect(first.claimed).toEqual([idle]);
    expect(terminate).toHaveBeenCalledExactlyOnceWith("i-0123456789abcdef0");
    expect(sessionOf(db, idle)).toMatchObject({ state: "STOPPING", sessionState: "STOPPING" });
    expect(sessionOf(db, active)).toMatchObject({ state: "READY" });
    expect(first.stillStopping).toEqual([idle]);
    expect(emit).toHaveBeenLastCalledWith({ SessionsStopped: 0, SessionsStopping: 1 });

    setProgress({ instanceGone: true, instanceLive: false, volumeAvailable: true });
    const second = await reap();
    expect(second.stopped).toEqual([idle]);
    expect(sessionOf(db, idle)).toMatchObject({ state: "STOPPED", sessionState: "STOPPED", volumeId: "vol-0123456789abcdef0" });
    expect(sessionOf(db, idle)).not.toHaveProperty("instanceId");
    expect(sessionOf(db, idle)).not.toHaveProperty("privateIp");
    expect(emit).toHaveBeenLastCalledWith({ SessionsStopped: 1, SessionsStopping: 0 });
    // The workspace's own status is never changed.
    expect(db.get(`WORKSPACE#${idle}`, "META")).toMatchObject({ status: "READY" });
  });

  it("stops a session launched over 14 days ago even when recently active", async () => {
    const { db, reap } = setup();
    const old = seedReady(db, { idleMinutes: 1, launchedMinutesAgo: 14 * 24 * 60 + 1 });
    expect((await reap()).claimed).toEqual([old]);
  });

  it("never reaps a workspace with an active operation or a worker reporting HealthyBusy", async () => {
    const busyWorkspace = setup();
    const withOperation = seedReady(busyWorkspace.db, { idleMinutes: 30, activeOperationId: randomUUID() });
    expect((await busyWorkspace.reap()).skippedBusy).toEqual([withOperation]);
    expect(sessionOf(busyWorkspace.db, withOperation)).toMatchObject({ state: "READY" });

    const busyWorker = setup({ ping: async () => "HealthyBusy" });
    const working = seedReady(busyWorker.db, { idleMinutes: 30 });
    expect((await busyWorker.reap()).skippedBusy).toEqual([working]);
    expect(busyWorker.terminate).not.toHaveBeenCalled();
  });

  it("loses to a dispatch that touches the session between its read and its claim", async () => {
    const race = { workspaceId: "" };
    const { db, sessions, reap, terminate } = setup({
      // The dispatcher's ensureSession lands while the reaper probes the worker.
      ping: async () => {
        await sessions.ensureSession({ workspaceId: race.workspaceId, binding });
        return "Healthy";
      },
    });
    const raced = race.workspaceId = seedReady(db, { idleMinutes: 10 });
    const report = await reap();
    expect(report.lostRace).toEqual([raced]);
    expect(sessionOf(db, raced)).toMatchObject({ state: "READY", lastActivityAt: NOW.toISOString() });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("starts the next generation at once when work was parked while stopping", async () => {
    const { db, sessions, reap, start, setProgress } = setup();
    const workspaceId = seedReady(db, { idleMinutes: 10 });
    await reap();
    const outboxId = randomUUID();
    db.set({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "QUEUED", workspaceId, deploymentMode: "ec2-ebs" });
    expect(await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId })).toMatchObject({ ready: false, state: "STOPPING" });

    setProgress({ instanceGone: true, instanceLive: false, volumeAvailable: true });
    const report = await reap();
    expect(report.stopped).toEqual([workspaceId]);
    expect(report.restarted).toEqual([workspaceId]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "PROVISIONING", generation: 2, volumeId: "vol-0123456789abcdef0" });
    expect([...(sessionOf(db, workspaceId).waitingOutboxIds as Set<string>)]).toEqual([outboxId]);
    expect(start.mock.calls[0]![0].name).toBe(`ws-${workspaceId}-gen-2`);
  });

  it("keeps a session STOPPING and sends the terminate again while its instance is still live", async () => {
    const { db, reap, terminate, setProgress } = setup();
    terminate.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "RequestLimitExceeded" }));
    const workspaceId = seedReady(db, { idleMinutes: 10 });
    await reap();
    setProgress({ instanceGone: false, instanceLive: true, volumeAvailable: false });
    const report = await reap();
    expect(report.stillStopping).toEqual([workspaceId]);
    // The claim's terminate failed; the next tick saw the instance live and sent it again.
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPING" });
  });
});

// CLOSE-RETENTION: a RETAINED session is idle-stopped after the normal idle window like any other: the instance ends, the VOLUME and the RETENTION record are kept, so a Close stays refused (the retained
// sentence) until it is previewed and bound. Work resumes by a Continue or a new step, which wakes it on the same volume. The deployed reaper's busy rule is `holdsActiveOperation`.
describe("idle reaper and a retained session", () => {
  const OLD_INSTANCE = "i-0aaaaaaaaaaaaaaaa";
  /** A READY session idle 6 minutes with a retention record; `woken` = a new instance since the retention (the record is stale), else the retention's own instance and its completed preflight as the workspace's holder. */
  function retainedIdle(woken: boolean, extra: { activeOperationId?: string | null; accepted?: boolean } = {}) {
    const w = setup();
    const workspaceId = seedReady(w.db, { idleMinutes: 6 });
    const preflight = randomUUID();
    const generation = { sessionGeneration: 1, instanceId: woken ? OLD_INSTANCE : "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
    const retained = { inspectionOperationId: preflight, inspectionFence: 2, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
    const closeRetention = { schemaVersion: 1, operationId: preflight, fence: 2, generation, retained, ...(extra.accepted === true ? { acceptedOperationId: randomUUID() } : {}) };
    w.db.set({ ...sessionOf(w.db, workspaceId), ...(woken ? { generation: 2 } : {}), closeRetention, workspaceDataIdentity: generation });
    const holder = extra.activeOperationId !== undefined ? extra.activeOperationId : woken ? null : preflight;
    w.db.set({ ...w.db.get(`WORKSPACE#${workspaceId}`, "META")!, fence: 2, ...(holder === null ? { activeOperationId: null } : { activeOperationId: holder }) });
    w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${preflight}`, status: "SUCCEEDED", kind: "close", fence: 2, workspaceId, closePreflight: { schemaVersion: 1 } });
    const real = createReaperHandler({
      sessions: w.sessions, ping: async () => "Healthy", terminate: w.terminate, progress: async () => ({ instanceGone: true, instanceLive: false, volumeAvailable: true }), binding: async () => binding, emit: w.emit, now: () => NOW, log: () => undefined,
      activeOperation: async (id, retainedOperationId) => holdsActiveOperation(w.db.get(`WORKSPACE#${id}`, "META"), retainedOperationId),
    });
    return { ...w, workspaceId, closeRetention, real };
  }

  it("a woken-but-idle retained session (a new instance, the old retention record, no step): after the idle window it is STOPPED, the volume and the retention are kept", async () => {
    const w = retainedIdle(true);
    const tick = await w.real();
    expect(tick.claimed).toEqual([w.workspaceId]);
    expect(w.terminate).toHaveBeenCalledExactlyOnceWith("i-0123456789abcdef0");
    expect(tick.stopped).toEqual([w.workspaceId]);
    expect(sessionOf(w.db, w.workspaceId)).toMatchObject({ state: "STOPPED", volumeId: "vol-0123456789abcdef0", closeRetention: w.closeRetention });
    expect(sessionOf(w.db, w.workspaceId)).not.toHaveProperty("instanceId");
  });

  it("a retained session whose completed preflight still holds the workspace is idle-stopped too (the preflight is not 'work')", async () => {
    const w = retainedIdle(false);
    const tick = await w.real();
    expect(tick.claimed).toEqual([w.workspaceId]);
    expect(tick.stopped).toEqual([w.workspaceId]);
    expect(sessionOf(w.db, w.workspaceId)).toMatchObject({ state: "STOPPED", volumeId: "vol-0123456789abcdef0", closeRetention: w.closeRetention });
  });

  it("a retention is stale when EITHER the instance or the generation moved on (a new generation with the same instance id, a new instance in the same generation): both are woken sessions, both are idle-stopped", async () => {
    for (const [sessionGeneration, instanceId] of [[2, "i-0123456789abcdef0"], [1, OLD_INSTANCE]] as const) {
      const w = retainedIdle(false);
      const row = sessionOf(w.db, w.workspaceId), retention = row["closeRetention"] as { generation: Record<string, unknown> };
      // The session is on generation 2 (or on its own instance); the record names generation 1 and the instance it names here.
      w.db.set({ ...row, generation: sessionGeneration === 2 ? 2 : 1, closeRetention: { ...retention, generation: { ...retention.generation, sessionGeneration: 1, instanceId } } });
      w.db.set({ ...w.db.get(`WORKSPACE#${w.workspaceId}`, "META")!, activeOperationId: null });
      expect((await w.real()).claimed).toEqual([w.workspaceId]);
    }
  });

  it("a woken session is stopped whether or not its old preflight is still on record (the record of a dead instance guards nothing)", async () => {
    const w = retainedIdle(true);
    w.db.delete(`WORKSPACE#${w.workspaceId}`, `OPERATION#${(w.closeRetention as { operationId: string }).operationId}`);
    expect((await w.real()).claimed).toEqual([w.workspaceId]);
  });

  it("a step that holds the workspace is work: a retained session is never stopped under it", async () => {
    for (const woken of [true, false]) {
      const w = retainedIdle(woken, { activeOperationId: randomUUID() });
      expect((await w.real()).skippedBusy).toEqual([w.workspaceId]);
      expect(w.terminate).not.toHaveBeenCalled();
      expect(sessionOf(w.db, w.workspaceId)).toMatchObject({ state: "READY" });
    }
  });

  it("an ACCEPTED close owns the session: it is never stopped by the idle rule", async () => {
    for (const woken of [true, false]) {
      const w = retainedIdle(woken, { accepted: true });
      expect((await w.real()).claimed).toEqual([]);
      expect(w.terminate).not.toHaveBeenCalled();
      expect(sessionOf(w.db, w.workspaceId)).toMatchObject({ state: "READY" });
    }
  });

  it("the busy rule: an operation that is not the retained preflight is work; the retained preflight itself is not", () => {
    expect(holdsActiveOperation(undefined)).toBe(false);
    expect(holdsActiveOperation({ activeOperationId: null })).toBe(false);
    expect(holdsActiveOperation({ activeOperationId: "op-1" })).toBe(true);
    expect(holdsActiveOperation({ activeOperationId: "op-1" }, "op-1")).toBe(false);
    expect(holdsActiveOperation({ activeOperationId: "op-2" }, "op-1")).toBe(true);
  });
});
