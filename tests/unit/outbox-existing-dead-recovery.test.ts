import { expect, it } from "vitest";
import { canonicalJson, change, companyScoped, orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { recoverDeadPreparation, prepareWatchKey } from "../../packages/broker/src/core/task-flow/prepare-watch.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";

it.each(["DEAD", "PENDING", "QUEUED"])("bounded targeted recovery handles an old %s row without a SETUP_WATCH marker", async (status) => {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "An old orphan" });
  const workspace = (await h.store.get(workspaceKey(COMPANY, task.workspaceId)))!;
  const id = workspace.activeOperationId as string;
  await h.store.delete({ key: prepareWatchKey(COMPANY, task.createdAt, task.workspaceId) });
  await h.store.update({ key: { pk: companyScoped(COMPANY, `OUTBOX#${id}`), sk: "OUTBOX" }, ops: [change.set("status", status)] });
  expect(await recoverDeadPreparation(h.deps, task.workspaceId, id)).toBe(status === "DEAD");
  expect((await h.flow.get(h.owner, task.taskId)).status).toBe(status === "DEAD" ? "FAILED" : "STARTING");
  if (status === "DEAD") {
    expect(await h.store.get(operationKey(COMPANY, task.workspaceId, id))).toMatchObject({ status: "FAILED", error: "Rovara couldn't start this task: the start request couldn't be queued. Try again." });
    expect(await recoverDeadPreparation(h.deps, task.workspaceId, id)).toBe(false);
  }
});

// The installed schedule, including a cold flow each pass: recovery cannot rely on process cursors.
import { CORE_JOBS } from "../../packages/broker/src/core-host/jobs.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createTaskFlow, TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { definition } from "../support/task-flow-harness.js";
import { createHash } from "node:crypto";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { backfillCorePage } from "../../packages/broker/src/aws/core-project-backfill.js";
import { retireProjectIncarnation } from "../../packages/broker/src/core/project-incarnation.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { runWatchKey } from "../../packages/broker/src/core/task-flow/run-watch-rows.js";

const checkpointKey = (companyId = COMPANY) => ({ pk: companyScoped(companyId, "SETUP_WATCH"), sk: "~RECOVERY" });

