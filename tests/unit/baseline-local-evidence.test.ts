// TE-C1: the laptop's wiring of the keeper. The candidates come from the plan the broker stored with THIS operation (never from the worker), only while the switch is on; the words are read back for exactly this code.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BaselineRowSchema, projectRevisionKey, type CheckEntry } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createLocalEvidence } from "../../packages/broker/src/local/app/evidence.js";
import { mintTrustedBaselineRun, recordBaselineRow } from "../../packages/broker/src/core/test-env/baseline-cache.js";

const ORG = `org_${"a".repeat(20)}`;
const PROJECT = "payments";
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DIGEST = "c".repeat(64);
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1", project: PROJECT };
const entry: CheckEntry = { id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 };
const planOf = (candidates?: string[]) => ({ revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], ...(candidates === undefined ? {} : { baselineCandidates: candidates.map((value) => ({ sha: value })) }) });

async function world(env: NodeJS.ProcessEnv | undefined, claim: unknown) {
  const store = new MemoryDocumentStore();
  const blobs = createDocumentObjectStorage(store, { companyId: ORG, now: () => NOW });
  const text = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], ...(claim === undefined ? {} : { baseline: claim }) });
  const rawKey = "private/owner-1/ws-1/op-1/evidence-raw.json";
  await blobs.put(rawKey, Buffer.from(text), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
  await store.put({ item: { pk: "WORKSPACE#ws-1", sk: "ARTIFACT#op-1#evidence-raw.json", name: "evidence-raw.json", objectKey: rawKey, sha256: createHash("sha256").update(text).digest("hex") } });
  await store.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: [{ name: "r", url: "https://example.invalid/r.git", path: "r", defaultBranch: "main", credentialRef: "c" }] } } });
  const testEnv = { store, now: () => NOW, ...(env === undefined ? {} : { env }) };
  await recordBaselineRow(testEnv, mintTrustedBaselineRun({ orgId: ORG, project: PROJECT, row: BaselineRowSchema.parse({
    recordedAt: new Date(NOW - 3_600_000).toISOString(), envRevision: 1, branch: "main", headSha: sha(1), finishedAt: new Date(NOW - 3 * 3_600_000).toISOString(), writer: "nightly", tests: { total: 5, passed: 4, failed: 1, skipped: 0 }, failed: ["a::x"], flaky: [] }) }));
  const evidence = createLocalEvidence({ flow: { store, companyId: ORG, log: () => undefined }, blobs, testEnv: env === undefined ? undefined : testEnv });
  const keep = (plan: unknown) => evidence.keepAfterChecks({ task: TASK as never, operation: { id: "op-1", dispatch: { kind: "task", projectRevision: 1, payload: { testEnvironment: plan } } } as never, workflow: {} as never, candidateDigest: DIGEST, checks: [entry] });
  return { evidence, keep };
}

describe("the laptop keeps the baseline words for a plan that offered candidates", () => {
  it("with the switch on, for a sha the stored plan offered", async () => {
    const w = await world({ ROVARA_BASELINE_CACHE: "1" }, { sha: sha(1), commitsBack: 2 });
    expect(await w.keep(planOf([sha(1)]))).toMatchObject({ kept: true });
    expect(await w.evidence.baselineOf(TASK, DIGEST)).toMatchObject({ sha: sha(1), commitsBack: 2, knownFailing: 1, flaky: 0, ageHours: 3 });
    expect(await w.evidence.baselineOf(TASK, "e".repeat(64))).toBeUndefined();
  });

  it("not with the switch off, no testEnv wiring, a plan that offered other shas, or none, or a stored plan that does not read", async () => {
    for (const [env, plan] of [[{}, planOf([sha(1)])], [undefined, planOf([sha(1)])], [{ ROVARA_BASELINE_CACHE: "1" }, planOf([sha(2)])], [{ ROVARA_BASELINE_CACHE: "1" }, planOf()], [{ ROVARA_BASELINE_CACHE: "1" }, { nonsense: true }], [{ ROVARA_BASELINE_CACHE: "1" }, undefined]] as const) {
      const w = await world(env, { sha: sha(1), commitsBack: 2 });
      expect(await w.keep(plan)).toMatchObject({ kept: true });
      expect(await w.evidence.baselineOf(TASK, DIGEST)).toBeUndefined();
    }
  });
});
