// TE-C1: the engine's half of the baseline claim. The worker's claim is untrusted: it is used only for a sha THIS task's plan offered and an integer commit count 0 to 50; then the engine looks the row up itself and keeps the
// words beside the evidence. Nothing a task, a callback or the worker sends can write a baseline row; the pull request line says which run the task was compared with.
import { describe, expect, it } from "vitest";
import {
  BaselineRowSchema, EvidenceBaselineSchema, projectRevisionKey, EvidencePackSchema, EvidenceRawSchema, baselineWords, type CheckEntry, type EvidenceBaseline, type EvidencePack,
} from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { eraseTaskEvidence } from "../../packages/broker/src/core/proof/evidence-erase.js";
import { evidenceBaselineKey, keepEvidence, loadEvidenceBaseline, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { evidenceLines } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { mintTrustedBaselineRun, recordBaselineRow } from "../../packages/broker/src/core/test-env/baseline-cache.js";
import { alreadyFailingFromBaseline, taskBaselineOf } from "../../packages/broker/src/core/test-env/baseline-task.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const ORG = `org_${"a".repeat(20)}`;
const PROJECT = "payments";
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const entry = (id: string): CheckEntry => ({ id, label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 });
const raw = (baseline?: unknown) => JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: ["t1", "t2", "t3"].map((name) => ({ name, status: "passed" })), newTests: [] } }], selection: { method: "full", selected: 3, total: 3 }, ...(baseline === undefined ? {} : { baseline }) });

/** A store, a keeper's deps over it, and a baseline row for `sha(1)` and `sha(2)`. */
async function world(rawText: string | undefined) {
  const documents = new MemoryDocumentStore();
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: ORG });
  const deps: KeepEvidenceDeps = {
    scan: scanTextForTests, store: { blobs },
    actions: { async artifacts() { return rawText === undefined ? [] : [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; }, async readArtifact(key, max) { return key === `${PREFIX}evidence-raw.json` && rawText !== undefined ? rawText.slice(0, max) : ""; } },
  };
  const testEnv = { store: documents, now: () => NOW, env: { ROVARA_BASELINE_CACHE: "1" } };
  for (const [n, hours] of [[1, 5], [2, 30]] as const) {
    await recordBaselineRow(testEnv, mintTrustedBaselineRun({ orgId: ORG, project: PROJECT, row: BaselineRowSchema.parse({
      recordedAt: new Date(NOW - hours * 3_600_000).toISOString(), envRevision: 1, branch: "main", headSha: sha(n), finishedAt: new Date(NOW - hours * 3_600_000).toISOString(), writer: "nightly",
      tests: { total: 10, passed: 6, failed: 3, skipped: 1 }, failed: ["a::x", "a::y"], failedUnlisted: 1, flaky: ["b::z", "b::w"] }) }));
  }
  const plan = (candidates: string[] | undefined) => ({ revision: 1, ...(candidates === undefined ? {} : { baselineCandidates: candidates.map((value) => ({ sha: value })) }) });
  // The default branch of the project, as the nightly's usability rule reads it.
  await documents.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: [{ name: "r", url: "https://example.invalid/r.git", path: "r", defaultBranch: "main", credentialRef: "c" }] } } });
  const baseline = (candidates: string[] | undefined, env: NodeJS.ProcessEnv = { ROVARA_BASELINE_CACHE: "1" }) => taskBaselineOf({ ...testEnv, env }, { orgId: ORG, project: PROJECT, plan: plan(candidates) });
  const keep = (candidates: string[] | undefined, env?: NodeJS.ProcessEnv) => keepEvidence(deps, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline: baseline(candidates, env) });
  return { deps, documents, blobs, keep, baseline };
}
const kept = async (w: Awaited<ReturnType<typeof world>>) => loadEvidenceBaseline(w.blobs, TASK, DIGEST);

