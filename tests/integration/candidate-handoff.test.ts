import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { assertTaskCandidateBase, freezeTaskCandidate } from "../../packages/worker/src/candidate.js";
import type { WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { createEditTool } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const roots: string[] = [];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function git(path: string, ...args: string[]) { return (await run("git", ["-C", path, ...args])).stdout.trim(); }

async function fixture(repositoryPath = "repo") {
  const root = await mkdtemp(join(tmpdir(), "agentx-candidate-test-")); roots.push(root);
  const repo = join(root, repositoryPath); await mkdir(repo, { recursive: true });
  await git(repo, "init", "--initial-branch=main");
  await writeFile(join(repo, "keep.txt"), "base\n"); await writeFile(join(repo, "delete.txt"), "delete\n");
  await git(repo, "add", ".");
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base");
  const baseCommit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "remote", "add", "origin", "https://github.com/example/demo.git");
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = {
    protocolVersion: 1, operationId: randomUUID(), workspaceId: randomUUID(), fence: 2, projectRevision: 1,
    callbackCapability: "c".repeat(64), kind: "task", payload: {
      conversationId: randomUUID(), prompt: "change", candidate: { jobId: randomUUID(), attempt: 1, repository: "demo", baseCommit },
      project: { schemaVersion: 2, name: "demo", revision: 1, controlPlaneUrl: "https://broker.example.test", auth: { issuer: "https://id.example.test", audience: "demo", clientId: "demo" }, environment: { image: `example.test/worker@sha256:${"a".repeat(64)}` }, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo", defaultBranch: "main", credentialRef: "demo" }], setup: [], readiness: [], orchestratorInstructions: "work" },
    },
  };
  invocation.payload.project!.repositories[0]!.path = repositoryPath;
  const artifacts = new Map<string, WorkerArtifact>();
  const artifactSink = async (artifact: WorkerArtifact) => {
    artifacts.set(artifact.name, artifact);
    return { artifactId: artifact.id!, sha256: digest(artifact.content), sizeBytes: Buffer.byteLength(artifact.content) };
  };
  return { root, repo, invocation, artifacts, artifactSink };
}

describe("immutable complete candidate", () => {
  it("edits candidate-relative paths in the validated repository while retaining workspace session storage", async () => {
    const f = await fixture("repo/team-tasks");
    await mkdir(join(f.repo, "app/web/src"), { recursive: true });
    await writeFile(join(f.repo, "app/web/src/App.tsx"), "<h1>Before</h1>\n");
    await git(f.repo, "add", ".");
    await git(f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "nested app");
    f.invocation.payload.candidate!.baseCommit = await git(f.repo, "rev-parse", "HEAD");
    await mkdir(join(f.root, ".agentx"), { recursive: true });
    await writeFile(join(f.root, ".agentx/preparation-manifest.json"), JSON.stringify({
      complete: true, projectRevision: 1, repositories: [{ name: "demo", path: "repo/team-tasks" }],
    }));
    const root = await realpath(f.root);
    const result = await runTaskInvocation(f.invocation, {
      rootPath: f.root, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
      eventSink: async () => undefined, artifactSink: f.artifactSink,
      piAdapter: { create: async ({ cwd, sessionDirectory, agentDirectory }) => {
        expect(sessionDirectory).toBe(join(root, "agent-sessions"));
        expect(agentDirectory).toBe(join(root, ".agentx/pi"));
        return { conversationId: f.invocation.payload.conversationId, sessionFile: join(sessionDirectory, "fixture.jsonl"),
          prompt: async () => { await createEditTool(cwd).execute("edit-heading", {
            path: "app/web/src/App.tsx", edits: [{ oldText: "Before", newText: "After" }],
          }); },
          abort: async () => undefined, dispose: () => undefined, subscribe: () => () => undefined };
      } },
    });
    expect(await readFile(join(f.repo, "app/web/src/App.tsx"), "utf8")).toBe("<h1>After</h1>\n");
    expect(result.candidate!.tree).not.toBe(await git(f.repo, "rev-parse", "HEAD^{tree}"));
  });

  it.each(["outside", "symlink"])("rejects an escaping %s tool working directory before creating a session", async (kind) => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "agentx-outside-cwd-")); roots.push(outside);
    const link = join(f.root, "escape"); await symlink(outside, link);
    const create = vi.fn();
    await expect(createWorkspacePiSession({ rootPath: f.root, toolCwd: kind === "outside" ? outside : link,
      model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } }, { create })).rejects.toThrow(/escap/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the workspace as the default tool working directory", async () => {
    const f = await fixture();
    const root = await realpath(f.root);
    const session = await createWorkspacePiSession({ rootPath: f.root,
      model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } }, { create: async ({ cwd, sessionDirectory }) => {
      expect(cwd).toBe(root);
      return { conversationId: randomUUID(), sessionFile: join(sessionDirectory, "ordinary.jsonl"),
        prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined, subscribe: () => () => undefined };
    } });
    session.dispose();
  });

  it("does not upload more artifacts when the demo deadline expires during candidate handoff", async () => {
    const f = await fixture();
    await mkdir(join(f.root, ".agentx"), { recursive: true });
    await writeFile(join(f.root, ".agentx/preparation-manifest.json"), JSON.stringify({
      complete: true, projectRevision: 1, repositories: [{ name: "demo", path: "repo" }],
    }));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const uploads: string[] = [];
    await expect(runTaskInvocation(f.invocation, {
      rootPath: f.root, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
      demoLimits: true, eventSink: async () => undefined,
      artifactSink: async (artifact) => {
        uploads.push(artifact.name);
        const receipt = await f.artifactSink(artifact);
        now += 181_000;
        return receipt;
      },
      piAdapter: { create: async ({ sessionDirectory }) => ({
        conversationId: f.invocation.payload.conversationId,
        sessionFile: join(sessionDirectory, "fixture.jsonl"),
        prompt: async () => { await writeFile(join(f.repo, "keep.txt"), "changed\n"); },
        abort: async () => undefined, dispose: () => undefined, subscribe: () => () => undefined,
      }) },
    })).rejects.toThrow("DEMO_TASK_DEADLINE");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/^candidate-.*\.bundle\.base64$/);
  });

  it("reconstructs committed, new, deleted, binary and executable source beyond display limits", async () => {
    const f = await fixture(); await assertTaskCandidateBase(f.root, f.invocation);
    await writeFile(join(f.repo, "keep.txt"), "committed\n");
    await git(f.repo, "add", "."); await git(f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "agent edit");
    await rm(join(f.repo, "delete.txt"));
    const binary = randomBytes(5_000_000); await writeFile(join(f.repo, "large.bin"), binary);
    await writeFile(join(f.repo, "new.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(f.repo, "new.sh"), 0o755);
    await writeFile(join(f.repo, ".env"), "API_KEY=secret\n");
    await mkdir(join(f.repo, "node_modules")); await writeFile(join(f.repo, "node_modules/debris.js"), "generated");
    const result = await freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink });
    expect(result.baseCommit).toBe(f.invocation.payload.candidate!.baseCommit);
    const bytes = Buffer.concat(result.retrieval.chunks.map((chunk) => Buffer.from(f.artifacts.get(chunk.name)!.content, "base64")));
    expect(digest(bytes)).toBe(result.retrieval.sha256);
    const bundle = join(f.root, "retained.bundle"); await writeFile(bundle, bytes);
    const consumer = join(f.root, "consumer"); await run("git", ["clone", bundle, consumer]);
    expect(await git(consumer, "rev-parse", "HEAD")).toBe(result.commit);
    expect(await git(consumer, "rev-parse", "HEAD^{tree}")).toBe(result.tree);
    expect(await git(consumer, "rev-parse", "HEAD^")).toBe(result.baseCommit);
    expect(await readFile(join(consumer, "keep.txt"), "utf8")).toBe("committed\n");
    expect(digest(await readFile(join(consumer, "large.bin")))).toBe(digest(binary));
    expect(await git(consumer, "ls-tree", "HEAD", "new.sh")).toMatch(/^100755/);
    for (const path of ["delete.txt", ".env", "node_modules/debris.js"]) await expect(readFile(join(consumer, path))).rejects.toThrow();
    await writeFile(join(f.repo, "keep.txt"), "later mutation");
    expect(await freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink })).toEqual(result);
  });

  it("rejects wrong starting commit or dirty starting workspace before coding", async () => {
    const f = await fixture();
    f.invocation.payload.candidate!.baseCommit = "a".repeat(40);
    await expect(assertTaskCandidateBase(f.root, f.invocation)).rejects.toThrow(/base/i);
    f.invocation.payload.candidate!.baseCommit = await git(f.repo, "rev-parse", "HEAD");
    await writeFile(join(f.repo, "extra.txt"), "dirty");
    await expect(assertTaskCandidateBase(f.root, f.invocation)).rejects.toThrow(/clean/i);
  });

  it("rejects unsafe symlinks and secrets in intended source", async () => {
    const f = await fixture(); await assertTaskCandidateBase(f.root, f.invocation);
    await symlink("../../outside", join(f.repo, "escape"));
    await expect(freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink })).rejects.toThrow(/symlink/i);
    await rm(join(f.repo, "escape"));
    await writeFile(join(f.repo, "secret.txt"), "-----BEGIN PRIVATE KEY-----\nsensitive\n");
    await expect(freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink })).rejects.toThrow(/credential/i);
  });

  it("does not report success on cancellation or altered upload receipts", async () => {
    const f = await fixture(); await assertTaskCandidateBase(f.root, f.invocation);
    await writeFile(join(f.repo, "keep.txt"), "changed\n");
    await expect(freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink, isCancelled: () => true })).rejects.toThrow(/cancel/i);
    await expect(freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: async () => ({ artifactId: randomUUID(), sha256: "0".repeat(64), sizeBytes: 1 }) })).rejects.toThrow(/receipt/i);
    const result = await freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink });
    await writeFile(join(f.repo, "keep.txt"), "changed after frozen\n");
    expect((await freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink })).commit).toBe(result.commit);
    f.invocation.payload.candidate!.jobId = randomUUID();
    await expect(freezeTaskCandidate({ rootPath: f.root, invocation: f.invocation, artifactSink: f.artifactSink })).rejects.toThrow(/conflict/i);
  });
});
