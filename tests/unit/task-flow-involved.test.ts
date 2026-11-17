// Web task channel (C5): the involved index and the read side of "tasks I'm involved in". The row is a pointer; the read trusts nothing in it: every row is re-checked against the live task and
// the live task access, the company comes from the flow's own company, and a stale, forged or other-company row shows nothing. Writers are idempotent.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DeveloperTaskListItemSchema, queryAll, type Principal } from "@agentx/contracts";
import { involvedOnCore, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import type { TaskAccess } from "../../packages/broker/src/core/task-flow/deps.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";
import { taskIndexKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import {
  INVOLVED_EXAMINE_MAX, deleteInvolvedRow, involvedPartition, involvedRowDelete, involvedRowKey, involvedRowPut, listInvolvedTasks, writeInvolvedRow, type InvolvedRowInput,
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
  const make = (companyId: string) => createHarness({ companyId: companyId as never, limits: { member: 1_000, organization: 2_000 }, backend: () => ({ store, queues }), extra: () => ({ access: accessWith(allowed) }) });
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
  it("is keyed in the company's partition, per person: the same person in two companies has two partitions", async () => {
    const { taskA } = await world();
    const key = involvedRowKey(rowFor(taskA, ALICE));
    expect(key.pk).toContain(COMPANY_A_ID);
    expect(key.pk).toContain(ALICE);
    expect(key.sk).toBe(`TASK#${taskA.createdAt}#${taskA.taskId}`);
    expect(involvedPartition(COMPANY_A_ID, ALICE)).not.toBe(involvedPartition(COMPANY_B_ID, ALICE));
    expect(involvedPartition(COMPANY_A_ID, ALICE)).not.toBe(involvedPartition(COMPANY_A_ID, BOB));
  });

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

  it("deleting one person's row leaves the same task's row for another person, and another task's row", async () => {
    const { w, taskA } = await world();
    const second = await startTask(w.a, "second");
    for (const row of [rowFor(taskA, ALICE), rowFor(taskA, BOB), rowFor(second, ALICE)]) await writeInvolvedRow({ store: w.store }, row);
    await deleteInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    expect(await w.store.get(involvedRowKey(rowFor(taskA, BOB)))).toBeDefined();
    expect(await w.store.get(involvedRowKey(rowFor(second, ALICE)))).toBeDefined();
    expect(await w.store.get(involvedRowKey(rowFor(taskA, ALICE)))).toBeUndefined();
  });

  it("gives the transaction steps C4 puts in its own transaction (a plain put, a delete)", async () => {
    const { w, taskA } = await world();
    const put = involvedRowPut(rowFor(taskA, ALICE), "2026-11-10T00:00:00.000Z");
    const remove = involvedRowDelete(rowFor(taskA, ALICE));
    await w.store.transact([put]);
    await w.store.transact([put]);
    expect(await queryAll(w.store, { pk: involvedPartition(COMPANY_A_ID, ALICE) })).toHaveLength(1);
    await w.store.transact([remove]);
    await w.store.transact([remove]);
    expect(await queryAll(w.store, { pk: involvedPartition(COMPANY_A_ID, ALICE) })).toEqual([]);
  });

  it.each([
    ["a company id that is not one", { companyId: "acme" }],
    ["a company id with a separator", { companyId: "org_aaaaaaaaaa#aaaaaaaaaa" }],
    ["an empty person", { personId: "" }],
    ["a person with a separator", { personId: "a#b" }],
    ["a person with white space", { personId: "a b" }],
    ["a task id that is not a task id", { taskId: "../x" }],
    ["a creation time that is not a time", { createdAt: "yesterday" }],
  ])("refuses %s, in fixed words that echo nothing", async (_label, bad) => {
    const { w, taskA } = await world();
    const input = { ...rowFor(taskA, ALICE), ...bad } as InvolvedRowInput;
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
  it("lists a task the live access lets the caller see, with the ordinary list item's shape, read from the task", async () => {
    const { w, taskA } = await world();
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    allow(w, COMPANY_A_ID, ALICE, taskA);
    const answer = await list(w, COMPANY_A_ID, ALICE);
    expect(answer).toEqual({ involved: true, tasks: [{ taskId: taskA.taskId, title: "Task of company A", project: "payments", status: "STARTING", shared: false, createdAt: taskA.createdAt, updatedAt: taskA.createdAt }] });
    expect(DeveloperTaskListItemSchema.parse(answer.tasks[0])).toEqual(answer.tasks[0]);
    // The same item the owner's own list shows for it (title, project, status and times come from the task, not from the row).
    const owners = await w.a.flow.list(w.a.owner);
    expect(owners.tasks[0]).toMatchObject({ taskId: taskA.taskId, title: "Task of company A", project: "payments", status: "STARTING", createdAt: taskA.createdAt });
  });

  it("shows the task's present status, as the owner's index row says (not what it was when the person was added)", async () => {
    const { w, taskA } = await world();
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    allow(w, COMPANY_A_ID, ALICE, taskA);
    const key = taskIndexKey(taskA.developerId, taskA.createdAt, taskA.taskId);
    await w.store.put({ item: { ...(await w.store.get(key))!, status: "RUNNING", updatedAt: "2026-11-10T09:00:00.000Z" } });
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks[0]).toMatchObject({ status: "RUNNING", updatedAt: "2026-11-10T09:00:00.000Z" });
  });

  it("shows nothing of a task whose access the person lost, or was denied: the row stays, the task is not shown", async () => {
    const { w, taskA } = await world();
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    allow(w, COMPANY_A_ID, ALICE, taskA);
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toHaveLength(1);
    w.allowed.clear();
    const gone = await list(w, COMPANY_A_ID, ALICE);
    expect(gone).toEqual({ involved: true, tasks: [] });
    expect(JSON.stringify(gone)).not.toContain("Task of company A");
    expect(await w.store.get(involvedRowKey(rowFor(taskA, ALICE)))).toBeDefined();
  });

  it("never shows the task to a person with no row, even one the access would let see it", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, BOB, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    allow(w, COMPANY_A_ID, ALICE, taskA);
    expect((await list(w, COMPANY_A_ID, BOB)).tasks).toEqual([]);
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toHaveLength(1);
  });

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

  it("leaves out the caller's own tasks (they are in the ordinary list), even with a row", async () => {
    const { w, taskA } = await world();
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, taskA.developerId));
    expect((await listInvolvedTasks(w.a.deps, { principal: w.a.owner.principal })).tasks).toEqual([]);
  });

  describe("company", () => {
    it("never lists another company's task, even when this company's partition holds a row that names it", async () => {
      const { w, taskA, taskB } = await world();
      allow(w, COMPANY_A_ID, ALICE, taskA);
      allow(w, COMPANY_B_ID, ALICE, taskB);
      // A forged row in company A's partition for Alice, naming company B's task (its own key and fields all agree with A).
      await w.store.put({ item: { ...involvedRowKey({ companyId: COMPANY_A_ID, personId: ALICE, taskId: taskB.taskId, createdAt: taskB.createdAt }), entityType: "TASK_INVOLVED", companyId: COMPANY_A_ID, personId: ALICE, taskId: taskB.taskId, createdAt: taskB.createdAt, addedAt: "2026-11-10T00:00:00.000Z" } });
      await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
      const answer = await list(w, COMPANY_A_ID, ALICE);
      expect(answer.tasks.map((task) => task.taskId)).toEqual([taskA.taskId]);
      expect(JSON.stringify(answer)).not.toContain("Task of company B");
    });

    it("lists each company's own involved tasks for the same person, and never the other's", async () => {
      const { w, taskA, taskB } = await world();
      allow(w, COMPANY_A_ID, ALICE, taskA);
      allow(w, COMPANY_B_ID, ALICE, taskB);
      await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
      await writeInvolvedRow({ store: w.store }, rowFor(taskB, ALICE));
      expect((await list(w, COMPANY_A_ID, ALICE)).tasks.map((task) => task.title)).toEqual(["Task of company A"]);
      expect((await list(w, COMPANY_B_ID, ALICE)).tasks.map((task) => task.title)).toEqual(["Task of company B"]);
      // Company B's row only, under the same ids: company A reads nothing.
      await deleteInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
      expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toEqual([]);
    });

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
      expect(await listInvolvedTasks({ ...w.a.deps, companyId: "acme" as never }, caller(COMPANY_A_ID, ALICE))).toEqual({ involved: true, tasks: [] });
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

    it("pages newest first with a cursor: every task once, none twice, and the last page has no cursor", async () => {
      const { w, ids } = await many(7);
      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      for (let page = 0; page < 10; page += 1) {
        const answer = await list(w, COMPANY_A_ID, ALICE, { limit: 3, ...(cursor === undefined ? {} : { cursor }) });
        sizes.push(answer.tasks.length);
        seen.push(...answer.tasks.map((task) => task.taskId));
        cursor = answer.nextCursor;
        if (cursor === undefined) break;
      }
      expect(sizes).toEqual([3, 3, 1]);
      expect(seen).toEqual(ids);
    });

    it("answers a page that fills exactly at the end with no cursor", async () => {
      const { w } = await many(3);
      const answer = await list(w, COMPANY_A_ID, ALICE, { limit: 3 });
      expect(answer.tasks).toHaveLength(3);
      expect(answer.nextCursor).toBeUndefined();
    });

    it("clamps the page to 50 whatever is asked", async () => {
      const { w } = await many(1);
      const answer = await list(w, COMPANY_A_ID, ALICE, { limit: 5_000 });
      expect(answer.tasks).toHaveLength(1);
      const query = vi.spyOn(w.store, "query");
      await list(w, COMPANY_A_ID, ALICE, { limit: 5_000 });
      expect(Math.max(...query.mock.calls.map(([request]) => request.limit ?? 0))).toBeLessThanOrEqual(50);
    });

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
      ["a cursor that is not base64url", "not a cursor!"],
      ["a cursor that is not JSON", Buffer.from("nope").toString("base64url")],
      ["a cursor with another key", Buffer.from(JSON.stringify({ pk: "x", sk: "TASK#2026-11-09T10:00:00.000Z#" + randomUUID() })).toString("base64url")],
      ["a cursor whose sort key is not a row's", Buffer.from(JSON.stringify({ sk: "DEVTASK#other" })).toString("base64url")],
      ["a cursor that is too long", "A".repeat(500)],
    ])("refuses %s in fixed words", async (_label, cursor) => {
      const { w } = await many(1);
      await expect(list(w, COMPANY_A_ID, ALICE, { cursor })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("cursor is not valid") });
    });

    it("a cursor can only start inside the caller's own partition: another person's sort key finds the caller's rows, never theirs", async () => {
      const { w, ids } = await many(2);
      const bobTask = await startTask(w.a, "bob's task");
      allow(w, COMPANY_A_ID, BOB, bobTask);
      await writeInvolvedRow({ store: w.store }, rowFor(bobTask, BOB));
      const sk = `TASK#9999-12-31T23:59:59.999Z#${randomUUID()}`;
      const answer = await list(w, COMPANY_A_ID, ALICE, { cursor: Buffer.from(JSON.stringify({ sk })).toString("base64url") });
      expect(answer.tasks.map((task) => task.taskId)).toEqual(ids);
      expect(JSON.stringify(answer)).not.toContain("bob's task");
    });

    it.each([0, -1, 1.5, Number.NaN])("refuses a limit of %s", async (limit) => {
      const { w } = await many(1);
      await expect(list(w, COMPANY_A_ID, ALICE, { limit })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });
  });
});

