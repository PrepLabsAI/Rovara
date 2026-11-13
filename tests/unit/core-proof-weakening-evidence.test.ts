// TE-B3: the facts from the worker's run on the original code (test-proof.json) reach the evidence pack: skips among untouched tests before and now, and the tests that ran before and are gone. The worker is untrusted: the
// facts join the raw file before the data guard and the builder, are bound to this code's digest and the operation's own prefix, and a name is redacted again. Old packs without the facts keep parsing and rendering.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EvidencePackSchema, readEvidencePack, renderEvidenceRead, type CheckEntry } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidencePackKey, keepEvidence, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { buildEvidencePack } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const OTHER = "e".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const tests = (over: Record<string, unknown> = {}) => ({ total: 4, passed: 3, failed: 0, skipped: 1, errored: 0, names: [{ name: "t.py::a", status: "passed" }], newTests: [], ...over });
const raw = (testsPart = tests(), digest = DIGEST) => JSON.stringify({ schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", tests: testsPart }], selection: { method: "full", selected: 4, total: 4 } });
const proof = (weakening: unknown, digest = DIGEST) => JSON.stringify({ schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], weakening, durationMs: 5 });
const fact = (over: Record<string, unknown> = {}) => ({ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 1, absentOnNew: ["t.py::gone"], absentOnNewCount: 1, ...over });

function world(files: { raw?: string | undefined; proof?: string | undefined; proofKey?: string }) {
  const documents = new MemoryDocumentStore();
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: "org_00000000000000000000" });
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() {
      return [
        ...(files.raw === undefined ? [] : [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]),
        ...(files.proof === undefined ? [] : [{ name: "test-proof.json", objectKey: files.proofKey ?? `${PREFIX}test-proof.json` }]),
      ];
    },
    async readArtifact(key, max) {
      if (key === `${PREFIX}evidence-raw.json`) return (files.raw ?? "").slice(0, max);
      return (files.proof ?? "").slice(0, max);
    },
  };
  const deps: KeepEvidenceDeps = { scan: scanTextForTests, actions, store: { blobs } };
  return { deps, blobs };
}
const input = (over: Record<string, unknown> = {}) => ({ orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")], ...over });
const kept = async (files: Parameters<typeof world>[0]) => {
  const w = world(files);
  const result = await keepEvidence(w.deps, input());
  return { result, pack: await loadEvidencePack(w.blobs, TASK, DIGEST) };
};

describe("the facts from the original code's run reach the pack", () => {
  it("puts the skip counts and the absent tests in the check's tests part, and says so in the not-tested rows", async () => {
    const { result, pack } = await kept({ raw: raw(), proof: proof([fact()]) });
    expect(result).toMatchObject({ kept: true });
    expect(pack?.checks[0]?.tests).toMatchObject({ skippedBefore: 0, skippedAfter: 1, absentOnNew: ["t.py::gone"], absentOnNewCount: 1 });
    expect(pack?.notTested).toContainEqual({ kind: "check", id: "readiness:0", text: "pytest -q", reason: "more tests skipped than before" });
    expect(pack?.notTested).toContainEqual({ kind: "check", id: "absent:readiness:0", text: "pytest -q", reason: "1 test ran before and not now" });
  });
  it("a pack made without the facts is what it was: no fields, no rows", async () => {
    const { pack } = await kept({ raw: raw() });
    expect(pack?.checks[0]?.tests).not.toHaveProperty("absentOnNew");
    expect(pack?.checks[0]?.tests).not.toHaveProperty("skippedBefore");
    expect(pack?.notTested.some((item) => item.id.startsWith("absent:"))).toBe(false);
  });
  it("does not read facts for other code, from outside the operation's own prefix, or that do not parse", async () => {
    for (const files of [
      { raw: raw(), proof: proof([fact()], OTHER) },
      { raw: raw(), proof: proof([fact()]), proofKey: `private/another-owner/${TASK.workspaceId}/${OP}/test-proof.json` },
      { raw: raw(), proof: proof([fact({ absentOnNewCount: 0 })]) },
      { raw: raw(), proof: "{ not json" },
    ]) {
      const { result, pack } = await kept(files);
      expect(result).toMatchObject({ kept: true });
      expect(pack?.checks[0]?.tests, JSON.stringify(files).slice(0, 80)).not.toHaveProperty("absentOnNew");
    }
  });
  it("the raw file's own numbers win, and a rise that cannot be some of the skips is not used", async () => {
    const own = await kept({ raw: raw(tests({ skipped: 3, passed: 1, skippedBefore: 3, skippedAfter: 3 })), proof: proof([fact({ skippedBefore: 0, skippedAfter: 1 })]) });
    expect(own.pack?.checks[0]?.tests).toMatchObject({ skippedBefore: 3, skippedAfter: 3 });
    const impossible = await kept({ raw: raw(tests({ skipped: 0, passed: 4 })), proof: proof([fact({ skippedBefore: 0, skippedAfter: 2 })]) });
    expect(impossible.pack?.checks[0]?.tests).not.toHaveProperty("skippedAfter");
    expect(impossible.pack?.checks[0]?.tests?.absentOnNew).toEqual(["t.py::gone"]);
  });
  it("redacts a name again and drops the details of a check whose absent names hold a credential, like any other test name", async () => {
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const w = world({ raw: raw(), proof: proof([fact({ absentOnNew: [`t.py::leak ${secret}`] })]) });
    await keepEvidence(w.deps, input());
    const stored = JSON.stringify(await loadEvidencePack(w.blobs, TASK, DIGEST));
    expect(stored).not.toContain(secret);
  });
  it("is checked against the check: a name list longer than its count is refused by the schema and the facts are not used", async () => {
    const { pack } = await kept({ raw: raw(), proof: proof([fact({ absentOnNew: ["a", "b"], absentOnNewCount: 1 })]) });
    expect(pack?.checks[0]?.tests).not.toHaveProperty("absentOnNew");
  });
  it("is written under the key of this code only", async () => {
    const w = world({ raw: raw(), proof: proof([fact()]) });
    await keepEvidence(w.deps, input());
    expect(await loadEvidencePack(w.blobs, TASK, OTHER)).toBeUndefined();
    expect(evidencePackKey(TASK, DIGEST)).toContain(DIGEST);
  });
});

describe("the builder", () => {
  const build = (testsPart: Record<string, unknown>) => buildEvidencePack({
    candidateDigest: DIGEST, rawText: raw(tests(testsPart)), checks: [entry("readiness:0", "pytest -q")], checkKinds: new Map([["readiness:0", "test"]]),
    environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map(),
  });
  it("shows a name that is not a valid id as one plain cut line, and a valid one as it is", () => {
    // A trailing space makes an id that is not valid (it is never matched against a failing set); it is shown trimmed. A name over 500 characters never reaches here: the raw schema refuses the whole file.
    const built = build({ absentOnNew: ["t.py::fine", "t.py::bad "], absentOnNewCount: 2 });
    expect(built.pack?.checks[0]?.tests?.absentOnNew).toEqual(["t.py::fine", "t.py::bad"]);
    expect(build({ absentOnNew: [`t.py::${"x".repeat(600)}`], absentOnNewCount: 1 }).problems).toContain("raw_unreadable");
  });
  it("says nothing for a count of zero", () => {
    expect(build({ absentOnNew: [], absentOnNewCount: 0 }).pack?.notTested.some((item) => item.id.startsWith("absent:"))).toBe(false);
  });
});

describe("old packs keep working", () => {
  it("a v1 pack with no weakening fields parses and a v1 pack with them parses; the reader says it is v1", () => {
    const base = { schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, selection: { method: "full", selected: 4, total: 4 }, api: [], browser: [], notTested: [] };
    const check = (testsPart: Record<string, unknown>) => ({ checkId: "readiness:0", kind: "test", label: "pytest", before: "passed", after: "passed", class: "passing", durationMs: 1, tests: tests(testsPart) });
    expect(EvidencePackSchema.safeParse({ ...base, checks: [check({})] }).success).toBe(true);
    const withFacts = { ...base, checks: [check({ absentOnNew: ["t.py::a"], absentOnNewCount: 1 })] };
    expect(EvidencePackSchema.safeParse(withFacts).success).toBe(true);
    expect(readEvidencePack(withFacts).status).toBe("v1");
    expect(renderEvidenceRead(readEvidencePack(withFacts)).firstLine).toBe("Evidence from an older Rovara, open in Rovara for the level");
    // Both or neither; the count is at least the names.
    expect(EvidencePackSchema.safeParse({ ...base, checks: [check({ absentOnNew: ["t.py::a"] })] }).success).toBe(false);
    expect(EvidencePackSchema.safeParse({ ...base, checks: [check({ absentOnNew: ["a", "b"], absentOnNewCount: 1 })] }).success).toBe(false);
  });
});

// ---- Opus review M1: a pack with nothing to flag has none of the new keys
describe("M1: the new keys are written only when there is something to say", () => {
  it("a compared check with nothing found adds no key to the pack and no not-tested row", async () => {
    const { pack } = await kept({ raw: raw(), proof: proof([fact({ skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 })]) });
    const tests = pack?.checks[0]?.tests ?? {};
    for (const key of ["absentOnNew", "absentOnNewCount", "skippedBefore", "skippedAfter"]) expect(tests, key).not.toHaveProperty(key);
    expect(pack?.notTested.some((item) => item.id.startsWith("absent:") || item.reason.includes("skipped"))).toBe(false);
  });
  it("a fall in skips adds nothing; a real rise adds both skip counts and no absent keys; absent tests add only the absent keys", async () => {
    const fall = await kept({ raw: raw(tests({ skipped: 3, passed: 1 })), proof: proof([fact({ skippedBefore: 3, skippedAfter: 1, absentOnNew: [], absentOnNewCount: 0 })]) });
    expect(fall.pack?.checks[0]?.tests).not.toHaveProperty("skippedAfter");
    const rise = await kept({ raw: raw(), proof: proof([fact({ absentOnNew: [], absentOnNewCount: 0 })]) });
    expect(rise.pack?.checks[0]?.tests).toMatchObject({ skippedBefore: 0, skippedAfter: 1 });
    expect(rise.pack?.checks[0]?.tests).not.toHaveProperty("absentOnNew");
    const gone = await kept({ raw: raw(), proof: proof([fact({ skippedBefore: 0, skippedAfter: 0 })]) });
    expect(gone.pack?.checks[0]?.tests).toMatchObject({ absentOnNew: ["t.py::gone"], absentOnNewCount: 1 });
    expect(gone.pack?.checks[0]?.tests).not.toHaveProperty("skippedAfter");
  });
  it("an old-shape reader (the tests part as it was before TE-B3, strict) still reads a new pack that has nothing to flag", async () => {
    const OldTests = z.object({ total: z.number(), passed: z.number(), failed: z.number(), skipped: z.number(), errored: z.number(), skippedBefore: z.number().optional(), skippedAfter: z.number().optional(), names: z.array(z.unknown()), newTests: z.array(z.string()) }).strict();
    const { pack } = await kept({ raw: raw(), proof: proof([fact({ skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 })]) });
    expect(OldTests.safeParse(pack?.checks[0]?.tests).success).toBe(true);
    // And a pack that does flag something is refused by that old reader: the reason the reader ships first.
    const flagged = await kept({ raw: raw(), proof: proof([fact()]) });
    expect(OldTests.safeParse(flagged.pack?.checks[0]?.tests).success).toBe(false);
  });
  it("loadEvidencePack reads a kept pack whose tests part has a key a newer writer added (the key is dropped)", async () => {
    const w = world({ raw: raw() });
    await keepEvidence(w.deps, input());
    const key = evidencePackKey(TASK, DIGEST);
    const stored = JSON.parse(Buffer.from((await w.blobs.get(key, 10_000_000))!).toString("utf8")) as { checks: Array<{ tests: Record<string, unknown> }> };
    stored.checks[0]!.tests["newerPart"] = [1];
    await w.blobs.put(key, Buffer.from(JSON.stringify(stored), "utf8"), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    const read = await loadEvidencePack(w.blobs, TASK, DIGEST);
    expect(read?.checks[0]?.tests?.total).toBe(4);
    expect(read?.checks[0]?.tests).not.toHaveProperty("newerPart");
  });
});
