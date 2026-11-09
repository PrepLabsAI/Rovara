// Live interaction A2, worker side: a `peek` reads the working tree of the workspace for an Ask and answers on the same request. It is read only (the whole workspace, .git included, is
// byte and mtime identical afterwards, and Git is only ever run with the four allow-listed subcommands), redacted before it is cut, bounded, and silent about why it failed.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PEEK_FEATURE, PEEK_PATCH_MAX_BYTES, PeekAnswerSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, type WorkerInvocation } from "../../packages/contracts/src/index.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { PEEK_GIT_SUBCOMMANDS, handlePeekInvocation, parseNumstat, parseUntracked } from "../../packages/worker/src/peek-invocation.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";

// Every Git call the peek makes goes through runIsolatedGit; this records them (and still runs them).
const gitCalls: Array<{ args: readonly string[]; mode?: string | undefined }> = [];
vi.mock("../../packages/worker/src/isolated-repository.js", async (importOriginal) => {
  const original: Record<string, unknown> & { runIsolatedGit(directory: string, args: readonly string[], options?: never): Promise<string> } = await importOriginal();
  return { ...original, runIsolatedGit: (directory: string, args: readonly string[], options?: { mode?: string }) => { gitCalls.push({ args, mode: options?.mode }); return original.runIsolatedGit(directory, args, options as never); } };
});

