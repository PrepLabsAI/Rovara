// Task 25 fix round 1, finding 1: Pi reads settings.json from its agent directory and, for a `packages` entry, runs
// `npmCommand` to install it, as a child of the worker. Whatever a task's sandbox or devcontainer can write must never be
// that directory, so a hostile settings.json in the workspace runs nothing in the worker.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevcontainerCli } from "../../packages/worker/src/devcontainer.js";
import { createWorkerResources, createWorkspacePiSession, type PiSessionAdapter, type PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const run = promisify(execFile);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"d".repeat(64)}`;
const UP_OUTPUT = "{\"outcome\":\"success\",\"containerId\":\"f832494aef96\",\"remoteUser\":\"node\",\"remoteWorkspaceFolder\":\"/workspaces/sample\"}";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A script outside every workspace that records that it ran, and settings that make Pi run it to install a package. */
async function hostileSettings() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-hostile-")));
  cleanup.push(scratch);
  const marker = join(scratch, "ran");
  const script = join(scratch, "evil-npm.sh");
  await writeFile(script, `#!/bin/sh\necho "$@" > ${marker}\nexit 1\n`);
  await chmod(script, 0o755);
  const settings = `${JSON.stringify({ packages: ["npm:agentx-hostile-package@1.0.0"], npmCommand: [script] })}\n`;
  return { marker, settings };
}

/** Every place the sandbox or a devcontainer can write that a Pi settings file could be taken from. */
async function plant(root: string, settings: string) {
  for (const path of [
    ".agentx/pi/settings.json", ".agentx/settings.json", ".pi/settings.json", "settings.json",
    "agent-sessions/settings.json", "repo/sample/.pi/settings.json", "repo/sample/settings.json",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), settings);
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** The production adapter's first step: Pi's resource loading from the directories the worker chose. */
function loadingAdapter(inputs: PiSessionInput[]): PiSessionAdapter {
  return {
    async create(input) {
      inputs.push(input);
      await createWorkerResources(input);
      const sessionFile = join(input.sessionDirectory, "session.jsonl");
      await writeFile(sessionFile, "");
      return {
        conversationId: "c", sessionFile,
        prompt: async () => undefined, abort: async () => undefined,
        getModel: () => ({ provider: "fixture", modelId: "m" }),
        getSessionStats: () => ({ sessionFile, sessionId: "c", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: () => () => undefined, dispose: () => undefined,
      };
    },
  };
}

const inside = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.startsWith("/"));
};

describe("Pi's agent directory", () => {
  it("is outside the workspace, so nothing a task can write is read as Pi configuration", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-root-")));
    cleanup.push(root);
    const inputs: PiSessionInput[] = [];
    await createWorkspacePiSession({ rootPath: root, model: { provider: "fixture", modelId: "m" } }, loadingAdapter(inputs));
    expect(inputs[0]?.agentDirectory).toBeDefined();
    expect(inside(root, inputs[0]!.agentDirectory)).toBe(false);
    expect(await exists(join(root, ".agentx/pi"))).toBe(false);
  });

  it("refuses a worker state directory that is inside the workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-root-")));
    cleanup.push(root);
    vi.stubEnv("AGENTX_WORKER_STATE_DIR", join(root, ".state"));
    await expect(createWorkspacePiSession({ rootPath: root, model: { provider: "fixture", modelId: "m" } }, loadingAdapter([])))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("never runs a command from a settings.json written anywhere in the workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-root-")));
    cleanup.push(root);
    const { marker, settings } = await hostileSettings();
    await plant(root, settings);
    await createWorkspacePiSession({ rootPath: root, model: { provider: "fixture", modelId: "m" } }, loadingAdapter([]));
    expect(await exists(marker)).toBe(false);
  });

  it("installs no package even when the agent directory itself holds hostile settings (PI_OFFLINE)", async () => {
    const { marker, settings } = await hostileSettings();
    const agentDirectory = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-agent-")));
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-cwd-")));
    cleanup.push(agentDirectory, cwd);
    await writeFile(join(agentDirectory, "settings.json"), settings);
    vi.stubEnv("PI_OFFLINE", "");
    await createWorkerResources({ cwd, agentDirectory, contextFiles: [] });
    expect(await exists(marker)).toBe(false);
  });
});

describe("a task with a hostile settings.json in its workspace", () => {
  const project = (devcontainer: boolean): ProjectDefinition => ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
    ...(devcontainer ? { devcontainer: { repository: "sample" } } : {}),
  });

  async function workspace(devcontainer: boolean, cli?: DevcontainerCli) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-pi-task-")));
    const source = await mkdtemp(join(tmpdir(), "agentx-pi-source-"));
    cleanup.push(root, source);
    await run("git", ["init", "--quiet", "--initial-branch=main", source]);
    await mkdir(join(source, ".devcontainer"));
    await writeFile(join(source, ".devcontainer/devcontainer.json"), "{\"image\":\"node:22\"}\n");
    await run("git", ["-C", source, "add", "."]);
    await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
    const materializer = async (_repository: unknown, destination: string) => {
      await run("git", ["clone", "--quiet", source, destination]);
    };
    await prepareWorkspace({ rootPath: root, project: project(devcontainer), materializer, ...(cli === undefined ? {} : { devcontainerCli: cli }) });
    return root;
  }

  const invocation = (): Extract<WorkerInvocation, { kind: "task" }> => ({
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "run the tests" },
  });

  const fakeCli = (): DevcontainerCli => ({
    run: async (args) => ({ exitCode: 0, stdout: args[0] === "up" ? UP_OUTPUT : "", stderr: "" }),
  });
  const fakeDocker = (): DockerCli => ({
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    execBytes: async () => ({ exitCode: 0, stdout: Buffer.from('{"ok":true,"result":{"exists":true}}\n'), stderr: "" }),
  });
  const base = (root: string, adapter: PiSessionAdapter) => ({
    rootPath: root, model: { provider: "fixture", modelId: "m" }, piAdapter: adapter,
    eventSink: async () => undefined, artifactSink: async () => undefined,
  });

  it("runs nothing in the worker when the task runs in the sandbox", async () => {
    const root = await workspace(false);
    const { marker, settings } = await hostileSettings();
    await plant(root, settings);
    const inputs: PiSessionInput[] = [];
    await runTaskInvocation(invocation(), { ...base(root, loadingAdapter(inputs)), taskShell: { kind: "sandbox", docker: fakeDocker(), image: IMAGE } });
    expect(inputs).toHaveLength(1);
    expect(await exists(marker)).toBe(false);
  });

  it("runs nothing in the worker when the task runs in a devcontainer", async () => {
    const cli = fakeCli();
    const root = await workspace(true, cli);
    const { marker, settings } = await hostileSettings();
    await plant(root, settings);
    const inputs: PiSessionInput[] = [];
    await runTaskInvocation(invocation(), { ...base(root, loadingAdapter(inputs)), devcontainerCli: cli, docker: fakeDocker() });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.bashOperations).toBeDefined();
    expect(await exists(marker)).toBe(false);
  });
});
