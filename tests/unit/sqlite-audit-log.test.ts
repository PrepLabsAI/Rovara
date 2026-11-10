// Port lane P6 (item L2, owner decision 60): the local append-only audit log on SQLite, so "audit before add" holds in Code.
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PLUGIN_POINT_CARDINALITY, isAllowedModuleSpecifier, type AuditEvent, type AuditSink } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, registerCodeDefaults, type ModuleImporter } from "../../packages/broker/src/ports/index.js";
import * as pluginModule from "../../packages/local-adapters/src/audit-sink-plugin.js";
import { AUDIT_DETAILS_MAX_BYTES, AuditLogError, SqliteAuditLog } from "../../packages/local-adapters/src/sqlite-audit-log.js";

const folders: string[] = [];
const logs: SqliteAuditLog[] = [];
afterEach(async () => {
  for (const log of logs.splice(0)) log.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function open(): Promise<{ log: SqliteAuditLog; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "audit-log-"));
  folders.push(dir);
  const path = join(dir, "audit.db");
  const log = SqliteAuditLog.open({ path });
  logs.push(log);
  return { log, path };
}
const event = (n: number, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  eventId: `evt-${String(n)}`, companyId: IMPLICIT_COMPANY_ID, at: `2026-11-10T00:00:0${String(n)}.000Z`, actor: { type: "person", id: "local-owner" }, action: "lessons.added",
  subject: { kind: "lesson", id: `lesson-${String(n)}` } as never, details: { reason: "test", n }, ...extra,
});
/** An event with no subject at all (the field absent, not undefined). */
const withoutSubject = (n: number): AuditEvent => {
  const { eventId, companyId, at, actor, action, details } = event(n);
  return { eventId, companyId, at, actor, action, ...(details === undefined ? {} : { details }) };
};

