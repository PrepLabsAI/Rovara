// Port lane P6 (item L2, owner decision 60; review H1, M2, L1): Code's audit trail. The record COMMITS WITH THE CHANGE (an AUDIT# row staged into the caller's own transaction); the append-only,
// hash-chained copy in audit.db is fed from committed rows only and is never the primary.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PLUGIN_POINT_CARDINALITY, change, companyScoped, isAllowedModuleSpecifier, when, type AuditEvent, type AuditSink, type DocumentStore } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, registerCodeDefaults, type ModuleImporter } from "../../packages/broker/src/ports/index.js";
import * as pluginModule from "../../packages/local-adapters/src/audit-sink-plugin.js";
import { AUDIT_DETAILS_MAX_BYTES, AuditLogError, SqliteAuditLog } from "../../packages/local-adapters/src/sqlite-audit-log.js";
import { DocumentAuditSink, auditRowKey, startAuditCopy, verifyAuditCopy } from "../../packages/local-adapters/src/document-audit-sink.js";
import { SqliteDocumentStore } from "../../packages/local-adapters/src/sqlite-document-store.js";

const folders: string[] = [];
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "audit-log-"));
  folders.push(dir);
  return dir;
}
const event = (n: number, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  eventId: `evt-${String(n)}`, companyId: IMPLICIT_COMPANY_ID, at: `2026-11-10T00:00:0${String(n)}.000Z`, actor: { type: "person", id: "local-owner" }, action: "lessons.added",
  subject: { type: "lesson", id: `lesson-${String(n)}` }, details: { reason: "test", n }, ...extra,
});
const rowsOf = async (store: DocumentStore): Promise<string[]> => {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk: companyScoped(IMPLICIT_COMPANY_ID, "AUDIT"), ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items.map((item) => item.eventId as string));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out.sort();
};
const decisionKey = (id: string) => ({ pk: companyScoped(IMPLICIT_COMPANY_ID, "DECISION"), sk: id });

