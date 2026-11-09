// Port lane L3: the SQLite adapters load through the W0 registry's config, as lane L4 will load them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOX_PENDING_INDEX, change, companyScoped, isAllowedModuleSpecifier, when, type DocumentStore, type QueueService } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import * as queueModule from "../../packages/local-adapters/src/queue-plugin.js";
import * as storageModule from "../../packages/local-adapters/src/storage-plugin.js";
import type { SqliteDocumentStore, SqliteQueueService } from "../../packages/local-adapters/src/index.js";

const modules: Record<string, unknown> = { "@agentx/local-adapters/storage": storageModule, "@agentx/local-adapters/queue": queueModule };
const importer: ModuleImporter = async (specifier) => {
  if (!(specifier in modules)) throw new Error("no such module");
  return modules[specifier];
};

const folders: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";

describe("the SQLite plug-ins", () => {
  it("are allowed module names, and load from a config entry into the storage and queue points", async () => {
    expect(isAllowedModuleSpecifier("@agentx/local-adapters/storage")).toBe(true);
    expect(isAllowedModuleSpecifier("@agentx/local-adapters/queue")).toBe(true);
    const folder = await mkdtemp(join(tmpdir(), "local-plugin-"));
    folders.push(folder);
    const path = join(folder, "state.db");
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({
      version: 1,
      plugins: [
        { point: "storage", name: "sqlite", module: "@agentx/local-adapters/storage", settings: { path, indexes: [{ name: "byKind", partitionAttribute: "kind", sortAttribute: "rank", sortType: "number" }], changeFeed: { pollMs: 20 } } },
        { point: "queue", name: "sqlite", module: "@agentx/local-adapters/queue", settings: { path } },
      ],
    }), { registry, importModule: importer });
    registry.seal();
    const store = registry.require("storage") as DocumentStore & SqliteDocumentStore;
    const queues = registry.require("queue") as QueueService & SqliteQueueService;
    closers.push(async () => {
      await store.close();
      await queues.close();
    });
    expect(store.ttlAttribute).toBe("expiresAt");
    expect(store.indexes.map((index) => index.name)).toEqual([OUTBOX_PENDING_INDEX.name, "byKind"]);
    expect(store.changes).toBeDefined();

    // The outbox works over what the registry gave, with the pending index the plug-in always keeps.
    const outbox = createTransactionalOutbox({ store, queues });
    const pk = companyScoped(COMPANY, "TASK#1");
    expect((await store.transact([{ kind: "put", item: { pk, sk: "META", kind: "task", rank: 1 }, condition: when.absent() }, outbox.stage({ companyId: COMPANY, id: "op-1", queue: "dispatch", body: "go" })])).applied).toBe(true);
    expect(await outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 1, failed: 0, dead: 0 });
    expect((await (await queues.queue("dispatch")).receive()).map((message) => message.body)).toEqual(["go"]);
    expect((await store.queryIndex({ index: "byKind", partition: "task" })).items).toHaveLength(1);
    await store.update({ key: { pk, sk: "META" }, ops: [change.add("rank", 1)] });
  });

  it("run expiry on the injected clock, or not at all with ttlAttribute null", async () => {
    const folder = await mkdtemp(join(tmpdir(), "local-plugin-"));
    folders.push(folder);
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "storage", name: "sqlite", module: "@agentx/local-adapters/storage", settings: { path: join(folder, "a.db"), sweepIntervalMs: 0 } }] }), { registry, importModule: importer, now: () => new Date(10_000_000) });
    const store = registry.require("storage") as DocumentStore & SqliteDocumentStore;
    closers.push(() => store.close());
    await store.put({ item: { pk: "p", sk: "old", expiresAt: 9_999 } });
    await store.put({ item: { pk: "p", sk: "new", expiresAt: 10_001 } });
    expect(store.sweepExpired()).toBe(1);
    const none = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "storage", name: "sqlite", module: "@agentx/local-adapters/storage", settings: { path: join(folder, "b.db"), ttlAttribute: null } }] }), { registry: none, importModule: importer });
    const plain = none.require("storage") as DocumentStore & SqliteDocumentStore;
    closers.push(() => plain.close());
    expect(plain.ttlAttribute).toBeUndefined();
  });

  it("refuse settings they do not know, a missing path, an in-memory path and a bad index", async () => {
    const make = async (module: "storage" | "queue", settings: Record<string, unknown>) => {
      const registry = createAdapterRegistry();
      await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: module, name: "sqlite", module: `@agentx/local-adapters/${module}`, settings }] }), { registry, importModule: importer });
    };
    const folder = await mkdtemp(join(tmpdir(), "local-plugin-"));
    folders.push(folder);
    const path = join(folder, "state.db");
    await expect(make("storage", {})).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("storage", { path: ":memory:" })).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("storage", { path, typo: 1 })).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("storage", { path, indexes: [{ name: "x", partitionAttribute: "a", extra: 1 }] })).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("storage", { path, indexes: [{ name: OUTBOX_PENDING_INDEX.name, partitionAttribute: "other" }] })).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("storage", { path, synchronous: "OFF" })).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("queue", { path, pollMs: 0 })).rejects.toMatchObject({ code: "create_failed" });
    await expect(make("queue", {})).rejects.toMatchObject({ code: "create_failed" });
  });
});
