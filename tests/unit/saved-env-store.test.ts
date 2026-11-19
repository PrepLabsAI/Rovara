// The saved environment registry's store on the document store. One row per project, written with its audit steps in ONE transaction, fenced by the row's version; deleted projects are found through the
// sparse due index until their registry deletion is final.
import { describe, expect, it } from "vitest";
import { WORKFLOW_DISPATCH_DUE_INDEX, orgPk, type AuditEvent, type AuditSink, type DocumentKey, type OrgId, type SavedEnvManifest, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { SAVED_ENV_JOB_LEASE_MS, type SavedEnvAuditEntry, type SavedEnvImageRecord, type SavedEnvState } from "../../packages/broker/src/core/test-env/saved-env.js";
import { SAVED_ENV_INDEXES, SAVED_ENV_PURGE_PARTITION, documentSavedEnvStore, savedEnvAuditEvent } from "../../packages/broker/src/core/test-env/saved-env-store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const AT = new Date(NOW).toISOString();
const DIGEST = `sha256:${"1".repeat(64)}`;
const LEASE_TOKEN = "lease-secret-token-0123456789abcdef";

/** An audit sink that stages one marker row per event in the caller's transaction, so a test sees both that it commits WITH the change and what it holds. */
function stagingSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    sink: {
      stage(event) {
        events.push(event);
        return [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: event.eventId, entityType: "AUDIT", action: event.action }, condition: { op: "notExists", path: ["pk"] } } satisfies TransactItem];
      },
      async record(event) { events.push(event); },
    },
  };
}

function bench(options: { noAudit?: boolean; now?: () => number } = {}) {
  const clock = { now: options.now ?? (() => NOW) };
  const db = new MemoryDocumentStore({ indexes: SAVED_ENV_INDEXES });
  const audit = stagingSink();
  const store = documentSavedEnvStore({ store: db, now: () => clock.now(), ...(options.noAudit === true ? {} : { audit: audit.sink }) });
  const get = async (key: DocumentKey) => (await db.get(key)) as Record<string, unknown> | undefined;
  const set = async (item: Record<string, unknown>) => { await db.put({ item: item as StoredDocument }); };
  return { db, audit, store, clock, get, set };
}
const manifest = (): SavedEnvManifest => ({ schemaVersion: 1, environmentKey: "c".repeat(64), testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: "f".repeat(40) }], proveReportDigest: "b".repeat(64), imageDigest: DIGEST, builtAt: AT });
const image = (): SavedEnvImageRecord => ({ approved: { revision: 4, digest: "a".repeat(64) }, digest: DIGEST, tag: "kcccc-1", manifest: manifest(), recordedAt: AT, status: "ready" });
const state = (changes: Partial<SavedEnvState> = {}): SavedEnvState => ({ orgId: ORG, projectId: "web", version: 1, enabled: true, images: [], health: "never_proved", ...changes });
const entry = (action: SavedEnvAuditEntry["action"] = "rebuild_queued", extra: Partial<SavedEnvAuditEntry> = {}): SavedEnvAuditEntry => ({ action, orgId: ORG, projectId: "web", at: AT, ...extra });


