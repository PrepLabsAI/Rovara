// Port lane W0: the one plug-in registry, its config loader, and the channel point that Pratik's channel adapters (spec 062) use.
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelEventSchema, type ChannelInboundSink, PLUGIN_POINTS, channelEventId, type ChannelEvent, type PluginModule } from "@agentx/contracts";
import { createAdapterRegistry, createModuleImporter, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";

const pluginName = (loaded: unknown): string => (loaded as { plugin: { name: string } }).plugin.name;
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
    await sink.message({ version: 2, channel: "whatsapp", eventId: "e1", conversation: { channel: "whatsapp", tenant: "t", space: "s", thread: "main" }, actor: { channel: "whatsapp", tenant: "t", userId: "u" }, text: "hello", receivedAt: event.createdAt });
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

  it("imports a ./ module from inside the config folder only, following links to their real place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plugin-config-"));
    const outside = await mkdtemp(join(tmpdir(), "plugin-outside-"));
    try {
      await writeFile(join(directory, "inside.mjs"), "export const plugin = { point: 'admission', name: 'inside', create: () => ({}) };\n");
      await writeFile(join(outside, "evil.mjs"), "export const plugin = { point: 'admission', name: 'evil', create: () => ({}) };\n");
      await symlink(join(outside, "evil.mjs"), join(directory, "link.mjs"));
      const importer = createModuleImporter(directory);
      expect(pluginName(await importer("./inside.mjs"))).toBe("inside");
      await expect(importer("./link.mjs")).rejects.toThrow(/inside the config folder/);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

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

  it("refuses a module that is for a different point or name than its config entry", async () => {
    await expect(loadAdapters(config([{ point: "queue", name: "memory", module: "m" }]), { registry: createAdapterRegistry(), importModule: importerOf({ m: { plugin: storeModule } }) }))
      .rejects.toMatchObject({ name: "PluginRegistryError", code: "bad_module" });
  });

  it("refuses a module that cannot be loaded or exports no plug-in, without echoing the specifier's error", async () => {
    await expect(loadAdapters(config([{ point: "storage", name: "memory", module: "missing-pkg" }]), { registry: createAdapterRegistry(), importModule: importerOf({}) })).rejects.toMatchObject({ code: "bad_module" });
    await expect(loadAdapters(config([{ point: "storage", name: "memory", module: "empty-pkg" }]), { registry: createAdapterRegistry(), importModule: importerOf({ "empty-pkg": {} }) })).rejects.toMatchObject({ code: "bad_module" });
  });

});
