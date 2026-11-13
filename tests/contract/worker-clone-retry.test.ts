import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@rovara-code/contracts";
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

  it("keeps the existing failure after the last attempt", async () => {
    const f = await fixture();
    await expect(prepareWorkspace({
      rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry,
      materializer: flaky(f.source, [NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND]),
    })).rejects.toThrow(/Repository not found/);
    expect(f.sleeps).toEqual([2_000, 5_000]);
    expect(f.events.map((event) => event.outcome)).toEqual(["repository_not_found", "repository_not_found"]);
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
  it("prepares when each repository's own resolution is exactly its pin", async () => {
    const f = await fixture();
    const pin = await headOf(f.source);
    const manifest = await prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins: [{ repository: "demo", commit: pin }] });
    expect(manifest.repositories.map((repository) => repository.resolvedCommit)).toEqual([pin]);
  });
  it("refuses when the head differs from the pin, when a repository has no pin, and when the pin is for another repository; and reports no base", async () => {
    const f = await fixture();
    for (const pins of [[{ repository: "demo", commit: "b".repeat(40) }], [], [{ repository: "other", commit: await headOf(f.source) }]]) {
      await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []), pins }), JSON.stringify(pins)).rejects.toThrow(/not at the commit the control plane pinned/u);
    }
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
  it("without pins (every other preparation) nothing changes", async () => {
    const f = await fixture();
    const manifest = await prepareWorkspace({ rootPath: await f.workspace(), project: f.project, readOnly: true, cloneRetry: f.retry, credentialProvider: async () => ({}), materializer: flaky(f.source, []) });
    expect(manifest.complete).toBe(true);
  });
  it("reports no base for a 64-hex commit (the broker's baseCommitSha is a 40-hex SHA-1: a longer one keeps no preparedBase, which fails closed)", async () => {
    const { preparedBaseResult } = await import("../../packages/worker/src/prepare.js");
    const long = "d".repeat(64);
    expect(preparedBaseResult({ repositories: [{ name: "demo", resolvedCommit: long }] } as never)).toEqual({});
    expect(preparedBaseResult({ repositories: [{ name: "demo", resolvedCommit: "short" }] } as never)).toEqual({});
  });
});
