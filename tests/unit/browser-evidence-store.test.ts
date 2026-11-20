// TE-H1 slice 1: browser-evidence screenshots go into the evidence store, under the task and the company (the document adapter's partition is company-scoped), as `jpeg`
// artifacts with the standard retention, through the existing content-addressed writer. A screenshot the store does not keep is "Not run", never a dangling reference.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore, type EvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidenceArtifactKey } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { storeBrowserEvidence } from "../../packages/broker/src/core/proof/browser-evidence-store.js";
import type { BrowserEvidenceCaptured } from "../../packages/contracts/src/browser-evidence.js";

const OWNER = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const COMPANY_A = "org_00000000000000000000";
const jpegOf = (seed: string) => { const bytes = new Uint8Array(500); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const shot = (seed: string) => { const bytes = jpegOf(seed); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; };
const captured = (): BrowserEvidenceCaptured => ({
  isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0,
  routes: [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 0 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" }],
});

describe("storeBrowserEvidence", () => {

  it("a screenshot the store does not keep makes its route Not run (not stored), never a reference to nothing", async () => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: COMPANY_A });
    const failing: EvidenceBlobStore = { ...blobs, async put(key, bytes, meta, options) { if (meta.metadata["sha256"] === shot("b").sha256) throw new Error("disk full at /var/secret"); return blobs.put(key, bytes, meta, options); } };
    const outcome = await storeBrowserEvidence({ blobs: failing }, OWNER, captured());
    expect(outcome.routes[0]).toEqual({ route: "/checkout", status: "not_run", reason: "not_stored" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    // The side that was stored is deleted again: no object is left that no pack names.
    expect(await blobs.get(evidenceArtifactKey(OWNER.ownerKey, OWNER.workspaceId, OWNER.taskId, shot("a").sha256), 1_000)).toBeUndefined();
    // A digest that does not match its bytes is not stored either.
    const lying = captured();
    const first = lying.routes[0]!;
    if (first.status === "shown") first.after = { ...first.after, sha256: "f".repeat(64) };
    expect((await storeBrowserEvidence({ blobs }, OWNER, lying)).routes[0]).toEqual({ route: "/checkout", status: "not_run", reason: "not_stored" });
  });

  it("a run that did not happen stores nothing and keeps its reason", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_A });
    const outcome = await storeBrowserEvidence({ blobs }, OWNER, { isolation: "developer_machine", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "app_did_not_start" });
    expect(outcome).toEqual({ isolation: "developer_machine", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "app_did_not_start" });
    expect(await blobs.deletePrefix("private/")).toBe(true);
  });
});
