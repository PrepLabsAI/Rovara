import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/session.js";
import { failActiveOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import {
  createReconcilerHandler,
  type ExecutionStatus,
  type InstanceView,
  type ReconcilerDependencies,
  type VolumeView,
} from "../../packages/broker/src/aws/session-reconciler.js";
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
const hex = () => randomUUID().replaceAll("-", "").slice(0, 17);

type Start = (input: { stateMachineArn: string; name: string; input: string }) => Promise<string>;

function setup(options: { instances?: InstanceView[]; volumes?: VolumeView[]; executions?: Record<string, ExecutionStatus>; ping?: ReconcilerDependencies["ping"]; sweepStuckSetups?: ReconcilerDependencies["sweepStuckSetups"]; expireIndexDays?: ReconcilerDependencies["expireIndexDays"]; sweepUnwaitedTasks?: ReconcilerDependencies["sweepUnwaitedTasks"]; log?: ReconcilerDependencies["log"] } = {}) {
  const db = new FakeDynamoDb();
  const start = vi.fn<Start>(async ({ name }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
  const sessions = new SessionManager({
    documentClient: db, tableName: "state",
    executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start },
    now: () => NOW,
  });
  const state = { instances: options.instances ?? [], volumes: options.volumes ?? [], executions: options.executions ?? {} };
  const terminate = vi.fn<(instanceId: string) => Promise<void>>(async () => undefined);
  const deleteVolume = vi.fn<(volumeId: string) => Promise<void>>(async () => undefined);
  const quarantine = vi.fn<(volumeId: string) => Promise<void>>(async () => undefined);
  const emit = vi.fn<(metrics: Record<string, number>) => void>();
  const reconcile = createReconcilerHandler({
    sessions,
    instances: async () => state.instances,
    volumes: async () => state.volumes,
    executionStatus: async (arn) => state.executions[arn],
    ping: options.ping ?? (async () => "Healthy"),
    terminate, deleteVolume, quarantine,
    failActiveOperation: (workspaceId, error) => failActiveOperation(db, "state", workspaceId, error),
    closedAt: async (workspaceId) => {
      const item = db.get(`WORKSPACE#${workspaceId}`, "META");
      return item?.status === "CLOSED" ? item.closedAt as string : undefined;
    },
    binding: async () => binding,
    emit,
    now: () => NOW,
    log: options.log ?? (() => undefined),
    ...(options.sweepStuckSetups === undefined ? {} : { sweepStuckSetups: options.sweepStuckSetups }),
    ...(options.expireIndexDays === undefined ? {} : { expireIndexDays: options.expireIndexDays }),
    ...(options.sweepUnwaitedTasks === undefined ? {} : { sweepUnwaitedTasks: options.sweepUnwaitedTasks }),
  });
  return { db, sessions, state, start, terminate, deleteVolume, quarantine, emit, reconcile };
}

/** A SESSION item with the given state and fields, and its workspace. */
function seedSession(db: FakeDynamoDb, state: string, fields: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  const workspaceId = randomUUID();
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "READY", deploymentMode: "ec2-ebs", fence: 1, ...workspace });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state, sessionState: state, generation: 1, availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa", ...fields });
  return workspaceId;
}

const ready = () => ({
  volumeId: `vol-${hex()}`, instanceId: `i-${hex()}`, privateIp: "10.42.128.10",
  launchedAt: minutesAgo(60), readyAt: minutesAgo(58), lastActivityAt: minutesAgo(1),
});
const sessionOf = (db: FakeDynamoDb, workspaceId: string) => db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;

