import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DeveloperTaskDetailedListResponseSchema, DeveloperTaskViewSchema, OperationSchema, WorkspaceInstanceSchema, change } from "@agentx/contracts";
import { routeDeveloperTaskRequest, taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { taskStartupView, type DeveloperTaskRecord, type OperationFacts } from "../../packages/broker/src/developer/task-records.js";
import { developerTaskView } from "../../packages/broker/src/core-host/app/task-view.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { PRIYA, pageTask } from "../support/page-tasks.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";

const at = "2026-11-22T00:00:00.000Z";
const operation = (kind = "prepare", status = "ACCEPTED"): OperationFacts => ({ id: "own", kind, status, createdAt: at });
const workspace = { status: "PREPARING", activeOperationId: "own" };

describe("startup reason from authoritative own workspace / operation facts", () => {
  it.each(["ACCEPTED", "DISPATCHING", "RUNNING"])("identifies its active prepare/resume in %s", (status) => {
    expect(taskStartupView({ status: "STARTING", closing: false }, workspace, [operation("prepare", status)])).toEqual({ startupReason: "own-machine-starting" });
    expect(taskStartupView({ status: "STARTING", closing: false }, { ...workspace, status: "RESUMING" }, [operation("resume", status)])).toEqual({ startupReason: "own-machine-starting" });
  });

  it.each(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"] as const)("omits the reason for %s even with stale startup facts", (status) => {
    expect(taskStartupView({ status, closing: false }, workspace, [operation()])).toEqual({});
  });

  it("omits the reason while closing", () => {
    expect(taskStartupView({ status: "STARTING", closing: true }, workspace, [operation()])).toEqual({});
  });

  it("uses unknown for missing, mismatched, terminal or non-startup facts; ACCEPTED alone proves nothing", () => {
    const cases: Array<[typeof workspace | undefined, OperationFacts[]]> = [
      [undefined, []], [workspace, []], [{ ...workspace, activeOperationId: "other" }, [operation()]],
      [{ ...workspace, status: "READY" }, [operation()]], [{ ...workspace, status: "BUSY" }, [operation("task")]],
      [workspace, [operation("resume")]], [{ ...workspace, status: "RESUMING" }, [operation()]],
      ...["task", "publish", "close"].map((kind): [typeof workspace, OperationFacts[]] => [workspace, [operation(kind)]]),
      ...["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CANCEL_REQUESTED", "future"].map((status): [typeof workspace, OperationFacts[]] => [workspace, [operation("prepare", status)]]),
    ];
    for (const [facts, operations] of cases) expect(taskStartupView({ status: "STARTING", closing: false }, facts, operations)).toEqual({ startupReason: "unknown" });
  });
});

