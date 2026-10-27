// On an EC2 worker the agent's file tools for a devcontainer project run inside the dev container (through the file-tool
// helper, sandbox-file-ops.ts), never in the worker, and the worker's own folders of the workspace are hidden from the dev
// container. A fake Docker answers as the helper would, so these tests see which calls the tools make, and prove that no
// file tool touches the worker's own filesystem. Nothing here starts a real container.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDevcontainer, type DevcontainerCli, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";
import { FILE_TOOLS_NEED_SANDBOX_MESSAGE, createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { runFileOp, type SandboxFileRequest } from "../../packages/worker/src/sandbox-file-ops.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const run = promisify(execFile);
const UP_OUTPUT = [
  "{\"type\":\"text\",\"level\":2,\"text\":\"Resolving Remote\"}",
  "{\"outcome\":\"success\",\"containerId\":\"f832494aef96\",\"remoteUser\":\"node\",\"remoteWorkspaceFolder\":\"/workspaces/sample\"}",
].join("\n");
const CONTAINER_FOLDER = "/workspaces/sample";
const IMAGE = "registry.example.test/agentx/worker@sha256:" + "b".repeat(64);
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const lastResult = (context: TranscriptContext) => JSON.parse(JSON.stringify(context.messages.at(-1))) as { toolName: string; isError: boolean; content: Array<{ text: string }> };

const cleanup: string[] = [];
beforeEach(() => { vi.stubEnv("AGENTX_RUNTIME", "ec2"); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function project(): ProjectDefinition {
  return ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [], readiness: [], devcontainer: { repository: "sample" }, orchestratorInstructions: "Delegate all code changes to the remote worker.",
  });
}

function fakeCli(): { cli: DevcontainerCli; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cli: { run: (args) => { calls.push([...args]); return Promise.resolve(args[0] === "up" ? { exitCode: 0, stdout: UP_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }); } },
  };
}

/** A prepared workspace with a devcontainer project, as the worker leaves one, and a private folder standing for the worker's own state. */
async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-dc-tools-")));
  const source = await mkdtemp(join(tmpdir(), "agentx-dc-tools-source-"));
  const state = await realpath(await mkdtemp(join(tmpdir(), "agentx-dc-tools-state-")));
  cleanup.push(root, source, state);
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await mkdir(join(source, ".devcontainer"));
  await writeFile(join(source, ".devcontainer/devcontainer.json"), "{\"image\":\"node:22\"}\n");
  await writeFile(join(source, "notes.txt"), "repository notes\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const materializer = async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); };
  await prepareWorkspace({ rootPath: root, project: project(), materializer, devcontainerCli: fakeCli().cli });
  return { root, state, hostFolder: join(root, "repo/sample") };
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "change the notes" },
  };
}

interface ExecCall { request: SandboxFileRequest; stdin: Buffer | undefined }

/**
 * A fake Docker for the file tools. `exec -i` answers like the helper over an in-memory filesystem of container paths, or,
 * with `hostFolder`, runs the real helper over that folder (the container folder is the host folder), which is Linux-only.
 */
