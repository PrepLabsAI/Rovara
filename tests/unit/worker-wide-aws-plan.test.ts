// A wide AWS plan end to end, on the worker's side and the broker's: an approved environment that asks Rovara local AWS for services beyond s3, sqs and dynamodb is pinned by the broker (the real plan code, from a signed
// catalog), needs the all-services worker feature, goes to a worker that lists it and is refused cleanly by one that does not; the worker starts it (no `mismatch`), the sandbox's variables name only the planned services and the
// ones the repository's own settings set, and the usage record is the wide one only when the plan was. No Docker: a fake daemon (tests/support/fake-services-docker.ts).
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_PLAN_FEATURE, TestEnvTaskPlanSchema, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES,
  type ProjectCommand, type ServiceCatalog, type TaskDependencyPlan,
} from "@agentx/contracts";
import { taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";
import { withDetachedWorking } from "../../packages/worker/src/check-sandbox.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { TestServicesError, startTestServicesRun, type SealedRoundPorts, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { fakeServicesDocker } from "../support/fake-services-docker.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const OPERATION = "55555555-5555-4555-8555-555555555555";
const SEED: ProjectCommand = { cwd: "app", executable: "npm", args: ["run", "seed"], timeoutSeconds: 60 };
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });

const roots: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

// ---- the broker's side: the real plan from a pinned catalog

const aws = (service: string, over: Record<string, unknown> = {}) => ({
  id: `aws-${service}`, name: service, kind: "cloud_api", family: `aws:${service}`, found: [{ path: "template.yaml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: [service], region: "us-east-1" },
  connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[]) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
  data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies,
});
const catalog: ServiceCatalog = pinnedCatalog();
const planOf = (dependencies: unknown[]): TaskDependencyPlan[] => {
  const result = taskDependencyPlansOf({ body: body(dependencies), catalog: verifiedCatalog(catalog), edition: "public" });
  if (!result.ok) throw new Error(result.reason);
  return result.dependencies;
};
const withSeed = (plans: TaskDependencyPlan[]): TaskDependencyPlan[] => plans.map((plan, index) => (index === 0 ? { ...plan, seeds: [{ command: SEED }] } : plan));

describe("the broker pins a wide plan, and only a worker that lists the feature is sent it", () => {
  const WIDE = [aws("sns", { connect: { env: [], hostAliases: ["aws"] } }), aws("secrets-manager"), aws("kinesis")];
  it("pins each service by its key, needs the all-services feature, and the plan parses on the wire", () => {
    const plans = planOf(WIDE);
    expect(plans.map((plan) => plan.aws!.services)).toEqual([["sns"], ["secrets-manager"], ["kinesis"]]);
    const needs = featuresForTestPlan(plans);
    expect(needs).toEqual(expect.arrayContaining([TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_AWS_ALL_SERVICES_FEATURE]));
    expect(TestEnvTaskPlanSchema.safeParse({ revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies: plans }).success).toBe(true);
  });
  it("a new worker (every feature) has all it needs; an old one without the feature lacks exactly that, so the dispatch guard refuses it with the fixed sentence", () => {
    const needs = featuresForTestPlan(planOf(WIDE));
    const lacking = (workerFeatures: readonly string[]) => needs.filter((feature) => !workerFeatures.includes(feature));
    expect(lacking(WORKER_INVOCATION_FEATURES)).toEqual([]);
    expect(lacking(WORKER_INVOCATION_FEATURES.filter((feature) => feature !== TEST_SERVICES_AWS_ALL_SERVICES_FEATURE))).toEqual([TEST_SERVICES_AWS_ALL_SERVICES_FEATURE]);
  });
  it("a plan of the three that were always seeded does not need the feature, so an old worker still gets it", () => {
    const narrow = planOf([aws("s3", { connect: { env: [], hostAliases: ["aws"] } }), aws("sqs"), aws("dynamodb")]);
    expect(featuresForTestPlan(narrow)).not.toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    expect(featuresForTestPlan(narrow)).toContain(TEST_SERVICES_AWS_PLAN_FEATURE);
  });
});

// ---- the worker's side: it starts the wide plan

function stubSealed(): SealedRoundPorts {
  return {
    withSealedCheckRound(setup, round) {
      return withDetachedWorking(setup.docker, setup.plan, async (start) => {
        await start();
        const runners: CheckRunners = {
          runProjectCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
          runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
        };
        return round(runners);
      });
    },
    buildServiceUsageRecord(input) {
      return Promise.resolve({
        schemaVersion: 1,
        dependencies: input.planned.map((id) => ({ id, started: true, healthy: true, startMs: 0, resetCount: input.resetCounts?.get(id) ?? 0 })),
        unknownCalls: { domains: [], otherCount: 0 },
      });
    },
  };
}

async function harness() {
  const fake = fakeServicesDocker();
  const root = await temp("rsv-workspace-");
  await mkdir(join(root, "app"));
  const runParent = await temp("rsv-runs-");
  const config: TestServicesConfig = {
    docker: fake.docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(catalog), sealedRound: stubSealed(), sleep: () => Promise.resolve(), log: () => undefined,
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker: fake.docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const start = (dependencies: readonly TaskDependencyPlan[]) => startTestServicesRun(config, { dependencies, hasDevcontainer: false, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, "app")], sandbox });
  return { fake, root, runParent, config, sandbox, start };
}

