// A world for the tests of the evidence path: the evidence blob store over an in-memory document store, the artifact listing the broker reads the worker's raw file through, and the stand-in data guard.
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import type { KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { scanTextForTests } from "./evidence-scan.js";

export const EVIDENCE_TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
export const EVIDENCE_OP = "op-1";
const PREFIX = `private/${EVIDENCE_TASK.ownerKey}/${EVIDENCE_TASK.workspaceId}/${EVIDENCE_OP}/`;

export function evidenceWorld(rawText: string): { deps: KeepEvidenceDeps } {
  const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() { return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; },
    async readArtifact(key, max) { return key.startsWith(PREFIX) ? rawText.slice(0, max) : ""; },
  };
  return { deps: { scan: scanTextForTests, markStored: async () => undefined, actions, store: { blobs } } };
}