const REASON = "Rovara couldn't start this task: the start request couldn't be queued. Try again.";
async function scheduled(h: ReturnType<typeof createHarness>) {
  const job = CORE_JOBS.find((row) => row.name === "run-watch")!;
  expect(job.trigger).toEqual({ kind: "schedule", rate: "rate(1 minute)" });
  await job.run({ flow: createTaskFlow(h.deps) } as Parameters<typeof job.run>[0], 30_000);
}
async function orphan(h: ReturnType<typeof createHarness>, status: string | undefined, project = "payments") {
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project, instructions: "Historical orphan" });
  const ws = (await h.store.get(workspaceKey(COMPANY, task.workspaceId)))!;
  const id = ws.activeOperationId as string;
  await h.store.delete({ key: prepareWatchKey(COMPANY, task.createdAt, task.workspaceId) });
  const key = { pk: companyScoped(COMPANY, `OUTBOX#${id}`), sk: "OUTBOX" };
  if (status === undefined) await h.store.delete({ key });
  else await h.store.update({ key, ops: [change.set("status", status)] });
  return { task, id, key, op: operationKey(COMPANY, task.workspaceId, id) };
}
it.each(["DEAD", undefined])("the scheduled run-watch ends a pre-watch orphan with outbox %s and is idempotent", async (status) => {
  const h = createHarness(); await h.registerProject();
  const old = await orphan(h, status); h.clock.advance(3_001);
  await scheduled(h);
  expect(await h.flow.get(h.owner, old.task.taskId)).toMatchObject({ status: "FAILED", failure: { message: REASON } });
  const op = await h.store.get(old.op); await scheduled(h);
  expect(await h.store.get(old.op)).toEqual(op);
});
it("the scheduled scan progresses past a capped page across cold runtimes and projects", async () => {
  const h = createHarness({ limits: { member: 100, organization: 100 } }); await h.registerProject();
  await h.registerProject({ ...definition, name: "zebra" });
  const rows = [];
  for (let i = 0; i < 51; i++) { rows.push(await orphan(h, "DEAD")); h.clock.advance(1); }
  const tail = await orphan(h, "DEAD", "zebra");
  const queryIndex = h.store.queryIndex.bind(h.store); const limits: number[] = [];
  h.store.queryIndex = async (request) => { limits.push(request.limit!); return queryIndex(request); };
  await scheduled(h);
  expect((await Promise.all(rows.map((row) => h.store.get(row.op)))).filter((row) => row?.status === "FAILED")).toHaveLength(50);
  expect(limits).toEqual([50]);
  await scheduled(h); await scheduled(h);
  expect((await Promise.all(rows.map((row) => h.store.get(row.op)))).every((row) => row?.status === "FAILED")).toBe(true);
  expect(await h.store.get(tail.op)).toMatchObject({ status: "FAILED" });
});
it.each(["ACCEPTED-young", "ACCEPTED-boundary", "DISPATCHING", "RUNNING", "delivered", "PENDING", "QUEUED", "bad-age", "future-age", "wrong-kind", "wrong-fence", "different-active", "not-preparing"])("scheduled expired-row recovery refuses %s", async (scenario) => {
  const h = createHarness(); await h.registerProject();
  const old = await orphan(h, undefined); h.clock.advance(3_001);
  if (scenario === "ACCEPTED-young") h.clock.advance(-3_000);
  if (scenario === "ACCEPTED-boundary") h.clock.advance(-1);
  if (scenario === "DISPATCHING" || scenario === "RUNNING") await h.store.update({ key: old.op, ops: [change.set("status", scenario)] });
  if (scenario === "delivered") await h.store.update({ key: old.op, ops: [change.set("deliveredAt", old.task.createdAt)] });
  if (scenario === "PENDING" || scenario === "QUEUED") await h.store.put({ item: { ...old.key, status: scenario } });
  if (scenario === "bad-age" || scenario === "future-age") await h.store.update({ key: old.op, ops: [change.set("createdAt", scenario === "bad-age" ? "invalid" : "2099-01-01T00:00:00.000Z")] });
  if (scenario === "wrong-kind") await h.store.update({ key: old.op, ops: [change.set("kind", "task")] });
  if (scenario === "wrong-fence") await h.store.update({ key: old.op, ops: [change.set("fence", 99)] });
  if (scenario === "different-active") await h.store.update({ key: workspaceKey(COMPANY, old.task.workspaceId), ops: [change.set("activeOperationId", "successor")] });
  if (scenario === "not-preparing") await h.store.update({ key: workspaceKey(COMPANY, old.task.workspaceId), ops: [change.set("status", "READY")] });
  const get = h.store.get.bind(h.store); let recoveryReads = 0;
  h.store.get = async (key) => { if (key.pk.includes("OUTBOX#")) recoveryReads++; return get(key); };
  const before = await h.store.get(old.op); await scheduled(h);
  if (scenario === "not-preparing") expect(recoveryReads).toBe(0);
  expect(await h.store.get(old.op)).toEqual(before);
  const transact = h.store.transact.bind(h.store); let writes = 0;
  h.store.transact = async (items) => { writes++; return transact(items); };
  expect(await recoverDeadPreparation(h.deps, old.task.workspaceId, old.id)).toBe(false);
  expect(writes).toBe(0);
});
it.each(["dispatch", "delivery-marker", "live-outbox", "workspace"])("the scheduled recovery fences a concurrent %s in the result transaction", async (scenario) => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, undefined); h.clock.advance(3_001);
  const transact = h.store.transact.bind(h.store); let raced = false;
  h.store.transact = async (items) => {
    if (!raced && items.some((item) => item.kind === "update" && item.key.sk === old.op.sk && item.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "FAILED"))) {
      raced = true;
      if (scenario === "dispatch") await h.store.update({ key: old.op, ops: [change.set("status", "DISPATCHING")] });
      if (scenario === "delivery-marker") await h.store.update({ key: old.op, ops: [change.set("deliveredAt", old.task.createdAt)] });
      if (scenario === "live-outbox") await h.store.put({ item: { ...old.key, status: "PENDING" } });
      if (scenario === "workspace") await h.store.update({ key: workspaceKey(COMPANY, old.task.workspaceId), ops: [change.set("status", "CLOSING")] });
    }
    return transact(items);
  };
  await scheduled(h); expect(raced).toBe(true);
  expect((await h.store.get(old.op))?.status).toBe(scenario === "dispatch" ? "DISPATCHING" : "ACCEPTED");
});

