// Port lane W0: the one plug-in registry, its config loader, and the channel point that Pratik's channel adapters (spec 062) use.
import { describe, expect, it } from "vitest";
import { ChannelEventSchema, type ChannelInboundSink, PLUGIN_POINTS, PluginRegistryError, channelEventId, type ChannelEvent, type PluginModule } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { createAllowAllAdmission, registerCodeDefaults } from "../../packages/broker/src/ports/policy-defaults.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";

const config = (plugins: unknown[], extra: Record<string, unknown> = {}) => parsePluginConfig({ version: 1, plugins, ...extra });
const importerOf = (modules: Record<string, unknown>): ModuleImporter => async (specifier) => {
  if (!(specifier in modules)) throw new Error("no such module");
  return modules[specifier];
};

describe("the adapter registry", () => {
  it("has a point for everything decision 40 names, plus the policy seams", () => {
    expect(PLUGIN_POINTS).toEqual(expect.arrayContaining(["code-host", "tracker", "check-runner", "channel", "worker-machines", "storage", "queue", "monitoring", "learning", "team-record-source", "identity", "build-system", "admission", "audit-sink", "approvers", "metering", "model-keys"]));
  });

  it("holds many adapters by name at a many-point and finds them", () => {
    const registry = createAdapterRegistry();
    const whatsapp = new FakeChannelAdapter();
    const teams = new FakeChannelAdapter();
    registry.register("channel", "whatsapp", whatsapp);
    registry.register("channel", "teams", teams);
    expect(registry.names("channel")).toEqual(["teams", "whatsapp"]);
    expect(registry.get("channel", "whatsapp")).toBe(whatsapp);
    expect(registry.get("channel", "nope")).toBeUndefined();
    expect(() => registry.require("channel")).toThrowError(expect.objectContaining({ code: "ambiguous" }));
    expect(registry.require("channel", "teams")).toBe(teams);
    expect(() => registry.register("channel", "teams", teams)).toThrowError(expect.objectContaining({ code: "already_registered" }));
  });

  it("registers and unregisters a channel at run time, as an administrator's registration does", () => {
    const registry = createAdapterRegistry();
    registry.register("channel", "whatsapp", new FakeChannelAdapter());
    expect(registry.unregister("channel", "whatsapp")).toBe(true);
    expect(registry.unregister("channel", "whatsapp")).toBe(false);
    expect(() => registry.require("channel", "whatsapp")).toThrowError(expect.objectContaining({ code: "not_registered" }));
  });

  it("gives the only adapter of a point when no name is asked for", () => {
    const registry = createAdapterRegistry();
    expect(() => registry.require("storage")).toThrowError(expect.objectContaining({ code: "not_registered" }));
    const store = new MemoryDocumentStore();
    registry.register("storage", "memory", store);
    expect(registry.require("storage")).toBe(store);
  });

  it("lets a configured adapter replace a default at a one-point, and refuses two configured ones", () => {
    const registry = createAdapterRegistry();
    const fallback = createAllowAllAdmission();
    const configured = createAllowAllAdmission();
    registry.register("admission", "allow-all", fallback, { isDefault: true });
    registry.register("admission", "budgets", configured);
    expect(registry.names("admission")).toEqual(["budgets"]);
    expect(() => registry.register("admission", "other", createAllowAllAdmission())).toThrowError(expect.objectContaining({ code: "already_registered" }));
    registry.register("admission", "late-default", fallback, { isDefault: true });
    expect(registry.names("admission")).toEqual(["budgets"]);
  });

  it("registers Code's defaults for the policy seams, and a configured adapter wins over them", () => {
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("admission")).toEqual(["allow-all"]);
    expect(registry.names("audit-sink")).toEqual(["none"]);
    expect(registry.names("approvers")).toEqual(["local-owner"]);
    expect(registry.names("identity")).toEqual(["local-owner"]);
    expect(registry.names("metering")).toEqual(["price-table"]);
    registry.register("admission", "budgets", createAllowAllAdmission());
    expect(registry.names("admission")).toEqual(["budgets"]);
  });

  it("carries Pratik's channel events to a channel adapter unchanged", async () => {
    const registry = createAdapterRegistry();
    const adapter = new FakeChannelAdapter();
    registry.register("channel", "whatsapp", adapter);
    const event: ChannelEvent = ChannelEventSchema.parse({
      version: 1, id: channelEventId(), channel: "whatsapp", conversation: { channel: "whatsapp", tenant: "t", space: "s", thread: "main" },
      createdAt: "2026-11-09T10:00:00.000Z", type: "progress", data: { text: "working" },
    });
    await registry.require("channel", "whatsapp").deliver(event);
    await registry.require("channel", "whatsapp").deliver(event);
    expect(adapter.delivered).toHaveLength(1);
    const heard: string[] = [];
    const sink: ChannelInboundSink = { message: async (message) => void heard.push(message.text), decision: async () => {} };
    const listener = await adapter.start(sink);
    await sink.message({ version: 2, channel: "whatsapp", eventId: "e1", conversation: event.conversation, actor: { channel: "whatsapp", tenant: "t", userId: "u" }, text: "hello", receivedAt: event.createdAt });
    expect(heard).toEqual(["hello"]);
    await listener.stop();
    expect(adapter.stopped).toBe(true);
  });
});

