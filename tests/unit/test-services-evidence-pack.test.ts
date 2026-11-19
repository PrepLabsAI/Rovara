// Test services: the evidence of a round with dependencies. The pack's dependency rows and labels are the BROKER's (from what it pinned); the worker's usage record only says whether a dependency really
// ran. The pull request says what each was backed by, unknown calls are counted as registrable domain + count, and a pack without dependencies is what it was.
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, testEnvDigest, EvidenceRawSchema, TestEnvironmentBodySchema, type CheckEntry, type EvidenceEnvironment, type OrgId, type EvidenceRaw } from "@agentx/contracts";
import { BLOCKED_CALLS_ITEM_ID, NO_USAGE_RECORD_ITEM, dependencyEvidenceOf } from "../../packages/broker/src/core/proof/dependency-evidence.js";
import { buildEvidencePack } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { keepEvidence, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { evidenceLines } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import type { TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/core/test-env/evidence-line.js";
import { testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { scanTextForTests } from "../support/evidence-scan.js";
import { projectStore } from "../support/test-env-world.js";

const DIGEST = "c".repeat(64);
const ENV: EvidenceEnvironment = { tier: "sandbox", envRevision: 4, services: [], data: "synthetic", accounts: [] };
const CHECKS: CheckEntry[] = [{ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 7, exitCode: 0 }];
const PINNED = [{ id: "postgres", name: "Postgres", backing: "local" as const }];
const usage = (over: Partial<NonNullable<EvidenceRaw["testServices"]>> = {}): NonNullable<EvidenceRaw["testServices"]> => ({
  schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 840, resetCount: 1 }], unknownCalls: { domains: [], otherCount: 0 }, ...over,
});
const rawOf = (testServices?: unknown) => JSON.stringify({
  schemaVersion: 1, candidateDigest: DIGEST,
  checks: [{ checkId: "readiness:0", tests: { total: 2, passed: 2, failed: 0, skipped: 0, errored: 0, names: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }], newTests: [] } }],
  selection: { method: "full", selected: 2, total: 2 }, ...(testServices === undefined ? {} : { testServices }),
});
const build = (rawText: string | undefined, dependencies: typeof PINNED | "none" = PINNED) => buildEvidencePack({ candidateDigest: DIGEST, rawText, checks: CHECKS, environment: ENV, storedArtifacts: new Map(), ...(dependencies === "none" ? {} : { dependencies }) });

describe("the dependency rows", () => {
  it("shows a dependency that started healthy as real, with its start time, and the label is the broker's", () => {
    const { dependencies, notTested } = dependencyEvidenceOf(PINNED, usage());
    expect(dependencies).toEqual([{ name: "Postgres", backing: "local", label: "real", startedMs: 840 }]);
    expect(notTested).toEqual([]);
  });

  it("never shows one the record does not show started and healthy as running: not available, did not start", () => {
    for (const record of [
      usage({ dependencies: [{ id: "postgres", started: true, healthy: false, startMs: 30_000, resetCount: 0, failure: "not_healthy" }] }),
      usage({ dependencies: [{ id: "postgres", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "pull_failed" }] }),
      usage({ dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 5, resetCount: 0, failure: "seed_failed" }] }),
      usage({ dependencies: [] }),
    ]) {
      expect(dependencyEvidenceOf(PINNED, record).dependencies).toEqual([{ name: "Postgres", backing: "none", label: "not_available", fellBack: { from: "local", reason: "did_not_start" } }]);
    }
  });

  it("without a record claims nothing and says so", () => {
    const result = dependencyEvidenceOf(PINNED, undefined);
    expect(result.dependencies[0]).toMatchObject({ label: "not_available" });
    expect(result.notTested).toEqual([NO_USAGE_RECORD_ITEM]);
  });

  it("counts unknown calls as registrable domain and count, and nothing else", () => {
    const { notTested } = dependencyEvidenceOf(PINNED, usage({ unknownCalls: { domains: [{ domain: "example-pay.com", count: 3 }, { domain: "api.other.test", count: 1 }], otherCount: 2 } }));
    expect(notTested).toEqual([{ kind: "environment", id: BLOCKED_CALLS_ITEM_ID, text: "Blocked by environment: 6 calls to names no dependency answers: example-pay.com (3), api.other.test (1) and 2 more", reason: "blocked by environment" }]);
    const hidden = dependencyEvidenceOf(PINNED, usage({ unknownCalls: { domains: [], otherCount: 1 } })).notTested[0]!;
    expect(hidden.text).toBe("Blocked by environment: 1 call to names no dependency answers");
  });

  it("tells two dependencies with the same words apart by their ids", () => {
    const { dependencies } = dependencyEvidenceOf([{ id: "pg-a", name: "Postgres", backing: "local" }, { id: "pg-b", name: "Postgres", backing: "local" }], usage({ dependencies: [{ id: "pg-a", started: true, healthy: true, startMs: 1, resetCount: 0 }, { id: "pg-b", started: true, healthy: true, startMs: 2, resetCount: 0 }] }));
    expect(new Set(dependencies.map((entry) => entry.name)).size).toBe(2);
  });
});

