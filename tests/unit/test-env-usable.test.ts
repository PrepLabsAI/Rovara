// The test environment in the task flow's broker half: which approved environment a task may use (the production list, recordings, sandbox only), how a task pins the revision it started with, the plan a
// verification run is sent, the checks a task is held to, and what the evidence says about the environment. (The task flow's own start and the plan seam are in test-env-task-flow.test.ts.)
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, projectPk, type StoredDocument, type TransactItem, type OrgId, type TestEnvironment, type TestEnvironmentBody, type ProjectCommand } from "@agentx/contracts";
import { testEnvPlanFor } from "../../packages/broker/src/core/test-env/task-plan.js";
import { testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { UNUSED_WORDS, environmentUnusedReason, readTestEnvPin, testEnvPinItem, testEnvironmentForStart, usableTestEnvironment } from "../../packages/broker/src/core/test-env/usable.js";
import { taskWorkflowCheckPolicy } from "../../packages/broker/src/core/task-flow/check-policy.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

/** The row a task start would write for its pin. */
const putItem = (pin: TransactItem | undefined): StoredDocument => (pin as Extract<TransactItem, { kind: "put" }>).item;
const ORG: OrgId = BENCH_ORG;
const PROJECT = "service";
const ON = { ROVARA_TEST_ENVIRONMENT: "1" };
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [
    { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test", selectArgs: ["{tests}"] },
    { id: "lint", label: "Lint", command: cmd("ruff", ["check"]), kind: "lint" },
  ] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
const asEnvironment = (environment: TestEnvironmentBody, revision = 1): TestEnvironment => ({ revision, approvedAt: "2026-11-02T10:00:00.000Z", environment });

/** The bench with test services off, and `approve` as the next revision of the project (the Prove run is recorded directly: the store is under test here, not the setup check). */
async function harness() {
  const h = await bench({ project: PROJECT, env: ON, startMs: Date.UTC(2026, 10, 2, 10, 0, 0) });
  let current = 0;
  const approve = async (environment: TestEnvironmentBody) => {
    const proposed = await h.proposeAndProve(environment);
    const result = await h.approve(proposed.digest, current);
    if (result.status !== "decided") throw new Error(`not approved: ${JSON.stringify(result)}`);
    current += 1;
    return result;
  };
  /** Writes the pin a task start would have stored. */
  const pin = async (taskId: string, env: NodeJS.ProcessEnv = ON) => {
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId }, env);
    if (start.pin !== undefined) await h.store.put({ item: putItem(start.pin) });
    return start;
  };
  const revisionRow = async (revision = 1) => (await h.store.get(testEnvRevisionKey(ORG, PROJECT, revision)))!;
  return { ...h, approve, pin, revisionRow };
}

