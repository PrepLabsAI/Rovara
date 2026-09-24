import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishWorkspace } from "../../packages/worker/src/publish.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pull request publication", () => {
  it("replays the workspace tree onto the latest base without inheriting stale publication commits", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "ABOUT.md"), "old unpublished change\n", "utf8");
    await git(fixture.checkout, ["add", "ABOUT.md"]);
    await git(fixture.checkout, [
      "-c", "user.name=AgentX", "-c", "user.email=agentx@noreply.local",
      "commit", "-m", "AgentX: stale publication",
    ]);
    const staleCommit = (await git(fixture.checkout, ["rev-parse", "HEAD"])).trim();
    await git(fixture.checkout, [
      "-c", "user.name=AgentX", "-c", "user.email=agentx@noreply.local",
      "commit", "--allow-empty", "-m", "AgentX: stale retry",
    ]);

    await writeFile(join(fixture.seed, "UPSTREAM.md"), "upstream\n", "utf8");
    await git(fixture.seed, ["add", "UPSTREAM.md"]);
    await git(fixture.seed, [
      "-c", "user.name=Upstream", "-c", "user.email=upstream@example.test",
      "commit", "-m", "upstream change",
    ]);
    await git(fixture.seed, ["push", "origin", "main"]);
    const latestBase = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(fixture.checkout, "WORK.md"), "new work\n", "utf8");

    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: async () => ({
        number: 13,
        url: "https://github.com/example/demo/pull/13",
        reconciled: false,
      }),
    });

    const parents = (await git(fixture.checkout, ["rev-list", "--parents", "-n", "1", result.commit]))
      .trim().split(" ");
    expect(parents).toEqual([result.commit, latestBase]);
    expect(await git(fixture.checkout, ["rev-list", "--count", `origin/main..${result.commit}`])).toBe("1\n");
    await expect(git(fixture.checkout, ["merge-base", "--is-ancestor", staleCommit, result.commit])).rejects.toThrow();
    expect(await readFile(join(fixture.checkout, "UPSTREAM.md"), "utf8")).toBe("upstream\n");
    expect(await readFile(join(fixture.checkout, "WORK.md"), "utf8")).toBe("new work\n");
  });

  it("rejects workspace changes that conflict with the latest base before push", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "workspace\n", "utf8");
    await writeFile(join(fixture.seed, "README.md"), "upstream\n", "utf8");
    await git(fixture.seed, ["add", "README.md"]);
    await git(fixture.seed, [
      "-c", "user.name=Upstream", "-c", "user.email=upstream@example.test",
      "commit", "-m", "conflicting upstream change",
    ]);
    await git(fixture.seed, ["push", "origin", "main"]);
    const pullRequestSink = vi.fn();
    await expect(publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink,
    })).rejects.toThrow(/conflict with the latest default branch/i);
    expect(pullRequestSink).not.toHaveBeenCalled();
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/${fixture.invocation.payload.headBranch}`]))
      .rejects.toThrow();
  });

  it("runs registered checks, creates a deterministic commit, pushes without credentials, and requests a PR", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    let pullRequestCalls = 0;
    const pullRequestSink = vi.fn(async () => ({
      number: 12,
      url: "https://github.com/example/demo/pull/12",
      reconciled: pullRequestCalls++ > 0,
    }));

    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink,
    });

    expect(result).toMatchObject({
      repository: "demo",
      number: 12,
      headBranch: `agentx/${fixture.invocation.operationId}`,
      baseBranch: "main",
      reconciled: false,
      checks: [{ index: 0, outcome: "passed", exitCode: 0 }],
    });
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(pullRequestSink).toHaveBeenCalledWith(expect.objectContaining({ commit: result.commit }));
    const remoteCommit = await git(fixture.bare, ["rev-parse", `refs/heads/${result.headBranch}`]);
    expect(remoteCommit.trim()).toBe(result.commit);
    expect(await git(fixture.checkout, ["remote", "get-url", "origin"])).not.toContain("@");

    const retried = await publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink,
    });
    expect(retried).toMatchObject({ commit: result.commit, reconciled: true });
    expect(await git(fixture.bare, ["rev-list", "--count", `refs/heads/${result.headBranch}`])).toBe("2\n");
  });

  it("creates a pull request only after CodeBuild succeeds for the exact candidate", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "validated change\n", "utf8");
    const project = {
      ...fixture.invocation.payload.project,
      repositories: fixture.invocation.payload.project.repositories.map((repository) => ({
        ...repository,
        codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 5 }],
      })),
    };
    const invocation = {
      ...fixture.invocation,
      payload: { ...fixture.invocation.payload, project },
    } as Extract<WorkerInvocation, { kind: "publish" }>;
    const calls: string[] = [];
    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      codeBuildSink: async (request) => {
        calls.push(`build:${request.action}`);
        return {
          gate: request.gate,
          projectName: request.projectName,
          buildId: `${request.projectName}:${crypto.randomUUID()}`,
          status: "SUCCEEDED",
          requestedSourceVersion: request.commit,
          resolvedSourceVersion: request.commit,
        };
      },
      pullRequestSink: async () => {
        calls.push("pull-request");
        return { number: 22, url: "https://github.com/example/demo/pull/22", reconciled: false };
      },
    });
    expect(calls).toEqual(["build:start", "pull-request"]);
    expect(result.codeBuildChecks).toMatchObject([{ status: "SUCCEEDED", requestedSourceVersion: result.commit }]);
  });

  it("leaves the candidate branch but creates no pull request when CodeBuild fails", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "failing change\n", "utf8");
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
    } as Extract<WorkerInvocation, { kind: "publish" }>;
    const pullRequestSink = vi.fn();
    await expect(publishWorkspace({
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
      pullRequestSink,
    })).rejects.toThrow(/FAILED/);
    expect(pullRequestSink).not.toHaveBeenCalled();
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/${invocation.payload.headBranch}`]))
      .resolves.toMatch(/^[a-f0-9]{40}\n$/);
  });

  it("creates no side effect when there is no diff or a registered check fails", async () => {
    const empty = await createFixture();
    const emptyPushCredential = vi.fn(async () => ({}));
    const emptyPullRequest = vi.fn();
    await expect(publishWorkspace({
      rootPath: empty.root,
      invocation: empty.invocation,
      credentialProvider: emptyPushCredential,
      pullRequestSink: emptyPullRequest,
    })).rejects.toThrow(/no changes/i);
    expect(emptyPushCredential).not.toHaveBeenCalled();
    expect(emptyPullRequest).not.toHaveBeenCalled();

    const failed = await createFixture(false);
    await writeFile(join(failed.checkout, "README.md"), "changed\n", "utf8");
    const failedPushCredential = vi.fn(async () => ({}));
    const failedPullRequest = vi.fn();
    await expect(publishWorkspace({
      rootPath: failed.root,
      invocation: failed.invocation,
      credentialProvider: failedPushCredential,
      pullRequestSink: failedPullRequest,
    })).rejects.toThrow(/readiness checks failed/i);
    expect(failedPushCredential).toHaveBeenCalledOnce();
    expect(failedPullRequest).not.toHaveBeenCalled();

    const timedOut = await createFixture("timeout");
    await writeFile(join(timedOut.checkout, "README.md"), "changed\n", "utf8");
    await expect(publishWorkspace({
      rootPath: timedOut.root,
      invocation: timedOut.invocation,
      credentialProvider: failedPushCredential,
      pullRequestSink: failedPullRequest,
    })).rejects.toThrow(/readiness checks failed/i);
    expect(failedPushCredential).toHaveBeenCalledTimes(2);
    expect(failedPullRequest).not.toHaveBeenCalled();
  });

  it("fails a readiness command whose directory this workspace does not have", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    // Readiness follows the project's latest revision, which may name a repository this workspace
    // was never prepared with. The gate fails rather than being skipped.
    const invocation = structuredClone(fixture.invocation) as typeof fixture.invocation & {
      payload: { project: { readiness: Array<Record<string, unknown>> } };
    };
    invocation.payload.project.readiness = [{
      cwd: "repo/new-service",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutSeconds: 10,
    }];
    const pullRequest = vi.fn();

    await expect(publishWorkspace({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: pullRequest,
    })).rejects.toThrow(/readiness checks failed/i);
    expect(pullRequest).not.toHaveBeenCalled();
  });

  it("rejects conflicts and unregistered repository selection before push or PR creation", async () => {
    const conflicted = await createFixture();
    await git(conflicted.checkout, ["checkout", "-b", "ours"]);
    await writeFile(join(conflicted.checkout, "README.md"), "ours\n", "utf8");
    await git(conflicted.checkout, ["add", "README.md"]);
    await git(conflicted.checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "ours"]);
    await git(conflicted.checkout, ["checkout", "main"]);
    await git(conflicted.checkout, ["checkout", "-b", "theirs"]);
    await writeFile(join(conflicted.checkout, "README.md"), "theirs\n", "utf8");
    await git(conflicted.checkout, ["add", "README.md"]);
    await git(conflicted.checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "theirs"]);
    await git(conflicted.checkout, ["checkout", "ours"]);
    await expect(git(conflicted.checkout, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "merge", "theirs",
    ])).rejects.toThrow();
    expect(await git(conflicted.checkout, ["diff", "--name-only", "--diff-filter=U"])).toBe("README.md\n");
    const credentialProvider = vi.fn(async () => ({}));
    const pullRequestSink = vi.fn();
    await expect(publishWorkspace({
      rootPath: conflicted.root,
      invocation: conflicted.invocation,
      credentialProvider,
      pullRequestSink,
    })).rejects.toThrow(/unresolved merge conflicts/i);
    expect(credentialProvider).not.toHaveBeenCalled();
    expect(pullRequestSink).not.toHaveBeenCalled();

    const unknown = await createFixture();
    const unknownInvocation = {
      ...unknown.invocation,
      payload: { ...unknown.invocation.payload, repository: "not-registered" },
    } as Extract<WorkerInvocation, { kind: "publish" }>;
    await expect(publishWorkspace({
      rootPath: unknown.root,
      invocation: unknownInvocation,
      credentialProvider,
      pullRequestSink,
    })).rejects.toThrow(/not registered/i);
    expect(credentialProvider).not.toHaveBeenCalled();
    expect(pullRequestSink).not.toHaveBeenCalled();
  });

  it("creates a clean replacement result without rewriting the original branch", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "clean replacement\n", "utf8");
    const originalBranch = `agentx/${crypto.randomUUID()}`;
    await git(fixture.bare, ["branch", originalBranch, "main"]);
    const originalHead = (await git(fixture.bare, ["rev-parse", originalBranch])).trim();
    const invocation = {
      ...fixture.invocation,
      payload: { ...fixture.invocation.payload, mode: "replace", targetPullRequestNumber: 6 },
    } as const satisfies Extract<WorkerInvocation, { kind: "publish" }>;
    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: async () => ({
        number: 8,
        url: "https://github.com/example/demo/pull/8",
        reconciled: false,
      }),
    });
    expect(result).toMatchObject({ action: "replace", number: 8, replacementFor: 6 });
    expect(await git(fixture.bare, ["rev-parse", originalBranch])).toBe(`${originalHead}\n`);
  });

  it.each([false, true])("creates a reviewed revert for a %s-parent merged change", async (mergeCommit) => {
    const fixture = await createFixture();
    let commitToRevert: string;
    if (mergeCommit) {
      await git(fixture.seed, ["checkout", "-b", "feature"]);
      await writeFile(join(fixture.seed, "MERGED.md"), "merged feature\n", "utf8");
      await git(fixture.seed, ["add", "MERGED.md"]);
      await git(fixture.seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "feature"]);
      await git(fixture.seed, ["checkout", "main"]);
      await git(fixture.seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "merge", "--no-ff", "feature", "-m", "merge feature"]);
      commitToRevert = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    } else {
      await writeFile(join(fixture.seed, "MERGED.md"), "squashed feature\n", "utf8");
      await git(fixture.seed, ["add", "MERGED.md"]);
      await git(fixture.seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "squashed feature"]);
      commitToRevert = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    }
    await git(fixture.seed, ["push", "origin", "main"]);
    const invocation = {
      ...fixture.invocation,
      payload: {
        ...fixture.invocation.payload,
        mode: "revert",
        targetPullRequestNumber: 5,
        revertCommit: commitToRevert,
      },
    } as const satisfies Extract<WorkerInvocation, { kind: "publish" }>;
    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: async () => ({
        number: 9,
        url: "https://github.com/example/demo/pull/9",
        reconciled: false,
      }),
    });
    expect(result).toMatchObject({ action: "revert", number: 9 });
    await expect(readFile(join(fixture.checkout, "MERGED.md"), "utf8")).rejects.toThrow();
  });

  it("creates no remote branch when a merged revert conflicts with later base changes", async () => {
    const fixture = await createFixture();
    await git(fixture.seed, ["checkout", "-b", "conflicting-feature"]);
    await writeFile(join(fixture.seed, "README.md"), "feature version\n", "utf8");
    await git(fixture.seed, ["add", "README.md"]);
    await git(fixture.seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "feature version"]);
    await git(fixture.seed, ["checkout", "main"]);
    await git(fixture.seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "merge", "--no-ff", "conflicting-feature", "-m", "merge feature"]);
    const mergeCommit = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(fixture.seed, "README.md"), "later base version\n", "utf8");
    await git(fixture.seed, ["add", "README.md"]);
    await git(fixture.seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "later base edit"]);
    await git(fixture.seed, ["push", "origin", "main"]);
    const invocation = {
      ...fixture.invocation,
      payload: {
        ...fixture.invocation.payload,
        mode: "revert",
        targetPullRequestNumber: 5,
        revertCommit: mergeCommit,
      },
    } as const satisfies Extract<WorkerInvocation, { kind: "publish" }>;
    const sink = vi.fn();
    await expect(publishWorkspace({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: sink,
    })).rejects.toThrow(/cannot be reverted cleanly/i);
    expect(sink).not.toHaveBeenCalled();
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/${invocation.payload.headBranch}`])).rejects.toThrow();
  });
});

async function createFixture(checkPasses: boolean | "timeout" = true) {
  const root = await mkdtemp(join(tmpdir(), "agentx-publish-test-"));
  temporaryDirectories.push(root);
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "repo", "demo");
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await git(root, ["init", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "initial\n", "utf8");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
  await git(seed, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(seed, ["push", "origin", "main"]);
  await mkdir(join(root, "repo"), { recursive: true });
  await git(root, ["clone", "--branch", "main", pathToFileURL(bare).href, checkout]);
  const resolvedCommit = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const remoteUrl = (await git(checkout, ["remote", "get-url", "origin"])).trim();
  const operationId = crypto.randomUUID();
  const project = {
    name: "demo",
    revision: 1,
    repositories: [{
      name: "demo",
      url: remoteUrl,
      path: "repo/demo",
      defaultBranch: "main",
      credentialRef: "github-app",
    }],
    setup: [],
    readiness: [{
      cwd: "repo/demo",
      executable: process.execPath,
      args: [
        "-e",
        checkPasses === "timeout"
          ? "setInterval(() => undefined, 10000)"
          : checkPasses
            ? "process.exit(0)"
            : "process.exit(9)",
      ],
      timeoutSeconds: checkPasses === "timeout" ? 1 : 10,
    }],
    orchestratorInstructions: "Delegate coding work.",
  } as const;
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    projectName: "demo",
    projectRevision: 1,
    // A manifest written before the environment pin was removed still carries it.
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    repositories: [{
      name: "demo",
      path: "repo/demo",
      defaultBranch: "main",
      resolvedCommit,
      resolvedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }],
    completedSetupSteps: [],
    readinessResults: [],
    creationIdentity: "test",
    complete: true,
    updatedAt: new Date().toISOString(),
  }), "utf8");
  const invocation = {
    protocolVersion: 1,
    kind: "publish",
    operationId,
    workspaceId: crypto.randomUUID(),
    fence: 2,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {
      project,
      repository: "demo",
      title: "Publish demo change",
      body: "Validated by AgentX.",
      headBranch: `agentx/${operationId}`,
      repositoryGrant: "push-grant",
    },
  } as const satisfies Extract<WorkerInvocation, { kind: "publish" }>;
  return { root, bare, seed, checkout, invocation };
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout;
}
