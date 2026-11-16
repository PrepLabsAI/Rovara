// TE-H1 browser evidence, slice 2: the `browser-evidence` callback. A CHECKS run that was sent the recipe (`payload.browserEvidence`) hands its before and after screenshots to the broker as ONE upload in 64 KiB chunks
// (init, chunk, finalize), the way the other chunked uploads of a run do (core/e2e/uploads-chunks.ts), bounded at `BROWSER_EVIDENCE_UPLOAD_MAX_BYTES` (the run's 4 MiB of pictures and a small header). The upload is
// judged HERE, never on the worker's word: the operation must be the live CHECKS operation of this install that the broker itself sent the recipe to (so a capture is bound to its task, its workspace and its company, which
// the callback layer read from the company's own store), the chunks arrive once and in order with their digests, and the whole is decoded and checked (`decodeBrowserEvidenceUpload`: the shape, every picture within the
// screenshot cap, all within the run's budget) before it is kept. What is kept is only the assembled bytes, under the operation's own prefix; the pictures reach the evidence store later, from the keeper, through
// `storeBrowserEvidence`, which stores each one only when it is a JPEG with the digest it names.
import { z } from "zod";
import { BROWSER_EVIDENCE_UPLOAD_MAX_BYTES, BrowserEvidencePayloadSchema, ObjectConflictError, agentXError, change, decodeBrowserEvidenceUpload, when, type BrowserEvidenceCaptured, type JsonValue } from "@agentx/contracts";
import {
  UPLOAD_CHUNK_BYTES, acceptChunk, assembleUpload, dropChunks, isLiveOperation, openUpload, parseUploadBody, requireCurrentUpload, sha256Of, uploadRowKey,
  type UploadOperation, type UploadSpec, type UploadStores,
} from "../e2e/uploads-chunks.js";

/** The operation as the callback layer read it: the upload fields, and the invocation the broker sent (its payload says whether this run was asked for browser evidence). */
export interface BrowserEvidenceOperation extends UploadOperation { dispatch?: { payload?: unknown } | undefined }

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const ENTITY = "BROWSER_EVIDENCE_UPLOAD";
const bodySchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("init"), totalBytes: z.number().int().positive().max(BROWSER_EVIDENCE_UPLOAD_MAX_BYTES), chunkCount: z.number().int().positive().max(Math.ceil(BROWSER_EVIDENCE_UPLOAD_MAX_BYTES / UPLOAD_CHUNK_BYTES)), sha256: SHA256 }).strict(),
  z.object({ stage: z.literal("chunk"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(), bytesBase64: z.string().min(1).max(Math.ceil(UPLOAD_CHUNK_BYTES * 4 / 3) + 8), sha256: SHA256 }).strict(),
  z.object({ stage: z.literal("finalize"), uploadId: z.string().uuid(), sha256: SHA256 }).strict(),
]);

const spec = (operation: Pick<UploadOperation, "workspaceId" | "id">): UploadSpec => ({
  label: "browser evidence", entityType: ENTITY, rowKey: uploadRowKey(operation.workspaceId, ENTITY, operation.id),
  stagingKey: (uploadId, index) => `browser-evidence-staging/${operation.workspaceId}/${operation.id}/${uploadId}/${index}.chunk`,
});
/** Where an assembled upload is kept: under its operation, named by its digest. */
const objectPrefix = (operation: Pick<UploadOperation, "workspaceId" | "id">): string => `browser-evidence/${operation.workspaceId}/${operation.id}/`;
/** Kept as long as the other short-lived evidence objects: it is only a hand-off to the keeper and expires on its own if nobody keeps it. */
const KEPT_RETENTION = "evidence-short";

/** Only the live CHECKS operation the broker sent the recipe to may upload. Anything else (another mode, an ended operation, a run that was never asked for browser evidence) is refused with one sentence. */
function requireAskedOperation(operation: BrowserEvidenceOperation): void {
  const payload = operation.dispatch?.payload;
  const asked = typeof payload === "object" && payload !== null && !Array.isArray(payload) && BrowserEvidencePayloadSchema.safeParse((payload as Record<string, unknown>)["browserEvidence"]).success;
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || !isLiveOperation(operation.status) || !asked) throw agentXError("CALLBACK_FORBIDDEN", "browser evidence uploads require the active CHECKS operation that was asked for it");
}

