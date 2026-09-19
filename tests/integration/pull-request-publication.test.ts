import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    expect(failedPushCredential).not.toHaveBeenCalled();
    expect(failedPullRequest).not.toHaveBeenCalled();

    const timedOut = await createFixture("timeout");
    await writeFile(join(timedOut.checkout, "README.md"), "changed\n", "utf8");
    await expect(publishWorkspace({
      rootPath: timedOut.root,
      invocation: timedOut.invocation,
      credentialProvider: failedPushCredential,
      pullRequestSink: failedPullRequest,
    })).rejects.toThrow(/readiness checks failed/i);
    expect(failedPushCredential).not.toHaveBeenCalled();
    expect(failedPullRequest).not.toHaveBeenCalled();
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
    await expect(git(conflicted.checkout, ["merge", "theirs"])).rejects.toThrow();
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
    schemaVersion: 2,
    name: "demo",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
    environment: { image: `example.test/agentx@sha256:${"a".repeat(64)}` },
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
    environmentDigest: project.environment.image,
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
  return { root, bare, checkout, invocation };
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout;
}