describe("the row", () => {
  it("writes the row and its audit event together and reads it back for its own company only", async () => {
    const { get, audit, store, db } = bench();
    const job = { jobId: "job1", leaseToken: LEASE_TOKEN, reason: "no_image" as const, approved: { revision: 4, digest: "a".repeat(64) }, commits: { svc: "f".repeat(40) }, expectedKey: "c".repeat(64), createdAt: AT, leaseUntil: new Date(NOW + SAVED_ENV_JOB_LEASE_MS).toISOString() };
    const first = state({ images: [image()], job });
    expect(await store.commit(first, null, entry("rebuild_queued", { reason: "no_image" }))).toBe(true);
    expect(await store.get(ORG, "web")).toEqual(first);
    expect(await store.get(OTHER, "web")).toBeUndefined();
    expect(await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })).toMatchObject({ version: 1, entityType: "SAVED_ENV" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ companyId: ORG, action: "saved_env.rebuild_queued", subject: { type: "project", id: "web" }, actor: { type: "system", id: "rovara" }, details: { cause: "no_image" } });
    // the audit holds fixed words and a digest: never the job's lease token
    expect(JSON.stringify(audit.events[0])).not.toContain(LEASE_TOKEN);
    // and it committed WITH the row (the sink's own step is in the store)
    expect((await db.query({ pk: `AUDIT#${ORG}` })).items).toHaveLength(1);
  });

  it("names the person who pressed Reset as the actor", async () => {
    const { audit, store } = bench();
    await store.commit(state({ resetRequested: true }), null, entry("reset_requested", { actor: "dev_1" }));
    expect(audit.events[0]).toMatchObject({ actor: { type: "person", id: "dev_1" }, action: "saved_env.reset_requested" });
  });

  it("changes a row only from the version the caller read: a stale, missing or skipped version writes nothing and no audit step", async () => {
    const { db, audit, store } = bench();
    await store.commit(state(), null, entry());
    const next = state({ version: 2, health: "healthy" });
    expect(await store.commit(next, 5, entry("build_recorded"))).toBe(false);
    expect(await store.commit({ ...next, version: 3 }, 1, entry("build_recorded"))).toBe(false);
    expect(await store.commit(state(), null, entry())).toBe(false);
    expect((await store.get(ORG, "web"))?.health).toBe("never_proved");
    expect((await db.query({ pk: `AUDIT#${ORG}` })).items).toHaveLength(1);
    expect(await store.commit(next, 1, entry("build_recorded"))).toBe(true);
    // two writers at the same version: the second loses
    expect(await store.commit({ ...next, version: 2, health: "needs_repair" }, 1, entry("build_failed"))).toBe(false);
    expect((await store.get(ORG, "web"))?.health).toBe("healthy");
    void audit;
  });

  it("refuses a write whose ids are not the entry's, or whose state does not parse, and writes nothing", async () => {
    const { get, store } = bench();
    expect(await store.commit(state(), null, { ...entry(), projectId: "other" })).toBe(false);
    expect(await store.commit(state(), null, { ...entry(), orgId: OTHER })).toBe(false);
    expect(await store.commit({ ...state(), health: "great" as never }, null, entry())).toBe(false);
    expect(await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })).toBeUndefined();
  });

  it("commits without an audit sink (Code's default sink writes nothing); an event that a sink records elsewhere is recorded after the write", async () => {
    const { get, store } = bench({ noAudit: true });
    expect(await store.commit(state(), null, entry())).toBe(true);
    await store.audit(entry("scan_started", { digest: DIGEST }));
    expect(await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })).toBeDefined();
    const recorded: AuditEvent[] = [];
    const elsewhere = documentSavedEnvStore({ store: new MemoryDocumentStore({ indexes: SAVED_ENV_INDEXES }), now: () => NOW, audit: { stage: () => [], record: async (event) => { recorded.push(event); } } });
    expect(await elsewhere.commit(state(), null, entry("rebuild_queued", { reason: "no_image" }))).toBe(true);
    expect(recorded.map((event) => event.action)).toEqual(["saved_env.rebuild_queued"]);
  });

  it("a sink that throws on record never undoes an audit-only entry's caller", async () => {
    const store = documentSavedEnvStore({ store: new MemoryDocumentStore({ indexes: SAVED_ENV_INDEXES }), now: () => NOW, audit: { stage: () => [], record: async () => { throw new Error("sink down"); } } });
    await expect(store.audit(entry("scan_started", { digest: DIGEST }))).resolves.toBeUndefined();
  });

  it("writes the dispatcher's hand-over of a lease as the row alone", async () => {
    const { audit, store } = bench();
    expect(await store.commit(state({ lastPushAt: AT }), null, entry("rebuild_queued", { reason: "dispatched" }))).toBe(true);
    expect(audit.events).toEqual([]);
  });

  it("audits a setting change with the person and the new value only", async () => {
    const { audit, store } = bench();
    await store.commit(state({ enabled: false }), null, entry("setting_changed", { enabled: false, actor: "dev_1" }));
    expect(audit.events[0]).toMatchObject({ action: "saved_env.setting_changed", subject: { type: "project", id: "web" }, actor: { type: "person", id: "dev_1" }, details: { enabled: false } });
  });

  it("writes activity as the row alone, with no audit event", async () => {
    const { audit, store } = bench();
    expect(await store.commit(state({ lastTaskAt: AT }), null, entry("activity", { reason: "task" }))).toBe(true);
    expect(audit.events).toEqual([]);
    expect((await store.get(ORG, "web"))?.lastTaskAt).toBe(AT);
  });

  it("records an audit entry that is not tied to the row alone, with its digest and count", async () => {
    const { audit, store } = bench();
    await store.audit(entry("images_deleted", { digest: DIGEST, count: 2, reason: "walk" }));
    expect(audit.events[0]).toMatchObject({ action: "saved_env.images_deleted", details: { digest: DIGEST, count: 2, cause: "walk" } });
  });

  it("gives the same entry the same event id, and a different change another", () => {
    const one = savedEnvAuditEvent(entry("build_recorded", { digest: DIGEST }), 3);
    expect(savedEnvAuditEvent(entry("build_recorded", { digest: DIGEST }), 3)?.eventId).toBe(one?.eventId);
    expect(savedEnvAuditEvent(entry("build_recorded", { digest: DIGEST }), 4)?.eventId).not.toBe(one?.eventId);
    expect(savedEnvAuditEvent(entry("activity"), 3)).toBeUndefined();
  });

  it("treats a stored row that does not read back as an error, never as no row", async () => {
    const { set, store } = bench();
    await set({ pk: orgPk(ORG), sk: "SAVED_ENV#web", entityType: "SAVED_ENV", orgId: ORG, projectId: "web", version: 1, enabled: "yes", images: [], health: "healthy" });
    await expect(store.get(ORG, "web")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("does not store undefined attributes, and a row with an unknown attribute does not read back", async () => {
    const { get, set, store } = bench();
    await store.commit(state({ job: undefined, lastFailure: undefined }), null, entry());
    expect(Object.keys((await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })) ?? {})).not.toContain("job");
    await set({ ...((await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })) as Record<string, unknown>), surprise: 1 });
    await expect(store.get(ORG, "web")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the poll", () => {
  const LATER = new Date(NOW + 60_000).toISOString();
  const EARLIER = new Date(NOW - 60_000).toISOString();

  it("lists live, enabled projects whose poll time has come, oldest first, and no other", async () => {
    const { store } = bench();
    await store.commit(state({ projectId: "late", nextPollAt: LATER }), null, entry("activity", { projectId: "late" }));
    await store.commit(state({ projectId: "due-b", nextPollAt: new Date(NOW - 1000).toISOString() }), null, entry("activity", { projectId: "due-b" }));
    await store.commit(state({ projectId: "due-a", nextPollAt: EARLIER }), null, entry("activity", { projectId: "due-a" }));
    await store.commit(state({ projectId: "never" }), null, entry("activity", { projectId: "never" }));
    await store.commit(state({ projectId: "archived", nextPollAt: EARLIER, archived: true }), null, entry("project_archived", { projectId: "archived" }));
    await store.commit(state({ projectId: "off", nextPollAt: EARLIER, enabled: false }), null, entry("setting_changed", { projectId: "off", enabled: false }));
    await store.commit(state({ projectId: "gone", nextPollAt: EARLIER, deleted: true, deletedAt: AT }), null, entry("project_deleted", { projectId: "gone" }));
    expect(await store.pollDue(10)).toEqual([{ orgId: ORG, projectId: "due-a" }, { orgId: ORG, projectId: "due-b" }]);
    expect(await store.pollDue(1)).toEqual([{ orgId: ORG, projectId: "due-a" }]);
  });

  it("checks the row itself, not the eventually consistent index", async () => {
    const { get, set, store } = bench();
    await store.commit(state({ nextPollAt: EARLIER }), null, entry("activity"));
    const live = (await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })) as Record<string, unknown>;
    // the index still lists the row, but it was turned off, archived, or its time moved on
    for (const change of [{ enabled: false }, { archived: true }, { nextPollAt: LATER }, { deleted: true }]) {
      await set({ ...live, ...change });
      expect(await store.pollDue(10), JSON.stringify(change)).toEqual([]);
    }
    await set(live);
    expect(await store.pollDue(10)).toEqual([{ orgId: ORG, projectId: "web" }]);
  });
});

