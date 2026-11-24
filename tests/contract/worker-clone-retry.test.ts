import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PREPARE_PIN_MOVED_MARKER, type ProjectDefinition } from "@agentx/contracts";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import type { CredentialedGitRunner } from "../../packages/worker/src/git-auth.js";

const execFileAsync = promisify(execFile);
const NOT_FOUND = "Command failed: git clone --no-checkout --branch main -- https://github.com/PrepLabsAI/Sample-Project-A.git /mnt/workspace/repo/demo\nremote: Repository not found.\nfatal: repository 'https://github.com/PrepLabsAI/Sample-Project-A.git/' not found\n";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

/**
 * Staging v0.4.9: a clone or fetch with a fresh GitHub token sometimes got "Repository not found" from the worker and worked a few seconds later. Only that answer is
 * retried (2 s, then 5 s), with the same token unless it is nearly an hour old; any other failure, and the last "not found", end the preparation as before.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clone-retry-"));
  const source = join(root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", source], { env: gitEnv });
  await writeFile(join(source, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["-C", source, "add", "."], { env: gitEnv });
  await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "init"], { env: gitEnv });
  // A pull request head that no branch holds, so that a clone does not bring it and only the pull request's own ref does.
  const tree = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD^{tree}"], { env: gitEnv })).stdout.trim();
  const parent = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"], { env: gitEnv })).stdout.trim();
  const head = (await execFileAsync("git", ["-C", source, "commit-tree", tree, "-p", parent, "-m", "pull request head"], { env: gitEnv })).stdout.trim();
  await execFileAsync("git", ["-C", source, "update-ref", "refs/pull/1/head", head], { env: gitEnv });
  await execFileAsync("git", ["-C", source, "config", "uploadpack.allowAnySHA1InWant", "false"], { env: gitEnv });
  const project: ProjectDefinition = {
    name: "demo", revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/PrepLabsAI/Sample-Project-A.git", path: "repo/demo", defaultBranch: "main", credentialRef: "demo-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
  const sleeps: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  const retry = { sleep: async (ms: number) => { sleeps.push(ms); }, log: (event: Record<string, unknown>) => { events.push(event); } };
  const workspace = async () => { const dir = await mkdtemp(join(root, "ws-")); return dir; };
  return { root, source, head, project, sleeps, events, retry, workspace };
}

function flaky(source: string, failures: Array<string | Error>, seen: string[] = []): RepositoryMaterializer {
  const queue = [...failures];
  return async (_repository, target, credential) => {
    seen.push(String(credential.password));
    const next = queue.shift();
    if (next !== undefined) throw next instanceof Error ? next : new Error(next);
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target], { env: gitEnv });
  };
}

describe("workspace clone retries only Git's 'Repository not found'", () => {
  it("retries after 2 s then 5 s with the same token, and logs each retry without the token", async () => {
    const f = await fixture();
    const seen: string[] = [];
    const manifest = await prepareWorkspace({
      rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry,
      credentialProvider: async () => ({ username: "x-access-token", password: "ghs_secretvalue" }),
      materializer: flaky(f.source, [NOT_FOUND, NOT_FOUND], seen),
    });
    expect(manifest.complete).toBe(true);
    expect(f.sleeps).toEqual([2_000, 5_000]);
    expect(seen).toEqual(["ghs_secretvalue", "ghs_secretvalue", "ghs_secretvalue"]);
    expect(f.events).toEqual([
      { event: "workspace.clone_retry", repository: "demo", attempt: 1, delayMs: 2_000, outcome: "repository_not_found" },
      { event: "workspace.clone_retry", repository: "demo", attempt: 2, delayMs: 5_000, outcome: "succeeded" },
    ]);
    expect(JSON.stringify(f.events)).not.toContain("ghs_secretvalue");
    expect(JSON.stringify(f.events)).not.toContain("github.com");
  });

  it("does not retry any other failure, nor one that appears on a retry", async () => {
    const f = await fixture();
    await expect(prepareWorkspace({
      rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry,
      materializer: flaky(f.source, ["fatal: Authentication failed for 'https://github.com/PrepLabsAI/Sample-Project-A.git/'"]),
    })).rejects.toThrow(/Authentication failed/);
    expect(f.sleeps).toEqual([]);
    expect(f.events).toEqual([]);
    const g = await fixture();
    await expect(prepareWorkspace({
      rootPath: await g.workspace(), project: g.project, readOnly: true, cloneRetry: g.retry,
      materializer: flaky(g.source, [NOT_FOUND, "fatal: unable to access: Could not resolve host"]),
    })).rejects.toThrow(/Could not resolve host/);
    expect(g.sleeps).toEqual([2_000]);
    expect(g.events.map((event) => event.outcome)).toEqual(["failed"]);
  });

  it("asks for a new token only when the held one is within 5 minutes of its hour", async () => {
    const f = await fixture();
    let clock = 1_000_000;
    let issued = 0;
    const seen: string[] = [];
    await prepareWorkspace({
      rootPath: await f.workspace(), project: f.project, readOnly: true,
      cloneRetry: { ...f.retry, now: () => clock, sleep: async (ms: number) => { f.sleeps.push(ms); clock += 56 * 60_000; } },
      credentialProvider: async () => { issued += 1; return { username: "x-access-token", password: `token-${String(issued)}` }; },
      materializer: flaky(f.source, [NOT_FOUND], seen),
    });
    expect(seen).toEqual(["token-1", "token-2"]);
    const g = await fixture();
    let fresh = 0;
    await prepareWorkspace({
      rootPath: await g.workspace(), project: g.project, readOnly: true, cloneRetry: g.retry,
      credentialProvider: async () => { fresh += 1; return { username: "x-access-token", password: "t" }; },
      materializer: flaky(g.source, [NOT_FOUND]),
    });
    expect(fresh).toBe(1);
  });

  it("retries the pull request head fetch the same way", async () => {
    const f = await fixture();
    const failures = [NOT_FOUND];
    const runner: CredentialedGitRunner = async (args, options) => {
      // A server that does not serve a commit by its sha (the first fetch), so that the pull request's own ref is fetched.
      if (args.includes("fetch") && args.includes(f.head)) throw new Error("fatal: remote error: upload-pack: not our ref");
      if (args.includes("fetch") && args.some((arg) => arg.includes("refs/pull/"))) {
        const next = failures.shift();
        if (next !== undefined) throw new Error(next);
      }
      // The worker's Git hardening refuses the file transport the fixture's remote uses.
      return execFileAsync("git", [...args], { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" }, encoding: "utf8" });
    };
    const manifest = await prepareWorkspace({
      rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry,
      materializer: flaky(f.source, []), gitRunner: runner,
      checkout: [{ repository: "demo", pullRequest: 1, headSha: f.head }],
      pullRequestRemote: () => pathToFileURL(f.source).href,
    });
    expect(manifest.repositories[0]?.checkedOut).toEqual({ pullRequest: 1, headSha: f.head });
    expect(f.sleeps).toEqual([2_000]);
    expect(f.events).toEqual([{ event: "workspace.clone_retry", repository: "demo", attempt: 1, delayMs: 2_000, outcome: "succeeded" }]);
  });
});

describe("P1: a setup run's preparation is held to the heads the broker pinned", () => {
  const headOf = async (source: string) => (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"], { env: gitEnv })).stdout.trim();
  it("refuses when the head differs from the pin, when a repository has no pin, and when the pin is for another repository; and reports no base", async () => {
    const f = await fixture();
    // A pin that is not a commit of the default branch (it never was, or the branch was rewritten): refused, with the sentence the broker reads to tell the owner and to pin again (never "try again" for ever).
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins: [{ repository: "demo", commit: "b".repeat(40) }] })).rejects.toThrow(PREPARE_PIN_MOVED_MARKER);
    // No pin for a repository (or a pin for another one) is the broker's own fault: refused as before.
    for (const pins of [[], [{ repository: "other", commit: await headOf(f.source) }]]) {
      await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins }), JSON.stringify(pins)).rejects.toThrow(/not at the commit the control plane pinned/u);
    }
  });
  // The default branch moves between the broker's pin and the clone (a machine takes minutes to boot): the preparation reads exactly the pinned commit, which is still on the branch. It never fails for a branch that only moved ahead.
  it("a default branch that moved ahead of the pin is read at the pin, not refused", async () => {
    const f = await fixture();
    const pin = await headOf(f.source);
    await writeFile(join(f.source, "later.txt"), "pushed after the pin\n", "utf8");
    await execFileAsync("git", ["-C", f.source, "add", "."], { env: gitEnv });
    await execFileAsync("git", ["-C", f.source, "commit", "--quiet", "-m", "later"], { env: gitEnv });
    const moved = await headOf(f.source);
    expect(moved).not.toBe(pin);
    const root = await f.workspace();
    const manifest = await prepareWorkspace({ rootPath: root, project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins: [{ repository: "demo", commit: pin }] });
    expect(manifest.repositories[0]).toMatchObject({ name: "demo", resolvedCommit: pin });
    expect((await execFileAsync("git", ["-C", join(root, "repo/demo"), "rev-parse", "HEAD"], { env: gitEnv })).stdout.trim()).toBe(pin);
    await expect(readFile(join(root, "repo/demo/later.txt"), "utf8")).rejects.toThrow();
    // A preparation with no pins (an ordinary task, a setup run) reads the head as it is now.
    const free = await f.workspace();
    expect((await prepareWorkspace({ rootPath: free, project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []) })).repositories[0]).toMatchObject({ resolvedCommit: moved });
    // A pin of the head itself is read as before.
    expect((await prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins: [{ repository: "demo", commit: moved }] })).repositories[0]).toMatchObject({ resolvedCommit: moved });
  });
  // The clone is shallow (a saved environment, a custom materializer) and the branch moved ahead by more commits than its depth: the pin is not in the clone, which means "unknown", never "moved away". It is fetched, the clone deepened, and the pin read.
  // MUTANT shallow: a pin missing from the clone is read as "the branch no longer holds it", so a busy branch fails the build.
  it("a shallow clone that does not hold the pin fetches it and reads it; every check says what it found in the log", async () => {
    const f = await fixture();
    const pin = await headOf(f.source);
    for (const n of [1, 2, 3]) {
      await writeFile(join(f.source, `later-${String(n)}.txt`), `${String(n)}\n`, "utf8");
      await execFileAsync("git", ["-C", f.source, "add", "."], { env: gitEnv });
      await execFileAsync("git", ["-C", f.source, "commit", "--quiet", "-m", `later ${String(n)}`], { env: gitEnv });
    }
    const shallow: RepositoryMaterializer = async (_repository, target, credential) => {
      void credential;
      await execFileAsync("git", ["clone", "--quiet", "--no-checkout", "--depth", "1", pathToFileURL(f.source).href, target], { env: gitEnv });
    };
    const runner: CredentialedGitRunner = async (args, options) => execFileAsync("git", [...args], { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" }, encoding: "utf8" });
    const logged: string[] = [];
    const root = await f.workspace();
    const manifest = await prepareWorkspace({
      rootPath: root, project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: shallow, gitRunner: runner, pullRequestRemote: () => pathToFileURL(f.source).href,
      pins: [{ repository: "demo", commit: pin }], onDiagnostic: (message) => { logged.push(message); },
    });
    expect(manifest.repositories[0]).toMatchObject({ resolvedCommit: pin });
    expect((await execFileAsync("git", ["-C", join(root, "repo/demo"), "rev-parse", "HEAD"], { env: gitEnv })).stdout.trim()).toBe(pin);
    // The log names the repository, the ref, the pinned and the resolved commit and the clone's mode (so a failure on prod is decidable).
    expect(logged.join("\n")).toMatch(new RegExp(`pin check passed.*repository demo, ref origin/main, pinned ${pin}, resolved [a-f0-9]{40}, clone shallow`, "u"));
    // A refused pin says the same in its error.
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins: [{ repository: "demo", commit: "b".repeat(40) }], onDiagnostic: (message) => { logged.push(message); } }))
      .rejects.toThrow(/repository demo, ref origin\/main, pinned b{40}, resolved [a-f0-9]{40}, clone full/u);
    expect(logged.join("\n")).toMatch(/pin check failed: the pin is not on the branch/u);
  });
  // MUTANT history: the check takes any commit the clone holds as "on the branch", so a pin the branch no longer contains (rewritten history, a commit of another ref) is read.
  it("a pin the branch no longer holds (rewritten history) is refused with the moved sentence, never read", async () => {
    const f = await fixture();
    const pin = await headOf(f.source);
    // The branch is rewritten: a new root commit replaces it, and the old commit stays only as another ref, which a clone of the branch does not bring.
    await execFileAsync("git", ["-C", f.source, "update-ref", "refs/heads/old-main", pin], { env: gitEnv });
    const tree = (await execFileAsync("git", ["-C", f.source, "rev-parse", "HEAD^{tree}"], { env: gitEnv })).stdout.trim();
    const root = (await execFileAsync("git", ["-C", f.source, "commit-tree", tree, "-m", "rewritten"], { env: gitEnv })).stdout.trim();
    await execFileAsync("git", ["-C", f.source, "update-ref", "refs/heads/main", root], { env: gitEnv });
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins: [{ repository: "demo", commit: pin }] })).rejects.toThrow(PREPARE_PIN_MOVED_MARKER);
  });
  it("a finished workspace is reused only when it holds each repository at its pin", async () => {
    const f = await fixture();
    const pin = await headOf(f.source);
    const root = await f.workspace();
    const options = { rootPath: root, project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []) };
    await prepareWorkspace({ ...options, pins: [{ repository: "demo", commit: pin }] });
    // Prepared again (the workspace is complete): the same pin is reused as it is, another pin, or none for a repository, is refused.
    await expect(prepareWorkspace({ ...options, pins: [{ repository: "demo", commit: pin }] })).resolves.toMatchObject({ complete: true });
    for (const pins of [[{ repository: "demo", commit: "b".repeat(40) }], [], [{ repository: "other", commit: pin }]]) {
      await expect(prepareWorkspace({ ...options, pins }), JSON.stringify(pins)).rejects.toThrow(/another commit than the control plane pinned/u);
    }
    // And a preparation without pins reuses it as before.
    await expect(prepareWorkspace(options)).resolves.toMatchObject({ complete: true });
  });
});
