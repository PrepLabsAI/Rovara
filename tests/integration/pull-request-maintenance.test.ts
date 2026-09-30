import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pull request maintenance", () => {
  it("redacts a Git error before it is cut (#170 review)", async () => {
    const token = `ghp_${"M1n2B3v4C5".repeat(4)}`;
    // Git names the missing remote, whose path holds a token, in its error.
    const fixture = await createFixture("sync", `remote-${token}.git`);
    await rm(fixture.bare, { recursive: true, force: true });
    const failure = await maintainPullRequest({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestUpdateSink: vi.fn(),
    }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("[REDACTED]");
    expect(failure?.message).not.toContain(token.slice(4));
  });

  it("appends checked workspace changes with one ordinary fast-forward push", async () => {
    const fixture = await createFixture("append");
    await writeFile(join(fixture.checkout, "FIRST.md"), "first unpublished commit\n", "utf8");
    await git(fixture.checkout, ["add", "FIRST.md"]);
    await commit(fixture.checkout, "first unpublished commit");
    await writeFile(join(fixture.checkout, "SECOND.md"), "second unpublished commit\n", "utf8");
    await git(fixture.checkout, ["add", "SECOND.md"]);
    await commit(fixture.checkout, "second unpublished commit");
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    const sink = vi.fn(async () => ({
      url: "https://github.com/example/demo/pull/7",
      state: "open" as const,
      reconciled: false,
    }));
    const result = await maintainPullRequest({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestUpdateSink: sink,
    });
    expect(result).toMatchObject({ action: "append", previousCommit: fixture.pullRequestHead });
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${result.commit}\n`);
    expect(await git(fixture.checkout, ["rev-list", "--parents", "-n", "1", result.commit])).toBe(
      `${result.commit} ${fixture.pullRequestHead}\n`,
    );
    expect(await git(fixture.checkout, ["rev-list", "--count", `${fixture.pullRequestHead}..${result.commit}`])).toBe("1\n");
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      previousCommit: fixture.pullRequestHead,
      commit: result.commit,
    }));
  });

  it("rejects a stale recorded head before changing a remote branch", async () => {
    const fixture = await createFixture("append");
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    const stale = {
      ...fixture.invocation,
      payload: { ...fixture.invocation.payload, expectedHeadCommit: "f".repeat(40) },
    } as Extract<WorkerInvocation, { kind: "maintain" }>;
    const sink = vi.fn();
    await expect(maintainPullRequest({
      rootPath: fixture.root,
      invocation: stale,
      credentialProvider: async () => ({}),
      pullRequestUpdateSink: sink,
    })).rejects.toThrow(/head changed/i);
    expect(sink).not.toHaveBeenCalled();
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
  });

  it("keeps the visible PR head unchanged when a validation-branch CodeBuild gate fails", async () => {
    const fixture = await createFixture("append");
    await writeFile(join(fixture.checkout, "APPEND.md"), "candidate\n", "utf8");
    const invocation = {
      ...fixture.invocation,
      payload: {
        ...fixture.invocation.payload,
        project: {
          ...fixture.invocation.payload.project,
          repositories: fixture.invocation.payload.project.repositories.map((repository) => ({
            ...repository,
            codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 5 }],
          })),
        },
      },
    } as Extract<WorkerInvocation, { kind: "maintain" }>;
    const sink = vi.fn();
    await expect(maintainPullRequest({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      codeBuildSink: async (request) => ({
        gate: request.gate,
        projectName: request.projectName,
        buildId: `${request.projectName}:${crypto.randomUUID()}`,
        status: "FAILED",
        requestedSourceVersion: request.commit,
      }),
      pullRequestUpdateSink: sink,
    })).rejects.toThrow(/FAILED/);
    expect(sink).not.toHaveBeenCalled();
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/agentx/${invocation.operationId}`]))
      .resolves.toMatch(/^[a-f0-9]{40}\n$/);
  });

  it("fast-forwards the visible PR head only after a validation gate succeeds", async () => {
    const fixture = await createFixture("append");
    await writeFile(join(fixture.checkout, "APPEND.md"), "validated candidate\n", "utf8");
    const invocation = {
      ...fixture.invocation,
      payload: {
        ...fixture.invocation.payload,
        project: {
          ...fixture.invocation.payload.project,
          repositories: fixture.invocation.payload.project.repositories.map((repository) => ({
            ...repository,
            codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 5 }],
          })),
        },
      },
    } as Extract<WorkerInvocation, { kind: "maintain" }>;
    const calls: string[] = [];
    const result = await maintainPullRequest({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      codeBuildSink: async (request) => {
        calls.push("build");
        return {
          gate: request.gate,
          projectName: request.projectName,
          buildId: `${request.projectName}:${crypto.randomUUID()}`,
          status: "SUCCEEDED",
          requestedSourceVersion: request.commit,
          resolvedSourceVersion: request.commit,
        };
      },
      pullRequestUpdateSink: async () => {
        calls.push("pull-request-update");
        return {
          url: "https://github.com/example/demo/pull/7",
          state: "open",
          reconciled: false,
        };
      },
    });
    expect(calls).toEqual(["build", "pull-request-update"]);
    expect(result.codeBuildChecks).toMatchObject([{ status: "SUCCEEDED", requestedSourceVersion: result.commit }]);
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${result.commit}\n`);
    await expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.pullRequestHead, result.commit]))
      .resolves.toBe("");
  });

  it("syncs the latest base with a merge commit and never rewrites the PR head", async () => {
    const fixture = await createFixture("sync");
    await writeFile(join(fixture.seed, "UPSTREAM.md"), "latest base\n", "utf8");
    await git(fixture.seed, ["add", "UPSTREAM.md"]);
    await commit(fixture.seed, "upstream");
    await git(fixture.seed, ["push", "origin", "main"]);
    const latestBase = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    const result = await maintainPullRequest({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestUpdateSink: async () => ({
        url: "https://github.com/example/demo/pull/7",
        state: "open",
        reconciled: false,
      }),
    });
    const parents = (await git(fixture.checkout, ["rev-list", "--parents", "-n", "1", result.commit])).trim().split(" ");
    expect(parents).toEqual([result.commit, fixture.pullRequestHead, latestBase]);
    await expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.pullRequestHead, result.commit]))
      .resolves.toBe("");
  });

  it("aborts a conflicting sync without pushing", async () => {
    const fixture = await createFixture("sync");
    await writeFile(join(fixture.checkout, "README.md"), "pull request version\n", "utf8");
    await git(fixture.checkout, ["add", "README.md"]);
    await commit(fixture.checkout, "PR conflict");
    await git(fixture.checkout, ["push", "origin", fixture.headBranch]);
    const head = (await git(fixture.checkout, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(fixture.seed, "README.md"), "base version\n", "utf8");
    await git(fixture.seed, ["add", "README.md"]);
    await commit(fixture.seed, "base conflict");
    await git(fixture.seed, ["push", "origin", "main"]);
    const invocation = {
      ...fixture.invocation,
      payload: { ...fixture.invocation.payload, expectedHeadCommit: head },
    } as Extract<WorkerInvocation, { kind: "maintain" }>;
    const sink = vi.fn();
    await expect(maintainPullRequest({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      pullRequestUpdateSink: sink,
    })).rejects.toThrow(/conflicts with the latest base/i);
    expect(sink).not.toHaveBeenCalled();
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${head}\n`);
  });
});

