// Lane L4b: a worker started by `rovara up` is told which network its sandboxes join (AGENTX_SANDBOX_NETWORK). That network is made and
// walled by the starter; the worker must not make, inspect, replace or fall back to the shared `agentx-task` bridge.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_SANDBOX_NETWORK, TaskSandbox, sandboxNetworkFromEnvironment, taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const IMAGE = "worker:test";
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";

describe("the sandbox network a starter names (AGENTX_SANDBOX_NETWORK)", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads a plain network name, ignores an unset or empty one, and refuses one that could be a docker option", () => {
    expect(sandboxNetworkFromEnvironment({})).toBeUndefined();
    expect(sandboxNetworkFromEnvironment({ AGENTX_SANDBOX_NETWORK: "" })).toBeUndefined();
    expect(sandboxNetworkFromEnvironment({ AGENTX_SANDBOX_NETWORK: "rovara-snet-0123" })).toBe("rovara-snet-0123");
    for (const bad of ["--privileged", "-x", "a b", "a/b", "a\nb", ".hidden", "x".repeat(129)]) {
      expect(() => sandboxNetworkFromEnvironment({ AGENTX_SANDBOX_NETWORK: bad }), bad).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
  });

  it("puts the sandbox on that network and nothing else, and defaults to the shared bridge", () => {
    const base = { name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] };
    const own = taskSandboxRunArgs({ ...base, sharedNetwork: "rovara-snet-0123" });
    expect(own[own.indexOf("--network") + 1]).toBe("rovara-snet-0123");
    expect(own.filter((entry) => entry === "--network")).toHaveLength(1);
    const shared = taskSandboxRunArgs(base);
    expect(shared[shared.indexOf("--network") + 1]).toBe(TASK_SANDBOX_NETWORK);
  });

  it("starts the sandbox without making, inspecting or removing any network", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-net-")));
    cleanup.push(root);
    const calls: string[][] = [];
    const docker: DockerCli = { run: async (args) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE, environment: { AGENTX_SANDBOX_NETWORK: "rovara-snet-0123" } }).start();
    expect(calls.filter((call) => call[0] === "network")).toEqual([]);
    const run = calls.find((call) => call[0] === "run")!;
    expect(run[run.indexOf("--network") + 1]).toBe("rovara-snet-0123");
  });

  it("is the shared bridge, made on demand, when no network is named", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-net-")));
    cleanup.push(root);
    const calls: string[][] = [];
    const docker: DockerCli = { run: async (args) => { calls.push([...args]); return { exitCode: args[0] === "network" && args[1] === "inspect" ? 1 : 0, stdout: "", stderr: "" }; } };
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE, environment: {} }).start();
    expect(calls).toContainEqual(["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK]);
  });
});
