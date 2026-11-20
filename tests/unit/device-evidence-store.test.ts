// Device testing slice 1: device-evidence screenshots go into the evidence store, under the task and the company (the document adapter's partition is company-scoped), as `jpeg` artifacts with
// the standard retention, through the existing content-addressed writer. A screenshot the store does not keep is "Not run", never a dangling reference. Two companies never see each other's.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidencePackV2Schema, type EvidencePackV2 } from "../../packages/contracts/src/evidence.js";
import { addDeviceEvidenceToPack, type DeviceEvidenceCaptured } from "../../packages/contracts/src/device-evidence.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore, type EvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidenceArtifactKey } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { storeDeviceEvidence } from "../../packages/broker/src/core/proof/device-evidence-store.js";

const OWNER = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const COMPANY_A = "org_00000000000000000000";
const jpegOf = (seed: string) => { const bytes = new Uint8Array(500); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const shot = (seed: string) => { const bytes = jpegOf(seed); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; };
const captured = (): DeviceEvidenceCaptured => ({
  device: "fake", isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0, unmasked: 0,
  steps: [{ flow: "checkout", step: "open", status: "shown", before: shot("a"), after: shot("b") }, { flow: "checkout", step: "submit", status: "not_run", reason: "step_failed" }],
});
const pack = (): EvidencePackV2 => ({ schemaVersion: 2, candidate: { digest: "c".repeat(64), repositories: [] }, producer: { edition: "code", isolation: "sandbox" }, level: { reached: "sandbox_only", required: [] }, result: "verified", checks: [], notTested: [] });
const keyOf = (seed: string) => evidenceArtifactKey(OWNER.ownerKey, OWNER.workspaceId, OWNER.taskId, shot(seed).sha256);

describe("storeDeviceEvidence", () => {
  it("stores each kept screenshot under the task and the company, and gives the pack refs with the jpeg kind and standard retention", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_A });
    const outcome = await storeDeviceEvidence({ blobs }, OWNER, captured());
    expect(outcome.steps[0]).toEqual({ flow: "checkout", step: "open", status: "shown",
      before: { kind: "jpeg", sha256: shot("a").sha256, bytes: 500, retentionClass: "evidence-std" }, after: { kind: "jpeg", sha256: shot("b").sha256, bytes: 500, retentionClass: "evidence-std" } });
    expect(outcome.steps[1]).toEqual({ flow: "checkout", step: "submit", status: "not_run", reason: "step_failed" });
    expect(outcome.device).toBe("fake");
    expect(Buffer.from((await blobs.get(keyOf("a"), 1_000))!)).toEqual(Buffer.from(jpegOf("a")));
    expect(EvidencePackV2Schema.safeParse(addDeviceEvidenceToPack(pack(), outcome)).success).toBe(true);
  });

  it("a screenshot the store does not keep makes its step Not run (not stored), never a reference to nothing", async () => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: COMPANY_A });
    const failing: EvidenceBlobStore = { ...blobs, async put(key, bytes, meta, options) { if (meta.metadata["sha256"] === shot("b").sha256) throw new Error("disk full at /var/secret"); return blobs.put(key, bytes, meta, options); } };
    const outcome = await storeDeviceEvidence({ blobs: failing }, OWNER, captured());
    expect(outcome.steps[0]).toEqual({ flow: "checkout", step: "open", status: "not_run", reason: "not_stored" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    // The side that was stored is deleted again: no object is left that no pack names.
    expect(await blobs.get(keyOf("a"), 1_000)).toBeUndefined();
    // A digest that does not match its bytes is not stored either.
    const lying = captured();
    const first = lying.steps[0]!;
    if (first.status === "shown") first.after = { ...first.after, sha256: "f".repeat(64) };
    expect((await storeDeviceEvidence({ blobs }, OWNER, lying)).steps[0]).toEqual({ flow: "checkout", step: "open", status: "not_run", reason: "not_stored" });
  });

  it("a run that did not happen stores nothing and keeps its reason", async () => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: COMPANY_A });
    const run: DeviceEvidenceCaptured = { device: "fake", isolation: "developer_machine", durationMs: 0, steps: [], notShown: [], moreNotShown: 0, unmasked: 0, notRun: "needs_macos" };
    expect(await storeDeviceEvidence({ blobs }, OWNER, run)).toEqual(run);
  });
});