async function createFixture(action: "append" | "sync", remoteName = "remote.git") {
  const root = await mkdtemp(join(tmpdir(), "agentx-maintain-test-"));
  temporaryDirectories.push(root);
  const bare = join(root, remoteName);
  const seed = join(root, "seed");
  const checkout = join(root, "repo", "demo");
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await git(root, ["init", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "initial\n", "utf8");
  await git(seed, ["add", "README.md"]);
  await commit(seed, "initial");
  await git(seed, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(seed, ["push", "origin", "main"]);
  await mkdir(join(root, "repo"), { recursive: true });
  await git(root, ["clone", "--branch", "main", pathToFileURL(bare).href, checkout]);
  const preparedCommit = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const operationId = crypto.randomUUID();
  const headBranch = `agentx/${operationId}`;
  await git(checkout, ["checkout", "-b", headBranch]);
  await writeFile(join(checkout, "FEATURE.md"), "feature\n", "utf8");
  await git(checkout, ["add", "FEATURE.md"]);
  await commit(checkout, "feature");
  await git(checkout, ["push", "origin", headBranch]);
  const pullRequestHead = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const remoteUrl = (await git(checkout, ["remote", "get-url", "origin"])).trim();
  const project = {
    name: "demo",
    revision: 1,
    repositories: [{ name: "demo", url: remoteUrl, path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [],
    readiness: [{ cwd: "repo/demo", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutSeconds: 10 }],
    orchestratorInstructions: "Delegate coding work.",
  } as const;
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    projectName: "demo",
    projectRevision: 1,
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    repositories: [{
      name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: preparedCommit,
      resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "test", complete: true,
    updatedAt: new Date().toISOString(),
  }), "utf8");
  const invocation = {
    protocolVersion: 1,
    kind: "maintain",
    operationId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    fence: 3,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {
      action, project, repository: "demo", pullRequestNumber: 7, headBranch, baseBranch: "main",
      expectedHeadCommit: pullRequestHead, repositoryGrant: "push-grant",
    },
  } as const satisfies Extract<WorkerInvocation, { kind: "maintain" }>;
  return { root, bare, seed, checkout, invocation, headBranch, pullRequestHead };
}

async function commit(directory: string, message: string): Promise<void> {
  await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message]);
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout;
}
