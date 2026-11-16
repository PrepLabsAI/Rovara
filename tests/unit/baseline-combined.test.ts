// TE-MR2b: ONE combined baseline for a task that holds several repositories. Each repository's base is compared with the nearest trusted run of its own (TE-C1's per-commit rows); the combination exists only when EVERY
// repository has one, on one branch, from one kind of writer. Anything less is no baseline (today's behaviour), never a baseline of some of the repositories. The words name each repository's commit; a repository-less
// failing set never excuses a failure across repositories (`alreadyFailingFromBaseline` gives nothing for a combined baseline).
import { describe, expect, it } from "vitest";
import {
  BaselineRowSchema, EvidenceBaselineSchema, EvidenceRawSchema, RawRepositoryBaselinesSchema, baselineWords, projectRevisionKey, type BaselineRow, type EvidenceBaseline, type CheckEntry,
} from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { keepEvidence, loadEvidenceBaseline, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { combinedBaselineFor, mintTrustedBaselineRun, recordBaselineRow } from "../../packages/broker/src/core/test-env/baseline-cache.js";
import { alreadyFailingFromBaseline, evidenceCombinedBaselineOf, taskBaselineOf } from "../../packages/broker/src/core/test-env/baseline-task.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const HOUR = 3_600_000;
const ORG = `org_${"a".repeat(20)}`;
const PROJECT = "payments";
const DIGEST = "c".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const row = (n: number, hours: number, over: Partial<BaselineRow> = {}): BaselineRow => BaselineRowSchema.parse({
  recordedAt: new Date(NOW - hours * HOUR).toISOString(), envRevision: 1, branch: "main", headSha: sha(n), finishedAt: new Date(NOW - hours * HOUR).toISOString(), writer: "nightly",
  tests: { total: 10, passed: 7, failed: 2, skipped: 1 }, failed: ["a.py::x", "a.py::y"], flaky: ["b.py::z"], ...over,
});
const claim = (repositoryId: string, n: number, commitsBack = 0) => ({ repositoryId, sha: sha(n), commitsBack });
const lead = (prefix: string, repositoryId: string, commitsBack = 0) => ({ repositoryId, sha: prefix.padEnd(40, "0"), commitsBack });
const entry = (id: string): CheckEntry => ({ id, label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 });

async function world(rows: BaselineRow[], rawBaselines: unknown, candidates?: string[], repositoryNames: string[] = ["lib", "service"]) {
  const documents = new MemoryDocumentStore();
  const testEnv = { store: documents, now: () => NOW, env: { ROVARA_BASELINE_CACHE: "1" } };
  for (const value of rows) await recordBaselineRow(testEnv, mintTrustedBaselineRun({ orgId: ORG, project: PROJECT, row: value }));
  await documents.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: repositoryNames.map((name) => ({ name, url: `https://example.invalid/${name}.git`, path: name, defaultBranch: "main", credentialRef: "c" })) } } });
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: ORG });
  const rawText = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], ...(rawBaselines === undefined ? {} : { baselines: rawBaselines }) });
  const deps: KeepEvidenceDeps = {
    scan: scanTextForTests, store: { blobs },
    actions: { async artifacts() { return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; }, async readArtifact(key: string, max: number) { return key === `${PREFIX}evidence-raw.json` ? Buffer.from(rawText).subarray(0, max) : undefined; } },
  } as never;
  const offered = candidates ?? rows.map((value) => value.headSha);
  const baseline = taskBaselineOf(testEnv, { orgId: ORG, project: PROJECT, taskId: TASK.taskId, plan: { revision: 1, baselineCandidates: offered.map((value) => ({ sha: value })) } });
  const keep = () => keepEvidence(deps, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline });
  return { documents, blobs, keep, testEnv };
}

