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

async function build(options: { docker?: FakeDocker; maxConcurrentMachines?: number | null; stateDirectory?: string; callbackPort?: number; signer?: ReturnType<typeof createEphemeralInvokeSigner>; modelProxy?: boolean; piMcp?: boolean } = {}) {
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
    ...(options.piMcp === undefined ? {} : { piMcp: options.piMcp }),
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

  it("passes a steer or peek answer on, bounded: an oversized or non-object answer reads as none, and a job's answer is never passed on", async () => {
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner();
    const real = docker.fetch;
    const answer: { body: string } = { body: JSON.stringify({ accepted: true, outcome: "steered" }) };
    const first = await build({ docker, signer });
    const machines = new DockerWorkerMachines({
      image: "worker:test", stateDirectory: first.stateDirectory, callback: () => ({ tcpPort: 1234 }), signer, docker,
      fetch: (async (url: string, init?: RequestInit) => (url.endsWith("/invocations") ? new Response(answer.body, { status: 200 }) : real(url, init))) as typeof fetch,
    });
    const { machineId } = await machines.start({ machineKey: "ws-a", companyId: COMPANY });
    await machines.health(machineId);
    const workspaceId = workspaceIdFor(COMPANY, "ws-a");
    const steer = WorkerInvocationSchema.parse({
      protocolVersion: AGENTX_PROTOCOL_VERSION, kind: "steer", operationId: randomUUID(), workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(48),
      payload: { targetOperationId: randomUUID(), messageId: `msg_${"1".repeat(20)}`, step: "PLAN", authority: "owner_instruction", sender: "person p_abcdef", text: "hi" },
    });
    expect(await machines.deliver(machineId, steer)).toEqual({ duplicate: false, answer: { accepted: true, outcome: "steered" } });
    answer.body = `{"accepted":true,"pad":"${"x".repeat(1_100_000)}"}`;
    expect(await machines.deliver(machineId, steer)).toEqual({ duplicate: false, answer: {} });
    answer.body = "[1,2]";
    expect(await machines.deliver(machineId, steer)).toEqual({ duplicate: false, answer: {} });
    // A job's answer is its receipt only.
    answer.body = JSON.stringify({ accepted: true, duplicate: true, secret: "no" });
    expect(await machines.deliver(machineId, invocationFor(workspaceId, randomUUID()))).toEqual({ duplicate: true });
  });

  it("maps a worker that refuses the signature to unauthorized", async () => {
    const docker = new FakeDocker();
    const { machines } = await build({ docker });
    const { machineId } = await machines.start({ machineKey: "ws-b", companyId: COMPANY });
    // Another process's key: the machine was booted with a different public key.
    const other = new DockerWorkerMachines({ image: "worker:test", stateDirectory: "/unused", callback: () => ({ tcpPort: 1 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch });
    await expect(other.deliver(machineId, invocationFor(workspaceIdFor(COMPANY, "ws-b"), randomUUID()))).rejects.toMatchObject({ code: "unauthorized" });
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