describe("which approved environment a task may use", () => {

  it("an environment that points at production is not used, whatever approved it", () => {
    // The approval refuses these; the task flow reads again, so one approved by an earlier build or a path with fewer checks is still not used.
    const preprod = body({
      services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/scorer", roleArn: "arn:aws:iam::222222222222:role/invoke", region: "us-west-2" } }],
      prodDeny: { accountIds: ["999988887777"], hosts: [], arnPrefixes: [] },
    });
    // The same environment, with a deny list that names its account, as the store holds it when approved by a path that did not refuse it.
    const named = { ...preprod, prodDeny: { accountIds: ["222222222222"], hosts: [], arnPrefixes: [] } } as TestEnvironmentBody;
    expect(environmentUnusedReason(asEnvironment(named))).toBe("names_production");
    // And one that reaches a remote with no list at all.
    expect(environmentUnusedReason(asEnvironment({ ...preprod, prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } }))).toBe("names_production");
  });

  it("recordings are not allowed in the shared tier, whatever the accounts", () => {
    const shared = { ...body(), tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" }, capture: { screenshots: "failed", video: true, traces: false }, accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }], prodDeny: { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] } } as TestEnvironmentBody;
    expect(environmentUnusedReason(asEnvironment(shared))).toBe("recording_not_allowed");
    expect(environmentUnusedReason(asEnvironment({ ...shared, capture: { screenshots: "failed", video: false, traces: true } }))).toBe("recording_not_allowed");
    // Without a recording the shared tier is simply not carried out by tasks yet.
    expect(environmentUnusedReason(asEnvironment({ ...shared, capture: { screenshots: "failed", video: false, traces: false } }))).toBe("tier_not_connected");
  });

  it("services, accounts and the preview or shared tiers are not carried out by tasks yet, so the environment is not applied", () => {
    const withService = body({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }] });
    expect(environmentUnusedReason(asEnvironment(withService))).toBe("services_not_connected");
    // A long-lived (registered) account is a credential that outlives the round: never carried by a task.
    expect(environmentUnusedReason(asEnvironment(body({ accounts: [{ profileId: "buyer", provisioner: "registered", registryProfileId: "buyer" }] })))).toBe("accounts_not_connected");
    expect(environmentUnusedReason(asEnvironment(body({ accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }] })))).toBe("accounts_not_connected");
    const preview = body({ tier: "preview", preview: { provider: "cdk", stackTemplate: "infra/stack.ts", deployRoleArn: "arn:aws:iam::222222222222:role/deploy", ttlHours: 4, costCapUsdPerDay: 10, fallbackTier: "sandbox" }, prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] } });
    expect(environmentUnusedReason(asEnvironment(preview))).toBe("tier_not_connected");
    for (const reason of ["services_not_connected", "accounts_not_connected", "tier_not_connected", "names_production", "recording_not_allowed"] as const) expect(UNUSED_WORDS[reason]).not.toMatch(/\d/u);
  });

  it("with the switch off nothing is read, and it is never an environment", async () => {
    const h = await harness();
    await h.approve(body());
    const reads = vi.fn();
    const counted = { ...h.deps, store: new Proxy(h.store, { get: (target, name, receiver) => { const value: unknown = Reflect.get(target, name, receiver); return typeof value === "function" ? (...args: unknown[]) => { reads(name); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value; } }) };
    // Only exactly "0" turns the environment off: nothing is read and it is never an environment.
    for (const env of [{ ROVARA_TEST_ENVIRONMENT: "0" }]) {
      expect(await usableTestEnvironment(counted, ORG, PROJECT, undefined, env)).toEqual({ ok: false, reason: "none" });
      expect(await testEnvironmentForStart(counted, { orgId: ORG, project: PROJECT, taskId: "t1" }, env)).toEqual({});
      expect(await testEnvPlanFor(counted, { orgId: ORG, project: PROJECT, taskId: "t1", readiness: [cmd("pytest", ["-q"])] }, env)).toBeUndefined();
    }
    expect(reads).not.toHaveBeenCalled();
  });

});

describe("recordings in the approval", () => {
  const shared = (capture: { video: boolean; traces: boolean }) => body({
    tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" },
    accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }], prodDeny: { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] },
    capture: { screenshots: "failed", ...capture },
  });
  it("a video or a trace in the shared tier is refused when proposed, and never approvable", async () => {
    const h = await harness();
    for (const capture of [{ video: true, traces: false }, { video: false, traces: true }]) {
      await expect(h.propose(shared(capture))).rejects.toThrow(/video and traces are kept only in the sandbox/);
    }
    // The same environment without a recording is a proposal like any other (a less-safe one: a second person on the confirmation page).
    await expect(h.propose(shared({ video: false, traces: false }))).resolves.toMatchObject({ risk: "high" });
  });
});

describe("the task's pin", () => {

  it("a pin is another task's, another org's or damaged: none", async () => {
    const h = await harness();
    await h.approve(body());
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t3" }, ON);
    const item = putItem(start.pin);
    await h.store.put({ item: item });
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "other")).toBeUndefined();
    expect(await readTestEnvPin(h.deps, "org_bbbbbbbbbbbbbbbbbbbb", PROJECT, "t3")).toBeUndefined();
    await h.store.put({ item: { ...item, revision: "1" } });
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t3")).toBeUndefined();
    await h.store.put({ item: { ...item, unused: "something_else" } });
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t3")).toBeUndefined();
    expect(testEnvPinItem({ orgId: ORG, project: PROJECT, taskId: "x", nowMs: 0 })).toBeUndefined();
  });
});