describe("the wire shapes", () => {
  it("the worker's claims are one per repository, at least two, at most 32, strict, shas and counts 0 to 50", () => {
    expect(RawRepositoryBaselinesSchema.safeParse([claim("a", 1), claim("b", 2, 50)]).success).toBe(true);
    for (const bad of [[claim("a", 1)], [claim("a", 1), claim("a", 2)], [claim("a", 1), claim("b", 1)], [claim("a", 1), { ...claim("b", 2), extra: 1 }], [claim("a", 1), claim("b", 2, 51)], [claim("a", 1), claim("b bad", 2)], [claim("a", 1), { ...claim("b", 2), sha: "main" }],
      Array.from({ length: 33 }, (_, i) => claim(`r${String(i)}`, i + 1))]) expect(RawRepositoryBaselinesSchema.safeParse(bad).success).toBe(false);
    expect(RawRepositoryBaselinesSchema.safeParse(Array.from({ length: 32 }, (_, i) => claim(`r${String(i)}`, i + 1))).success).toBe(true);
  });
  it("a raw file carries one claim or the combined claims, never both, and an old file still parses", () => {
    const raw = { schemaVersion: 1, candidateDigest: DIGEST, checks: [] };
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
    expect(EvidenceRawSchema.safeParse({ ...raw, baselines: [claim("a", 1), claim("b", 2)] }).success).toBe(true);
    expect(EvidenceRawSchema.safeParse({ ...raw, baseline: { sha: sha(1), commitsBack: 0 }, baselines: [claim("a", 1), claim("b", 2)] }).success).toBe(false);
  });
  it("the stored words name each repository when the baseline is combined, and the old words parse as before", () => {
    const old = { schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 2, ageHours: 5, knownFailing: 1, flaky: 0 };
    expect(EvidenceBaselineSchema.safeParse(old).success).toBe(true);
    expect(EvidenceBaselineSchema.safeParse({ ...old, repositories: [claim("a", 1), claim("b", 2)] }).success).toBe(true);
    expect(EvidenceBaselineSchema.safeParse({ ...old, repositories: [claim("a", 1)] }).success).toBe(false);
    expect(EvidenceBaselineSchema.safeParse({ ...old, repositories: [claim("a", 1), claim("a", 2)] }).success).toBe(false);
  });
  it("the line names every repository's commit and says partial when any is behind", () => {
    const words: EvidenceBaseline = { schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 3, ageHours: 5, knownFailing: 4, flaky: 1, repositories: [lead("abc1234", "payments-lib"), lead("8d3e11a", "service", 3)] };
    expect(baselineWords(words)).toBe("Compared with main at payments-lib abc1234, service 8d3e11a (nightly, 5 h old, 3 commits back; partial): 4 known failing, 1 flaky");
    expect(baselineWords({ ...words, commitsBack: 0, repositories: [lead("abc1234", "payments-lib"), lead("8d3e11a", "service")] })).toBe("Compared with main at payments-lib abc1234, service 8d3e11a (nightly, 5 h old): 4 known failing, 1 flaky");
    const hostile = baselineWords({ ...words, repositories: [{ ...claim("a", 1), repositoryId: "[x](https://evil.example)" }, claim("b", 2)] });
    expect(hostile).not.toMatch(/\]\(|\n/u);
  });
});

