// The chunked uploads of the browser and API checks, on the ports: the three uploads a coding run makes besides its result (its committed source, the build source manifest of that code,
// and the unchanged code for the baseline round) and the evidence a checks run posts, all arrive as 64 KiB chunks of one exact byte string with its digest. The upload's row is in the
// document store and its chunks are staged in object storage until the whole is checked. This file holds what every one of them shares; the rules of each are in `uploads.ts` and `callbacks.ts`.
//
// The stored keys are the hosted product's, byte for byte: the rows under `WORKSPACE#<workspace>`, the staged and kept objects under the same prefixes.
import { createHash, randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { ObjectConflictError, ObjectTooBigError, agentXError, when, type Condition, type DocumentKey, type DocumentStore, type JsonValue, type ObjectStorage, type StoredDocument } from "@agentx/contracts";

/** The size of one chunk; the answer to `init` repeats it and the worker cuts its upload to it. */
export const UPLOAD_CHUNK_BYTES = 64 * 1024;
/** The most a candidate's committed source (or the unchanged code's) may hold: the tree inventory and the bounded blobs. */
export const MAX_CANDIDATE_EXPORT_BYTES = 112 * 1024 * 1024;
/**
 * The retention class of everything kept here. An unknown class is kept until it is deleted, which is what the checks need: the code a round runs on must still be there when the round starts,
 * however long the owner took to approve the plan.
 */
export const E2E_OBJECT_RETENTION = "task-document";
/** The retention class of a staged chunk: short, so a chunk an upload left behind expires on its own (the object storage maps the class to days). */
export const E2E_STAGING_RETENTION = "evidence-short";

/**
 * The statuses of an operation whose worker may still call: RUNNING, which the hosted product's worker reaches by its first heartbeat, and DISPATCHING, which is where a delivered
 * operation stays on an install whose callback listener serves no heartbeat (the local one). An operation that has ended, is being cancelled or was never handed to a worker is neither.
 */
export const LIVE_OPERATION_STATUSES = ["RUNNING", "DISPATCHING"] as const;
export const isLiveOperation = (status: string): boolean => (LIVE_OPERATION_STATUSES as readonly string[]).includes(status);
/** The same rule as a condition on the operation's row. */
export const whenOperationLive = (): Condition => when.or(...LIVE_OPERATION_STATUSES.map((status) => when.eq("status", status)));

/** What the upload handlers read of the worker's operation: the row the flow keeps, as the callback layer read it for this request. */
export interface UploadOperation {
  id: string;
  workspaceId: string;
  fence: number;
  kind: string;
  status: string;
  workflowMode?: string | undefined;
  /** A planning run that was asked for the unchanged code to ground its plan. */
  groundingSourceAsked?: boolean | undefined;
  candidateSourceRef?: unknown;
  candidateBuildSource?: unknown;
  baselineSource?: unknown;
  /** Set when the committed source of the code was too big to keep: the checks then block with a fixed sentence. */
  candidateSourceRefused?: unknown;
}

/** The two ports every handler works on, and the clock a row's times come from. */
export interface UploadStores {
  store: DocumentStore;
  objects: ObjectStorage;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
}

export const nowIso = (stores: UploadStores): string => (stores.now?.() ?? new Date()).toISOString();
export const newUploadId = (stores: UploadStores): string => stores.newId?.() ?? randomUUID();
export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The request body judged against its schema; anything else is a fixed `CONFIG_INVALID` sentence, never the validator's text. */
export function parseUploadBody<T>(schema: ZodType<T>, raw: unknown, label: string): T {
  try { return schema.parse(raw); } catch (error) {
    if (error instanceof ZodError) throw agentXError("CONFIG_INVALID", `the ${label} request is not valid`);
    throw error;
  }
}

/** The row an upload of one kind keeps: `WORKSPACE#<workspace>` / `<prefix>#<operation>`. */
export const uploadRowKey = (workspaceId: string, prefix: string, operationId: string, suffix = ""): DocumentKey => ({ pk: `WORKSPACE#${workspaceId}`, sk: `${prefix}#${operationId}${suffix}` });

/** What one kind of upload is called and where it keeps its row and its staged chunks. */
export interface UploadSpec {
  /** The words of its messages ("candidate source", "baseline source"). */
  label: string;
  entityType: string;
  rowKey: DocumentKey;
  stagingKey(uploadId: string, index: number): string;
}

const asRow = (value: StoredDocument | undefined): Record<string, unknown> | undefined => value;

/** The size the chunk at `index` of an upload must have. */
export const expectedChunkBytes = (index: number, chunkCount: number, totalBytes: number): number =>
  index === chunkCount - 1 ? totalBytes - index * UPLOAD_CHUNK_BYTES : UPLOAD_CHUNK_BYTES;

/** A staged chunk, or undefined when it is missing or is not a chunk (empty, or over the chunk size). */
export async function readChunk(stores: UploadStores, key: string): Promise<Buffer | undefined> {
  const found = await stores.objects.get(key, UPLOAD_CHUNK_BYTES);
  return found === undefined || found.byteLength === 0 ? undefined : Buffer.from(found);
}

/** The object storage of this install cannot hold the upload (the default keeps objects as documents). Its message is one fixed sentence. */
export class SourceTooLargeError extends Error {
  constructor(what: string) {
    super(`the ${what} is too large for this install's object storage (use the folder store)`);
    this.name = "SourceTooLargeError";
  }
}

/**
 * Keeps an object under its content address once. An object already there must hold exactly these bytes (a retried finalize, or another task with the same code); anything else under a
 * content address is a fault. An object this install's storage cannot hold is said so in one fixed sentence.
 */
export async function putOnce(stores: UploadStores, key: string, bytes: Uint8Array, meta: Record<string, string>, readLimit: number, what: string): Promise<void> {
  try {
    await stores.objects.put(key, bytes, { contentType: "application/json", metadata: meta, retention: E2E_OBJECT_RETENTION });
  } catch (error) {
    if (error instanceof ObjectTooBigError) throw new SourceTooLargeError(what);
    if (!(error instanceof ObjectConflictError)) throw error;
    const existing = await stores.objects.get(key, readLimit);
    if (existing === undefined || !Buffer.from(existing).equals(Buffer.from(bytes))) throw agentXError("RUNTIME_UNAVAILABLE", `an existing ${what} object does not match its content address`);
  }
}

export interface UploadInit { totalBytes: number; chunkCount: number; sha256: string }

/** What an `init` answers: the upload's id and the chunking the caller must use. */
export const initAnswer = (uploadId: string, body: UploadInit): Record<string, JsonValue> => ({ uploadId, chunkBytes: UPLOAD_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount });

/**
 * Opens an upload, or answers the open one again when the same request is repeated. A row of another upload, a closed one or one of another operation or fence is refused: a coding run
 * owns one upload of each kind. `row` carries what the kind keeps in addition to the common attributes.
 */
export async function openUpload(stores: UploadStores, operation: UploadOperation, spec: UploadSpec, body: UploadInit, row: Record<string, JsonValue> = {}): Promise<Record<string, JsonValue>> {
  if (body.chunkCount !== Math.ceil(body.totalBytes / UPLOAD_CHUNK_BYTES)) throw agentXError("CONFIG_INVALID", `${spec.label} chunk count does not match its total`);
  const same = (existing: Record<string, unknown> | undefined): Record<string, JsonValue> | undefined => {
    if (existing === undefined) return undefined;
    if (existing["entityType"] !== spec.entityType || existing["status"] !== "OPEN" || existing["operationId"] !== operation.id || existing["fence"] !== operation.fence
      || existing["totalBytes"] !== body.totalBytes || existing["chunkCount"] !== body.chunkCount || existing["sha256"] !== body.sha256 || typeof existing["uploadId"] !== "string") {
      throw agentXError("CALLBACK_FORBIDDEN", `implementation already owns a different ${spec.label} upload`);
    }
    return initAnswer(existing["uploadId"], body);
  };
  const again = same(asRow(await stores.store.get(spec.rowKey)));
  if (again !== undefined) return again;
  const uploadId = newUploadId(stores);
  const put = await stores.store.put({
    item: { ...spec.rowKey, entityType: spec.entityType, schemaVersion: 1, workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, uploadId,
      totalBytes: body.totalBytes, chunkCount: body.chunkCount, sha256: body.sha256, nextChunkIndex: 0, status: "OPEN", createdAt: nowIso(stores), ...row },
    condition: when.absent(),
  });
  if (put.applied) return initAnswer(uploadId, body);
  // A second init raced this one: it is the same upload only if it asked for the same bytes.
  const raced = same(asRow(await stores.store.get(spec.rowKey)));
  if (raced === undefined) throw agentXError("STALE_FENCE", `${spec.label} upload is not current`);
  return raced;
}

/** The upload row a later call continues: this kind's, for this operation and fence. */
export function requireCurrentUpload(row: StoredDocument | undefined, operation: UploadOperation, spec: UploadSpec): Record<string, unknown> {
  const upload = asRow(row);
  if (upload === undefined || upload["entityType"] !== spec.entityType || upload["operationId"] !== operation.id || upload["fence"] !== operation.fence) {
    throw agentXError("STALE_FENCE", `${spec.label} upload is not current`);
  }
  return upload;
}

export interface ChunkBody { uploadId: string; index: number; bytesBase64: string; sha256: string }

/**
 * Takes the next chunk of an open upload, once and in order. The chunk is checked for its size, its encoding and its digest; a chunk sent again must be exactly the bytes already kept for
 * its place (a retried request), never other bytes.
 */
export async function acceptChunk(stores: UploadStores, operation: UploadOperation, spec: UploadSpec, upload: Record<string, unknown>, body: ChunkBody): Promise<Record<string, JsonValue>> {
  const chunkCount = Number(upload["chunkCount"]);
  if (upload["uploadId"] !== body.uploadId || !Number.isSafeInteger(body.index) || body.index >= chunkCount) throw agentXError("CALLBACK_FORBIDDEN", `${spec.label} chunk is outside its owned upload`);
  const bytes = Buffer.from(body.bytesBase64, "base64");
  if (bytes.byteLength !== expectedChunkBytes(body.index, chunkCount, Number(upload["totalBytes"])) || bytes.toString("base64") !== body.bytesBase64 || sha256Of(bytes) !== body.sha256) {
    throw agentXError("CONFIG_INVALID", `${spec.label} chunk bytes or digest are invalid`);
  }
  const nextIndex = Number(upload["nextChunkIndex"]);
  if (body.index > nextIndex) throw agentXError("CONFIG_INVALID", `${spec.label} chunks must arrive in order`);
  const key = spec.stagingKey(body.uploadId, body.index);
  if (body.index < nextIndex) {
    const prior = await readChunk(stores, key);
    if (prior === undefined || !prior.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", `replayed ${spec.label} chunk differs from its owned bytes`);
    return { accepted: true, index: body.index, duplicate: true };
  }
  try {
    await stores.objects.put(key, bytes, { contentType: "application/octet-stream", metadata: { sha256: body.sha256, upload: body.uploadId, index: String(body.index) }, retention: E2E_STAGING_RETENTION });
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
    // The chunk was staged and the row not yet moved (a crash between the two): the same bytes go on, other bytes are refused.
    const prior = await readChunk(stores, key);
    if (prior === undefined || !prior.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", `replayed ${spec.label} chunk differs from its owned bytes`);
  }
  const moved = await stores.store.update({
    key: spec.rowKey, ops: [{ op: "set", path: ["nextChunkIndex"], value: body.index + 1 }],
    condition: when.and(when.eq("status", "OPEN"), when.eq("nextChunkIndex", body.index), when.eq("operationId", operation.id), when.eq("fence", operation.fence)),
  });
  if (!moved.applied) throw agentXError("STALE_FENCE", `${spec.label} upload is not current`);
  return { accepted: true, index: body.index, duplicate: false };
}

/**
 * The whole upload, read back from its staged chunks and held to its size and digest. A finalize that names another upload or digest, or comes before every chunk, is refused. Returns the
 * bytes and the keys of the staged chunks to delete once the upload is recorded.
 */
export async function assembleUpload(stores: UploadStores, spec: UploadSpec, upload: Record<string, unknown>, body: { uploadId: string; sha256: string }): Promise<{ bytes: Buffer; chunkKeys: string[] }> {
  if (upload["uploadId"] !== body.uploadId || upload["sha256"] !== body.sha256 || Number(upload["nextChunkIndex"]) !== Number(upload["chunkCount"])) {
    throw agentXError("STALE_FENCE", `${spec.label} upload is incomplete or changed`);
  }
  const chunks: Buffer[] = [];
  const chunkKeys = Array.from({ length: Number(upload["chunkCount"]) }, (_, index) => spec.stagingKey(body.uploadId, index));
  for (const key of chunkKeys) {
    const chunk = await readChunk(stores, key);
    if (chunk === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `an owned ${spec.label} chunk is missing`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(upload["totalBytes"]) || sha256Of(bytes) !== body.sha256) {
    // The bytes the worker staged are not the ones it named: nothing more can come of them, so they are not kept.
    await dropChunks(stores, chunkKeys);
    throw agentXError("CONFIG_INVALID", `${spec.label} bytes do not match their stored digest`);
  }
  return { bytes, chunkKeys };
}

/** Deletes the staged chunks of a closed upload. */
export async function dropChunks(stores: UploadStores, chunkKeys: readonly string[]): Promise<void> {
  for (const key of chunkKeys) await stores.objects.delete(key);
}
