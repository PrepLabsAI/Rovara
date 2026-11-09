// Lane L10: the three uploads a coding run makes besides its result (`candidate-export`, `candidate-build-source`, `baseline-source`). They carry the exact committed source of the candidate, and
// feed only the browser and API checks (E2E), which are not part of Code's wave 1. The worker's result is refused when one of them fails, so they must be answered; they are checked for shape
// and size, acknowledged, and not kept. When E2E comes to Code, the upload's bytes go to the object-storage port (lane L9a) and are checked against their tree here.
import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";

/** The chunk size the worker uploads with (`callback-client.ts`); the answer to `init` repeats it. */
export const UPLOAD_CHUNK_BYTES = 64 * 1024;
/** The most one upload may hold. Cloud's committed-source export is bounded the same way (4 MiB of blobs plus the tree inventory). */
export const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the upload request must be an object");
  return value as Record<string, unknown>;
};

/** Answers one request of an upload (`init`, `chunk`, `finalize`, or `unavailable` for the sources that may say there is none). */
export function acknowledgeUpload(rawBody: unknown, options: { allowUnavailable: boolean }): Record<string, unknown> {
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
