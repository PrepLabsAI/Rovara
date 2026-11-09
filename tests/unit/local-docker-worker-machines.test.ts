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

async function build(options: { docker?: FakeDocker; maxConcurrentMachines?: number | null } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-l4-"));
  cleanup.push(stateDirectory);
  const docker = options.docker ?? new FakeDocker();
  const machines = new DockerWorkerMachines({
    image: "worker:test",
    stateDirectory,
    controlPlaneUrl: "http://host.docker.internal:1234",
    signer: createEphemeralInvokeSigner(),
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
});