describe("the checks a task is held to", () => {
  const project = { readiness: [cmd("make", ["old-test"]), cmd("pytest", ["-q"])] } as never;

  it("are the environment's checks first, with their kinds, then any readiness command the environment does not run", () => {
    const policy = taskWorkflowCheckPolicy(project, body());
    expect(policy.required.map((check) => [check.id, check.command.executable, check.kind])).toEqual([["required-1", "pytest", "test"], ["required-2", "ruff", "lint"], ["required-3", "make", undefined]]);
    expect(policy.required[0]!.label).toBe("Unit tests");
  });
});

describe("the plan a verification run is sent", () => {
  async function pinned(environment: TestEnvironmentBody = body()) {
    const h = await harness();
    await h.approve(environment);
    await h.pin("t1");
    return h;
  }
  const readiness = [cmd("pytest", ["-q"]), cmd("ruff", ["check"]), cmd("make", ["old-test"])];
  const planOf = (h: Awaited<ReturnType<typeof pinned>>, ready = readiness, env: NodeJS.ProcessEnv = ON) => testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness: ready }, env);

  it("carries the approved coveragePath of a check (S-2), and nothing for a check that has none", async () => {
    const withPath = body({ repos: [{ repositoryId: "service", setupCommands: [], checks: [
      { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test", selectArgs: ["{tests}"], coveragePath: "reports/coverage.xml" },
      { id: "lint", label: "Lint", command: cmd("ruff", ["check"]), kind: "lint" },
    ] }] });
    const h = await pinned(withPath);
    const plan = (await planOf(h))!;
    expect(plan.checks).toEqual([{ id: "unit", kind: "test", coveragePath: "reports/coverage.xml", selectArgs: ["{tests}"] }, { id: "lint", kind: "lint" }]);
  });

  it("carries the tests that failed in the last nightly, when there is a baseline", async () => {
    const h = await pinned();
    await h.store.put({ item: { pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: ORG, project: PROJECT, baseline: {
      recordedAt: "2026-11-02T06:00:00.000Z", envRevision: 1, branch: "main", headSha: "a".repeat(40), finishedAt: "2026-11-02T06:00:00.000Z", tests: { total: 10, passed: 9, failed: 1, skipped: 0 }, failed: ["tests/test_a.py::test_x"], flaky: [],
    } } });
    expect((await planOf(h))!.lastNightlyFailures).toEqual(["tests/test_a.py::test_x"]);
  });

  it("re-checks the narrowing rule at dispatch: an approved environment with `{tests}` on a command that is not a test runner, or that passes with no tests, gets no plan", async () => {
    for (const unsafe of [cmd("make", ["old-test"]), cmd("pnpm", ["run", "jest"]), cmd("jest", ["--passWithNoTests"])]) {
      const h = await harness();
      await h.approve(body({ repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: unsafe, kind: "test", selectArgs: ["{tests}"] }] }], selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] } }));
      const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
      await h.store.put({ item: putItem(start.pin) });
      expect(await planOf(h, [unsafe]), JSON.stringify(unsafe.args)).toBeUndefined();
    }
  });

  it("is not built when the pinned revision can no longer be used (it names production now)", async () => {
    const h = await pinned();
    const stored = await h.revisionRow();
    // The store holds a revision whose digest and contents agree, but whose deny list now names a remote it reaches.
    const hostile = { ...body(), services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/scorer", roleArn: "arn:aws:iam::222222222222:role/invoke", region: "us-west-2" } }], prodDeny: { accountIds: ["222222222222"], hosts: [], arnPrefixes: [] } };
    await h.store.put({ item: { ...stored, environment: JSON.parse(JSON.stringify(hostile)), digest: "x" } });
    expect(await planOf(h)).toBeUndefined();
  });
});