describe("GET /v1/dev/tasks on the core's route function", () => {
  it("serves ?involved=1 for exactly that query, and every other query is the ordinary list, byte for byte", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, ALICE, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    const ordinary = await handleTaskRoute(w.a.flow, { method: "GET", path: "/v1/dev/tasks", caller: w.a.owner });
    expect(JSON.stringify(ordinary)).toBe(JSON.stringify({ status: 200, body: await w.a.flow.list(w.a.owner) }));
    for (const query of ["?involved=0", "?involved=true", "?involved=11", "?involved=", "?involvedx=1", "?other=1", "?involved=1x"]) {
      expect(JSON.stringify(await handleTaskRoute(w.a.flow, { method: "GET", path: `/v1/dev/tasks${query}`, caller: w.a.owner })), query).toBe(JSON.stringify(ordinary));
    }
    const involved = await handleTaskRoute(w.a.flow, { method: "GET", path: "/v1/dev/tasks?involved=1", caller: { principal: person(COMPANY_A_ID, ALICE) } });
    expect(involved).toMatchObject({ status: 200, body: { involved: true, tasks: [{ taskId: taskA.taskId }] } });
    // The owner's own tasks are not in it.
    expect((await handleTaskRoute(w.a.flow, { method: "GET", path: "/v1/dev/tasks?involved=1", caller: w.a.owner }))?.body).toEqual({ involved: true, tasks: [] });
  });

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
  it("skips a row whose own partition key is not the caller's, even if every field agrees (a store answering from another partition)", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, ALICE, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    const good = (await queryAll(w.store, { pk: involvedPartition(COMPANY_A_ID, ALICE) }))[0]!;
    const stub = { ...w.a.deps, store: withQuery(w.store, async () => ({ items: [{ ...good, pk: involvedPartition(COMPANY_A_ID, BOB) }] })) };
    expect((await listInvolvedTasks(stub, caller(COMPANY_A_ID, ALICE))).tasks).toEqual([]);
    const honest = { ...w.a.deps, store: withQuery(w.store, async () => ({ items: [good] })) };
    expect((await listInvolvedTasks(honest, caller(COMPANY_A_ID, ALICE))).tasks).toHaveLength(1);
  });

  it("checks the task's own company, not only the owner's index row: a task of another company with an index row that names this one is not listed", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, ALICE, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toHaveLength(1);
    await w.store.put({ item: { ...(await w.store.get(taskKey(taskA.taskId)))!, companyId: COMPANY_B_ID } });
    expect((await list(w, COMPANY_A_ID, ALICE)).tasks).toEqual([]);
  });

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

  it("clamps a page to 50 tasks and refuses a cursor over 400 characters or outside base64url", async () => {
    const w = twoCompanies();
    await w.a.registerProject();
    for (let i = 0; i < 55; i += 1) {
      w.a.clock.advance(1);
      const task = await startTask(w.a, `bulk ${i}`);
      allow(w, COMPANY_A_ID, ALICE, task);
      await writeInvolvedRow({ store: w.store }, rowFor(task, ALICE));
    }
    const page = await list(w, COMPANY_A_ID, ALICE, { limit: 5_000 });
    expect(page.tasks).toHaveLength(50);
    expect(page.nextCursor).toBeDefined();
    const valid = Buffer.from(JSON.stringify({ sk: `TASK#2026-11-09T10:00:00.000Z#${randomUUID()}` })).toString("base64url");
    expect(valid.length).toBeLessThan(400);
    await expect(list(w, COMPANY_A_ID, ALICE, { cursor: valid + "A".repeat(400) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(list(w, COMPANY_A_ID, ALICE, { cursor: valid + "=" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a malformed sort key in the partition is skipped and never becomes the cursor the next call would refuse", async () => {
    const { w, taskA } = await world();
    allow(w, COMPANY_A_ID, ALICE, taskA);
    await writeInvolvedRow({ store: w.store }, rowFor(taskA, ALICE));
    await w.store.put({ item: { pk: involvedPartition(COMPANY_A_ID, ALICE), sk: "TASK#9999-junk", entityType: "TASK_INVOLVED" } });
    // The junk key sorts first (newest first): it is skipped, the real row fills the page, and nothing is left to continue from.
    const first = await list(w, COMPANY_A_ID, ALICE, { limit: 1 });
    expect(first.tasks.map((task) => task.taskId)).toEqual([taskA.taskId]);
    expect(first.nextCursor).toBeUndefined();
    const all = await list(w, COMPANY_A_ID, ALICE);
    expect(all.tasks.map((task) => task.taskId)).toEqual([taskA.taskId]);
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
