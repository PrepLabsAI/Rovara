// Company-approved extra images, wire side only (switch `pj`): the plan dependency `backing: "company"` and its `company` block parse, and Rovara Code's worker REFUSES such a plan by name: it has no way to fetch or verify
// an image of a company's own (it starts only the digests its catalog pins), so a company image is never started, not even with a digest the catalog pins. The approval process for company images is not in Rovara Code.
// No Docker: a fake daemon (tests/support/fake-services-docker.ts).
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE, TaskDependencyPlanSchema, WORKER_INVOCATION_FEATURES, type ProjectCommand, type ServiceCatalog, type TaskDependencyPlan } from "@agentx/contracts";
import { withDetachedWorking } from "../../packages/worker/src/check-sandbox.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { TestServicesError, startTestServicesRun, testServicesAdvertisedFeatures, type SealedRoundPorts, type SealedRoundSetup, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
import type { CheckPlan, CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { fakeServicesDocker, type FakeServicesDockerOptions } from "../support/fake-services-docker.js";

const DIGEST = "a".repeat(64);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const MIGRATE: ProjectCommand = { cwd: "app", executable: "npm", args: ["run", "migrate"], timeoutSeconds: 60 };
const TEST_COMMAND: ProjectCommand = { cwd: "app", executable: "npm", args: ["test"], timeoutSeconds: 60 };

const roots: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function dependency(change: Partial<TaskDependencyPlan> = {}): TaskDependencyPlan {
  return TaskDependencyPlanSchema.parse({
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: DIGEST,
    config: { database: "app", user: "app" }, aliases: ["postgres"],
    connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }, { name: "PGPASSWORD", template: "{password}" }],
    seeds: [{ command: MIGRATE }], reset: "fresh_per_round", ...change,
  });
}

const catalog: ServiceCatalog = (() => {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog;
  const copy = structuredClone(raw);
  for (const entry of copy.entries) if (entry.id === "postgres@16") entry.image.digest = DIGEST;
  return copy;
})();

interface SealedState {
  executed: ProjectCommand[];
  setups: SealedRoundSetup[];
  rounds: number;
  /** The round's callback waits for this before it hands the runners over (to hold a round open). */
  hold?: Promise<void>;
  failStart?: boolean;
  /** The round fails when it ends, with `closeError` as its message (a clean-up fault whose message holds a secret). */
  failClose?: boolean;
  closeError?: string;
  exitCode?: number;
  timedOut?: boolean;
  throwOnCommand?: boolean;
  /** A command that takes this long to run (the signal can stop it). */
  slowCommand?: boolean;
}

/** s1-sealed's two exports, as a stub: the round is the real `withDetachedWorking`, the checks are recorded. */
function stubSealed(state: SealedState): SealedRoundPorts {
  return {
    withSealedCheckRound(setup, round) {
      state.setups.push(setup);
      return withDetachedWorking(setup.docker, setup.plan, async (start) => {
        if (state.failStart === true) throw new Error("the sealed round could not start");
        await start();
        state.rounds += 1;
        const runners: CheckRunners = {
          async runProjectCommand(command, signal) {
            state.executed.push(command);
            // The seeds (`npm run migrate`) always work; the failures below are the CHECK's.
            if (command.args.join(" ") === "run migrate") return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
            if (state.throwOnCommand === true) throw new Error("the check could not be run");
            if (state.slowCommand === true) await new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
            return { exitCode: state.exitCode ?? 0, timedOut: state.timedOut === true, stdout: "ok", stderr: "" };
          },
          runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
        };
        if (state.hold !== undefined) await state.hold;
        const value = await round(runners);
        if (state.failClose === true) throw new Error(state.closeError ?? "close failed");
        return value;
      });
    },
    buildServiceUsageRecord(input) {
      return Promise.resolve({
        schemaVersion: 1,
        dependencies: input.planned.map((id) => ({ id, started: true, healthy: true, startMs: input.startMs === undefined || typeof input.startMs !== "number" ? 0 : input.startMs, resetCount: input.resetCounts?.get(id) ?? 0, ...(input.failures?.get(id) === undefined ? {} : { failure: input.failures.get(id) }) })),
        unknownCalls: { domains: [], otherCount: 0 },
      });
    },
  };
}