describe("the claim is used only for a commit this task's plan offered", () => {
  it("keeps the words of the run the task was compared with, bound to the code, and the pack's own shape is unchanged", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 3 }));
    expect(await w.keep([sha(1), sha(2)])).toMatchObject({ kept: true });
    const words = await kept(w);
    expect(words).toEqual({ schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 3, ageHours: 5, knownFailing: 3, flaky: 2 });
    expect(baselineWords(words!)).toBe("Compared with main at 0000000 (nightly, 5 h old, 3 commits back; partial): 3 known failing, 2 flaky");
    // The pack itself carries no baseline key: a reader built before this lane still reads every pack.
    const pack = await loadEvidencePack(w.blobs, TASK, DIGEST);
    expect(EvidencePackSchema.safeParse(pack).success).toBe(true);
    expect(JSON.stringify(pack)).not.toContain("baseline");
    expect(evidenceBaselineKey(TASK, DIGEST)).toBe(`private/owner-1/ws-1/evidence-pack/task-1/${DIGEST}.baseline.json`);
    // Not for other code, another task, or a bad digest.
    expect(await loadEvidenceBaseline(w.blobs, TASK, "e".repeat(64))).toBeUndefined();
    expect(await loadEvidenceBaseline(w.blobs, { ...TASK, taskId: "task-2" }, DIGEST)).toBeUndefined();
    expect(await loadEvidenceBaseline(w.blobs, TASK, "../../x")).toBeUndefined();
  });

  it("the already-failing set is read again from the engine's own row by the kept sha, whole or not at all", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 3 }));
    await w.keep([sha(1)]);
    const words = (await kept(w))!;
    const ask = (over: Record<string, unknown> = {}) => alreadyFailingFromBaseline({ store: w.documents, now: () => NOW }, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main", words, ...over });
    expect(await ask()).toEqual(["a::x", "a::y"]);
    // Another revision, branch, company, or a commit count out of range finds nothing: the caller keeps today's rule.
    expect(await ask({ envRevision: 2 })).toBeUndefined();
    expect(await ask({ branch: "release" })).toBeUndefined();
    expect(await ask({ orgId: `org_${"b".repeat(20)}` })).toBeUndefined();
    expect(await ask({ words: { ...words, commitsBack: 51 } })).toBeUndefined();
    expect(await ask({ words: { ...words, sha: sha(9) } })).toBeUndefined();
  });

  it("ignores a sha the plan did not offer, even when a row exists for it", async () => {
    const w = await world(raw({ sha: sha(2), commitsBack: 1 }));
    expect(await w.keep([sha(1)])).toMatchObject({ kept: true });
    expect(await kept(w)).toBeUndefined();
    // Positive control: the same claim is used when the plan did offer it.
    const control = await world(raw({ sha: sha(2), commitsBack: 1 }));
    await control.keep([sha(1), sha(2)]);
    expect(await kept(control)).toMatchObject({ sha: sha(2), commitsBack: 1, ageHours: 30 });
  });

  it("ignores a claim when the plan offered nothing (an old engine, the switch off) and when there is no claim", async () => {
    const none = await world(raw({ sha: sha(1), commitsBack: 0 }));
    await none.keep(undefined);
    expect(await kept(none)).toBeUndefined();
    const off = await world(raw({ sha: sha(1), commitsBack: 0 }));
    await off.keep([sha(1)], {});
    expect(await kept(off)).toBeUndefined();
    const noClaim = await world(raw());
    await noClaim.keep([sha(1)]);
    expect(await kept(noClaim)).toBeUndefined();
  });

  it("refuses a claim out of range or not an integer (the raw file does not even parse as evidence), and still keeps the pack of the broker's own verdicts", async () => {
    for (const bad of [{ sha: sha(1), commitsBack: 51 }, { sha: sha(1), commitsBack: -1 }, { sha: sha(1), commitsBack: 1.5 }, { sha: sha(1), commitsBack: "1" }, { sha: "main", commitsBack: 1 }, { sha: sha(1), commitsBack: 1, extra: 1 }]) {
      expect(EvidenceRawSchema.safeParse(JSON.parse(raw(bad))).success).toBe(false);
      const w = await world(raw(bad));
      expect(await w.keep([sha(1)])).toMatchObject({ kept: true });
      expect(await kept(w)).toBeUndefined();
    }
  });

  it("a row that cannot be used (another revision, a failing set that did not fit, none at all) gives no words, never a made-up count", async () => {
    const w = await world(raw({ sha: sha(9), commitsBack: 1 }));
    await w.keep([sha(9)]);
    expect(await kept(w)).toBeUndefined();
    const other = await world(raw({ sha: sha(1), commitsBack: 1 }));
    const wrongRevision = taskBaselineOf({ store: other.documents, now: () => NOW, env: { ROVARA_BASELINE_CACHE: "1" } }, { orgId: ORG, project: PROJECT, plan: { revision: 2, baselineCandidates: [{ sha: sha(1) }] } });
    await keepEvidence(other.deps, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline: wrongRevision });
    expect(await kept(other)).toBeUndefined();
  });

  it("a claim for the candidate of another company's task finds nothing (the company is the task's)", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 1 }));
    const stranger = taskBaselineOf({ store: w.documents, now: () => NOW, env: { ROVARA_BASELINE_CACHE: "1" } }, { orgId: `org_${"b".repeat(20)}` as never, project: PROJECT, plan: { revision: 1, baselineCandidates: [{ sha: sha(1) }] } });
    await keepEvidence(w.deps, { orgId: "org-b", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline: stranger });
    expect(await kept(w)).toBeUndefined();
  });

  it("never writes a baseline row: a whole task round of keeping adds no row to the store", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 2 }));
    const before = (await w.documents.query({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#SHA#" } })).items.map((item) => item.sk);
    expect(before).toHaveLength(2);
    await w.keep([sha(1), sha(2)]);
    await w.keep([sha(1), sha(2)]);
    const after = (await w.documents.query({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#" } })).items.map((item) => item.sk);
    expect(after).toEqual(before);
  });

  it("a re-check of the same code replaces the words, and a re-check with no claim removes the old ones (never 'compared with' a run it was not)", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 3 }));
    await w.keep([sha(1)]);
    expect(await kept(w)).toMatchObject({ commitsBack: 3 });
    const again = await world(raw());
    await w.blobs.put(evidenceBaselineKey(TASK, DIGEST), Buffer.from(JSON.stringify({ schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 3, ageHours: 1, knownFailing: 0, flaky: 0 })), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    await keepEvidence({ ...again.deps, store: { blobs: w.blobs } }, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline: again.baseline([sha(1)]) });
    expect(await kept(w)).toBeUndefined();
  });

  it("an abandoned call (its time has run out) writes no baseline words, and the call it ran in still ends", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 3 }));
    // The keeper asks `late` before it stores the tails, before it stores the pack, and now before the words: the third answer is "late".
    let asked = 0;
    const late = () => { asked += 1; return asked >= 3; };
    const result = await keepEvidence({ ...w.deps, late }, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline: w.baseline([sha(1)]) });
    expect(result).toMatchObject({ kept: true });
    expect(asked).toBe(3);
    expect(await kept(w)).toBeUndefined();
    // Positive control: the same call, not late, writes them.
    await w.keep([sha(1)]);
    expect(await kept(w)).toBeDefined();
  });

  it("with the switch off (no baseline input) the keeper does not touch the words object at all: no write and no delete", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 3 }));
    const touched: string[] = [];
    const spy = { ...w.blobs, put: async (key: string, ...rest: Parameters<typeof w.blobs.put> extends [string, ...infer R] ? R : never) => { touched.push(`put ${key}`); await w.blobs.put(key, ...rest); }, delete: async (key: string) => { touched.push(`delete ${key}`); await w.blobs.delete(key); } };
    const deps = { ...w.deps, store: { blobs: spy } };
    await keepEvidence(deps, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")] });
    expect(touched.some((entry) => entry.includes(".baseline.json"))).toBe(false);
    expect(touched.some((entry) => entry.startsWith("put ") && entry.includes("evidence-pack"))).toBe(true);
    // Positive control: with baseline input the same keeper does write or delete the words object.
    await keepEvidence(deps, { orgId: ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0")], baseline: w.baseline([sha(1)]) });
    expect(touched.some((entry) => entry.includes(".baseline.json"))).toBe(true);
  });

  it("is deleted with the task's evidence (erase by task or workspace prefix), and the object expires with it", async () => {
    const w = await world(raw({ sha: sha(1), commitsBack: 3 }));
    await w.keep([sha(1)]);
    expect(await kept(w)).toBeDefined();
    expect(await eraseTaskEvidence(w.blobs, TASK)).toBe(true);
    expect(await kept(w)).toBeUndefined();
    expect(await loadEvidencePack(w.blobs, TASK, DIGEST)).toBeUndefined();
  });

  it("a damaged or look-alike stored object reads as no baseline", async () => {
    const w = await world(raw());
    const put = (value: unknown) => w.blobs.put(evidenceBaselineKey(TASK, DIGEST), Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    const good: EvidenceBaseline = { schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 1, ageHours: 1, knownFailing: 1, flaky: 0 };
    await put("{not json");
    expect(await kept(w)).toBeUndefined();
    for (const bad of [{ ...good, commitsBack: 80 }, { ...good, writer: "task" }, { ...good, extra: 1 }, { ...good, knownFailing: -1 }]) { await put(bad); expect(await kept(w)).toBeUndefined(); }
    await put(good);
    expect(EvidenceBaselineSchema.safeParse(await kept(w)).success).toBe(true);
  });
});

