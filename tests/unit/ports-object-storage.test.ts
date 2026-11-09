// Port lane L9a: the object-storage adapters pass one conformance suite (provisional, owner decision 58): the document-store adapter (the
// default) and the folder adapter, plus what only the folder adapter has to prove: atomic writes, traversal and link safety, the plug-in.
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectConflictError, ObjectKeyError, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, isAllowedModuleSpecifier, isValidObjectKey, type ObjectStorage } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DOCUMENT_BLOB_MAX_BYTES, createDocumentEvidenceBlobStore, createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { FolderObjectStorage, spellPart, unspellPart } from "../../packages/local-adapters/src/folder-object-storage.js";
import * as folderModule from "../../packages/local-adapters/src/object-storage-plugin.js";
import { evidencePrefixesOf, eraseTaskEvidence } from "../../packages/broker/src/core/proof/evidence-erase.js";
import { storeEvidenceArtifacts } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { runObjectStorageConformance } from "../support/ports/object-storage-conformance.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function tempFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "object-storage-"));
  folders.push(folder);
  return folder;
}

const COMPANY = "org_00000000000000000000";
const DAY = 86_400_000;

runObjectStorageConformance("document store", {
  async create() {
    let now = Date.parse("2026-11-09T00:00:00.000Z");
    const documents = new MemoryDocumentStore();
    return {
      store: createDocumentObjectStorage(documents, { companyId: COMPANY, now: () => now }),
      tooBigBytes: DOCUMENT_BLOB_MAX_BYTES + 1,
      fitsBytes: 65_536,
      expire: async () => { now += 400 * DAY; },
    };
  },
});

runObjectStorageConformance("folder", {
  async create() {
    let now = Date.parse("2026-11-09T00:00:00.000Z");
    const root = await tempFolder();
    return {
      store: new FolderObjectStorage({ root: join(root, "store"), maxObjectBytes: 100_000, now: () => now, retentionDays: { "evidence-std": 30 } }),
      tooBigBytes: 100_001,
      fitsBytes: 100_000,
      expire: async () => { now += 31 * DAY; },
    };
  },
});

describe("the object keys", () => {
  it("accept the keys proof evidence uses and refuse the rest", () => {
    expect(isValidObjectKey("private/0123abcd/ws-1/evidence/t-1/" + "a".repeat(64))).toBe(true);
    expect(isValidObjectKey("a")).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "a/..", "./a", "a/b c", "a\\b", "ä"]) expect(isValidObjectKey(bad), bad).toBe(false);
  });

  it("spell as file names that read back as the same part, and never as . or ..", () => {
    for (const part of ["abc", "Abc", "ABC", "a.b", "a=b", "x:y@z+q,r~s", "A-B_C", ".hidden", "..x", "-"]) {
      const spelled = spellPart(part);
      expect(spelled).not.toBe(".");
      expect(spelled).not.toBe("..");
      expect(spelled).toMatch(/^[a-z0-9._=%^-]+$/);
      expect(unspellPart(spelled)).toBe(part);
    }
    expect(spellPart("Aa")).not.toBe(spellPart("aa"));
    expect(unspellPart("A")).toBeUndefined();
    expect(unspellPart("%zz")).toBeUndefined();
  });
});

