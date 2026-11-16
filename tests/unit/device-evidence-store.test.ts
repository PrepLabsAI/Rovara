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
const COMPANY_B = "org_11111111111111111111";
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

  it("company isolation: another company reading the very same key in the same table gets nothing, and each company's own run is its own", async () => {
    const documents = new MemoryDocumentStore();
    const blobsA = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_A });
    const blobsB = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_B });
    await storeDeviceEvidence({ blobs: blobsA }, OWNER, captured());
    expect(await blobsA.get(keyOf("a"), 1_000)).toBeDefined();
    expect(await blobsB.get(keyOf("a"), 1_000)).toBeUndefined();
    expect(await blobsB.get(keyOf("b"), 1_000)).toBeUndefined();
    // Company B stores the same task and owner names with different pictures: A's are untouched, and B cannot read A's.
    const other = captured();
    const first = other.steps[0]!;
    if (first.status === "shown") { first.before = shot("c"); first.after = shot("d"); }
    await storeDeviceEvidence({ blobs: blobsB }, OWNER, other);
    expect(await blobsB.get(keyOf("c"), 1_000)).toBeDefined();
    expect(await blobsA.get(keyOf("c"), 1_000)).toBeUndefined();
    expect(Buffer.from((await blobsA.get(keyOf("a"), 1_000))!)).toEqual(Buffer.from(jpegOf("a")));
    // Erasing one company's prefix leaves the other's in place.
    expect(await blobsB.deletePrefix("private/")).toBe(true);
    expect(await blobsB.get(keyOf("c"), 1_000)).toBeUndefined();
    expect(await blobsA.get(keyOf("a"), 1_000)).toBeDefined();
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

  it("keeps a half-stored picture another kept step still names, and keeps the unmasked count within the steps still shown", async () => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: COMPANY_A });
    const failing: EvidenceBlobStore = { ...blobs, async put(key, bytes, meta, options) { if (meta.metadata["sha256"] === shot("c").sha256) throw new Error("no"); return blobs.put(key, bytes, meta, options); } };
    const run = captured();
    run.unmasked = 2;
    run.steps = [{ flow: "a", step: "s", status: "shown", before: shot("a"), after: shot("b") }, { flow: "b", step: "s", status: "shown", before: shot("a"), after: shot("c") }];
    const outcome = await storeDeviceEvidence({ blobs: failing }, OWNER, run);
    expect(outcome.steps.map((row) => row.status)).toEqual(["shown", "not_run"]);
    expect(outcome.unmasked).toBe(1);
    expect(await blobs.get(keyOf("a"), 1_000)).toBeDefined();
  });

  it("checks the run whole before the first write: a run it refuses stores nothing", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_A });
    const big = (seed: string) => { const bytes = new Uint8Array(500_000); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; };
    const bad: unknown[] = [
      { ...captured(), steps: Array.from({ length: 31 }, (_, i) => ({ flow: `f${i}`, step: "s", status: "shown", before: shot("a"), after: shot("b") })) },
      { ...captured(), isolation: "imported" }, { ...captured(), device: "ios_simulator" },
      { ...captured(), steps: ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((c, i) => ({ flow: `f${i}`, step: "s", status: "shown", before: big(c), after: big(c.toUpperCase()) })) },
      { ...captured(), steps: [{ flow: "a", step: "s", status: "shown", before: { sha256: "x", bytes: jpegOf("a") }, after: shot("b") }] },
    ];
    for (const run of bad) await expect(storeDeviceEvidence({ blobs }, OWNER, run as DeviceEvidenceCaptured)).rejects.toThrow("device evidence outcome is not valid");
    expect(await blobs.get(keyOf("a"), 1_000)).toBeUndefined();
    expect(await blobs.get(evidenceArtifactKey(OWNER.ownerKey, OWNER.workspaceId, OWNER.taskId, big("a").sha256), 600_000)).toBeUndefined();
  });

  it("a run that did not happen stores nothing and keeps its reason", async () => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: COMPANY_A });
    const run: DeviceEvidenceCaptured = { device: "fake", isolation: "developer_machine", durationMs: 0, steps: [], notShown: [], moreNotShown: 0, unmasked: 0, notRun: "needs_macos" };
    expect(await storeDeviceEvidence({ blobs }, OWNER, run)).toEqual(run);
  });
});