describe("the worker starts a wide plan", () => {
  it("accepts services beyond the three (no `mismatch`), and the sandbox's variables name the planned services and the ones the repository's settings set", async () => {
    const h = await harness();
    await writeFile(join(h.root, "app", ".env"), "AWS_ENDPOINT_URL_STEPFUNCTIONS=http://localhost:4566\nAWS_ENDPOINT_URL_SFN=http://localhost:4566\n");
    const plans = withSeed(planOf([aws("sns", { connect: { env: [], hostAliases: ["aws"] } }), aws("secrets-manager"), aws("kinesis")]));
    const run = await h.start(plans);
    try {
      // The seed ran in the working sandbox with the run's variables.
      const seeded = h.fake.execs.find((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL=") === true);
      expect(seeded, "the seed ran with the run's variables").toBeDefined();
      const lines = Object.fromEntries(seeded!.envFile!.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      const endpoint = lines["AWS_ENDPOINT_URL"]!;
      expect(endpoint).toMatch(/^http:\/\/aws:4566$/u);
      for (const name of ["AWS_ENDPOINT_URL_SNS", "AWS_ENDPOINT_URL_SECRETS_MANAGER", "AWS_ENDPOINT_URL_KINESIS"]) expect(lines[name], name).toBe(endpoint);
      // The repository's own `.env` names are pointed at the emulator too, whether the table knows the spelling (SFN) or not (STEPFUNCTIONS).
      expect(lines["AWS_ENDPOINT_URL_STEPFUNCTIONS"]).toBe(endpoint);
      expect(lines["AWS_ENDPOINT_URL_SFN"]).toBe(endpoint);
      // No variable for the ~430 other services.
      expect(Object.keys(lines).filter((name) => name.startsWith("AWS_ENDPOINT_URL_")).sort()).toEqual(["AWS_ENDPOINT_URL_KINESIS", "AWS_ENDPOINT_URL_SECRETS_MANAGER", "AWS_ENDPOINT_URL_SFN", "AWS_ENDPOINT_URL_SNS", "AWS_ENDPOINT_URL_STEPFUNCTIONS"]);
    } finally {
      await run.dispose();
    }
    expect(h.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
    expect(await readdir(h.runParent)).toEqual([]);
  });
  it("refuses a plan whose service the table does not know, before anything is started", async () => {
    const plan = planOf([aws("sns", { connect: { env: [], hostAliases: ["aws"] } })])[0]!;
    const h = await harness();
    const error = await h.start([{ ...plan, aws: { ...plan.aws!, services: ["nosuchservice"] } }]).then(() => undefined, (caught: unknown) => caught as TestServicesError);
    expect(error).toBeInstanceOf(TestServicesError);
    expect(error!.reason).toBe("mismatch");
  });
  it("refuses an emulator entry that names another engine release than the table's", async () => {
    const other: ServiceCatalog = structuredClone(catalog);
    for (const entry of other.entries) if (entry.id === "local-aws@r1" && entry.emulator !== undefined) entry.emulator.engineVersion = "1.0.321";
    const h = await harness();
    h.config.catalog = () => Promise.resolve(other);
    const error = await h.start(planOf([aws("sns", { connect: { env: [], hostAliases: ["aws"] } })])).then(() => undefined, (caught: unknown) => caught as TestServicesError);
    expect(error).toBeInstanceOf(TestServicesError);
    expect(error!.reason).toBe("mismatch");
  });
  it("starts one that names the table's engine release, and one that names none (a catalog made before the field)", async () => {
    for (const engineVersion of ["1.0.322", undefined]) {
      const copy: ServiceCatalog = structuredClone(catalog);
      for (const entry of copy.entries) if (entry.id === "local-aws@r1" && entry.emulator !== undefined) { if (engineVersion === undefined) delete entry.emulator.engineVersion; else entry.emulator.engineVersion = engineVersion; }
      const h = await harness();
      h.config.catalog = () => Promise.resolve(copy);
      const run = await h.start(planOf([aws("sns", { connect: { env: [], hostAliases: ["aws"] } })]));
      await run.dispose();
    }
  });
});