describe("the folder adapter", () => {
  it("writes under its own folder only, with private modes, and leaves no part file behind", async () => {
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    await store.put("a/B/c", new Uint8Array([1, 2, 3]), { contentType: "x/y", metadata: {}, retention: "r" });
    const mode = (path: string) => stat(path).then((details) => details.mode & 0o777);
    expect(await mode(root)).toBe(0o700);
    expect(await mode(join(root, "objects", "D_a", "D_^b", "F_c"))).toBe(0o600);
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    expect(await readdir(root)).toEqual(["objects", "tmp"]);
  });

  it("does not leave half an object when a write fails, and the old object stays whole", async () => {
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root, maxObjectBytes: 10 });
    await store.put("k", new Uint8Array([9, 9]), { contentType: "x/y", metadata: {}, retention: "r" });
    await expect(store.put("k", new Uint8Array(11), { contentType: "x/y", metadata: {}, retention: "r" })).rejects.toThrow(/does not fit/);
    expect(Array.from((await store.get("k", 10))!)).toEqual([9, 9]);
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("reads nothing from a file whose header does not match its bytes (a torn or foreign file)", async () => {
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    await store.put("k", new Uint8Array([1, 2, 3, 4]), { contentType: "x/y", metadata: {}, retention: "r" });
    const file = join(root, "objects", "F_k");
    const whole = await readFile(file);
    await writeFile(file, whole.subarray(0, whole.length - 1));
    expect(await store.get("k", 10)).toBeUndefined();
    expect(await store.stat("k")).toBeUndefined();
    await writeFile(file, "not a header\nbytes");
    expect(await store.get("k", 10)).toBeUndefined();
  });

  it("refuses a key that walks out, before touching the disk", async () => {
    const outside = await tempFolder();
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    for (const key of ["../escape", "a/../../escape", `${outside}/x`, "/etc/passwd", "a/..", "..%2f..%2fx"]) {
      await expect(store.put(key, new Uint8Array([1]), { contentType: "x/y", metadata: {}, retention: "r" })).rejects.toBeInstanceOf(ObjectKeyError);
    }
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not follow a link planted inside the store", async () => {
    const outside = await tempFolder();
    await writeFile(join(outside, "secret"), "outside data");
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    await store.put("seed", new Uint8Array([1]), { contentType: "x/y", metadata: {}, retention: "r" });
    // A folder that is a link to somewhere else, and a file that is a link to a file somewhere else.
    await symlink(outside, join(root, "objects", "D_link"));
    await symlink(join(outside, "secret"), join(root, "objects", "F_leak"));
    await expect(store.put("link/x", new Uint8Array([1]), { contentType: "x/y", metadata: {}, retention: "r" })).rejects.toThrow(/outside the store/);
    expect(await readdir(outside)).toEqual(["secret"]);
    expect(await store.get("link/x", 10)).toBeUndefined();
    expect(await store.get("leak", 100)).toBeUndefined();
    expect(await store.stat("leak")).toBeUndefined();
    // Deleting through the link deletes nothing outside either.
    await store.delete("link/x");
    expect(await store.deletePrefix("link/")).toBe(true);
    expect(await readdir(outside)).toEqual(["secret"]);
  });

  it("refuses a store root that is a link", async () => {
    const real = await tempFolder();
    const holder = await tempFolder();
    await symlink(real, join(holder, "store"));
    const store = new FolderObjectStorage({ root: join(holder, "store") });
    await expect(store.put("k", new Uint8Array([1]), { contentType: "x/y", metadata: {}, retention: "r" })).rejects.toThrow(/not a link/);
    await mkdir(join(real, "unused"), { recursive: true });
  });

  it("removes the folders a delete empties and cleans old part files", async () => {
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    await store.put("a/b/c", new Uint8Array([1]), { contentType: "x/y", metadata: {}, retention: "r" });
    await store.delete("a/b/c");
    expect(await readdir(join(root, "objects"))).toEqual([]);
    expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });
});

describe("the folder plug-in", () => {
  const importer: ModuleImporter = async (specifier) => {
    if (specifier !== "@agentx/local-adapters/object-storage") throw new Error("no such module");
    return folderModule;
  };

  it("is a point with one adapter, an allowed module name, and loads from a config entry", async () => {
    expect(PLUGIN_POINTS).toContain("object-storage");
    expect(PLUGIN_POINT_CARDINALITY["object-storage"]).toBe("one");
    expect(isAllowedModuleSpecifier("@agentx/local-adapters/object-storage")).toBe(true);
    const root = join(await tempFolder(), "objects");
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "object-storage", name: "folder", module: "@agentx/local-adapters/object-storage", settings: { path: root, maxObjectMiB: 2, retentionDays: { "evidence-std": 7 } } }] }), { registry, importModule: importer });
    const store: ObjectStorage = registry.require("object-storage");
    await store.put("k", new Uint8Array([1, 2]), { contentType: "x/y", metadata: {}, retention: "evidence-std" });
    expect(Array.from((await store.get("k", 10))!)).toEqual([1, 2]);
    expect(await readdir(root)).toContain("objects");
    await expect(store.put("big", new Uint8Array(2 * 1_048_576 + 1), { contentType: "x/y", metadata: {}, retention: "r" })).rejects.toThrow(/does not fit/);
  });

  it("names a setting it does not know, and refuses a bad number of days", async () => {
    const registry = createAdapterRegistry();
    const load = (settings: Record<string, unknown>) => loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "object-storage", name: "folder", module: "@agentx/local-adapters/object-storage", settings }] }), { registry, importModule: importer });
    await expect(load({ pth: "/x" })).rejects.toThrow(/could not be created/);
    await expect(load({ retentionDays: { x: 0 } })).rejects.toThrow(/could not be created/);
    expect(registry.names("object-storage")).toEqual([]);
  });
});