async function harness(options: { docker?: FakeServicesDockerOptions; sealed?: Partial<SealedState> } = {}) {
  const fake = fakeServicesDocker(options.docker);
  const root = await temp("rsv-workspace-");
  await mkdir(join(root, "app"));
  const runParent = await temp("rsv-runs-");
  const state: SealedState = { executed: [], setups: [], rounds: 0, ...options.sealed };
  const logs: Array<Record<string, unknown>> = [];
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  const config: TestServicesConfig = {
    docker: fake.docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(catalog), sealedRound: stubSealed(state), sleep: () => Promise.resolve(), log: (event) => logs.push(event),
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker: fake.docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const artifactSink = (artifact: { name: string; mediaType: string; content: string }): Promise<void> => { artifacts.push(artifact); return Promise.resolve(); };
  const start = (dependencies: readonly TaskDependencyPlan[] = [dependency()], hasDevcontainer = false) => startTestServicesRun(config, { dependencies, hasDevcontainer, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, "app")], sandbox, artifactSink });
  const checkPlan: CheckPlan = { source: "project", readiness: [TEST_COMMAND], projectBefore: ["passed"] };
  const base: CheckRunners = { runProjectCommand: () => Promise.reject(new Error("the working sandbox's runners must not run a check")), runAgentCommand: () => Promise.reject(new Error("the working sandbox's runners must not run a check")) };
  return { fake, root, runParent, state, logs, artifacts, config, sandbox, start, checkPlan, base };
}

const nothingLeft = async (h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
  expect(h.fake.left().networks).toEqual([]);
  expect(h.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
  expect(await readdir(h.runParent)).toEqual([]);
};

const COMPANY = { imageId: "img_" + "1".repeat(20), registry: "docker.io", repository: "library/postgres", digest: "c".repeat(64) };
const companyPlan = (change: Record<string, unknown> = {}): TaskDependencyPlan => dependency({ backing: "company", digest: COMPANY.digest, company: COMPANY, ...change } as never);

describe("the wire: a company image plan", () => {
  it("parses with its company block, and the plan says plainly that it is a company image", () => {
    const plan = companyPlan();
    expect(plan.backing).toBe("company");
    expect(plan.company).toEqual(COMPANY);
  });

  it("is refused when it does not name its approval, runs another digest than the approved one, borrows a helper's profile, carries AWS services, or when a catalog plan carries a company block", () => {
    const base = { id: "postgres", name: "Postgres", kind: "database", family: "postgres", catalogId: "postgres@16", repository: "svc/postgres", config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round" };
    const parse = (change: Record<string, unknown>) => TaskDependencyPlanSchema.safeParse({ ...base, digest: COMPANY.digest, ...change }).success;
    expect(parse({ backing: "company", company: COMPANY })).toBe(true);
    expect(parse({ backing: "company" })).toBe(false);
    expect(parse({ backing: "company", company: { ...COMPANY, digest: "d".repeat(64) } })).toBe(false);
    expect(parse({ backing: "company", company: { ...COMPANY, imageId: "img_short" } })).toBe(false);
    expect(parse({ backing: "company", company: { ...COMPANY, extra: 1 } })).toBe(false);
    expect(parse({ backing: "local", company: COMPANY })).toBe(false);
  });

  it("has its worker feature string, listed for a worker invocation, and this worker does not advertise it", () => {
    expect(TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE).toBe("task.testServices.companyImage.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE);
    for (const environment of [{}, { AGENTX_SANDBOX_IMAGE: IMAGE, AGENTX_WORKER_IMAGE: IMAGE }]) expect(testServicesAdvertisedFeatures(environment)).not.toContain(TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE);
  });
});

describe("Rovara Code's worker refuses a company image", () => {
  it("BY NAME with the same sentence as a digest it does not pin: it is never started, even with the digest the catalog pins, and nothing is pulled or made", async () => {
    const h = await harness();
    const pinned = dependency().digest as string;
    for (const plan of [companyPlan(), companyPlan({ digest: pinned, company: { ...COMPANY, digest: pinned } })]) {
      const error = await h.start([plan]).then(() => undefined, (caught: unknown) => caught as TestServicesError);
      expect(error).toBeInstanceOf(TestServicesError);
      expect(error!.reason).toBe("pull_failed");
      expect(error!.message).toBe("Dependency image not available on this worker");
      expect(error!.failures.get("postgres")).toBe("pull_failed");
    }
    expect(h.fake.verbs("network").filter((call) => call[1] === "create")).toEqual([]);
    expect(h.fake.calls.some((call) => call[0] === "pull")).toBe(false);
    expect(h.fake.calls.some((call) => call.some((argument) => argument.includes("rovara-svc-")))).toBe(false);
    await nothingLeft(h);
  });

  it("refuses the plan even beside a catalog dependency: nothing of the run starts", async () => {
    const h = await harness();
    const error = await h.start([dependency(), companyPlan({ id: "cache", name: "Cache", family: "valkey", catalogId: "valkey@8", repository: "svc/valkey" })]).then(() => undefined, (caught: unknown) => caught as TestServicesError);
    expect(error).toBeInstanceOf(TestServicesError);
    expect(error!.reason).toBe("pull_failed");
    expect(error!.failures.get("cache")).toBe("pull_failed");
    expect(h.fake.calls.some((call) => call.some((argument) => argument.includes("rovara-svc-")))).toBe(false);
    await nothingLeft(h);
  });
});
