import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TaskDependencyPlanSchema, type ServiceCatalog } from "@agentx/contracts";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { startTestServicesRun } from "../../packages/worker/src/test-services-run.js";
import { fakeServicesDocker } from "../support/fake-services-docker.js";

it("publishes the started services' local aliases to the mounted hosts inode before the working phase can run commands", async () => {
  forgetWorkerStartSweeps();
  const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-service-hosts-")));
  const fake = fakeServicesDocker();
  const runDocker = fake.docker.run.bind(fake.docker);
  // ICC gate: expose the sandbox's endpoint and host-side port. The fake's
  // run --rm host helper succeeds, representing isolation being set and verified.
  fake.docker.run = async (args, options) => {
    const result = await runDocker(args, options);
    if (args[0] === "inspect" && args.includes('{{(index .NetworkSettings.Networks "rovara-snet").MacAddress}}')) return { ...result, exitCode: 0, stdout: "02:42:ac:1c:fa:03" };
    if (args[0] === "exec" && args.includes("-e") && args.some(arg => arg.includes("iflink"))) return { ...result, stdout: "101" };
    return result;
  };
  const image = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
  const sandbox = new TaskSandbox({ rootPath: root, taskId: "gateway-services", docker: fake.docker, image, gatewayResolverDirectory: join(root, "name-files"),
    environment: { AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2" } });
  try {
    await mkdir(join(root, "services"), { mode: 0o700 });
    await sandbox.start();
    const dependency = TaskDependencyPlanSchema.parse({ id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: "a".repeat(64),
      config: { database: "app", user: "app" }, aliases: ["postgres", "test-db"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round" });
    const catalog = JSON.parse(readFileSync(new URL("../fixtures/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog;
    for (const entry of catalog.entries) if (entry.id === "postgres@16") entry.image.digest = dependency.digest!;
    await startTestServicesRun({ docker: fake.docker, registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", catalogEnv: "staging", edition: "public", probeImage: image, guardImage: image, maxMemMiB: 3072, runDirectoryParent: join(root, "services"), catalog: async () => catalog, sleep: async () => undefined,
      sealedRound: { withSealedCheckRound: async () => { throw new Error("no check round in this test"); }, buildServiceUsageRecord: async () => { throw new Error("no usage collection in this test"); } }, log: () => undefined },
    { dependencies: [dependency], hasDevcontainer: false, operationId: "gateway-services", rootPath: root, repositoryPaths: [root], sandbox });
    const args = fake.calls.find(call => call[0] === "run" && call.includes(sandbox.name))!;
    const mount = args.find(value => value.includes("dst=/etc/hosts,readonly"))!;
    const path = mount.split(",src=")[1]!.split(",dst=")[0]!;
    const hosts = await readFile(path, "utf8");
    expect(hosts).toMatch(/172\.\d+\.\d+\.16 postgres\n/u);
    expect(hosts).toMatch(/172\.\d+\.\d+\.16 test-db\n/u);
    expect(hosts).not.toContain("example.com");
  } finally {
    await sandbox.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