describe("reconciler: instances", () => {
  it("terminates instances no session owns, after a grace period, and leaves owned ones alone", async () => {
    const owned = ready();
    const { db, state, reconcile, terminate } = setup();
    const readyWorkspace = seedSession(db, "READY", owned);
    const stoppedWorkspace = seedSession(db, "STOPPED", { volumeId: `vol-${hex()}` });
    state.instances = [
      { instanceId: owned.instanceId, state: "running", workspaceId: readyWorkspace, launchedAt: minutesAgo(60) },
      { instanceId: "i-0000000000000000a", state: "running", workspaceId: stoppedWorkspace, launchedAt: minutesAgo(30) },
      { instanceId: "i-0000000000000000b", state: "running", workspaceId: randomUUID(), launchedAt: minutesAgo(20) },
      { instanceId: "i-0000000000000000c", state: "running", launchedAt: minutesAgo(20) },
      { instanceId: "i-0000000000000000d", state: "pending", workspaceId: randomUUID(), launchedAt: minutesAgo(5) },
    ];
    const report = await reconcile();
    expect(report.orphanInstances.sort()).toEqual(["i-0000000000000000a", "i-0000000000000000b", "i-0000000000000000c"]);
    expect(terminate).not.toHaveBeenCalledWith(owned.instanceId);
    expect(terminate).not.toHaveBeenCalledWith("i-0000000000000000d");
  });

  it("marks a READY session whose instance is gone STOPPED and fails the operation it was running", async () => {
    const lost = ready();
    const operationId = randomUUID();
    const { db, state, reconcile } = setup();
    const workspaceId = seedSession(db, "READY", lost, { status: "BUSY", activeOperationId: operationId });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "RUNNING", fence: 1 });
    state.instances = [];

    const report = await reconcile();
    expect(report.lostInstances).toEqual([lost.instanceId]);
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "STOPPED", sessionState: "STOPPED", volumeId: lost.volumeId });
    expect(sessionOf(db, workspaceId)).not.toHaveProperty("instanceId");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "FAILED", error: "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
  });

  it("terminates a READY session's stopped instance and treats it as lost", async () => {
    const lost = ready();
    const { db, state, reconcile, terminate } = setup();
    const workspaceId = seedSession(db, "READY", lost);
    state.instances = [{ instanceId: lost.instanceId, state: "stopped", workspaceId, launchedAt: minutesAgo(60) }];
    expect((await reconcile()).lostInstances).toEqual([lost.instanceId]);
    expect(terminate).toHaveBeenCalledWith(lost.instanceId);
  });

  it("replaces a worker after three consecutive failed probes, and forgets failures after a good one", async () => {
    const worker = ready();
    let healthy = false;
    const { db, state, reconcile, terminate } = setup({ ping: async () => { if (!healthy) throw new Error("timeout"); return "Healthy"; } });
    const workspaceId = seedSession(db, "READY", worker);
    state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) }];

    await reconcile();
    await reconcile();
    expect(sessionOf(db, workspaceId)).toMatchObject({ pingFailures: 2 });
    healthy = true;
    await reconcile();
    expect(sessionOf(db, workspaceId)).not.toHaveProperty("pingFailures");

    healthy = false;
    await reconcile();
    await reconcile();
    const third = await reconcile();
    expect(third.unresponsiveInstances).toEqual([worker.instanceId]);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(worker.instanceId);
  });
});

