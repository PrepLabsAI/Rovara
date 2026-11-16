// TE-H1 slice 2 (DEC 241b): the `browser-evidence` callback on the document store and object storage. Chunked and bounded, judged on the broker's own record of the operation (a live CHECKS operation that was sent the recipe), checked
// whole before a byte is kept, bound to its operation, workspace and company, and read back by the keeper only for the operation that made it.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type DocumentStore, type ObjectStorage } from "@agentx/contracts";
import { BROWSER_EVIDENCE_UPLOAD_MAX_BYTES, encodeBrowserEvidenceUpload, type BrowserEvidenceCaptured } from "../../packages/contracts/src/index.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { dropBrowserEvidenceUpload, handleBrowserEvidenceUpload, readBrowserEvidenceUpload, type BrowserEvidenceOperation } from "../../packages/broker/src/core/proof/browser-evidence-upload.js";
import { UPLOAD_CHUNK_BYTES, type UploadStores } from "../../packages/broker/src/core/e2e/uploads-chunks.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
const jpeg = (seed: string, size = 500) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const shot = (seed: string, size = 500) => { const bytes = jpeg(seed, size); return { bytes, sha256: sha(bytes) }; };
const run = (): BrowserEvidenceCaptured => ({ isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0,
  routes: [{ route: "/checkout", status: "shown", before: shot("a", 70_000), after: shot("b", 70_000), consoleErrors: { before: 0, after: 0 } }] });

const RECIPE = { startCommand: "npm run start", port: 4321, routes: [{ path: "/checkout", files: ["src/**"] }] };
const workspaceId = randomUUID();
const operationId = randomUUID();

