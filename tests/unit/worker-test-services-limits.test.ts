// DEC 254zm 2 on the worker's side: it is told the guard's ceilings, refuses a run that cannot fit before anything starts, and when the guard stops a start it says so in one fixed sentence (never Docker's words).
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_SERVICES_CEILING_MARKER, TEST_SERVICES_LIMIT_SENTENCES, TEST_SERVICES_OVER_LIMIT_SENTENCE, TaskDependencyPlanSchema, ownerCatalogOf, ownerImageReferences, ownerStarterEntries,
  type CatalogEntry, type ProjectCommand, type ServiceCatalog, type TaskDependencyPlan,
} from "@agentx/contracts";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { createDockerServiceRunner, forgetWorkerStartSweeps, type ServiceRunner } from "../../packages/worker/src/service-runner.js";
import { startTestServicesRun, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
import { fakeServicesDocker } from "../support/fake-services-docker.js";
import { RUN_FIXED_CONTAINERS, HelperStartError, startHelpers, type HelperFiles } from "../../packages/worker/src/service-helpers.js";
import { TEST_SERVICES_OWNER_IMAGES_ENVIRONMENT, TestServicesError, failureOf, testServicesConfigFromEnvironment } from "../../packages/worker/src/test-services-run.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WORKER_IMAGE = `sha256:${"a".repeat(64)}`;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  AGENTX_TEST_SERVICES_RUN_DIR: "/run/test-services", AGENTX_SANDBOX_IMAGE: "worker:test", AGENTX_WORKER_IMAGE: WORKER_IMAGE, [TEST_SERVICES_OWNER_IMAGES_ENVIRONMENT]: JSON.stringify(ownerStarterEntries()), ...extra,
});
const idle = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as DockerCli;

describe("the worker's configuration: the guard's ceilings", () => {
  it("takes what the broker told it", () => {
    expect(testServicesConfigFromEnvironment(env({ AGENTX_TEST_SERVICES_MAX_CONTAINERS: "30", AGENTX_TEST_SERVICES_MAX_HELPER_MEM_MIB: "2048" }), idle, undefined, false)!.limits).toEqual({ containers: 30, helperMemMiB: 2048 });
  });
});

describe("starting helpers under the ceilings", () => {
  const files: HelperFiles = { write: async (name) => `/run/files/${name}`, remove: async () => undefined };
  const net = {
    name: "rovara-svc-0123456789ab", bridge: "rvi01234567", slot: 7, subnet: "172.30.7.0/24", gateway: "172.30.7.1", ipRange: "172.30.7.128/25", dnsHelperIp: "172.30.7.2", workingSandboxIp: "172.30.7.3", checkSandboxIp: "172.30.7.4", proxyIp: "172.30.7.5",
    helperIp: (index: number) => `172.30.7.${String(16 + index)}`, labelArgs: () => ["--label", "x=1"], stop: async () => undefined,
  };
  const entryOf = (id: string): CatalogEntry => ownerCatalogOf(ownerStarterEntries())!.entries.find((entry) => entry.id === id)!;
  const cli = (answer?: (call: string[]) => { exitCode: number; stderr: string }): { cli: DockerCli; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, cli: { run: async (call: string[]) => { calls.push(call); const refused = answer?.(call); return { exitCode: refused?.exitCode ?? 0, stdout: call[0] === "image" ? "null\n" : call[0] === "inspect" ? "running\n" : "", stderr: refused?.stderr ?? "" }; } } };
  };
  const input = (entries: CatalogEntry[], limits?: { containers: number; helperMemMiB: number }) => ({
    registry: "owner-list.invalid", edition: "public" as const, probeImage: WORKER_IMAGE, maxMemMiB: 65536, files, imageReferences: ownerImageReferences(ownerStarterEntries()),
    ...(limits === undefined ? {} : { limits }),
    helpers: entries.map((entry, index) => ({ id: `${entry.family}${String(index)}`, name: entry.family, entry, aliases: [`${entry.connect.defaultAliases[0]!}${String(index)}`], credentials: { user: "rovara", password: "p".repeat(32), database: "app" } })),
    now: () => 0, sleep: async () => undefined,
  });
  const redis = (): CatalogEntry => entryOf("redis@7");

  it("counts the name server and the check sandbox: helpers plus two may not pass the container ceiling, and the refusal starts nothing", async () => {
    expect(RUN_FIXED_CONTAINERS).toBe(2);
    const four = [redis(), redis(), redis(), redis()];
    const ok = cli();
    await expect(startHelpers(ok.cli, net, input(four, { containers: 6, helperMemMiB: 1024 }))).resolves.toBeDefined();
    const over = cli();
    const error = await startHelpers(over.cli, net, input(four, { containers: 5, helperMemMiB: 1024 })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HelperStartError);
    expect(error).toMatchObject({ reason: "over_limit", message: TEST_SERVICES_OVER_LIMIT_SENTENCE });
    expect(over.calls).toEqual([]);
  });

  it("when the guard stops a start with its words, the failure is the fixed over-limit sentence and nothing of Docker's text", async () => {
    for (const words of Object.values(TEST_SERVICES_LIMIT_SENTENCES)) {
      const stopped = cli((call) => (call[0] === "run" && call.includes("--detach") ? { exitCode: 125, stderr: `docker: Error response from daemon: rovara: ${words}.\nSecret path /home/me/x` } : { exitCode: 0, stderr: "" }));
      const error = await startHelpers(stopped.cli, net, input([redis()])).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: "over_limit", message: TEST_SERVICES_OVER_LIMIT_SENTENCE });
      expect(String((error as Error).message)).not.toContain("/home/me");
      expect(words).toContain(TEST_SERVICES_CEILING_MARKER);
    }
  });

  it("any other failed start stays 'could not be started'", async () => {
    const failed = cli((call) => (call[0] === "run" && call.includes("--detach") ? { exitCode: 125, stderr: "docker: Error response from daemon: no space left" } : { exitCode: 0, stderr: "" }));
    await expect(startHelpers(failed.cli, net, input([redis()]))).rejects.toMatchObject({ reason: "start_failed", message: "redis could not be started" });
  });

  it("the run's failure for an over-limit start is the fixed sentence, and for any other start failure still the old one", () => {
    const over = failureOf(new HelperStartError("over_limit", TEST_SERVICES_OVER_LIMIT_SENTENCE, "redis0"));
    expect(over).toBeInstanceOf(TestServicesError);
    expect(over.reason).toBe("over_limit");
    expect(over.message).toBe(TEST_SERVICES_OVER_LIMIT_SENTENCE);
    expect(over.failures.get("redis0")).toBe("start_failed");
    expect(failureOf(new HelperStartError("start_failed", "x", "redis0")).message).toBe("The test services could not be started");
    expect(failureOf(new HelperStartError("health_timeout", "x", "redis0")).reason).toBe("not_healthy");
  });
});