describe("SqliteAuditLog", () => {
  it("records an event and reads it back in order, with the sink's own fields intact", async () => {
    const { log } = await open();
    await log.record(event(1));
    await log.record(withoutSubject(2));
    const rows = log.read({ companyId: IMPLICIT_COMPANY_ID });
    expect(rows.map((row) => row.eventId)).toEqual(["evt-1", "evt-2"]);
    expect(rows[0]).toMatchObject({ seq: 1, actor: { type: "person", id: "local-owner" }, action: "lessons.added", details: { reason: "test", n: 1 } });
    expect(rows[1]?.subject).toBeUndefined();
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID, afterSeq: 1 }).map((row) => row.seq)).toEqual([2]);
    expect(log.read({ companyId: "org_other" })).toEqual([]);
  });

  it("records an event id once", async () => {
    const { log } = await open();
    await log.record(event(1));
    await log.record(event(1, { action: "lessons.removed" }));
    log.stage(event(1));
    const rows = log.read({ companyId: IMPLICIT_COMPANY_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("lessons.added");
  });

  it("stage writes the record BEFORE the caller's transaction and adds no transaction steps (audit before add)", async () => {
    const { log } = await open();
    const steps = log.stage(event(1));
    expect(steps).toEqual([]);
    // The record is already durable; the caller has not yet made its change.
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID })).toHaveLength(1);
  });

  it("keeps its records across a restart", async () => {
    const { log, path } = await open();
    await log.record(event(1));
    log.close();
    const again = SqliteAuditLog.open({ path });
    logs.push(again);
    expect(again.read({ companyId: IMPLICIT_COMPANY_ID })).toHaveLength(1);
    await again.record(event(2));
    expect(again.verify()).toEqual({ ok: true, checked: 2 });
  });

  it("is append-only: a row cannot be changed or removed, even through another connection", async () => {
    const { log, path } = await open();
    await log.record(event(1));
    const other = new DatabaseSync(path);
    try {
      expect(() => other.exec("UPDATE audit_events SET action = 'x'")).toThrow(/append-only/);
      expect(() => other.exec("DELETE FROM audit_events")).toThrow(/append-only/);
    } finally {
      other.close();
    }
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID })[0]?.action).toBe("lessons.added");
  });

  it("verifies its chain, and notices a row changed by someone who removed the triggers", async () => {
    const { log, path } = await open();
    for (const n of [1, 2, 3]) await log.record(event(n));
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

  it("notices a removed row (the next row no longer links to the one before)", async () => {
    const { log, path } = await open();
    for (const n of [1, 2, 3]) await log.record(event(n));
    const other = new DatabaseSync(path);
    try {
      other.exec("DROP TRIGGER audit_events_no_delete");
      other.exec("DELETE FROM audit_events WHERE seq = 2");
    } finally {
      other.close();
    }
    expect(log.verify().ok).toBe(false);
  });

  it("refuses a bad event and writes nothing (the change it was to record must not be made)", async () => {
    const { log } = await open();
    const bad: AuditEvent[] = [
      event(1, { eventId: "" }), event(1, { companyId: "" }), event(1, { at: "yesterday" }), event(1, { action: "Lessons Added" }),
      event(1, { actor: { type: "robot" as never, id: "x" } }), event(1, { actor: { type: "agent", id: "" } }), event(1, { details: { big: "x".repeat(AUDIT_DETAILS_MAX_BYTES) } }),
      event(1, { eventId: "lone\ud800surrogate" }),
    ];
    for (const one of bad) {
      await expect(log.record(one)).rejects.toBeInstanceOf(AuditLogError);
      expect(() => log.stage(one)).toThrow(AuditLogError);
    }
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID })).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps its file private to the owner", async () => {
    const { path } = await open();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o600);
  });

  it("serves two connections to one file without losing or reordering a record", async () => {
    const { log, path } = await open();
    const second = SqliteAuditLog.open({ path });
    logs.push(second);
    await Promise.all([log.record(event(1)), second.record(event(2)), log.record(event(3)), second.record(event(4))]);
    expect(log.read({ companyId: IMPLICIT_COMPANY_ID })).toHaveLength(4);
    expect(second.verify()).toEqual({ ok: true, checked: 4 });
  });
});

describe("the audit-sink plug-in and Code's defaults", () => {
  const importer: ModuleImporter = async (specifier) => {
    if (specifier !== "@agentx/local-adapters/audit-sink") throw new Error("no such module");
    return pluginModule;
  };

  it("loads from a config entry and replaces the default sink that writes nothing", async () => {
    expect(isAllowedModuleSpecifier("@agentx/local-adapters/audit-sink")).toBe(true);
    expect(PLUGIN_POINT_CARDINALITY["audit-sink"]).toBe("one");
    const dir = await mkdtemp(join(tmpdir(), "audit-plugin-"));
    folders.push(dir);
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("audit-sink")).toEqual(["none"]);
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "audit-sink", name: "sqlite", module: "@agentx/local-adapters/audit-sink", settings: { path: join(dir, "audit.db") } }] }), { registry, importModule: importer });
    expect(registry.names("audit-sink")).toEqual(["sqlite"]);
    const sink: AuditSink = registry.require("audit-sink");
    await sink.record(event(1));
    (sink as SqliteAuditLog).close();
  });

  it("registerCodeDefaults can take the local log as the default instead of the no-op sink", async () => {
    const { log } = await open();
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} }, auditSink: { name: "sqlite", sink: log } });
    expect(registry.names("audit-sink")).toEqual(["sqlite"]);
    expect(registry.require("audit-sink")).toBe(log);
  });

  it("refuses a setting it does not know and an in-memory path", async () => {
    const registry = createAdapterRegistry();
    for (const settings of [{ paht: "x" }, { path: ":memory:" }]) {
      await expect(loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "audit-sink", name: "sqlite", module: "@agentx/local-adapters/audit-sink", settings }] }), { registry, importModule: importer })).rejects.toThrow();
    }
  });
});