describe("the config loader", () => {
  const storeModule: PluginModule<"storage"> = { point: "storage", name: "memory", create: () => new MemoryDocumentStore() };
  const queueModule: PluginModule<"queue"> = {
    point: "queue", name: "memory",
    create: (context) => {
      // A queue may need the store: it finds it through the registry the loader built it with.
      expect(context.registry.require("storage")).toBeInstanceOf(MemoryDocumentStore);
      expect(context.settings).toEqual({ visibility: 30 });
      return new MemoryQueueService();
    },
  };

  it("creates the enabled adapters in order and registers them under their names", async () => {
    const registry = createAdapterRegistry();
    await loadAdapters(
      config([
        { point: "storage", name: "memory", module: "@rovara/plugin-memory-store" },
        { point: "queue", name: "memory", module: "./local/queue.js", settings: { visibility: 30 } },
        { point: "channel", name: "off", module: "@rovara/plugin-off", enabled: false },
      ]),
      { registry, importModule: importerOf({ "@rovara/plugin-memory-store": { plugin: storeModule }, "./local/queue.js": { default: queueModule } }) },
    );
    expect(registry.names("storage")).toEqual(["memory"]);
    expect(registry.names("queue")).toEqual(["memory"]);
    expect(registry.names("channel")).toEqual([]);
  });

  it("gives an adapter the company from the config, or the implicit one", async () => {
    const seen: string[] = [];
    const probe: PluginModule<"admission"> = { point: "admission", name: "probe", create: (context) => (seen.push(context.companyId), createAllowAllAdmission()) };
    for (const extra of [{ companyId: "org_abc" }, {}]) {
      await loadAdapters(config([{ point: "admission", name: "probe", module: "probe-pkg" }], extra), { registry: createAdapterRegistry(), importModule: importerOf({ "probe-pkg": { plugin: probe } }) });
    }
    expect(seen).toEqual(["org_abc", "org_00000000000000000000"]);
  });

  it("refuses a module that is for a different point or name than its config entry", async () => {
    await expect(loadAdapters(config([{ point: "queue", name: "memory", module: "m" }]), { registry: createAdapterRegistry(), importModule: importerOf({ m: { plugin: storeModule } }) }))
      .rejects.toMatchObject({ name: "PluginRegistryError", code: "bad_module" });
  });

  it("refuses a module that cannot be loaded or exports no plug-in, without echoing the specifier's error", async () => {
    await expect(loadAdapters(config([{ point: "storage", name: "memory", module: "missing-pkg" }]), { registry: createAdapterRegistry(), importModule: importerOf({}) })).rejects.toMatchObject({ code: "bad_module" });
    await expect(loadAdapters(config([{ point: "storage", name: "memory", module: "empty-pkg" }]), { registry: createAdapterRegistry(), importModule: importerOf({ "empty-pkg": {} }) })).rejects.toMatchObject({ code: "bad_module" });
  });

  it("reports an adapter that fails to build by its name only", async () => {
    const broken: PluginModule<"storage"> = { point: "storage", name: "memory", create: () => { throw new Error("secret detail"); } };
    const error = await loadAdapters(config([{ point: "storage", name: "memory", module: "m" }]), { registry: createAdapterRegistry(), importModule: importerOf({ m: { plugin: broken } }) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginRegistryError);
    expect((error as PluginRegistryError).code).toBe("create_failed");
    expect((error as PluginRegistryError).message).not.toContain("secret detail");
  });

  it("refuses a config that is malformed", () => {
    const bad = (value: unknown) => expect(() => parsePluginConfig(value)).toThrowError(expect.objectContaining({ code: "bad_config" }));
    bad({ plugins: [] });
    bad({ version: 2, plugins: [] });
    bad({ version: 1, plugins: [{ point: "no-such-point", name: "x", module: "m" }] });
    bad({ version: 1, plugins: [{ point: "storage", name: "Bad Name", module: "m" }] });
    bad({ version: 1, plugins: [{ point: "storage", name: "a", module: "m", surprise: true }] });
    bad({ version: 1, plugins: [{ point: "storage", name: "a", module: "m" }, { point: "storage", name: "a", module: "m" }] });
    bad({ version: 1, plugins: [{ point: "storage", name: "a", module: "m" }, { point: "storage", name: "b", module: "m" }] });
  });

  it("allows only package names and relative paths as module specifiers", () => {
    const specifier = (module: string) => () => parsePluginConfig({ version: 1, plugins: [{ point: "storage", name: "a", module }] });
    for (const good of ["@rovara/plugin-github", "plugin-sqlite", "./plugins/sqlite.js", "../adapters/docker/index.js", "@scope/pkg/sub/entry.js"]) expect(specifier(good)).not.toThrow();
    for (const bad of ["file:///etc/passwd", "https://example.com/x.js", "data:text/javascript,1", "/abs/path.js", "./a/../../b.js", "../../x/../y.js", "node:fs", "", "a b", "C:\\x.js"]) expect(specifier(bad)).toThrow();
  });
});
