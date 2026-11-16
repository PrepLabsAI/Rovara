import { expect, it, vi } from "vitest";
import { WorkerInvocationSchema, TestEnvironmentBodySchema, testEnvDigest, TEST_ENV_PROVE_MEASURE_FEATURE } from "../../packages/contracts/src/index.js";
import { PrepareSetupProveSchema, SETUP_PROVE_RESULT_PATH } from "../../packages/contracts/src/setup-prove.js";
import { expectLinearScaling } from "../support/scaling.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

const environment = TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
  data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const job = { jobId: "job-1", proposalDigest: testEnvDigest(environment), environment, commits: { svc: "d".repeat(40) } };
function invocation() {
  return {
    protocolVersion: 1, kind: "prepare", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(40),
    payload: { project: { name: "demo", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "r" }], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "g", readOnly: true, pins: [{ repository: "svc", commit: "d".repeat(40) }], setupProve: job },
  };
}
it("accepts a stored job without lease and a delivery job with lease; stays unadvertised", () => {
  expect(PrepareSetupProveSchema.parse(job)).toEqual(job);
  expect(PrepareSetupProveSchema.parse({ ...job, leaseToken: "l".repeat(40) }).leaseToken).toBe("l".repeat(40));
  expect(SETUP_PROVE_RESULT_PATH).toBe("setup-prove-result");
  expect(WORKER_IMPLEMENTED_FEATURES).not.toContain(TEST_ENV_PROVE_MEASURE_FEATURE);
  expect(WorkerInvocationSchema.safeParse(invocation()).success).toBe(true);
});
it.each([{ machineChip: "x86_64" }, { measureMachine: true }, { extra: 1 }, { environment: null }, { commits: {} }, { jobId: "@owner" }, { leaseToken: "short" }, { proposalDigest: "bad" }])("strict job refuses unknown or malformed input %j", override => {
  expect(PrepareSetupProveSchema.safeParse({ ...job, ...override }).success).toBe(false);
});
it.each([{ readOnly: undefined }, { pins: undefined }, { pins: [{ repository: "svc", commit: "e".repeat(40) }] }, { pins: [{ repository: "other", commit: "d".repeat(40) }] }, { checkout: [] }, { savedEnvBuild: {} }, { testServices: { dependencies: [] } }])("requires only a read-only preparation pinned to the job %j", override => {
  const value = invocation();
  expect(WorkerInvocationSchema.safeParse({ ...value, payload: { ...value.payload, ...override } }).success).toBe(false);
});
it("absent setupProve retains the exact ordinary prepare parse", () => {
  const { kind, payload, ...base } = invocation();
  const ordinary = { ...base, kind, payload: { project: payload.project, repositoryGrant: payload.repositoryGrant } };
  expect(JSON.stringify(WorkerInvocationSchema.parse(ordinary))).toBe(JSON.stringify(ordinary));
});
it("one total job byte bound refuses huge and aggregate inputs without silently dropping fields", () => {
  // Scaling checks: a refusal must be needed only past 256 KiB, but the 8N input of a scaling check stays at or under 256 KiB so it stays in CPU cache, so the timed runs use the sizes below the bound
  // (the job is copied and measured the same way whatever the verdict; one huge string is refused here by its unknown key, the aggregate may be accepted). The refusals past the bound run once at full size, un-timed
  // (the largest sizes are 2.4 MB of one string, and 16 repositories of 20 commands with 8,000-character arguments).
  const hugeOf = (size: number) => ({ ...job, extra: "x".repeat(size) });
  const aggregateOf = (size: number) => {
    const repos = Array.from({ length: 16 }, (_, i) => ({ repositoryId: `r${i}`, setupCommands: Array.from({ length: 20 }, () => ({ cwd: "svc", executable: "echo", args: ["x".repeat(size)], timeoutSeconds: 60 })), checks: [] }));
    return { ...job, environment: { ...environment, repos } };
  };
  expectLinearScaling((size) => {
    const huge = hugeOf(size);
    return () => PrepareSetupProveSchema.safeParse(huge);
  }, { n: 32_000, label: "reading one huge string in a setup-prove job" });
  expectLinearScaling((size) => {
    const aggregate = aggregateOf(size);
    return () => PrepareSetupProveSchema.safeParse(aggregate);
  }, { n: 90, unitBytes: 320, label: "reading an aggregate of many commands in a setup-prove job" });
  expect([PrepareSetupProveSchema.safeParse(hugeOf(2_400_000)).success, PrepareSetupProveSchema.safeParse(aggregateOf(8_000)).success]).toEqual([false, false]);
});

it("unreadable JSON is refused without invoking accessors or toJSON", () => {
  const toJSON = vi.fn(() => ({}));
  const getter = { ...job, get extra() { throw new Error("private-cause"); }, toJSON };
  expect(() => PrepareSetupProveSchema.safeParse(getter)).not.toThrow();
  expect(PrepareSetupProveSchema.safeParse(getter).success).toBe(false);
  expect(toJSON).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(PrepareSetupProveSchema.safeParse(cycle).success).toBe(false);
});

it.each([
  { registries: [{ name: "packages", kind: "npm", format: "npm", url: "https://packages.example.test" }] },
  { meta: { repository: { name: "meta", url: "https://github.com/acme/meta.git", path: "meta", defaultBranch: "main", credentialRef: "r" }, paths: ["docs"], commit: "d".repeat(40) } },
])("setup Prove refuses otherwise valid preparation extras %j", extra => {
  const value = invocation();
  const ordinary = { ...value.payload, setupProve: undefined };
  expect(WorkerInvocationSchema.safeParse({ ...value, payload: { ...ordinary, ...extra } }).success).toBe(true);
  expect(WorkerInvocationSchema.safeParse({ ...value, payload: { ...value.payload, ...extra } }).success).toBe(false);
});
it("setup Prove explicitly refuses duplicate pins even when count and each commit match", () => {
  const value = invocation();
  const payload = { ...value.payload, setupProve: { ...job, commits: { svc: "d".repeat(40), other: "d".repeat(40) } }, pins: [value.payload.pins[0], value.payload.pins[0]] };
  expect(WorkerInvocationSchema.safeParse({ ...value, payload }).success).toBe(false);
});
