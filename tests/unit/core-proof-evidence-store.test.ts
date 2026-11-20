// Proof and evidence P6: the evidence store (magic bytes, caps, a retention class per kind), the read rule (only what the current pack names as available, checked on every request) and the erase by
// prefix. (Port lane L7b: the store is the evidence blob store port over the document store, not a bucket; the signed address and the lifecycle rules of Cloud's bucket are not here.)
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_RETENTION, EVIDENCE_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, buildApiSample, type EvidenceView } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DOCUMENT_BLOB_MAX_BYTES, createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import {
  deleteEvidenceArtifacts, evidenceArtifactKey, evidenceBytesAreKind, readEvidenceArtifact, statEvidenceArtifacts, storeEvidenceArtifacts, type EvidenceReadDependencies,
} from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { evidenceViewOf } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { eraseTaskEvidence, eraseWorkspaceEvidence, evidencePrefixesOf } from "../../packages/broker/src/core/proof/evidence-erase.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 3)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(500, 4)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500, 5)]);
const SAMPLE = Buffer.from(buildApiSample({ method: "GET", path: "/o", status: 200, responseHeaders: { "content-type": "application/json" }, responseBody: Buffer.from('{"a":1}') }).bytes!);
const TAIL = Buffer.from("3 failed\nAssertionError: expected 1 to be 2\n");
const OWNER = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "t-1" };
const COMPANY = "org_00000000000000000000";

function memory(now = () => Date.parse("2026-11-09T00:00:00.000Z")) {
  const documents = new MemoryDocumentStore();
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY, now });
  const keys = async () => (await documents.query({ pk: `ORG#${COMPANY}#EVIDENCE_BLOB` })).items.map((item) => item.sk);
  return { documents, blobs, store: { blobs }, keys };
}

