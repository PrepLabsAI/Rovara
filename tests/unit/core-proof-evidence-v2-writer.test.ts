// TE-A2b: the broker's pack WRITER can write version 2. The default is still version 1 (a Cloud reader that is strict about v1 must not meet a v2 pack before the Cloud half and the TE-A1 gate exist); readers accept both.
// The level and the result are decided here from facts the broker has (where the checks ran, how the CI reads, the checks' own outcomes); the CI part comes from TE-B2's `ciEvidenceLevel`, passed in by the caller.
// Old v1 data keeps working: the v2 pack is made from a pack `buildEvidencePack` really built, not only a fixture.
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, EvidencePackV2Schema, readEvidencePack, readEvidencePackText, renderEvidence, type CheckEntry, type EvidencePack } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { weakeningPartsOf } from "../../packages/broker/src/core/proof/evidence-v2-lines.js";
import { evidencePackKey, keepEvidence, loadEvidencePack, loadEvidenceRead, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { buildEvidencePack, evidenceLevelOf, evidencePackV2Of, evidenceResultOf, type EvidenceV2Writer } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: { total: 4, passed: 4, failed: 0, skipped: 0, errored: 0, names: [{ name: "t.py::a", status: "passed" }], newTests: ["t.py::a"] } }], selection: { method: "full", selected: 4, total: 4 } });
const sandbox: EvidenceV2Writer = { version: 2, producer: { edition: "code", isolation: "sandbox" } };

