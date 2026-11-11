// The uploads a coding run makes for the browser and API checks, on the document store and object storage: committed source, its build source manifest and the unchanged code.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, ObjectTooBigError, type DocumentStore, type ObjectStorage } from "@agentx/contracts";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { handleBaselineSource, handleCandidateBuildSource, handleCandidateExport, readCandidateSourceExport } from "../../packages/broker/src/core/e2e/uploads.js";
import { UPLOAD_CHUNK_BYTES, type UploadOperation, type UploadStores } from "../../packages/broker/src/core/e2e/uploads-chunks.js";
import { createRealCandidate, disposeRealCandidates, type RealCandidate } from "../support/e2e-application-candidate.js";

afterEach(async () => { await disposeRealCandidates(); });

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const workspaceId = randomUUID();
const operationId = randomUUID();

function world(patch: Record<string, unknown> = {}, objectsOf?: (inner: ObjectStorage) => ObjectStorage) {
  const store: DocumentStore = new MemoryDocumentStore();
  const inner = createDocumentObjectStorage(store, { companyId: IMPLICIT_COMPANY_ID });
  const objects = objectsOf === undefined ? inner : objectsOf(inner);
  const stores: UploadStores = { store, objects };
  const seed = async (more: Record<string, unknown> = {}) => store.put({ item: { ...operationKey(workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task",
    workflowMode: "IMPLEMENT", status: "RUNNING", fence: 1, ...patch, ...more } });
  /** The operation as the callback layer reads it at the start of a request. */
  const operation = async (): Promise<UploadOperation> => (await store.get(operationKey(workspaceId, operationId))) as unknown as UploadOperation;
  const keysWith = async (needle: string) => (await store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#EVIDENCE_BLOB` })).items.map((item) => item.sk).filter((key) => key.includes(needle));
  return { store, objects, stores, seed, operation, keysWith };
}
type World = ReturnType<typeof world>;

const SCHEMA = {
  export: { init: "workflow-candidate-export-upload/v1", chunk: "workflow-candidate-export-chunk/v1", finalize: "workflow-candidate-export-finalize/v1" },
  build: { init: "workflow-candidate-build-source-upload/v1", chunk: "workflow-candidate-build-source-chunk/v1", finalize: "workflow-candidate-build-source-finalize/v1" },
  baseline: { init: "workflow-baseline-source-upload/v1", chunk: "workflow-baseline-source-chunk/v1", finalize: "workflow-baseline-source-finalize/v1" },
} as const;
type Kind = keyof typeof SCHEMA;
const handlerOf = { export: handleCandidateExport, build: handleCandidateBuildSource, baseline: handleBaselineSource } as const;

/** Streams `bytes` the way the worker does and answers every reply, so a test can stop or alter any step. */
async function upload(w: World, kind: Kind, bytes: Buffer, options: { stopBeforeFinalize?: boolean } = {}) {
  const handle = handlerOf[kind];
  const count = Math.ceil(bytes.byteLength / UPLOAD_CHUNK_BYTES);
  const digest = sha256(bytes);
  const init = await handle(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA[kind].init, totalBytes: bytes.byteLength, chunkCount: count, sha256: digest });
  const uploadId = init["uploadId"] as string;
  for (let index = 0; index < count; index += 1) {
    const chunk = bytes.subarray(index * UPLOAD_CHUNK_BYTES, Math.min((index + 1) * UPLOAD_CHUNK_BYTES, bytes.byteLength));
    await handle(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA[kind].chunk, uploadId, index, bytesBase64: chunk.toString("base64"), sha256: sha256(chunk) });
  }
  if (options.stopBeforeFinalize === true) return { uploadId, digest, finalized: undefined };
  const finalized = await handle(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA[kind].finalize, uploadId, sha256: digest });
  return { uploadId, digest, finalized };
}

const exportBytes = (candidate: RealCandidate) => Buffer.from(JSON.stringify(candidate.source), "utf8");
const TREE = { "package.json": "{\"name\":\"app\"}", "src/server.js": "console.log(1)\n" };
const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

