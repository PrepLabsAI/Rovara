// a task in a project without a devcontainer runs the agent's shell, the project's setup and readiness
// commands and AgentX's checks in the task sandbox, never as children of the worker.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectCommand, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { agentShellTool, type PiSessionAdapter, type PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { runReadinessChecks } from "../../packages/worker/src/publish.js";
import { createCheckRunners } from "../../packages/worker/src/verification/checks.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";

const run = promisify(execFile);
const IMAGE = "registry.example.test/agentx/worker@sha256:" + "b".repeat(64);
const SANDBOX = { kind: "sandbox" as const, image: IMAGE };

/** A fake Docker CLI that records every call. A `docker exec` answers with `exec(args)`. */
function fakeDocker(exec: (args: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0 })) {
  const calls: string[][] = [];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] === "exec") {
        const answer = exec(args);
        return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
      }
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

function project(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
    ...overrides,
  });
}

async function workspace(definition: ProjectDefinition = project(), options: { docker?: DockerCli } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-task-")));
  const source = await mkdtemp(join(tmpdir(), "agentx-sandbox-source-"));
  cleanup.push(root, source);
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await writeFile(join(source, "README.md"), "# sample\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const materializer = async (_repository: unknown, destination: string) => {
    await run("git", ["clone", "--quiet", source, destination]);
  };
  await prepareWorkspace({ rootPath: root, project: definition, materializer, ...(options.docker === undefined ? {} : { taskShell: { kind: "sandbox" as const, docker: options.docker, image: IMAGE } }) });
  return { root, checkout: join(root, "repo/sample") };
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "run the tests" },
  };
}

/** A pi adapter that records its input and, when `prompt` is given, runs it. */
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

