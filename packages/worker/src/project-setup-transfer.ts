import { createHash } from "node:crypto";
import { e2ePrivateTransferMaxBytes } from "@agentx/verifier";

const CHUNK_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_RETRIES = 2;

type TransferInvocation = {
  setupExecutionId: string;
  operationId: string;
  fence: number;
  callbackCapability: string;
  executionRef: { key: string; sha256: string; byteLength: number };
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function remaining(deadlineAt: string): number {
  const time = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(time) || time <= 0) throw new Error("project setup transfer exceeded its stored deadline");
  return time;
}

async function requestWithRetry(url: URL, init: RequestInit, deadlineAt: string, retries = MAX_RETRIES): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeLeft = remaining(deadlineAt);
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(10_000, timeLeft)) });
      if (response.ok || response.status < 500 || attempt === retries) return response;
      lastError = new Error(`setup transfer returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries || remaining(deadlineAt) <= 0) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100 * (attempt + 1), Math.max(1, remaining(deadlineAt) - 1))));
  }
  throw lastError instanceof Error ? lastError : new Error("setup transfer failed");
}

export function createProjectSetupTransfer(input: {
  controlPlaneUrl: string;
  invocation: TransferInvocation;
}): {
  loadExecution: (key: string) => Promise<Uint8Array>;
  saveEvidence: (bytes: Uint8Array, digest: string, admittedByteLimit: number) => Promise<{ key: string; sha256: string }>;
} {
  const base = new URL(input.controlPlaneUrl);
  const { invocation } = input;
  const headers = { "x-agentx-callback-capability": invocation.callbackCapability };
  const path = `/v1/internal/project-setups/${invocation.setupExecutionId}`;

  return {
    async loadExecution(key) {
      if (key !== invocation.executionRef.key || invocation.executionRef.byteLength > MAX_SOURCE_BYTES) throw new Error("project setup source reference is outside the signed execution");
      const chunks: Buffer[] = [];
      let deadlineAt: string | undefined;
      const totalBytes = invocation.executionRef.byteLength;
      for (let offset = 0; offset < totalBytes; offset += CHUNK_BYTES) {
        const url = new URL(`${path}/execution?offset=${offset}`, base);
        const response = await requestWithRetry(url, { headers }, deadlineAt ?? new Date(Date.now() + 60_000).toISOString());
        if (!response.ok) throw new Error(`setup execution read returned HTTP ${response.status}`);
        const chunk = await response.json() as { setupExecutionId?: unknown; operationId?: unknown; fence?: unknown; executionRef?: { key?: unknown; sha256?: unknown; byteLength?: unknown }; offset?: unknown; totalBytes?: unknown; deadlineAt?: unknown; chunkBase64?: unknown };
        if (chunk.setupExecutionId !== invocation.setupExecutionId || chunk.operationId !== invocation.operationId || chunk.fence !== invocation.fence
          || chunk.executionRef?.key !== key || chunk.executionRef.sha256 !== invocation.executionRef.sha256 || chunk.executionRef.byteLength !== totalBytes
          || chunk.offset !== offset || chunk.totalBytes !== totalBytes || typeof chunk.deadlineAt !== "string" || typeof chunk.chunkBase64 !== "string"
          || deadlineAt !== undefined && deadlineAt !== chunk.deadlineAt) throw new Error("setup execution chunk response differs from its authenticated stored reference");
        deadlineAt = chunk.deadlineAt;
        const bytes = Buffer.from(chunk.chunkBase64, "base64");
        const expectedLength = Math.min(CHUNK_BYTES, totalBytes - offset);
        if (bytes.byteLength !== expectedLength || bytes.toString("base64") !== chunk.chunkBase64) throw new Error("setup execution chunk is malformed");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.byteLength !== totalBytes || sha256(bytes) !== invocation.executionRef.sha256) throw new Error("reassembled setup source differs from its stored digest or size");
      return new Uint8Array(bytes);
    },
    async saveEvidence(bytes, digest, admittedByteLimit) {
      const maxEvidenceBytes = e2ePrivateTransferMaxBytes(64, 4);
      if (!Number.isSafeInteger(admittedByteLimit) || admittedByteLimit < 1 || admittedByteLimit > maxEvidenceBytes
        || bytes.byteLength === 0 || bytes.byteLength > admittedByteLimit || sha256(bytes) !== digest) throw new Error("setup evidence exceeds its bounded content reference");
      const chunkCount = Math.ceil(bytes.byteLength / CHUNK_BYTES);
      const initResponse = await fetch(new URL(`${path}/evidence/init`, base), {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: "project-setup-evidence-upload/v1", totalBytes: bytes.byteLength, chunkCount, sha256: digest }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!initResponse.ok) throw new Error(`setup evidence upload initialization returned HTTP ${initResponse.status}`);
      const upload = await initResponse.json() as { setupExecutionId?: unknown; operationId?: unknown; fence?: unknown; uploadId?: unknown; totalBytes?: unknown; chunkCount?: unknown; chunkBytes?: unknown; deadlineAt?: unknown };
      if (upload.setupExecutionId !== invocation.setupExecutionId || upload.operationId !== invocation.operationId || upload.fence !== invocation.fence
        || typeof upload.uploadId !== "string" || upload.totalBytes !== bytes.byteLength || upload.chunkCount !== chunkCount
        || upload.chunkBytes !== CHUNK_BYTES || typeof upload.deadlineAt !== "string") throw new Error("setup evidence upload session is not bound to this operation");
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.byteLength));
        const response = await requestWithRetry(new URL(`${path}/evidence/chunks`, base), {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: "project-setup-evidence-chunk/v1", uploadId: upload.uploadId, index,
            bytesBase64: Buffer.from(chunk).toString("base64"), sha256: sha256(chunk) }),
        }, upload.deadlineAt);
        if (!response.ok) throw new Error(`setup evidence chunk ${index} returned HTTP ${response.status}`);
        const ack = await response.json() as { accepted?: unknown; index?: unknown };
        if (ack.accepted !== true || ack.index !== index) throw new Error("setup evidence chunk acknowledgement is invalid");
      }
      const finalize = await requestWithRetry(new URL(`${path}/evidence/finalize`, base), {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: "project-setup-evidence-finalize/v1", uploadId: upload.uploadId, sha256: digest }),
      }, upload.deadlineAt);
      if (!finalize.ok) throw new Error(`setup evidence finalization returned HTTP ${finalize.status}`);
      const result = await finalize.json() as { evidenceRef?: { key?: unknown; sha256?: unknown } };
      if (result.evidenceRef?.sha256 !== digest || result.evidenceRef.key !== `project-setup-evidence/sha256/${digest}.json`) throw new Error("setup evidence final reference is invalid");
      return { key: result.evidenceRef.key, sha256: digest };
    },
  };
}