/** One request of the browser-evidence upload. Never keeps a byte the checks above refuse; a refused upload leaves no staged chunk. */
export async function handleBrowserEvidenceUpload(stores: UploadStores, operation: BrowserEvidenceOperation, rawBody: unknown): Promise<Record<string, JsonValue>> {
  requireAskedOperation(operation);
  const body = parseUploadBody(bodySchema, rawBody, "browser evidence upload");
  const upload = spec(operation);
  if (body.stage === "init") return openUpload(stores, operation, upload, body);
  const row = requireCurrentUpload(await stores.store.get(upload.rowKey), operation, upload);
  if (body.stage === "chunk") {
    if (row["status"] !== "OPEN") throw agentXError("STALE_FENCE", "browser evidence upload is not current");
    return acceptChunk(stores, operation, upload, row, body);
  }
  // finalize. The same finalize again (a retried request) answers the same.
  if (row["status"] === "COMPLETE") {
    if (row["uploadId"] !== body.uploadId || row["sha256"] !== body.sha256) throw agentXError("CALLBACK_FORBIDDEN", "browser evidence upload already finished with other bytes");
    return { complete: true, sha256: body.sha256 };
  }
  if (row["status"] !== "OPEN") throw agentXError("STALE_FENCE", "browser evidence upload is not current");
  const { bytes, chunkKeys } = await assembleUpload(stores, upload, row, body);
  try {
    // The whole is checked before a byte is kept: a run the check refuses is dropped with its chunks.
    decodeBrowserEvidenceUpload(bytes);
  } catch {
    await dropChunks(stores, chunkKeys);
    throw agentXError("CONFIG_INVALID", "browser evidence upload is not valid");
  }
  const objectKey = `${objectPrefix(operation)}${body.sha256}`;
  try {
    await stores.objects.put(objectKey, bytes, { contentType: "application/octet-stream", metadata: { sha256: body.sha256, operation: operation.id }, retention: KEPT_RETENTION });
  } catch (error) {
    // A retried finalize (or a crash between the object and the row) finds its own object: the same bytes go on, other bytes under a content address are a fault.
    if (!(error instanceof ObjectConflictError)) { await dropChunks(stores, chunkKeys); throw error; }
    const existing = await stores.objects.get(objectKey, BROWSER_EVIDENCE_UPLOAD_MAX_BYTES + 1);
    if (existing === undefined || sha256Of(existing) !== body.sha256) { await dropChunks(stores, chunkKeys); throw agentXError("RUNTIME_UNAVAILABLE", "an existing browser evidence object does not match its content address"); }
  }
  const moved = await stores.store.update({
    key: upload.rowKey, ops: [change.set("status", "COMPLETE"), change.set("objectKey", objectKey)],
    condition: when.and(when.eq("status", "OPEN"), when.eq("uploadId", body.uploadId), when.eq("sha256", body.sha256), when.eq("operationId", operation.id), when.eq("fence", operation.fence)),
  });
  await dropChunks(stores, chunkKeys);
  if (!moved.applied) throw agentXError("STALE_FENCE", "browser evidence upload is not current");
  return { complete: true, sha256: body.sha256 };
}

/**
 * The run an operation uploaded, for the keeper: undefined when there is none, it is not complete, it belongs to another operation or workspace, its object is not under this operation's own prefix, the bytes are not
 * the digest the row names, or it does not decode. Never throws. Read again with the same checks as the upload, so a row or object made by anything else is never believed.
 */
export async function readBrowserEvidenceUpload(stores: Pick<UploadStores, "store" | "objects">, operation: Pick<UploadOperation, "workspaceId" | "id">): Promise<BrowserEvidenceCaptured | undefined> {
  try {
    const row = await stores.store.get(spec(operation).rowKey);
    if (row === undefined || row["entityType"] !== ENTITY || row["status"] !== "COMPLETE" || row["operationId"] !== operation.id || row["workspaceId"] !== operation.workspaceId) return undefined;
    const key = row["objectKey"];
    const digest = row["sha256"];
    if (typeof key !== "string" || typeof digest !== "string" || !SHA256.safeParse(digest).success || key !== `${objectPrefix(operation)}${digest}`) return undefined;
    const found = await stores.objects.get(key, BROWSER_EVIDENCE_UPLOAD_MAX_BYTES + 1);
    if (found === undefined || found.byteLength > BROWSER_EVIDENCE_UPLOAD_MAX_BYTES || sha256Of(found) !== digest) return undefined;
    return decodeBrowserEvidenceUpload(found);
  } catch { return undefined; }
}

/** Removes what an upload left once the keeper has what it needs (best effort: the object also expires on its own). */
export async function dropBrowserEvidenceUpload(stores: Pick<UploadStores, "store" | "objects">, operation: Pick<UploadOperation, "workspaceId" | "id">): Promise<void> {
  try {
    const row = await stores.store.get(spec(operation).rowKey);
    if (typeof row?.["objectKey"] === "string" && row["objectKey"].startsWith(objectPrefix(operation))) await stores.objects.delete(row["objectKey"]);
  } catch { /* it expires on its own */ }
}

