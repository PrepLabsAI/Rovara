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
import { runWorkerMachinesConformance } from "../support/ports/worker-machines-conformance.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function build(options: { docker?: FakeDocker; maxConcurrentMachines?: number | null; stateDirectory?: string; controlPlaneUrl?: string; signer?: ReturnType<typeof createEphemeralInvokeSigner> } = {}) {
  const stateDirectory = options.stateDirectory ?? (await mkdtemp(join(tmpdir(), "rovara-l4-")));
  cleanup.push(stateDirectory);
  const docker = options.docker ?? new FakeDocker();
  const machines = new DockerWorkerMachines({
    image: "worker:test",
    stateDirectory,
    controlPlaneUrl: options.controlPlaneUrl ?? "http://host.docker.internal:1234",
    signer: options.signer ?? createEphemeralInvokeSigner(),
    docker,
    fetch: docker.fetch,
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
  it("creates the container with the sandbox flags, loopback-only publishing and the environment in a file", async () => {
    const { machines, docker, stateDirectory } = await build();
    const handle = await machines.start({ machineKey: "ws-flags", companyId: COMPANY, resources: { cpu: 2, memoryMiB: 4096 }, environment: { ANTHROPIC_API_KEY: "never-in-arguments" } });
    const create = docker.calls.find((call) => call[0] === "create")!;
    const text = create.join(" ");
    for (const flag of ["--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 4096", "--user 1000:1000", "--publish 127.0.0.1::8080", "--memory 4096m", "--cpus 2", "--group-add 999"]) expect(text).toContain(flag);
    expect(text).not.toContain("--network host");
    expect(text).not.toContain("--privileged");
    expect(text).not.toContain("never-in-arguments");
    expect(create).not.toContain("--env");
    expect(create).not.toContain("--publish-all");
    const workspace = join(stateDirectory, "workspaces", handle.machineId.slice("rovara-worker-".length));
    expect(create).toContain(`${workspace}:${workspace}`);
    expect(create).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(create.filter((entry) => entry === "--volume")).toHaveLength(2);
    const container = docker.containers.get(handle.machineId)!;
    expect(container.environment.ANTHROPIC_API_KEY).toBe("never-in-arguments");
    expect(container.environment.AGENTX_SANDBOX_IMAGE).toBe("worker:test");
    expect(container.environment.AGENTX_TASK_SHELL).toBeUndefined();
    expect(container.environment.AGENTX_CONTROL_PLANE_URL).toBe("http://host.docker.internal:1234");
    // The environment file is gone after the container is created.
    expect(readdirSync(join(stateDirectory, "workspaces")).filter((entry) => entry.startsWith(".env-"))).toEqual([]);
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
    const other = new DockerWorkerMachines({ image: "worker:test", stateDirectory: "/unused", controlPlaneUrl: "x", signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch });
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
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, controlPlaneUrl: "x", signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, now: () => now, startupGraceMs: 1_000 });
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
    const first = await build({ docker, signer, controlPlaneUrl: "http://host.docker.internal:1111" });
    const { machineId } = await first.machines.start({ machineKey: "ws-port", companyId: COMPANY });
    const before = docker.containers.get(machineId)!;
    const generation = before.labels["rovara.local.generation"];
    await first.machines.stop(machineId);
    const folder = join(first.stateDirectory, "workspaces", machineId.slice("rovara-worker-".length));
    expect(existsSync(folder)).toBe(true);

    // `rovara up` restarted on another port.
    const second = await build({ docker, signer, stateDirectory: first.stateDirectory, controlPlaneUrl: "http://host.docker.internal:2222" });
    const again = await second.machines.start({ machineKey: "ws-port", companyId: COMPANY });
    expect(again.machineId).toBe(machineId);
    const after = docker.containers.get(machineId)!;
    expect(after).not.toBe(before);
    expect(after.environment.AGENTX_CONTROL_PLANE_URL).toBe("http://host.docker.internal:2222");
    expect(after.labels["rovara.local.generation"]).not.toBe(generation);
    expect(existsSync(folder)).toBe(true);
    // Unchanged address: the same container is woken, not replaced.
    await second.machines.stop(machineId);
    const third = await build({ docker, signer, stateDirectory: first.stateDirectory, controlPlaneUrl: "http://host.docker.internal:2222" });
    await third.machines.start({ machineKey: "ws-port", companyId: COMPANY });
    expect(docker.containers.get(machineId)).toBe(after);
  });

  it("refuses a token for an earlier container of the same machine (a new generation)", async () => {
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner();
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-l4-"));
    cleanup.push(stateDirectory);
    const make = (url: string) => new DockerWorkerMachines({ image: "worker:test", stateDirectory, controlPlaneUrl: url, signer, docker, fetch: docker.fetch });
    const old = make("http://a");
    const { machineId } = await old.start({ machineKey: "ws-gen", companyId: COMPANY });
    const job = invocationFor(workspaceIdFor(COMPANY, "ws-gen"), randomUUID());
    const token = signer.authorization(job, Date.now(), Number(docker.containers.get(machineId)!.labels["rovara.local.generation"]));
    await make("http://b").start({ machineKey: "ws-gen", companyId: COMPANY });
    // The replacement worker verifies against its own generation.
    const response = await docker.fetch(`http://127.0.0.1:${docker.containers.get(machineId)!.hostPort}/invocations`, { method: "POST", headers: { authorization: token }, body: JSON.stringify(job) });
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
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, controlPlaneUrl: "x", signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, now: () => now, startupGraceMs: 1_000 });
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
    docker.containers.set("abcdef012345", { name: "abcdef012345", args: [], labels: { "agentx.workspace": key }, environment: {}, status: "running", exitCode: 0, oomKilled: false, createdAt: 0, startedAt: 0, hostPort: 0, accepted: new Set() });
    docker.failSandboxRemoval = true;
    await expect(machines.terminate(machineId)).rejects.toMatchObject({ code: "unavailable" });
    expect(existsSync(folder)).toBe(true);
    docker.failSandboxRemoval = false;
    await machines.terminate(machineId);
    expect(existsSync(folder)).toBe(false);
    expect(docker.containers.has("abcdef012345")).toBe(false);
  });
});
