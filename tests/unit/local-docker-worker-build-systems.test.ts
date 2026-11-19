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
  it("sets nothing when no build system is registered", async () => {
    const { machines, docker } = await build(() => []);
    const handle = await machines.start({ machineKey: "ws-none", companyId: COMPANY });
    expect(docker.containers.get(handle.machineId)!.environment[BUILD_SYSTEM_PROFILES_ENV]).toBeUndefined();
  });

  it("hands the profiles to the worker as ROVARA_BUILD_SYSTEMS, in the environment file and not in Docker's arguments", async () => {
    const { machines, docker } = await build(async () => [profile()]);
    const handle = await machines.start({ machineKey: "ws-profile", companyId: COMPANY });
    const value = docker.containers.get(handle.machineId)!.environment[BUILD_SYSTEM_PROFILES_ENV];
    expect(parseBuildSystemProfiles(value)).toEqual([profile()]);
    expect(JSON.stringify(docker.calls)).not.toContain("detect-examplebuild");
  });

  it("does not let a machine spec (a project) set the variable, or name its own detector module", async () => {
    const { machines } = await build();
    await expect(machines.start({ machineKey: "ws-spec", companyId: COMPANY, environment: { [BUILD_SYSTEM_PROFILES_ENV]: JSON.stringify([profile()]) } })).rejects.toMatchObject({ code: "rejected" });
  });

  it("starts nothing when a profile is not valid (a machine is not started with a build system half described)", async () => {
    const { machines, docker } = await build(() => [{ name: "bad", detectorModule: "../escape.js", setupPrograms: [], keyFileGlobs: [] }]);
    await expect(machines.start({ machineKey: "ws-bad", companyId: COMPANY })).rejects.toThrow();
    expect([...docker.containers.values()].filter((container) => container.kind === "worker")).toHaveLength(0);
  });

  it("re-creates an idle machine when the profiles change, like any change of its environment", async () => {
    let current: BuildSystemProfile[] = [profile()];
    const { machines, docker } = await build(() => current);
    const first = await machines.start({ machineKey: "ws-change", companyId: COMPANY });
    const before = docker.containers.get(first.machineId)!.labels["rovara.local.config"];
    current = [profile({ setupPrograms: ["examplebuild", "more"] })];
    const second = await machines.start({ machineKey: "ws-change", companyId: COMPANY });
    const after = docker.containers.get(second.machineId)!.labels["rovara.local.config"];
    expect(after).not.toBe(before);
    expect(parseBuildSystemProfiles(docker.containers.get(second.machineId)!.environment[BUILD_SYSTEM_PROFILES_ENV])[0]?.setupPrograms).toContain("more");
  });
});