describe("the pull request line", () => {
  const pack = async (): Promise<EvidencePack> => {
    const w = await world(raw());
    await w.keep(undefined);
    return (await loadEvidencePack(w.blobs, TASK, DIGEST))!;
  };
  const words: EvidenceBaseline = { schemaVersion: 1, sha: sha(1), branch: "main", writer: "nightly", commitsBack: 0, ageHours: 2, knownFailing: 3, flaky: 2 };

  it("says which run the task was compared with, after the not-run line, at every shrink level, only for a pack bound to this code", async () => {
    const bound = await pack();
    const line = "Compared with main at 0000000 (nightly, 2 h old): 3 known failing, 2 flaky";
    for (const level of [0, 1, 2, 3, 4]) {
      const lines = evidenceLines({ pack: bound, mode: "summary", baseline: words }, DIGEST, level).lines;
      expect(lines).toContain(line);
      expect(lines.at(-1)).toBe("Full evidence is in Rovara (sign-in needed).");
    }
    expect(evidenceLines({ pack: bound, mode: "summary", baseline: words }, "e".repeat(64), 0)).toEqual({ lines: [], notTested: [] });
    // Without words (gate off, no claim, old engine) the lines are exactly what they were.
    const plain = evidenceLines({ pack: bound, mode: "summary" }, DIGEST, 0).lines;
    expect(plain).not.toContain(line);
    expect(plain.filter((value) => value.startsWith("Compared with"))).toEqual([]);
    expect(evidenceLines({ pack: bound, mode: "summary", baseline: words }, DIGEST, 0).lines.filter((value) => value !== line)).toEqual(plain);
  });

  it("a hostile branch name is inert in the line, whatever the stored words say", async () => {
    const bound = await pack();
    const hostile = evidenceLines({ pack: bound, mode: "summary", baseline: { ...words, branch: "[x](https://evil.example) @owner #12 ENG-42 <b>" } }, DIGEST, 0).lines.find((value) => value.startsWith("Compared with"))!;
    expect(hostile).not.toMatch(/\]\(|<b>|(?<!‍)@owner|#12\b/u);
    expect(hostile.split("\n")).toHaveLength(1);
  });
});