function world() {
  const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() { return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; },
    async readArtifact(key, max) { return key === `${PREFIX}evidence-raw.json` ? raw.slice(0, max) : ""; },
  };
  return { deps: { scan: scanTextForTests, actions, store: { blobs } } satisfies KeepEvidenceDeps, blobs };
}
const keepInput = (over: Record<string, unknown> = {}) => ({ orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")], ...over });
const stored = async (blobs: ReturnType<typeof world>["blobs"]) => JSON.parse(Buffer.from((await blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304))!).toString("utf8")) as Record<string, unknown>;

describe("the default writer is still version 1", () => {
  it("keeps a v1 pack when no writer is named, and when version 1 is named", async () => {
    for (const writer of [undefined, { version: 1 as const }]) {
      const w = world();
      expect(await keepEvidence(w.deps, keepInput(writer === undefined ? {} : { writer }))).toMatchObject({ kept: true });
      const pack = await stored(w.blobs);
      expect(pack.schemaVersion).toBe(1);
      expect(EvidencePackSchema.safeParse(pack).success).toBe(true);
    }
  });
});

describe("the version 2 writer", () => {
  it("keeps a v2 pack that the strict v2 schema and the tolerant reader both accept, with the v1 parts kept", async () => {
    const w = world();
    expect(await keepEvidence(w.deps, keepInput({ writer: sandbox }))).toMatchObject({ kept: true });
    const pack = await stored(w.blobs);
    expect(pack.schemaVersion).toBe(2);
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
    const read = readEvidencePackText(JSON.stringify(pack));
    expect(read.status).toBe("v2");
    expect(pack).toMatchObject({ producer: { edition: "code", isolation: "sandbox" }, level: { reached: "rovara_real_run" }, result: "verified", candidate: { digest: DIGEST } });
    expect(pack).toHaveProperty("environment");
    expect(pack).toHaveProperty("selection");
  });
  it("is read by the v1 reader function as a v1 pack (readers accept both), and by the v2 reader as v2", async () => {
    const w = world();
    await keepEvidence(w.deps, keepInput({ writer: sandbox }));
    const v1 = await loadEvidencePack(w.blobs, TASK, DIGEST);
    expect(v1?.schemaVersion).toBe(1);
    expect(v1?.checks[0]).toMatchObject({ checkId: "readiness:0", after: "passed" });
    const read = await loadEvidenceRead(w.blobs, TASK, DIGEST);
    expect(read?.status).toBe("v2");
  });
  it("a v1 pack kept today is read as v1 by both readers (old data keeps working)", async () => {
    const w = world();
    await keepEvidence(w.deps, keepInput());
    expect((await loadEvidenceRead(w.blobs, TASK, DIGEST))?.status).toBe("v1");
    expect((await loadEvidencePack(w.blobs, TASK, DIGEST))?.checks).toHaveLength(1);
  });
  it("a strict v1 reader still cannot parse a v2 pack, which is why the default stays v1", async () => {
    const w = world();
    await keepEvidence(w.deps, keepInput({ writer: sandbox }));
    expect(EvidencePackSchema.safeParse(await stored(w.blobs)).success).toBe(false);
  });
  it("loadEvidenceRead and loadEvidencePack refuse a pack for other code, a v2 pack among them", async () => {
    const w = world();
    await keepEvidence(w.deps, keepInput({ writer: sandbox }));
    const other = "d".repeat(64);
    await w.blobs.put(evidencePackKey(TASK, other), Buffer.from(JSON.stringify(await stored(w.blobs)), "utf8"), { contentType: "application/json", metadata: { kind: "evidence-pack" }, retention: "evidence-std" }, { overwrite: true });
    expect(await loadEvidencePack(w.blobs, TASK, other)).toBeUndefined();
    expect(await loadEvidenceRead(w.blobs, TASK, other)).toBeUndefined();
  });
  it("keeps nothing rather than a v2 pack the strict schema refuses (an unregistered check kind cannot happen, but a bad producer would)", async () => {
    const w = world();
    const bad = { version: 2, producer: { edition: "code", isolation: "teleport" } } as unknown as EvidenceV2Writer;
    expect(await keepEvidence(w.deps, keepInput({ writer: bad }))).toEqual({ kept: false, reason: "invalid" });
    expect(await w.blobs.get(evidencePackKey(TASK, DIGEST), 1_000)).toBeUndefined();
  });
});

const v1 = (checks: CheckEntry[], extra: Record<string, unknown> = {}): EvidencePack => buildEvidencePack({ candidateDigest: DIGEST, checks, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map(), ...extra }).pack!;

describe("the level and the result", () => {
  it.each([
    ["a sandbox run, no CI facts", { version: 2, producer: { edition: "code", isolation: "sandbox" } }, "rovara_real_run", undefined],
    ["a sealed run", { version: 2, producer: { edition: "cloud", isolation: "sealed" } }, "rovara_real_run", undefined],
    ["a sealed run on a repository with no CI names the weakest link", { version: 2, producer: { edition: "cloud", isolation: "sealed" }, ciLevel: "no_ci" }, "rovara_real_run", "No CI on this repository"],
    ["a sealed run with CI that could not be read", { version: 2, producer: { edition: "cloud", isolation: "sealed" }, ciLevel: "ci_not_readable" }, "rovara_real_run", "CI not readable"],
    ["a developer machine with CI that passed", { version: 2, producer: { edition: "code", isolation: "developer_machine" }, ciLevel: "their_ci" }, "their_ci", undefined],
    ["a developer machine with no CI", { version: 2, producer: { edition: "code", isolation: "developer_machine" }, ciLevel: "no_ci" }, "no_ci", undefined],
    ["a developer machine with CI not readable", { version: 2, producer: { edition: "code", isolation: "developer_machine" }, ciLevel: "ci_not_readable" }, "ci_not_readable", undefined],
    ["a developer machine while CI is still running", { version: 2, producer: { edition: "code", isolation: "developer_machine" } }, "sandbox_only", undefined],
    ["an imported result is never a Rovara run", { version: 2, producer: { edition: "cloud", isolation: "imported" }, ciLevel: "their_ci" }, "their_ci", undefined],
  ])("%s", (_name, writer, reached, weakestWords) => {
    const pack = evidencePackV2Of(v1([entry("readiness:0", "pytest -q")]), writer as EvidenceV2Writer)!;
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
    expect(pack.level.reached).toBe(reached);
    expect(pack.level.weakest?.words).toBe(weakestWords);
  });
  it("a Rovara run with no check that ran is not a real run", () => {
    expect(evidenceLevelOf(v1([entry("readiness:0", "pytest -q", { after: "not_run" })]), sandbox).reached).toBe("sandbox_only");
    expect(evidenceLevelOf(v1([]), sandbox).reached).toBe("sandbox_only");
  });
  it.each([
    ["all passed", [entry("a", "a")], "verified"],
    ["a regression", [entry("a", "a"), entry("b", "b", { after: "failed", class: "regression" })], "code_failed"],
    ["failing with no before", [entry("a", "a", { before: "unknown", after: "failed", class: "failing_no_before" })], "code_failed"],
    ["already failing is not a verification", [entry("a", "a", { before: "failed", after: "failed", class: "already_failing" })], "partially_verified"],
    ["a check that timed out", [entry("a", "a"), entry("b", "b", { after: "timed_out" })], "partially_verified"],
    ["a check that did not run", [entry("a", "a"), entry("b", "b", { after: "not_run" })], "partially_verified"],
    ["no check at all", [], "partially_verified"],
  ] as const)("%s -> %s", (_name, checks, result) => {
    expect(evidenceResultOf(v1([...checks]), false)).toBe(result);
  });
  it("blocked by the environment wins when the caller says so, and a failed code check still wins over a partial one", () => {
    expect(evidenceResultOf(v1([entry("a", "a")]), true)).toBe("blocked_by_environment");
  });
});

describe("the pack the writer makes from real v1 data", () => {
  it("round-trips: the v1 pack comes back from the v2 pack, and it renders a first line and a body", () => {
    const pack = v1([entry("readiness:0", "pytest -q")], { rawText: raw });
    expect(pack.checks[0]?.tests?.total).toBe(4);
    const v2 = evidencePackV2Of(pack, sandbox)!;
    const rendering = renderEvidence(v2);
    expect(rendering.firstLine).toBe("Verified · Run by Rovara, not sealed");
    expect(rendering.text).toContain("pytest -q");
    expect(rendering.text).toContain("4 tests (1 new)");
  });
  it("puts the changed files' flags and weakening in the pack when the caller has the files, and nothing when it has none", () => {
    const pack = v1([entry("readiness:0", "pytest -q")], { rawText: raw });
    const files = [{ repository: "app", path: "CLAUDE.md", added: 1, removed: 0 }, { repository: "app", path: "a/__snapshots__/x.snap", added: 1, removed: 1, snapshotChanged: true }];
    const flagged = evidencePackV2Of(pack, { ...sandbox, changedFiles: files })!;
    expect(flagged.flags?.instructionFiles).toEqual(["CLAUDE.md"]);
    expect(flagged.weakening?.changedSnapshots).toEqual(["a/__snapshots__/x.snap"]);
    expect(EvidencePackV2Schema.safeParse(flagged).success).toBe(true);
    const plain = evidencePackV2Of(pack, sandbox)!;
    expect(plain.flags).toBeUndefined();
    expect(plain.weakening).toBeUndefined();
  });
  it("a pack with the most checks, test names and not-tested rows still fits the v2 size the reader reads", () => {
    const checks = Array.from({ length: 64 }, (_unused, index) => entry(`readiness:${String(index)}`, `check ${String(index)} ${"x".repeat(150)}`));
    const pack = v1(checks);
    const v2 = evidencePackV2Of(pack, sandbox)!;
    expect(Buffer.byteLength(JSON.stringify(v2), "utf8")).toBeLessThan(4 * 1_048_576);
    expect(readEvidencePack(JSON.parse(JSON.stringify(v2))).status).toBe("v2");
  });
});

describe("TE-B3's shapes: no zero or empty shape is made up", () => {
  it("facts with nothing to say give no part at all, and a zero count or a skip count that did not rise is not written", () => {
    expect(weakeningPartsOf({ absentOnNew: [], absentOnNewCount: 0, changedTestConfig: [], changedSnapshots: [], changedFixtures: [], instructionFiles: [], ciExecutedFiles: [] })).toEqual({});
    expect(weakeningPartsOf({ skipRise: { before: 3, after: 3 } })).toEqual({});
    expect(weakeningPartsOf({ skipRise: { before: 5, after: 2 } })).toEqual({});
  });
  it("a real rise and a real count are written, and a count of zero never is", () => {
    const rise = weakeningPartsOf({ skipRise: { before: 1, after: 4 } });
    expect(rise.weakening?.skipRise).toEqual({ before: 1, after: 4 });
    expect(rise.weakening !== undefined && "absentOnNewCount" in rise.weakening).toBe(false);
    const absent = weakeningPartsOf({ absentOnNew: ["t.py::gone"], absentOnNewCount: 3 });
    expect(absent.weakening?.absentOnNewCount).toBe(3);
    expect(absent.weakening !== undefined && "skipRise" in absent.weakening).toBe(false);
    expect(absent.flags).toBeUndefined();
    const other = weakeningPartsOf({ changedSnapshots: ["a/__snapshots__/x.snap"], absentOnNew: [], absentOnNewCount: 0 });
    expect(other.weakening?.changedSnapshots).toEqual(["a/__snapshots__/x.snap"]);
    expect(other.weakening !== undefined && "absentOnNewCount" in other.weakening).toBe(false);
  });
  it("a pack whose checks compared and found nothing (zero counts, skips equal) is written with no weakening part, and the v2 pack still parses", () => {
    const base = JSON.parse(raw) as { checks: { tests: Record<string, unknown> }[] };
    base.checks[0]!.tests = { ...base.checks[0]!.tests, skippedBefore: 2, skippedAfter: 2, absentOnNew: [], absentOnNewCount: 0 };
    const pack = buildEvidencePack({ candidateDigest: DIGEST, rawText: JSON.stringify(base), checks: [entry("readiness:0", "pytest -q")], checkKinds: new Map([["readiness:0", "test" as const]]), environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map() }).pack!;
    const v2 = evidencePackV2Of(pack, { ...sandbox, changedFiles: [{ repository: "app", path: "src/a.ts", added: 1, removed: 0 }] })!;
    expect(v2.weakening).toBeUndefined();
    expect(v2.flags).toBeUndefined();
    expect(EvidencePackV2Schema.safeParse(v2).success).toBe(true);
  });
});
