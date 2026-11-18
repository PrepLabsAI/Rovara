// L4-E7: where the stand-in writer's sample data is kept, and the setup callback that takes it from the worker. Two companies and two projects share ONE document store and ONE bucket on purpose: nothing of one may reach another.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderObjectStorage } from "../../packages/local-adapters/src/folder-object-storage.js";
import { ObjectConflictError } from "@agentx/contracts";
import {
  STANDIN_LIMITS, StandInWriterInputSchema, parseStandInWriterOutput, standInSetDigest, type ObjectStorage, type StandInWriterSet, type TestEnvProdDeny,
} from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FixtureObjectError, fixtureObjectPortOf } from "../../packages/broker/src/core/test-env/fixture-store-aws.js";
import { createStandInDataStore, standInObjectKey, type StandInDataStore } from "../../packages/broker/src/core/test-env/standin-data-store.js";
import { handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId; const B = COMPANY_B.orgId;
const NO_DENY: TestEnvProdDeny = { accountIds: [], hosts: [], arnPrefixes: [] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const REQUEST = StandInWriterInputSchema.parse({
  tables: [{ name: "creators", rows: 3, columns: [{ name: "id", kind: "integer", key: true, writable: false }, { name: "bio", kind: "text", key: false, writable: true, maxChars: 200 }, { name: "followers", kind: "integer", key: false, writable: true }] }],
  operations: [{ id: "tiktok-user", host: "open.tiktokapis.com", method: "GET", path: "/v2/user/info", answers: 2, fields: [{ path: "data.user.display_name", kind: "string", required: true }] }],
});
const setOf = (over: { bio?: string; followers?: number } = {}): StandInWriterSet => {
  const read = parseStandInWriterOutput(JSON.stringify({
    tables: { creators: [{ bio: over.bio ?? "Weekend baker sharing quick recipes.", followers: over.followers ?? 12044 }, { bio: "Slow travel around West Africa.", followers: 880 }] },
    answers: { "tiktok-user": [{ data: { user: { display_name: "Mara Okafor" } } }] },
  }), REQUEST);
  if (!read.ok) throw new Error("fixture");
  return read.set;
};

function bucket(): { storage: ObjectStorage; raw: FolderObjectStorage } {
  const root = mkdtempSync(join(tmpdir(), "standin-objects-"));
  dirs.push(root);
  const raw = new FolderObjectStorage({ root: join(root, "store"), maxObjectBytes: 1_000_000 });
  return { storage: raw, raw };
}
function world(options: { deny?: () => Promise<TestEnvProdDeny>; storage?: ObjectStorage } = {}) {
  const b = bucket();
  const documents = new MemoryDocumentStore();
  const objects = fixtureObjectPortOf(options.storage ?? b.storage);
  const make = (): StandInDataStore => createStandInDataStore({ objects, documents, denyFor: options.deny ?? (async () => NO_DENY), now: () => new Date("2026-11-18T10:00:00.000Z") });
  return { documents, objects, storage: b.storage, store: make(), make };
}
const RUN = (n = 1) => ({ taskId: `00000000-0000-4000-8000-00000000000${String(n)}`, actor: "rovara-stand-in-writer" });

describe("the store keeps one versioned set per project, written once per run", () => {
  it("round-trips a set, whole, and says which version the project is at (what E4 hashes into the stand-in version)", async () => {
    const w = world();
    const set = setOf();
    const stored = await w.store.put(A, "demo", RUN(), set);
    expect(stored).toEqual({ ok: true, digest: standInSetDigest(set), version: 1, created: true });
    const read = await w.store.current(A, "demo");
    expect(read).toEqual({ ok: true, set, digest: standInSetDigest(set), version: 1 });
    expect(await w.store.versionOf(A, "demo")).toEqual({ digest: standInSetDigest(set), version: 1 });
    // The same for every run: reading twice is the same bytes and digest.
    const again = await w.store.current(A, "demo");
    expect(again.ok && read.ok && standInSetDigest(again.set) === standInSetDigest(read.set)).toBe(true);
  });
  it("a different set from a later run is the next version; the same set again is the same version", async () => {
    const w = world();
    const first = setOf(); const second = setOf({ bio: "Former line cook turned food writer." });
    expect(await w.store.put(A, "demo", RUN(1), first)).toMatchObject({ version: 1, created: true });
    expect(await w.store.put(A, "demo", RUN(2), second)).toMatchObject({ version: 2, created: true, digest: standInSetDigest(second) });
    expect(await w.store.put(A, "demo", RUN(3), second)).toMatchObject({ version: 2, created: false });
    expect((await w.store.current(A, "demo"))).toMatchObject({ ok: true, version: 2 });
    // Going back to the first set is a pointer move to the version it already had, not a new number.
    expect(await w.store.put(A, "demo", RUN(4), first)).toMatchObject({ version: 1, created: true });
    expect(await w.store.versionOf(A, "demo")).toEqual({ digest: standInSetDigest(first), version: 1 });
  });
  it("accepts ONE set per setup run: a second from the same run is refused and changes nothing", async () => {
    const w = world();
    expect(await w.store.put(A, "demo", RUN(1), setOf())).toMatchObject({ ok: true });
    expect(await w.store.put(A, "demo", RUN(1), setOf({ bio: "A different bio altogether." }))).toEqual({ ok: false, reason: "already_stored" });
    expect((await w.store.versionOf(A, "demo"))?.version).toBe(1);
  });
  it("two writers racing the same new set both end at one version, one set", async () => {
    const w = world();
    const results = await Promise.all([w.store.put(A, "demo", RUN(1), setOf()), w.make().put(A, "demo", RUN(2), setOf())]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await w.store.versionOf(A, "demo"))?.version).toBe(1);
  });
  it("is bounded: a set over the bytes cap, a set that is not the writer's and a bad run are refused", async () => {
    const w = world();
    const big = { ...setOf(), tables: Object.fromEntries(Array.from({ length: 20 }, (_, t) => [`table_${String(t)}`, Array.from({ length: 50 }, (_, i) => ({ bio: `${"é".repeat(390)}${String(i % 10)}` }))])) };
    expect(await w.store.put(A, "demo", RUN(), big)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await w.store.put(A, "demo", RUN(), { ...setOf(), writer: "someone-else" })).toEqual({ ok: false, reason: "invalid" });
    expect(await w.store.put(A, "demo", RUN(), { ...setOf(), extra: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(await w.store.put(A, "demo", { taskId: "", actor: "x" }, setOf())).toEqual({ ok: false, reason: "bad_run" });
    expect(await w.store.put(A, "demo", { taskId: "t1", actor: " " }, setOf())).toEqual({ ok: false, reason: "bad_run" });
    expect(await w.store.put("not-an-org", "demo", RUN(), setOf())).toEqual({ ok: false, reason: "bad_org" });
    expect(await w.store.put(A, "Bad Project!", RUN(), setOf())).toEqual({ ok: false, reason: "bad_project" });
    expect(await w.store.versionOf(A, "demo")).toBeUndefined();
    expect(STANDIN_LIMITS.setBytes).toBe(32 * 1_024);
  });
});

describe("two companies and two projects share one bucket and one table, and never see each other's data", () => {
  it("a set is found only by the company and project that stored it; the others get the same answer as nothing stored", async () => {
    const w = world();
    const mine = setOf({ bio: "Company A creator bio, only for A." });
    await w.store.put(A, "demo", RUN(1), mine);
    await w.store.put(B, "demo", RUN(2), setOf({ bio: "Company B creator bio, only for B." }));
    await w.store.put(A, "other", RUN(3), setOf({ bio: "Project other of company A." }));
    const a = await w.store.current(A, "demo");
    expect(a.ok && JSON.stringify(a.set)).toContain("only for A");
    expect(a.ok && JSON.stringify(a.set)).not.toContain("only for B");
    const b = await w.store.current(B, "demo");
    expect(b.ok && JSON.stringify(b.set)).toContain("only for B");
    const other = await w.store.current(A, "other");
    expect(other.ok && JSON.stringify(other.set)).toContain("Project other");
    expect(await w.store.current(B, "other")).toEqual({ ok: false, reason: "none" });
    expect(await w.store.current(A, "missing")).toEqual({ ok: false, reason: "none" });
    expect(await w.store.versionOf(B, "other")).toBeUndefined();
    // Every key names the company and project first.
    expect(standInObjectKey(A, "demo", "d".repeat(64))).toBe(`private/${A}/standins/demo/${"d".repeat(64)}`);
  });
  it("the same set in two companies is two objects and two versions (a digest only another company holds is not found)", async () => {
    const w = world();
    const set = setOf();
    await w.store.put(A, "demo", RUN(1), set);
    expect(await w.store.current(B, "demo")).toEqual({ ok: false, reason: "none" });
    await w.store.put(B, "demo", RUN(2), set);
    expect((await w.store.versionOf(B, "demo"))?.version).toBe(1);
    // A run marker is per company and project: B's run id does not use up A's.
    expect(await w.store.put(A, "demo", RUN(2), setOf({ bio: "Another bio for company A." }))).toMatchObject({ ok: true, version: 2 });
  });
  it("a pointer row that names another company or project (a corrupt index) is not read", async () => {
    const w = world();
    await w.store.put(A, "demo", RUN(1), setOf());
    await w.store.put(B, "demo", RUN(2), setOf({ bio: "Company B creator bio." }));
    const pk = `ORG#${A}#STANDIN`;
    const row = await w.documents.get({ pk, sk: "C#demo" });
    await w.documents.put({ item: { ...row!, company: B } });
    expect(await w.store.current(A, "demo")).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(await w.store.versionOf(A, "demo")).toBeUndefined();
    await w.documents.put({ item: { ...row!, project: "other" } });
    expect(await w.store.current(A, "demo")).toEqual({ ok: false, reason: "digest_mismatch" });
  });
});

describe("nothing a real database holds, and nothing unsafe, is ever kept", () => {
  const rejected = async (set: unknown, deny?: TestEnvProdDeny) => {
    const w = world({ deny: async () => deny ?? NO_DENY });
    const result = await w.store.put(A, "demo", RUN(), set);
    return { result, version: await w.store.versionOf(A, "demo"), keys: [...(await w.documents.query({ pk: `ORG#${A}#STANDIN` })).items.map((item) => item.sk)] };
  };
  it("refuses a real-looking email, phone number, card, key or password in any cell or answer; nothing is stored, not even a run marker", async () => {
    for (const bio of ["Reach me at jane.doe@gmail.com for collabs.", "Call +44 20 7946 0958 anytime.", "Card 4111 1111 1111 1111 on file.", "key AKIAIOSFODNN7EXAMPLE is mine", "password=hunter2hunter2"]) {
      const { result, version, keys } = await rejected(setOf({ bio }));
      expect(result).toEqual({ ok: false, reason: "data_guard" });
      expect(version).toBeUndefined();
      expect(keys).toEqual([]);
    }
    const inAnswer = parseStandInWriterOutput(JSON.stringify({ answers: { "tiktok-user": [{ data: { user: { display_name: "Write to real.person@gmail.com" } } }] } }), REQUEST);
    if (!inAnswer.ok) throw new Error("fixture");
    expect((await rejected(inAnswer.set)).result).toEqual({ ok: false, reason: "data_guard" });
  });
  it("allows the invented kind: names, bios, example.test addresses and the fictional phone range", async () => {
    const { result } = await rejected(setOf({ bio: "Write to mara@example.test or call +1 415 555 0100." }));
    expect(result).toMatchObject({ ok: true });
  });
  it("refuses a name from the project's production list, and a list that cannot be read stops the write (fail closed)", async () => {
    const deny: TestEnvProdDeny = { accountIds: ["123456789012"], hosts: ["api.acme-prod.com"], arnPrefixes: [] };
    expect((await rejected(setOf({ bio: "Posts mirrored from api.acme-prod.com daily." }), deny)).result).toEqual({ ok: false, reason: "data_guard" });
    const w = world({ deny: async () => { throw new Error("list unreadable"); } });
    expect(await w.store.put(A, "demo", RUN(), setOf())).toEqual({ ok: false, reason: "unavailable" });
    expect(await w.store.current(A, "demo")).toEqual({ ok: false, reason: "none" });
  });
  it("scans AGAIN at every read, with the list as it is now: a production name added later stops a stored set", async () => {
    let deny = NO_DENY;
    const w = world({ deny: async () => deny });
    await w.store.put(A, "demo", RUN(), setOf({ bio: "Mirrors posts from api.acme-prod.com." }));
    expect(await w.store.current(A, "demo")).toMatchObject({ ok: true });
    deny = { accountIds: [], hosts: ["api.acme-prod.com"], arnPrefixes: [] };
    expect(await w.store.current(A, "demo")).toEqual({ ok: false, reason: "data_guard" });
  });
  it("never hands out a stored object that no longer hashes to its digest, and repairs it from the same bytes on the next write", async () => {
    const w = world();
    const set = setOf();
    const stored = await w.store.put(A, "demo", RUN(1), set);
    if (!stored.ok) throw new Error("fixture");
    const key = standInObjectKey(A, "demo", stored.digest);
    await w.storage.put(key, new TextEncoder().encode(JSON.stringify({ tampered: true })), { contentType: "application/json", metadata: {}, retention: "fixture" }, { overwrite: true });
    expect(await w.store.current(A, "demo")).toEqual({ ok: false, reason: "digest_mismatch" });
    await w.storage.delete(key);
    expect(await w.store.current(A, "demo")).toEqual({ ok: false, reason: "none" });
    // A later run that writes the same set puts the object back (the pointer already names the digest).
    await w.documents.delete({ key: { pk: `ORG#${A}#STANDIN`, sk: "C#demo" } });
    expect(await w.store.put(A, "demo", RUN(2), set)).toMatchObject({ ok: true });
    expect(await w.store.current(A, "demo")).toMatchObject({ ok: true });
  });
  it("the data only ever holds what the writer wrote: the request that produced it holds no value to copy", () => {
    // The request has no field for a row; a row smuggled in is refused (see the contract tests), so no value of a real database can be in a set the writer wrote from it.
    expect(StandInWriterInputSchema.safeParse({ ...REQUEST, rows: [{ email: "jane.doe@gmail.com" }] }).success).toBe(false);
    expect(JSON.stringify(setOf())).not.toMatch(/gmail|@(?!example\.test)/u);
  });
});

describe("the fixture object port over the install's object storage (the AWS adapter)", () => {
  it("writes once, says `exists` for a key that is taken, replaces only an object still as observed, and reads at most N bytes", async () => {
    const b = bucket();
    const port = fixtureObjectPortOf(b.storage);
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(await port.putIfAbsent("private/x/y", bytes("one"), "application/json")).toBe("created");
    expect(await port.putIfAbsent("private/x/y", bytes("two"), "application/json")).toBe("exists");
    expect(new TextDecoder().decode(await port.get("private/x/y", 100))).toBe("one");
    expect(await port.get("private/x/missing", 100)).toBeUndefined();
    expect(await port.get("private/x/y", 2)).toBeUndefined();
    expect(await port.replaceIfUnchanged("private/x/y", bytes("zzz"), bytes("three"), "application/json")).toBe("changed");
    expect(await port.replaceIfUnchanged("private/x/y", bytes("one"), bytes("three"), "application/json")).toBe("replaced");
    expect(new TextDecoder().decode(await port.get("private/x/y", 100))).toBe("three");
    expect(await port.replaceIfUnchanged("private/x/none", bytes("a"), bytes("b"), "application/json")).toBe("changed");
  });
  it("hands out no signed read without a signer; with one it signs exactly the key", async () => {
    const b = bucket();
    await expect(fixtureObjectPortOf(b.storage).presignGet("k", 900)).rejects.toBeInstanceOf(FixtureObjectError);
    expect(await fixtureObjectPortOf(b.storage, { presign: async (key, seconds) => `https://signed.invalid/${key}?e=${String(seconds)}` }).presignGet("private/a", 900)).toBe("https://signed.invalid/private/a?e=900");
  });
  it("never carries the storage's own words: a storage failure is the fixed error", async () => {
    const broken: ObjectStorage = {
      put: async () => { throw new Error("AccessDenied on bucket secret-bucket key private/org/x"); }, get: async () => { throw new Error("secret-bucket down"); },
      stat: async () => undefined, delete: async () => undefined, deletePrefix: async () => true,
    };
    const port = fixtureObjectPortOf(broken);
    for (const call of [() => port.putIfAbsent("k", new Uint8Array(1), "x"), () => port.get("k", 10), () => port.replaceIfUnchanged("k", new Uint8Array(1), new Uint8Array(1), "x")]) {
      const error = await call().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FixtureObjectError);
      expect(String((error as Error).message)).not.toContain("secret-bucket");
    }
    const conflict: ObjectStorage = { ...broken, put: async (key) => { throw new ObjectConflictError(key); } };
    expect(await fixtureObjectPortOf(conflict).putIfAbsent("k", new Uint8Array(1), "x")).toBe("exists");
  });
});

// ---- the worker's callback

async function callbackWorld(companyId: string, shared: { documents: MemoryDocumentStore; objects: ReturnType<typeof fixtureObjectPortOf> }, project = "demo") {
  const workspaceId = randomUUID(); const taskId = randomUUID();
  const store = shared.documents;
  await store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId, purpose: "setup_agent" } });
  await store.put({ item: { ...setupAgentKey(companyId, project), entityType: "SETUP_AGENT", taskId } });
  const operation = { kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", workspaceId, companyId };
  const call = (body: unknown, over: { objects?: typeof shared.objects | undefined; op?: object } = {}) => handleSetupAgentCallback({ store, companyId, now: () => Date.parse("2026-11-18T10:00:00.000Z"), standInObjects: "objects" in over ? over.objects : shared.objects }, (over.op ?? operation) as never, body);
  return { taskId, workspaceId, operation, call };
}

describe("the setup callback takes the writer's set", () => {
  const shared = () => { const b = bucket(); return { documents: new MemoryDocumentStore(), objects: fixtureObjectPortOf(b.storage), storage: b.storage }; };
  it("stores the set for the AUTHENTICATED run's company and project (never named by the body), once, and answers a digest and a version", async () => {
    const s = shared();
    const a = await callbackWorld(A, s);
    const set = setOf();
    expect(await a.call({ kind: "stand_in_data", set })).toEqual({ stored: true, digest: standInSetDigest(set), version: 1 });
    expect(await a.call({ kind: "stand_in_data", set: setOf({ bio: "A second set from the same run." }) })).toEqual({ stored: false, reason: "already_stored" });
    const store = createStandInDataStore({ objects: s.objects, documents: s.documents, denyFor: async () => NO_DENY });
    expect((await store.current(A, "demo"))).toMatchObject({ ok: true, digest: standInSetDigest(set) });
    expect(await store.current(B, "demo")).toEqual({ ok: false, reason: "none" });
  });
  it("two companies' runs write two companies' data", async () => {
    const s = shared();
    const a = await callbackWorld(A, s); const b = await callbackWorld(B, s);
    await a.call({ kind: "stand_in_data", set: setOf({ bio: "Only company A should ever see this bio." }) });
    await b.call({ kind: "stand_in_data", set: setOf({ bio: "Only company B should ever see this bio." }) });
    const store = createStandInDataStore({ objects: s.objects, documents: s.documents, denyFor: async () => NO_DENY });
    const readA = await store.current(A, "demo"); const readB = await store.current(B, "demo");
    expect(readA.ok && JSON.stringify(readA.set)).toContain("company A");
    expect(readA.ok && JSON.stringify(readA.set)).not.toContain("company B");
    expect(readB.ok && JSON.stringify(readB.set)).toContain("company B");
    // A run of company A cannot be used to write company B's data: the callback is bound to the run's own company.
    expect(await a.call({ kind: "stand_in_data", set: setOf() }, { op: { ...a.operation, companyId: B } }).then(() => "answered", (error: Error) => error.message)).toContain("CALLBACK_FORBIDDEN");
  });
  it("refuses a body that names a company or project, answers `off` with no object storage, and refuses an operation that is not a running setup run", async () => {
    const s = shared();
    const a = await callbackWorld(A, s);
    await expect(a.call({ kind: "stand_in_data", set: setOf(), companyId: B })).rejects.toThrow(/not one of its shapes/u);
    await expect(a.call({ kind: "stand_in_data", set: setOf(), project: "other" })).rejects.toThrow(/not one of its shapes/u);
    expect(await a.call({ kind: "stand_in_data", set: setOf() }, { objects: undefined })).toEqual({ stored: false, reason: "off" });
    await expect(a.call({ kind: "stand_in_data", set: setOf() }, { op: { ...a.operation, status: "SUCCEEDED" } })).rejects.toThrow(/running setup run/u);
    await expect(a.call({ kind: "stand_in_data", set: setOf() }, { op: { ...a.operation, workflowMode: "IMPLEMENT" } })).rejects.toThrow(/running setup run/u);
    const store = createStandInDataStore({ objects: s.objects, documents: s.documents, denyFor: async () => NO_DENY });
    expect(await store.versionOf(A, "demo")).toBeUndefined();
  });
  it("answers a fixed reason for a set that is not the writer's or carries something unsafe, and stores nothing", async () => {
    const s = shared();
    const a = await callbackWorld(A, s);
    expect(await a.call({ kind: "stand_in_data", set: { hello: "world" } })).toEqual({ stored: false, reason: "invalid" });
    expect(await a.call({ kind: "stand_in_data", set: setOf({ bio: "Email jane.doe@gmail.com now." }) })).toEqual({ stored: false, reason: "data_guard" });
    expect(await a.call({ kind: "stand_in_data", set: setOf() })).toMatchObject({ stored: true });
  });
});