describe("the candidate's committed source", () => {
  it("is checked against its tree, kept under its content address and recorded once on the coding operation", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world();
    await w.seed();
    const bytes = exportBytes(candidate);
    const { finalized } = await upload(w, "export", bytes);
    const digest = sha256(bytes);
    expect(finalized).toEqual({ sourceRef: { key: `workflow-candidate-sources/sha256/${digest}.json`, sha256: digest, byteLength: bytes.byteLength, candidateDigest: candidate.source.candidate.digest } });
    const row = await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${operationId}` });
    expect(row).toMatchObject({ entityType: "WORKFLOW_CANDIDATE_EXPORT", status: "COMPLETE", sourceRef: (finalized as { sourceRef: unknown }).sourceRef });
    const operation = await w.operation();
    expect(operation.candidateSourceRef).toEqual((finalized as { sourceRef: unknown }).sourceRef);
    expect(Buffer.from((await w.objects.get(`workflow-candidate-sources/sha256/${digest}.json`, bytes.byteLength))!).equals(bytes)).toBe(true);
    expect(await w.keysWith("staging")).toEqual([]);
    expect(await readCandidateSourceExport(w.stores, operation.candidateSourceRef as never)).toEqual(candidate.source);
  });

  it("answers a repeated finalize with the first answer and records nothing twice", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world();
    await w.seed();
    const first = await upload(w, "export", exportBytes(candidate));
    const again = await handleCandidateExport(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: first.uploadId, sha256: first.digest });
    expect(again).toEqual({ sourceRef: (first.finalized as { sourceRef: unknown }).sourceRef, duplicate: true });
  });

  it("takes a large export in many chunks, answers a repeated init with the same upload and a replayed chunk as a duplicate", async () => {
    // Long paths make the tree inventory large without going over the limit on how many blobs an export may carry.
    const folder = `src/${"a".repeat(100)}/${"b".repeat(100)}`;
    const many = Object.fromEntries(Array.from({ length: 450 }, (_, index) => [`${folder}/module-${String(index).padStart(5, "0")}.txt`, `${index}\n`]));
    const candidate = await createRealCandidate({ ...TREE, ...many });
    const bytes = exportBytes(candidate);
    expect(bytes.byteLength).toBeGreaterThan(UPLOAD_CHUNK_BYTES);
    const w = world();
    await w.seed();
    const count = Math.ceil(bytes.byteLength / UPLOAD_CHUNK_BYTES);
    const init = { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: bytes.byteLength, chunkCount: count, sha256: sha256(bytes) };
    const opened = await handleCandidateExport(w.stores, await w.operation(), init);
    expect(await handleCandidateExport(w.stores, await w.operation(), init)).toEqual(opened);
    const uploadId = opened["uploadId"] as string;
    const chunkOf = (index: number) => { const chunk = bytes.subarray(index * UPLOAD_CHUNK_BYTES, Math.min((index + 1) * UPLOAD_CHUNK_BYTES, bytes.byteLength)); return { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId, index, bytesBase64: chunk.toString("base64"), sha256: sha256(chunk) }; };
    expect(await handleCandidateExport(w.stores, await w.operation(), chunkOf(0))).toEqual({ accepted: true, index: 0, duplicate: false });
    expect(await handleCandidateExport(w.stores, await w.operation(), chunkOf(0))).toEqual({ accepted: true, index: 0, duplicate: true });
    for (let index = 1; index < count; index += 1) await handleCandidateExport(w.stores, await w.operation(), chunkOf(index));
    const done = await handleCandidateExport(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId, sha256: sha256(bytes) });
    expect(done).toMatchObject({ sourceRef: { byteLength: bytes.byteLength } });
  });

  it("refuses a replayed chunk whose bytes differ from the ones kept, and a chunk that skips ahead", async () => {
    const w = world();
    await w.seed();
    const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 5, 7);
    const count = 3;
    const opened = await handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: bytes.byteLength, chunkCount: count, sha256: sha256(bytes) });
    const uploadId = opened["uploadId"] as string;
    const chunk = (index: number, content: Buffer) => ({ stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId, index, bytesBase64: content.toString("base64"), sha256: sha256(content) });
    const first = bytes.subarray(0, UPLOAD_CHUNK_BYTES);
    await rejects(handleCandidateExport(w.stores, await w.operation(), chunk(1, bytes.subarray(UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2))), "CONFIG_INVALID");
    await handleCandidateExport(w.stores, await w.operation(), chunk(0, first));
    await rejects(handleCandidateExport(w.stores, await w.operation(), chunk(0, Buffer.alloc(UPLOAD_CHUNK_BYTES, 9))), "CALLBACK_FORBIDDEN");
  });

  it("refuses a chunk whose digest or size is wrong, and an upload that is empty, over its bound or chunked wrongly", async () => {
    const w = world();
    await w.seed();
    const opened = await handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) });
    const uploadId = opened["uploadId"] as string;
    const content = Buffer.alloc(10, 1);
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId, index: 0, bytesBase64: content.toString("base64"), sha256: "b".repeat(64) }), "CONFIG_INVALID");
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId, index: 0, bytesBase64: Buffer.alloc(9, 1).toString("base64"), sha256: sha256(Buffer.alloc(9, 1)) }), "CONFIG_INVALID");
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 0, chunkCount: 0, sha256: "a".repeat(64) }), "CONFIG_INVALID");
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 113 * 1024 * 1024, chunkCount: 1810, sha256: "a".repeat(64) }), "CONFIG_INVALID");
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 10, chunkCount: 2, sha256: "a".repeat(64) }), "CONFIG_INVALID");
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "init", totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) }), "CONFIG_INVALID");
  });

  it("is limited to a running coding operation, under the fence the upload began with", async () => {
    const w = world();
    await w.seed();
    const init = { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) };
    const base = await w.operation();
    await rejects(handleCandidateExport(w.stores, { ...base, workflowMode: "CHECKS" }, init), "CALLBACK_FORBIDDEN");
    await rejects(handleCandidateExport(w.stores, { ...base, workflowMode: "PLAN" }, init), "CALLBACK_FORBIDDEN");
    await rejects(handleCandidateExport(w.stores, { ...base, status: "SUCCEEDED" }, init), "CALLBACK_FORBIDDEN");
    await rejects(handleCandidateExport(w.stores, { ...base, kind: "publish" }, init), "CALLBACK_FORBIDDEN");
    const opened = await handleCandidateExport(w.stores, base, init);
    const chunk = { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId: opened["uploadId"], index: 0, bytesBase64: Buffer.alloc(10, 1).toString("base64"), sha256: sha256(Buffer.alloc(10, 1)) };
    await rejects(handleCandidateExport(w.stores, { ...base, fence: 2 }, chunk), "STALE_FENCE");
    await rejects(handleCandidateExport(w.stores, { ...base, fence: 2 }, init), "CALLBACK_FORBIDDEN");
  });

  it("is open to a delivered operation that has not reported running, and closed to one being cancelled", async () => {
    const delivered = world({ status: "DISPATCHING" });
    await delivered.seed();
    const init = { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) };
    await expect(handleCandidateExport(delivered.stores, await delivered.operation(), init)).resolves.toMatchObject({ chunkBytes: UPLOAD_CHUNK_BYTES });
    const unavailable = { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "none" };
    await expect(handleBaselineSource(delivered.stores, await delivered.operation(), unavailable)).resolves.toMatchObject({ accepted: false });
    expect((await delivered.operation()).baselineSource).toMatchObject({ status: "REFUSED" });
    for (const status of ["ACCEPTED", "CANCEL_REQUESTED", "CANCELLED", "FAILED", "INTERRUPTED"]) {
      await rejects(handleCandidateExport(delivered.stores, { ...(await delivered.operation()), status }, init), "CALLBACK_FORBIDDEN");
    }
  });

  it("refuses a second upload of other bytes and a chunk of another upload", async () => {
    const w = world();
    await w.seed();
    const opened = await handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) });
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 11, chunkCount: 1, sha256: "a".repeat(64) }), "CALLBACK_FORBIDDEN");
    const content = Buffer.alloc(10, 1);
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId: randomUUID(), index: 0, bytesBase64: content.toString("base64"), sha256: sha256(content) }), "CALLBACK_FORBIDDEN");
    await rejects(handleCandidateExport(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: opened["uploadId"], sha256: "a".repeat(64) }), "STALE_FENCE");
  });

  it("refuses an export whose manifest or blobs are not its committed tree, and records nothing", async () => {
    const candidate = await createRealCandidate(TREE);
    const wrongDigest = JSON.stringify({ ...candidate.source, candidate: { ...candidate.source.candidate, digest: "f".repeat(64) } });
    const blob = candidate.source.repositories[0]!.sources[0]!;
    const wrongBlob = JSON.stringify({ ...candidate.source, repositories: [{ ...candidate.source.repositories[0]!, sources: [{ ...blob, bytesBase64: Buffer.from("not the file\n").toString("base64") }, ...candidate.source.repositories[0]!.sources.slice(1)] }] });
    const extraKey = JSON.stringify({ ...candidate.source, extra: true });
    for (const text of [wrongDigest, wrongBlob, extraKey, "not json"]) {
      const w = world();
      await w.seed();
      await expect(upload(w, "export", Buffer.from(text, "utf8"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect((await w.operation()).candidateSourceRef).toBeUndefined();
      expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${operationId}` })).toMatchObject({ status: "OPEN" });
    }
  });

  it("does not answer a finalize from another fence, even after the upload finished", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world();
    await w.seed();
    const done = await upload(w, "export", exportBytes(candidate));
    await rejects(handleCandidateExport(w.stores, { ...(await w.operation()), fence: 2 }, { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: done.uploadId, sha256: done.digest }), "STALE_FENCE");
  });

  it("refuses chunks that are right one by one but are not the bytes the upload was opened for", async () => {
    const w = world();
    await w.seed();
    const content = Buffer.alloc(10, 1);
    const opened = await handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) });
    await handleCandidateExport(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId: opened["uploadId"], index: 0, bytesBase64: content.toString("base64"), sha256: sha256(content) });
    await expect(handleCandidateExport(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: opened["uploadId"], sha256: "a".repeat(64) })).rejects.toThrow(/do not match their stored digest/);
  });

  it("refuses an export whose candidate digest is not the digest of its repositories, though the rest agrees (the manifest's own schema holds the digest as well)", async () => {
    const candidate = await createRealCandidate(TREE);
    const repository = candidate.source.repositories[0]!;
    const commit = "1".repeat(40);
    const forged = { ...candidate.source, candidate: { ...candidate.source.candidate, repositories: [{ ...candidate.source.candidate.repositories[0]!, commitSha: commit }] }, repositories: [{ ...repository, commitSha: commit }] };
    const w = world();
    await w.seed();
    await expect(upload(w, "export", Buffer.from(JSON.stringify(forged), "utf8"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("records a source once: an operation that already carries one takes no second", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world();
    await w.seed();
    const started = await upload(w, "export", exportBytes(candidate), { stopBeforeFinalize: true });
    await w.store.update({ key: operationKey(workspaceId, operationId), ops: [{ op: "set", path: ["candidateSourceRef"], value: { key: "other", sha256: "b".repeat(64), byteLength: 1, candidateDigest: "c".repeat(64) } }] });
    await rejects(handleCandidateExport(w.stores, { ...(await w.operation()), candidateSourceRef: undefined }, { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: started.uploadId, sha256: started.digest }), "STALE_FENCE");
  });

  it("refuses blobs that together go over the aggregate bound, before keeping anything", async () => {
    const candidate = await createRealCandidate(TREE);
    const repository = candidate.source.repositories[0]!;
    const big = Buffer.alloc(450_000, 5).toString("base64");
    const heavy = { ...candidate.source, repositories: [{ ...repository, sources: Array.from({ length: 10 }, (_, index) => ({ path: `big-${index}.bin`, sha256: "a".repeat(64), bytesBase64: big, kind: "blob" as const })) }] };
    const w = world();
    await w.seed();
    await expect(upload(w, "export", Buffer.from(JSON.stringify(heavy), "utf8"))).rejects.toThrow(/aggregate bound/);
    expect(await w.keysWith("workflow-candidate-sources/")).toEqual([]);
  });

  it("says a source too large for this install's object storage in one fixed sentence", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world({}, (inner) => ({ ...inner, put: async (key, bytes, meta, options) => { if (key.startsWith("workflow-candidate-sources/")) throw new ObjectTooBigError(bytes.byteLength, 1); return inner.put(key, bytes, meta, options); },
      get: inner.get.bind(inner), stat: inner.stat.bind(inner), delete: inner.delete.bind(inner), deletePrefix: inner.deletePrefix.bind(inner) }));
    await w.seed();
    const { finalized, uploadId, digest } = await upload(w, "export", exportBytes(candidate));
    // The coding run's result is not held up for it: the answer says the source was not kept, the row says why, and nothing is left staged.
    expect(finalized).toEqual({ accepted: false, reason: "too-large" });
    const operation = await w.operation();
    expect(operation.candidateSourceRef).toBeUndefined();
    expect(operation.candidateSourceRefused).toBe("too-large");
    expect(await w.keysWith("staging")).toEqual([]);
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${operationId}` })).toMatchObject({ status: "REFUSED", refusedReason: "too-large" });
    expect(await handleCandidateExport(w.stores, operation, { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId, sha256: digest })).toEqual({ accepted: false, reason: "too-large", duplicate: true });
  });

  it("holds a code base over what the default object storage keeps (about 300 KB) to the same answer, and leaves no staged chunk", async () => {
    // 30 files of 8 KB: 240 KB of source, a bigger export than one object of the default storage can hold.
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`src/file-${String(index).padStart(2, "0")}.txt`, `${String(index).padStart(2, "0")}${"x".repeat(8 * 1024 - 3)}\n`]));
    const candidate = await createRealCandidate({ "package.json": "{\"name\":\"app\"}", ...files });
    const bytes = exportBytes(candidate);
    expect(bytes.byteLength).toBeGreaterThan(300 * 1024);
    const w = world();
    await w.seed();
    const { finalized } = await upload(w, "export", bytes);
    expect(finalized).toEqual({ accepted: false, reason: "too-large" });
    expect((await w.operation()).candidateSourceRefused).toBe("too-large");
    expect(await w.keysWith("staging")).toEqual([]);
  });

  it("does not keep what a worker staged when its upload is refused as not an export", async () => {
    const w = world();
    await w.seed();
    const junk = Buffer.from("not an export at all", "utf8");
    await expect(upload(w, "export", junk)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await w.keysWith("staging")).toEqual([]);
  });

  it("stages chunks under a short retention class, so a chunk an upload left behind expires by itself, and keeps the source under the class that stays", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world();
    await w.seed();
    const bytes = exportBytes(candidate);
    await upload(w, "export", bytes, { stopBeforeFinalize: true });
    const rows = (await w.store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#EVIDENCE_BLOB` })).items;
    const staged = rows.filter((item) => item.sk.includes("staging"));
    expect(staged.length).toBeGreaterThan(0);
    for (const row of staged) expect(row).toMatchObject({ retention: "evidence-short" });
    expect(staged.every((row) => typeof row[INDEX_EXPIRY_ATTRIBUTE] === "number")).toBe(true);
    const done = await handleCandidateExport(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: (await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${operationId}` }))!["uploadId"], sha256: sha256(bytes) });
    expect(done).toHaveProperty("sourceRef");
    const kept = (await w.store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#EVIDENCE_BLOB` })).items.find((item) => item.sk.startsWith("workflow-candidate-sources/"));
    expect(kept).toMatchObject({ retention: "task-document" });
  });

  it("does not keep the chunks of an upload whose bytes are not the digest it named", async () => {
    const w = world();
    await w.seed();
    const named = Buffer.from("abcd", "utf8");
    const sent = Buffer.from("abce", "utf8");
    const opened = await handleCandidateExport(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.export.init, totalBytes: 4, chunkCount: 1, sha256: sha256(named) });
    await handleCandidateExport(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.export.chunk, uploadId: opened["uploadId"], index: 0, bytesBase64: sent.toString("base64"), sha256: sha256(sent) });
    expect(await w.keysWith("staging")).toHaveLength(1);
    await expect(handleCandidateExport(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: opened["uploadId"], sha256: sha256(named) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await w.keysWith("staging")).toEqual([]);
  });

  it("refuses a recorded source for another operation's fence", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = world();
    await w.seed();
    const bytes = exportBytes(candidate);
    const started = await upload(w, "export", bytes, { stopBeforeFinalize: true });
    // The workspace moved on: the operation row is under a newer fence, so the finalize must not record.
    await w.seed({ fence: 2 });
    await rejects(handleCandidateExport(w.stores, { ...(await w.operation()), fence: 1 }, { stage: "finalize", schemaVersion: SCHEMA.export.finalize, uploadId: started.uploadId, sha256: started.digest }), "STALE_FENCE");
    expect((await w.operation()).candidateSourceRef).toBeUndefined();
  });
});

