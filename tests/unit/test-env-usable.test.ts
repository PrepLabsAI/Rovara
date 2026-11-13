// The test environment in the task flow's broker half: which approved environment a task may use (the production list, recordings, sandbox only), how a task pins the revision it started with, the plan a
// verification run is sent, the checks a task is held to, and what the evidence says about the environment. (The task flow's own start and the plan seam are in test-env-task-flow.test.ts.)
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, projectPk, testEnvDigest, type CheckEntry, type StoredDocument, type TransactItem, type OrgId, type TestEnvironment, type TestEnvironmentBody, type ProjectCommand } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/core/src/core/proof/evidence-blob-store.js";
import { keepEvidence, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/core/src/core/proof/evidence-keep.js";
import { evidenceEnvironmentOf } from "../../packages/core/src/core/test-env/evidence-line.js";
import { testEnvPlanFor } from "../../packages/core/src/core/test-env/task-plan.js";
import { testEnvRevisionKey } from "../../packages/core/src/core/test-env/environment.js";
import { UNUSED_WORDS, environmentUnusedReason, readTestEnvPin, testEnvPinItem, testEnvironmentForStart, usableTestEnvironment } from "../../packages/core/src/core/test-env/usable.js";
import { taskWorkflowCheckPolicy } from "../../packages/core/src/core/task-flow/check-policy.js";
import { MemoryQueueService } from "../../packages/core/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/core/src/core/task-flow/flow.js";
import { createTaskTestEnvironment } from "../../packages/core/src/core/test-env/seam.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { scanTextForTests } from "../support/evidence-scan.js";
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
  it("a plain sandbox is used", () => {
    expect(environmentUnusedReason(asEnvironment(body()))).toBeUndefined();
  });

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
      expect(await evidenceEnvironmentOf(counted, { orgId: ORG, project: PROJECT, taskId: "t1" }, env)).toEqual({});
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it("with the switch on the newest approved sandbox is used, and none approved is none", async () => {
    const h = await harness();
    expect(await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON)).toEqual({ ok: false, reason: "none" });
    await h.approve(body());
    const found = await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON);
    expect(found.ok && found.environment.revision).toBe(1);
  });

  it("an item that does not read back is unreadable, never used", async () => {
    const h = await harness();
    await h.approve(body());
    const item = await h.revisionRow();
    await h.store.put({ item: { ...item, environment: { tier: "sandbox" } } });
    expect(await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON)).toEqual({ ok: false, reason: "unreadable" });
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
  it("a task start pins the revision it uses, and a later approval does not change it", async () => {
    const h = await harness();
    await h.approve(body());
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(start.used?.revision).toBe(1);
    await h.store.put({ item: putItem(start.pin) });
    // A later revision that runs more (one more file that runs the whole suite): narrowing which tests run would be a less-safe change with a second person.
    await h.approve(body({ roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock", "Makefile"] } }));
    expect((await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON) as { environment: TestEnvironment }).environment.revision).toBe(2);
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t1")).toMatchObject({ revision: 1 });
  });

  it("an environment that exists but cannot be applied is pinned as not applied, with the reason", async () => {
    const h = await harness();
    await h.approve(body({ accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }] }));
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t2" }, ON);
    expect(start.used).toBeUndefined();
    await h.store.put({ item: putItem(start.pin) });
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t2")).toMatchObject({ revision: 1, unused: "accounts_not_connected" });
    // The evidence says which, in place of the plain "no approved environment".
    const chosen = await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t2" }, ON);
    expect(chosen.environment).toBeUndefined();
    expect(chosen.note?.text).toContain(UNUSED_WORDS.accounts_not_connected);
  });

  it("a pin for an environment that was not applied names the revision that was judged: the newest revision is read once", async () => {
    const h = await harness();
    await h.approve(body({ accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }] }));
    const latestReads: unknown[] = [];
    const spy = { ...h.deps, store: new Proxy(h.store, { get: (target, name, receiver) => { const value: unknown = Reflect.get(target, name, receiver); return name === "get" ? (key: { sk: string }) => { if (key.sk === "TESTENV#LATEST") latestReads.push(1); return target.get(key as never); } : value; } }) };
    const start = await testEnvironmentForStart(spy, { orgId: ORG, project: PROJECT, taskId: "t5" }, ON);
    expect(latestReads).toHaveLength(1);
    expect(putItem(start.pin)).toMatchObject({ revision: 1, unused: "accounts_not_connected" });
  });

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

  it("are the project's readiness commands without an environment, as before", () => {
    const policy = taskWorkflowCheckPolicy(project);
    expect(policy.required.map((check) => check.command.executable)).toEqual(["make", "pytest"]);
    expect(policy.required.every((check) => check.kind === undefined)).toBe(true);
  });

  it("are the environment's checks first, with their kinds, then any readiness command the environment does not run", () => {
    const policy = taskWorkflowCheckPolicy(project, body());
    expect(policy.required.map((check) => [check.id, check.command.executable, check.kind])).toEqual([["required-1", "pytest", "test"], ["required-2", "ruff", "lint"], ["required-3", "make", undefined]]);
    expect(policy.required[0]!.label).toBe("Unit tests");
  });
});