describe("reconciler: stuck transitions", () => {
  it("fails a provisioning whose execution ended, terminating its instance and failing parked work", async () => {
    const executionArn = "arn:aws:states:us-east-1:111122223333:execution:provisioner:ws-x-gen-1";
    const { db, state, reconcile, terminate } = setup({ executions: { [executionArn]: "FAILED" } });
    const operationId = randomUUID();
    const outboxId = randomUUID();
    const workspaceId = seedSession(db, "PROVISIONING", { executionArn, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", waitingOutboxIds: new Set([outboxId]) }, { status: "PREPARING", activeOperationId: operationId });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "prepare", status: "DISPATCHING", fence: 1 });
    db.set({
      pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "WAITING_FOR_SESSION", operationId, workspaceId, deploymentMode: "ec2-ebs",
      invocation: { protocolVersion: 1, kind: "prepare", operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {} },
    });
    state.instances = [];

    expect((await reconcile()).stuckProvisioning).toEqual([workspaceId]);
    expect(terminate).toHaveBeenCalledWith("i-0123456789abcdef0");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "FAILED", volumeId: "vol-0123456789abcdef0" });
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
  });

  it("trusts a running provisioner, and restarts one whose start was never recorded", async () => {
    const executionArn = "arn:aws:states:us-east-1:111122223333:execution:provisioner:ws-y-gen-1";
    const { db, reconcile, start } = setup({ executions: { [executionArn]: "RUNNING" } });
    const running = seedSession(db, "PROVISIONING", { executionArn });
    const unstarted = seedSession(db, "PROVISIONING");
    const report = await reconcile();
    expect(report.stuckProvisioning).toEqual([]);
    expect(sessionOf(db, running)).toMatchObject({ state: "PROVISIONING" });
    expect(report.restartedProvisioning).toEqual([unstarted]);
    expect(start.mock.calls[0]![0].name).toBe(`ws-${unstarted}-gen-1`);
  });

  it("finishes a deletion whose deleter stopped: terminate, then delete the volume and mark DELETED", async () => {
    const executionArn = "arn:aws:states:us-east-1:111122223333:execution:deleter:ws-z-delete";
    const { db, state, reconcile, terminate, deleteVolume } = setup({ executions: { [executionArn]: "FAILED" } });
    const workspaceId = seedSession(db, "DELETING", { executionArn, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0" });
    state.instances = [{ instanceId: "i-0123456789abcdef0", state: "running", workspaceId, launchedAt: minutesAgo(90) }];
    state.volumes = [{ volumeId: "vol-0123456789abcdef0", state: "in-use", workspaceId, createdAt: minutesAgo(120), quarantined: false }];

    expect((await reconcile()).stuckDeleting).toEqual([workspaceId]);
    expect(terminate).toHaveBeenCalledWith("i-0123456789abcdef0");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "DELETING" });

    state.instances = [];
    state.volumes = [{ volumeId: "vol-0123456789abcdef0", state: "available", workspaceId, createdAt: minutesAgo(120), quarantined: false }];
    await reconcile();
    expect(deleteVolume).toHaveBeenCalledWith("vol-0123456789abcdef0");
    expect(sessionOf(db, workspaceId)).toMatchObject({ state: "DELETED" });
  });

  it("re-sends work still parked on a READY session", async () => {
    const worker = ready();
    const outboxId = randomUUID();
    const { db, state, reconcile } = setup();
    const workspaceId = seedSession(db, "READY", { ...worker, waitingOutboxIds: new Set([outboxId]) });
    db.set({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "WAITING_FOR_SESSION", workspaceId });
    state.instances = [{ instanceId: worker.instanceId, state: "running", workspaceId, launchedAt: minutesAgo(60) }];
    expect((await reconcile()).requeued).toEqual([outboxId]);
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
  });
});

describe("reconciler: volumes", () => {
  it("deletes a closed workspace's volume after an hour, quarantines unclaimed ones, and never touches claimed or new ones", async () => {
    const { db, state, reconcile, deleteVolume, quarantine, emit } = setup();
    const stopped = seedSession(db, "STOPPED", { volumeId: "vol-000000000000000a1" });
    const closedLongAgo = seedSession(db, "DELETED", {}, { status: "CLOSED", closedAt: minutesAgo(120) });
    const closedRecently = seedSession(db, "DELETED", {}, { status: "CLOSED", closedAt: minutesAgo(30) });
    state.volumes = [
      { volumeId: "vol-000000000000000a1", state: "available", workspaceId: stopped, createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a2", state: "available", workspaceId: closedLongAgo, createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a3", state: "available", workspaceId: closedRecently, createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a4", state: "available", workspaceId: randomUUID(), createdAt: minutesAgo(600), quarantined: false },
      { volumeId: "vol-000000000000000a5", state: "available", workspaceId: randomUUID(), createdAt: minutesAgo(5), quarantined: false },
      { volumeId: "vol-000000000000000a6", state: "available", workspaceId: randomUUID(), createdAt: minutesAgo(600), quarantined: true },
    ];
    const report = await reconcile();
    expect(report.closedVolumesDeleted).toEqual(["vol-000000000000000a2"]);
    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith("vol-000000000000000a2");
    expect(quarantine).toHaveBeenCalledExactlyOnceWith("vol-000000000000000a4");
    expect(report.quarantinedVolumes.sort()).toEqual(["vol-000000000000000a4", "vol-000000000000000a6"]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerClosedVolumesDeleted: 1, ReconcilerQuarantinedVolumes: 2, ReconcilerOrphanInstances: 0 }));
  });
});

