// the agent's file tools run in the task's own container, never in the worker. A
// session's `read`, `write`, `edit`, `grep`, `find` and `ls` each go through `docker exec -i` to the helper
// (sandbox-file-ops.ts) in the task sandbox, or in the project's devcontainer. A fake Docker answers as a small
// in-memory filesystem would, so these tests see exactly which calls the tools make, and prove that none touches the
// worker's own files. The helper's no-follow walk has its own contract test (tests/contract/sandbox-file-ops.test.ts).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devcontainerMounts, notMountedMessage, toContainerPath, toHostPath, virtualDirectoryEntries } from "../../packages/worker/src/devcontainer-file-paths.js";
import { FILE_OPS_NODE_FLAGS, fileOpsExec, type FileOpsTarget } from "../../packages/worker/src/file-ops-exec.js";
import {
  FILE_TOOLS_NEED_SANDBOX_MESSAGE,
  createDefaultPiSessionAdapter,
  createWorkspacePiSession,
  type PiSessionAdapter,
  type PiSessionHandle,
} from "../../packages/worker/src/pi-session.js";
import type { SandboxFileRequest } from "../../packages/worker/src/sandbox-file-ops.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { runWorkflowFeedbackReview, runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const IMAGE = "registry.example.test/agentx/worker@sha256:" + "b".repeat(64);
const NODE = "/usr/local/bin/node";
const HELPER = "/opt/agentx/packages/worker/dist/sandbox-file-ops.js";
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

interface ExecCall { args: string[]; request: SandboxFileRequest; stdin: Buffer | undefined }

/**
 * A fake Docker whose `exec -i` answers like the helper over an in-memory filesystem of container paths. It enforces the
 * request's root, so a path sent with the wrong root is OUTSIDE, as the real helper would say.
 */
function fakeDocker(initial: Record<string, string>, options: { mounts?: unknown[]; reply?: (request: SandboxFileRequest) => string | undefined; failRun?: boolean } = {}) {
  const files = new Map(Object.entries(initial));
  const execs: ExecCall[] = [];
  const runs: string[][] = [];
  const events: string[] = [];
  const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
  const dirsOf = (path: string) => {
    const names = new Map<string, "dir" | "file">();
    for (const file of files.keys()) {
      if (!file.startsWith(`${path}/`)) continue;
      const [first, ...rest] = file.slice(path.length + 1).split("/");
      names.set(first!, rest.length > 0 ? "dir" : "file");
    }
    return names;
  };
  const answer = (request: SandboxFileRequest, stdin: Buffer | undefined): unknown => {
    const refuse = (code: string, message = code) => ({ ok: false, code, message });
    if ("path" in request && !inside(request.root, request.path)) return refuse("OUTSIDE");
    switch (request.op) {
      case "readFile": {
        const content = files.get(request.path);
        return content === undefined ? refuse("ENOENT") : { ok: true, result: { contentBase64: Buffer.from(request.head === undefined ? content : content.slice(0, request.head)).toString("base64") } };
      }
      case "access": return files.has(request.path) || dirsOf(request.path).size > 0 ? { ok: true, result: {} } : refuse("ENOENT");
      case "exists": return { ok: true, result: { exists: files.has(request.path) || dirsOf(request.path).size > 0 } };
      case "stat": return files.has(request.path) ? { ok: true, result: { type: "file", size: 1, mtimeMs: 1, mode: 0o644 } } : dirsOf(request.path).size > 0 ? { ok: true, result: { type: "dir", size: 0, mtimeMs: 1, mode: 0o755 } } : refuse("ENOENT");
      case "readdir": return { ok: true, result: { entries: [...dirsOf(request.path)].map(([name, kind]) => ({ name, kind })) } };
      case "writeFile": files.set(request.path, stdin?.toString("utf8") ?? ""); return { ok: true, result: {} };
      case "mkdir": case "sweep": return { ok: true, result: request.op === "sweep" ? { removed: 0 } : {} };
      case "glob": return { ok: true, result: { paths: [...files.keys()].filter((file) => inside(request.cwd, file) && file.endsWith(request.pattern.replace(/^(\*\*\/)?\*/u, ""))) } };
      case "grep": {
        const blocks = [...files].filter(([file]) => inside(request.path, file)).flatMap(([file, content]) =>
          content.split("\n").flatMap((text, index) => text.includes(request.pattern) ? [{ path: file, lines: [{ n: index + 1, text, match: true }] }] : []));
        return { ok: true, result: { searchIsDirectory: !files.has(request.path), blocks, limitReached: false } };
      }
    }
  };
  const docker: DockerCli = {
    async run(args) {
      runs.push([...args]);
      events.push(`run ${args[0]}`);
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] === "run" && options.failRun === true) return { exitCode: 1, stdout: "", stderr: "no" };
      if (args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify(options.mounts ?? []), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async execBytes(args, bytesOptions) {
      const request = JSON.parse(Buffer.from(args.at(-1)!, "base64url").toString("utf8")) as SandboxFileRequest;
      execs.push({ args: [...args], request, stdin: bytesOptions.stdin });
      events.push(`exec ${request.op}`);
      const raw = options.reply?.(request) ?? `${JSON.stringify(answer(request, bytesOptions.stdin))}\n`;
      return { exitCode: 0, stdout: Buffer.from(raw), stderr: "" };
    },
  };
  return { docker, files, execs, runs, events };
}

