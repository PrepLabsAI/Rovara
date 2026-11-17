// Web task channel C7: the in-app inbox. A person's attention rows are kept beside the attention queue (the queue's own row goes once the person was messaged or has nowhere to be); GET /v1/app/inbox lists
// them newest first, one bounded page with a cursor, each row checked again against the person's session access now; POST /v1/app/inbox/read marks only the caller's own rows.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID, agentSessionKey, type OrgId, type Principal } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import type { SessionCompanyRole, SessionMembers, SessionProjectRole } from "../../packages/broker/src/core/sessions/access.js";
import { INBOX_PAGE_MAX, INBOX_READ_IDS_MAX, deliverAttention, inboxIdOf, inboxKey, inboxPartition, inboxRow, queueAttention, parseInboxId } from "../../packages/broker/src/core/notify/index.js";
import { createInboxRoutes } from "../../packages/broker/src/core-host/inbox-routes.js";
import { createCoreDevRoutes, NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { appRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER_ORG = "org_inboxother0000000001" as OrgId;
const T0 = "2026-11-09T10:00:00.000Z";
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const person = (personId: string, companyId: string = ORG): Principal => ({ companyId, personId, displayName: personId, roles: ["member"], provider: "test" });
const DANA = person("dana");
const DANA_ID = developerIdOf(DANA);
const ERIN = person("erin");
const ERIN_ID = developerIdOf(ERIN);
const AGENT = { agentId: "rovara-code", name: "Rovara Code", version: 1 };
const taskIdOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function membersOf() {
  const roles = new Map<string, SessionCompanyRole>();
  const grants = new Map<string, SessionProjectRole>();
  const throwing = { value: false };
  const members: SessionMembers = {
    companyRole: (who) => { if (throwing.value) throw new Error("members down"); return roles.get(`${who.companyId}|${who.developerId}`); },
    projectGrant: (who, project) => grants.get(`${who.developerId}|${project}`),
  };
  return { members, roles, grants, throwing, join: (companyId: string, developerId: string, role: SessionCompanyRole = "member") => roles.set(`${companyId}|${developerId}`, role), grant: (developerId: string, project: string, role: SessionProjectRole = "contributor") => grants.set(`${developerId}|${project}`, role) };
}

/** A task session in a state, written the way the task flow does it: created, then its summary refreshed (twice, so the move is a real change). */
async function addSession(store: MemoryDocumentStore, n: number, options: { title?: string; stage?: string; state?: string; owner?: Principal; orgId?: OrgId; onChange?: SummaryDependencies["onChange"] } = {}) {
  const orgId = options.orgId ?? ORG;
  const taskId = taskIdOf(n);
  const sessionId = taskSessionId(taskId);
  const owner = options.owner ?? OWNER;
  await store.transact(createTaskSessionItems({ orgId, sessionId, taskId, project: "web", agent: AGENT, title: options.title ?? `Task ${String(n)}`, owner, origin: "app", payer: { kind: "member", developerId: developerIdOf(owner) } as never, now: T0 }));
  const facts: { value: SessionTaskFacts } = { value: { companyId: orgId, taskId, project: "web", ownerDeveloperId: developerIdOf(owner), runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } };
  let ms = NOW - 3_600_000;
  const deps: SummaryDependencies = { store, facts: { read: async () => facts.value }, cost: { costUsd: async () => 0 }, now: () => new Date(ms), log: () => undefined, ...(options.onChange === undefined ? {} : { onChange: options.onChange }) };
  const move = async (stage: string, state: string, extra: Partial<SessionTaskFacts> = {}) => { facts.value = { ...facts.value, workflow: { stage, state }, ...extra }; ms += 1_000; await refreshSessionSummary(deps, orgId, sessionId); };
  await move("IMPLEMENT", "RUNNING");
  await move(options.stage ?? "PLAN_REVIEW", options.state ?? "WAITING");
  return { sessionId, taskId, move };
}

async function world() {
  const store = new MemoryDocumentStore();
  const m = membersOf();
  m.join(ORG, OWNER_ID, "owner");
  m.join(ORG, DANA_ID);
  m.join(ORG, ERIN_ID);
  const clock = { ms: NOW };
  const routeFor = (companyId: OrgId = ORG) => createInboxRoutes({ store, companyId, origin: () => "https://app.example", members: m.members, now: () => clock.ms });
  interface InboxBody { items: Array<{ id: string; sessionId: string; kind: string; title: string; status: string; link: string; at: string; read: boolean }>; unread?: number; nextCursor?: string; marked?: number; error: { code: string; message: string } }
  type Answer = { status: number; body: InboxBody };
  const call = async (caller: Principal, method: string, path: string, body?: unknown, companyId: OrgId = ORG): Promise<Answer> => {
    try {
      const answer = await routeFor(companyId)({ method, path, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, { principal: caller });
      if (answer === undefined) return { status: 0, body: undefined as never };
      return { status: answer.statusCode, body: JSON.parse(answer.body) as InboxBody };
    } catch (error) {
      if (error instanceof AgentXError) return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as InboxBody };
      throw error;
    }
  };
  const list = (caller: Principal, query = "", companyId: OrgId = ORG) => call(caller, "GET", `/v1/app/inbox${query}`, undefined, companyId);
  const mark = (caller: Principal, ids: unknown[], extra: Record<string, unknown> = {}) => call(caller, "POST", "/v1/app/inbox/read", { requestId: randomUUID(), ids, ...extra });
  /** One inbox row for a person, as `queueAttention` writes it. */
  const rowFor = async (developerId: string, sessionId: string, kind: "needs_you" | "paused" | "ready" | "failed" | "done", atMs: number, orgId: OrgId = ORG) =>
    store.put({ item: inboxRow({ orgId, developerId, sessionId, kind, at: new Date(atMs).toISOString(), nowMs: NOW }) });
  return { store, m, clock, list, mark, call, rowFor, routeFor };
}

describe("what the queue keeps for the inbox", () => {
  it("writes one row for the owner when a session moves into Needs you, replaces it on the next change, and a failed inbox write never holds the queue back", async () => {
    const store = new MemoryDocumentStore();
    const logs: Array<Record<string, unknown>> = [];
    const hook: SummaryDependencies["onChange"] = [async (change) => { await queueAttention({ store, now: () => new Date(NOW), log: (entry) => logs.push(entry) }, change); }];
    const { sessionId, move } = await addSession(store, 1, { stage: "IMPLEMENT", state: "RUNNING", onChange: hook });
    await move("PLAN_REVIEW", "WAITING");
    const row = await store.get(inboxKey(ORG, OWNER_ID, sessionId, "needs_you"));
    expect(row).toMatchObject({ entityType: "NOTIFY_INBOX", orgId: ORG, developerId: OWNER_ID, sessionId, kind: "needs_you" });
    expect(row!["expiresAtSec"]).toBe(Math.floor(NOW / 1000) + 14 * 86_400);
    expect(row!["indexExpiresAt"]).toBe(Math.floor(NOW / 1000) + 14 * 86_400);
    // A read mark, then a later change of the same kind: the row is replaced and is unread again.
    await store.update({ key: inboxKey(ORG, OWNER_ID, sessionId, "needs_you"), ops: [{ op: "set", path: ["readAt"], value: 1 }] });
    await move("IMPLEMENT", "RUNNING");
    await move("PLAN_REVIEW", "WAITING");
    expect((await store.get(inboxKey(ORG, OWNER_ID, sessionId, "needs_you")))!["readAt"]).toBeUndefined();
    // A store that refuses the inbox row still queues the pending row, and says so in fixed words.
    const failing = new MemoryDocumentStore();
    const realPut = failing.put.bind(failing);
    vi.spyOn(failing, "put").mockImplementation(async (request) => { if (request.item["entityType"] === "NOTIFY_INBOX") throw new Error("boom"); return realPut(request); });
    const failLogs: Array<Record<string, unknown>> = [];
    const failHook: SummaryDependencies["onChange"] = [async (change) => { await queueAttention({ store: failing, now: () => new Date(NOW), log: (entry) => failLogs.push(entry) }, change); }];
    const second = await addSession(failing, 2, { stage: "IMPLEMENT", state: "RUNNING", onChange: failHook });
    await second.move("PLAN_REVIEW", "WAITING");
    expect((await failing.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(1);
    expect(failLogs).toEqual([{ event: "attention.inbox_failed", sessionId: second.sessionId, error: "Error" }]);
    expect(logs).toEqual([]);
  });

  it("keeps the inbox row after the queue's own row went (nobody to message), so a person with no chat and no email still finds it", async () => {
    const w = await world();
    const store = w.store;
    const hook: SummaryDependencies["onChange"] = [async (change) => { await queueAttention({ store, now: () => new Date(NOW), log: () => undefined }, change); }];
    const { sessionId, move } = await addSession(store, 1, { stage: "IMPLEMENT", state: "RUNNING", onChange: hook });
    await move("PLAN_REVIEW", "WAITING");
    expect((await store.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(1);
    await deliverAttention({ store, registry: createAdapterRegistry(), now: () => NOW + 3_600_000, log: () => undefined });
    expect((await store.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(0);
    const shown = await w.list(OWNER);
    expect(shown.status).toBe(200);
    expect(shown.body.items.map((item) => item.sessionId)).toEqual([sessionId]);
  });
});

describe("GET /v1/app/inbox", () => {
  it("shows only what a message would hold (title, status words, link), for the caller's own rows, and nothing else", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1, { title: "Add retry" });
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 1000);
    const shown = await w.list(OWNER);
    expect(shown.status).toBe(200);
    expect(shown.body.items).toHaveLength(1);
    const item = shown.body.items[0];
    expect(Object.keys(item ?? {}).sort()).toEqual(["at", "id", "kind", "link", "read", "sessionId", "status", "title"]);
    expect(item).toMatchObject({ sessionId, kind: "needs_you", title: "Add retry", read: false, link: `https://app.example/app/sessions/${sessionId}`, id: inboxIdOf({ sessionId, kind: "needs_you", atMs: NOW - 1000 }) });
    expect(typeof item?.status).toBe("string");
    expect(Object.keys(shown.body).sort()).toEqual(["items", "unread"]);
    expect(shown.body.unread).toBe(1);
    expect(JSON.stringify(shown.body)).not.toContain(OWNER_ID);
    expect(shown.body.items[0]?.id).toMatch(/^ses_[0-9a-z]{20}\.needs_you\.[0-9]+$/u);
  });

  it("lists newest first in bounded pages with a cursor, every row once", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let n = 1; n <= 7; n += 1) {
      const { sessionId } = await addSession(w.store, n);
      await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - n * 60_000);
      ids.push(sessionId);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await w.list(OWNER, `?limit=3${cursor === undefined ? "" : `&cursor=${cursor}`}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.body.items.map((item) => item.sessionId));
      if (cursor === undefined) expect(page.body.unread).toBe(7); else expect(page.body.unread).toBeUndefined();
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
    // The default page and the bound.
    expect((await w.list(OWNER)).body.items).toHaveLength(7);
    for (const bad of ["?limit=0", `?limit=${String(INBOX_PAGE_MAX + 1)}`, "?limit=abc", "?limit=-1", "?limit=1.5"]) {
      const refused = await w.list(OWNER, bad);
      expect(refused.status, bad).toBe(400);
      expect(refused.body.error.message).toBe("The page size must be a whole number from 1 to 50.");
    }
    for (const bad of ["?cursor=%%%", `?cursor=${Buffer.from("[1]").toString("base64url")}`, `?cursor=${Buffer.from('["a","b"]').toString("base64url")}`, `?cursor=${"A".repeat(300)}`]) {
      const refused = await w.list(OWNER, bad);
      expect(refused.status, bad).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain("AAAA");
    }
  });

  it("shows a person nothing of another person's rows, and checks every row against the person's access now (lost access reads as nothing)", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1, { title: "Secret plan" });
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 1000);
    // Dana holds a row for the owner's session but no access to it: nothing, and no count.
    await w.rowFor(DANA_ID, sessionId, "needs_you", NOW - 1000);
    const none = await w.list(DANA);
    expect(none.body).toEqual({ items: [], unread: 0 });
    // A project grant gives her view: now she sees it. Her row only; the owner's row is not hers.
    w.m.grant(DANA_ID, "web");
    const seen = await w.list(DANA);
    expect(seen.body.items).toHaveLength(1);
    expect(seen.body.unread).toBe(1);
    // The grant goes: gone again, at once.
    w.m.grants.clear();
    expect((await w.list(DANA)).body).toEqual({ items: [], unread: 0 });
    // Losing the company membership hides everything too, even for the session's owner.
    w.m.roles.delete(`${ORG}|${OWNER_ID}`);
    expect((await w.list(OWNER)).body).toEqual({ items: [], unread: 0 });
  });

  it("hides a row whose task moved on, a session that is gone, and a Needs you of an ended session", async () => {
    const w = await world();
    const a = await addSession(w.store, 1);
    const b = await addSession(w.store, 2);
    const c = await addSession(w.store, 3);
    await w.rowFor(OWNER_ID, a.sessionId, "needs_you", NOW - 3000);
    await w.rowFor(OWNER_ID, b.sessionId, "needs_you", NOW - 2000);
    await w.rowFor(OWNER_ID, c.sessionId, "needs_you", NOW - 1000);
    await w.rowFor(OWNER_ID, `ses_${"z".repeat(20)}`, "needs_you", NOW - 500);
    expect((await w.list(OWNER)).body.items).toHaveLength(3);
    await a.move("IMPLEMENT", "RUNNING");
    expect((await w.list(OWNER)).body.items.map((item) => item.sessionId)).toEqual([c.sessionId, b.sessionId]);
    const doc = await w.store.get(agentSessionKey(ORG, b.sessionId, "META"));
    await w.store.put({ item: { ...doc!, endedAt: "2026-11-09T11:00:00.000Z" } });
    expect((await w.list(OWNER)).body.items.map((item) => item.sessionId)).toEqual([c.sessionId]);
  });

  it("hides an email address in the title from a reader who is not the owner", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1, { title: "Fix login for dana@example.com" });
    await w.rowFor(DANA_ID, sessionId, "needs_you", NOW - 1000);
    w.m.grant(DANA_ID, "web");
    const title = (await w.list(DANA)).body.items[0]?.title;
    expect(title).not.toContain("dana@example.com");
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 1000);
    expect((await w.list(OWNER)).body.items[0]?.title).toContain("dana@example.com");
  });

  it("is two-company safe: the company is the caller's membership, rows of another company are never read or shown", async () => {
    const w = await world();
    const mine = await addSession(w.store, 1, { title: "Company A task" });
    await w.rowFor(DANA_ID, mine.sessionId, "needs_you", NOW - 1000);
    w.m.grant(DANA_ID, "web");
    expect((await w.list(DANA)).body.items).toHaveLength(1);
    // The same person asking as a member of company B (same store) sees nothing of company A.
    w.m.join(OTHER_ORG, DANA_ID);
    const asB = await w.list(person("dana", OTHER_ORG), "", OTHER_ORG);
    expect(asB.body).toEqual({ items: [], unread: 0 });
    // A principal of one company asking company B's routes is refused outright, with fixed words.
    const crossed = await w.list(DANA, "", OTHER_ORG);
    expect(crossed.status).toBe(401);
    // A company B row for the person that names company A's session is hidden (a session of another company reads as absent), and a row copied into the person's partition with another company or person is ignored.
    await w.rowFor(DANA_ID, mine.sessionId, "needs_you", NOW - 1000, OTHER_ORG);
    expect((await w.list(person("dana", OTHER_ORG), "", OTHER_ORG)).body.items).toEqual([]);
    // Rows copied into the person's partition that name another person or another company are ignored, even for a session the person may read.
    const s3 = await addSession(w.store, 3, { title: "Readable" });
    const s4 = await addSession(w.store, 4, { title: "Readable too" });
    await w.store.put({ item: { ...inboxRow({ orgId: ORG, developerId: ERIN_ID, sessionId: s3.sessionId, kind: "needs_you", at: new Date(NOW).toISOString(), nowMs: NOW }), ...inboxKey(ORG, DANA_ID, s3.sessionId, "needs_you") } });
    await w.store.put({ item: { ...inboxRow({ orgId: OTHER_ORG, developerId: DANA_ID, sessionId: s4.sessionId, kind: "needs_you", at: new Date(NOW).toISOString(), nowMs: NOW }), ...inboxKey(ORG, DANA_ID, s4.sessionId, "needs_you") } });
    expect((await w.list(DANA)).body.items).toHaveLength(1);
    // B's own session, and its own rows for B's person.
    const theirs = await addSession(w.store, 2, { orgId: OTHER_ORG, title: "Company B task", owner: person("dana", OTHER_ORG) });
    await w.rowFor(DANA_ID, theirs.sessionId, "needs_you", NOW - 500, OTHER_ORG);
    expect((await w.list(person("dana", OTHER_ORG), "", OTHER_ORG)).body.items.map((item) => item.title)).toEqual(["Company B task"]);
    expect((await w.list(DANA)).body.items.map((item) => item.title)).toEqual(["Company A task"]);
    expect(inboxPartition(ORG, DANA_ID)).not.toBe(inboxPartition(OTHER_ORG, DANA_ID));
  });

  it("reads every row before choosing the newest: more than 300 rows never push the newest one out", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1, { title: "Newest" });
    // Rows whose sort keys come first (ses_00000000...), all older; the real session's id sorts after them.
    for (let n = 0; n < 350; n += 1) await w.rowFor(OWNER_ID, `ses_00000000${String(n).padStart(12, "0")}`, "needs_you", NOW - 10_000 - n);
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 1);
    const page = await w.list(OWNER);
    expect(page.body.items.map((item) => item.title)).toEqual(["Newest"]);
    expect(page.body.unread).toBe(1);
  });

  it("answers a person who can read none of their rows exactly like a person with no rows, even with more rows than one request checks (no cursor, no count, no hint)", async () => {
    const w = await world();
    for (let n = 0; n < 130; n += 1) await w.rowFor(DANA_ID, `ses_11111111${String(n).padStart(12, "0")}`, "needs_you", NOW - n);
    const hidden = await w.list(DANA);
    const empty = await w.list(ERIN);
    expect(hidden).toEqual(empty);
    expect(hidden.body).toEqual({ items: [], unread: 0 });
    const later = await w.list(DANA, `?cursor=${Buffer.from(JSON.stringify([NOW - 60, `ses_11111111${"0".repeat(12)}#needs_you`]), "utf8").toString("base64url")}`);
    expect(later.body).toEqual({ items: [] });
  });

  it("keeps checking a long run of hidden rows only up to the budget, then shows what it found (a visible row inside the budget is shown past hidden ones)", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1, { title: "Visible" });
    for (let n = 0; n < 40; n += 1) await w.rowFor(OWNER_ID, `ses_22222222${String(n).padStart(12, "0")}`, "needs_you", NOW - 1000 - n);
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 100_000);
    const page = await w.list(OWNER);
    expect(page.body.items.map((item) => item.title)).toEqual(["Visible"]);
    expect(page.body.nextCursor).toBeUndefined();
  });

  it("reads a chain-session row, a throwing members seam and a throwing store as nothing", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1);
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 1000);
    const doc = await w.store.get(agentSessionKey(ORG, sessionId, "META"));
    await w.store.put({ item: { ...doc!, kind: "chain", subject: { kind: "chain", chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa" } } });
    expect((await w.list(OWNER)).body).toEqual({ items: [], unread: 0 });
    const other = await addSession(w.store, 2);
    await w.rowFor(OWNER_ID, other.sessionId, "needs_you", NOW - 500);
    const roles = new Map(w.m.roles);
    w.m.roles.clear();
    w.m.throwing.value = true;
    expect((await w.list(OWNER)).body).toEqual({ items: [], unread: 0 });
    w.m.throwing.value = false;
    for (const [key, role] of roles) w.m.roles.set(key, role);
    expect((await w.list(OWNER)).body.items).toHaveLength(1);
  });

  it("expired rows are not shown, and a method other than GET is not this route's", async () => {
    const w = await world();
    const { sessionId } = await addSession(w.store, 1);
    await w.rowFor(OWNER_ID, sessionId, "needs_you", NOW - 1000);
    const noExpiry = inboxRow({ orgId: ORG, developerId: OWNER_ID, sessionId: (await addSession(w.store, 2)).sessionId, kind: "needs_you", at: new Date(NOW).toISOString(), nowMs: NOW }) as Record<string, unknown>;
    delete noExpiry["expiresAtSec"];
    await w.store.put({ item: noExpiry as never });
    expect((await w.list(OWNER)).body.items).toHaveLength(1);
    w.clock.ms = NOW + 15 * 86_400_000;
    expect((await w.list(OWNER)).body.items).toEqual([]);
    expect((await w.call(OWNER, "DELETE", "/v1/app/inbox")).status).toBe(0);
    expect((await w.call(OWNER, "GET", "/v1/app/inbox/read")).status).toBe(0);
    expect((await w.call(OWNER, "POST", "/v1/app/inbox")).status).toBe(0);
  });
});

describe("POST /v1/app/inbox/read", () => {
  it("marks the caller's own rows read, once per id, and the page and the count show it", async () => {
    const w = await world();
    const a = await addSession(w.store, 1);
    const b = await addSession(w.store, 2);
    await w.rowFor(OWNER_ID, a.sessionId, "needs_you", NOW - 2000);
    await w.rowFor(OWNER_ID, b.sessionId, "needs_you", NOW - 1000);
    const before = await w.list(OWNER);
    expect(before.body.unread).toBe(2);
    const id = before.body.items[0]?.id;
    const marked = await w.mark(OWNER, [id, id]);
    expect(marked).toEqual({ status: 200, body: { marked: 1 } });
    const after = await w.list(OWNER);
    expect(after.body.items.map((item) => item.read)).toEqual([true, false]);
    expect(after.body.unread).toBe(1);
  });

  it("marks nothing of anyone else's: the same id from another person finds no row of theirs, and the owner's row stays unread", async () => {
    const w = await world();
    const a = await addSession(w.store, 1);
    await w.rowFor(OWNER_ID, a.sessionId, "needs_you", NOW - 1000);
    const id = inboxIdOf({ sessionId: a.sessionId, kind: "needs_you", atMs: NOW - 1000 });
    expect(await w.mark(DANA, [id])).toEqual({ status: 200, body: { marked: 0 } });
    expect(await w.mark(ERIN, [id])).toEqual({ status: 200, body: { marked: 0 } });
    expect((await w.list(OWNER)).body.items[0]?.read).toBe(false);
    // No row is created for the person who marked nothing.
    expect((await w.store.query({ pk: inboxPartition(ORG, DANA_ID) })).items).toEqual([]);
    // Another company's route marks nothing either (the partition is the company's).
    w.m.join(OTHER_ORG, OWNER_ID, "owner");
    expect((await w.call(person(OWNER.personId, OTHER_ORG), "POST", "/v1/app/inbox/read", { requestId: randomUUID(), ids: [id] }, OTHER_ORG)).body).toEqual({ marked: 0 });
    expect((await w.list(OWNER)).body.items[0]?.read).toBe(false);
  });

  it("does not mark a row that changed since it was shown (the id names the time)", async () => {
    const w = await world();
    const a = await addSession(w.store, 1);
    await w.rowFor(OWNER_ID, a.sessionId, "needs_you", NOW - 5000);
    const shown = (await w.list(OWNER)).body.items[0]?.id;
    await w.rowFor(OWNER_ID, a.sessionId, "needs_you", NOW - 1000);
    expect((await w.mark(OWNER, [shown])).body).toEqual({ marked: 0 });
    expect((await w.list(OWNER)).body.items[0]?.read).toBe(false);
  });

  it("refuses a body that is not exactly { requestId, ids } with fixed words that echo nothing, and marks nothing of a batch with a bad id", async () => {
    const w = await world();
    const a = await addSession(w.store, 1);
    await w.rowFor(OWNER_ID, a.sessionId, "needs_you", NOW - 1000);
    const good = inboxIdOf({ sessionId: a.sessionId, kind: "needs_you", atMs: NOW - 1000 });
    const canary = "canary-secret-value";
    const badBodies: unknown[] = [
      { ids: [good] }, { requestId: "not-a-uuid", ids: [good] }, { requestId: randomUUID() }, { requestId: randomUUID(), ids: "x" }, { requestId: randomUUID(), ids: [good], companyId: ORG }, { requestId: randomUUID(), ids: [good], personId: canary },
      { requestId: randomUUID(), ids: [] }, { requestId: randomUUID(), ids: Array.from({ length: INBOX_READ_IDS_MAX + 1 }, () => good) }, { requestId: randomUUID(), ids: [good, 5] }, { requestId: randomUUID(), ids: [good, `ses_${canary}.needs_you.1`] },
      { requestId: randomUUID(), ids: [good, `${a.sessionId}.bogus.1`] }, { requestId: randomUUID(), ids: [good, `${a.sessionId}.needs_you.-1`] }, { requestId: randomUUID(), ids: [good, `${a.sessionId}.needs_you.99999999999999999999`] }, [good], "x", null,
    ];
    for (const body of badBodies) {
      const refused = await w.call(OWNER, "POST", "/v1/app/inbox/read", body);
      expect(refused.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain(canary);
      expect(["That request is not valid.", "Send { requestId, ids } with 1 to 50 inbox ids."]).toContain(refused.body.error.message);
    }
    const notJson = await w.routeFor()({ method: "POST", path: "/v1/app/inbox/read", headers: {}, body: "{nope" }, { principal: OWNER }).catch((error: unknown) => error);
    expect(notJson).toBeInstanceOf(AgentXError);
    expect((await w.list(OWNER)).body.items[0]?.read).toBe(false);
  });

  it("parses ids strictly", () => {
    const id = `ses_${"a".repeat(20)}.ready.1700000000000`;
    expect(parseInboxId(id)).toEqual({ sessionId: `ses_${"a".repeat(20)}`, kind: "ready", atMs: 1_700_000_000_000 });
    for (const bad of [`${id}x`, `ses_short.ready.1`, `ses_${"a".repeat(20)}.nope.1`, `ses_${"A".repeat(20)}.ready.1`, 5, undefined, `ses_${"a".repeat(20)}.ready.`, ` ${id}`]) expect(parseInboxId(bad), String(bad)).toBeUndefined();
  });
});

describe("on the core host", () => {
  const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
  const wired = (members: SessionMembers): CoreDevWiring => ({ origin: () => "https://api.example", members });
  async function host(env: NodeJS.ProcessEnv = { ROVARA_CORE_ENGINE: "on" }) {
    const fake = createFakeWorld();
    const app = createCoreHostApp({
      env, modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
    });
    const member = new Map<string, CompanyMembership>();
    const callerOf = (companyId: string, personId?: string): DeployedCaller => {
      const principal = { ...localOwnerPrincipal({ companyId }), ...(personId === undefined ? {} : { personId }) };
      member.set(principal.personId + companyId, { companyId, role: "owner" });
      return { principal, client: "web-app" };
    };
    return { fake, app, callerOf, companyOf: async (caller: DeployedCaller) => member.get(caller.principal.personId + caller.principal.companyId) };
  }
  const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
  const post = (path: string, body: unknown) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });

  it("serves the list and the read mark for a member, with the scope rows the developer API needs", async () => {
    const h = await host();
    const m = membersOf();
    const caller = h.callerOf(FAKE_COMPANY);
    const owner = developerIdOf(caller.principal);
    m.join(FAKE_COMPANY, owner, "owner");
    const routes = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => wired(m.members) });
    const { sessionId } = await addSession(h.fake.store as never, 1, { orgId: FAKE_COMPANY, owner: caller.principal });
    await h.fake.store.put({ item: inboxRow({ orgId: FAKE_COMPANY, developerId: owner, sessionId, kind: "needs_you", at: new Date(Date.now()).toISOString(), nowMs: Date.now() }) });
    const listed = await routes.route(get("/v1/app/inbox"), caller);
    expect(listed?.statusCode).toBe(200);
    const body = JSON.parse(listed!.body) as { items: Array<{ id: string; link: string }>; unread: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.link).toBe(`https://api.example/app/sessions/${sessionId}`);
    expect(listed!.headers["cache-control"]).toBe("no-store");
    const marked = await routes.route(post("/v1/app/inbox/read", { requestId: randomUUID(), ids: [body.items[0]!.id] }), caller);
    expect(JSON.parse(marked!.body)).toEqual({ marked: 1 });
    expect(appRouteOf("GET", "/v1/app/inbox")).toMatchObject({ requires: "tasks:read" });
    expect(appRouteOf("POST", "/v1/app/inbox/read")).toMatchObject({ requires: "tasks:read" });
    expect(appRouteOf("DELETE", "/v1/app/inbox")).toBeUndefined();
  });

  it("is served by the core only: off answers nothing, an unwired host says 'not on the core yet', and a script token never reaches it", async () => {
    const h = await host();
    const m = membersOf();
    const caller = h.callerOf(FAKE_COMPANY);
    const spy = vi.spyOn(h.fake.store, "get");
    const off = createCoreDevRoutes({ app: (await host({})).app, companyOf: h.companyOf, wiring: () => wired(m.members) });
    expect(await off.route(get("/v1/app/inbox"), caller)).toBeUndefined();
    expect(await off.route(post("/v1/app/inbox/read", { requestId: randomUUID(), ids: [] }), caller)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    const unwired = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => ({ origin: () => "https://api.example" }) });
    const nope = await unwired.route(get("/v1/app/inbox"), caller);
    expect(nope?.statusCode).toBe(404);
    expect((JSON.parse(nope!.body) as { error: { message: string } }).error.message).toBe(NOT_ON_THE_CORE_YET);
    const routes = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => wired(m.members) });
    for (const request of [get("/v1/app/inbox"), post("/v1/app/inbox/read", { requestId: randomUUID(), ids: [] })]) {
      const refused = await routes.route(request, { ...caller, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
      expect(refused?.statusCode).toBe(403);
      expect((JSON.parse(refused!.body) as { error: { message: string } }).error.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    }
    // Another method on these paths is the old broker's (nothing here).
    expect(await routes.route({ method: "PUT", path: "/v1/app/inbox", headers: {}, body: "" }, caller)).toBeUndefined();
  });
});