describe("a run's start passes the configured ceilings on and reports an over-limit start in the fixed sentence", () => {
  const roots: string[] = [];
  beforeEach(() => forgetWorkerStartSweeps());
  afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  const temp = async (prefix: string): Promise<string> => { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; };
  const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
  const DIGEST = "a".repeat(64);
  const MIGRATE: ProjectCommand = { cwd: "app", executable: "npm", args: ["run", "migrate"], timeoutSeconds: 60 };
  const catalog: ServiceCatalog = (() => {
    const copy = structuredClone(JSON.parse(readFileSync(new URL("../fixtures/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog);
    for (const entry of copy.entries) if (entry.id === "postgres@16") entry.image.digest = DIGEST;
    return copy;
  })();
  const plan = (): TaskDependencyPlan => TaskDependencyPlanSchema.parse({
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: DIGEST, config: { database: "app", user: "app" }, aliases: ["postgres"],
    connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [{ command: MIGRATE }], reset: "fresh_per_round",
  });

  it("hands the runner exactly the configured limits, and an over-limit start ends the run with the fixed sentence and a failed-start record", async () => {
    const fake = fakeServicesDocker();
    const root = await temp("rsl-workspace-");
    await mkdir(join(root, "app"));
    const runParent = await temp("rsl-runs-");
    const seen: Array<Parameters<ServiceRunner["start"]>[0]> = [];
    const runner = { start: (input: Parameters<ServiceRunner["start"]>[0]) => { seen.push(input); return Promise.reject(new HelperStartError("over_limit", TEST_SERVICES_OVER_LIMIT_SENTENCE, "postgres")); } };
    const config: TestServicesConfig = {
      docker: fake.docker, registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
      limits: { containers: 7, helperMemMiB: 300 }, catalog: () => Promise.resolve(catalog), runner, sleep: () => Promise.resolve(), log: () => undefined,
      sealedRound: { withSealedCheckRound: () => Promise.reject(new Error("not reached")), buildServiceUsageRecord: () => Promise.reject(new Error("not reached")) } as never,
    };
    const sandbox = new TaskSandbox({ rootPath: root, taskId: "44444444-4444-4444-8444-444444444444", docker: fake.docker, image: IMAGE, log: () => undefined });
    await sandbox.start();
    const error = await startTestServicesRun(config, { dependencies: [plan()], hasDevcontainer: false, operationId: "44444444-4444-4444-8444-444444444444", rootPath: root, repositoryPaths: [join(root, "app")], sandbox, artifactSink: () => Promise.resolve() })
      .then(() => undefined, (caught: unknown) => caught as TestServicesError);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.limits).toEqual({ containers: 7, helperMemMiB: 300 });
    expect(error).toBeInstanceOf(TestServicesError);
    expect(error).toMatchObject({ reason: "over_limit", message: TEST_SERVICES_OVER_LIMIT_SENTENCE });
    expect(error!.failures.get("postgres")).toBe("start_failed");
  });

  it("the docker service runner hands the limits to the helper launcher (a run that cannot fit is refused before any container is made)", async () => {
    const fake = fakeServicesDocker();
    const runParent = await temp("rsl-runner-");
    const entry = catalog.entries.find((candidate) => candidate.id === "postgres@16")!;
    const files = { write: (name: string) => Promise.resolve(join(runParent, name)), remove: () => Promise.resolve() };
    const start = (limits?: { containers: number; helperMemMiB: number }) => createDockerServiceRunner(fake.docker).start({
      runId: "r1", workspace: "0123456789abcdef", roundBudgetMs: 60_000, registry: "registry.example.test/rovara-catalog/staging", edition: "public", probeImage: IMAGE, maxMemMiB: 3072, ...(limits === undefined ? {} : { limits }), files,
      helpers: [{ id: "postgres", name: "Postgres", entry, aliases: ["postgres"], credentials: { user: "app", password: "p".repeat(32), database: "app" } }],
    } as never);
    await expect(start({ containers: 2, helperMemMiB: 4096 })).rejects.toMatchObject({ reason: "over_limit", message: TEST_SERVICES_OVER_LIMIT_SENTENCE });
    expect(fake.calls.some((call) => call[0] === "run" && call.includes("--detach") && call.some((part) => part.includes("-h")))).toBe(false);
  });
});