describe("the engine's combination", () => {
  const find = (store: MemoryDocumentStore, parts: Array<{ repositoryId: string; sha: string; commitsBack: number }>, over: Record<string, unknown> = {}) =>
    combinedBaselineFor({ store, now: () => NOW }, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main", parts, ...over });

  it("is found when every repository has a trusted run, with the oldest age, the farthest commit count and the sums", async () => {
    const w = await world([row(1, 3), row(2, 10, { tests: { total: 5, passed: 4, failed: 1, skipped: 0 }, failed: ["c.py::q"], flaky: [] })], undefined);
    const found = (await find(w.documents, [claim("lib", 1), claim("service", 2, 4)]))!;
    expect(found).toMatchObject({ commitsBack: 4, partial: true, ageHours: 10 });
    expect(found.parts.map((part) => [part.repositoryId, part.found.row.headSha])).toEqual([["lib", sha(1)], ["service", sha(2)]]);
    expect(evidenceCombinedBaselineOf(found)).toEqual({ schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 4, ageHours: 10, knownFailing: 3, flaky: 1, repositories: [claim("lib", 1), claim("service", 2, 4)] });
  });
  it("is not found when ANY repository has none, when two repositories name one commit, or with fewer than two", async () => {
    const w = await world([row(1, 3), row(2, 3)], undefined);
    expect(await find(w.documents, [claim("lib", 1), claim("service", 9)])).toBeUndefined();
    expect(await find(w.documents, [claim("lib", 1), claim("service", 1)])).toBeUndefined();
    expect(await find(w.documents, [claim("lib", 1)])).toBeUndefined();
    expect(await find(w.documents, [])).toBeUndefined();
    expect(await find(w.documents, [claim("lib", 1), claim("service", 2)])).toBeDefined();
  });
  it("uses no row of another revision, branch or company, and none from two kinds of writer or two branches", async () => {
    const w = await world([row(1, 3), row(2, 3)], undefined);
    expect(await find(w.documents, [claim("lib", 1), claim("service", 2)], { envRevision: 2 })).toBeUndefined();
    expect(await find(w.documents, [claim("lib", 1), claim("service", 2)], { branch: "release" })).toBeUndefined();
    expect(await find(w.documents, [claim("lib", 1), claim("service", 2)], { orgId: `org_${"b".repeat(20)}` })).toBeUndefined();
    const mixed = await world([row(1, 3), row(2, 3, { writer: "readiness" })], undefined);
    expect(await find(mixed.documents, [claim("lib", 1), claim("service", 2)])).toBeUndefined();
  });
  it("a claim farther than 50 commits, or not an integer, finds nothing", async () => {
    const w = await world([row(1, 3), row(2, 3)], undefined);
    expect(await find(w.documents, [claim("lib", 1, 51), claim("service", 2)])).toBeUndefined();
    expect(await find(w.documents, [claim("lib", 1, 1.5), claim("service", 2)])).toBeUndefined();
  });
  it("excuses no failure: a combined baseline's repository-less failing set is never read as the failing set of a repository", async () => {
    const w = await world([row(1, 3), row(2, 3)], undefined);
    const found = (await find(w.documents, [claim("lib", 1), claim("service", 2)]))!;
    const words = evidenceCombinedBaselineOf(found);
    expect(await alreadyFailingFromBaseline({ store: w.documents, now: () => NOW }, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main", words: { sha: words.sha, commitsBack: words.commitsBack, repositories: words.repositories } })).toBeUndefined();
    // Positive control: the same row, asked as a single repository's words, does excuse its failing tests.
    expect(await alreadyFailingFromBaseline({ store: w.documents, now: () => NOW }, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main", words: { sha: sha(1), commitsBack: 0, repositories: undefined } })).toEqual(["a.py::x", "a.py::y"]);
  });
});

describe("the keeper", () => {
  const kept = async (w: Awaited<ReturnType<typeof world>>) => loadEvidenceBaseline(w.blobs, TASK, DIGEST);
  it("keeps the combined words when every claimed commit was offered and every repository has a row", async () => {
    const w = await world([row(1, 3), row(2, 6)], [claim("lib", 1), claim("service", 2, 2)]);
    expect(await w.keep()).toMatchObject({ kept: true });
    expect(await kept(w)).toMatchObject({ sha: sha(1), commitsBack: 2, ageHours: 6, knownFailing: 4, flaky: 2, repositories: [claim("lib", 1), claim("service", 2, 2)] });
  });
  it("keeps nothing when one claimed commit was not offered, even if a row exists for it", async () => {
    const w = await world([row(1, 3), row(2, 6)], [claim("lib", 1), claim("service", 2)], [sha(1)]);
    await w.keep();
    expect(await kept(w)).toBeUndefined();
  });
  it("keeps nothing for a claim of some of the project's repositories, or of names the project does not have", async () => {
    const some = await world([row(1, 3), row(2, 6)], [claim("lib", 1), claim("service", 2)], undefined, ["lib", "service", "docs"]);
    await some.keep();
    expect(await kept(some)).toBeUndefined();
    const foreign = await world([row(1, 3), row(2, 6)], [claim("lib", 1), claim("payments", 2)]);
    await foreign.keep();
    expect(await kept(foreign)).toBeUndefined();
    // Positive control: the same rows and the project's own names.
    const own = await world([row(1, 3), row(2, 6)], [claim("lib", 1), claim("service", 2)]);
    await own.keep();
    expect(await kept(own)).toBeDefined();
  });
  it("keeps nothing when one repository has no row, and nothing when the plan offered nothing", async () => {
    const w = await world([row(1, 3)], [claim("lib", 1), claim("service", 2)], [sha(1), sha(2)]);
    await w.keep();
    expect(await kept(w)).toBeUndefined();
    const none = await world([row(1, 3), row(2, 3)], [claim("lib", 1), claim("service", 2)], []);
    await none.keep();
    expect(await kept(none)).toBeUndefined();
  });
});
