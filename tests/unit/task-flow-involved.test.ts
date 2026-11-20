// Web task channel (C5): the involved index and the read side of "tasks I'm involved in". The row is a pointer; the read trusts nothing in it: every row is re-checked against the live task and
// the live task access, the company comes from the flow's own company, and a stale, forged or other-company row shows nothing. Writers are idempotent.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { queryAll, type Principal } from "@agentx/contracts";
import { involvedOnCore, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import type { TaskAccess } from "../../packages/broker/src/core/task-flow/deps.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";
import { taskIndexKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import {
  INVOLVED_EXAMINE_MAX, deleteInvolvedRow, involvedTaskIds, involvedPartition, involvedRowDelete, involvedRowKey, involvedRowPut, listInvolvedTasks, writeInvolvedRow, type InvolvedRowInput,
} from "../../packages/broker/src/core/task-flow/involved.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";
import { createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

/** Who may act on which task, as a deployment's live access says (a co-owner, say); the harness's owner rule otherwise. A test changes it between calls. */
function accessWith(allowed: Set<string>): TaskAccess {
  return {
    async checkStart() { return { allowed: true }; },
    async canAct(principal, task) {
      const record = task as { taskId?: string; developerId: string };
      return principal.personId === record.developerId || allowed.has(`${principal.companyId}|${principal.personId}|${record.taskId}`);
    },
    async checkStep() { return { allowed: true }; },
  };
}

const person = (companyId: string, personId: string): Principal => ({ companyId, personId, displayName: personId, roles: ["member"], provider: "local-owner" });
const ALICE = "alice";
const BOB = "bob";

interface World { a: Harness; b: Harness; allowed: Set<string>; store: MemoryDocumentStore }

/** Two companies on ONE store and queue, the same people in both (a person's sign-in is install-wide). */
function twoCompanies(): World {
  const allowed = new Set<string>();
  const clock = { now: Date.parse("2026-11-09T10:00:00.000Z") };
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(clock.now / 1_000) });
  const queues = new MemoryQueueService({ now: () => clock.now });
  const make = (companyId: string) => createHarness({ companyId, limits: { member: 1_000, organization: 2_000 }, backend: () => ({ store, queues }), extra: () => ({ access: accessWith(allowed) }) });
  return { a: make(COMPANY_A_ID), b: make(COMPANY_B_ID), allowed, store };
}

async function startTask(h: Harness, instructions: string): Promise<TaskRecord> {
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions });
  return (await h.store.get(taskKey(task.taskId))) as unknown as TaskRecord;
}

const rowFor = (task: TaskRecord, personId: string): InvolvedRowInput => ({ companyId: task.companyId, personId, taskId: task.taskId, createdAt: task.createdAt });
const caller = (companyId: string, personId: string) => ({ principal: person(companyId, personId) });
const allow = (w: World, companyId: string, personId: string, task: TaskRecord) => w.allowed.add(`${companyId}|${personId}|${task.taskId}`);

async function world(): Promise<{ w: World; taskA: TaskRecord; taskB: TaskRecord }> {
  const w = twoCompanies();
  await w.a.registerProject();
  await w.b.registerProject();
  return { w, taskA: await startTask(w.a, "Task of company A"), taskB: await startTask(w.b, "Task of company B") };
}

const list = (w: World, companyId: string, personId: string, options?: { limit?: number; cursor?: string }) => listInvolvedTasks((companyId === COMPANY_A_ID ? w.a : w.b).deps, caller(companyId, personId), options);