describe("the build source manifest of the candidate", () => {
  const exported = async (candidate: RealCandidate) => { const w = world(); await w.seed(); await upload(w, "export", exportBytes(candidate)); return w; };

  it("is judged against the stored export, kept under its content address and recorded on the export row and the operation", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = await exported(candidate);
    const { finalized } = await upload(w, "build", candidate.manifestBytes);
    expect(finalized).toMatchObject({ accepted: true, buildSource: candidate.stored });
    const operation = await w.operation();
    expect(operation.candidateBuildSource).toEqual(candidate.stored);
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${operationId}` })).toMatchObject({ buildSource: candidate.stored });
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_BUILD_SOURCE#${operationId}` })).toMatchObject({ status: "COMPLETE" });
    if (candidate.stored.status !== "READY") throw new Error("expected READY");
    expect(Buffer.from((await w.objects.get(candidate.stored.manifestRef.key, candidate.manifestBytes.byteLength))!).equals(candidate.manifestBytes)).toBe(true);
    expect(await w.keysWith("staging")).toEqual([]);
    // A repeat of the finished upload is the same answer.
    const again = await handleCandidateBuildSource(w.stores, operation, { stage: "finalize", schemaVersion: SCHEMA.build.finalize, uploadId: (await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_BUILD_SOURCE#${operationId}` }))!["uploadId"] as string, sha256: sha256(candidate.manifestBytes) });
    expect(again).toMatchObject({ accepted: true, duplicate: true });
  });

  it("follows a finalized export only", async () => {
    const w = world();
    await w.seed();
    await rejects(handleCandidateBuildSource(w.stores, await w.operation(), { stage: "unavailable", schemaVersion: SCHEMA.build.init.replace("upload", "unavailable"), reason: "none" }), "STALE_FENCE");
    await rejects(handleCandidateBuildSource(w.stores, { ...(await w.operation()), workflowMode: "CHECKS" }, { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "none" }), "CALLBACK_FORBIDDEN");
  });

  it("is a refusal, not an error, for a manifest of other code, and nothing about it is kept", async () => {
    const candidate = await createRealCandidate(TREE);
    const other = await createRealCandidate({ ...TREE, "src/other.js": "export {};\n" });
    const w = await exported(candidate);
    const { finalized } = await upload(w, "build", other.manifestBytes);
    expect(finalized).toMatchObject({ accepted: false, buildSource: { status: "REFUSED", candidateDigest: candidate.source.candidate.digest } });
    expect((await w.operation()).candidateBuildSource).toMatchObject({ status: "REFUSED" });
    expect(await w.keysWith("workflow-candidate-build-sources/")).toEqual([]);
  });

  it("does not keep what a worker staged for a build source when the code it follows can no longer be read", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = await exported(candidate);
    const sourceRef = (await w.operation()).candidateSourceRef as { key: string };
    const opened = await handleCandidateBuildSource(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.build.init, totalBytes: 4, chunkCount: 1, sha256: sha256(Buffer.from("abcd")) });
    const chunk = Buffer.from("abcd");
    await handleCandidateBuildSource(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.build.chunk, uploadId: opened["uploadId"], index: 0, bytesBase64: chunk.toString("base64"), sha256: sha256(chunk) });
    expect(await w.keysWith("workflow-candidate-build-source-staging/")).toHaveLength(1);
    await w.objects.delete(sourceRef.key);
    await expect(handleCandidateBuildSource(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.build.finalize, uploadId: opened["uploadId"], sha256: sha256(chunk) })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await w.keysWith("workflow-candidate-build-source-staging/")).toEqual([]);
  });

  it("records the worker's report that it has no manifest, closing an upload it abandoned and deleting what it staged", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = await exported(candidate);
    const opened = await handleCandidateBuildSource(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.build.init, totalBytes: 70_000, chunkCount: 2, sha256: "c".repeat(64) });
    const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 3);
    await handleCandidateBuildSource(w.stores, await w.operation(), { stage: "chunk", schemaVersion: SCHEMA.build.chunk, uploadId: opened["uploadId"], index: 0, bytesBase64: first.toString("base64"), sha256: sha256(first) });
    expect(await w.keysWith("workflow-candidate-build-source-staging/")).toHaveLength(1);
    const body = { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "no lockfile" };
    const answer = await handleCandidateBuildSource(w.stores, await w.operation(), body);
    expect(answer).toMatchObject({ accepted: false, buildSource: { status: "REFUSED", reason: "the worker could not export a build source manifest: no lockfile" } });
    expect(await w.keysWith("workflow-candidate-build-source-staging/")).toEqual([]);
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_BUILD_SOURCE#${operationId}` })).toMatchObject({ status: "ABORTED" });
    expect(await handleCandidateBuildSource(w.stores, await w.operation(), body)).toMatchObject({ accepted: false, duplicate: true });
    await rejects(handleCandidateBuildSource(w.stores, await w.operation(), { ...body, reason: "another reason" }), "CALLBACK_FORBIDDEN");
  });

  it("is recorded once: a later init is refused", async () => {
    const candidate = await createRealCandidate(TREE);
    const w = await exported(candidate);
    await handleCandidateBuildSource(w.stores, await w.operation(), { stage: "unavailable", schemaVersion: "workflow-candidate-build-source-unavailable/v1", reason: "none" });
    await rejects(handleCandidateBuildSource(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.build.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) }), "CALLBACK_FORBIDDEN");
  });
});

