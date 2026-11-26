// #1548: `GET /v1/app/sessions/<session>/activity`. The agent's saved events for the session's own task, across its steps in the order they started, after a cursor. Read by anyone who
// can see the task (the same rule as the task's log); everyone else gets the missing-session answer. Usage and result events are never answered.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SessionActivityPageSchema, agentSessionKey, sessionActivityView, type OrgId, type Principal, type SessionActivityPage } from "@agentx/contracts";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/index.js";
import type { SessionCompanyRole, SessionMembers, SessionProjectRole } from "../../packages/broker/src/core/sessions/access.js";
import { createSessionRoutes } from "../../packages/broker/src/core-host/app/session-routes.js";
import { SESSION_ACTIVITY_PAGE_MAX_BYTES, encodeActivityCursor } from "../../packages/broker/src/core-host/app/session-activity.js";
import { operationEventKey, operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const WORKSPACE = "3f1d2c4b-5a69-4e7f-8a1b-2c3d4e5f6a7b";
const PLAN = "1a2b3c4d-0000-4000-8000-000000000001";
const CODE = "0a2b3c4d-0000-4000-8000-000000000002";
const T0 = "2026-11-26T10:00:00.000Z";
const person = (id: string): Principal => ({ companyId: ORG, personId: id, displayName: id, roles: [], provider: "oidc" });

type Table = Record<string, { role?: SessionCompanyRole; grants?: Record<string, SessionProjectRole> }>;
function members(table: Table): SessionMembers {
  const row = (developerId: string) => (developerId === developerIdOf(OWNER) ? { role: "owner" as const, grants: { web: "maintainer" as const } } : Object.entries(table).find(([personId]) => developerIdOf(person(personId)) === developerId)?.[1]);
  return { companyRole: (who) => row(who.developerId)?.role, projectGrant: (who, project) => row(who.developerId)?.grants?.[project] };
}

async function world(options: { workspace?: boolean } = {}): Promise<MemoryDocumentStore> {
  const store = new MemoryDocumentStore({ indexes: [] });
  await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: ORG, sessionId: SESSION, workspaceId: WORKSPACE, conversationId: "c", title: "Add retry", requestText: "Add retry", workflow: { definitionVersion: "1.1.0", stage: "CODE", state: "RUNNING", revision: 2, path: "QUICK", artifacts: [], decisions: [] } } });
  await store.transact(createTaskSessionItems({
    orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: developerIdOf(OWNER) } as never, now: T0,
  }));
  if (options.workspace === false) return store;
  await store.put({ item: { ...workspaceKey(ORG, WORKSPACE), entityType: "WORKSPACE", id: WORKSPACE, companyId: ORG, orgId: ORG } });
  // The plan step started first; its id sorts after the code step's, so the order must come from when each started.
  await store.put({ item: { ...operationKey(ORG, WORKSPACE, PLAN), entityType: "OPERATION", id: PLAN, kind: "agent_step", programStepId: "plan", status: "SUCCEEDED", createdAt: "2026-11-26T10:00:00.000Z" } });
  await store.put({ item: { ...operationKey(ORG, WORKSPACE, CODE), entityType: "OPERATION", id: CODE, kind: "agent_step", programStepId: "code", status: "RUNNING", createdAt: "2026-11-26T10:05:00.000Z" } });
  return store;
}

/** An event row as the worker callback writes it (services/callbacks.ts `recordEvents`). */
async function saved(store: MemoryDocumentStore, operationId: string, sequence: number, type: string, payload: unknown): Promise<void> {
  await store.put({ item: { ...operationEventKey(ORG, WORKSPACE, operationId, sequence), entityType: "OPERATION_EVENT", operationId, sequence, type, timestamp: `2026-11-26T10:00:${String(sequence).padStart(2, "0")}.000Z`, payload: payload as never } });
}

