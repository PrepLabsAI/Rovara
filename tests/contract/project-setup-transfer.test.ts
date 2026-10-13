import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSetupTransfer } from "../../packages/worker/src/project-setup-transfer.js";
import { e2ePrivateTransferMaxBytes } from "../../packages/verifier/src/result-adapter.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const setupExecutionId = randomUUID();
const operationId = randomUUID();
const callbackCapability = "project-setup-test-capability".padEnd(40, "x");
const deadlineAt = new Date(Date.now() + 60_000).toISOString();

function makeTransfer(byteSource: Uint8Array) {
  const executionRef = { key: `project-setup-executions/sha256/${hash(byteSource)}.json`, sha256: hash(byteSource), byteLength: byteSource.byteLength };
  return { executionRef, transfer: createProjectSetupTransfer({ controlPlaneUrl: "http://broker.invalid", invocation: {
    setupExecutionId, operationId, fence: 7, callbackCapability, executionRef,
  } }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("project setup broker transfer", () => {
  it("reassembles only ordered 64 KiB source chunks matching the signed stored size and digest", async () => {
    const source = Buffer.alloc(70_001, 0x41);
    const { executionRef, transfer } = makeTransfer(source);
    const fetchMock = vi.fn(async (url: URL) => {
      const offset = Number(url.searchParams.get("offset"));
      const bytes = source.subarray(offset, Math.min(offset + 64 * 1024, source.byteLength));
      return new Response(JSON.stringify({ setupExecutionId, operationId, fence: 7, executionRef, offset, totalBytes: source.byteLength, deadlineAt,
        chunkBase64: bytes.toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const actual = await transfer.loadExecution(executionRef.key);
    expect(Buffer.from(actual)).toEqual(source);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => Number(url.searchParams.get("offset")))).toEqual([0, 65_536]);
  });

  it("rejects a source range whose total differs from the stored execution reference", async () => {
    const source = Buffer.alloc(100, 0x41);
    const { executionRef, transfer } = makeTransfer(source);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ setupExecutionId, operationId, fence: 7, executionRef,
      offset: 0, totalBytes: source.byteLength + 1, deadlineAt, chunkBase64: source.toString("base64") }), { status: 200 })));
    await expect(transfer.loadExecution(executionRef.key)).rejects.toThrow("authenticated stored reference");
  });

  it("uploads evidence as ordered 64 KiB original-byte chunks and finalizes only its content digest", async () => {
    const source = Buffer.from("source execution");
    const { transfer } = makeTransfer(source);
    const evidence = Buffer.alloc(70_001, 0x42);
    const evidenceDigest = hash(evidence);
    const uploadId = randomUUID();
    const chunks: Array<{ index: number; bytesBase64: string; sha256: string }> = [];
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname.endsWith("/evidence/init")) return new Response(JSON.stringify({ setupExecutionId, operationId, fence: 7, uploadId,
        totalBytes: evidence.byteLength, chunkCount: 2, chunkBytes: 65_536, deadlineAt }), { status: 200 });
      if (url.pathname.endsWith("/evidence/chunks")) {
        const requestBody = init?.body;
        expect(typeof requestBody).toBe("string");
        const body = JSON.parse(requestBody as string) as { index: number; bytesBase64: string; sha256: string };
        chunks.push(body);
        expect(Buffer.from(body.bytesBase64, "base64").byteLength).toBeLessThanOrEqual(65_536);
        return new Response(JSON.stringify({ accepted: true, index: body.index }), { status: 200 });
      }
      return new Response(JSON.stringify({ evidenceRef: { key: `project-setup-evidence/sha256/${evidenceDigest}.json`, sha256: evidenceDigest } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ref = await transfer.saveEvidence(evidence, evidenceDigest, e2ePrivateTransferMaxBytes(1, 1));
    expect(ref).toEqual({ key: `project-setup-evidence/sha256/${evidenceDigest}.json`, sha256: evidenceDigest });
    expect(chunks.map(({ index }) => index)).toEqual([0, 1]);
    expect(Buffer.concat(chunks.map(({ bytesBase64 }) => Buffer.from(bytesBase64, "base64")))).toEqual(evidence);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a broker upload session bound to a different operation", async () => {
    const source = Buffer.from("source execution");
    const { transfer } = makeTransfer(source);
    const evidence = Buffer.from("bounded evidence");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ setupExecutionId, operationId: randomUUID(), fence: 7,
      uploadId: randomUUID(), totalBytes: evidence.byteLength, chunkCount: 1, chunkBytes: 65_536, deadlineAt }), { status: 200 })));
    await expect(transfer.saveEvidence(evidence, hash(evidence), e2ePrivateTransferMaxBytes(1, 1))).rejects.toThrow("not bound to this operation");
  });
});