function legacyFixture() {
  const f = pageTask({ shared: false });
  const task = f.db.get(`DEVTASK#${f.taskId}`, "META") as unknown as DeveloperTaskRecord;
  const wid = task.workspaceId;
  const prepare = OperationSchema.parse({ ...operation(), id: randomUUID(), workspaceId: wid, requestId: randomUUID(), payloadHash: "a".repeat(64), fence: 1, updatedAt: at });
  let ws = WorkspaceInstanceSchema.parse({ id: wid, ownerKey: task.ownerKey, projectName: task.project, projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", ...workspace, activeOperationId: prepare.id, fence: 1, createdAt: at, updatedAt: at });
  let operations = [prepare];
  const workspaceRead = vi.fn(async () => ws);
  const operationRead = vi.fn(async () => operations);
  f.deps.actions.workspace = workspaceRead;
  f.deps.actions.operations = operationRead;
  // The index has its own keys, never the canonical task's.
  f.db.set({ ...task, pk: `DEVELOPER#${PRIYA.developerId}`, sk: `TASK#${at}#${task.taskId}`, entityType: "DEVELOPER_TASK_INDEX", status: "STARTING" });
  const list = async (query = "detail=1") => routeDeveloperTaskRequest(f.deps, PRIYA, { method: "GET", path: "/v1/dev/tasks", headers: {}, requestId: newRequestId() }, new URL(`https://example.test/v1/dev/tasks?${query}`)) as Promise<{ tasks: Array<Record<string, unknown>> }>;
  return { ...f, task, prepare, list, workspaceRead, operationRead, state: (status: typeof ws.status, next = operations) => { ws = { ...ws, status }; operations = next; } };
}

describe("single task producer and detail=1 parity", () => {
  // D1-2 (DEC 254zzz502): a legacy (unmarked) task is no longer listed, so the legacy `taskView` mapping stands alone here; the detailed row of a core task is the next test.
  it("uses the same real prepare, unknown and omitted mapping for the legacy taskView", async () => {
    const f = legacyFixture();
    for (const [state, expected] of [["PREPARING", "own-machine-starting"], ["READY", "unknown"]] as const) {
      f.state(state);
      const view = await taskView(f.deps, f.task, { events: 0, details: false });
      expect(DeveloperTaskViewSchema.parse(view).startupReason).toBe(expected);
      expect((await f.list()).tasks).toEqual([]);
    }
    const build = { ...f.prepare, id: randomUUID(), kind: "task" as const, status: "RUNNING" as const };
    f.state("BUSY", [build]);
    expect(await taskView(f.deps, f.task, { events: 0, details: false })).not.toHaveProperty("startupReason");
  });

  it.each(["", "detail=true", "detail=0"])("keeps the ordinary list unchanged for %s", async (query) => {
    const f = legacyFixture();
    f.db.set({ ...coreTaskMarkKey(f.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "cc=on", stampedAt: at } });
    expect((await f.list(query)).tasks[0]).not.toHaveProperty("startupReason");
  });

  it("core detail reads the same authorized task route and never workflow workspace facts", async () => {
    const f = legacyFixture();
    f.db.set({ ...coreTaskMarkKey(f.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "cc=on", stampedAt: at } });
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: f.taskId, startupReason: "own-machine-starting" } }) }));
    f.deps.coreTasks = { route };
    expect(DeveloperTaskDetailedListResponseSchema.parse(await f.list()).tasks[0]?.startupReason).toBe("own-machine-starting");
    expect(route).toHaveBeenCalledWith({ method: "GET", path: `/v1/dev/tasks/${f.taskId}`, headers: {} }, PRIYA);
    expect(f.workspaceRead).not.toHaveBeenCalled();
    expect(f.operationRead).not.toHaveBeenCalled();
    for (const [statusCode, task] of [
      [200, { taskId: f.taskId, startupReason: "unknown" }], [200, { taskId: f.taskId }],
      [404, { taskId: f.taskId, startupReason: "own-machine-starting" }], [401, { taskId: f.taskId, startupReason: "own-machine-starting" }],
      [200, { taskId: randomUUID(), startupReason: "own-machine-starting" }], [200, { taskId: f.taskId, startupReason: "daily-limit" }],
    ] as const) {
      route.mockResolvedValue({ statusCode, headers: {}, body: JSON.stringify({ task }) });
      const row = (await f.list()).tasks[0]!;
      if (statusCode === 200 && task.taskId === f.taskId && "startupReason" in task && task.startupReason === "unknown") expect(row).toHaveProperty("startupReason", "unknown");
      else expect(row).not.toHaveProperty("startupReason");
    }
    route.mockResolvedValue({ statusCode: 200, headers: {}, body: "not json" });
    expect((await f.list()).tasks[0]).not.toHaveProperty("startupReason");
    route.mockRejectedValue(new Error("unavailable"));
    expect((await f.list()).tasks[0]).not.toHaveProperty("startupReason");
    delete f.deps.coreTasks;
    expect((await f.list()).tasks[0]).not.toHaveProperty("startupReason");
  });

  it.each(["RUNNING", "SUCCEEDED"] as const)("omits startup details for a core index row already %s", async status => {
    const f = legacyFixture();
    const pk = `DEVELOPER#${PRIYA.developerId}`, sk = `TASK#${at}#${f.taskId}`;
    f.db.set({ ...f.db.get(pk, sk)!, status });
    f.db.set({ ...coreTaskMarkKey(f.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "all", stampedAt: at } });
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: f.taskId, startupReason: "own-machine-starting" } }) }));
    f.deps.coreTasks = { route };
    const row = DeveloperTaskDetailedListResponseSchema.parse(await f.list()).tasks[0]!;
    expect(row.status).toBe(status);
    expect(row).not.toHaveProperty("startupReason");
    expect(route).not.toHaveBeenCalled();
    expect(f.workspaceRead).not.toHaveBeenCalled();
    expect(f.operationRead).not.toHaveBeenCalled();
  });

  it("never exposes another company's reason from a planted index row", async () => {
    const f = legacyFixture();
    f.deps.companyId = "org_startreason000000001";
    f.db.set({ ...f.task, companyId: "org_startreason000000002" });
    const route = vi.fn();
    f.deps.coreTasks = { route };
    expect((await f.list()).tasks).toEqual([]);
    expect(route).not.toHaveBeenCalled();
    expect(f.workspaceRead).not.toHaveBeenCalled();
  });
});

describe("core task read and public presentation", () => {
  it("serves its own starting preparation, unknown without facts, and omits after the build or close", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Fix retry" });
    const id = started.task.taskId, wid = started.task.workspaceId;
    const task = (await readTask(h.deps, id))!;
    const read = async () => {
      const answer = await handleTaskRoute(h.flow, { method: "GET", path: `/v1/dev/tasks/${id}`, caller: h.owner });
      expect(answer?.status).toBe(200);
      const view = await h.flow.get(h.owner, id);
      const publicView = await developerTaskView(task, view, {} as never);
      return { answer, publicView, view };
    };
    let result = await read();
    expect(result.answer?.body).toMatchObject({ task: { startupReason: "own-machine-starting" } });
    expect(DeveloperTaskViewSchema.parse(result.publicView).startupReason).toBe("own-machine-starting");
    await h.store.update({ key: workspaceKey(COMPANY, wid), ops: [change.set("status", "READY")] });
    result = await read();
    expect(result.publicView).toHaveProperty("startupReason", "unknown");
    await h.store.update({ key: taskPointerKey(COMPANY, wid), ops: [change.remove("pendingPrompt")] });
    const op = { ...operation("task", "RUNNING"), id: randomUUID(), workspaceId: wid, companyId: COMPANY, requestId: randomUUID(), payloadHash: "a".repeat(64), fence: 2, updatedAt: at };
    await h.store.put({ item: toDocument({ ...op, ...operationKey(COMPANY, wid, op.id), entityType: "OPERATION" }) });
    expect((await read()).publicView).not.toHaveProperty("startupReason");
    await h.store.update({ key: workspaceKey(COMPANY, wid), ops: [change.set("status", "CLOSED")] });
    expect((await read()).publicView).not.toHaveProperty("startupReason");
    const other = { ...h.owner, principal: { ...h.owner.principal, companyId: "org_startreason000000002" } };
    expect((await handleTaskRoute(h.flow, { method: "GET", path: `/v1/dev/tasks/${id}`, caller: other }))?.status).toBe(404);
  });
});
