// Saved project images (SV wiring): the rebuild job on the wire. The payload field names what to build and holds no credential in its stored form; the worker lists the feature it needs.
import { describe, expect, it } from "vitest";
import { PrepareSavedEnvBuildSchema, SavedEnvFallbackBodySchema, SavedEnvLeaseBodySchema, SavedEnvResultBodySchema, savedEnvRepositoryName, testEnvDigest, TestEnvironmentBodySchema } from "../../packages/contracts/src/index.js";

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