describe("a task in a project without a devcontainer", () => {
  it("gives pi the sandbox's shell, never the local one, and runs the shell's commands with docker exec", async () => {
    const { root, checkout } = await workspace();
    const fake = fakeDocker();
    const inputs: PiSessionInput[] = [];
    const marker = join(root, "ran-locally");
    // The agent runs a command through the shell pi was given, while the task is running.
    const adapter = adapterOf(inputs, async () => {
      expect(inputs[0]?.bashOperations).toBeDefined();
      await inputs[0]!.bashOperations!.exec(`touch ${marker}`, checkout, { onData: () => undefined });
    });
    await runTaskInvocation(taskInvocation(), dependencies(root, adapter, { taskShell: { ...SANDBOX, docker: fake.docker } }));

    expect(fake.verbs("exec").some((args) => args.includes(`touch ${marker}`))).toBe(true);
    // The command went to Docker, not to a child of this process.
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts exactly one sandbox with the sandbox arguments and without the socket, the host network or privileges", async () => {
    const { root } = await workspace();
    const fake = fakeDocker();
    await runTaskInvocation(taskInvocation(), dependencies(root, adapterOf([]), { taskShell: { ...SANDBOX, docker: fake.docker } }));

    const runs = fake.verbs("run");
    expect(runs).toHaveLength(1);
    const args = runs[0]!;
    const joined = args.join(" ");
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--network", "agentx-task", IMAGE]));
    expect(args[args.indexOf("--volume") + 1]).toBe(`${root}:${root}`);
    expect(joined).not.toMatch(/docker\.sock|--privileged|--network[ =]host|--pid(?!s-limit)|--cap-add/u);
  });

  it("labels the sandbox with the operation and removes it when the task ends", async () => {
    const { root } = await workspace();
    const fake = fakeDocker();
    const invocation = taskInvocation();
    await runTaskInvocation(invocation, dependencies(root, adapterOf([]), { taskShell: { ...SANDBOX, docker: fake.docker } }));
    const started = fake.verbs("run")[0]!;
    expect(started[started.indexOf("--label") + 1]).toBe(`agentx.task=${invocation.operationId}`);
    const name = started[started.indexOf("--name") + 1]!;
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", name]);
  });

  it("removes the sandbox when the task fails", async () => {
    const { root } = await workspace();
    const fake = fakeDocker();
    const failing: PiSessionAdapter = { create: async () => { throw new Error("pi could not start"); } };
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, failing, { taskShell: { ...SANDBOX, docker: fake.docker } }))).rejects.toThrow("pi could not start");
    const name = fake.verbs("run")[0]![fake.verbs("run")[0]!.indexOf("--name") + 1]!;
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", name]);
  });

  it("removes the sandbox when the model turn fails", async () => {
    const { root } = await workspace();
    const fake = fakeDocker();
    const inputs: PiSessionInput[] = [];
    const adapter = adapterOf(inputs, async () => { throw new Error("the model turn failed"); });
    await runTaskInvocation(taskInvocation(), dependencies(root, adapter, { taskShell: { ...SANDBOX, docker: fake.docker } })).catch(() => undefined);
    const name = fake.verbs("run")[0]![fake.verbs("run")[0]!.indexOf("--name") + 1]!;
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", name]);
  });

  it("does not start the task when the sandbox cannot start, and does not fall back to the local shell", async () => {
    const { root } = await workspace();
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: async (args) => {
        calls.push([...args]);
        return args[0] === "run" ? { exitCode: 125, stdout: "", stderr: "pull access denied" } : { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const inputs: PiSessionInput[] = [];
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, adapterOf(inputs), { taskShell: { ...SANDBOX, docker } })))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("pull access denied") as unknown });
    expect(inputs).toEqual([]);
  });

  it("on the EC2 runtime selects the sandbox from the environment, and refuses to start without its image", async () => {
    const { root } = await workspace();
    // An EC2 worker's environment: marked, no local shell, no sandbox image.
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    vi.stubEnv("AGENTX_SANDBOX_IMAGE", "");
    const inputs: PiSessionInput[] = [];
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, adapterOf(inputs))))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("task sandbox image") as unknown });
    expect(inputs).toEqual([]);
  });

  it("uses the sandbox when nothing says otherwise: no EC2 marker and no variable is not a reason to run locally", async () => {
    const { root } = await workspace();
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "");
    vi.stubEnv("AGENTX_RUNTIME", "");
    vi.stubEnv("AGENTX_SANDBOX_IMAGE", "");
    const inputs: PiSessionInput[] = [];
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, adapterOf(inputs))))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("task sandbox image") as unknown });
    expect(inputs).toEqual([]);
  });

  it("runs the local shell when the caller chose it explicitly, with the environment silent", async () => {
    const { root, checkout } = await workspace();
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    const marker = join(checkout, "ran-in-test");
    const inputs: PiSessionInput[] = [];
    const adapter = adapterOf(inputs, async () => {
      await inputs[0]!.bashOperations!.exec(`touch ${marker}`, checkout, { onData: () => undefined });
    });
    await runTaskInvocation(taskInvocation(), dependencies(root, adapter, { taskShell: { kind: "local" } }));
    await expect(stat(marker)).resolves.toBeDefined();
  });

  it("on the EC2 runtime refuses an explicit request for the local shell", async () => {
    const { root } = await workspace();
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
    await expect(runTaskInvocation(taskInvocation(), dependencies(root, adapterOf([]), { taskShell: { kind: "local" } })))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("AgentX's checks in a project without a devcontainer", () => {
  const command = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: ".", executable, args, timeoutSeconds: 60 });

  it("replay the agent's test command and run project commands through the sandbox's docker exec", async () => {
    const { root } = await workspace();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: "t", docker: fake.docker, image: IMAGE });
    const runners = createCheckRunners({ rootPath: root, sandbox });
    const marker = join(root, "checked-locally");

    const project = await runners.runProjectCommand(command("touch", [marker]), new AbortController().signal);
    expect(project.exitCode).toBe(0);
    expect(fake.verbs("exec").length).toBeGreaterThan(0);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const test = await runners.runAgentCommand("npm test", 5_000, new AbortController().signal);
    expect(test.exitCode).toBe(0);
    expect(fake.verbs("exec").some((args) => args.some((arg) => arg === "npm test"))).toBe(true);
  });

  it("refuse to run a command locally when nothing asked for the local shell, and run nothing", async () => {
    const { root } = await workspace();
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    const runners = createCheckRunners({ rootPath: root });
    const marker = join(root, "checked-locally");
    await expect(runners.runProjectCommand(command("touch", [marker]), new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(runners.runAgentCommand("npm test", 5_000, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Told to use it, the same call runs.
    const local = createCheckRunners({ rootPath: root, local: true });
    await expect(local.runProjectCommand(command("touch", [marker]), new AbortController().signal)).resolves.toMatchObject({ exitCode: 0 });
    await expect(stat(marker)).resolves.toBeDefined();
  });

  it("on the EC2 runtime refuse to run a command locally, and run nothing", async () => {
    const { root } = await workspace();
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
    const runners = createCheckRunners({ rootPath: root });
    const marker = join(root, "checked-locally");
    await expect(runners.runProjectCommand(command("touch", [marker]), new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(runners.runAgentCommand("npm test", 5_000, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the agent's shell tool", () => {
  it("on the EC2 runtime refuses the local shell, so a missing sandbox cannot silently run a command in the worker", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-shell-")));
    cleanup.push(cwd);
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
    const marker = join(cwd, "ran");
    const shell = agentShellTool(cwd) as unknown as { execute: (id: string, params: { command: string }) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> };
    const result = await shell.execute("t", { command: `touch ${marker}` }).catch((error: unknown) => ({ isError: true, content: [{ text: String(error) }] }));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("task sandbox");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the local shell when nothing asked for it, not only on EC2", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-shell-")));
    cleanup.push(cwd);
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    const marker = join(cwd, "ran");
    const shell = agentShellTool(cwd) as unknown as { execute: (id: string, params: { command: string }) => Promise<{ isError?: boolean }> };
    const result = await shell.execute("t", { command: `touch ${marker}` }).catch(() => ({ isError: true }));
    expect(result.isError).toBe(true);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("with AGENTX_TASK_SHELL=local runs a command locally, for tests and a developer's machine", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-shell-")));
    cleanup.push(cwd);
    const shell = agentShellTool(cwd) as unknown as { execute: (id: string, params: { command: string }) => Promise<{ structuredContent?: { exit_code?: number } }> };
    const result = await shell.execute("t", { command: "echo hi > out.txt" });
    expect(result.structuredContent?.exit_code ?? 0).toBe(0);
    expect(await readFile(join(cwd, "out.txt"), "utf8")).toBe("hi\n");
  });
});

describe("readiness checks at publication", () => {
  it("run in the sandbox, which is removed afterwards", async () => {
    const { root, checkout } = await workspace();
    const fake = fakeDocker();
    const marker = join(checkout, "ready-locally");
    const manifest = JSON.parse(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8")) as Parameters<typeof runReadinessChecks>[2];
    const invocation = { operationId: randomUUID(), payload: { project: project({ readiness: [{ cwd: "repo/sample", executable: "touch", args: [marker], timeoutSeconds: 60 }] }) } } as unknown as Parameters<typeof runReadinessChecks>[1];
    const results = await runReadinessChecks(root, invocation, manifest, { taskShell: { ...SANDBOX, docker: fake.docker } });
    expect(results.map((entry) => entry.outcome)).toEqual(["passed"]);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fake.verbs("run")).toHaveLength(1);
    expect(fake.verbs("rm").length).toBeGreaterThan(0);
  });
});

describe("preparing a workspace in a project without a devcontainer", () => {
  it("runs setup and readiness commands in the sandbox and removes it afterwards", async () => {
    const marker = join(tmpdir(), `agentx-prepare-marker-${randomUUID()}`);
    cleanup.push(marker);
    const fake = fakeDocker();
    await workspace(project({
      setup: [{ cwd: "repo/sample", executable: "touch", args: [marker], timeoutSeconds: 60 }],
      readiness: [{ cwd: "repo/sample", executable: "true", args: [], timeoutSeconds: 60 }],
    }), { docker: fake.docker });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fake.verbs("run")).toHaveLength(1);
    const execs = fake.verbs("exec").flat();
    expect(execs).toContain(marker);
    expect(fake.verbs("rm").length).toBeGreaterThan(0);
  });

  it("starts no sandbox when the project has no commands", async () => {
    const fake = fakeDocker();
    await workspace(project(), { docker: fake.docker });
    expect(fake.calls).toEqual([]);
  });

  it("on the EC2 runtime refuses to run a project's setup command locally", async () => {
    // An EC2 worker's environment: marked, no local shell, no sandbox image.
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    vi.stubEnv("AGENTX_SANDBOX_IMAGE", "");
    await expect(workspace(project({ setup: [{ cwd: "repo/sample", executable: "true", args: [], timeoutSeconds: 60 }] })))
      .rejects.toThrow(/task sandbox image/u);
  });
});
