// The saved environments on a real task-flow harness: the memory store the flow uses, an approved test environment written the way an approval writes it, the fake image registry and the key's code host.
import { createHash } from "node:crypto";
import { TestEnvProveReportSchema, TestEnvironmentBodySchema, testEnvDigest, type ProjectCommand, type TestEnvironmentBody } from "@rovara-code/contracts";
import { createAdapterRegistry, createFakeImageRegistry, type FakeImageRegistry } from "../../packages/core/src/ports/index.js";
import type { BuildSystem } from "@rovara-code/contracts";
import { documentOf, type TestEnvDeps } from "../../packages/core/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvProveKey, testEnvRevisionKey } from "../../packages/core/src/core/test-env/environment.js";
import { createSavedEnvDeps } from "../../packages/core/src/core/test-env/saved-env-real.js";
import type { TreeEntryListing, KeyHost } from "../../packages/core/src/core/test-env/saved-env-key.js";
import { COMPANY, createHarness, type Harness, type HarnessOptions } from "./task-flow-harness.js";

export { COMPANY };
export const PROJECT = "payments";
export const HEAD = "1".repeat(40);
export const BASE_IMAGE = `sha256:${"b".repeat(64)}`;

const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "demo", executable, args, timeoutSeconds: 600 });
export const environmentBody = (over: Partial<TestEnvironmentBody> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: ["package-lock.json"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});

/** Writes an approved revision the way an approval does (the revision row and the pointer), by the same keys. */
export async function approve(deps: Pick<TestEnvDeps, "store">, body: TestEnvironmentBody, revision = 1, approvedBy = "local-owner"): Promise<{ revision: number; digest: string }> {
  const digest = testEnvDigest(body);
  await deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, revision), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy, digest, requestId: "r".repeat(12), lessSafe: [], environment: body }) });
  await deps.store.put({ item: { ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision, digest } });
  await deps.store.put({ item: documentOf({ ...testEnvProveKey(COMPANY, PROJECT, digest), entityType: "TEST_ENV_PROVE", orgId: COMPANY, project: PROJECT, digest, report: passingProve(digest), recordedAt: "2026-11-09T09:00:00.000Z" }) });
  return { revision, digest };
}

/** The Prove report of a passing run for this digest, as the worker would report it. */
export const passingProve = (digest: string) => TestEnvProveReportSchema.parse({ schemaVersion: 1, proposalDigest: digest, steps: [{ step: "smoke", status: "passed", durationMs: 5 }], services: [], finishedAt: "2026-11-09T09:00:00.000Z" });

export const treeOf = (files: Record<string, string>): { truncated: boolean; entries: TreeEntryListing[] } => ({
  truncated: false,
  entries: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", sha: createHash("sha1").update(content).digest("hex") })),
});

export interface SavedWorld {
  h: Harness;
  registry: FakeImageRegistry;
  files: Record<string, string>;
  heads: { value: string };
  keyHostCalls: { trees: number };
  deps: NonNullable<ReturnType<typeof createSavedEnvDeps>>;
  test: TestEnvDeps;
  adapters: ReturnType<typeof createAdapterRegistry>;
  base: { digest: string | undefined };
  owner: { value: string | undefined };
}

export function savedWorld(options: { harness?: HarnessOptions; env?: NodeJS.ProcessEnv; buildSystems?: BuildSystem[]; registry?: FakeImageRegistry; files?: Record<string, string> } = {}): SavedWorld {
  const h = createHarness(options.harness);
  const registry = options.registry ?? createFakeImageRegistry({ now: () => h.clock.now });
  const files: Record<string, string> = options.files ?? { "package-lock.json": "lock-v1", "README.md": "hi" };
  const heads = { value: HEAD };
  const keyHostCalls = { trees: 0 };
  const base = { digest: BASE_IMAGE as string | undefined };
  const owner = { value: "local-owner" as string | undefined };
  const adapters = createAdapterRegistry();
  for (const buildSystem of options.buildSystems ?? []) adapters.register("build-system", buildSystem.name, buildSystem);
  const test: TestEnvDeps = { store: h.store, now: () => h.clock.now };
  const keyHost: KeyHost = {
    async listTree() { keyHostCalls.trees += 1; return treeOf(files); },
    async readText(_repository, _commit, path) { return files[path]; },
  };
  const deps = createSavedEnvDeps({
    test, flow: h.deps, registry, adapters, keyHost: () => keyHost, headOf: async () => heads.value, baseImageDigest: async () => base.digest, envName: "local",
    env: { ROVARA_SAVED_ENVIRONMENTS: "1", ...options.env }, ownerFor: async () => owner.value, log: () => undefined,
  })!;
  return { h, registry, files, heads, keyHostCalls, deps, test, adapters, base, owner };
}

/** A text field of a stored row, or "" (a row is flat JSON: this is how a test reads one without a cast). */
export const textOf = (row: { [attribute: string]: unknown } | undefined, key: string): string => { const value = row?.[key]; return typeof value === "string" ? value : ""; };

/** The part of a stored operation these tests read. */
export interface StoredOperation {
  kind: string; status: string;
  dispatch: { kind: string; extraActions?: string[]; requires?: string[]; payload: { readOnly?: boolean; pins?: unknown; savedEnvBuild: { leaseToken?: unknown; detectorGlobs?: string[] } & Record<string, unknown> } };
}
