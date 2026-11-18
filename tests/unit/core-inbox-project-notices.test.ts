// L4-U5b: the project notices in a person's own inbox. "Setup needs repair" and "Nightly upkeep is paused" are about a PROJECT, and the admins who must act are told through the attention queue (chat, email). An admin with
// neither still finds them here: the writers (`queueSetupBroken`, `queueUpkeepPaused`) keep one inbox row per person they queue, and `GET /v1/app/inbox/project-notices` lists them, each checked again now against the
// project (the person still administers it; a setup notice only while the setup is still broken). What each test would catch if the code were changed is listed in the PR body (mutants).
import { describe, expect, it, vi } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID, UPKEEP_NOTICE_WORDS, upkeepSubjectId, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { INBOX_KEEP_SECONDS, deliverAttention, eraseInboxRows, inboxKey, inboxPartition, listProjectNotices, projectNoticeKey, queueSetupBroken, queueUpkeepPaused, type ProjectNoticeDeps } from "../../packages/broker/src/core/notify/index.js";
import { createHash } from "node:crypto";
import { createInboxRoutes } from "../../packages/broker/src/core-host/inbox-routes.js";
import { setupAdminNoticeWords } from "../../packages/broker/src/core/setup-agent/recheck-rows.js";
import { setupBrokenSubjectId } from "../../packages/broker/src/core/setup-agent/broken-notice.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";
import { appRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER_ORG = "org_inboxother0000000001" as OrgId;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
// The hosted convention: the person is a 64-hex person id (the membership's), and the principal's personId IS that id (aws/core-engine-root.ts deployedCallerFromMembership). The session inbox's hashed developer id is
// a different thing, and the project notices must not be keyed by it.
const personOf = (name: string): string => createHash("sha256").update(`person\0${name}`).digest("hex");
const ADMIN = personOf("admin");
const ADMIN_TWO = personOf("admin-two");
const MEMBER = personOf("member");
const STRANGER = personOf("stranger");
const principalOf = (personId: string, companyId: OrgId = ORG) => ({ companyId, personId, displayName: "x", roles: ["member"], provider: "rovara-sign-in" }) as const;
const BREAK_ID = "ab12cd34ef56".repeat(4);
const FAILED_STEP = "setup: npm ci - exit 1";

const members: SessionMembers = { companyRole: () => "member", projectGrant: () => undefined };

interface World {
  store: MemoryDocumentStore;
  admins: Map<string, Set<string>>;
  broken: { value: { key: string; failedStep: string; fixReady: boolean } | undefined };
  clock: { ms: number };
  get(person: string, path?: string, org?: OrgId): Promise<{ status: number; body: { items: Array<{ id: string; kind: string; project: string; status: string; at: string }> } }>;
}

function world(): World {
  const store = new MemoryDocumentStore();
  const admins = new Map<string, Set<string>>();
  const broken: World["broken"] = { value: { key: BREAK_ID, failedStep: FAILED_STEP, fixReady: false } };
  const clock = { ms: NOW };
  const projectNotices: Pick<ProjectNoticeDeps, "administers" | "setupRead"> = {
    administers: async (org, person, project) => org === ORG && admins.get(project)?.has(person) === true,
    setupRead: async (org, project) => (org === ORG && project === "payments" ? broken.value : undefined),
  };
  const routeFor = (org: OrgId) => createInboxRoutes({ store, companyId: org, origin: () => "https://app.example", members, now: () => clock.ms, projectNotices });
  return {
    store, admins, broken, clock,
    async get(person, path = "/v1/app/inbox/project-notices", org = ORG) {
      try {
        const answer = await routeFor(org)({ method: "GET", path, headers: {} }, { principal: principalOf(person, org) });
        return { status: answer?.statusCode ?? 0, body: answer === undefined ? (undefined as never) : (JSON.parse(answer.body) as { items: Array<{ id: string; kind: string; project: string; status: string; at: string }> }) };
      } catch (error) {
        if (error instanceof AgentXError) return { status: error.statusCode, body: { error: error.code } as never };
        throw error;
      }
    },
  };
}

/** The people the writers queue: the project's admins. */
const recipientsOf = (people: string[]) => async () => people;
const tell = (w: World, input: { project?: string; recheckKey?: string; people?: string[]; orgId?: OrgId } = {}) =>
  queueSetupBroken({ store: w.store, now: () => new Date(w.clock.ms), recipients: recipientsOf(input.people ?? [ADMIN]) }, { orgId: input.orgId ?? ORG, project: input.project ?? "payments", recheckKey: input.recheckKey ?? BREAK_ID });

describe("what the two project notices write for the inbox", () => {
  it("setup_broken: one inbox row per queued person, in the person's own partition, beside the pending row, with the queue's expiry", async () => {
    const w = world();
    const answer = await tell(w, { people: [ADMIN, ADMIN_TWO] });
    expect(answer).toEqual({ queued: 2, deduped: false });
    const subjectId = setupBrokenSubjectId({ project: "payments", recheckKey: BREAK_ID });
    for (const person of [ADMIN, ADMIN_TWO]) {
      const row = await w.store.get(projectNoticeKey(ORG, person, subjectId, "setup_broken"));
      expect(row).toMatchObject({ entityType: "NOTIFY_INBOX_PROJECT", orgId: ORG, developerId: person, subjectId, kind: "setup_broken", pk: inboxPartition(ORG, person) });
      expect(row!["expiresAtSec"]).toBe(Math.floor(NOW / 1000) + INBOX_KEEP_SECONDS);
      expect(row!["indexExpiresAt"]).toBe(Math.floor(NOW / 1000) + INBOX_KEEP_SECONDS);
    }
    expect((await w.store.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(2);
  });

  it("upkeep_paused: the same, one row per person", async () => {
    const w = world();
    const answer = await queueUpkeepPaused({ store: w.store, now: () => new Date(NOW), recipients: recipientsOf([ADMIN]) }, { orgId: ORG, project: "payments", reason: "monthly_limit" });
    expect(answer).toEqual({ queued: 1, deduped: false });
    const subjectId = upkeepSubjectId({ project: "payments", month: "2026-11", reason: "monthly_limit" });
    expect(await w.store.get(projectNoticeKey(ORG, ADMIN, subjectId, "upkeep_paused"))).toMatchObject({ entityType: "NOTIFY_INBOX_PROJECT", kind: "upkeep_paused", subjectId });
  });

  it("a second reader of the same break writes no second row (the marker holds), and nobody-to-tell leaves no row at all", async () => {
    const w = world();
    expect(await tell(w)).toEqual({ queued: 1, deduped: false });
    expect(await tell(w)).toEqual({ queued: 0, deduped: true });
    expect((await w.store.query({ pk: inboxPartition(ORG, ADMIN) })).items).toHaveLength(1);
    const empty = world();
    expect(await tell(empty, { people: [] })).toEqual({ queued: 0, deduped: false });
    expect((await empty.store.query({ pk: inboxPartition(ORG, ADMIN) })).items).toHaveLength(0);
  });

  it("the rows and the pending rows are written together or not at all (a transaction that fails leaves neither, and gives the marker back)", async () => {
    const w = world();
    vi.spyOn(w.store, "transact").mockResolvedValueOnce({ applied: false } as never);
    expect(await tell(w)).toEqual({ queued: 0, deduped: false });
    expect((await w.store.query({ pk: inboxPartition(ORG, ADMIN) })).items).toHaveLength(0);
    // The marker was given back: a later read tries again and now writes both.
    expect(await tell(w)).toEqual({ queued: 1, deduped: false });
    expect((await w.store.query({ pk: inboxPartition(ORG, ADMIN) })).items).toHaveLength(1);
  });

  it("the inbox row stays after the chat message went (the pending row is delivered and dropped, the inbox row is the person's until it expires)", async () => {
    const w = world();
    await tell(w);
    await deliverAttention({ store: w.store, registry: createAdapterRegistry(), now: () => NOW + 3_600_000, log: () => undefined, upkeep: { administers: async () => true, setupRead: async () => w.broken.value } });
    expect((await w.store.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(0);
    w.admins.set("payments", new Set([ADMIN]));
    expect((await w.get(ADMIN)).body.items).toHaveLength(1);
  });
});

describe("GET /v1/app/inbox/project-notices", () => {
  it("an admin with no chat and no email sees the setup notice, in fixed words, with the project's name", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    await tell(w);
    const answer = await w.get(ADMIN);
    expect(answer.status).toBe(200);
    expect(answer.body.items).toEqual([{ id: `setup_broken.${String(NOW)}.payments`, kind: "setup_broken", project: "payments", status: setupAdminNoticeWords(FAILED_STEP, false), at: new Date(NOW).toISOString() }]);
  });

  it("an admin sees the upkeep notice with its fixed words (no row of a reason is shown in another reason's words)", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    for (const reason of ["no_budget", "monthly_limit", "cost_too_high"] as const) {
      await queueUpkeepPaused({ store: w.store, now: () => new Date(NOW), recipients: recipientsOf([ADMIN]) }, { orgId: ORG, project: "payments", reason });
    }
    const answer = await w.get(ADMIN);
    expect(answer.body.items.map((item) => item.status).sort()).toEqual([UPKEEP_NOTICE_WORDS.no_budget, UPKEEP_NOTICE_WORDS.monthly_limit, UPKEEP_NOTICE_WORDS.cost_too_high].sort());
    expect(answer.body.items.every((item) => item.kind === "upkeep_paused" && item.project === "payments")).toBe(true);
  });

  it("a person who is not an admin of the project reads nothing, even with a row of their own (a row alone is not enough)", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    await tell(w, { people: [ADMIN, MEMBER] });
    expect((await w.get(MEMBER)).body).toEqual({ items: [] });
    expect((await w.get(ADMIN)).body.items).toHaveLength(1);
  });

  it("an admin who stopped administering the project reads nothing at the next read (live, not remembered)", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    await tell(w);
    expect((await w.get(ADMIN)).body.items).toHaveLength(1);
    w.admins.get("payments")!.delete(ADMIN);
    expect((await w.get(ADMIN)).body).toEqual({ items: [] });
  });

  it("a setup notice for a break that is fixed is not shown; one for ANOTHER break (another re-check key) is not shown either", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    await tell(w);
    w.broken.value = undefined;
    expect((await w.get(ADMIN)).body).toEqual({ items: [] });
    w.broken.value = { key: `ff${BREAK_ID.slice(2)}`, failedStep: FAILED_STEP, fixReady: false };
    expect((await w.get(ADMIN)).body).toEqual({ items: [] });
    w.broken.value = { key: BREAK_ID, failedStep: FAILED_STEP, fixReady: true };
    expect((await w.get(ADMIN)).body.items[0]!.status).toBe(setupAdminNoticeWords(FAILED_STEP, true));
  });

  it("an upkeep notice needs only the live admin standing (the pause is the month's, not the project's repair)", async () => {
    const w = world();
    await queueUpkeepPaused({ store: w.store, now: () => new Date(NOW), recipients: recipientsOf([ADMIN]) }, { orgId: ORG, project: "other-project", reason: "no_budget" });
    expect((await w.get(ADMIN)).body).toEqual({ items: [] });
    w.admins.set("other-project", new Set([ADMIN]));
    expect((await w.get(ADMIN)).body.items).toHaveLength(1);
  });

  it("a person reads only their own rows: another admin's row is theirs alone", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN, ADMIN_TWO, STRANGER]));
    await tell(w, { people: [ADMIN] });
    expect((await w.get(ADMIN_TWO)).body).toEqual({ items: [] });
    expect((await w.get(STRANGER)).body).toEqual({ items: [] });
  });

  it("two companies: a row written under company A is never read through company B, nor by B's people, and B's project of the same name has its own", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    await tell(w);
    const other = await w.get(ADMIN, "/v1/app/inbox/project-notices", OTHER_ORG);
    expect(other.body).toEqual({ items: [] });
    // A forged row in company B's partition that claims company A's data (its own orgId says A) is not B's.
    await w.store.put({ item: { ...projectNoticeKey(OTHER_ORG, ADMIN, setupBrokenSubjectId({ project: "payments", recheckKey: BREAK_ID }), "setup_broken"), entityType: "NOTIFY_INBOX_PROJECT", orgId: ORG, developerId: ADMIN, subjectId: setupBrokenSubjectId({ project: "payments", recheckKey: BREAK_ID }), kind: "setup_broken", at: new Date(NOW).toISOString(), atMs: NOW, expiresAtSec: Math.floor(NOW / 1000) + 1000 } });
    expect((await w.get(ADMIN, "/v1/app/inbox/project-notices", OTHER_ORG)).body).toEqual({ items: [] });
    expect((await w.get(ADMIN)).body.items).toHaveLength(1);
  });

  it("expired rows, rows at the wrong key, rows of another kind and rows with a foreign subject read as nothing", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    const subjectId = setupBrokenSubjectId({ project: "payments", recheckKey: BREAK_ID });
    const base = { entityType: "NOTIFY_INBOX_PROJECT", orgId: ORG, developerId: ADMIN, subjectId, kind: "setup_broken", at: new Date(NOW).toISOString(), atMs: NOW };
    await w.store.put({ item: { ...projectNoticeKey(ORG, ADMIN, subjectId, "setup_broken"), ...base, expiresAtSec: Math.floor(NOW / 1000) - 1 } });
    await w.store.put({ item: { pk: inboxPartition(ORG, ADMIN), sk: `PROJECT#elsewhere#setup_broken`, ...base, expiresAtSec: Math.floor(NOW / 1000) + 100 } });
    await w.store.put({ item: { ...projectNoticeKey(ORG, ADMIN, "not-a-subject", "setup_broken"), ...base, subjectId: "not-a-subject", expiresAtSec: Math.floor(NOW / 1000) + 100 } });
    await w.store.put({ item: { ...projectNoticeKey(ORG, ADMIN, subjectId, "needs_you" as never), ...base, kind: "needs_you", expiresAtSec: Math.floor(NOW / 1000) + 100 } });
    expect((await w.get(ADMIN)).body).toEqual({ items: [] });
  });

  it("a row naming another company or another person is dropped even where it sits in this person's own partition and the person administers the project", async () => {
    const store = new MemoryDocumentStore();
    const subjectId = setupBrokenSubjectId({ project: "payments", recheckKey: BREAK_ID });
    const deps: ProjectNoticeDeps = { store, now: () => NOW, administers: async () => true, setupRead: async () => ({ key: BREAK_ID, failedStep: FAILED_STEP, fixReady: false }) };
    const base = { ...projectNoticeKey(ORG, ADMIN, subjectId, "setup_broken"), entityType: "NOTIFY_INBOX_PROJECT", subjectId, kind: "setup_broken", at: new Date(NOW).toISOString(), atMs: NOW, expiresAtSec: Math.floor(NOW / 1000) + 1000 };
    await store.put({ item: { ...base, orgId: OTHER_ORG, developerId: ADMIN } });
    expect((await listProjectNotices(deps, { companyId: ORG, developerId: ADMIN })).items).toEqual([]);
    await store.put({ item: { ...base, orgId: ORG, developerId: ADMIN_TWO } });
    expect((await listProjectNotices(deps, { companyId: ORG, developerId: ADMIN })).items).toEqual([]);
    // Positive control: the same row naming this company and person is shown.
    await store.put({ item: { ...base, orgId: ORG, developerId: ADMIN } });
    expect((await listProjectNotices(deps, { companyId: ORG, developerId: ADMIN })).items).toHaveLength(1);
    // And one past its expiry is not.
    await store.put({ item: { ...base, orgId: ORG, developerId: ADMIN, expiresAtSec: Math.floor(NOW / 1000) } });
    expect((await listProjectNotices(deps, { companyId: ORG, developerId: ADMIN })).items).toEqual([]);
  });

  it("a read of the person's standing that fails shows nothing (never a guess), and one failing project does not hide another", async () => {
    const w = world();
    const calls: string[] = [];
    const routes = createInboxRoutes({
      store: w.store, companyId: ORG, origin: () => "https://app.example", members, now: () => NOW,
      projectNotices: { administers: async (_org, _person, project) => { calls.push(project); if (project === "broken-read") throw new Error("down"); return true; }, setupRead: async () => ({ key: BREAK_ID, failedStep: FAILED_STEP, fixReady: false }) },
    });
    await tell(w, { project: "broken-read" });
    await tell(w, { project: "payments" });
    const answer = await routes({ method: "GET", path: "/v1/app/inbox/project-notices", headers: {} }, { principal: principalOf(ADMIN) });
    const items = (JSON.parse(answer!.body) as { items: Array<{ project: string }> }).items;
    expect(calls.sort()).toEqual(["broken-read", "payments"]);
    expect(items.map((item) => item.project)).toEqual(["payments"]);
  });

  it("with no wiring the route lists nothing; a query string or another method is refused or not served", async () => {
    const w = world();
    const unwired = createInboxRoutes({ store: w.store, companyId: ORG, origin: () => "https://app.example", members, now: () => NOW });
    const caller = { principal: principalOf(ADMIN) };
    const answer = await unwired({ method: "GET", path: "/v1/app/inbox/project-notices", headers: {} }, caller);
    expect(JSON.parse(answer!.body)).toEqual({ items: [] });
    await expect(unwired({ method: "GET", path: "/v1/app/inbox/project-notices?limit=5", headers: {} }, caller)).rejects.toThrow();
    expect(await unwired({ method: "POST", path: "/v1/app/inbox/project-notices", headers: {}, body: "{}" }, caller)).toBeUndefined();
    expect(appRouteOf("GET", "/v1/app/inbox/project-notices")).toMatchObject({ requires: "full" });
  });

  it("a principal of another company is refused by the mounted company's route (the company is the live membership's)", async () => {
    const w = world();
    const mounted = createInboxRoutes({ store: w.store, companyId: ORG, origin: () => "https://app.example", members, now: () => NOW, projectNotices: { administers: async () => true } });
    const answer = await mounted({ method: "GET", path: "/v1/app/inbox/project-notices", headers: {} }, { principal: principalOf(ADMIN, OTHER_ORG) });
    expect(answer?.statusCode).toBe(401);
  });
});