describe("the unchanged code for the baseline round", () => {
  const withBase = () => createRealCandidate({ ...TREE, "src/new.js": "export const x = 1;\n" }, { baseTree: TREE });
  const wireOf = (candidate: RealCandidate) => Buffer.from(JSON.stringify({ schemaVersion: "workflow-baseline-source/v1", sourceBase64: candidate.baseline!.sourceBytes.toString("base64"), manifestBase64: candidate.baseline!.manifestBytes.toString("base64") }), "utf8");

  it("is judged, kept under content addresses and recorded once on the coding operation", async () => {
    const candidate = await withBase();
    const w = world();
    await w.seed();
    const { finalized } = await upload(w, "baseline", wireOf(candidate));
    expect(finalized).toMatchObject({ accepted: true, baselineSource: candidate.baseline!.stored });
    expect((await w.operation()).baselineSource).toEqual(candidate.baseline!.stored);
    const stored = candidate.baseline!.stored;
    if (stored.status !== "READY") throw new Error("expected READY");
    expect(Buffer.from((await w.objects.get(stored.sourceRef.key, stored.sourceRef.byteLength))!).equals(candidate.baseline!.sourceBytes)).toBe(true);
    expect(Buffer.from((await w.objects.get(stored.buildSource.manifestRef.key, stored.buildSource.manifestRef.byteLength))!).equals(candidate.baseline!.manifestBytes)).toBe(true);
    expect(await w.keysWith("staging")).toEqual([]);
    expect(await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `BASELINE_SOURCE#${operationId}` })).toMatchObject({ status: "COMPLETE" });
    const again = await handleBaselineSource(w.stores, await w.operation(), { stage: "finalize", schemaVersion: SCHEMA.baseline.finalize, uploadId: (await w.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `BASELINE_SOURCE#${operationId}` }))!["uploadId"], sha256: sha256(wireOf(candidate)) });
    expect(again).toMatchObject({ accepted: true, duplicate: true });
  });

  it("records unchanged code this install cannot keep as a refusal with a fixed reason, never a lost result, and leaves nothing staged", async () => {
    const candidate = await withBase();
    const w = world({}, (inner) => ({ ...inner, put: async (key, bytes, meta, options) => { if (key.startsWith("workflow-baseline-sources/") || key.startsWith("workflow-candidate-sources/") || !key.includes("staging")) throw new ObjectTooBigError(bytes.byteLength, 1); return inner.put(key, bytes, meta, options); },
      get: inner.get.bind(inner), stat: inner.stat.bind(inner), delete: inner.delete.bind(inner), deletePrefix: inner.deletePrefix.bind(inner) }));
    await w.seed();
    const { finalized } = await upload(w, "baseline", wireOf(candidate));
    expect(finalized).toMatchObject({ accepted: false, baselineSource: { status: "REFUSED", reason: "the unchanged code is too large for this install's object storage" } });
    expect((await w.operation()).baselineSource).toMatchObject({ status: "REFUSED" });
    expect(await w.keysWith("staging")).toEqual([]);
  });

  it("records the report that the unchanged code could not be exported, once", async () => {
    const w = world();
    await w.seed();
    const body = { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "no base" };
    expect(await handleBaselineSource(w.stores, await w.operation(), body)).toMatchObject({ accepted: false, baselineSource: { status: "REFUSED", reason: "the worker could not export the unchanged code: no base" } });
    expect(await handleBaselineSource(w.stores, await w.operation(), body)).toMatchObject({ duplicate: true });
    await rejects(handleBaselineSource(w.stores, await w.operation(), { ...body, reason: "other" }), "CALLBACK_FORBIDDEN");
    await rejects(handleBaselineSource(w.stores, await w.operation(), { stage: "init", schemaVersion: SCHEMA.baseline.init, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) }), "CALLBACK_FORBIDDEN");
  });

  it("refuses an export that is the candidate (it records a base of its own) or is not one repository, and records nothing", async () => {
    const candidate = await withBase();
    const w = world();
    await w.seed();
    const notBase = Buffer.from(JSON.stringify({ schemaVersion: "workflow-baseline-source/v1", sourceBase64: Buffer.from(JSON.stringify(candidate.source), "utf8").toString("base64"), manifestBase64: candidate.baseline!.manifestBytes.toString("base64") }), "utf8");
    await expect(upload(w, "baseline", notBase)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await w.operation()).baselineSource).toBeUndefined();
    const w2 = world();
    await w2.seed();
    await expect(upload(w2, "baseline", Buffer.from("{\"schemaVersion\":\"other\"}", "utf8"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers from the record that won when another request recorded first, and refuses a different one", async () => {
    const w = world();
    await w.seed();
    const stale = await w.operation();
    await handleBaselineSource(w.stores, stale, { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "first" });
    await rejects(handleBaselineSource(w.stores, stale, { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "second" }), "CALLBACK_FORBIDDEN");
    expect(await handleBaselineSource(w.stores, stale, { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "first" })).toMatchObject({ duplicate: true });
  });

  it("is open to a running coding operation, or to a planning operation that was asked for it", async () => {
    const body = { stage: "unavailable", schemaVersion: "workflow-baseline-source-unavailable/v1", reason: "none" };
    const w = world({ workflowMode: "PLAN" });
    await w.seed();
    await rejects(handleBaselineSource(w.stores, await w.operation(), body), "CALLBACK_FORBIDDEN");
    const asked = world({ workflowMode: "PLAN", groundingSourceAsked: true });
    await asked.seed();
    expect(await handleBaselineSource(asked.stores, await asked.operation(), body)).toMatchObject({ baselineSource: { status: "REFUSED", reason: "the worker could not export the unchanged code for the plan" } });
    const checks = world({ workflowMode: "CHECKS" });
    await checks.seed();
    await rejects(handleBaselineSource(checks.stores, await checks.operation(), body), "CALLBACK_FORBIDDEN");
  });
});
