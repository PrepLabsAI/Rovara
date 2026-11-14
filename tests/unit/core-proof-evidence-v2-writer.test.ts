// TE-A2b: the broker's pack WRITER can write version 2. The default is still version 1 (a Cloud reader that is strict about v1 must not meet a v2 pack before the Cloud half and the TE-A1 gate exist); readers accept both.
// The level and the result are decided here from facts the broker has (where the checks ran, how the CI reads, the checks' own outcomes); the CI part comes from TE-B2's `ciEvidenceLevel`, passed in by the caller.
// Old v1 data keeps working: the v2 pack is made from a pack `buildEvidencePack` really built, not only a fixture.
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, EvidencePackV2Schema, readEvidencePack, readEvidencePackText, renderEvidence, type CheckEntry, type EvidencePack } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import type { ChangedFileEntry } from "../../packages/broker/src/core/proof/verification-report.js";
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
  it("a developer machine while the CI is still running is worded as a laptop report, not as a sandbox with no sealed run (L1, O26)", () => {
    const pack = evidencePackV2Of(v1([entry("readiness:0", "pytest -q")]), { version: 2, producer: { edition: "code", isolation: "developer_machine" } })!;
    const first = renderEvidence(pack).firstLine;
    expect(first).toBe("Verified · Ran on a developer machine");
    expect(first).not.toContain("Sandbox only");
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
    const files: ChangedFileEntry[] = [{ repository: "app", path: "CLAUDE.md", added: 1, removed: 0 }, { repository: "app", path: "a/__snapshots__/x.snap", added: 1, removed: 1, snapshotChanged: true }];
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

describe("TE-A2b review M1: a stored v2 pack with something newer in a check's tests still loads as v1 parts", () => {
  it("loadEvidencePack reads a v2 pack whose tests part has a key this build does not know", async () => {
    const w = world();
    await keepEvidence(w.deps, keepInput({ writer: sandbox }));
    const pack = await stored(w.blobs) as { checks: { tests: Record<string, unknown> }[] };
    pack.checks[0]!.tests.flakyRetries = 3;
    await w.blobs.put(evidencePackKey(TASK, DIGEST), Buffer.from(JSON.stringify(pack), "utf8"), { contentType: "application/json", metadata: { kind: "evidence-pack" }, retention: "evidence-std" }, { overwrite: true });
    expect((await loadEvidenceRead(w.blobs, TASK, DIGEST))?.status).toBe("v2");
    const v1 = await loadEvidencePack(w.blobs, TASK, DIGEST);
    expect(v1?.checks[0]).toMatchObject({ checkId: "readiness:0" });
  });
});

describe("TE-A2b review M2: one odd file name never suppresses the pack", () => {
  const entryOf = (path: string, extra: Record<string, unknown> = {}) => ({ repository: "app", path, added: 1, removed: 0, ...extra });
  const longClaude = `${"d/".repeat(260)}CLAUDE.md`;
  const longSnapshot = `tests/__snapshots__/${"a".repeat(586)}.snap`;
  it.each([
    ["a 529-character CLAUDE.md path", entryOf(longClaude)],
    ["a name with a newline", entryOf("AGENTS.md\nevil")],
    ["a 611-character snapshot path", entryOf(longSnapshot, { snapshotChanged: true })],
  ])("%s still produces a pack, with the path cut to what the schema reads", (_name, file) => {
    expect(longClaude.length).toBe(529);
    expect(longSnapshot.length).toBe(611);
    const pack = evidencePackV2Of(v1([entry("readiness:0", "pytest -q")], { rawText: raw }), { ...sandbox, changedFiles: [file] });
    expect(pack).toBeDefined();
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
  });
  it("keeps the end of a long path (the file name) and a flagged instruction file stays flagged", () => {
    const pack = evidencePackV2Of(v1([entry("readiness:0", "pytest -q")], { rawText: raw }), { ...sandbox, changedFiles: [entryOf(longClaude)] })!;
    const [shown] = pack.flags!.instructionFiles;
    expect(shown!.length).toBeLessThanOrEqual(500);
    expect(shown!.endsWith("CLAUDE.md")).toBe(true);
  });
  it("a name that is nothing but hidden characters is dropped and counted, and the pack is still kept", async () => {
    const report = { droppedPaths: 0 };
    const pack = evidencePackV2Of(v1([entry("readiness:0", "pytest -q")], { rawText: raw }), { ...sandbox, changedFiles: [entryOf("\u200b\n", { snapshotChanged: true }), entryOf("a/__snapshots__/x.snap", { snapshotChanged: true })] }, report);
    expect(pack?.weakening?.changedSnapshots).toEqual(["a/__snapshots__/x.snap"]);
    expect(report.droppedPaths).toBe(1);
    const w = world();
    const logged: unknown[] = [];
    const result = await keepEvidence({ ...w.deps, log: (event, data) => { logged.push([event, data]); } }, keepInput({ writer: { ...sandbox, changedFiles: [entryOf("\u200b", { snapshotChanged: true })] } }));
    expect(result).toMatchObject({ kept: true });
    expect(logged).toContainEqual(["evidence.paths_dropped", { count: 1 }]);
  });
  it("the whole keep path keeps a pack for each odd name", async () => {
    for (const file of [entryOf(longClaude), entryOf("AGENTS.md\nevil"), entryOf(longSnapshot, { snapshotChanged: true })]) {
      const w = world();
      expect(await keepEvidence(w.deps, keepInput({ writer: { ...sandbox, changedFiles: [file] } }))).toMatchObject({ kept: true });
      expect((await stored(w.blobs)).schemaVersion).toBe(2);
    }
  });
});

describe("TE-A2b review M4: the parts only a v2 writer adds go through the data guard too", () => {
  const CARD = "4111 1111 1111 1111";
  const KEY = `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`;
  const proofWith = (reason: string) => ({ verdicts: [], provenCount: 1, loadFailureOnOld: 0, heldDraft: false, override: { actorId: "user-1", at: "2026-11-13T12:00:00.000Z", reason } });
  it("a card number in an override reason is not stored; the rest of the proof is", async () => {
    const w = world();
    expect(await keepEvidence(w.deps, keepInput({ writer: { ...sandbox, proof: proofWith(`ok, paid with ${CARD}`) } }))).toMatchObject({ kept: true });
    const text = JSON.stringify(await stored(w.blobs));
    expect(text).not.toContain("4111");
    const pack = await stored(w.blobs) as { proof?: { provenCount: number; override?: { actorId: string; reason?: string } }; notTested: { id?: string }[] };
    expect(pack.proof?.provenCount).toBe(1);
    expect(pack.proof?.override?.reason).toBeUndefined();
    expect(pack.notTested.some((item) => item.id === "data_guard")).toBe(true);
  });
  it("a credential in an actor id drops the proof part, and one in a changed file name drops the weakening and flags parts", async () => {
    const w = world();
    const files = [{ repository: "app", path: `CLAUDE.md.${KEY}/__snapshots__/x.snap`, added: 1, removed: 0, snapshotChanged: true }];
    const proof = { ...proofWith("fine"), override: { actorId: KEY, at: "2026-11-13T12:00:00.000Z" } };
    expect(await keepEvidence(w.deps, keepInput({ writer: { ...sandbox, proof, changedFiles: files } }))).toMatchObject({ kept: true });
    const text = JSON.stringify(await stored(w.blobs));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("AKIA");
  });
  it("an address in a repository's branch name is not stored", async () => {
    const w = world();
    const repositories = [{ id: "app", baseBranch: "fix/jane.doe@gmail.com", baseCommit: "1".repeat(40), headCommit: "2".repeat(40) }];
    expect(await keepEvidence(w.deps, keepInput({ writer: { ...sandbox, repositories } }))).toMatchObject({ kept: true });
    expect(JSON.stringify(await stored(w.blobs))).not.toContain("jane.doe");
  });
  it("clean v2 parts are stored as they are (nothing is dropped for nothing)", async () => {
    const w = world();
    const repositories = [{ id: "app", baseBranch: "main", baseCommit: "1".repeat(40), headCommit: "2".repeat(40) }];
    await keepEvidence(w.deps, keepInput({ writer: { ...sandbox, repositories, proof: proofWith("reviewed by hand") } }));
    const pack = await stored(w.blobs) as { proof?: { override?: { reason?: string } }; candidate: { repositories: unknown[] }; notTested: { id?: string }[] };
    expect(pack.proof?.override?.reason).toBe("reviewed by hand");
    expect(pack.candidate.repositories).toHaveLength(1);
    expect(pack.notTested.some((item) => item.id === "data_guard")).toBe(false);
  });
});