describe("the session inbox and the person erase", () => {
  it("the session inbox never lists a project notice (no row of it is read as a task's), and its list is unchanged", async () => {
    const w = world();
    w.admins.set("payments", new Set([ADMIN]));
    await tell(w);
    const sessions = await w.get(ADMIN, "/v1/app/inbox");
    expect(sessions.status).toBe(200);
    expect((sessions.body as unknown as { items: unknown[] }).items).toEqual([]);
  });

  it("a person erase removes their project notices with the rest of their inbox", async () => {
    const w = world();
    await tell(w, { people: [ADMIN, ADMIN_TWO] });
    expect(await eraseInboxRows(w.store, ORG, ADMIN)).toBe(1);
    expect((await w.store.query({ pk: inboxPartition(ORG, ADMIN) })).items).toHaveLength(0);
    expect((await w.store.query({ pk: inboxPartition(ORG, ADMIN_TWO) })).items).toHaveLength(1);
  });

  it("the reader and the session inbox share a partition but not a row: a project row's key is never a session row's", () => {
    const subjectId = setupBrokenSubjectId({ project: "payments", recheckKey: BREAK_ID });
    expect(projectNoticeKey(ORG, ADMIN, subjectId, "setup_broken").sk.startsWith("PROJECT#")).toBe(true);
    expect(inboxKey(ORG, ADMIN, "ses_abcdefabcdefabcdefab", "needs_you").sk.startsWith("PROJECT#")).toBe(false);
  });

  it("listProjectNotices is bounded: more raw rows than the cap are not all read, and the checks are capped", async () => {
    const w = world();
    const checks: number[] = [];
    const deps: ProjectNoticeDeps = { store: w.store, now: () => NOW, administers: async () => { checks.push(1); return true; }, setupRead: async () => ({ key: BREAK_ID, failedStep: FAILED_STEP, fixReady: false }) };
    for (let n = 0; n < 80; n += 1) {
      const project = `proj${String(n)}`;
      const subjectId = setupBrokenSubjectId({ project, recheckKey: BREAK_ID });
      await w.store.put({ item: { ...projectNoticeKey(ORG, ADMIN, subjectId, "setup_broken"), entityType: "NOTIFY_INBOX_PROJECT", orgId: ORG, developerId: ADMIN, subjectId, kind: "setup_broken", at: new Date(NOW + n).toISOString(), atMs: NOW + n, expiresAtSec: Math.floor(NOW / 1000) + 1000 } });
    }
    const page = await listProjectNotices(deps, { companyId: ORG, developerId: ADMIN });
    expect(checks.length).toBe(50);
    expect(page.items).toHaveLength(50);
    // Newest first.
    expect(page.items[0]!.project).toBe("proj79");
  });
});
