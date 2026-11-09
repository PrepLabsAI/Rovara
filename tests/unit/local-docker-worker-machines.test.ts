// Port lane L4: the local Docker adapter, against a simulated Docker and a simulated worker that uses the real invoke verification.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTX_PROTOCOL_VERSION, MachineError, WorkerInvocationSchema, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DockerWorkerMachines, workspaceIdFor } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { runSetupAgentInvocation } from "../../packages/worker/src/setup-agent-invocation.js";
import { runWorkerMachinesConformance } from "../support/ports/worker-machines-conformance.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function build(options: { docker?: FakeDocker; maxConcurrentMachines?: number | null; stateDirectory?: string; callbackPort?: number; signer?: ReturnType<typeof createEphemeralInvokeSigner>; modelProxy?: boolean } = {}) {
  const stateDirectory = options.stateDirectory ?? (await mkdtemp(join(tmpdir(), "rovara-l4-")));
  cleanup.push(stateDirectory);
  const docker = options.docker ?? new FakeDocker();
  const machines = new DockerWorkerMachines({
    image: "worker:test",
    stateDirectory,
    callback: () => ({ tcpPort: options.callbackPort ?? 1234 }),
    signer: options.signer ?? createEphemeralInvokeSigner(),
    docker,
    fetch: docker.fetch,
    ...(options.modelProxy === undefined ? {} : { modelProxy: options.modelProxy }),
    ...(options.maxConcurrentMachines === undefined ? {} : { maxConcurrentMachines: options.maxConcurrentMachines }),
  });
  return { stateDirectory, docker, machines };
}

function invocationFor(workspaceId: string, operationId: string): WorkerInvocation {
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    operationId,
    workspaceId,
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(48),
    kind: "task",
    // The same operation id always carries the same job: the worker refuses a changed one as a conflict.
    payload: { conversationId: operationId, prompt: "make the change" },
  });
}

// The suite starts machines named "ws-1" and so on and then delivers jobs without naming the machine, so the harness remembers the key
// it last built a spec for and addresses the job to that machine's workspace.
runWorkerMachinesConformance("local docker (simulated docker)", {
  async create() {
    const { machines, stateDirectory } = await build();
    let lastKey = "ws-1";
    return {
      machines,
      invocation: (operationId) => invocationFor(workspaceIdFor(COMPANY, lastKey), operationId),
      spec: (machineKey) => {
        lastKey = machineKey;
        return { machineKey, companyId: COMPANY };
      },
      dispose: async () => {
        await rm(stateDirectory, { recursive: true, force: true });
      },
    };
  },
});