describe("the pack", () => {
  it("holds the dependency rows from the pinned list and the raw file's usage record", () => {
    const built = build(rawOf(usage({ unknownCalls: { domains: [{ domain: "example-pay.com", count: 3 }], otherCount: 0 } })));
    expect(built.pack?.environment.dependencies).toEqual([{ name: "Postgres", backing: "local", label: "real", startedMs: 840 }]);
    expect(built.pack?.notTested.find((item) => item.id === BLOCKED_CALLS_ITEM_ID)?.text).toContain("example-pay.com (3)");
    expect(EvidencePackSchema.safeParse(built.pack).success).toBe(true);
  });

  it("does not believe a worker that claims a label: the raw file has no place for one", () => {
    expect(EvidenceRawSchema.safeParse(JSON.parse(rawOf({ ...usage(), dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 1, resetCount: 0, label: "real" }] }))).success).toBe(false);
  });

  it("a raw file with no record, or no raw file, shows the dependency as not available", () => {
    expect(build(rawOf()).pack?.environment.dependencies?.[0]).toMatchObject({ label: "not_available" });
    expect(build(rawOf()).pack?.notTested.some((item) => item.id === NO_USAGE_RECORD_ITEM.id)).toBe(true);
    expect(build(undefined).pack?.environment.dependencies?.[0]).toMatchObject({ label: "not_available" });
  });

  it("is today's pack for a run with no dependencies, record or not (golden)", () => {
    const without = build(rawOf(), "none");
    expect("dependencies" in without.pack!.environment).toBe(false);
    expect(build(rawOf(), []).pack).toEqual(without.pack);
    // A usage record in the raw file of a run that pinned nothing adds nothing.
    expect(build(rawOf(usage()), "none").pack).toEqual(without.pack);
    expect(without.pack?.notTested.some((item) => item.id === NO_USAGE_RECORD_ITEM.id || item.id === BLOCKED_CALLS_ITEM_ID)).toBe(false);
  });
});

describe("the pull request lines", () => {
  const context = (pack: ReturnType<typeof build>["pack"]) => ({ pack, mode: "summary" as const });
  it("say what each dependency was backed by, in the honesty label's words", () => {
    const pack = build(rawOf(usage())).pack!;
    const { lines, notTested } = evidenceLines(context(pack), DIGEST, 0);
    expect(lines).toContain("Integration tests ran against: Postgres (real).");
    expect(notTested).toEqual([]);
  });

  it("list a dependency that did not start as not run, and the blocked calls as not tested", () => {
    const pack = build(rawOf(usage({ dependencies: [{ id: "postgres", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "start_failed" }], unknownCalls: { domains: [{ domain: "example-pay.com", count: 2 }], otherCount: 0 } }))).pack!;
    const { lines, notTested } = evidenceLines(context(pack), DIGEST, 0);
    expect(lines.join("\n")).not.toContain("ran against");
    expect(notTested.join("\n")).toContain("Postgres: not available (fallback: did not start)");
    expect(notTested.join("\n")).toContain("Blocked by environment: 2 calls");
  });

  it("are today's lines for a pack without dependencies (golden)", () => {
    const pack = build(rawOf(), "none").pack!;
    const lines = evidenceLines(context(pack), DIGEST, 0);
    expect(lines.lines.join("\n")).not.toMatch(/ran against/u);
    expect(lines.lines.some((line) => line.startsWith("Environment:"))).toBe(true);
  });

  it("hold at every shrink level", () => {
    const pack = build(rawOf(usage())).pack!;
    for (let level = 0; level <= 4; level += 1) expect(evidenceLines(context(pack), DIGEST, level).lines.join("\n")).toMatch(/Ran against:|Integration tests ran against:/u);
  });
});

