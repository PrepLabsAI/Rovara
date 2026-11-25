// D1-2 review S1 (DEC 254zzz502): in company mode a list page counts its own rows against `limit`; old rows (no core mark) must not use the page up.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundedCompanyReads } from "../../packages/broker/src/aws/company-check.js";
import { agentXError } from "@agentx/contracts";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const DEV = "d".repeat(64);
const caller = { developerId: DEV, sessionId: "s", name: "Maya" } as never;
// A person lists their own task in a company only while they hold its project (PROJECT-GRANT-RECHECK, #1469); here they do.
const HOLDS_PROJECT = async () => ({ name: "Maya", projectMember: true });

function seed(db: FakeDynamoDb, taskId: string, at: string, core: boolean, padding = 0) {
  const meta = { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: DEV, companyId: COMPANY, title: core ? "Core" : "Old", project: "payments", createdAt: at, updatedAt: at, shared: false };
  db.set(padding === 0 ? meta : { ...meta, notes: "x".repeat(padding) });
  db.set({ ...meta, pk: `DEVELOPER#${DEV}`, sk: `TASK#${at}#${taskId}`, entityType: "DEVELOPER_TASK_INDEX", status: "CLOSED" });
  if (core) db.set({ ...engineStampKey(taskId), entityType: "TASK_ENGINE", coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on", stampedAt: at } });
}
const list = (db: { send(command: unknown): Promise<unknown> }, query: string) => routeDeveloperTaskRequest({ documentClient: db, tableName: "state", companyId: COMPANY, developer: {}, taskReaderPerson: HOLDS_PROJECT } as never, caller,
  { method: "GET", path: `/v1/dev/tasks${query}`, headers: {} } as never, new URL(`/v1/dev/tasks${query}`, "https://agentx.invalid")) as Promise<{ tasks: Array<{ taskId: string }>; nextCursor?: string }>;

describe("the task list in company mode with old rows newest", () => {
  it("lists the core task on the first page when the newest rows are old, and says nothing of old rows", async () => {
    const db = new FakeDynamoDb();
    const core = randomUUID();
    seed(db, core, "2026-11-01T00:00:00.000Z", true);
    for (let n = 1; n <= 6; n += 1) seed(db, randomUUID(), `2026-12-0${n}T00:00:00.000Z`, false);
    const page = await list(db, "?limit=2");
    expect(page.tasks.map((row) => row.taskId)).toEqual([core]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("a person with only old tasks gets an empty page with no cursor", async () => {
    const db = new FakeDynamoDb();
    for (let n = 1; n <= 5; n += 1) seed(db, randomUUID(), `2026-12-0${n}T00:00:00.000Z`, false);
    const page = await list(db, "?limit=2");
    expect(page).toEqual({ tasks: [] });
  });

  // An old row is one strongly consistent read of its mark. Rows counted: 200 old rows read at most (the old-row bound), then 50 core rows each with its mark, its task and the detail reads.
  it("200 old rows, limit=50 and detail=1 fit the company read budget (512 commands): a page, not an error", async () => {
    const db = new FakeDynamoDb();
    const coreIds: string[] = [];
    for (let n = 0; n < 60; n += 1) { const id = randomUUID(); coreIds.push(id); seed(db, id, `2026-10-${String(1 + (n % 28)).padStart(2, "0")}T0${n % 10}:00:00.000Z`, true); }
    for (let n = 0; n < 210; n += 1) seed(db, randomUUID(), `2026-12-01T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`, false);
    const scope = boundedCompanyReads(db);
    const page = await routeDeveloperTaskRequest({ documentClient: scope.client, tableName: "state", companyId: COMPANY, developer: {}, taskReaderPerson: HOLDS_PROJECT } as never, caller,
      { method: "GET", path: "/v1/dev/tasks", headers: {} } as never, new URL("/v1/dev/tasks?limit=50&detail=1", "https://agentx.invalid")) as { tasks: unknown[]; nextCursor?: string };
    scope.check(page.nextCursor !== undefined);
    // the first 200 old rows use their own bound, so the page ends with a cursor before any core row (an empty page that says there is more)
    expect(page.tasks).toEqual([]);
    expect(page.nextCursor).toBeDefined();
    // and the next page, from that cursor, reads the rest of the old rows and lists core tasks within the budget
    const scope2 = boundedCompanyReads(db);
    const next = await routeDeveloperTaskRequest({ documentClient: scope2.client, tableName: "state", companyId: COMPANY, developer: {}, taskReaderPerson: HOLDS_PROJECT } as never, caller,
      { method: "GET", path: "/v1/dev/tasks", headers: {} } as never, new URL(`/v1/dev/tasks?limit=50&detail=1&cursor=${page.nextCursor}`, "https://agentx.invalid")) as { tasks: Array<{ taskId: string }>; nextCursor?: string };
    scope2.check(next.nextCursor !== undefined);
    expect(next.tasks).toHaveLength(50);
    expect(next.tasks.every((row) => coreIds.includes(row.taskId))).toBe(true);
  });

  it("running out of the read budget ends the page with a cursor at the last row fully examined, never an error", async () => {
    const db = new FakeDynamoDb();
    const core = Array.from({ length: 8 }, () => randomUUID());
    core.forEach((id, n) => seed(db, id, `2026-11-0${n + 1}T00:00:00.000Z`, true));
    let sends = 0;
    const tight = { send: async (command: unknown) => { sends += 1; if (sends > 12) throw agentXError("CONFIG_INVALID", "company read limit exceeded"); return db.send(command as never); } };
    const page = await list(tight, "?limit=50");
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(page.tasks.length).toBeLessThan(8);
    expect(page.nextCursor).toBeDefined();
    // no progress at all is still an error (nothing to resume from)
    sends = 100;
    await expect(list(tight, "?limit=50")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  // The route checks the whole call once more after the page (`scope.check(cursor present)`): a page that ended with a cursor because it ran out of ANY budget must pass that check, and a complete page that went over must still refuse.
  const routeLike = async (client: { send(command: unknown): Promise<unknown> }, scope: ReturnType<typeof boundedCompanyReads>, query: string) => {
    const page = await list(client, query);
    scope.check(page.nextCursor !== undefined);
    return page;
  };

  it("running out of the BYTES read limit (8 MB) ends the page with a cursor, and the route's whole-call check accepts it", async () => {
    const db = new FakeDynamoDb();
    for (let n = 1; n <= 20; n += 1) seed(db, randomUUID(), `2026-11-${String(n).padStart(2, "0")}T00:00:00.000Z`, true, 500_000);
    const scope = boundedCompanyReads(db);
    const page = await routeLike(scope.client, scope, "?limit=50");
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(page.tasks.length).toBeLessThan(20);
    expect(page.nextCursor).toBeDefined();
  });

  it("running out of the TIME read limit (10 s) ends the page with a cursor, and the route's whole-call check accepts it", async () => {
    const db = new FakeDynamoDb();
    for (let n = 1; n <= 20; n += 1) seed(db, randomUUID(), `2026-11-${String(n).padStart(2, "0")}T00:00:00.000Z`, true);
    let now = 0;
    const scope = boundedCompanyReads(db, () => (now += 700));
    const page = await routeLike(scope.client, scope, "?limit=50");
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(page.tasks.length).toBeLessThan(20);
    expect(page.nextCursor).toBeDefined();
  });

  it("the whole-call check still refuses a call that went over its budget and has no cursor to continue from", () => {
    let now = 0;
    const scope = boundedCompanyReads(new FakeDynamoDb(), () => (now += 20_000));
    expect(() => scope.check(false)).toThrow(/company read limit exceeded/);
    expect(() => scope.check(true)).not.toThrow();
  });
});