type PeekInvocation = Extract<WorkerInvocation, { kind: "peek" }>;
const roots: string[] = [];
afterEach(async () => { gitCalls.length = 0; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

/** A prepared workspace: one repository `app` with two committed files, the manifest the worker reads, and whatever `change` does to the tree. */
async function workspace(change: (repo: string) => Promise<void> = async () => undefined, repositoryName = "app"): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "peek-"));
  roots.push(root);
  const repo = join(root, repositoryName);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "b.txt"), "alpha\nbeta\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  const commit = git(repo, "rev-parse", "HEAD").trim();
  await mkdir(join(root, ".agentx"));
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "p", projectRevision: 1,
    repositories: [{ name: repositoryName, path: repositoryName, defaultBranch: "main", resolvedCommit: commit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  await change(repo);
  return { root, repo };
}

function peekInvocation(maxPatchBytes = PEEK_PATCH_MAX_BYTES): PeekInvocation {
  return WorkerInvocationSchema.parse({ protocolVersion: 1, kind: "peek", operationId: randomUUID(), workspaceId: randomUUID(), fence: 3, projectRevision: 1, callbackCapability: "p".repeat(64), payload: { maxPatchBytes } }) as PeekInvocation;
}

/** Every file under `root` (the .git directory included) with its content hash, size and mtime. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const info = await stat(path);
      out[relative(root, path)] = `${createHash("sha256").update(await readFile(path)).digest("hex")}:${info.size}:${info.mtimeMs}`;
    }
  };
  await walk(root);
  return out;
}

describe("peek: what it returns", () => {
  it("lists the changed files with counts, the untracked names and the patch of the working tree", async () => {
    const { root } = await workspace(async (repo) => { await writeFile(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n"); await writeFile(join(repo, "new.txt"), "fresh\n"); });
    const answer = await handlePeekInvocation(peekInvocation(), root);
    expect(PeekAnswerSchema.parse(answer)).toMatchObject({ outcome: "peeked", patchTruncated: false, filesTruncated: false });
    expect(answer.files).toEqual([{ repository: "app", path: "a.txt", additions: 2, deletions: 1 }]);
    expect(answer.untracked).toEqual([{ repository: "app", path: "new.txt" }]);
    expect(answer.patch).toContain("diff --git a/a.txt b/a.txt");
    expect(answer.patch).toContain("+TWO");
    expect(answer.patch).not.toContain("b.txt");
  });

  it("shows work the agent already committed, against the commit the workspace was prepared at", async () => {
    const { root } = await workspace(async (repo) => { await writeFile(join(repo, "b.txt"), "alpha\nbeta\ngamma\n"); git(repo, "commit", "-q", "-am", "agent commit"); });
    const answer = await handlePeekInvocation(peekInvocation(), root);
    expect(answer.files).toEqual([{ repository: "app", path: "b.txt", additions: 1, deletions: 0 }]);
  });

  it("is bounded: a patch longer than the asked bytes is cut at a character boundary and says so", async () => {
    const { root } = await workspace(async (repo) => { await writeFile(join(repo, "a.txt"), `${"é".repeat(60_000)}\n`); });
    const answer = await handlePeekInvocation(peekInvocation(1_000), root);
    expect(Buffer.byteLength(answer.patch, "utf8")).toBeLessThanOrEqual(1_000);
    expect(answer.patch.includes("�")).toBe(false);
    expect(answer.patchTruncated).toBe(true);
    expect(answer.files).toHaveLength(1);
    // The schema itself refuses more than 32 KB, whatever a worker returns.
    expect(PeekAnswerSchema.safeParse({ ...answer, patch: "x".repeat(PEEK_PATCH_MAX_BYTES + 1) }).success).toBe(false);
  });

  it("redacts a secret in the patch before it is cut, so a cut cannot leave half of one", async () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const { root } = await workspace(async (repo) => { await writeFile(join(repo, "a.txt"), `one\nGITHUB=${token}\n`); });
    const answer = await handlePeekInvocation(peekInvocation(), root);
    expect(answer.patch).not.toContain(token);
    expect(answer.patch).not.toContain(token.slice(0, 14));
    expect(answer.patch).toContain("GITHUB=");
  });

  it("never returns the patch of a file named like a credential, but still lists it with its counts", async () => {
    const odd = "hunter2-not-key-shaped-9f3k2";
    const { root } = await workspace(async (repo) => {
      await writeFile(join(repo, ".env"), `PASSWORD_HINT=${odd}\n`); await writeFile(join(repo, "server.pem"), `${odd}\n`);
      git(repo, "add", "-f", ".env", "server.pem"); git(repo, "commit", "-q", "-m", "x");
      await writeFile(join(repo, ".env"), `PASSWORD_HINT=${odd}-2\nNEW=${odd}\n`); await writeFile(join(repo, "server.pem"), `${odd}-2\n`);
    });
    // The workspace was prepared at the first commit: both files show; the commit that added them is part of the diff.
    const manifestPath = join(root, ".agentx/preparation-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { repositories: Array<{ resolvedCommit: string }> };
    manifest.repositories[0]!.resolvedCommit = git(join(root, "app"), "rev-parse", "HEAD~1").trim();
    await writeFile(manifestPath, JSON.stringify(manifest));
    const answer = await handlePeekInvocation(peekInvocation(), root);
    expect(answer.files.map((file) => file.path).sort()).toEqual([".env", "server.pem"]);
    expect(answer.patch).not.toContain(odd);
    expect(answer.patch).not.toContain("PASSWORD_HINT");
  });

  it("names the repository on every path only when the workspace has several", async () => {
    const { root } = await workspace(async (repo) => { await writeFile(join(repo, "a.txt"), "changed\n"); });
    const second = join(root, "lib");
    await mkdir(second);
    git(second, "init", "-q", "-b", "main"); await writeFile(join(second, "c.txt"), "x\n"); git(second, "add", "."); git(second, "commit", "-q", "-m", "base");
    const manifestPath = join(root, ".agentx/preparation-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { repositories: Array<Record<string, unknown>> };
    manifest.repositories.push({ ...manifest.repositories[0], name: "lib", path: "lib", resolvedCommit: git(second, "rev-parse", "HEAD").trim() });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(second, "c.txt"), "y\n");
    const answer = await handlePeekInvocation(peekInvocation(), root);
    expect(answer.files.map((file) => `${file.repository}:${file.path}`).sort()).toEqual(["app:a.txt", "lib:c.txt"]);
  });
});

describe("peek: read only", () => {
  it("leaves every file of the workspace, .git included, byte and mtime identical, and runs only allow-listed read-mode Git subcommands", async () => {
    const { root } = await workspace(async (repo) => { await writeFile(join(repo, "a.txt"), "one\nchanged\n"); await writeFile(join(repo, "untracked.txt"), "u\n"); });
    const before = await snapshot(root);
    const answer = await handlePeekInvocation(peekInvocation(), root);
    expect(answer.outcome).toBe("peeked");
    expect(await snapshot(root)).toEqual(before);
    expect(gitCalls.length).toBeGreaterThanOrEqual(4);
    const subcommands = new Set(gitCalls.map((call) => call.args.find((arg) => !arg.startsWith("-"))));
    for (const subcommand of subcommands) expect(PEEK_GIT_SUBCOMMANDS as readonly (string | undefined)[]).toContain(subcommand);
    expect(gitCalls.some((call) => call.mode === "write")).toBe(false);
    // The pinned list itself has no command that writes the work tree, the index or the refs.
    for (const writer of ["add", "checkout", "reset", "commit", "stash", "clean", "restore", "merge", "rm"]) expect(PEEK_GIT_SUBCOMMANDS as readonly string[]).not.toContain(writer);
  });

  it("answers unavailable, with no words, when the workspace cannot be read (no manifest, not a repository)", async () => {
    const root = await mkdtemp(join(tmpdir(), "peek-empty-"));
    roots.push(root);
    expect(await handlePeekInvocation(peekInvocation(), root)).toEqual({ accepted: true, outcome: "unavailable", files: [], untracked: [], patch: "", patchTruncated: false, filesTruncated: false });
    const { root: broken } = await workspace();
    await rm(join(broken, "app/.git"), { recursive: true, force: true });
    const answer = await handlePeekInvocation(peekInvocation(), broken);
    expect(answer.outcome).toBe("unavailable");
    expect(JSON.stringify(answer)).not.toContain("fatal");
  });
});

describe("peek: the git output parsers", () => {
  it("reads numstat -z records, binary files with dashes, and paths with spaces", () => {
    expect(parseNumstat("3\t1\ta b.txt\0-\t-\timg.png\0")).toEqual([{ path: "a b.txt", additions: 3, deletions: 1, binary: false }, { path: "img.png", additions: 0, deletions: 0, binary: true }]);
    expect(parseNumstat("garbage\0")).toEqual([]);
    expect(parseUntracked("?? new one.txt\0 M a.txt\0?? z.txt\0")).toEqual(["new one.txt", "z.txt"]);
  });
});

describe("peek: the worker server", () => {
  const body = (invocation: WorkerInvocation) => new Request("http://worker/invocations", { method: "POST", body: JSON.stringify(invocation) });
  it("lists the feature, answers a peek on the same request, and journals nothing", async () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(PEEK_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(PEEK_FEATURE);
    const root = await mkdtemp(join(tmpdir(), "peek-server-"));
    roots.push(root);
    const journal = new OperationJournal(root);
    const executed: unknown[] = [];
    const state = createWorkerServerState(journal, { execute: async (invocation) => { executed.push(invocation); }, peek: async () => ({ accepted: true, outcome: "peeked", files: [], untracked: [], patch: "", patchTruncated: false, filesTruncated: false }) });
    const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
    expect(((await ping.json()) as { features?: string[]; invocationFeatures?: string[] })).toBeDefined();
    const invocation = peekInvocation();
    const response = await handleWorkerRequest(body(invocation), state);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, outcome: "peeked" });
    expect(await journal.get(invocation.operationId)).toBeUndefined();
    expect(executed).toEqual([]);
    expect(state.activeOperations.size).toBe(0);
  });

  it("refuses a peek when the executor has no peek (nothing is run in the background)", async () => {
    const root = await mkdtemp(join(tmpdir(), "peek-server-"));
    roots.push(root);
    const executed: unknown[] = [];
    const state = createWorkerServerState(new OperationJournal(root), { execute: async (invocation) => { executed.push(invocation); } });
    const response = await handleWorkerRequest(body(peekInvocation()), state);
    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executed).toEqual([]);
  });

  it("refuses a peek that carries a field it does not know (a command, a path, a budget)", () => {
    const base = { protocolVersion: 1, kind: "peek", operationId: randomUUID(), workspaceId: randomUUID(), fence: 3, projectRevision: 1, callbackCapability: "p".repeat(64) };
    for (const extra of [{ command: "ls" }, { path: "/etc/passwd" }, { budget: 5 }, { tools: ["bash"] }]) {
      expect(WorkerInvocationSchema.safeParse({ ...base, payload: { maxPatchBytes: 100, ...extra } }).success).toBe(false);
    }
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { maxPatchBytes: PEEK_PATCH_MAX_BYTES + 1 } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { maxPatchBytes: 100 } }).success).toBe(true);
  });
});
