// Port lane P6 (item L2, owner decision 60; review H1, M2, L1): Code's audit sink. The record COMMITS WITH THE CHANGE (an AUDIT# row staged into the caller's own transaction), and the
// `audit-sink` plug-in loads it over the registry's storage. (The laptop's append-only SQLite copy went with `@agentx/local-adapters`, issue #1538.)
import { describe, expect, it } from "vitest";
import { AUDIT_DETAILS_MAX_BYTES, AuditLogError, IMPLICIT_COMPANY_ID, PLUGIN_POINT_CARDINALITY, companyScoped, isAllowedModuleSpecifier, type AuditEvent, type AuditSink, type DocumentStore } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, registerCodeDefaults, type ModuleImporter } from "../../packages/broker/src/ports/index.js";
import * as pluginModule from "../../packages/broker/src/plugins/audit-sink/document/module.js";
import { DocumentAuditSink } from "../../packages/broker/src/plugins/audit-sink/document/sink.js";

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

describe("DocumentAuditSink: the record commits with the change", () => {
  const make = () => {
    const store = new MemoryDocumentStore();
    return { store, sink: new DocumentAuditSink({ store: () => store }) };
  };

  it("a transaction that fails for a store fault leaves no row, so the retry makes the only one", async () => {
    const { store, sink } = make();
    store.injectFault(new (await import("@agentx/contracts")).DocumentStoreError("unavailable", "down"));
    await expect(store.transact([...sink.stage(event(1))])).rejects.toThrow();
    expect(await rowsOf(store)).toEqual([]);
    expect((await store.transact([...sink.stage(event(1))])).applied).toBe(true);
    expect(await rowsOf(store)).toEqual(["evt-1"]);
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

describe("the audit-sink plug-in and Code's defaults", () => {
  const importer: ModuleImporter = async (specifier) => {
    if (specifier !== "@agentx/broker/plugins/audit-sink-document") throw new Error("no such module");
    return pluginModule;
  };

  it("loads from a config entry over the registry's storage and replaces the default sink that writes nothing", async () => {
    expect(isAllowedModuleSpecifier("@agentx/broker/plugins/audit-sink-document")).toBe(true);
    expect(PLUGIN_POINT_CARDINALITY["audit-sink"]).toBe("one");
    const store = new MemoryDocumentStore();
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", store);
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("audit-sink")).toEqual(["none"]);
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "audit-sink", name: "document", module: "@agentx/broker/plugins/audit-sink-document" }] }), { registry, importModule: importer });
    expect(registry.names("audit-sink")).toEqual(["document"]);
    const sink: AuditSink = registry.require("audit-sink");
    await sink.record(event(1));
    expect(await rowsOf(store)).toEqual(["evt-1"]);
  });

});