async function fill(store: MemoryDocumentStore): Promise<void> {
  await saved(store, PLAN, 1, "lifecycle", { status: "RUNNING" });
  await saved(store, PLAN, 2, "tool_start", { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
  await saved(store, PLAN, 3, "usage", { costUsd: 0.12 });
  await saved(store, PLAN, 4, "tool_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  await saved(store, CODE, 1, "progress", { message: "Installing dependencies" });
  await saved(store, CODE, 2, "result", { status: "SUCCEEDED" });
}

const routes = (store: MemoryDocumentStore, table?: Table) =>
  createSessionRoutes({ flow: { deps: { store, companyId: ORG } } as never, blobs: {} as never, companyId: ORG, origin: () => "https://example.test", ...(table === undefined ? {} : { members: members(table) }) });
const get = (route: ReturnType<typeof routes>, who: Principal, query = "", method = "GET") => route({ method, path: `/v1/app/sessions/${SESSION}/activity${query}`, headers: {} }, { principal: who });
const pageOf = (body: string): SessionActivityPage => SessionActivityPageSchema.parse(JSON.parse(body));

describe("reading a task's agent activity", () => {
  it("answers every step in the order it started and their events in order, without usage or result events", async () => {
    const store = await world();
    await fill(store);
    const answer = await get(routes(store), OWNER);
    expect(answer?.statusCode).toBe(200);
    const page = pageOf(answer!.body);
    expect(page.operations.map((operation) => operation.step)).toEqual(["plan", "code"]);
    expect(page.events.map((event) => `${event.operationId === PLAN ? "plan" : "code"}:${event.sequence}:${event.type}`)).toEqual(["plan:1:lifecycle", "plan:2:tool_start", "plan:4:tool_end", "code:1:progress"]);
    expect(answer!.body).not.toContain("costUsd");
    expect(page.active).toBe(true);
    // The cursor moved past the result event it did not answer.
    expect(page.cursor).toBe(encodeActivityCursor({ operationId: CODE, sequence: 2 }));
    // The shared formatter reads the page as it comes.
    expect(sessionActivityView(page.events, page.operations).map((item) => item.kind)).toEqual(["step", "status", "tool", "step", "note"]);
  });

  it("answers only what came after the cursor, and the same cursor when nothing new has", async () => {
    const store = await world();
    await fill(store);
    const first = pageOf((await get(routes(store), OWNER))!.body);
    const quiet = pageOf((await get(routes(store), OWNER, `?after=${first.cursor!}`))!.body);
    expect(quiet.events).toEqual([]);
    expect(quiet.cursor).toBe(first.cursor);
    await saved(store, CODE, 3, "tool_start", { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "npm test" } });
    const next = pageOf((await get(routes(store), OWNER, `?after=${first.cursor!}`))!.body);
    expect(next.events.map((event) => event.sequence)).toEqual([3]);
  });

  it("pages by the limit across steps", async () => {
    const store = await world();
    await fill(store);
    const sequences: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 5; round += 1) {
      const page = pageOf((await get(routes(store), OWNER, `?limit=1${cursor === undefined ? "" : `&after=${cursor}`}`))!.body);
      expect(page.events.length).toBeLessThanOrEqual(1);
      sequences.push(...page.events.map((event) => `${event.operationId === PLAN ? "plan" : "code"}:${event.sequence}`));
      cursor = page.cursor;
    }
    expect(sequences).toEqual(["plan:1", "plan:2", "plan:4", "code:1"]);
  });

  it("ends a page before it grows past the byte limit, but always answers at least one event", async () => {
    const store = await world();
    const big = "x".repeat(60_000);
    for (let sequence = 1; sequence <= 30; sequence += 1) await saved(store, CODE, sequence, "progress", { message: big });
    const answer = await get(routes(store), OWNER, "?limit=200");
    const page = pageOf(answer!.body);
    expect(page.events.length).toBeGreaterThan(1);
    expect(page.events.length).toBeLessThan(30);
    expect(answer!.body.length).toBeLessThan(SESSION_ACTIVITY_PAGE_MAX_BYTES + 100_000);
  });

  it("a task with no workspace yet answers an empty page", async () => {
    const store = await world({ workspace: false });
    expect(JSON.parse((await get(routes(store), OWNER))!.body)).toEqual({ operations: [], events: [], active: true });
  });

  it("an ended session answers that no more is coming", async () => {
    const store = await world();
    const meta = await store.get(agentSessionKey(ORG, SESSION, "META"));
    await store.put({ item: { ...meta!, endedAt: "2026-11-26T11:00:00.000Z" } });
    expect(pageOf((await get(routes(store), OWNER))!.body).active).toBe(false);
  });

  it("refuses a cursor or limit it did not make, and any method but GET", async () => {
    const store = await world();
    await fill(store);
    for (const query of ["?after=not-a-cursor", `?after=${encodeActivityCursor({ operationId: "another-operation", sequence: 1 })}`, "?limit=0", "?limit=201", "?limit=abc"]) {
      expect((await get(routes(store), OWNER, query))?.statusCode, query).toBe(400);
    }
    expect((await get(routes(store), OWNER, "", "POST"))?.statusCode).toBe(404);
  });

  it("anyone who can see the task reads it; everyone else gets the missing session's answer", async () => {
    const store = await world();
    await fill(store);
    const table: Table = { vic: { role: "member", grants: { web: "viewer" } }, ada: { role: "admin" }, ned: { role: "member" }, api: { role: "member", grants: { api: "maintainer" } } };
    expect((await get(routes(store, table), person("vic")))?.statusCode).toBe(200);
    expect((await get(routes(store, table), person("ada")))?.statusCode).toBe(200);
    const missing = await routes(store, table)({ method: "GET", path: "/v1/app/sessions/ses_zzzzzzzzzzzzzzzzzzzz/activity", headers: {} }, { principal: OWNER });
    for (const who of ["ned", "api", "dana"]) {
      const answer = await get(routes(store, table), person(who));
      expect(answer?.statusCode, who).toBe(404);
      expect(answer?.body, who).toBe(missing?.body);
    }
  });
});
