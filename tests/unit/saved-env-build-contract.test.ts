// Saved project images (SV wiring): the rebuild job on the wire. The payload field names what to build and holds no credential in its stored form; the worker lists the feature it needs.
import { describe, expect, it } from "vitest";
import { PREPARE_SAVED_ENV_BUILD_FEATURE, PrepareSavedEnvBuildSchema, SavedEnvFallbackBodySchema, SavedEnvLeaseBodySchema, SavedEnvResultBodySchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, savedEnvRepositoryName, testEnvDigest, TestEnvironmentBodySchema } from "../../packages/contracts/src/index.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

const cmd = { cwd: "svc", executable: "npm", args: ["ci"], timeoutSeconds: 60 };
const environment = TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [cmd], checks: [{ id: "unit", label: "Unit", command: { ...cmd, args: ["test"] }, kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 },
  accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const build = (over: Record<string, unknown> = {}) => ({
  jobId: "job-1", reason: "no_image", approved: { revision: 1, digest: testEnvDigest(environment) }, repository: savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "p" }), environment,
  commits: { svc: "d".repeat(40) }, expectedKey: "c".repeat(64), baseImageDigest: `sha256:${"b".repeat(64)}`, ...over,
});

describe("the prepare payload's savedEnvBuild", () => {
  it("takes the job without a lease token (the stored form), and with one (the delivered form), defaulting the lists", () => {
    const stored = PrepareSavedEnvBuildSchema.parse(build());
    expect(stored.leaseToken).toBeUndefined();
    expect(stored.detectorGlobs).toEqual([]);
    expect(stored.secretNames).toEqual([]);
    expect(PrepareSavedEnvBuildSchema.parse(build({ leaseToken: "L".repeat(40) })).leaseToken).toBe("L".repeat(40));
  });

  it("refuses what the worker could not build: a repository that is not a saved image repository, a commit that is not a sha, an empty or oversized job, a secret that is not a name, an unknown field", () => {
    for (const bad of [{ repository: "rovara-env/other" }, { commits: { svc: "main" } }, { commits: {} }, { commits: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`r${String(index)}`, "d".repeat(40)])) }, { secretNames: ["has space"] }, { baseImageDigest: "latest" }, { expectedKey: "short" }, { expectedKey: undefined }, { reason: "whenever" }, { leaseToken: "short" }, { extra: 1 }]) {
      expect(PrepareSavedEnvBuildSchema.safeParse(build(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rides in a prepare invocation, and the worker lists the feature the broker needs", () => {
    const invocation = {
      protocolVersion: 1, kind: "prepare", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(40),
      payload: { project: { name: "demo", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "r" }], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "g", readOnly: true, savedEnvBuild: build() },
    };
    expect(WorkerInvocationSchema.safeParse(invocation).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...invocation, payload: { ...invocation.payload, savedEnvBuild: build({ extra: 1 }) } }).success).toBe(false);
    expect(PREPARE_SAVED_ENV_BUILD_FEATURE).toBe("prepare.savedEnvBuild.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(PREPARE_SAVED_ENV_BUILD_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(PREPARE_SAVED_ENV_BUILD_FEATURE);
  });
});

describe("the route bodies", () => {
  it("the login names the job and its lease and nothing else; the result adds the result; the fallback names the step only", () => {
    expect(SavedEnvLeaseBodySchema.safeParse({ jobId: "j", leaseToken: "L".repeat(40) }).success).toBe(true);
    expect(SavedEnvLeaseBodySchema.safeParse({ jobId: "j", leaseToken: "L".repeat(40), repository: "x" }).success).toBe(false);
    expect(SavedEnvResultBodySchema.safeParse({ jobId: "j", leaseToken: "L".repeat(40), result: { ok: false } }).success).toBe(true);
    expect(SavedEnvFallbackBodySchema.safeParse({ step: "pull" }).success).toBe(true);
    expect(SavedEnvFallbackBodySchema.safeParse({ step: "pull", digest: "x" }).success).toBe(false);
  });
});
