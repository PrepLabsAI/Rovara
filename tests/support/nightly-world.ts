// A world for the nightly tests: an in-memory store with a project whose test environment is approved (rows written the way an approval writes them), a clock, a head reader, a run starter and an admission that
// can refuse. Every port is a fake the test can steer.
import {
  CoverageMapSchema, TestEnvironmentBodySchema, projectMetaKey, projectPk, testEnvDigest,
  type CoverageMapData, type DueSchedule, type TestEnvironmentBody,
} from "@rovara-code/contracts";
import { documentOf } from "../../packages/core/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/core/src/core/test-env/environment.js";
import { coverageMapDigest, nightlySlotId, type MapStore, type NightlyDeps } from "../../packages/core/src/core/test-env/nightly.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";

export const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
export const PROJECT = "partner-service";
export const HEAD1 = "a".repeat(40);
export const HEAD2 = "b".repeat(40);
export const T0 = Date.UTC(2026, 10, 5, 6, 0, 5);
export const SCHEDULED = new Date(T0 - 5_000).toISOString();

const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
export const body = (nightly: Partial<TestEnvironmentBody["nightly"]> = {}, extra: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "svc", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main", ...nightly },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false },
  ...extra,
});

/** Writes an approved revision the way an approval does (the revision row and the pointer), without going through the gate: the nightly only reads what an approval left. */
export async function approveForTest(store: MemoryDocumentStore, environment: TestEnvironmentBody, revision = 1, project = PROJECT): Promise<void> {
  const digest = testEnvDigest(environment);
  await store.put({ item: documentOf({ ...testEnvRevisionKey(ORG, project, revision), entityType: "TEST_ENV_REVISION", orgId: ORG, project, revision, approvedAt: new Date(T0 - 86_400_000).toISOString(), approvedBy: "person_a", digest, requestId: `request-${String(revision)}`, lessSafe: [], environment }) });
  await store.put({ item: { ...testEnvLatestKey(ORG, project), entityType: "TEST_ENV_LATEST", orgId: ORG, project, revision, digest } });
}

export async function nightlyWorld(nightly: Partial<TestEnvironmentBody["nightly"]> = {}, extra: Record<string, unknown> = {}) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...projectMetaKey(ORG, PROJECT), status: "active" } });
  const clock = { now: T0 };
  const heads: { value: string | undefined; throws: boolean } = { value: HEAD1, throws: false };
  const started: Array<Record<string, unknown>> = [];
  const startFails = { value: false };
  const startSkips: { value: { skipped: "workspace_limit" | "owner_unavailable" | "budget" } | undefined } = { value: undefined };
  const admitted: Array<Record<string, unknown>> = [];
  const admitError: { value: Error | undefined } = { value: undefined };
  const deps: NightlyDeps = {
    store, now: () => clock.now,
    runs: {
      admit: (input) => { admitted.push(input); return admitError.value === undefined ? Promise.resolve() : Promise.reject(admitError.value); },
      headOf: () => (heads.throws ? Promise.reject(new Error("host down")) : Promise.resolve(heads.value)),
      startRun: (input) => { if (startFails.value) return Promise.reject(new Error("no capacity")); started.push(input); return Promise.resolve(startSkips.value); },
    },
  };
  await approveForTest(store, body(nightly, extra));
  const maps = new Map<string, unknown>();
  const mapStore: MapStore = { put: (_o, _p, map) => { const digest = coverageMapDigest(map); maps.set(digest, map); return Promise.resolve(digest); }, get: (_o, _p, digest) => Promise.resolve(maps.get(digest)) };
  const due = (scheduledAt = SCHEDULED, project = PROJECT): DueSchedule => ({ companyId: ORG, scheduleId: "night", scheduledAt, slotId: nightlySlotId(ORG, project, scheduledAt), attempt: 1, target: { kind: "nightly", ref: { project } } });
  return { store, deps, clock, heads, started, startFails, startSkips, admitted, admitError, maps, mapStore, due };
}

export const map = (builtAt = new Date(T0).toISOString()): CoverageMapData => CoverageMapSchema.parse({ builtAt, files: { "src/match.py": ["tests/test_a.py::t1"], "src/rank.py": ["tests/test_b.py::t2"] } });
export function result(slotId: string, over: Record<string, unknown> = {}) {
  const coverage = map();
  return {
    result: { schemaVersion: 1, slotId, envRevision: 1, branch: "main", headSha: HEAD1, startedAt: new Date(T0 - 40 * 60_000).toISOString(), finishedAt: new Date(T0).toISOString(), durationMs: 40 * 60_000,
      tests: { total: 10, passed: 7, failed: 2, skipped: 1 }, failed: ["tests/test_x.py::bad1", "tests/test_x.py::bad2"], flaky: ["tests/test_y.py::flaky1"], coverageMapRef: coverageMapDigest(coverage), slowest: [{ id: "tests/test_z.py::slow", durationMs: 9_000 }], ...over },
    coverageMap: coverage,
  };
}

export async function rows(store: MemoryDocumentStore, prefix: string): Promise<string[]> {
  const page = await store.query({ pk: projectPk(ORG, PROJECT), sk: { op: "beginsWith", prefix } });
  return page.items.map((item) => item.sk);
}