describe("the evidence blob store over the document store", () => {

  it("expires an object by its class: the days the contracts name for it", async () => {
    const now = Date.parse("2026-11-09T00:00:00.000Z");
    const m = memory(() => now);
    await m.blobs.put("a", TAIL, { contentType: "text/plain", metadata: {}, retention: "evidence-std" });
    await m.blobs.put("b", WEBM, { contentType: "video/webm", metadata: {}, retention: "evidence-short" });
    expect((await m.documents.get({ pk: `ORG#${COMPANY}#EVIDENCE_BLOB`, sk: "a" }))![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(now / 1000) + EVIDENCE_RETENTION_DAYS["evidence-std"].default * 86_400);
    expect((await m.documents.get({ pk: `ORG#${COMPANY}#EVIDENCE_BLOB`, sk: "b" }))![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(now / 1000) + EVIDENCE_RETENTION_DAYS["evidence-short"].default * 86_400);
    const custom = createDocumentEvidenceBlobStore(m.documents, { companyId: COMPANY, now: () => now, retentionDays: { "evidence-std": 7 } });
    await custom.put("c", TAIL, { contentType: "text/plain", metadata: {}, retention: "evidence-std" });
    expect((await m.documents.get({ pk: `ORG#${COMPANY}#EVIDENCE_BLOB`, sk: "c" }))![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(now / 1000) + 7 * 86_400);
  });
});

describe("what the store keeps", () => {
  it("checks each kind by its bytes: magic numbers, caps, and that JSON and text really parse", () => {
    expect(evidenceBytesAreKind("jpeg", JPEG)).toBe(true);
    expect(evidenceBytesAreKind("webm", WEBM)).toBe(true);
    expect(evidenceBytesAreKind("trace_zip", ZIP)).toBe(true);
    expect(evidenceBytesAreKind("api_sample_json", SAMPLE)).toBe(true);
    expect(evidenceBytesAreKind("log_txt", TAIL)).toBe(true);
    expect(evidenceBytesAreKind("jpeg", WEBM)).toBe(false);
    expect(evidenceBytesAreKind("webm", JPEG)).toBe(false);
    expect(evidenceBytesAreKind("trace_zip", WEBM)).toBe(false);
    expect(evidenceBytesAreKind("api_sample_json", Buffer.from('{"a":1}'))).toBe(false);
    expect(evidenceBytesAreKind("api_sample_json", Buffer.from("not json"))).toBe(false);
    expect(evidenceBytesAreKind("log_txt", Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(evidenceBytesAreKind("log_txt", Buffer.from([0xc3, 0x28]))).toBe(false);
    expect(evidenceBytesAreKind("jpeg", new Uint8Array())).toBe(false);
    expect(evidenceBytesAreKind("jpeg", Buffer.concat([JPEG, Buffer.alloc(EVIDENCE_ARTIFACT_MAX_BYTES.jpeg)]))).toBe(false);
    expect(evidenceBytesAreKind("log_txt", Buffer.alloc(EVIDENCE_ARTIFACT_MAX_BYTES.log_txt + 1, 0x61))).toBe(false);
  });

  it("skips bytes that are not the kind they claim, a digest that is not theirs, and a second write changes nothing", async () => {
    const m = memory();
    const stored = await storeEvidenceArtifacts(m.store, OWNER, [
      { kind: "jpeg", bytes: WEBM }, { kind: "jpeg", bytes: JPEG, sha256: "f".repeat(64) }, { kind: "webm", bytes: Buffer.from("junk") }, { kind: "jpeg", bytes: JPEG }, { kind: "jpeg", bytes: JPEG }]);
    expect([...stored.keys()]).toEqual([sha(JPEG)]);
    expect(await m.keys()).toHaveLength(1);
  });

  it("leaves out an object this store cannot hold, so the pack builder loses its link; it never stores the pack's own class", async () => {
    const m = memory();
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.min(EVIDENCE_ARTIFACT_MAX_BYTES.jpeg, DOCUMENT_BLOB_MAX_BYTES + 10), 7)]);
    const stored = await storeEvidenceArtifacts(m.store, OWNER, [{ kind: "jpeg", bytes: big }, { kind: "log_txt", bytes: TAIL }]);
    expect([...stored.keys()]).toEqual([sha(TAIL)]);
    for (const kind of Object.keys(EVIDENCE_ARTIFACT_RETENTION) as Array<keyof typeof EVIDENCE_ARTIFACT_RETENTION>) expect(EVIDENCE_ARTIFACT_RETENTION[kind]).not.toBe("evidence-record");
  });

  it("reports what it really holds, kind and size from the object, and nothing for a digest it does not", async () => {
    const m = memory();
    await storeEvidenceArtifacts(m.store, OWNER, [{ kind: "jpeg", bytes: JPEG }]);
    const held = await statEvidenceArtifacts(m.store, OWNER, [sha(JPEG), "e".repeat(64), "not a digest", sha(JPEG)]);
    expect([...held.entries()]).toEqual([[sha(JPEG), { kind: "jpeg", bytes: JPEG.length }]]);
    expect((await statEvidenceArtifacts(m.store, { ownerKey: "other", workspaceId: "ws-1", taskId: "t-1" }, [sha(JPEG)])).size).toBe(0);
  });

  it("deletes withheld artifacts, reports the ones it could not, and hands each failure to the caller's retry queue with the key and the digest", async () => {
    const m = memory();
    await storeEvidenceArtifacts(m.store, OWNER, [{ kind: "webm", bytes: WEBM }]);
    expect(await deleteEvidenceArtifacts(m.store, OWNER, [{ sha256: sha(WEBM) }, { sha256: "bad" }])).toEqual([]);
    expect(await m.keys()).toEqual([]);
    const failing = { blobs: { ...m.blobs, delete: async () => { throw new Error("denied"); } } };
    const seen: Array<{ key: string; sha256: string }> = [];
    expect(await deleteEvidenceArtifacts(failing, OWNER, [{ sha256: sha(WEBM) }], (failure) => { seen.push(failure); })).toEqual([sha(WEBM)]);
    expect(seen).toEqual([{ key: evidenceArtifactKey("owner-1", "ws-1", "t-1", sha(WEBM)), sha256: sha(WEBM) }]);
  });

  it("keeps the same bytes of two tasks as two objects, so deleting one task's artifact never deletes the other's (I4)", async () => {
    const m = memory();
    const other = { ...OWNER, taskId: "t-2" };
    await storeEvidenceArtifacts(m.store, OWNER, [{ kind: "jpeg", bytes: JPEG }]);
    await storeEvidenceArtifacts(m.store, other, [{ kind: "jpeg", bytes: JPEG }]);
    expect(await m.keys()).toHaveLength(2);
    expect(await deleteEvidenceArtifacts(m.store, OWNER, [{ sha256: sha(JPEG) }])).toEqual([]);
    expect(await m.keys()).toEqual([evidenceArtifactKey("owner-1", "ws-1", "t-2", sha(JPEG))]);
    expect((await statEvidenceArtifacts(m.store, OWNER, [sha(JPEG)])).size).toBe(0);
    expect((await statEvidenceArtifacts(m.store, other, [sha(JPEG)])).size).toBe(1);
  });

  it("refuses a task id that is not a plain id (it becomes part of a key)", async () => {
    const m = memory();
    for (const taskId of ["", "../x", "a/b", "a b", "x".repeat(65)]) {
      await expect(storeEvidenceArtifacts(m.store, { ...OWNER, taskId }, [{ kind: "jpeg", bytes: JPEG }])).rejects.toThrow(/names its task/);
    }
    expect(await m.keys()).toEqual([]);
  });
});

// ---- the read

const DIGEST = "c".repeat(64);
function viewWith(links: Array<{ kind: keyof typeof EVIDENCE_ARTIFACT_RETENTION; bytes: Uint8Array; state?: "available" | "expired" }>, candidateDigest = DIGEST): EvidenceView {
  const refs = links.map((item) => ({ kind: item.kind, sha256: sha(item.bytes), bytes: item.bytes.byteLength, retentionClass: EVIDENCE_ARTIFACT_RETENTION[item.kind] }));
  const pack = { schemaVersion: 1 as const, candidateDigest, environment: { tier: "sandbox" as const, envRevision: 1, services: [], data: "synthetic" as const, accounts: [{ profileId: "buyer", kind: "run_scoped" as const }] },
    checks: [], selection: { method: "full" as const, selected: 0, total: 0 }, notTested: [],
    api: [{ scenarioId: "orders", samples: refs.filter((ref) => ref.kind === "api_sample_json"), diff: "none" as const, changedPaths: [] }],
    browser: [{ scenarioId: "checkout", strip: { before: [], after: refs.filter((ref) => ref.kind === "jpeg") }, consoleErrors: 0,
      ...(refs.find((ref) => ref.kind === "webm") === undefined ? {} : { video: refs.find((ref) => ref.kind === "webm") }), ...(refs.find((ref) => ref.kind === "trace_zip") === undefined ? {} : { trace: refs.find((ref) => ref.kind === "trace_zip") }) }] };
  const states = new Map(links.map((item) => [sha(item.bytes), item.state ?? "available"] as const));
  return evidenceViewOf(pack, "t-1", (ref) => states.get(ref.sha256) ?? "available")!;
}
async function setup(links: Parameters<typeof viewWith>[0], over: Partial<{ authorize: EvidenceReadDependencies["authorize"]; view: EvidenceView | undefined; candidateDigest: string | undefined }> = {}) {
  const m = memory();
  await storeEvidenceArtifacts(m.store, OWNER, links.map((item) => ({ kind: item.kind, bytes: item.bytes })));
  const deps: EvidenceReadDependencies = {
    authorize: over.authorize ?? (async () => ({ ownerKey: OWNER.ownerKey, workspaceId: OWNER.workspaceId, taskId: OWNER.taskId, candidateDigest: "candidateDigest" in over ? over.candidateDigest : DIGEST, view: "view" in over ? over.view : viewWith(links) })),
    store: m.store,
  };
  return { m, deps };
}

describe("the read rule", () => {
  const all = [{ kind: "jpeg" as const, bytes: JPEG }, { kind: "api_sample_json" as const, bytes: SAMPLE }, { kind: "webm" as const, bytes: WEBM }, { kind: "trace_zip" as const, bytes: ZIP }];

  it("reads an image inline, as bytes checked against the pack's own ref; the others as attachments", async () => {
    const { deps } = await setup(all);
    const image = await readEvidenceArtifact(deps, sha(JPEG));
    expect(image).toMatchObject({ status: 200, kind: "jpeg", contentType: "image/jpeg", disposition: "inline", retentionClass: "evidence-std" });
    expect(image.status === 200 && Buffer.from(image.bytes).equals(JPEG)).toBe(true);
    expect(await readEvidenceArtifact(deps, sha(SAMPLE))).toMatchObject({ status: 200, contentType: "application/json", disposition: "attachment" });
    expect(await readEvidenceArtifact(deps, sha(WEBM))).toMatchObject({ status: 200, kind: "webm", contentType: "video/webm", disposition: "attachment" });
    expect(await readEvidenceArtifact(deps, sha(ZIP))).toMatchObject({ status: 200, kind: "trace_zip", disposition: "attachment" });
  });

  it("is 404 for a hash the store holds but the current pack does not name (a withheld video, another candidate's file)", async () => {
    const { deps, m } = await setup(all);
    const stray = Buffer.concat([WEBM, Buffer.from("stray")]);
    await storeEvidenceArtifacts(m.store, OWNER, [{ kind: "webm", bytes: stray }]);
    expect(await m.keys()).toContain(evidenceArtifactKey("owner-1", "ws-1", "t-1", sha(stray)));
    expect(await readEvidenceArtifact(deps, sha(stray))).toEqual({ status: 404 });
    expect(await readEvidenceArtifact(deps, sha(Buffer.from("anything")))).toEqual({ status: 404 });
    expect(await readEvidenceArtifact(deps, "not a digest")).toEqual({ status: 404 });
  });

  it("is 404 when the object differs from what the pack says (size, digest or kind), and nothing leaves", async () => {
    const { deps, m } = await setup(all);
    const key = evidenceArtifactKey("owner-1", "ws-1", "t-1", sha(JPEG));
    // The test tampers with a stored object, so it overwrites on purpose (objects are immutable otherwise).
    await m.blobs.put(key, Buffer.concat([JPEG, Buffer.from("x")]), { contentType: "image/jpeg", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    expect(await readEvidenceArtifact(deps, sha(JPEG))).toEqual({ status: 404 });
    await m.blobs.put(key, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(JPEG.length - 4, 9)]), { contentType: "image/jpeg", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    expect(await readEvidenceArtifact(deps, sha(JPEG))).toEqual({ status: 404 });
  });

  it("is 403 for someone who may not read the task (and a task that does not exist as well), 403 when authorization says nothing, and 503 for any other fault", async () => {
    for (const code of ["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]) {
      expect((await readEvidenceArtifact((await setup(all, { authorize: async () => { throw Object.assign(new Error("no"), { code }); } })).deps, sha(JPEG))).status, code).toBe(403);
    }
    expect(await readEvidenceArtifact((await setup(all, { authorize: async () => undefined })).deps, sha(JPEG))).toEqual({ status: 403 });
    expect(await readEvidenceArtifact((await setup(all, { authorize: async () => { throw new Error("db down"); } })).deps, sha(JPEG))).toEqual({ status: 503 });
  });
});

describe("the erase", () => {
  it("names the pack's and the tails' prefixes for a task or a whole workspace, and refuses an id that could widen them", () => {
    expect(evidencePrefixesOf({ ownerKey: "o", workspaceId: "w", taskId: "t" })).toEqual(["private/o/w/evidence-pack/t/", "private/o/w/evidence/t/"]);
    expect(evidencePrefixesOf({ ownerKey: "o", workspaceId: "w" })).toEqual(["private/o/w/evidence-pack/", "private/o/w/evidence/"]);
    for (const bad of ["", "../x", "a/b", "a b", "-x", "x".repeat(129)]) {
      expect(evidencePrefixesOf({ ownerKey: bad, workspaceId: "w" }), bad).toBeUndefined();
      expect(evidencePrefixesOf({ ownerKey: "o", workspaceId: bad }), bad).toBeUndefined();
      expect(evidencePrefixesOf({ ownerKey: "o", workspaceId: "w", taskId: bad }), bad).toBeUndefined();
    }
  });

  it("deletes one task's pack and tails and nothing of another task, then a whole workspace, and nothing of another workspace", async () => {
    const m = memory();
    for (const task of ["t-1", "t-2"]) {
      await storeEvidenceArtifacts(m.store, { ...OWNER, taskId: task }, [{ kind: "log_txt", bytes: TAIL }]);
      await m.blobs.put(`private/owner-1/ws-1/evidence-pack/${task}/${DIGEST}.json`, Buffer.from("{}"), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
    }
    await storeEvidenceArtifacts(m.store, { ownerKey: "owner-1", workspaceId: "ws-2", taskId: "t-9" }, [{ kind: "log_txt", bytes: TAIL }]);
    expect(await eraseTaskEvidence(m.blobs, OWNER)).toBe(true);
    expect((await m.keys()).filter((key) => key.includes("/t-1/"))).toEqual([]);
    expect((await m.keys()).filter((key) => key.includes("/t-2/"))).toHaveLength(2);
    expect(await eraseWorkspaceEvidence(m.blobs, { ownerKey: "owner-1", workspaceId: "ws-1" })).toBe(true);
    expect(await m.keys()).toEqual([evidenceArtifactKey("owner-1", "ws-2", "t-9", sha(TAIL))]);
  });

  it("deletes nothing for an id that is not a plain id", async () => {
    const m = memory();
    await storeEvidenceArtifacts(m.store, OWNER, [{ kind: "log_txt", bytes: TAIL }]);
    await expect(eraseWorkspaceEvidence(m.blobs, { ownerKey: "owner-1", workspaceId: "../ws-1" })).rejects.toThrow(/plain ids/);
    await expect(eraseTaskEvidence(m.blobs, { ...OWNER, taskId: "" })).rejects.toThrow(/plain ids/);
    expect(await m.keys()).toHaveLength(1);
  });
});
