// L4-E7: where the stand-in writer's sample data is kept, and the setup callback that takes it from the worker. Two companies and two projects share ONE document store and ONE bucket on purpose: nothing of one may reach another.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryObjectStorage } from "../support/memory-object-storage.js";
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

function bucket(): { storage: ObjectStorage; raw: MemoryObjectStorage } {
  const raw = new MemoryObjectStorage({ maxObjectBytes: 1_000_000 });
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
    // A number is never reused: after A, B and back to A, a new set C is version 3, not 2.
    const third = setOf({ bio: "A third bio, written in a later setup run." });
    expect(await w.store.put(A, "demo", RUN(5), third)).toMatchObject({ version: 3, created: true });
    expect(await w.store.put(A, "demo", RUN(6), second)).toMatchObject({ version: 2 });
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
});
