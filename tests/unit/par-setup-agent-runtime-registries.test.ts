// The install's choice of registries for dev containers reaches the worker machines' Docker socket guard: what `startLocalRuntime` builds from the
// environment and the daemon is what the guard's policy holds (a fixed list in the runtime would pass every test of the pieces).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function guardPolicyOf(environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "rovara-par-reg-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  const docker = new FakeDocker();
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment, workerImage: "worker:test", docker, workerFetch: docker.fetch, version: "9.9.9", gh: async () => undefined,
  });
  cleanup.push(() => runtime.stop());
  const machines = runtime.registry.require("worker-machines", "docker");
  const handle = await machines.start({ machineKey: "reg-test", companyId: IMPLICIT_COMPANY_ID });
  const hash = handle.machineId.slice("rovara-worker-".length);
  return JSON.parse(docker.containers.get(`rovara-sock-${hash}`)!.environment.ROVARA_SOCK_POLICY!) as Record<string, unknown>;
}

describe("the registries of dev containers, from the install to the guard", () => {
  it("hands the guard the owner's own list, whatever the daemon is", async () => {
    const policy = await guardPolicyOf({ ROVARA_DEVCONTAINER_REGISTRIES: "registry.example.test, ghcr.io" });
    expect(policy.devcontainer).toEqual({ registries: ["registry.example.test", "ghcr.io"] });
  });

});