it("per-insert relay does no watch/index scan; the schedule owns recovery", async () => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "DEAD");
  const query = h.store.query.bind(h.store); let reads = 0;
  h.store.query = async (request) => { reads++; return query(request); };
  const queryIndex = h.store.queryIndex.bind(h.store);
  h.store.queryIndex = async (request) => { if (request.index === "byWorkspaceProject") throw new Error("per-insert workspace scan"); return queryIndex(request); };
  await h.flow.relayOnce(); expect(reads).toBe(0);
  expect(await h.store.get(old.op)).toMatchObject({ status: "ACCEPTED" });
});
it("an empty company catalog performs no index reads or checkpoint writes", async () => {
  const h = createHarness();
  h.store.queryIndex = async () => { throw new Error("empty catalog scan"); };
  h.store.update = async () => { throw new Error("empty catalog write"); };
  await scheduled(h);
});
it.each([undefined, 7])("an index row with id %s is ignored before any workspace read", async (id) => {
  const h = createHarness(); await h.registerProject();
  h.store.queryIndex = async () => ({ items: [{ pk: "bad", sk: "META", ...(id === undefined ? {} : { id }) }] });
  const get = h.store.get.bind(h.store); let reads = 0;
  h.store.get = async (key) => { if (key.sk !== "~RECOVERY") reads++; return get(key); };
  await scheduled(h); expect(reads).toBe(0);
});
it("a preparing workspace without an active operation is ignored", async () => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "DEAD");
  await h.store.update({ key: workspaceKey(COMPANY, old.task.workspaceId), ops: [change.set("activeOperationId", null)] });
  const get = h.store.get.bind(h.store); let invalidReads = 0;
  h.store.get = async (key) => { if (key.pk.includes("OUTBOX#null")) invalidReads++; return get(key); };
  await scheduled(h); expect(invalidReads).toBe(0); expect(await h.store.get(old.op)).toMatchObject({ status: "ACCEPTED" });
});
it("a vanished operation is ignored without abandoning the catalog walk", async () => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "DEAD");
  await h.store.delete({ key: old.op }); await scheduled(h);
  expect((await h.flow.get(h.owner, old.task.taskId)).status).toBe("STARTING");
});
it.each(["DISPATCHING", "RUNNING", "delivered"])("even a DEAD row cannot end a genuinely preparing %s operation", async (scenario) => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "DEAD");
  await h.store.update({ key: old.op, ops: [change.set(scenario === "delivered" ? "deliveredAt" : "status", scenario === "delivered" ? old.task.createdAt : scenario)] });
  const before = await h.store.get(old.op); await scheduled(h); expect(await h.store.get(old.op)).toEqual(before);
});
it.each(["kind", "createdAt", "active", "fence", "op-fence"])("the result transaction refuses a concurrent change to %s", async (scenario) => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, undefined); h.clock.advance(3_001);
  const transact = h.store.transact.bind(h.store); let raced = false;
  h.store.transact = async (items) => {
    if (!raced && items.some((item) => item.kind === "update" && item.key.sk === old.op.sk)) {
      raced = true;
      if (scenario === "op-fence") await h.store.update({ key: old.op, ops: [change.set("fence", 99)] });
      if (scenario === "kind" || scenario === "createdAt") await h.store.update({ key: old.op, ops: [change.set(scenario, scenario === "kind" ? "task" : new Date(h.clock.now).toISOString())] });
      if (scenario === "active" || scenario === "fence") await h.store.update({ key: workspaceKey(COMPANY, old.task.workspaceId), ops: [change.set(scenario === "active" ? "activeOperationId" : "fence", scenario === "active" ? "successor" : 99)] });
    }
    return transact(items);
  };
  await scheduled(h); expect(raced).toBe(true); expect(await h.store.get(old.op)).toMatchObject({ status: "ACCEPTED" });
});
it("a live row replacing DEAD in the result transaction refuses recovery", async () => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "DEAD");
  const transact = h.store.transact.bind(h.store); let raced = false;
  h.store.transact = async (items) => {
    if (!raced && items.some((item) => item.kind === "update" && item.key.sk === old.op.sk)) { raced = true; await h.store.update({ key: old.key, ops: [change.set("status", "PENDING")] }); }
    return transact(items);
  };
  await scheduled(h); expect(raced).toBe(true); expect(await h.store.get(old.op)).toMatchObject({ status: "ACCEPTED" });
});
it.each(["absent", "present", "project", "cursor", "no-project", "no-cursor"])("a stale page cannot overwrite the recovery checkpoint (%s)", async (scenario) => {
  const h = createHarness(); await h.registerProject(); const key = checkpointKey();
  if (scenario !== "absent") await h.store.put({ item: { ...key, companyId: COMPANY,
    ...(scenario === "project" || scenario === "cursor" ? { prepareRecoveryProject: "PROJECT#payments", prepareRecoveryCursor: "page-one" } : {}) } });
  h.store.queryIndex = async () => ({ items: [], cursor: "page-two" });
  const put = h.store.put.bind(h.store); let expected: Awaited<ReturnType<typeof h.store.get>>;
  h.store.put = async (request) => {
    if (request.item.sk === key.sk) {
      if (scenario === "present") await h.store.delete({ key });
      else if (scenario === "absent") await put({ item: { ...key, companyId: COMPANY, prepareRecoveryProject: "successor" } });
      else await h.store.update({ key, ops: [change.set(scenario === "project" || scenario === "no-project" ? "prepareRecoveryProject" : "prepareRecoveryCursor", "successor")] });
      expected = await h.store.get(key);
    }
    return put(request);
  };
  await scheduled(h); if (scenario !== "present") expect(expected).toBeDefined();
  expect(await h.store.get(key)).toEqual(expected);
});
it.each(["project", "cursor"])("a completed walk cannot reset a successor's checkpoint (%s)", async (scenario) => {
  const h = createHarness(); await h.registerProject(); const key = checkpointKey();
  await h.store.put({ item: { ...key, companyId: COMPANY, prepareRecoveryProject: "PROJECT#payments" } });
  const remove = h.store.delete.bind(h.store); let expected: Awaited<ReturnType<typeof h.store.get>>;
  h.store.delete = async (request) => {
    if (request.key.sk === key.sk) {
      await h.store.update({ key, ops: [change.set(scenario === "project" ? "prepareRecoveryProject" : "prepareRecoveryCursor", "successor")] });
      expected = await h.store.get(key);
    }
    return remove(request);
  };
  await scheduled(h); expect(expected).toBeDefined(); expect(await h.store.get(key)).toEqual(expected);
});
it("explicit large limits cannot exceed the historical page cap", async () => {
  const h = createHarness(); await h.registerProject(); const limits: number[] = [];
  h.store.queryIndex = async (request) => { limits.push(request.limit!); return { items: [] }; };
  await h.flow.sweepRunsOnce({ limit: 500 }); expect(limits).toEqual([50]);
});

