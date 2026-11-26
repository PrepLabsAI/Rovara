import { describe, expect, it } from "vitest";
import { ObjectConflictError, isValidObjectKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DOCUMENT_BLOB_MAX_BYTES, createDocumentEvidenceBlobStore, createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { MemoryObjectStorage } from "../support/memory-object-storage.js";
import { storeEvidenceArtifacts } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { runObjectStorageConformance } from "../support/ports/object-storage-conformance.js";

const COMPANY = "org_00000000000000000000";
const DAY = 86_400_000;

runObjectStorageConformance("document store", {
  async create() {
    let now = Date.parse("2026-11-09T00:00:00.000Z");
    const documents = new MemoryDocumentStore();
    return {
      store: createDocumentObjectStorage(documents, { companyId: COMPANY, now: () => now }),
      tooBigBytes: DOCUMENT_BLOB_MAX_BYTES + 1,
      fitsBytes: 65_536,
      expire: async () => { now += 400 * DAY; },
    };
  },
});

runObjectStorageConformance("memory (the tests' S3 stand-in)", {
  async create() {
    let now = Date.parse("2026-11-09T00:00:00.000Z");
    return {
      store: new MemoryObjectStorage({ maxObjectBytes: 100_000, now: () => now, retentionDays: { "evidence-std": 30 } }),
      tooBigBytes: 100_001,
      fitsBytes: 100_000,
      expire: async () => { now += 31 * DAY; },
    };
  },
});

describe("the object keys", () => {
  it("accept the keys proof evidence uses and refuse the rest", () => {
    expect(isValidObjectKey("private/0123abcd/ws-1/evidence/t-1/" + "a".repeat(64))).toBe(true);
    expect(isValidObjectKey("a")).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "a/..", "./a", "a/b c", "a\\b", "ä"]) expect(isValidObjectKey(bad), bad).toBe(false);
  });
});

describe("objects are immutable by default (L9-wire review O3)", () => {
  const META = { contentType: "x/y", metadata: {}, retention: "evidence-std" as const };

  it("keeps the evidence callers that write the same key again working, by an explicit overwrite, and refuses everyone else", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY });
    const owner = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "t-1" };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);
    await storeEvidenceArtifacts({ blobs }, owner, [{ kind: "jpeg", bytes: jpeg }]);
    const again = await storeEvidenceArtifacts({ blobs }, owner, [{ kind: "jpeg", bytes: jpeg }]);
    expect(again.size).toBe(1);
    await expect(blobs.put([...again.keys()].map((digest) => `private/owner-1/ws-1/evidence/t-1/${digest}`)[0]!, jpeg, META)).rejects.toBeInstanceOf(ObjectConflictError);
  });

});