function fakeDocker(options: { hostFolder?: string; nodeFails?: boolean; runFails?: boolean; mountSource?: string } = {}) {
  const files = new Map<string, string>();
  const execs: ExecCall[] = [];
  const runs: string[][] = [];
  const answer = (request: SandboxFileRequest, stdin: Buffer | undefined): unknown => {
    const refuse = (code: string) => ({ ok: false, code, message: code });
    if ("path" in request && !(request.path === request.root || request.path.startsWith(`${request.root}/`))) return refuse("OUTSIDE");
    switch (request.op) {
      case "exists": return { ok: true, result: { exists: "path" in request && files.has(request.path) } };
      case "readFile": { const content = files.get(request.path); return content === undefined ? refuse("ENOENT") : { ok: true, result: { contentBase64: Buffer.from(content).toString("base64") } }; }
      case "writeFile": files.set(request.path, stdin?.toString("utf8") ?? ""); return { ok: true, result: {} };
      case "mkdir": return { ok: true, result: {} };
      case "sweep": return { ok: true, result: { removed: 0 } };
      default: return refuse("ENOENT");
    }
  };
  const docker: DockerCli = {
    async run(args) {
      runs.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] === "inspect") {
        const source = options.mountSource ?? options.hostFolder;
        return { exitCode: 0, stdout: JSON.stringify(source === undefined ? [] : [{ Type: "bind", Source: source, Destination: CONTAINER_FOLDER }]), stderr: "" };
      }
      if (options.runFails === true && args[0] === "run") return { exitCode: 1, stdout: "", stderr: "no" };
      if (options.nodeFails === true && args.includes("--version")) return { exitCode: 127, stdout: "", stderr: "exec format error" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async execBytes(args, bytesOptions) {
      const request = JSON.parse(Buffer.from(args.at(-1)!, "base64url").toString("utf8")) as SandboxFileRequest;
      execs.push({ request, stdin: bytesOptions.stdin });
      if (options.hostFolder === undefined) return { exitCode: 0, stdout: Buffer.from(`${JSON.stringify(answer(request, bytesOptions.stdin))}\n`), stderr: "" };
      // The real helper over the host folder: the container's folder is the host's.
      const translated = JSON.parse(JSON.stringify(request).split(CONTAINER_FOLDER).join(options.hostFolder)) as SandboxFileRequest;
      const input = bytesOptions.stdin === undefined ? undefined : (async function* () { yield bytesOptions.stdin!; })();
      const response = await runFileOp(translated, input);
      return { exitCode: 0, stdout: Buffer.from(`${JSON.stringify(response)}\n`), stderr: "" };
    },
  };
  return { docker, files, execs, runs };
}

/** Runs one task on the worker's real Pi session and the scripted model; `script` returns the model's turns. */
async function runTask(root: string, state: string, docker: DockerCli, script: FauxResponseStep[], extra: object = {}) {
  vi.stubEnv("AGENTX_WORKER_STATE_DIR", state);
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(script);
  const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const progress: string[] = [];
  const outcome = await runTaskInvocation(taskInvocation(), {
    rootPath: root, model: FAUX_MODEL, piAdapter, devcontainerCli: fakeCli().cli, docker,
    eventSink: async (events) => { for (const event of events) if (event.type === "progress") progress.push(String((event.payload as { message?: unknown }).message)); },
    artifactSink: async () => undefined, ...extra,
  }).then(() => undefined, (error: unknown) => error);
  return { outcome, progress };
}