async function workspaceRoot(): Promise<string> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-file-tools-")));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "tools", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

const shell: BashOperations = { exec: async () => ({ exitCode: 0 }) };

/** A real worker session on the scripted model, with the given file-tool target. */
async function session(responses: FauxResponseStep[], input: { rootPath: string; fileTools: FileOpsTarget; workflowMode?: "PLAN" | "IMPLEMENT" | "REVIEW" }) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const handle = await createWorkspacePiSession({
    rootPath: input.rootPath, model: FAUX_MODEL, bashOperations: shell, fileTools: input.fileTools,
    ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
  }, adapter);
  return handle;
}

const settle = (handle: PiSessionHandle, text: string) => handle.prompt(text).then(() => "resolved", (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`);
const toolNames = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name).sort();
const lastResult = (context: TranscriptContext) => JSON.parse(JSON.stringify(context.messages.at(-1))) as { toolName: string; isError: boolean; content: Array<{ text: string }> };

beforeEach(() => { vi.stubEnv("AGENTX_RUNTIME", "ec2"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the task sandbox's file tools", () => {
  it("runs read, write, edit, grep, find and ls of an IMPLEMENT session through docker exec -i, never in the worker", async () => {
    const rootPath = await workspaceRoot();
    // The worker's own copy of the file: a tool that touched the worker would show this, not the container's.
    await writeFile(join(rootPath, "a.txt"), "WORKER-COPY\n");
    const fake = fakeDocker({ [`${rootPath}/a.txt`]: "container alpha\n", [`${rootPath}/src/b.ts`]: "const needle = 1;\n" });
    const sandbox = new TaskSandbox({ rootPath, taskId: randomUUID(), docker: fake.docker, image: IMAGE });
    await sandbox.start();
    const results: Array<ReturnType<typeof lastResult>> = [];
    const offered: string[][] = [];
    const handle = await session([
      (context) => { offered.push(toolNames(context)); return toolUse(fauxToolCall("read", { path: "a.txt" }, { id: "c1" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("write", { path: "new/c.txt", content: "SECRET-BODY \"quoted\"\n" }, { id: "c2" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, { id: "c3" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("grep", { pattern: "needle" }, { id: "c4" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("find", { pattern: "*.ts" }, { id: "c5" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("ls", { path: "src" }, { id: "c6" })); },
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
    ], { rootPath, fileTools: sandbox.fileOpsTarget() });
    try {
      expect(await settle(handle, "use every file tool")).toBe("resolved");
    } finally { handle.dispose(); }
    expect(offered[0]).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    expect(results.map(({ toolName, isError }) => ({ toolName, isError }))).toEqual([
      { toolName: "read", isError: false }, { toolName: "write", isError: false }, { toolName: "edit", isError: false },
      { toolName: "grep", isError: false }, { toolName: "find", isError: false }, { toolName: "ls", isError: false },
    ]);
    expect(results[0]!.content[0]!.text).toBe("container alpha\n");
    expect(results[3]!.content[0]!.text).toBe("src/b.ts:1: const needle = 1;");
    expect(results[4]!.content[0]!.text).toBe("src/b.ts");
    expect(results[5]!.content[0]!.text).toBe("b.ts");
    // Every call is the sandbox's: docker exec -i as uid 1000, with the sandbox's Node and helper by absolute path.
    expect(fake.execs.length).toBeGreaterThanOrEqual(6);
    for (const exec of fake.execs) {
      expect(exec.args.slice(0, 8)).toEqual(["exec", "-i", "--user", "1000:1000", sandbox.name, NODE, ...FILE_OPS_NODE_FLAGS, HELPER]);
      expect(exec.request.root).toBe(rootPath);
    }
    const ops = new Set(fake.execs.map(({ request }) => request.op));
    for (const op of ["readFile", "writeFile", "mkdir", "grep", "glob", "readdir"]) expect(ops).toContain(op);
    expect(fake.files.get(`${rootPath}/a.txt`)).toBe("container beta\n");
    // The worker's files are as they were: the write did not land, the edit did not touch its copy.
    expect(existsSync(join(rootPath, "new"))).toBe(false);
    expect(await readFile(join(rootPath, "a.txt"), "utf8")).toBe("WORKER-COPY\n");
  });

  it("sends a write's content on stdin, never in the argument", async () => {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({});
    const sandbox = new TaskSandbox({ rootPath, taskId: randomUUID(), docker: fake.docker, image: IMAGE });
    await sandbox.start();
    const body = `line "one"\n\u0001 control \\ backslash ${"x".repeat(40_000)}\n`;
    const handle = await session([
      toolUse(fauxToolCall("write", { path: "big.txt", content: body }, { id: "w1" })),
      fauxAssistantMessage("Done."),
    ], { rootPath, fileTools: sandbox.fileOpsTarget() });
    try { expect(await settle(handle, "write it")).toBe("resolved"); } finally { handle.dispose(); }
    const write = fake.execs.find(({ request }) => request.op === "writeFile")!;
    expect(write.stdin!.toString("utf8")).toBe(body);
    expect(write.request).toMatchObject({ op: "writeFile", path: `${rootPath}/big.txt`, size: Buffer.byteLength(body) });
    expect(write.args.join(" ")).not.toContain("control");
    expect(write.args.at(-1)!.length).toBeLessThan(16 * 1024);
    expect(fake.files.get(`${rootPath}/big.txt`)).toBe(body);
  });

  it("exposes only read, grep, find and ls in a PLAN session, all through the sandbox", async () => {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({ [`${rootPath}/notes.md`]: "plan notes\n" });
    const sandbox = new TaskSandbox({ rootPath, taskId: randomUUID(), docker: fake.docker, image: IMAGE });
    await sandbox.start();
    const offered: string[][] = [];
    const handle = await session([
      (context) => { offered.push(toolNames(context)); return toolUse(fauxToolCall("read", { path: "notes.md" }, { id: "p1" })); },
      fauxAssistantMessage("Planned."),
    ], { rootPath, fileTools: sandbox.fileOpsTarget(), workflowMode: "PLAN" });
    try { expect(await settle(handle, "plan")).toBe("resolved"); } finally { handle.dispose(); }
    expect(offered[0]).toEqual(["find", "grep", "ls", "read"]);
    expect(fake.execs.map(({ request }) => request.op)).toContain("readFile");
  });

  it("starts nothing in the worker and keeps Pi's built-ins for a local run", async () => {
    vi.stubEnv("AGENTX_RUNTIME", "");
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "");
    const rootPath = await workspaceRoot();
    await writeFile(join(rootPath, "local.txt"), "local file\n");
    const { modelRuntime, faux } = await fauxModelRuntime();
    const seen: string[] = [];
    faux.setResponses([
      toolUse(fauxToolCall("read", { path: "local.txt" }, { id: "l1" })),
      (context) => { seen.push(lastResult(context).content[0]!.text); return fauxAssistantMessage("Done."); },
    ]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const handle = await createWorkspacePiSession({ rootPath, model: FAUX_MODEL, bashOperations: shell }, adapter);
    try { expect(await settle(handle, "read")).toBe("resolved"); } finally { handle.dispose(); }
    expect(seen).toEqual(["local file\n"]);
  });

  it("turns a helper reply that is not JSON into a tool error, not a crash", async () => {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({}, { reply: () => "this is not json\n" });
    const sandbox = new TaskSandbox({ rootPath, taskId: randomUUID(), docker: fake.docker, image: IMAGE });
    await sandbox.start();
    const results: Array<ReturnType<typeof lastResult>> = [];
    const handle = await session([
      toolUse(fauxToolCall("read", { path: "a.txt" }, { id: "r1" })),
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
    ], { rootPath, fileTools: sandbox.fileOpsTarget() });
    try { expect(await settle(handle, "read")).toBe("resolved"); } finally { handle.dispose(); }
    expect(results[0]).toMatchObject({ toolName: "read", isError: true });
    expect(results[0]!.content[0]!.text).toContain("not JSON");
  });

  it("tells the agent why the helper refused: outside the workspace, or not allowed by the file's permissions", async () => {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({}, { reply: (request) => ("path" in request && request.path.endsWith("locked.txt")
      ? `${JSON.stringify({ ok: false, code: "EACCES", message: "x" })}\n`
      : `${JSON.stringify({ ok: false, code: "OUTSIDE", message: "x" })}\n`) });
    const sandbox = new TaskSandbox({ rootPath, taskId: randomUUID(), docker: fake.docker, image: IMAGE });
    await sandbox.start();
    const results: Array<ReturnType<typeof lastResult>> = [];
    const handle = await session([
      toolUse(fauxToolCall("read", { path: "link/x.txt" }, { id: "o1" })),
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: "locked.txt" }, { id: "o2" })); },
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
    ], { rootPath, fileTools: sandbox.fileOpsTarget() });
    try { expect(await settle(handle, "read")).toBe("resolved"); } finally { handle.dispose(); }
    expect(results[0]!.content[0]!.text).toBe(`${rootPath}/link/x.txt is outside the workspace`);
    expect(results[1]!.content[0]!.text).toBe(`${rootPath}/locked.txt can't be read or changed by the agent's file tools: the file's owner or permissions don't allow it. Use bash to change it, or check who created it.`);
  });

  it("sweeps leftover temporary files when a write fails, and when a sandbox starts", async () => {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({}, { reply: (request) => (request.op === "writeFile" ? `${JSON.stringify({ ok: false, code: "INVALID", message: "content ended early" })}\n` : undefined) });
    const sandbox = new TaskSandbox({ rootPath, taskId: randomUUID(), docker: fake.docker, image: IMAGE });
    await sandbox.start();
    expect(fake.execs.map(({ request }) => request.op)).toEqual(["sweep"]);
    expect(fake.execs[0]!.request).toMatchObject({ op: "sweep", path: rootPath, root: rootPath });
    const results: Array<ReturnType<typeof lastResult>> = [];
    const handle = await session([
      toolUse(fauxToolCall("write", { path: "sub/f.txt", content: "x" }, { id: "s1" })),
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
    ], { rootPath, fileTools: sandbox.fileOpsTarget() });
    try { expect(await settle(handle, "write")).toBe("resolved"); } finally { handle.dispose(); }
    expect(results[0]).toMatchObject({ toolName: "write", isError: true });
    expect(fake.execs.at(-1)!.request).toMatchObject({ op: "sweep", path: `${rootPath}/sub` });
  });
});

describe("fail closed", () => {
  const sessionInput = async () => ({ rootPath: await workspaceRoot(), model: FAUX_MODEL });
  const noAdapter: PiSessionAdapter = { create: () => Promise.reject(new Error("the adapter must not be reached")) };

  it("refuses to start a session with file tools and no container on an EC2 worker", async () => {
    await expect(createWorkspacePiSession(await sessionInput(), noAdapter)).rejects.toThrow(FILE_TOOLS_NEED_SANDBOX_MESSAGE);
    await expect(createWorkspacePiSession({ ...(await sessionInput()), workflowMode: "PLAN" }, noAdapter)).rejects.toThrow("AgentX did not start the agent: its file tools need the task sandbox");
    await expect(createWorkspacePiSession({ ...(await sessionInput()), workflowMode: "REVIEW" }, noAdapter)).rejects.toThrow(FILE_TOOLS_NEED_SANDBOX_MESSAGE);
  });

  it("refuses the feedback review and the critic and security reviews without fileTools, with the exact message", async () => {
    await expect(runWorkflowFeedbackReview({} as never)).rejects.toThrow("AgentX did not start the agent: its file tools need the task sandbox");
    await expect(runWorkflowReviews({} as never)).rejects.toThrow("AgentX did not start the agent: its file tools need the task sandbox");
  });

  it("starts a session on a local run without file tools", async () => {
    vi.stubEnv("AGENTX_RUNTIME", "");
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "");
    let reached = false;
    const adapter: PiSessionAdapter = { create: () => { reached = true; return Promise.reject(new Error("stop")); } };
    await expect(createWorkspacePiSession(await sessionInput(), adapter)).rejects.toThrow("stop");
    expect(reached).toBe(true);
  });
});

describe("the devcontainer's file tools", () => {
  const MOUNT = (source: string, destination: string) => ({ Type: "bind", Source: source, Destination: destination });

  async function devcontainerSession(options: { files: Record<string, string>; mounts: (root: string) => unknown[]; responses: (root: string) => FauxResponseStep[] }) {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker(options.files, { mounts: options.mounts(rootPath) });
    const mounts = await devcontainerMounts(fake.docker, "dev-container-id", rootPath, { hostFolder: join(rootPath, "api"), containerFolder: "/workspaces/api" });
    const target: FileOpsTarget = { container: "dev-container-id", user: "vscode", node: "/opt/agentx-file-ops/node", helper: "/opt/agentx-file-ops/sandbox-file-ops.js", root: "/workspaces/api", mounts, docker: fake.docker };
    const handle = await session(options.responses(rootPath), { rootPath, fileTools: target });
    return { rootPath, fake, handle, mounts };
  }

  it("runs a read of a container path as the devcontainer's user with the copied Node, rooted at the mount", async () => {
    const results: Array<ReturnType<typeof lastResult>> = [];
    const { fake, handle } = await devcontainerSession({
      files: { "/workspaces/api/a.txt": "api alpha\n" },
      mounts: (root) => [MOUNT(join(root, "api"), "/workspaces/api")],
      responses: () => [
        toolUse(fauxToolCall("read", { path: "/workspaces/api/a.txt" }, { id: "d1" })),
        (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
      ],
    });
    try { expect(await settle(handle, "read")).toBe("resolved"); } finally { handle.dispose(); }
    expect(results[0]!.content[0]!.text).toBe("api alpha\n");
    for (const exec of fake.execs) {
      expect(exec.args.slice(0, 8)).toEqual(["exec", "-i", "--user", "vscode", "dev-container-id", "/opt/agentx-file-ops/node", ...FILE_OPS_NODE_FLAGS, "/opt/agentx-file-ops/sandbox-file-ops.js"]);
      expect(exec.request).toMatchObject({ root: "/workspaces/api", path: "/workspaces/api/a.txt" });
    }
  });

  it("maps a host path and a relative path to the container, and grep results back to host paths", async () => {
    const results: Array<ReturnType<typeof lastResult>> = [];
    const { fake, handle } = await devcontainerSession({
      files: { "/workspaces/api/src/a.ts": "const needle = 1;\n" },
      mounts: (path) => [MOUNT(join(path, "api"), "/workspaces/api")],
      responses: (path) => [
        toolUse(fauxToolCall("read", { path: join(path, "api/src/a.ts") }, { id: "h1" })),
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: "api/src/a.ts" }, { id: "h2" })); },
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("grep", { pattern: "needle" }, { id: "h3" })); },
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("grep", { pattern: "needle", path: "api" }, { id: "h4" })); },
        (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
      ],
    });
    try { expect(await settle(handle, "go")).toBe("resolved"); } finally { handle.dispose(); }
    expect(results[0]!.content[0]!.text).toBe("const needle = 1;\n");
    expect(results[1]!.content[0]!.text).toBe("const needle = 1;\n");
    const reads = fake.execs.filter(({ request }) => request.op === "readFile" && "path" in request && request.path.endsWith("a.ts")).map(({ request }) => ("path" in request ? request.path : ""));
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(["/workspaces/api/src/a.ts"]));
    // grep with no path means the workspace root, which is not a mount: it defaults to the repository's mount (I2).
    expect(results[2]!.content[0]!.text).toBe("api/src/a.ts:1: const needle = 1;");
    expect(results[3]!.content[0]!.text).toBe("src/a.ts:1: const needle = 1;");
    expect(fake.execs.find(({ request }) => request.op === "grep")!.request).toMatchObject({ root: "/workspaces/api", path: "/workspaces/api" });
  });

  it("defaults a pathless grep and find to the repository's mount, lists the mounted folders for a pathless ls, and refuses workspace-level files (I2, R4)", async () => {
    const results: Array<ReturnType<typeof lastResult>> = [];
    const { rootPath, fake, handle } = await devcontainerSession({
      files: { "/workspaces/api/src/a.ts": "const needle = 1;\n", "/workspaces/api/README.md": "readme\n" },
      mounts: (path) => [MOUNT(join(path, "api"), "/workspaces/api")],
      responses: (path) => [
        toolUse(fauxToolCall("grep", { pattern: "needle" }, { id: "i1" })),
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("find", { pattern: "*.ts" }, { id: "i2" })); },
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("ls", {}, { id: "i3" })); },
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("ls", { path: "." }, { id: "i4" })); },
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: join(path, "notes.md") }, { id: "i5" })); },
        // What the listing shows can be used: the folder it names lists, and a path under it reads.
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("ls", { path: "api" }, { id: "i6" })); },
        (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: "api/src/a.ts" }, { id: "i7" })); },
        (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
      ],
    });
    try { expect(await settle(handle, "go")).toBe("resolved"); } finally { handle.dispose(); }
    expect(results.map((result) => result.isError)).toEqual([false, false, false, false, true, false, false]);
    expect(results[0]!.content[0]!.text).toBe("api/src/a.ts:1: const needle = 1;");
    expect(results[1]!.content[0]!.text).toBe("api/src/a.ts");
    expect(results[2]!.content[0]!.text).toBe("api/");
    expect(results[3]!.content[0]!.text).toBe("api/");
    expect(results[4]!.content[0]!.text).toContain("isn't in a workspace folder mounted in this devcontainer");
    expect(results[4]!.content[0]!.text).toContain(join(rootPath, "notes.md"));
    expect(results[5]!.content[0]!.text).toBe("README.md\nsrc/");
    expect(results[6]!.content[0]!.text).toBe("const needle = 1;\n");
    // The listing of the workspace root made no call; every call that did reach the container was rooted at the mount.
    expect(fake.execs.length).toBeGreaterThan(0);
    for (const exec of fake.execs) expect(exec.request.root).toBe("/workspaces/api");
  });

  it("lists the next folder of every mount below a folder that is no mount, and nothing inside a mount", () => {
    const mounts = [{ hostPath: "/ws/repo/api", containerPath: "/workspaces/api" }, { hostPath: "/ws/repo/web", containerPath: "/workspaces/web" }, { hostPath: "/ws/tools", containerPath: "/t" }];
    expect(virtualDirectoryEntries(mounts, "/ws")).toEqual(["repo", "tools"]);
    expect(virtualDirectoryEntries(mounts, "/ws/repo")).toEqual(["api", "web"]);
    expect(virtualDirectoryEntries(mounts, "/ws/repo/api")).toBeUndefined();
    expect(virtualDirectoryEntries(mounts, "/ws/repo/api/src")).toBeUndefined();
    expect(virtualDirectoryEntries(mounts, "/ws/other")).toBeUndefined();
  });

  it("refuses a second repository the devcontainer does not mount, and a workspace-level file, with NOT_MOUNTED and no docker exec", async () => {
    const results: Array<ReturnType<typeof lastResult>> = [];
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({ "/workspaces/api/a.txt": "x" }, { mounts: [MOUNT(join(rootPath, "api"), "/workspaces/api")] });
    const mounts = await devcontainerMounts(fake.docker, "dev-container-id", rootPath);
    const target: FileOpsTarget = { container: "dev-container-id", user: "vscode", node: "/opt/agentx-file-ops/node", helper: "/opt/agentx-file-ops/sandbox-file-ops.js", root: "/workspaces/api", mounts, docker: fake.docker };
    const handle = await session([
      toolUse(fauxToolCall("read", { path: join(rootPath, "web/b.ts") }, { id: "n1" })),
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: join(rootPath, "notes.md") }, { id: "n2" })); },
      (context) => { results.push(lastResult(context)); return toolUse(fauxToolCall("read", { path: "/tmp/x" }, { id: "n3" })); },
      (context) => { results.push(lastResult(context)); return fauxAssistantMessage("Done."); },
    ], { rootPath, fileTools: target });
    try { expect(await settle(handle, "read")).toBe("resolved"); } finally { handle.dispose(); }
    const copy = (path: string) => `${path} isn't in a workspace folder mounted in this devcontainer. The file tools reach only ${join(rootPath, "api")}; use bash in the devcontainer for other paths, or mount the folder in the project's devcontainer.json.`;
    expect(results.map((result) => result.content[0]!.text)).toEqual([copy(join(rootPath, "web/b.ts")), copy(join(rootPath, "notes.md")), copy("/tmp/x")]);
    expect(fake.execs).toEqual([]);
  });

  it("maps a second repository that is also bind-mounted to its own mount", async () => {
    const rootPath = await workspaceRoot();
    const fake = fakeDocker({ "/workspaces/web/b.ts": "web file\n" }, {
      mounts: [MOUNT(join(rootPath, "api"), "/workspaces/api"), MOUNT(join(rootPath, "web"), "/workspaces/web"), MOUNT("/var/lib/docker/other", "/other"), { Type: "volume", Source: join(rootPath, "vol"), Destination: "/vol" }],
    });
    const mounts = await devcontainerMounts(fake.docker, "dev-container-id", rootPath, { hostFolder: join(rootPath, "api"), containerFolder: "/workspaces/api" });
    expect(mounts).toEqual([
      { hostPath: join(rootPath, "api"), containerPath: "/workspaces/api" },
      { hostPath: join(rootPath, "web"), containerPath: "/workspaces/web" },
    ]);
    expect(toContainerPath(mounts, rootPath, join(rootPath, "web/b.ts"))).toEqual({ containerPath: "/workspaces/web/b.ts", mountRoot: "/workspaces/web" });
    expect(toContainerPath(mounts, rootPath, "web/b.ts")).toEqual({ containerPath: "/workspaces/web/b.ts", mountRoot: "/workspaces/web" });
    expect(toContainerPath(mounts, rootPath, "/workspaces/api/x")).toEqual({ containerPath: "/workspaces/api/x", mountRoot: "/workspaces/api" });
    expect(toContainerPath(mounts, rootPath, "/workspaces/apix/x")).toEqual({ notMounted: "/workspaces/apix/x" });
    expect(toContainerPath(mounts, rootPath, join(rootPath, "notes.md"))).toEqual({ notMounted: join(rootPath, "notes.md") });
    expect(toHostPath(mounts, "/workspaces/web/b.ts")).toBe(join(rootPath, "web/b.ts"));
    expect(toHostPath(mounts, "/elsewhere/b.ts")).toBe("/elsewhere/b.ts");
    expect(notMountedMessage("/x", [])).toContain("reach only no host folders");
    const target: FileOpsTarget = { container: "dev-container-id", user: "vscode", node: "/n", helper: "/h", root: "/workspaces/api", mounts, docker: fake.docker };
    const reply = await fileOpsExec(target, { root: "/workspaces/web", op: "readFile", path: "/workspaces/web/b.ts" });
    expect(reply.ok && Buffer.from(reply.result.contentBase64, "base64").toString()).toBe("web file\n");
  });
});

describe("sessions of reviews", () => {
  it("hands the critic and security sessions the container's file tools", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const rootPath = await workspaceRoot();
    const repositoryDirectory = join(rootPath, "repo");
    await mkdir(repositoryDirectory);
    const git = (...args: string[]) => run("git", ["-C", repositoryDirectory, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", ...args]);
    await run("git", ["init", "--quiet", "--initial-branch=main", repositoryDirectory]);
    await writeFile(join(repositoryDirectory, "app.ts"), "export const a = 1;\n");
    await git("add", "app.ts");
    await git("commit", "--quiet", "-m", "baseline");
    const base = (await run("git", ["-C", repositoryDirectory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await writeFile(join(repositoryDirectory, "app.ts"), "export const a = 2;\n");
    const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
    const repositories = [{ repositoryId: "demo", directory: repositoryDirectory }];
    const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
    const seen: Array<FileOpsTarget | undefined> = [];
    const adapter: PiSessionAdapter = {
      async create(input) {
        seen.push(input.fileTools);
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        return {
          conversationId: input.conversationId ?? "review", sessionFile,
          async prompt() { listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] } }); },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: "review-v1" }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    };
    const target: FileOpsTarget = { container: "task-sandbox", user: "1000:1000", node: NODE, helper: HELPER, root: rootPath };
    const reports = await runWorkflowReviews({
      operationId: randomUUID(), rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
      piAdapter: adapter, fileTools: target, ruleFileBaseCommits: [],
    });
    expect(reports.map(({ role, status }) => ({ role, status }))).toEqual([{ role: "CRITIC", status: "PASS" }, { role: "SECURITY", status: "PASS" }]);
    expect(seen).toEqual([target, target]);
  });
});

describe("candidate snapshots and the file tools' leftover temporary files", () => {
  async function repository() {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const directory = join(await workspaceRoot(), "repo");
    await mkdir(join(directory, "src"), { recursive: true });
    await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
    await writeFile(join(directory, "src/app.ts"), "export const a = 1;\n");
    await run("git", ["-C", directory, "add", "."]);
    await run("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "commit", "--quiet", "-m", "baseline"]);
    return { directory, tree: async (revision: string) => (await run("git", ["-C", directory, "rev-parse", revision], { encoding: "utf8" })).stdout.trim() };
  }

  it("sweeps first, and leaves a leftover out of the candidate tree whether or not the sweep ran", async () => {
    const { readCandidateRepositories, commitCandidateWorktree } = await import("../../packages/worker/src/verification/candidate.js");
    const { directory, tree } = await repository();
    await writeFile(join(directory, "src/app.ts"), "export const a = 2;\n");
    const clean = (await readCandidateRepositories([{ repositoryId: "demo", directory }]))[0]!;
    // A write the helper was killed in: the temporary file sits next to its target.
    await writeFile(join(directory, "src", ".agentx-file-ops-1b2c3d"), "partial content");
    await writeFile(join(directory, ".agentx-file-ops-top"), "partial content");
    const swept: string[] = [];
    const withLeftover = (await readCandidateRepositories([{ repositoryId: "demo", directory, sweep: async () => { swept.push("read"); } }]))[0]!;
    expect(swept).toEqual(["read"]);
    expect(withLeftover.treeSha).toBe(clean.treeSha);
    const committed = (await commitCandidateWorktree([{ repositoryId: "demo", directory, sweep: async () => { swept.push("commit"); } }]))[0]!;
    expect(swept).toEqual(["read", "commit"]);
    expect(committed.treeSha).toBe(clean.treeSha);
    expect(await tree("HEAD^{tree}")).toBe(clean.treeSha);
    const { execFile } = await import("node:child_process");
    const listed = await new Promise<string>((done, reject) => execFile("git", ["-C", directory, "ls-tree", "-r", "--name-only", "HEAD"], (error, stdout) => (error ? reject(error instanceof Error ? error : new Error("git failed")) : done(stdout))));
    expect(listed).not.toContain(".agentx-file-ops-");
  });

  it("does not fail a snapshot when the sweep fails", async () => {
    const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
    const { directory } = await repository();
    const read = await readCandidateRepositories([{ repositoryId: "demo", directory, sweep: () => Promise.reject(new Error("the container is gone")) }]);
    expect(read).toHaveLength(1);
  });
});