describe("DocumentAuditSink: the record commits with the change", () => {
  const make = () => {
    const store = new MemoryDocumentStore();
    return { store, sink: new DocumentAuditSink({ store: () => store }) };
  };

  it("stages one put step into the caller's transaction, and the row exists once the transaction commits", async () => {
    const { store, sink } = make();
    const steps = sink.stage(event(1));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "put", item: { ...auditRowKey(IMPLICIT_COMPANY_ID, "evt-1"), entityType: "AUDIT", action: "lessons.added", actor: { type: "person", id: "local-owner" } } });
    expect(await rowsOf(store)).toEqual([]);
    const result = await store.transact([{ kind: "put", item: { ...decisionKey("r1"), state: "approved" }, condition: when.absent() }, ...steps]);
    expect(result).toEqual({ applied: true });
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("a losing approval leaves no row: two approvers decide at once and only the winner's change, and record, commit", async () => {
    const { store, sink } = make();
    const decide = (who: string, n: number) => store.transact([
      { kind: "put", item: { ...decisionKey("request-1"), decidedBy: who }, condition: when.absent() },
      ...sink.stage(event(n, { action: "decision.approved", actor: { type: "person", id: who } })),
    ]);
    const [first, second] = [await decide("alice", 1), await decide("bob", 2)];
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("a lost merge claim leaves no row, and a claim that was made always leaves one", async () => {
    const { store, sink } = make();
    await store.put({ item: { ...decisionKey("merge-1"), status: "ready" } });
    const claim = (n: number) => store.transact([
      { kind: "update", key: decisionKey("merge-1"), ops: [change.set("status", "claimed"), change.set("claimedBy", `press-${String(n)}`)], condition: when.eq("status", "ready") },
      ...sink.stage(event(n, { action: "pull_request.merge_requested" })),
    ]);
    expect((await claim(1)).applied).toBe(true);
    expect((await claim(2)).applied).toBe(false);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("a crash between the audit and the change leaves no row (nothing was written before the transaction)", async () => {
    const { store, sink } = make();
    sink.stage(event(1));
    // The process stops here: the transaction is never run. A fresh sink over the same store sees nothing.
    const after = new DocumentAuditSink({ store: () => store });
    expect(await rowsOf(store)).toEqual([]);
    await store.transact([{ kind: "put", item: { ...decisionKey("r1"), state: "approved" } }, ...after.stage(event(1))]);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("a transaction that fails for a store fault leaves no row, so the retry makes the only one", async () => {
    const { store, sink } = make();
    store.injectFault(new (await import("@agentx/contracts")).DocumentStoreError("unavailable", "down"));
    await expect(store.transact([...sink.stage(event(1))])).rejects.toThrow();
    expect(await rowsOf(store)).toEqual([]);
    expect((await store.transact([...sink.stage(event(1))])).applied).toBe(true);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("refuses a retry that reuses an event id for different facts (it is not silently dropped), and accepts the same facts again", async () => {
    const { store, sink } = make();
    expect((await store.transact([...sink.stage(event(1, { details: { revision: 1 } }))])).applied).toBe(true);
    const different = await store.transact([{ kind: "put", item: { ...decisionKey("r2"), state: "approved" } }, ...sink.stage(event(1, { details: { revision: 2 } }))]);
    expect(different.applied).toBe(false);
    // The change in the same transaction was refused with it.
    expect(await store.get(decisionKey("r2"))).toBeUndefined();
    const stored = await store.get(auditRowKey(IMPLICIT_COMPANY_ID, "evt-1"));
    expect(stored?.details).toEqual({ revision: 1 });
    // The same facts at a later moment are the same record.
    expect((await store.transact([...sink.stage(event(1, { at: "2026-12-01T00:00:00.000Z", details: { revision: 1 } }))])).applied).toBe(true);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
    expect(stored?.at).toBe("2026-11-10T00:00:01.000Z");
  });

  it("record writes a row on its own, accepts the same facts twice, and rejects an event id used for other facts", async () => {
    const { store, sink } = make();
    await sink.record(event(1));
    await sink.record(event(1));
    await expect(sink.record(event(1, { action: "lessons.removed" }))).rejects.toBeInstanceOf(AuditLogError);
    await expect(sink.record(event(1, { details: { n: 99 } }))).rejects.toBeInstanceOf(AuditLogError);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("refuses a bad event before anything is written", async () => {
    const { store, sink } = make();
    const bad: AuditEvent[] = [
      event(1, { eventId: "" }), event(1, { companyId: "" }), event(1, { companyId: "has space" }), event(1, { at: "yesterday" }), event(1, { action: "Lessons Added" }),
      event(1, { actor: { type: "robot" as never, id: "x" } }), event(1, { actor: { type: "agent", id: "" } }), event(1, { details: { big: "x".repeat(AUDIT_DETAILS_MAX_BYTES) } }),
      event(1, { eventId: "lone\ud800surrogate" }),
    ];
    for (const one of bad) {
      await expect(sink.record(one)).rejects.toBeInstanceOf(AuditLogError);
      expect(() => sink.stage(one)).toThrow(AuditLogError);
    }
    expect(await rowsOf(store)).toEqual([]);
  });
});

describe("SqliteAuditLog: the append-only copy", () => {
  const open = async () => {
    const path = join(await folder(), "audit.db");
    const log = SqliteAuditLog.open({ path });
    closers.push(() => log.close());
    return { log, path };
  };

  it("appends committed events, reads them back in order, and appends an event id once", async () => {
    const { log } = await open();
    log.append(event(1));
    log.append(event(2));
    log.append(event(1, { at: "2030-01-01T00:00:00.000Z" }));
    const rows = log.read({ companyId: IMPLICIT_COMPANY_ID });
    expect(rows.map((row) => row.eventId)).toEqual(["evt-1", "evt-2"]);
    expect(rows[0]).toMatchObject({ seq: 1, action: "lessons.added", details: { reason: "test", n: 1 } });
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID, afterSeq: 1 }).map((row) => row.seq)).toEqual([2]);
    expect(log.read({ companyId: "org_other" })).toEqual([]);
    expect(log.head().count).toBe(2);
  });

  it("refuses an event id it already holds for other facts", async () => {
    const { log } = await open();
    log.append(event(1));
    expect(() => log.append(event(1, { details: { n: 5 } }))).toThrow(AuditLogError);
  });

  it("is append-only: a row cannot be changed or removed, even through another connection", async () => {
    const { log, path } = await open();
    log.append(event(1));
    const other = new DatabaseSync(path);
    try {
      expect(() => other.exec("UPDATE audit_events SET action = 'x'")).toThrow(/append-only/);
      expect(() => other.exec("DELETE FROM audit_events")).toThrow(/append-only/);
    } finally {
      other.close();
    }
  });

  it("verifies its chain, and notices a row changed by someone who removed the triggers", async () => {
    const { log, path } = await open();
    for (const n of [1, 2, 3]) log.append(event(n));
    expect(log.verify()).toEqual({ ok: true, checked: 3 });
    const other = new DatabaseSync(path);
    try {
      other.exec("DROP TRIGGER audit_events_no_update");
      other.exec("UPDATE audit_events SET action = 'lessons.removed' WHERE seq = 2");
    } finally {
      other.close();
    }
    expect(log.verify()).toEqual({ ok: false, checked: 2, brokenAt: 2 });
  });

  it("notices the newest rows being cut off, which the chain alone cannot (the anchor)", async () => {
    const { log, path } = await open();
    for (const n of [1, 2, 3]) log.append(event(n));
    const anchor = log.head();
    const other = new DatabaseSync(path);
    try {
      other.exec("DROP TRIGGER audit_events_no_delete");
      other.exec("DELETE FROM audit_events WHERE seq = 3");
    } finally {
      other.close();
    }
    expect(log.verify()).toEqual({ ok: true, checked: 2 });
    expect(log.verify(anchor)).toEqual({ ok: false, checked: 2, anchor: "behind" });
  });

  it("notices an anchored row that differs, and accepts a log longer than its anchor (the anchor is written after the rows)", async () => {
    const { log } = await open();
    for (const n of [1, 2]) log.append(event(n));
    const anchor = log.head();
    log.append(event(3));
    expect(log.verify(anchor)).toEqual({ ok: true, checked: 3 });
    expect(log.verify({ count: 2, hash: "f".repeat(64) })).toEqual({ ok: false, checked: 3, anchor: "mismatch" });
  });

  it.skipIf(process.platform === "win32")("keeps its file private to the owner", async () => {
    const { path } = await open();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("the copy is fed from committed rows only", () => {
  const setup = async () => {
    const dir = await folder();
    const store = SqliteDocumentStore.open({ path: join(dir, "state.db"), indexes: [], migrate: true });
    closers.push(() => store.close());
    const log = SqliteAuditLog.open({ path: join(dir, "audit.db") });
    closers.push(() => log.close());
    const sink = new DocumentAuditSink({ store: () => store });
    const errors: unknown[] = [];
    const feeding = await startAuditCopy({ store, log, companyId: IMPLICIT_COMPANY_ID, onError: (error) => errors.push(error) });
    closers.push(() => feeding?.stop());
    return { store, log, sink, errors };
  };
  const settle = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it("copies a row that committed, never one whose transaction was refused, and anchors the copy", async () => {
    const { store, log, sink } = await setup();
    await store.transact([{ kind: "put", item: { ...decisionKey("r1"), state: "approved" }, condition: when.absent() }, ...sink.stage(event(1))]);
    const refused = await store.transact([{ kind: "put", item: { ...decisionKey("r1"), state: "approved-again" }, condition: when.absent() }, ...sink.stage(event(2))]);
    expect(refused.applied).toBe(false);
    await store.transact([...sink.stage(event(3))]);
    await settle(() => log.head().count >= 2);
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID }).map((row) => row.eventId)).toEqual(["evt-1", "evt-3"]);
    await settle(() => log.head().count === 2);
    expect(await verifyAuditCopy({ store, log, companyId: IMPLICIT_COMPANY_ID })).toEqual({ ok: true, checked: 2 });
  });

  it("finds a copy whose newest rows were cut off, by the anchor kept in the store", async () => {
    const dir = await folder();
    const store = SqliteDocumentStore.open({ path: join(dir, "state.db"), indexes: [], migrate: true });
    closers.push(() => store.close());
    const path = join(dir, "audit.db");
    const log = SqliteAuditLog.open({ path });
    closers.push(() => log.close());
    const sink = new DocumentAuditSink({ store: () => store });
    const feeding = await startAuditCopy({ store, log, companyId: IMPLICIT_COMPANY_ID });
    for (const n of [1, 2, 3]) await store.transact([...sink.stage(event(n))]);
    await settle(() => log.head().count === 3);
    await feeding?.stop();
    // The anchor is written after the rows; wait until it says three.
    for (let i = 0; i < 100; i += 1) {
      const anchor = await store.get({ pk: companyScoped(IMPLICIT_COMPANY_ID, "AUDIT_COPY"), sk: "HEAD" });
      if (anchor?.count === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const other = new DatabaseSync(path);
    try {
      other.exec("DROP TRIGGER audit_events_no_delete");
      other.exec("DELETE FROM audit_events WHERE seq = 3");
    } finally {
      other.close();
    }
    expect(await verifyAuditCopy({ store, log, companyId: IMPLICIT_COMPANY_ID })).toEqual({ ok: false, checked: 2, anchor: "behind" });
  });

  it("a store with no change feed gets no copy, and a copy with no anchor yet is checked for its chain alone", async () => {
    const store = new MemoryDocumentStore({ changeFeed: false });
    const log = SqliteAuditLog.open({ path: join(await folder(), "audit.db") });
    closers.push(() => log.close());
    expect(await startAuditCopy({ store, log, companyId: IMPLICIT_COMPANY_ID })).toBeUndefined();
    log.append(event(1));
    expect(await verifyAuditCopy({ store, log, companyId: IMPLICIT_COMPANY_ID })).toEqual({ ok: true, checked: 1 });
  });
});

describe("the audit-sink plug-in and Code's defaults", () => {
  const importer: ModuleImporter = async (specifier) => {
    if (specifier !== "@agentx/local-adapters/audit-sink") throw new Error("no such module");
    return pluginModule;
  };

  it("loads from a config entry over the registry's storage and replaces the default sink that writes nothing", async () => {
    expect(isAllowedModuleSpecifier("@agentx/local-adapters/audit-sink")).toBe(true);
    expect(PLUGIN_POINT_CARDINALITY["audit-sink"]).toBe("one");
    const store = new MemoryDocumentStore();
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", store);
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("audit-sink")).toEqual(["none"]);
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "audit-sink", name: "document", module: "@agentx/local-adapters/audit-sink" }] }), { registry, importModule: importer });
    expect(registry.names("audit-sink")).toEqual(["document"]);
    const sink: AuditSink = registry.require("audit-sink");
    await sink.record(event(1));
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

  it("registerCodeDefaults can take a different sink as the default instead of the no-op one", () => {
    const registry = createAdapterRegistry();
    const sink = new DocumentAuditSink({ store: () => new MemoryDocumentStore() });
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} }, auditSink: { name: "document", sink } });
    expect(registry.names("audit-sink")).toEqual(["document"]);
    expect(registry.require("audit-sink")).toBe(sink);
  });

  it("refuses a setting it does not know", async () => {
    const registry = createAdapterRegistry();
    await expect(loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "audit-sink", name: "document", module: "@agentx/local-adapters/audit-sink", settings: { path: "x" } }] }), { registry, importModule: importer })).rejects.toThrow();
  });
});
