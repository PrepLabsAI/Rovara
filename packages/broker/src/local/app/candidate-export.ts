// The three uploads a coding run makes besides its result (`candidate-export`, `candidate-build-source`, `baseline-source`). They carry the exact committed source of the candidate (and of the
// unchanged code), and feed the browser and API checks. A task that does not need those checks has no use for them: its uploads are answered and nothing is kept, as the worker needs to finish
// its run, so a code base too big for this install's object storage never holds a result up. A task that needs the checks has its uploads judged and kept by `core/e2e/uploads.ts` on the document
// store and object storage; code that is too big to keep is answered as such and the checks block with a fixed sentence.
import { randomUUID } from "node:crypto";
import { agentXError, type JsonValue } from "@agentx/contracts";
import { handleBaselineSource, handleCandidateBuildSource, handleCandidateExport } from "../../core/e2e/uploads.js";
import type { UploadOperation, UploadStores } from "../../core/e2e/uploads-chunks.js";
import { taskKey, taskPointerKey } from "../../core/task-flow/keys.js";

export type CodingRunUploadAction = "candidate-export" | "candidate-build-source" | "baseline-source";

export const isCodingRunUpload = (action: string): action is CodingRunUploadAction => action === "candidate-export" || action === "candidate-build-source" || action === "baseline-source";

/** The chunk size the worker uploads with (`callback-client.ts`); the answer to `init` repeats it. */
const UPLOAD_CHUNK_BYTES = 64 * 1024;
/** The most one upload may hold when it is only answered. */
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the upload request must be an object");
  return value as Record<string, unknown>;
};

/** Answers one request of an upload without keeping anything: the shape and size the worker's own client sends, so its run goes on. */
export function acknowledgeUpload(rawBody: unknown, options: { allowUnavailable: boolean }): Record<string, JsonValue> {
  const body = object(rawBody);
  const stage = body["stage"];
  if (stage === "unavailable") {
    if (!options.allowUnavailable || typeof body["reason"] !== "string") throw agentXError("CONFIG_INVALID", "this upload cannot be reported unavailable");
    return { accepted: true };
  }
  if (stage === "init") {
    const total = body["totalBytes"];
    const count = body["chunkCount"];
    if (typeof total !== "number" || !Number.isInteger(total) || total < 1 || total > UPLOAD_MAX_BYTES) throw agentXError("CONFIG_INVALID", "the upload is empty or too large");
    if (typeof count !== "number" || count !== Math.ceil(total / UPLOAD_CHUNK_BYTES)) throw agentXError("CONFIG_INVALID", "the upload's chunk count does not match its size");
    if (typeof body["sha256"] !== "string" || !SHA256.test(body["sha256"])) throw agentXError("CONFIG_INVALID", "the upload needs its digest");
    return { uploadId: randomUUID(), chunkBytes: UPLOAD_CHUNK_BYTES, chunkCount: count };
  }
  if (stage === "chunk") {
    const index = body["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof body["bytesBase64"] !== "string" || Buffer.byteLength(body["bytesBase64"], "utf8") > UPLOAD_CHUNK_BYTES * 2) {
      throw agentXError("CONFIG_INVALID", "the upload chunk is not valid");
    }
    return { accepted: true, index, duplicate: false };
  }
  if (stage === "finalize") return { accepted: true };
  throw agentXError("CONFIG_INVALID", "the upload stage is not known");
}

/**
 * Whether the upload is kept: a planning run asked for the unchanged code to ground its plan, or a task whose approved plan needs the browser and API checks. An upload that follows a source
 * this install could not keep has nothing to follow, so it is only answered.
 */
async function keepsUpload(action: CodingRunUploadAction, stores: UploadStores, operation: UploadOperation): Promise<boolean> {
  if (action === "baseline-source" && operation.workflowMode === "PLAN" && operation.groundingSourceAsked === true) return true;
  if (action === "candidate-build-source" && operation.candidateSourceRefused !== undefined) return false;
  const pointer = await stores.store.get(taskPointerKey(operation.workspaceId));
  const taskId = typeof pointer?.["taskId"] === "string" ? pointer["taskId"] : undefined;
  if (taskId === undefined) return false;
  const workflow = (await stores.store.get(taskKey(taskId)))?.["workflow"] as { e2e?: { required?: unknown } } | undefined;
  return workflow?.e2e?.required === true;
}

/** Answers one request of a coding run's upload. The operation is the row the callback layer read for this request. */
export async function handleCodingRunUpload(action: CodingRunUploadAction, stores: UploadStores, operation: UploadOperation, body: unknown): Promise<Record<string, JsonValue>> {
  if (!await keepsUpload(action, stores, operation)) return acknowledgeUpload(body, { allowUnavailable: action !== "candidate-export" });
  switch (action) {
    case "candidate-export": return handleCandidateExport(stores, operation, body);
    case "candidate-build-source": return handleCandidateBuildSource(stores, operation, body);
    case "baseline-source": return handleBaselineSource(stores, operation, body);
    default: throw agentXError("NOT_FOUND", "this upload is not known");
  }
}