describe("the pack kept for a task that pinned dependencies", () => {
  const OP = "op-1";
  const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "t1" };
  const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
  const depsFor = (raw: string): KeepEvidenceDeps => {
    const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
    return {
      scan: scanTextForTests,
      actions: {
        async artifacts() { return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; },
        async readArtifact(key, max) {
          if (key.startsWith(PREFIX)) return raw.slice(0, max);
          const stored = await blobs.get(key, max);
          return stored === undefined ? "" : Buffer.from(stored).toString("utf8");
        },
      },
      store: { blobs }, markStored: async () => undefined,
    };
  };

  it("keeps the dependency rows through keepEvidence and reads them back", async () => {
    const deps = depsFor(rawOf(usage()));
    expect(await keepEvidence(deps, { orgId: "org_00000000000000000000", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: CHECKS, environment: ENV, dependencies: PINNED })).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(deps.store.blobs, TASK, DIGEST);
    expect(pack?.environment.dependencies).toEqual([{ name: "Postgres", backing: "local", label: "real", startedMs: 840 }]);
  });
});

describe("the evidence's environment with dependencies", () => {
  const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
  const PROJECT = "service";
  const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
  const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
  const body = TestEnvironmentBodySchema.parse({
    tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
    selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
    prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
    dependencies: [{ id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} }, connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round" }],
  });

  it("lists what the task pinned, from the approved backing", async () => {
    const store = await projectStore(ORG, PROJECT);
    const deps: TestEnvDeps = { store, now: () => Date.UTC(2026, 10, 3, 10, 0, 0), env: ON };
    // The approved revision as the approval gate writes it (the gate itself is covered where the approval is).
    const digest = testEnvDigest(body);
    await store.put({ item: JSON.parse(JSON.stringify({ ...testEnvRevisionKey(ORG, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: ORG, project: PROJECT, revision: 1, approvedAt: "2026-11-03T10:00:00.000Z", approvedBy: "dev_a", digest, requestId: "r1", lessSafe: [], environment: body })) as never });
    await store.put({ item: { ...testEnvLatestKey(ORG, PROJECT), entityType: "TEST_ENV_LATEST", orgId: ORG, project: PROJECT, revision: 1, digest } });
    const start = await testEnvironmentForStart(deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    await store.transact([start.pin!]);
    const chosen = await evidenceEnvironmentOf(deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(chosen.dependencies).toEqual([{ id: "postgres", name: "Postgres", backing: "local" }]);
    expect(chosen.environment).toEqual({ tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] });
  });

  const fakeBody = TestEnvironmentBodySchema.parse({
    ...body,
    dependencies: [{ id: "payments", name: "Payments", kind: "http_api", family: "http:api.example-pay.com", found: ["model"], usedBy: ["integration"], backing: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail", provenance: { origin: "rovara_task", mockSet: { setId: "payments-mocks", version: 1, store: "rovara" } } }, connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round" }],
  });

  it("pins a fake Rovara made as made by Rovara, from the approved backing's provenance (review M3)", async () => {
    const store = await projectStore(ORG, PROJECT);
    const deps: TestEnvDeps = { store, now: () => Date.UTC(2026, 10, 3, 10, 0, 0), env: ON };
    // The approved revision as the approval gate writes it (the gate itself is covered where the approval is).
    const digest = testEnvDigest(fakeBody);
    await store.put({ item: JSON.parse(JSON.stringify({ ...testEnvRevisionKey(ORG, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: ORG, project: PROJECT, revision: 1, approvedAt: "2026-11-03T10:00:00.000Z", approvedBy: "dev_a", digest, requestId: "r1", lessSafe: [], environment: fakeBody })) as never });
    await store.put({ item: { ...testEnvLatestKey(ORG, PROJECT), entityType: "TEST_ENV_LATEST", orgId: ORG, project: PROJECT, revision: 1, digest } });
    const start = await testEnvironmentForStart(deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    await store.transact([start.pin!]);
    const chosen = await evidenceEnvironmentOf(deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(chosen.dependencies).toEqual([{ id: "payments", name: "Payments", backing: "fake", fake: { origin: "hand_written", madeByRovara: true } }]);
    expect(chosen.environment).toEqual({ tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] });
  });
});