describe("the poll's pages", () => {
  it("reads past rows that are no longer eligible, so they cannot starve an eligible one behind them", async () => {
    const { get, set, store } = bench();
    const early = (index: number) => new Date(NOW - 3_600_000 + index).toISOString();
    // 450 rows listed first whose time has come but which were turned off meanwhile (the index still lists them), then one that is due
    for (let index = 0; index < 450; index += 1) {
      const projectId = `p${String(index).padStart(4, "0")}`;
      await store.commit(state({ projectId, nextPollAt: early(index) }), null, entry("activity", { projectId }));
      await set({ ...((await get({ pk: orgPk(ORG), sk: `SAVED_ENV#${projectId}` })) as Record<string, unknown>), enabled: false });
    }
    await store.commit(state({ projectId: "late-but-due", nextPollAt: new Date(NOW - 1000).toISOString() }), null, entry("activity", { projectId: "late-but-due" }));
    expect(await store.pollDue(1)).toEqual([{ orgId: ORG, projectId: "late-but-due" }]);
  });
});

describe("deleted projects", () => {
  const deleted = (changes: Partial<SavedEnvState> = {}): SavedEnvState => state({ deleted: true, deletedAt: AT, ...changes });

  it("lists a deleted project until its registry deletion is final, and only through the due index", async () => {
    const { get, store } = bench();
    await store.commit(state({ projectId: "alive" }), null, entry("rebuild_queued", { projectId: "alive" }));
    await store.commit(deleted(), null, entry("project_deleted"));
    expect((await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" }))).toMatchObject({ [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: SAVED_ENV_PURGE_PARTITION });
    expect((await get({ pk: orgPk(ORG), sk: "SAVED_ENV#alive" }))?.[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBeUndefined();
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([{ orgId: ORG, projectId: "web" }]);
  });

  it("lists a project purged too early again once the lease has passed, and drops it once a purge finished after deletedAt plus the lease", async () => {
    const { get, store, clock } = bench();
    const row = deleted({ registryPurgedAt: new Date(NOW + 1000).toISOString() });
    await store.commit(row, null, entry("project_deleted"));
    // purged one second after the delete: due again at deletedAt plus the lease, not before
    expect((await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" }))?.[WORKFLOW_DISPATCH_DUE_INDEX.sortKey]).toContain(String(NOW + SAVED_ENV_JOB_LEASE_MS).padStart(15, "0"));
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
    clock.now = () => NOW + SAVED_ENV_JOB_LEASE_MS + 5;
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([{ orgId: ORG, projectId: "web" }]);
    const final = { ...row, version: 2, registryPurgedAt: new Date(NOW + SAVED_ENV_JOB_LEASE_MS + 1).toISOString() };
    expect(await store.commit(final, 1, entry("images_deleted", { reason: "purged" }))).toBe(true);
    expect((await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" }))?.[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBeUndefined();
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
  });

  it("checks the row itself, not the eventually consistent index", async () => {
    const { get, set, store } = bench();
    await store.commit(deleted(), null, entry("project_deleted"));
    // the index still lists the row, but the row was registered again meanwhile
    const live = (await get({ pk: orgPk(ORG), sk: "SAVED_ENV#web" })) as Record<string, unknown>;
    await set({ ...live, deleted: false });
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
    // or its purge finished after the lease, though the index still lists it
    await set({ ...live, registryPurgedAt: new Date(NOW + SAVED_ENV_JOB_LEASE_MS + 1).toISOString() });
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
  });
});
