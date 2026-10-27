// A project without a devcontainer runs its commands in a sandbox container without host access; on an EC2 worker the
// worker's own process is never a place a task's commands run, and nothing falls back to it.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectCommand, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { createCheckRunners } from "../../packages/worker/src/verification/checks.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const run = promisify(execFile);
const IMAGE = "registry.example.test/agentx/worker@sha256:" + "b".repeat(64);

/** A fake Docker CLI that records every call and answers like a healthy daemon. */
function fakeDocker() {
  const calls: string[][] = [];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { docker, calls, verbs: (verb: string) => calls.filter((args) => args[0] === verb) };
}

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** An EC2 worker's environment as boot.sh and the worker image set it: marked, no local shell, the sandbox image named. */
function stubEc2Environment(): void {
  vi.stubEnv("AGENTX_RUNTIME", "ec2");
  vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
  vi.stubEnv("AGENTX_TASK_SHELL", "");
  vi.stubEnv("AGENTX_SANDBOX_IMAGE", IMAGE);
}

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-containment-")));
  const source = await mkdtemp(join(tmpdir(), "agentx-containment-source-"));
  cleanup.push(root, source);
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await writeFile(join(source, "README.md"), "# sample\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const definition = ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  });
  await prepareWorkspace({
    rootPath: root, project: definition,
    materializer: async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); },
  });
  return { root, checkout: join(root, "repo/sample") };
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "run the tests" },
  };
}

function adapterOf(inputs: PiSessionInput[], prompt: () => Promise<void> = async () => undefined): PiSessionAdapter {
  return {
    async create(input) {
      inputs.push(input);
      const sessionFile = join(input.sessionDirectory, "session.jsonl");
      await writeFile(sessionFile, "");
      return {
        conversationId: "c", sessionFile,
        prompt, abort: async () => undefined,
        getModel: () => ({ provider: "fixture", modelId: "m" }),
        getSessionStats: () => ({ sessionFile, sessionId: "c", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: () => () => undefined, dispose: () => undefined,
      };
    },
  };
}

const dependencies = (root: string, adapter: PiSessionAdapter, extra: object = {}) => ({
  rootPath: root, model: { provider: "fixture", modelId: "m" }, piAdapter: adapter,
  eventSink: async () => undefined, artifactSink: async () => undefined, ...extra,
});

describe("task code on an EC2 worker without a devcontainer", () => {
  it("never runs a coding session's shell command in the worker process: it goes through docker exec in the sandbox", async () => {
    const { root, checkout } = await workspace();
    stubEc2Environment();
    const fake = fakeDocker();
    const inputs: PiSessionInput[] = [];
    const marker = join(root, "ran-in-the-worker");
    const adapter = adapterOf(inputs, async () => {
      // The coding session was given a shell that is not Pi's local one.
      expect(inputs[0]?.bashOperations).toBeDefined();
      await inputs[0]!.bashOperations!.exec(`touch ${marker}`, checkout, { onData: () => undefined });
    });
    await runTaskInvocation(taskInvocation(), dependencies(root, adapter, { taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE } }));

    expect(fake.verbs("run")).toHaveLength(1);
    expect(fake.verbs("exec").some((args) => args.includes(`touch ${marker}`))).toBe(true);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the local shell even when the caller asks for it, and starts no coding session", async () => {
    const { root } = await workspace();
    stubEc2Environment();
    const inputs: PiSessionInput[] = [];
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, adapterOf(inputs), { taskShell: { kind: "local" } })))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(inputs).toEqual([]);
  });

  it("does not fall back to the worker when the sandbox image is missing", async () => {
    const { root } = await workspace();
    stubEc2Environment();
    vi.stubEnv("AGENTX_SANDBOX_IMAGE", "");
    const inputs: PiSessionInput[] = [];
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, adapterOf(inputs))))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(inputs).toEqual([]);
  });

  it("refuses to run a check command or the agent's replayed command in the worker, and runs nothing", async () => {
    const { root } = await workspace();
    stubEc2Environment();
    const runners = createCheckRunners({ rootPath: root });
    const marker = join(root, "checked-in-the-worker");
    const command: ProjectCommand = { cwd: ".", executable: "touch", args: [marker], timeoutSeconds: 60 };
    await expect(runners.runProjectCommand(command, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(runners.runAgentCommand("npm test", 5_000, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