describe("the involved row and its writers", () => {

  it("writes a pointer only (ids and the creation time), never a title, a project or a status", async () => {
    const { w, taskA } = await world();
    await writeInvolvedRow({ store: w.store, now: () => new Date("2026-11-10T00:00:00.000Z") }, rowFor(taskA, ALICE));
    const row = await w.store.get(involvedRowKey(rowFor(taskA, ALICE)));
    expect(row).toEqual({ ...involvedRowKey(rowFor(taskA, ALICE)), entityType: "TASK_INVOLVED", companyId: COMPANY_A_ID, personId: ALICE, taskId: taskA.taskId, createdAt: taskA.createdAt, addedAt: "2026-11-10T00:00:00.000Z" });
    expect(JSON.stringify(row)).not.toContain("Task of company A");
    expect(JSON.stringify(row)).not.toContain("payments");
  });

  it("is idempotent: writing twice leaves one row, deleting twice (or a row that was never there) is no error", async () => {
    const { w, taskA } = await world();
    for (let i = 0; i < 3; i += 1) await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    expect(await queryAll(w.store, { pk: involvedPartition(COMPANY_A_ID, ALICE) })).toHaveLength(1);
    await deleteInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    await deleteInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    await deleteInvolvedRow({ store: w.store }, rowFor(taskA, BOB));
    expect(await queryAll(w.store, { pk: involvedPartition(COMPANY_A_ID, ALICE) })).toEqual([]);
  });

  it.each([
    ["a company id that is not one", { companyId: "acme" }],
  ])("refuses %s, in fixed words that echo nothing", async (_label, bad) => {
    const { w, taskA } = await world();
    const input: InvolvedRowInput = { ...rowFor(taskA, ALICE), ...bad };
    const secret = JSON.stringify(Object.values(bad)[0]);
    for (const act of [() => involvedRowKey(input), () => involvedRowPut(input, "2026-11-10T00:00:00.000Z"), () => involvedRowDelete(input), () => writeInvolvedRow({ store: w.store }, input), () => deleteInvolvedRow({ store: w.store }, input)]) {
      let thrown: unknown;
      try { await act(); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ code: "CONFIG_INVALID" });
      expect(String((thrown as Error).message)).not.toContain(secret.slice(1, -1) || "\u0000");
    }
    expect(() => involvedRowPut(rowFor(taskA, ALICE), "not a time")).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("listing the tasks I was added to", () => {

  it("skips a stale row: a task that is gone, and a row whose creation time is not the task's", async () => {
    const { w, taskA } = await world();
    const second = await startTask(w.a, "second");
    allow(w, COMPANY_A_ID, ALICE, taskA);
    allow(w, COMPANY_A_ID, ALICE, second);
    const gone = { ...rowFor(taskA, ALICE), taskId: randomUUID(), createdAt: "2026-11-11T00:00:00.000Z" };
    const wrongTime = { ...rowFor(second, ALICE), createdAt: "2026-11-12T00:00:00.000Z" };
    for (const row of [gone, wrongTime, rowFor(taskA, ALICE)]) await writeInvolvedRow({ store: w.store }, row);
    const answer = await list(w, COMPANY_A_ID, ALICE);
    expect(answer.tasks.map((task) => task.taskId)).toEqual([taskA.taskId]);
    expect(JSON.stringify(answer)).not.toContain("second");
  });

  it("skips a task whose owner's index row does not read (never a partial item)", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, ALICE, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    const key = taskIndexKey(taskA.developerId, taskA.createdAt, taskA.taskId);
    const index = (await w.store.get(key))!;
    await w.store.put({ item: { ...index, status: "NOT_A_STATUS" } });
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toEqual([]);
    await w.store.put({ item: { ...index, orgId: COMPANY_B_ID } });
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toEqual([]);
    await w.store.put({ item: { ...index, taskId: randomUUID() } });
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toEqual([]);
    await w.store.delete({ key });
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toEqual([]);
  });

  describe("company", () => {

    it("skips a row in the caller's partition whose own fields name another company, another person, another kind or another task", async () => {
      const { w, taskA } = await world();
      allow(w, COMPANY_A_ID, ALICE, taskA);
      const key = involvedRowKey(rowFor(taskA, ALICE));
      const good = { ...key, entityType: "TASK_INVOLVED", companyId: COMPANY_A_ID, personId: ALICE, taskId: taskA.taskId, createdAt: taskA.createdAt, addedAt: "2026-11-10T00:00:00.000Z" };
      for (const bad of [{ companyId: COMPANY_B_ID }, { personId: BOB }, { entityType: "OTHER" }, { taskId: randomUUID() }, { createdAt: "2026-01-01T00:00:00.000Z" }]) {
        await w.store.put({ item: { ...good, ...bad } });
        expect((await list(w, COMPANY_A_ID, ALICE)).tasks, JSON.stringify(bad)).toEqual([]);
      }
      await w.store.put({ item: good });
      expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toHaveLength(1);
    });

    it("reads nothing for a caller whose principal is of another company than the flow's, or whose id is not a person id", async () => {
      const { w, taskA } = await world();
      allow(w, COMPANY_B_ID, ALICE, taskA);
      allow(w, COMPANY_A_ID, ALICE, taskA);
      await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
      const query = vi.spyOn(w.store, "query");
      expect(await listInvolvedTasks(w.a.deps, { principal: person(COMPANY_B_ID, ALICE) })).toEqual({ involved: true, tasks: [] });
      expect(await listInvolvedTasks(w.a.deps, { principal: person(COMPANY_A_ID, "a#b") })).toEqual({ involved: true, tasks: [] });
      expect(await listInvolvedTasks({ ...w.a.deps, companyId: "acme" }, caller(COMPANY_A_ID, ALICE))).toEqual({ involved: true, tasks: [] });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("a bounded page", () => {
    async function many(count: number, visible = true): Promise<{ w: World; ids: string[] }> {
      const w = twoCompanies();
      await w.a.registerProject();
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        w.a.clock.advance(1);
        const task = await startTask(w.a, `task ${i}`);
        if (visible) allow(w, COMPANY_A_ID, ALICE, task);
        await writeInvolvedRow({ store: w.store }, rowFor(task, ALICE));
        ids.unshift(task.taskId);
      }
      return { w, ids };
    }

    it("examines at most INVOLVED_EXAMINE_MAX rows in one call and carries on from a cursor, so a long run of rows that show nothing never makes a long call", async () => {
      const { w, ids } = await many(INVOLVED_EXAMINE_MAX + 20, false);
      const get = vi.spyOn(w.store, "get");
      const first = await list(w, COMPANY_A_ID, ALICE);
      expect(first.tasks).toEqual([]);
      expect(first.nextCursor).toBeDefined();
      // Each examined row costs one task read (the access refuses, so nothing more).
      expect(get.mock.calls.length).toBeLessThanOrEqual(INVOLVED_EXAMINE_MAX);
      // Let the oldest 20 be seen: the second call reaches them from the cursor.
      for (const id of ids.slice(INVOLVED_EXAMINE_MAX)) w.allowed.add(`${COMPANY_A_ID}|${ALICE}|${id}`);
      const second = await list(w, COMPANY_A_ID, ALICE, { cursor: first.nextCursor! });
      expect(second.tasks.map((task) => task.taskId)).toEqual(ids.slice(INVOLVED_EXAMINE_MAX));
      expect(second.nextCursor).toBeUndefined();
    });

    it.each([
      ["a cursor that is not JSON", Buffer.from("nope").toString("base64url")],
      ["a cursor with another key", Buffer.from(JSON.stringify({ pk: "x", sk: "TASK#2026-11-09T10:00:00.000Z#" + randomUUID() })).toString("base64url")],
    ])("refuses %s in fixed words", async (_label, cursor) => {
      const { w } = await many(1);
      await expect(list(w, COMPANY_A_ID, ALICE, { cursor })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("cursor is not valid") as string });
    });

    it.each([0])("refuses a limit of %s", async (limit) => {
      const { w } = await many(1);
      await expect(list(w, COMPANY_A_ID, ALICE, { limit })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });
  });
});

describe("GET /v1/dev/tasks on the core's route function", () => {

  it("refuses a bad limit or cursor with the route's own error body, and passes limit and cursor on", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, ALICE, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    for (const query of ["limit=0", "limit=51", "limit=abc", "limit=1e2", "cursor=!!"]) {
      const answer = await handleTaskRoute(w.a.flow, { method: "GET", path: `/v1/dev/tasks?involved=1&${query}`, caller: { principal: person(COMPANY_A_ID, ALICE) } });
      expect(answer?.status, query).toBe(400);
      expect(answer?.body, query).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    }
    const ok = await handleTaskRoute(w.a.flow, { method: "GET", path: "/v1/dev/tasks?involved=1&limit=1", caller: { principal: person(COMPANY_A_ID, ALICE) } });
    expect(ok?.status).toBe(200);
  });
});

/** The store with its `query` answered by `answer` (a store that returns what a real one should not, or stalls); everything else is the real store. */
function withQuery(store: MemoryDocumentStore, answer: () => Promise<{ items: Array<Record<string, unknown>>; cursor?: string }>): MemoryDocumentStore {
  return new Proxy(store, { get: (target, property) => (property === "query" ? answer : typeof (target as never)[property] === "function" ? ((target as never)[property] as (...args: unknown[]) => unknown).bind(target) : (target as never)[property]) });
}

describe("the re-checks and bounds, one by one (review M-1 to M-3, L-3, L-4)", () => {

  it("reads at most ten pages in one call: pages with no rows that still carry a continuation end in a fixed refusal, never an endless loop or a silently empty list", async () => {
    const { w } = await world();
    let calls = 0;
    const stub = { ...w.a.deps, store: withQuery(w.store, async () => { calls += 1; return { items: [], cursor: "more" }; }) };
    await expect(listInvolvedTasks(stub, caller(COMPANY_A_ID, ALICE))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(calls).toBe(10);
    // With a cursor of its own to resume from, the same stall hands that cursor back.
    calls = 0;
    const sk = `TASK#2026-11-09T10:00:00.000Z#${randomUUID()}`;
    const cursor = Buffer.from(JSON.stringify({ sk })).toString("base64url");
    const resumed = await listInvolvedTasks(stub, caller(COMPANY_A_ID, ALICE), { cursor });
    expect(calls).toBe(10);
    expect(resumed.tasks).toEqual([]);
    expect(Buffer.from(resumed.nextCursor!, "base64url").toString()).toBe(JSON.stringify({ sk }));
  });

});

describe("the involved task ids (the decision cards' second source)", () => {
  const idsOf = (w: World, companyId: string, personId: string, principalCompany = companyId) => involvedTaskIds((companyId === COMPANY_A_ID ? w.a : w.b).deps, { companyId: principalCompany, personId });

  it("never reads another company's rows: the same person in company B has their own partition, and a principal of another company gets nothing", async () => {
    const { w, taskA, taskB } = await world();
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    await writeInvolvedRow({ store: w.store }, rowFor(taskB, ALICE));
    expect(await idsOf(w, COMPANY_A_ID, ALICE)).toEqual([taskA.taskId]);
    expect(await idsOf(w, COMPANY_B_ID, ALICE)).toEqual([taskB.taskId]);
    expect(await idsOf(w, COMPANY_A_ID, ALICE, COMPANY_B_ID)).toEqual([]);
  });

  it("leaves out a row that is not what a writer makes (fields that do not match the key, another company or person inside the partition, a stranger kind)", async () => {
    const { w, taskA, taskB } = await world();
    const pk = involvedPartition(COMPANY_A_ID, ALICE);
    const key = involvedRowKey(rowFor(taskA, ALICE));
    const good = involvedRowPut(rowFor(taskA, ALICE), "2026-11-10T00:00:00.000Z").item;
    await w.store.put({ item: { ...good, sk: `TASK#2026-01-01T00:00:00.000Z#${randomUUID()}`, taskId: taskB.taskId } });
    await w.store.put({ item: { ...good, sk: `TASK#2026-01-02T00:00:00.000Z#${taskB.taskId}`, companyId: COMPANY_B_ID } });
    await w.store.put({ item: { ...good, sk: `TASK#2026-01-03T00:00:00.000Z#${taskB.taskId}`, personId: BOB } });
    await w.store.put({ item: { ...good, sk: `TASK#2026-01-04T00:00:00.000Z#${taskB.taskId}`, entityType: "OTHER" } });
    await w.store.put({ item: { pk, sk: "TASK#9999-junk", entityType: "TASK_INVOLVED" } });
    await w.store.put({ item: { ...good, ...key } });
    expect(await idsOf(w, COMPANY_A_ID, ALICE)).toEqual([taskA.taskId]);
  });

  it("is bounded: at most INVOLVED_EXAMINE_MAX of the newest rows, whatever the person has", async () => {
    const { w, taskA } = await world();
    const ids: string[] = [];
    for (let day = 0; day < INVOLVED_EXAMINE_MAX + 20; day += 1) {
      const id = randomUUID();
      ids.push(id);
      const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + day * 60_000).toISOString();
      await writeInvolvedRow({ store: w.store }, { ...rowFor(taskA, ALICE), taskId: id, createdAt });
    }
    const got = await idsOf(w, COMPANY_A_ID, ALICE);
    expect(got).toHaveLength(INVOLVED_EXAMINE_MAX);
    expect(got).toEqual(ids.slice(20).reverse());
  });

});

describe("the AWS boundary's involved list answer", () => {
  const caller = { developerId: "d".repeat(64), sessionId: "s", name: "Maya" };
  const request = { method: "GET", path: "/v1/dev/tasks?involved=1", headers: {} };
  const answering = (statusCode: number | undefined, body = "{}"): CoreTaskEntry => ({ route: async () => (statusCode === undefined ? undefined : { statusCode, headers: {}, body }) });
  const none = { involved: true, tasks: [] };

  it("is an empty involved list with no core entry, nothing the core serves, a sign-in refusal or a missing route; never the ordinary list", async () => {
    expect(await involvedOnCore(undefined, request, caller)).toEqual(none);
    expect(await involvedOnCore(answering(undefined), request, caller)).toEqual(none);
    expect(await involvedOnCore(answering(401), request, caller)).toEqual(none);
    expect(await involvedOnCore(answering(404), request, caller)).toEqual(none);
  });

  it("passes the core's list on, and any other refusal in the core's words", async () => {
    const listed = { involved: true, tasks: [{ taskId: randomUUID() }] };
    expect(await involvedOnCore(answering(200, JSON.stringify(listed)), request, caller)).toEqual(listed);
    await expect(involvedOnCore(answering(400, JSON.stringify({ error: { code: "CONFIG_INVALID", message: "limit must be a whole number from 1 to 50" } })), request, caller)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(involvedOnCore(answering(503, JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "down" } })), request, caller)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});
