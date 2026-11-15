// TE-B3 (readers first, ships in 0.5.18; the weakening WRITER follows in 0.5.19): the READERS of a v1 pack's `checks[].tests` and of test-proof.json ignore a key they do not know, and already know the optional parts the
// writer will add (`absentOnNew`, `absentOnNewCount`; the proof's `weakening` and `weakeningNotCompared`), so those round-trip without being dropped. The WRITERS stay strict. No behaviour changes for any pack or proof written today.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidencePackKey, loadEvidencePack } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { DeveloperTaskViewSchema, EvidencePackReadSchema, EvidenceViewReadSchema, EvidenceViewSchema, EvidencePackSchema, TestProofSchema, TestProofWriteSchema, type EvidencePack } from "../../packages/contracts/src/index.js";

const DIGEST = "c".repeat(64);
const pack = (testsPart: Record<string, unknown> = {}): unknown => ({
  schemaVersion: 1, candidateDigest: DIGEST,
  environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] },
  checks: [{ checkId: "readiness:0", kind: "test", label: "pytest", before: "passed", after: "passed", class: "passing", durationMs: 5, tests: { total: 4, passed: 3, failed: 0, skipped: 1, errored: 0, names: [], newTests: [], ...testsPart } }],
  selection: { method: "full", selected: 4, total: 4 }, api: [], browser: [], notTested: [],
});
const testsOf = (value: unknown): Record<string, unknown> | undefined => (value as EvidencePack).checks[0]?.tests;

describe("a reader of a v1 pack", () => {
  it("is what it was for a pack written today: the same pack, the same result", () => {
    expect(EvidencePackReadSchema.parse(pack())).toEqual(EvidencePackSchema.parse(pack()));
  });
  it("ignores a key the tests part does not know; the writer's schema refuses it", () => {
    const withExtra = pack({ somethingNewer: ["x"] });
    expect(EvidencePackSchema.safeParse(withExtra).success).toBe(false);
    const read = EvidencePackReadSchema.parse(withExtra);
    expect(testsOf(read)).not.toHaveProperty("somethingNewer");
    expect(testsOf(read)?.["total"]).toBe(4);
  });
  it("accepts the optional parts the writer will add and keeps them: absentOnNew, absentOnNewCount and the skip-rise counts round-trip", () => {
    const written = pack({ skippedBefore: 0, skippedAfter: 1, absentOnNew: ["tests/a.py::gone"], absentOnNewCount: 3 });
    const read = EvidencePackReadSchema.parse(written);
    expect(testsOf(read)).toMatchObject({ skippedBefore: 0, skippedAfter: 1, absentOnNew: ["tests/a.py::gone"], absentOnNewCount: 3 });
    // Written out and read again, nothing is lost.
    expect(EvidencePackReadSchema.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
  });
  it("still checks what it knows: both or neither, a count at least the names, a bounded list, the usual totals", () => {
    expect(EvidencePackReadSchema.safeParse(pack({ absentOnNew: ["a"] })).success).toBe(false);
    expect(EvidencePackReadSchema.safeParse(pack({ absentOnNew: ["a", "b"], absentOnNewCount: 1 })).success).toBe(false);
    expect(EvidencePackReadSchema.safeParse(pack({ absentOnNew: Array.from({ length: 101 }, () => "a"), absentOnNewCount: 101 })).success).toBe(false);
    expect(EvidencePackReadSchema.safeParse(pack({ total: 99 })).success).toBe(false);
  });
  it("is still strict everywhere else: an unknown key on a check or on the pack is refused", () => {
    const onCheck = pack() as { checks: Array<Record<string, unknown>> };
    onCheck.checks[0]!["extra"] = 1;
    expect(EvidencePackReadSchema.safeParse(onCheck).success).toBe(false);
    expect(EvidencePackReadSchema.safeParse({ ...(pack() as object), extra: 1 }).success).toBe(false);
  });
  it("round-trips the real B3 writer output through the tolerant reader", () => {
    expect(EvidencePackSchema.safeParse(pack({ absentOnNew: ["a"], absentOnNewCount: 1 })).success).toBe(true);
    const written = EvidencePackSchema.parse(pack({ absentOnNew: ["a"], absentOnNewCount: 1 }));
    expect(EvidencePackReadSchema.parse(JSON.parse(JSON.stringify(written)))).toEqual(written);
  });
});

describe("a reader of test-proof.json", () => {
  const proof = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 5, ...extra });
  const item = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 2, absentOnNew: ["a::t"], absentOnNewCount: 1 };
  it("reads a proof written today exactly as before", () => {
    expect(TestProofSchema.parse(proof())).toEqual(proof());
  });
  it("drops an unknown top-level key; the worker's strict schema refuses it", () => {
    expect(TestProofSchema.parse(proof({ newerPart: 1 }))).not.toHaveProperty("newerPart");
    expect(TestProofWriteSchema.safeParse(proof({ newerPart: 1 })).success).toBe(false);
  });
  it("keeps the weakening parts the writer will add: they round-trip without being dropped", () => {
    const written = proof({ weakening: [item], weakeningNotCompared: [{ checkId: "readiness:1", reason: "original_run_truncated" }] });
    const read = TestProofSchema.parse(written);
    expect(read.weakening).toEqual([item]);
    expect(read.weakeningNotCompared).toEqual([{ checkId: "readiness:1", reason: "original_run_truncated" }]);
    expect(TestProofSchema.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
    expect(TestProofWriteSchema.safeParse(written).success).toBe(true);
  });
  it("drops a weakening part it cannot read and still reads the rest of the proof; an unknown key in an item is dropped", () => {
    const parsed = TestProofSchema.parse(proof({ weakening: [{ checkId: "readiness:0", nonsense: true }], weakeningNotCompared: "no" }));
    expect(parsed.weakening).toBeUndefined();
    expect(parsed.weakeningNotCompared).toBeUndefined();
    expect(parsed.status).toBe("checked");
    expect(TestProofSchema.parse(proof({ weakening: [{ ...item, newerField: 1 }] })).weakening?.[0]).toEqual(item);
    expect(TestProofWriteSchema.safeParse(proof({ weakening: [{ ...item, newerField: 1 }] })).success).toBe(false);
  });
  it("still refuses a known field of the wrong type", () => {
    expect(TestProofSchema.safeParse(proof({ status: 7 })).success).toBe(false);
  });
});