it.each(["unasked", "requested", "terminal"])("ordinary documented result inputs still handle %s cancellation", async (scenario) => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "QUEUED");
  if (scenario !== "unasked") await h.store.update({ key: old.op, ops: [change.set("status", scenario === "requested" ? "CANCEL_REQUESTED" : "SUCCEEDED")] });
  await h.flow.recordResult({ workspaceId: old.task.workspaceId, operationId: old.id, fence: 1, status: "CANCELLED" });
  expect(await h.store.get(old.op)).toMatchObject({ status: scenario === "unasked" ? "FAILED" : scenario === "requested" ? "CANCELLED" : "SUCCEEDED" });
  if (scenario === "unasked") expect(await h.store.get(old.op)).toHaveProperty("error", "the worker stopped the job without being asked");
});

it.each(["SUCCEEDED", "FAILED"] as const)("ordinary documented %s results retain their status and optional error", async (status) => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "QUEUED");
  await h.flow.recordResult({ workspaceId: old.task.workspaceId, operationId: old.id, fence: 1, status });
  const op = await h.store.get(old.op); expect(op).toMatchObject({ status }); expect(op).not.toHaveProperty("error");
});

it("a DEAD row removed by the seven-day TTL still ends through the scheduled age rule", async () => {
  let store!: MemoryDocumentStore;
  const h = createHarness({ backend: (clock) => {
    store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: "expiresAt", nowSeconds: () => Math.floor(clock.now / 1_000) });
    return { store, queues: new MemoryQueueService({ now: () => clock.now }) };
  } });
  await h.registerProject(); const old = await orphan(h, "DEAD");
  h.clock.advance(7 * 86_400 + 1); expect(store.sweepExpired()).toBe(1);
  expect(await h.store.get(old.key)).toBeUndefined();
  expect((await h.flow.get(h.owner, old.task.taskId)).status).toBe("STARTING");
  await scheduled(h);
  expect(await h.flow.get(h.owner, old.task.taskId)).toMatchObject({ status: "FAILED", failure: { message: REASON } });
});