describe("failing an active operation", () => {
  it("restores a close preflight's previous status, and leaves a finished operation alone", async () => {
    const db = new FakeDynamoDb();
    const workspaceId = randomUUID();
    const closeId = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: "CLOSING", activeOperationId: closeId, fence: 3 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${closeId}`, kind: "close", status: "RUNNING", fence: 3, closePreviousStatus: "STOPPED" });
    expect(await failActiveOperation(db, "state", workspaceId, "lost")).toBe(closeId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "STOPPED" });

    const taskId = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: "BUSY", activeOperationId: taskId, fence: 4 });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${taskId}`, kind: "task", status: "SUCCEEDED", fence: 4 });
    expect(await failActiveOperation(db, "state", workspaceId, "lost")).toBeUndefined();
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskId}`)).toMatchObject({ status: "SUCCEEDED" });
  });
});

describe("reconciler: stuck setups (spec 025 FR-055)", () => {
  it("runs the sweep last, reports what it failed and counts it", async () => {
    const failedWorkspace = randomUUID();
    const sweep = vi.fn(async () => ({ failed: [failedWorkspace], dropped: 0, kept: 0 }));
    const logs: Array<Record<string, unknown>> = [];
    const { reconcile, emit } = setup({ sweepStuckSetups: sweep, log: (entry) => { logs.push(entry); } });
    const report = await reconcile();
    expect(sweep).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(report.stuckSetups).toEqual([failedWorkspace]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetups: 1 }));
    // The sweep logs each failed setup itself (stuck_setup.failed); the reconciler does not repeat it.
    expect(logs.filter((entry) => JSON.stringify(entry).includes(failedWorkspace))).toEqual([]);
  });

  it("still emits the EC2 repair metrics when the sweep throws, counts the error, and fails the run (F17)", async () => {
    const orphan: InstanceView = { instanceId: `i-${hex()}`, state: "running", launchedAt: minutesAgo(30) };
    const logs: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("PLANTED-SWEEP-MESSAGE"), { name: "ProvisionedThroughputExceededException" });
    const { reconcile, emit, terminate } = setup({ instances: [orphan], sweepStuckSetups: async () => { throw failure; }, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).rejects.toBe(failure);
    expect(terminate).toHaveBeenCalledWith(orphan.instanceId);
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerOrphanInstances: 1, ReconcilerStuckSetups: 0, ReconcilerStuckSetupErrors: 1 }));
    expect(logs).toContainEqual({ event: "reconciler.stuck_setup_sweep_failed", errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-SWEEP-MESSAGE");
  });

  it("reports no stuck setups and no sweep errors when no sweep is wired", async () => {
    const { reconcile, emit } = setup();
    expect((await reconcile()).stuckSetups).toEqual([]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerStuckSetups: 0, ReconcilerStuckSetupErrors: 0 }));
  });

  it("still runs the index expiry when the sweep throws, and still rethrows the sweep's error (A6, F17)", async () => {
    const failure = Object.assign(new Error("PLANTED-SWEEP-MESSAGE"), { name: "ProvisionedThroughputExceededException" });
    const expireIndexDays = vi.fn(async () => ({ deleted: 0 }));
    const { reconcile, emit } = setup({ sweepStuckSetups: async () => { throw failure; }, expireIndexDays });
    await expect(reconcile()).rejects.toBe(failure);
    expect(expireIndexDays).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerStuckSetupErrors: 1 }));
  });

  it("runs the index expiry, and a failed expiry is logged and does not fail the run (A6)", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const expireIndexDays = vi.fn(async () => { throw Object.assign(new Error("PLANTED-EXPIRY-MESSAGE"), { name: "ThrottlingException" }); });
    const { reconcile, emit } = setup({ expireIndexDays, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(expireIndexDays).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(logs).toContainEqual({ event: "reconciler.index_expiry_failed", errorName: "ThrottlingException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-EXPIRY-MESSAGE");
    // A6: the metrics are the same set as before; the expiry adds none.
    expect(Object.keys(emit.mock.calls[0]![0])).not.toContain("ReconcilerIndexExpiry");
    const baseline = setup();
    await baseline.reconcile();
    expect(Object.keys(emit.mock.calls[0]![0])).toEqual(Object.keys(baseline.emit.mock.calls[0]![0]));
  });
});

describe("reconciler: unwaited Slack tasks (#173)", () => {
  it("hands the sweep every live session's workspace, reports what it cancelled and counts it", async () => {
    const readyWorkspace = seedSession(new FakeDynamoDb(), "READY");
    const sweep = vi.fn(async () => ({ cancelled: ["op-1"], failed: ["op-2"], noteFailures: 0 }));
    const { db, reconcile, emit } = setup({ sweepUnwaitedTasks: sweep });
    const live = seedSession(db, "STOPPED", { volumeId: `vol-${hex()}` });
    const provisioning = seedSession(db, "PROVISIONING", { executionArn: "arn:aws:states:us-east-1:111122223333:execution:provisioner:x" });
    const report = await reconcile();
    expect(sweep).toHaveBeenCalledOnce();
    const [workspaceIds, at] = sweep.mock.calls[0]! as unknown as [Iterable<string>, Date];
    expect([...workspaceIds].sort()).toEqual([live, provisioning].sort());
    expect([...workspaceIds]).not.toContain(readyWorkspace);
    expect(at).toEqual(NOW);
    expect(report.unwaitedTasks).toEqual({ cancelled: ["op-1"], failed: ["op-2"], noteFailures: 0 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ReconcilerUnwaitedTasksCancelled: 1, ReconcilerUnwaitedTaskFailures: 1 }));
  });

  it("logs a sweep that throws by its error name, counts it, and still finishes the run", async () => {
    const orphan: InstanceView = { instanceId: `i-${hex()}`, state: "running", launchedAt: minutesAgo(30) };
    const logs: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("PLANTED-UNWAITED-MESSAGE"), { name: "ProvisionedThroughputExceededException" });
    const expireIndexDays = vi.fn(async () => ({ deleted: 0 }));
    const { reconcile, emit, terminate } = setup({ instances: [orphan], sweepUnwaitedTasks: async () => { throw failure; }, expireIndexDays, log: (entry) => { logs.push(entry); } });
    await expect(reconcile()).resolves.toBeDefined();
    expect(terminate).toHaveBeenCalledWith(orphan.instanceId);
    expect(expireIndexDays).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ReconcilerOrphanInstances: 1, ReconcilerUnwaitedTasksCancelled: 0, ReconcilerUnwaitedTaskFailures: 1 }));
    expect(logs).toContainEqual({ event: "reconciler.unwaited_task_sweep_failed", errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED-UNWAITED-MESSAGE");
  });

  it("adds no metric and no report field where the backstop is not wired (the legacy deployment)", async () => {
    const { reconcile, emit } = setup();
    const report = await reconcile();
    expect(report).not.toHaveProperty("unwaitedTasks");
    expect(Object.keys(emit.mock.calls[0]![0]).filter((name) => name.includes("Unwaited"))).toEqual([]);
  });
});