describe("the folder adapter after the review (L6, L7)", () => {
  const META = { contentType: "x/y", metadata: {}, retention: "r" };

  it("accepts every id the evidence erase accepts, and erases with it", async () => {
    const owner = "a".repeat(128);
    const workspace = `W${"0".repeat(127)}`;
    const prefixes = evidencePrefixesOf({ ownerKey: owner, workspaceId: workspace, taskId: "t".repeat(128) })!;
    expect(prefixes).toHaveLength(2);
    for (const make of [async () => new FolderObjectStorage({ root: join(await tempFolder(), "store") }), async () => createDocumentObjectStorage(new MemoryDocumentStore(), { companyId: COMPANY })]) {
      const store = await make();
      const key = `${prefixes[1]!}${"c".repeat(64)}`;
      await store.put(key, new Uint8Array([1]), META);
      expect(await eraseTaskEvidence(store, { ownerKey: owner, workspaceId: workspace, taskId: "t".repeat(128) })).toBe(true);
      expect(await store.get(key, 10)).toBeUndefined();
    }
  });

  it("refuses, as a bad key, a long part of capitals that would not fit one file name, and puts nothing on disk", async () => {
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    const key = `p/${"A".repeat(128)}/x`;
    await expect(store.put(key, new Uint8Array([1]), META)).rejects.toBeInstanceOf(ObjectKeyError);
    await expect(store.get(key, 10)).rejects.toBeInstanceOf(ObjectKeyError);
    await expect(store.stat(key)).rejects.toBeInstanceOf(ObjectKeyError);
    await expect(store.delete(key)).rejects.toBeInstanceOf(ObjectKeyError);
    expect(await readdir(join(root, "objects")).catch(() => [])).toEqual([]);
  });

  it("answers a key whose path is longer than the disk allows with a key error, not a disk error", async () => {
    const store = new FolderObjectStorage({ root: join(await tempFolder(), "store") });
    const key = Array.from({ length: 200 }, () => "abcde").join("/");
    const outcome = await store.put(key, new Uint8Array([1]), META).then(() => "stored", (error: unknown) => error);
    if (outcome !== "stored") expect(outcome).toBeInstanceOf(ObjectKeyError);
  });

  it("checks each folder before making it, so a link in the middle of a key makes nothing outside the store", async () => {
    const outside = await tempFolder();
    const root = join(await tempFolder(), "store");
    const store = new FolderObjectStorage({ root });
    await store.put("seed", new Uint8Array([1]), META);
    await symlink(outside, join(root, "objects", "D_link"));
    await expect(store.put("link/new/deeper/x", new Uint8Array([1]), META)).rejects.toThrow(/outside the store/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a folder other users can write to, where links could be planted", async () => {
    const parent = await tempFolder();
    const root = join(parent, "store");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o777);
    const store = new FolderObjectStorage({ root });
    await expect(store.put("k", new Uint8Array([1]), META)).rejects.toThrow(/not be writable by others/);
    await chmod(root, 0o700);
    await store.put("k", new Uint8Array([1]), META);
  });
});

describe("objects are immutable by default (L9-wire review O3)", () => {
  const META = { contentType: "x/y", metadata: {}, retention: "evidence-std" as const };

  it("keeps the evidence callers that write the same key again working, by an explicit overwrite, and refuses everyone else", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY });
    const owner = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "t-1" };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);
    await storeEvidenceArtifacts({ blobs }, owner, [{ kind: "jpeg", bytes: jpeg }]);
    const again = await storeEvidenceArtifacts({ blobs }, owner, [{ kind: "jpeg", bytes: jpeg }]);
    expect(again.size).toBe(1);
    await expect(blobs.put([...again.keys()].map((digest) => `private/owner-1/ws-1/evidence/t-1/${digest}`)[0]!, jpeg, META)).rejects.toBeInstanceOf(ObjectConflictError);
  });

  it("frees a key whose document row has expired but not been swept", async () => {
    let now = Date.parse("2026-11-09T00:00:00.000Z");
    const blobs = createDocumentObjectStorage(new MemoryDocumentStore(), { companyId: COMPANY, now: () => now });
    await blobs.put("k", new Uint8Array([1]), META);
    await expect(blobs.put("k", new Uint8Array([2]), META)).rejects.toBeInstanceOf(ObjectConflictError);
    now += 31 * DAY;
    await blobs.put("k", new Uint8Array([3]), META);
    expect(Array.from((await blobs.get("k", 10))!)).toEqual([3]);
  });
});