describe("a dev container's file tools, on an EC2 worker", () => {
  it("never write to a path the agent chose outside the repository in the worker; they go through the dev container or are refused", async () => {
    const { root, state, hostFolder } = await workspace();
    const outsideTargets = [join(state, "worker-state.json"), join(root, ".agentx", "extra.json"), join(root, "agent-sessions", "extra.jsonl"), "/home/node/.docker/config.json"];
    const results: Array<ReturnType<typeof lastResult>> = [];
    const turns: FauxResponseStep[] = [
      ...outsideTargets.map((path, index): FauxResponseStep => (context) => {
        if (index > 0) results.push(lastResult(context));
        return toolUse(fauxToolCall("write", { path, content: "planted\n" }, { id: `w${String(index)}` }));
      }),
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("write", { path: `${CONTAINER_FOLDER}/inside.txt`, content: "inside\n" }, { id: "w-in" })); },
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("AgentX result: done"); },
    ];
    const fake = fakeDocker({ mountSource: hostFolder });
    const { outcome } = await runTask(root, state, fake.docker, turns);

    expect(outcome).toBeUndefined();
    // The worker's own files are untouched.
    for (const path of outsideTargets.slice(0, 3)) expect(existsSync(path), path).toBe(false);
    // Whatever reached the container was inside the repository's folder; the four outside paths were refused there.
    const written = fake.execs.filter((call) => call.request.op === "writeFile").map((call) => (call.request as { path: string }).path);
    expect(written.every((path) => path.startsWith(`${CONTAINER_FOLDER}/`))).toBe(true);
    expect(results.slice(0, 4).every((result) => result.isError)).toBe(true);
    // Positive control: a write inside the repository ran in the container, not in the worker.
    expect(written).toContain(`${CONTAINER_FOLDER}/inside.txt`);
    expect(results[4]?.isError).toBe(false);
  });

  it("do not follow a link inside the repository that points outside it, for a read or a write", async () => {
    const { root, state, hostFolder } = await workspace();
    const outside = join(state, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE-CONTENT");
    await symlink(outside, join(hostFolder, "linkout"));
    const results: Array<ReturnType<typeof lastResult>> = [];
    const turns: FauxResponseStep[] = [
      () => toolUse(fauxToolCall("read", { path: `${CONTAINER_FOLDER}/linkout/secret.txt` }, { id: "r1" })),
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("write", { path: `${CONTAINER_FOLDER}/linkout/planted.txt`, content: "planted\n" }, { id: "w1" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: `${CONTAINER_FOLDER}/notes.txt` }, { id: "r2" })); },
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("AgentX result: done"); },
    ];
    const { outcome } = await runTask(root, state, fakeDocker({ hostFolder }).docker, turns);

    expect(outcome).toBeUndefined();
    expect(JSON.stringify(results.slice(0, 2))).not.toContain("TOP-SECRET-OUTSIDE-CONTENT");
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET-OUTSIDE-CONTENT");
    expect(results[0]?.isError).toBe(true);
    expect(results[1]?.isError).toBe(true);
    // Positive control (the helper's walk needs /proc/self/fd, so Linux only): a file of the repository is read through it.
    if (process.platform === "linux") expect(results[2]?.content[0]?.text).toContain("repository notes");
  });

  it("start no session when the dev container cannot run the helper and no sandbox can take its place", async () => {
    const { root, state, hostFolder } = await workspace();
    const inputs: unknown[] = [];
    const fake = fakeDocker({ mountSource: hostFolder, nodeFails: true });
    const { outcome } = await runTask(root, state, fake.docker, [fauxAssistantMessage("AgentX result: done")], {
      taskShell: { kind: "local" },
      piAdapter: { create: (input: unknown) => { inputs.push(input); return Promise.reject(new Error("must not be reached")); } },
    });
    expect(String(outcome)).toContain(FILE_TOOLS_NEED_SANDBOX_MESSAGE);
    expect(inputs).toEqual([]);
  });

  it("start no task when the dev container cannot run the helper and the sandbox that should take its place cannot start", async () => {
    const { root, state, hostFolder } = await workspace();
    const fake = fakeDocker({ mountSource: hostFolder, nodeFails: true, runFails: true });
    const { outcome } = await runTask(root, state, fake.docker, [fauxAssistantMessage("AgentX result: done")], { taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE } });
    expect(outcome).toBeDefined();
    expect(fake.execs.filter((call) => call.request.op === "writeFile")).toEqual([]);
  });
});

describe("the dev container's start", () => {
  it("mounts an empty volume over each of the worker's own folders of the workspace, creating them first", async () => {
    const { root } = await workspace();
    await mkdir(join(root, ".docker"));
    const target: DevcontainerTarget = { rootPath: root, workspaceFolder: join(root, "repo/sample"), configPath: join(root, "repo/sample/.devcontainer/devcontainer.json") };
    const { cli, calls } = fakeCli();
    await ensureDevcontainer(cli, target);
    const mounts = calls[0]!.flatMap((arg, index) => (calls[0]![index - 1] === "--mount" ? [arg] : []));
    for (const name of [".agentx", "agent-sessions", ".docker"]) {
      expect(mounts.some((mount) => mount.startsWith("type=volume,") && mount.endsWith(`,target=${join(root, name)}`)), name).toBe(true);
    }
  });
});