async function lostPreparation(h: ReturnType<typeof createHarness>) {
  const run = await orphan(h, "QUEUED");
  await h.store.update({ key: run.op, ops: [change.set("status", "DISPATCHING"), change.set("machineId", "lost-machine")] });
  await h.store.put({ item: { ...runWatchKey(COMPANY, run.task.workspaceId, run.id), entityType: "WORKFLOW_RUN_WATCH", companyId: COMPANY,
    workspaceId: run.task.workspaceId, operationId: run.id, fence: 1, machineId: "lost-machine", unhealthySince: run.task.createdAt } });
  h.machines.health = async () => ({ state: "terminated", activeOperations: 0, features: [], checkedAt: new Date(h.clock.now).toISOString() });
  h.clock.advance(121);
  return run;
}
it("the scheduled job skips and logs a poison row, ends the next orphan and lost run, and advances across cold hosts", async () => {
  const lines: unknown[] = []; const h = createHarness({ extra: () => ({ log: entry => { lines.push(entry); } }) });
  await h.registerProject(); const poison = await orphan(h, "DEAD"); h.clock.advance(1);
  const healthy = await orphan(h, "DEAD"); const lost = await lostPreparation(h);
  await h.store.update({ key: taskKey(poison.task.taskId), ops: [change.remove("charge")] });
  await expect(scheduled(h)).resolves.toBeUndefined();
  expect(await h.store.get(healthy.op)).toMatchObject({ status: "FAILED", error: REASON });
  expect(await h.store.get(lost.op)).toMatchObject({ status: "INTERRUPTED" });
  expect(await h.store.get(poison.op)).toMatchObject({ status: "ACCEPTED" });
  expect(lines).toContainEqual({ companyId: COMPANY, component: "task-flow", event: "task_flow.prepare_recovery_row_failed", workspaceId: poison.task.workspaceId });
  expect(await h.store.get(checkpointKey())).toMatchObject({ prepareRecoveryProject: "PROJECT#payments" });
  const index = h.store.queryIndex.bind(h.store); let reread = false;
  h.store.queryIndex = async request => { reread = true; return index(request); };
  await scheduled(h); expect(reread).toBe(false); // completed project, then wrap; poison cannot wedge the pass
});
it.each(["catalog", "index", "checkpoint"])("a whole historical %s failure cannot block the scheduled lost-run sweep", async phase => {
  const lines: unknown[] = []; const h = createHarness({ extra: () => ({ log: entry => { lines.push(entry); } }) });
  await h.registerProject(); const lost = await lostPreparation(h);
  const query = h.store.query.bind(h.store), put = h.store.put.bind(h.store);
  let interruptedBeforeWalk = false;
  const fail = async (): Promise<never> => {
    interruptedBeforeWalk = (await h.store.get(lost.op))?.status === "INTERRUPTED";
    throw new Error("private payload must never be logged");
  };
  if (phase === "catalog") h.store.query = async request => request.pk.endsWith("PROJECT_CATALOG") ? fail() : query(request);
  if (phase === "index") h.store.queryIndex = fail;
  if (phase === "checkpoint") h.store.put = async request => request.item.sk === "~RECOVERY" ? fail() : put(request);
  await expect(scheduled(h)).resolves.toBeUndefined();
  expect(interruptedBeforeWalk).toBe(true);
  expect(await h.store.get(lost.op)).toMatchObject({ status: "INTERRUPTED" });
  expect(lines).toContainEqual({ companyId: COMPANY, component: "task-flow", event: "task_flow.prepare_recovery_failed" });
  expect(JSON.stringify(lines)).not.toContain("private payload");
});
it("scheduled recovery leaves the inventoried catalog byte-identical so real incarnation migration succeeds", async () => {
  const h = createHarness(); await h.registerProject();
  const catalogKey = orgProjectCatalogKey(COMPANY, "payments"), revisionKey = projectRevisionKey(COMPANY, "payments", 1);
  const catalog = (await h.store.get(catalogKey))!, revision = (await h.store.get(revisionKey))!;
  const digest = (row: unknown) => createHash("sha256").update(canonicalJson(row)).digest("hex");
  const inventory = [{ project: "payments", revision: 1, catalogDigest: digest(catalog), revisionDigest: digest(revision), metaDigest: digest(null) }];
  await scheduled(h);
  expect(canonicalJson(await h.store.get(catalogKey))).toBe(canonicalJson(catalog));
  const db = new FakeDynamoDb(); db.set((await h.store.get(catalogKey))!); db.set(revision);
  expect(await backfillCorePage({ documentClient: db, tableName: "state", signInTableName: "signin" },
    { mode: "migrate-incarnations", companyId: COMPANY, projectNames: ["payments"], runId: "before-recovery", inventory, dryRun: false }))
    .toMatchObject({ written: 1, skippedConflict: 0, failed: 0 });
});
it("a scheduled recovery pass between project erase snapshot and CAS does not invalidate identity", async () => {
  const h = createHarness(); await h.registerProject(); await scheduled(h); const transact = h.store.transact.bind(h.store);
  let swept = false;
  h.store.transact = async items => {
    if (!swept && items.some(item => item.kind === "put" && item.item.sk === "META" && item.item["status"] === "deleted")) {
      swept = true; await scheduled(h);
    }
    return transact(items);
  };
  await expect(retireProjectIncarnation(h.store, COMPANY, "payments")).resolves.toBe(true);
  expect(swept).toBe(true); expect(await h.store.get(projectMetaKey(COMPANY, "payments"))).toMatchObject({ status: "deleted", incarnationRevision: 1 });
});
it("the next-project query stays inside PROJECT# and wraps without walking unrelated catalog records", async () => {
  const h = createHarness(); await h.registerProject();
  await h.store.put({ item: { pk: orgProjectCatalogKey(COMPANY, "payments").pk, sk: "ZZZ#not-a-project" } });
  await scheduled(h);
  const index = h.store.queryIndex.bind(h.store); let reads = 0;
  h.store.queryIndex = async request => { reads++; return index(request); };
  await scheduled(h); expect(reads).toBe(0); expect(await h.store.get(checkpointKey())).toBeUndefined();
  await scheduled(h); expect(reads).toBe(1);
});