describe("a started task's check policy", () => {
  it("begins with the environment's checks when the project has an approved one, and is the project's own readiness commands when it has none", async () => {
    const h = await bench({ project: "payments", env: ON, store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES }) });
    const t = createHarness({ backend: (clock) => ({ store: h.store, queues: new MemoryQueueService({ now: () => clock.now }) }) });
    await t.registerProject();
    t.deps.testEnvironment = createTaskTestEnvironment(h.deps, { orgId: ORG });
    const start = () => t.flow.start(t.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
    const policyOf = async (taskId: string) => ((await h.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" })) as unknown as { workflow: { checkPolicy: { required: Array<{ id: string; kind?: string; command: { executable: string } }> } } }).workflow.checkPolicy.required;
    expect(await policyOf((await start()).task.taskId)).toEqual([]);
    const environment = body({ repos: [{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 }, kind: "test" }] }], selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } });
    const proposed = await h.proposeAndProve(environment);
    expect(await h.approve(proposed.digest)).toMatchObject({ status: "decided" });
    expect((await policyOf((await start()).task.taskId)).map((check) => [check.id, check.command.executable, check.kind])).toEqual([["required-1", "npm", "test"]]);
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

  it("carries the environment's checks, selection rules and budget, bound to its digest", async () => {
    const h = await pinned();
    const plan = (await planOf(h))!;
    expect(plan).toMatchObject({ revision: 1, digest: testEnvDigest(body()), roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] } });
    expect(plan.checks).toEqual([{ id: "unit", kind: "test", selectArgs: ["{tests}"] }, { id: "lint", kind: "lint" }]);
    expect(plan.coverageMap).toBeUndefined();
  });

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

  it("is not built when the run's first commands are not the environment's checks, or fewer", async () => {
    const h = await pinned();
    expect(await planOf(h, [cmd("make", ["old-test"]), cmd("pytest", ["-q"]), cmd("ruff", ["check"])])).toBeUndefined();
    expect(await planOf(h, [cmd("pytest", ["-q"])])).toBeUndefined();
    expect(await planOf(h, [cmd("pytest", ["-q", "-x"]), cmd("ruff", ["check"])])).toBeUndefined();
    expect(await planOf(h, [])).toBeUndefined();
  });

  it("is not built for a task with no pin, a pin for an environment that was not applied, or a pin for other contents", async () => {
    const h = await harness();
    await h.approve(body());
    expect(await planOf(h)).toBeUndefined();
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    const item = putItem(start.pin);
    await h.store.put({ item: { ...item, unused: "services_not_connected" } });
    expect(await planOf(h)).toBeUndefined();
    await h.store.put({ item: { ...item, digest: "f".repeat(64) } });
    expect(await planOf(h)).toBeUndefined();
    await h.store.put({ item: item });
    expect(await planOf(h)).toBeDefined();
    expect(await planOf(h, readiness, { ROVARA_TEST_ENVIRONMENT: "0" })).toBeUndefined();
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

describe("the evidence's environment", () => {
  it("names the pinned environment and its revision, and gives the data guard its production list", async () => {
    const h = await harness();
    await h.approve(body({ prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] } }));
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    await h.store.put({ item: putItem(start.pin) });
    const chosen = await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(chosen.environment).toEqual({ tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] });
    expect(chosen.deny).toEqual({ accountIds: ["111122223333"], hosts: [], arnPrefixes: [] });
    expect(chosen.note).toBeUndefined();
    // A task with no pin says nothing (the pack then reads as it always did).
    expect(await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t9" }, ON)).toEqual({});
    expect(await evidenceEnvironmentOf(h.deps, { project: PROJECT, taskId: "t1" }, ON)).toEqual({});
  });
});


describe("the pack kept for a task that pinned an environment", () => {
  const DIGEST = "c".repeat(64);
  const OP = "op-1";
  const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "t1" };
  const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
  const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }, { name: "c", status: "passed" }], newTests: [] } }], selection: { method: "full", selected: 3, total: 3 } });
  const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
  const deps: KeepEvidenceDeps = {
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
  const checks: CheckEntry[] = [{ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 7, exitCode: 0 }];

  it("keepEvidence names the revision it ran in, and says why when the project's environment was not applied", async () => {
    const used = await keepEvidence(deps, { orgId: "org_00000000000000000000", task: TASK, operationId: OP, candidateDigest: DIGEST, checks, environment: { tier: "sandbox", envRevision: 4, services: [], data: "synthetic", accounts: [] } });
    expect(used).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(blobs, TASK, DIGEST);
    expect(pack?.environment).toMatchObject({ tier: "sandbox", envRevision: 4 });
    expect(pack?.notTested.some((item) => item.id === "test_environment")).toBe(false);
    const note = { kind: "environment" as const, id: "test_environment", text: `${UNUSED_WORDS.accounts_not_connected}: the project's own test setup was used`, reason: "not applied" };
    // The pack of a task is kept once per code; a task on other code (another digest) is told as unused.
    const other = "d".repeat(64);
    const otherRaw = raw.replace(DIGEST, other);
    const otherDeps: KeepEvidenceDeps = { ...deps, actions: { ...deps.actions, readArtifact: async (key, max) => (key.startsWith(PREFIX) ? otherRaw.slice(0, max) : deps.actions.readArtifact(key, max)) } };
    expect(await keepEvidence(otherDeps, { orgId: "org_00000000000000000000", task: TASK, operationId: OP, candidateDigest: other, checks, environmentNote: note })).toMatchObject({ kept: true });
    const unused = await loadEvidencePack(blobs, TASK, other);
    expect(unused?.environment.envRevision).toBe(0);
    expect(unused?.notTested.find((item) => item.id === "test_environment")?.text).toContain("test accounts");
  });
});
