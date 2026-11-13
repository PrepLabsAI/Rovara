// The setup run on a laptop's worker: it joins the machine's own sandbox network (the only one the Docker socket guard lets a sandbox use), makes no network and starts no helper, and so reports no blocked website.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerWorkerMachines } from "../../packages/core/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/core/src/local/invoke-signer.js";
import { DEFAULT_DEVCONTAINER_REGISTRIES } from "../../packages/core/src/local/isolation/stack.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { assertSetupSandboxRunArgs, guardedSetupDocker } from "../../packages/worker/src/setup-agent.js";
import { sharedRunNetwork } from "../../packages/worker/src/setup-agent-invocation.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const rootPath = "/work/root";
const LOCAL_NETWORK = "rovara-sbx-0123456789abcdef";
const args = (sharedNetwork?: string) => taskSandboxRunArgs({ name: "agentx-task-x", taskId: "x", image: "i", rootPath, maskedPaths: [], hostCpus: 2, hostMemoryBytes: 8 * 2 ** 30, ...(sharedNetwork === undefined ? {} : { sharedNetwork }) });

describe("the setup sandbox on the machine's own sandbox network", () => {
  it("accepts the machine's sandbox network when the worker names it, and no other", () => {
    expect(() => assertSetupSandboxRunArgs(args(LOCAL_NETWORK), { rootPath, sharedNetwork: LOCAL_NETWORK })).not.toThrow();
    // The same arguments are refused when the worker was not told that network (a setup run never picks its own).
    expect(() => assertSetupSandboxRunArgs(args(LOCAL_NETWORK), { rootPath })).toThrow();
    expect(() => assertSetupSandboxRunArgs(args("some-other-network"), { rootPath, sharedNetwork: LOCAL_NETWORK })).toThrow();
    // Everything else still holds: no extra flag gets through just because the network is the machine's.
    const widened = [...args(LOCAL_NETWORK).slice(0, 1), "--privileged", ...args(LOCAL_NETWORK).slice(1)];
    expect(() => assertSetupSandboxRunArgs(widened, { rootPath, sharedNetwork: LOCAL_NETWORK })).toThrow();
  });

  it("passes the run's docker calls through the same guard as before", async () => {
    const calls: string[][] = [];
    const real: DockerCli = { run: async (a) => { calls.push([...a]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    const guarded = guardedSetupDocker(real, { rootPath, sharedNetwork: LOCAL_NETWORK });
    await guarded.run(args(LOCAL_NETWORK));
    expect(calls).toHaveLength(1);
    await expect(guarded.run([...args(LOCAL_NETWORK), "extra"])).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("has a run network that makes and removes nothing and reports no blocked website", async () => {
    const network = sharedRunNetwork(LOCAL_NETWORK);
    expect(network.name).toBe(LOCAL_NETWORK);
    expect(await network.readBlocked()).toEqual([]);
    await expect(network.stop()).resolves.toBeUndefined();
  });
});

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const folders: string[] = [];
afterEach(async () => { while (folders.length > 0) await rm(folders.pop()!, { recursive: true, force: true }); });

describe("what a machine starts with on a laptop", () => {
  async function world(options: { devcontainerRegistries?: readonly string[] } = {}) {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-sa-"));
    folders.push(stateDirectory);
    const docker = new FakeDocker();
    const machines = new DockerWorkerMachines({
      image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch,
      extraAllowedDomains: (project) => (project === "payments" ? ["deps.exampledeps.dev", "not a name", "10.0.0.5"] : []),
      ...options,
    });
    const start = async (key: string, projectName: string | undefined) => {
      const handle = await machines.start({ machineKey: key, companyId: COMPANY, ...(projectName === undefined ? {} : { projectName }) });
      const hash = handle.machineId.slice("rovara-worker-".length);
      return {
        allowed: (JSON.parse(docker.containers.get(`rovara-gw-${hash}`)!.environment.ROVARA_GW_CONFIG!) as { allowed: string[] }).allowed,
        policy: JSON.parse(docker.containers.get(`rovara-sock-${hash}`)!.environment.ROVARA_SOCK_POLICY!) as Record<string, unknown>,
        machineId: handle.machineId,
      };
    };
    return { machines, docker, start };
  }

  it("reaches the websites the owner approved for its own project and no other project's, leaving out a name the allow-list rules refuse", async () => {
    const { start } = await world();
    const own = await start("ws-own", "payments");
    expect(own.allowed).toContain("deps.exampledeps.dev");
    expect(own.allowed).not.toContain("not a name");
    expect(own.allowed).not.toContain("10.0.0.5");
    expect((await start("ws-other", "billing")).allowed).not.toContain("deps.exampledeps.dev");
    expect((await start("ws-none", undefined)).allowed).not.toContain("deps.exampledeps.dev");
  });

  it("remakes a machine that starts again with a new website on its list, keeping its workspace, and leaves one with the same list alone", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-sa-"));
    folders.push(stateDirectory);
    const docker = new FakeDocker();
    let hosts: string[] = [];
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, extraAllowedDomains: () => hosts });
    const handle = await machines.start({ machineKey: "ws-1", companyId: COMPANY, projectName: "payments" });
    const hash = handle.machineId.slice("rovara-worker-".length);
    const gateway = (): string => docker.containers.get(`rovara-gw-${hash}`)!.environment.ROVARA_GW_CONFIG!;
    const before = gateway();
    await machines.start({ machineKey: "ws-1", companyId: COMPANY, projectName: "payments" });
    expect(gateway()).toBe(before);
    hosts = ["deps.exampledeps.dev"];
    await machines.start({ machineKey: "ws-1", companyId: COMPANY, projectName: "payments" });
    expect((JSON.parse(gateway()) as { allowed: string[] }).allowed).toContain("deps.exampledeps.dev");
  });

  it("tells its Docker socket guard which registries a dev container may pull from: the install's list, the owner's own, or none (and none when nothing was said)", async () => {
    const standard = await (await world({ devcontainerRegistries: DEFAULT_DEVCONTAINER_REGISTRIES })).start("ws-a", "payments");
    expect(standard.policy["devcontainer"]).toEqual({ registries: [...DEFAULT_DEVCONTAINER_REGISTRIES] });
    const unsaid = await (await world()).start("ws-a", "payments");
    expect(unsaid.policy).not.toHaveProperty("devcontainer");
    const own = await (await world({ devcontainerRegistries: ["registry.example.com"] })).start("ws-a", "payments");
    expect(own.policy["devcontainer"]).toEqual({ registries: ["registry.example.com"] });
    const off = await (await world({ devcontainerRegistries: [] })).start("ws-a", "payments");
    expect(off.policy).not.toHaveProperty("devcontainer");
  });
});