describe("local docker worker machines", () => {
  it("creates the worker on its internal network only, with no socket, no published port and the environment in a file", async () => {
    const { machines, docker, stateDirectory } = await build();
    const handle = await machines.start({ machineKey: "ws-flags", companyId: COMPANY, resources: { cpu: 2, memoryMiB: 4096 }, environment: { EXAMPLE_FLAG: "never-in-arguments" } });
    const create = docker.calls.find((call) => call[0] === "create" && call.includes(handle.machineId))!;
    const text = create.join(" ");
    for (const flag of ["--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 4096", "--user 1000:1000", "--memory 4096m", "--cpus 2"]) expect(text).toContain(flag);
    const hash = handle.machineId.slice("rovara-worker-".length);
    expect(text).toContain(`--network rovara-wnet-${hash}`);
    expect(create.filter((entry) => entry === "--network")).toHaveLength(1);
    for (const never of ["--network host", "--privileged", "--publish", "--add-host", "--group-add", "docker.sock", "--publish-all", "--env "]) expect(text, never).not.toContain(never);
    expect(text).not.toContain("never-in-arguments");
    const workspace = join(stateDirectory, "workspaces", hash);
    expect(create).toContain(`${workspace}:${workspace}`);
    expect(create.filter((entry) => entry === "--volume")).toHaveLength(1);
    const container = docker.containers.get(handle.machineId)!;
    expect(container.environment.EXAMPLE_FLAG).toBe("never-in-arguments");
    expect(container.environment.AGENTX_SANDBOX_IMAGE).toBe("worker:test");
    expect(container.environment.AGENTX_TASK_SHELL).toBeUndefined();
    // The worker is told addresses on its own network, never the computer's.
    expect(container.environment.AGENTX_CONTROL_PLANE_URL).toBe("http://rovara-broker:8081");
    expect(container.environment.DOCKER_HOST).toBe("tcp://rovara-sock:2375");
    expect(container.environment.AGENTX_SANDBOX_NETWORK).toBe(`rovara-snet-${hash}`);
    // The environment file is gone after the container is created.
    expect(readdirSync(join(stateDirectory, "workspaces")).filter((entry) => entry.startsWith(".env-"))).toEqual([]);
  });

  it("walls the machine: two internal networks without a host address, one plain bridge, a gateway on all three and a guard on the worker's", async () => {
    const { machines, docker } = await build();
    const handle = await machines.start({ machineKey: "ws-walls", companyId: COMPANY });
    const hash = handle.machineId.slice("rovara-worker-".length);
    const networks = [...docker.networks.values()];
    expect(networks.map((network) => network.name).sort()).toEqual([`rovara-snet-${hash}`, `rovara-wnet-${hash}`, `rovara-xnet-${hash}`]);
    for (const inner of networks.filter((network) => !network.name.includes("xnet"))) {
      expect(inner.internal).toBe(true);
      expect(inner.options["com.docker.network.bridge.inhibit_ipv4"]).toBe("true");
    }
    expect(networks.find((network) => network.name.includes("xnet"))!.internal).toBe(false);
    const gateway = docker.containers.get(`rovara-gw-${hash}`)!;
    const guard = docker.containers.get(`rovara-sock-${hash}`)!;
    expect([...gateway.networks.keys()].sort()).toEqual(networks.map((network) => network.name).sort());
    expect([...guard.networks.keys()]).toEqual([`rovara-wnet-${hash}`]);
    const gatewayText = gateway.args.join(" ");
    expect(gatewayText).toContain("--publish 127.0.0.1::8080");
    expect(gatewayText).toContain("--cap-drop ALL");
    expect(gatewayText).toContain("--read-only");
    expect(gatewayText).not.toContain("docker.sock");
    const guardText = guard.args.join(" ");
    expect(guardText).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(guardText).toContain("--group-add 999");
    expect(guardText).not.toContain("--publish");
    // The guard hands sandboxes the gateway's address on the sandbox network as their name server.
    const policy = JSON.parse(guard.environment.ROVARA_SOCK_POLICY!) as { dns: string[]; network: string; image: string; owner: string };
    expect(policy).toMatchObject({ network: `rovara-snet-${hash}`, image: "worker:test", owner: hash });
    expect(policy.dns).toEqual([gateway.networks.get(`rovara-snet-${hash}`)]);
    expect(docker.containers.get(handle.machineId)!.args).toContain(gateway.networks.get(`rovara-wnet-${hash}`));
    // The gateway's list is the default list plus the owner's.
    const config = JSON.parse(gateway.environment.ROVARA_GW_CONFIG!) as { allowed: string[]; callback: { workspaceId: string; hostHeader: string } };
    expect(config.allowed).toContain("api.anthropic.com");
    expect(config.callback.workspaceId).toBe(workspaceIdFor(COMPANY, "ws-walls"));
    expect(config.callback.hostHeader).toBe("host.docker.internal:1234");
  });

  it("refuses to start, and leaves nothing behind, when a network cannot be made or an existing one is not as it should be", async () => {
    const docker = new FakeDocker();
    docker.failNetworkCreate = "could not find an available, non-overlapping IPv4 address pool among the defaults";
    const { machines } = await build({ docker });
    await expect(machines.start({ machineKey: "ws-pool", companyId: COMPANY })).rejects.toThrow(/network address ranges/);
    expect(docker.containers.size).toBe(0);

    // A network of the right name that is an ordinary bridge (a host address, not internal) is not trusted: it is replaced.
    const other = new FakeDocker();
    const { machines: second } = await build({ docker: other });
    const first = await second.start({ machineKey: "ws-trust", companyId: COMPANY });
    const hash = first.machineId.slice("rovara-worker-".length);
    await second.terminate(first.machineId);
    other.networks.set(`rovara-wnet-${hash}`, { name: `rovara-wnet-${hash}`, internal: false, options: {}, subnet: "172.99.0.0/16", labels: {} });
    await second.start({ machineKey: "ws-trust", companyId: COMPANY });
    expect(other.networks.get(`rovara-wnet-${hash}`)).toMatchObject({ internal: true, options: { "com.docker.network.bridge.inhibit_ipv4": "true" } });
  });

  it("removes the whole machine when its start fails halfway, so a retry starts clean", async () => {
    const docker = new FakeDocker();
    const { machines } = await build({ docker });
    const realRun = docker.run.bind(docker);
    docker.run = async (args) => (args[0] === "start" && args.some((entry) => entry.startsWith("rovara-sock-")) ? { exitCode: 1, stdout: "", stderr: "boom" } : realRun(args));
    await expect(machines.start({ machineKey: "ws-half", companyId: COMPANY })).rejects.toMatchObject({ code: "unavailable" });
    expect(docker.containers.size).toBe(0);
    docker.run = realRun;
    await machines.start({ machineKey: "ws-half", companyId: COMPANY });
    expect(docker.containers.size).toBe(3);
  });

  it("does not let a spec override the names the worker sets itself (no local shell, no other key or workspace)", async () => {
    const { machines } = await build();
    for (const name of ["AGENTX_TASK_SHELL", "AGENTX_INVOKE_PUBLIC_KEY", "AGENTX_WORKSPACE_ID", "AGENTX_RUNTIME", "PORT"]) {
      await expect(machines.start({ machineKey: "ws-env", companyId: COMPANY, environment: { [name]: "x" } })).rejects.toMatchObject({ code: "rejected" });
    }
    await expect(machines.start({ machineKey: "ws-env", companyId: COMPANY, environment: { OK: "line\nINJECTED=1" } })).rejects.toMatchObject({ code: "rejected" });
    await expect(machines.start({ machineKey: "ws-env", companyId: COMPANY, environment: { "BAD NAME": "x" } })).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses keys, companies and images that could climb out of the folder or add Docker flags", async () => {
    const { machines } = await build();
    await expect(machines.start({ machineKey: "../escape", companyId: COMPANY })).rejects.toMatchObject({ code: "rejected" });
    await expect(machines.start({ machineKey: "ok", companyId: "bad company" })).rejects.toMatchObject({ code: "rejected" });
    await expect(machines.start({ machineKey: "ok", companyId: COMPANY, image: "--privileged" })).rejects.toMatchObject({ code: "rejected" });
    await expect(machines.start({ machineKey: "ok", companyId: COMPANY, image: "missing:image" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("accepts a token only for its own workspace, and refuses a job for another one before the worker sees it", async () => {
    const { machines } = await build();
    const { machineId } = await machines.start({ machineKey: "ws-a", companyId: COMPANY });
    expect((await machines.health(machineId)).state).toBe("ready");
    await expect(machines.deliver(machineId, invocationFor(workspaceIdFor(COMPANY, "ws-other"), randomUUID()))).rejects.toMatchObject({ code: "rejected" });
    const receipt = await machines.deliver(machineId, invocationFor(workspaceIdFor(COMPANY, "ws-a"), randomUUID()));
    expect(receipt).toEqual({ duplicate: false });
  });

  it("maps a worker that refuses the signature to unauthorized", async () => {
    const docker = new FakeDocker();
    const { machines } = await build({ docker });
    const { machineId } = await machines.start({ machineKey: "ws-b", companyId: COMPANY });
    // Another process's key: the machine was booted with a different public key.
    const other = new DockerWorkerMachines({ image: "worker:test", stateDirectory: "/unused", callback: () => ({ tcpPort: 1 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch });
    await expect(other.deliver(machineId, invocationFor(workspaceIdFor(COMPANY, "ws-b"), randomUUID()))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("keeps two companies' machines with the same key apart, and uses a key that is a UUID as the workspace id", async () => {
    const { machines } = await build();
    const one = await machines.start({ machineKey: "same", companyId: COMPANY });
    const two = await machines.start({ machineKey: "same", companyId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(one.machineId).not.toBe(two.machineId);
    const uuid = randomUUID();
    expect(workspaceIdFor(COMPANY, uuid)).toBe(uuid);
    expect(workspaceIdFor(COMPANY, "x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("stays at its limit of running machines and says so", async () => {
    const { machines } = await build({ maxConcurrentMachines: 1 });
    await machines.start({ machineKey: "first", companyId: COMPANY });
    await expect(machines.start({ machineKey: "second", companyId: COMPANY })).rejects.toBeInstanceOf(MachineError);
  });

  it("reports a worker that has not answered yet as starting, then unhealthy after the grace time", async () => {
    const docker = new FakeDocker();
    let now = Date.now();
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-l4-"));
    cleanup.push(stateDirectory);
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, now: () => now, startupGraceMs: 1_000 });
    docker.silent = true;
    const { machineId } = await machines.start({ machineKey: "slow", companyId: COMPANY });
    expect((await machines.health(machineId)).state).toBe("starting");
    now += 5_000;
    expect(await machines.health(machineId)).toMatchObject({ state: "unhealthy", detail: "the worker does not answer" });
  });

  it("calls a worker that exited with an error unhealthy, and one that was stopped stopped", async () => {
    const { machines, docker } = await build();
    const { machineId } = await machines.start({ machineKey: "crash", companyId: COMPANY });
    const container = docker.containers.get(machineId)!;
    container.status = "exited";
    container.exitCode = 1;
    expect(await machines.health(machineId)).toMatchObject({ state: "unhealthy" });
    container.exitCode = 143;
    expect((await machines.health(machineId)).state).toBe("stopped");
  });

  it("answers Docker being down with unhealthy for health and unavailable for start", async () => {
    const { machines, docker } = await build();
    const { machineId } = await machines.start({ machineKey: "down", companyId: COMPANY });
    docker.reachable = false;
    expect((await machines.health(machineId)).state).toBe("unhealthy");
    await expect(machines.start({ machineKey: "another", companyId: COMPANY })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("removes the workspace folder only when the container is gone, and never touches an id that is not ours", async () => {
    const { machines, docker, stateDirectory } = await build();
    const { machineId } = await machines.start({ machineKey: "gone", companyId: COMPANY });
    const folder = join(stateDirectory, "workspaces", machineId.slice("rovara-worker-".length));
    expect(existsSync(folder)).toBe(true);
    await machines.terminate("../../../etc");
    await machines.terminate("rovara-worker-../..");
    expect(existsSync(stateDirectory)).toBe(true);
    await machines.terminate(machineId);
    expect(existsSync(folder)).toBe(false);
    expect(docker.containers.has(machineId)).toBe(false);
  });

  it("stops every running worker and keeps the workspaces", async () => {
    const { machines, docker, stateDirectory } = await build();
    const { machineId } = await machines.start({ machineKey: "bye", companyId: COMPANY });
    expect(await machines.stopAll()).toBe(1);
    expect(docker.containers.get(machineId)!.status).toBe("exited");
    expect(readdirSync(join(stateDirectory, "workspaces"))).toContain(machineId.slice("rovara-worker-".length));
  });

  it("re-creates a stopped worker whose broker address changed, with a new session generation, and keeps its workspace", async () => {
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner(); // the key is kept in the state folder, so a restart has the same one
    const first = await build({ docker, signer, callbackPort: 1111 });
    const { machineId } = await first.machines.start({ machineKey: "ws-port", companyId: COMPANY });
    const before = docker.containers.get(machineId)!;
    const generation = before.labels["rovara.local.generation"];
    await first.machines.stop(machineId);
    const folder = join(first.stateDirectory, "workspaces", machineId.slice("rovara-worker-".length));
    expect(existsSync(folder)).toBe(true);

    // `rovara up` restarted on another port.
    const second = await build({ docker, signer, stateDirectory: first.stateDirectory, callbackPort: 2222 });
    const again = await second.machines.start({ machineKey: "ws-port", companyId: COMPANY });
    expect(again.machineId).toBe(machineId);
    const after = docker.containers.get(machineId)!;
    expect(after).not.toBe(before);
    const gatewayAfter = JSON.parse(docker.containers.get(`rovara-gw-${machineId.slice("rovara-worker-".length)}`)!.environment.ROVARA_GW_CONFIG!) as { callback: { hostHeader: string } };
    expect(gatewayAfter.callback.hostHeader).toBe("host.docker.internal:2222");
    expect(after.labels["rovara.local.generation"]).not.toBe(generation);
    expect(existsSync(folder)).toBe(true);
    // Unchanged address: the same container is woken, not replaced.
    await second.machines.stop(machineId);
    const third = await build({ docker, signer, stateDirectory: first.stateDirectory, callbackPort: 2222 });
    await third.machines.start({ machineKey: "ws-port", companyId: COMPANY });
    expect(docker.containers.get(machineId)).toBe(after);
  });

  it("refuses a token for an earlier container of the same machine (a new generation)", async () => {
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner();
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-l4-"));
    cleanup.push(stateDirectory);
    const make = (port: number) => new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: port }), signer, docker, fetch: docker.fetch });
    const old = make(1);
    const { machineId } = await old.start({ machineKey: "ws-gen", companyId: COMPANY });
    const job = invocationFor(workspaceIdFor(COMPANY, "ws-gen"), randomUUID());
    const token = signer.authorization(job, Date.now(), Number(docker.containers.get(machineId)!.labels["rovara.local.generation"]));
    await make(2).start({ machineKey: "ws-gen", companyId: COMPANY });
    // The replacement worker verifies against its own generation.
    const response = await docker.fetch(`http://127.0.0.1:${docker.portOf(machineId)}/invocations`, { method: "POST", headers: { authorization: token }, body: JSON.stringify(job) });
    expect(response.status).toBe(401);
  });

  it("only counts and stops the workers of its own state folder", async () => {
    const docker = new FakeDocker();
    const one = await build({ docker, maxConcurrentMachines: 1 });
    const two = await build({ docker, maxConcurrentMachines: 1 });
    const a = await one.machines.start({ machineKey: "same", companyId: COMPANY });
    const b = await two.machines.start({ machineKey: "same", companyId: COMPANY });
    expect(a.machineId).not.toBe(b.machineId);
    expect(await one.machines.stopAll()).toBe(1);
    expect(docker.containers.get(a.machineId)!.status).toBe("exited");
    expect(docker.containers.get(b.machineId)!.status).toBe("running");
  });

  it("refuses environment names that change how the worker loads code or reaches Docker, and labels that claim another machine's name", async () => {
    const { machines, docker } = await build();
    for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DOCKER_HOST", "PATH", "HOME"]) {
      await expect(machines.start({ machineKey: "ws-deny", companyId: COMPANY, environment: { [name]: "x" } })).rejects.toMatchObject({ code: "rejected" });
    }
    const { machineId } = await machines.start({ machineKey: "ws-label", companyId: COMPANY, labels: { "agentx.workspace": "x", "rovara.local.state": "y", team: "blue" } });
    const create = docker.calls.find((call) => call[0] === "create")!.join(" ");
    expect(create).not.toContain("agentx.workspace=x");
    expect(create).not.toContain("rovara.local.state=y");
    expect(docker.containers.get(machineId)!.labels.team).toBe("blue");
  });

  it("reports an out-of-memory kill as unhealthy, and a container stuck in created as unhealthy after the grace time", async () => {
    const docker = new FakeDocker();
    let now = Date.now();
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-l4-"));
    cleanup.push(stateDirectory);
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, now: () => now, startupGraceMs: 1_000 });
    const { machineId } = await machines.start({ machineKey: "oom", companyId: COMPANY });
    const container = docker.containers.get(machineId)!;
    container.status = "exited";
    container.exitCode = 137;
    container.oomKilled = true;
    expect(await machines.health(machineId)).toMatchObject({ state: "unhealthy", detail: "the worker ran out of memory" });
    container.oomKilled = false;
    container.status = "created";
    container.createdAt = now;
    expect((await machines.health(machineId)).state).toBe("starting");
    now += 5_000;
    expect((await machines.health(machineId)).state).toBe("unhealthy");
  });

  it("keeps the workspace folder when a task sandbox cannot be removed, and does not put Docker's words in health detail", async () => {
    const { machines, docker, stateDirectory } = await build();
    const { machineId } = await machines.start({ machineKey: "ws-sandbox", companyId: COMPANY });
    const folder = join(stateDirectory, "workspaces", machineId.slice("rovara-worker-".length));
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update(folder).digest("hex").slice(0, 16);
    docker.containers.set("abcdef012345", { name: "abcdef012345", kind: "other", args: [], labels: { "agentx.workspace": key, "rovara.local.owner": machineId.slice("rovara-worker-".length) }, environment: {}, networks: new Map(), status: "running", exitCode: 0, oomKilled: false, createdAt: 0, startedAt: 0, hostPort: 0, accepted: new Set() });
    docker.failSandboxRemoval = true;
    await expect(machines.terminate(machineId)).rejects.toMatchObject({ code: "unavailable" });
    expect(existsSync(folder)).toBe(true);
    docker.failSandboxRemoval = false;
    await machines.terminate(machineId);
    expect(existsSync(folder)).toBe(false);
    expect(docker.containers.has("abcdef012345")).toBe(false);
  });

  it("does not replace a running worker that is in the middle of a job", async () => {
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner();
    const first = await build({ docker, signer, callbackPort: 1111 });
    const { machineId } = await first.machines.start({ machineKey: "ws-busy", companyId: COMPANY });
    await first.machines.deliver(machineId, invocationFor(workspaceIdFor(COMPANY, "ws-busy"), randomUUID()));
    const second = await build({ docker, signer, stateDirectory: first.stateDirectory, callbackPort: 2222 });
    await expect(second.machines.start({ machineKey: "ws-busy", companyId: COMPANY })).rejects.toMatchObject({ code: "unavailable" });
    expect(docker.containers.get(machineId)!.status).toBe("running");
  });
});

describe("local docker worker machines and the model proxy (lane L9a)", () => {
  it("tells the worker where the broker's model proxy is, an address and never a key", async () => {
    const { machines, docker } = await build({ modelProxy: true });
    const handle = await machines.start({ machineKey: "ws-proxy", companyId: COMPANY });
    const environment = docker.containers.get(handle.machineId)!.environment;
    expect(environment.AGENTX_MODEL_PROXY_URL).toBe("http://rovara-broker:8081/v1/internal/model-proxy");
    expect(Object.keys(environment).filter((name) => /KEY|SECRET|TOKEN|PASSWORD/iu.test(name))).toEqual(["AGENTX_INVOKE_PUBLIC_KEY"]);
  });

  it("sets no proxy address when the broker serves no proxy, and a spec cannot set or move it", async () => {
    const off = await build();
    const plain = await off.machines.start({ machineKey: "ws-plain", companyId: COMPANY });
    expect(off.docker.containers.get(plain.machineId)!.environment.AGENTX_MODEL_PROXY_URL).toBeUndefined();
    const on = await build({ modelProxy: true });
    await expect(on.machines.start({ machineKey: "ws-move", companyId: COMPANY, environment: { AGENTX_MODEL_PROXY_URL: "http://elsewhere.example.test" } })).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses a model key, a provider's address or cloud credentials in a spec's environment: the worker holds none", async () => {
    const { machines } = await build({ modelProxy: true });
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GEMINI_API_KEY", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_REGION", "HTTPS_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY"]) {
      await expect(machines.start({ machineKey: `ws-${name.toLowerCase().replaceAll("_", "-")}`, companyId: COMPANY, environment: { [name]: "x" } }), name).rejects.toMatchObject({ code: "rejected" });
    }
  });

  it("lets a setup run start: it needs the proxy address the adapter sets, so the run's spend is counted", async () => {
    const { machines, docker } = await build({ modelProxy: true });
    const handle = await machines.start({ machineKey: "ws-setup", companyId: COMPANY });
    const environment = { ...docker.containers.get(handle.machineId)!.environment };
    const invocation = { kind: "task", operationId: "op-setup", projectRevision: 1, payload: { conversationId: "c", setupAgent: { limits: {}, commits: {} } } };
    const run = (env: NodeJS.ProcessEnv) => runSetupAgentInvocation(invocation as never, { rootPath: "/nowhere", model: { provider: "anthropic", modelId: "claude-test" }, eventSink: { async send() {} } as never, setupAgent: async () => ({}), environment: env }, { repositories: [] }, "/nowhere");
    const without = { ...environment };
    delete without.AGENTX_MODEL_PROXY_URL;
    await expect(run(without)).rejects.toThrow(/no model proxy/);
    // With the address the check passes; the run then goes on and fails further in (there is no Docker or repository here), never on the proxy.
    const withProxy: unknown = await run(environment).catch((error: unknown) => error);
    expect(String((withProxy as { message?: unknown }).message)).not.toMatch(/model proxy/);
    const plain = await build();
    const off = await plain.machines.start({ machineKey: "ws-setup-off", companyId: COMPANY });
    await expect(run(plain.docker.containers.get(off.machineId)!.environment)).rejects.toThrow(/no model proxy/);
  });
});