it("deleted project catalog entries still have their historical workspaces recovered", async () => {
  const h = createHarness(); await h.registerProject(); const old = await orphan(h, "DEAD");
  await h.store.update({ key: orgProjectCatalogKey(COMPANY, "payments"), ops: [change.set("status", "DELETED")] });
  await scheduled(h); expect(await h.store.get(old.op)).toMatchObject({ status: "FAILED", error: REASON });
});

it("companies sharing a store resume independent recovery cursors", async () => {
  const a = createHarness({ companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
  const b = createHarness({ companyId: "org_bbbbbbbbbbbbbbbbbbbb", backend: () => ({ store: a.store, queues: a.queues }) });
  await a.registerProject(); await b.registerProject();
  await scheduled(a);
  const aKey = checkpointKey(a.deps.companyId), bKey = checkpointKey(b.deps.companyId);
  const aCheckpoint = await a.store.get(aKey);
  expect(aCheckpoint).toMatchObject({ companyId: a.deps.companyId, prepareRecoveryProject: "PROJECT#payments" });
  expect(await a.store.get(bKey)).toBeUndefined();
  await scheduled(b);
  expect(await a.store.get(aKey)).toEqual(aCheckpoint);
  expect(await a.store.get(bKey)).toMatchObject({ companyId: b.deps.companyId, prepareRecoveryProject: "PROJECT#payments" });
  await scheduled(a);
  expect(await a.store.get(aKey)).toBeUndefined(); expect(await a.store.get(bKey)).toBeDefined();
});