async function world(options: { operation?: Record<string, unknown>; companyId?: string; objectsOf?: (inner: ObjectStorage) => ObjectStorage } = {}) {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const store: DocumentStore = new MemoryDocumentStore();
  const inner = createDocumentObjectStorage(store, { companyId });
  const objects = options.objectsOf === undefined ? inner : options.objectsOf(inner);
  const stores: UploadStores = { store, objects };
  const row = { ...operationKey(companyId, workspaceId, operationId), entityType: "OPERATION", companyId, id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING", fence: 1, dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: RECIPE } }, ...options.operation };
  await store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", companyId } });
  await store.put({ item: { pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId, workspaceId } });
  await store.put({ item: row });
  const operation = async (): Promise<BrowserEvidenceOperation> => (await store.get(operationKey(companyId, workspaceId, operationId))) as unknown as BrowserEvidenceOperation;
  const upload = async (captured: BrowserEvidenceCaptured = run(), overrides: { sha256?: string } = {}) => {
    const bytes = Buffer.from(encodeBrowserEvidenceUpload(captured));
    const digest = overrides.sha256 ?? sha(bytes);
    const op = await operation();
    const init = await handleBrowserEvidenceUpload(stores, op, { stage: "init", totalBytes: bytes.byteLength, chunkCount: Math.ceil(bytes.byteLength / UPLOAD_CHUNK_BYTES), sha256: digest }) as { uploadId: string; chunkCount: number };
    for (let index = 0; index < init.chunkCount; index += 1) {
      const chunk = bytes.subarray(index * UPLOAD_CHUNK_BYTES, Math.min((index + 1) * UPLOAD_CHUNK_BYTES, bytes.byteLength));
      await handleBrowserEvidenceUpload(stores, op, { stage: "chunk", uploadId: init.uploadId, index, bytesBase64: chunk.toString("base64"), sha256: sha(chunk) });
    }
    return { bytes, digest, uploadId: init.uploadId, op, finalize: () => handleBrowserEvidenceUpload(stores, op, { stage: "finalize", uploadId: init.uploadId, sha256: digest }) };
  };
  return { store, objects, stores, operation, upload };
}

describe("the browser-evidence callback", () => {
  it("keeps a run uploaded in chunks, whole, under its operation, and the keeper reads back exactly that run", async () => {
    const w = await world();
    const sent = await w.upload();
    expect(await sent.finalize()).toEqual({ complete: true, sha256: sent.digest });
    // The same finalize again (a retried request) answers the same.
    expect(await sent.finalize()).toEqual({ complete: true, sha256: sent.digest });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toEqual(run());
    // The staged chunks are gone; the assembled object lives under the operation's own prefix.
    expect((await w.store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#EVIDENCE_BLOB` })).items.map((item) => item.sk).filter((key) => key.includes("browser-evidence-staging"))).toEqual([]);
    await dropBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toBeUndefined();
  });

  it("is bound to the operation: another operation, another workspace, or a missing upload reads nothing", async () => {
    const w = await world();
    await (await w.upload()).finalize();
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: randomUUID() })).toBeUndefined();
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId: randomUUID(), id: operationId })).toBeUndefined();
    // A row copied under another operation's key does not make that operation's upload: the row names its own operation and workspace.
    const row = await w.store.get({ pk: (await w.operation()).pk, sk: `BROWSER_EVIDENCE_UPLOAD#${operationId}` });
    const otherOperation = randomUUID();
    await w.store.put({ item: { ...row!, pk: (await w.operation()).pk, sk: `BROWSER_EVIDENCE_UPLOAD#${otherOperation}` } });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: otherOperation })).toBeUndefined();
  });

  it("refuses an object that is not the digest the row names, an object outside the operation's prefix even when it is really there, and a row of another workspace", async () => {
    const w = await world();
    const sent = await w.upload();
    await sent.finalize();
    const rowKey = { pk: (await w.operation()).pk, sk: `BROWSER_EVIDENCE_UPLOAD#${operationId}` };
    const row = (await w.store.get(rowKey))!;
    const objectKey = row["objectKey"] as string;
    // The object really exists at a key outside the operation's own prefix: the row naming it is still refused.
    const foreign = `browser-evidence/${randomUUID()}/${operationId}/${sent.digest}`;
    await w.objects.put(foreign, new Uint8Array(sent.bytes), { contentType: "application/octet-stream", metadata: {}, retention: "evidence-short" });
    await w.store.put({ item: { ...row, objectKey: foreign } });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toBeUndefined();
    // A row that names another workspace is refused though its key and operation are the right ones.
    await w.store.put({ item: { ...row, workspaceId: randomUUID() } });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toBeUndefined();
    // Bytes that are not the digest the row names (the object swapped under its own key) are not believed.
    await w.store.put({ item: row });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toEqual(run());
    await w.objects.delete(objectKey);
    await w.objects.put(objectKey, new Uint8Array(Buffer.from(encodeBrowserEvidenceUpload({ ...run(), durationMs: 1 }))), { contentType: "application/octet-stream", metadata: {}, retention: "evidence-short" });
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toBeUndefined();
  });

  it("refuses every operation that is not the live CHECKS operation the broker sent the recipe to, each for its own reason", async () => {
    // The operation is the broker's own record, as the callback layer reads it: one field is changed at a time, so each refusal is for that field alone.
    const stage = async (operation: Record<string, unknown>) => { const w = await world({ operation }); return handleBrowserEvidenceUpload(w.stores, await w.operation(), { stage: "init", totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) }); };
    await expect(stage({})).resolves.toMatchObject({ chunkCount: 1 });
    await rejects(stage({ workflowMode: "IMPLEMENT" }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ workflowMode: "REVIEW" }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ status: "SUCCEEDED" }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ status: "FAILED" }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ kind: "publish" }), "CALLBACK_FORBIDDEN");
    // Never asked: the invocation carried no recipe, or one the schema refuses, or no invocation at all.
    await rejects(stage({ dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evidenceCapture: true } } }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: { ...RECIPE, port: 80 } } } }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: "yes" } } }), "CALLBACK_FORBIDDEN");
    await rejects(stage({ dispatch: { kind: "task" } }), "CALLBACK_FORBIDDEN");
  });

  it("bounds the upload before it keeps a byte, and refuses a chunk that is out of order, over its size or against its digest", async () => {
    const w = await world();
    const op = await w.operation();
    await rejects(handleBrowserEvidenceUpload(w.stores, op, { stage: "init", totalBytes: BROWSER_EVIDENCE_UPLOAD_MAX_BYTES + 1, chunkCount: Math.ceil((BROWSER_EVIDENCE_UPLOAD_MAX_BYTES + 1) / UPLOAD_CHUNK_BYTES), sha256: "a".repeat(64) }), "CONFIG_INVALID");
    await rejects(handleBrowserEvidenceUpload(w.stores, op, { stage: "init", totalBytes: 100, chunkCount: 5, sha256: "a".repeat(64) }), "CONFIG_INVALID");
    await rejects(handleBrowserEvidenceUpload(w.stores, op, { stage: "init", totalBytes: 100, chunkCount: 1, sha256: "a".repeat(64), extra: true }), "CONFIG_INVALID");
    await rejects(handleBrowserEvidenceUpload(w.stores, op, { stage: "chunk", uploadId: randomUUID(), index: 0, bytesBase64: "AAAA", sha256: "a".repeat(64) }), "STALE_FENCE");
    const sent = await w.upload();
    await rejects(handleBrowserEvidenceUpload(w.stores, sent.op, { stage: "chunk", uploadId: sent.uploadId, index: 99, bytesBase64: "AAAA", sha256: sha(Buffer.from("AAAA", "base64")) }), "CALLBACK_FORBIDDEN");
  });

  it("refuses a finalize whose bytes are not what was named, or are not a valid run, and keeps nothing of it", async () => {
    const lying = await world();
    const sentLying = await lying.upload(run(), { sha256: sha("something else") });
    await rejects(sentLying.finalize(), "CONFIG_INVALID");
    expect(await readBrowserEvidenceUpload(lying.stores, { ...(await lying.operation()), workspaceId, id: operationId })).toBeUndefined();
    // Bytes that match their digest but are not a run: a run is checked whole before it is kept.
    const w = await world();
    const op = await w.operation();
    const junk = Buffer.from("not a browser evidence run at all");
    const init = await handleBrowserEvidenceUpload(w.stores, op, { stage: "init", totalBytes: junk.byteLength, chunkCount: 1, sha256: sha(junk) }) as { uploadId: string };
    await handleBrowserEvidenceUpload(w.stores, op, { stage: "chunk", uploadId: init.uploadId, index: 0, bytesBase64: junk.toString("base64"), sha256: sha(junk) });
    await rejects(handleBrowserEvidenceUpload(w.stores, op, { stage: "finalize", uploadId: init.uploadId, sha256: sha(junk) }), "CONFIG_INVALID");
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toBeUndefined();
    expect((await w.store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#EVIDENCE_BLOB` })).items.map((item) => item.sk).filter((key) => key.startsWith("browser-evidence"))).toEqual([]);
  });

  it("takes no chunk and no other bytes once the upload has finished", async () => {
    const w = await world();
    const sent = await w.upload();
    await sent.finalize();
    await rejects(handleBrowserEvidenceUpload(w.stores, sent.op, { stage: "chunk", uploadId: sent.uploadId, index: 0, bytesBase64: Buffer.from("x").toString("base64"), sha256: sha("x") }), "STALE_FENCE");
    await rejects(handleBrowserEvidenceUpload(w.stores, sent.op, { stage: "finalize", uploadId: sent.uploadId, sha256: sha("other bytes") }), "CALLBACK_FORBIDDEN");
    await rejects(handleBrowserEvidenceUpload(w.stores, sent.op, { stage: "finalize", uploadId: randomUUID(), sha256: sent.digest }), "CALLBACK_FORBIDDEN");
    expect(await readBrowserEvidenceUpload(w.stores, { ...(await w.operation()), workspaceId, id: operationId })).toEqual(run());
  });

  it("refuses a second, different upload for the same operation", async () => {
    const w = await world();
    await w.upload();
    const bytes = Buffer.from(encodeBrowserEvidenceUpload({ ...run(), durationMs: 9 }));
    await rejects(handleBrowserEvidenceUpload(w.stores, await w.operation(), { stage: "init", totalBytes: bytes.byteLength, chunkCount: Math.ceil(bytes.byteLength / UPLOAD_CHUNK_BYTES), sha256: sha(bytes) }), "CALLBACK_FORBIDDEN");
  });
});

describe("the callback route", () => {
  it("is served on Code (the route exists in the handler's list of actions) and needs the capability like every other", async () => {
    const handler = createCallbackHandler({ flow: { store: new MemoryDocumentStore(), companyId: IMPLICIT_COMPANY_ID, callbackSigningKey: Buffer.alloc(32, 7) } as never, blobs: {} as never, grants: {} as never });
    const response = await handler({ method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/browser-evidence`, headers: {}, body: "{}" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const answer = JSON.parse(response.body ?? "{}") as { error: { code: string; message: string } };
    expect(answer.error.code).toBe("CALLBACK_FORBIDDEN");
    expect(answer.error.message).toBe("callback capability is required");
  });
});