describe("the broker's loader of a kept pack", () => {
  it("reads a kept pack that has a key a newer writer added, and keeps the optional parts it knows", async () => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
    const task = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
    await blobs.put(evidencePackKey(task, DIGEST), Buffer.from(JSON.stringify(pack({ newerPart: [1], absentOnNew: ["a::t"], absentOnNewCount: 1 })), "utf8"), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
    const read = await loadEvidencePack(blobs, task, DIGEST);
    expect(read?.checks[0]?.tests).toMatchObject({ total: 4, absentOnNew: ["a::t"], absentOnNewCount: 1 });
    expect(read?.checks[0]?.tests).not.toHaveProperty("newerPart");
  });
});

describe("the evidence view of the task page and the CLI (TaskView.evidence)", () => {
  const view = (testsPart: Record<string, unknown> = {}): unknown => pack(testsPart);
  it("is read tolerantly: a key a newer writer added to the tests part is dropped, and the optional parts round-trip", () => {
    expect(EvidenceViewSchema.safeParse(view({ somethingNewer: 1 })).success).toBe(false);
    const read = EvidenceViewReadSchema.parse(view({ somethingNewer: 1, skippedBefore: 0, skippedAfter: 1, absentOnNew: ["a::t"], absentOnNewCount: 2 }));
    expect(testsOf(read)).toMatchObject({ skippedBefore: 0, skippedAfter: 1, absentOnNew: ["a::t"], absentOnNewCount: 2 });
    expect(testsOf(read)).not.toHaveProperty("somethingNewer");
    expect(EvidenceViewReadSchema.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
  });
  it("the task view's evidence field reads it: an old client does not fail the whole task view on the new part", () => {
    const field = DeveloperTaskViewSchema.shape.evidence;
    expect(field.safeParse(view({ absentOnNew: ["a::t"], absentOnNewCount: 1, somethingNewer: 1 })).success).toBe(true);
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse({ ...(view() as object), extra: 1 }).success).toBe(false);
  });
});
