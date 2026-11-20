// Port lane P6 (item B1): the local Docker adapter hands the registered build systems' profiles to the worker in its start-up environment, and only the broker can set them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_SYSTEM_PROFILES_ENV, BuildSystemProfileSchema, parseBuildSystemProfiles, type BuildSystemProfile } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DockerWorkerMachines } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

const profile = (extra: Record<string, unknown> = {}): BuildSystemProfile => BuildSystemProfileSchema.parse({ name: "examplebuild", detectorModule: "@example/detect-examplebuild", setupPrograms: ["examplebuild"], ...extra });

async function build(buildSystems?: () => Promise<readonly BuildSystemProfile[]> | readonly BuildSystemProfile[]) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-p6-"));
  cleanup.push(stateDirectory);
  const docker = new FakeDocker();
  const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, ...(buildSystems === undefined ? {} : { buildSystems }) });
  return { docker, machines };
}

describe("build systems on the local worker machine", () => {

  it("hands the profiles to the worker as ROVARA_BUILD_SYSTEMS, in the environment file and not in Docker's arguments", async () => {
    const { machines, docker } = await build(async () => [profile()]);
    const handle = await machines.start({ machineKey: "ws-profile", companyId: COMPANY });
    const value = docker.containers.get(handle.machineId)!.environment[BUILD_SYSTEM_PROFILES_ENV];
    expect(parseBuildSystemProfiles(value)).toEqual([profile()]);
    expect(JSON.stringify(docker.calls)).not.toContain("detect-examplebuild");
  });
});
