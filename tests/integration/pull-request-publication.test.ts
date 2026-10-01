import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishWorkspace, runReadinessChecks } from "../../packages/worker/src/publish.js";
import { storedCommandOutput } from "../../packages/worker/src/command-failure.js";
import { TIMEOUT_KILL_GRACE_MS } from "../../packages/worker/src/collected-process.js";
import type { DevcontainerCli, DevcontainerProcess } from "../../packages/worker/src/devcontainer.js";
import type { PreparationManifest } from "../../packages/worker/src/prepare.js";

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

// #170: a check's output is stored redacted, its last lines kept, and its outcome says what happened.
describe("publication check results (#170)", () => {
  const TOKEN = `ghp_${"Z9y8X7w6V5".repeat(4)}`;

  function withReadiness(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    readiness: Array<Record<string, unknown>>,
  ): typeof fixture.invocation {
    const invocation = structuredClone(fixture.invocation) as typeof fixture.invocation & {
      payload: { project: { readiness: Array<Record<string, unknown>> } };
    };
    invocation.payload.project.readiness = readiness;
    return invocation;
  }

  it("stores a token a check prints redacted, never raw in the operation result, the workspace files or the logs", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    const script = `console.log("using ${TOKEN} for the registry"); console.error("auth with ${TOKEN} ok")`;
    const invocation = withReadiness(fixture, [{ cwd: "repo/demo", executable: process.execPath, args: ["-e", script], timeoutSeconds: 10 }]);
    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "info").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { logged.push(String(chunk)); return true; }),
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { logged.push(String(chunk)); return true; }),
    ];
    let result: Awaited<ReturnType<typeof publishWorkspace>>;
    try {
      // The worker sends this result, unchanged, as the operation's terminal result (server.ts).
      result = await publishWorkspace({
        rootPath: fixture.root,
        invocation,
        credentialProvider: async () => ({}),
        pullRequestSink: async () => ({ number: 7, url: "https://github.com/example/demo/pull/7", reconciled: false }),
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(result.checks[0]).toMatchObject({
      outcome: "passed",
      stdout: "using [REDACTED] for the registry\n",
      stderr: "auth with [REDACTED] ok\n",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const file of await filesUnder(join(fixture.root, ".agentx"))) {
      expect(await readFile(file, "utf8")).not.toContain(TOKEN);
    }
    expect(logged.join("\n")).not.toContain(TOKEN);
  }, 30_000);

  it("keeps the last lines of more than 1 MiB of output, redacted before the cut", async () => {
    const fixture = await createFixture();
    const script = `process.stdout.write("line of output\\n".repeat(200000)); console.log("last line ${TOKEN}")`;
    const [check] = await runReadinessChecks(fixture.root, withReadiness(fixture, [
      { cwd: "repo/demo", executable: process.execPath, args: ["-e", script], timeoutSeconds: 20 },
    ]), await manifestOf(fixture));
    expect(check!.stdout.length).toBeLessThanOrEqual(1_048_576);
    expect(check!.stdout.endsWith("last line [REDACTED]\n")).toBe(true);
    expect(check!.stdout.startsWith("line of output\n")).toBe(true);
    expect(check!.stdout).not.toContain(TOKEN);
  }, 30_000);

  it("redacts stored output before cutting it, and starts a cut output at a whole line", () => {
    // Cut first, the last 30 characters would keep the token's end, which no pattern matches.
    expect(storedCommandOutput(`${"x".repeat(10)}${TOKEN}\nlast\n`, 30)).toBe(`${"x".repeat(10)}[REDACTED]\nlast\n`);
    expect(storedCommandOutput(`${"a".repeat(50)}\nsecond ${TOKEN}\nthird\n`, 40)).toBe("second [REDACTED]\nthird\n");
    // A Git error cut to its last 16 KiB, with a token across the cut.
    // Cut first, the last 16 KiB would start 20 characters into the token.
    const gitError = `${TOKEN}\n${"r".repeat(16_384 + 20 - TOKEN.length - 16)}\nfatal: failed\n`;
    const shownError = storedCommandOutput(gitError, 16_384);
    expect(shownError).not.toContain(TOKEN.slice(-10));
    expect(shownError.endsWith("fatal: failed\n")).toBe(true);
  });

  it("redacts a Git error before it is cut (#170 review)", async () => {
    // Git names the missing remote, whose path holds a token, in its error.
    const fixture = await createFixture(true, `remote-${TOKEN}.git`);
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    await rm(fixture.bare, { recursive: true, force: true });
    const failure = await publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: vi.fn(),
    }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("[REDACTED]");
    expect(failure?.message).not.toContain(TOKEN.slice(4));
  });

  it("says timed_out only when the timer fired: a signal or a failed start is a failure", async () => {
    const fixture = await createFixture();
    const checks = await runReadinessChecks(fixture.root, withReadiness(fixture, [
      { cwd: "repo/demo", executable: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"], timeoutSeconds: 10 },
      { cwd: "repo/demo", executable: "agentx-no-such-check-170", args: [], timeoutSeconds: 10 },
      { cwd: "repo/demo", executable: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"], timeoutSeconds: 1 },
    ]), await manifestOf(fixture));
    expect(checks.map((check) => [check.exitCode, check.outcome])).toEqual([[-1, "failed"], [-1, "failed"], [-1, "timed_out"]]);
    expect(checks[0]!.stderr).toContain("readiness command 0 was killed by SIGKILL");
    expect(checks[1]!.stderr).toContain("ENOENT");
    expect(checks[2]!.stderr).toContain("readiness command 2 timed out after 1 s");
  }, 30_000);
});

// #183: publication runs each readiness check where preparation did: in the devcontainer the
// preparation manifest records, otherwise on the host.
describe("publication checks in a devcontainer (#183)", () => {
  const TOKEN = `ghp_${"Q1w2E3r4T5".repeat(4)}`;
  // Not on the worker host: a check that runs on the host fails to start.
  const CONTAINER_ONLY = "agentx-container-only-check-183";

  function withReadiness(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    readiness: Array<Record<string, unknown>>,
  ): typeof fixture.invocation {
    const invocation = structuredClone(fixture.invocation) as typeof fixture.invocation & {
      payload: { project: { readiness: Array<Record<string, unknown>> } };
    };
    invocation.payload.project.readiness = readiness;
    return invocation;
  }

  it("runs a devcontainer project's check through devcontainer exec, after starting the container", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    const invocation = withReadiness(fixture, [{ cwd: "repo/demo", executable: CONTAINER_ONLY, args: ["--all"], timeoutSeconds: 30 }]);
    const { cli, calls } = fakeCli(() => ({ exitCode: 0, stdout: "checked in the container\n", stderr: "" }));

    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: async () => ({ number: 8, url: "https://github.com/example/demo/pull/8", reconciled: false }),
      devcontainerCli: cli,
    });

    const root = await realpath(fixture.root);
    const workspaceFolder = join(root, "repo/demo");
    const configPath = join(root, "repo/demo/.devcontainer/devcontainer.json");
    expect(result.checks).toEqual([expect.objectContaining({
      index: 0, cwd: "repo/demo", executable: CONTAINER_ONLY, exitCode: 0, outcome: "passed",
      stdout: "checked in the container\n", stderr: "",
    })]);
    // A resumed instance has its containers stopped, so publication starts it first, as a task does.
    expect(calls.map((args) => args[0])).toEqual(["up", "exec"]);
    expect(calls[0]!.slice(0, 5)).toEqual(["up", "--workspace-folder", workspaceFolder, "--config", configPath]);
    const exec = calls[1]!;
    expect(exec.slice(0, 7)).toEqual(["exec", "--workspace-folder", workspaceFolder, "--config", configPath, "bash", "-c"]);
    expect(exec[7]).toContain('exec "$@"');
    expect(exec[8]).toBe("bash");
    expect(exec[9]).toBe(workspaceFolder);
    expect(exec[10]).toMatch(/^\/tmp\/agentx-command-[0-9a-f-]+\.pgid$/);
    expect(exec.slice(11)).toEqual([CONTAINER_ONLY, "--all"]);
  });

  it("fails a devcontainer project's check that fails in the container, and pushes nothing", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    const { cli } = fakeCli(() => ({ exitCode: 2, stdout: "", stderr: "lint failed\n" }));
    const sink = vi.fn();
    await expect(publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: sink,
      devcontainerCli: cli,
    })).rejects.toThrow(/readiness checks failed/i);
    expect(sink).not.toHaveBeenCalled();
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/${fixture.invocation.payload.headBranch}`])).rejects.toThrow();
  });

  it("runs a project's check on the host when preparation recorded no devcontainer", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    const { cli, calls } = fakeCli();
    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation: withReadiness(fixture, [{ cwd: "repo/demo", executable: process.execPath, args: ["-e", "console.log('on the host')"], timeoutSeconds: 10 }]),
      credentialProvider: async () => ({}),
      pullRequestSink: async () => ({ number: 9, url: "https://github.com/example/demo/pull/9", reconciled: false }),
      devcontainerCli: cli,
    });
    expect(result.checks).toEqual([expect.objectContaining({ outcome: "passed", stdout: "on the host\n" })]);
    expect(calls).toEqual([]);
  });

  it("stops a timed-out check inside the container: TERM to its process group, then KILL", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    const { cli, calls, kills } = stoppableCli();
    const started = Date.now();
    const [check] = await runReadinessChecks(
      await realpath(fixture.root),
      withReadiness(fixture, [{ cwd: "repo/demo", executable: "sleep", args: ["300"], timeoutSeconds: 1 }]),
      await manifestOf(fixture),
      { devcontainerCli: cli },
    );
    expect(check).toMatchObject({ index: 0, exitCode: -1, outcome: "timed_out" });
    expect(check!.stderr).toContain("readiness command 0 timed out after 1 s");
    const groupFile = calls.find((args) => args.includes("sleep"))![10]!;
    expect(kills().map((args) => args.at(-1))).toEqual([groupFile, groupFile]);
    expect(kills()[0]!.some((arg) => arg.includes("kill -TERM"))).toBe(true);
    expect(kills()[1]!.some((arg) => arg.includes("kill -KILL"))).toBe(true);
    // The TERM step, then the grace period before KILL: the check did not end at its own timeout.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000 + TIMEOUT_KILL_GRACE_MS);
  }, 30_000);

  it("says in a timed-out check's stored output when the container refused to stop it", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    const { cli } = stoppableCli({ kill: async () => ({ exitCode: 1, stdout: "bash: kill: (4242) - Operation not permitted\n", stderr: "" }) });
    const [check] = await runReadinessChecks(
      await realpath(fixture.root),
      withReadiness(fixture, [{ cwd: "repo/demo", executable: "sleep", args: ["300"], timeoutSeconds: 1 }]),
      await manifestOf(fixture),
      { devcontainerCli: cli },
    );
    expect(check!.outcome).toBe("timed_out");
    expect(check!.stderr).toContain("AgentX could not stop the command in the container (TERM): bash: kill: (4242) - Operation not permitted");
  }, 30_000);

  it("stores a devcontainer check's output redacted and cut to its last lines, as on the host (#170)", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    const { cli } = fakeCli(() => ({
      exitCode: 0,
      stdout: `${"line of output\n".repeat(200_000)}last line ${TOKEN}\n`,
      stderr: `auth with ${TOKEN} ok\n`,
    }));
    const result = await publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: async () => ({ number: 10, url: "https://github.com/example/demo/pull/10", reconciled: false }),
      devcontainerCli: cli,
    });
    const [check] = result.checks;
    expect(check!.outcome).toBe("passed");
    expect(check!.stdout.length).toBeLessThanOrEqual(1_048_576);
    expect(check!.stdout.startsWith("line of output\n")).toBe(true);
    expect(check!.stdout.endsWith("last line [REDACTED]\n")).toBe(true);
    expect(check!.stderr).toBe("auth with [REDACTED] ok\n");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const file of await filesUnder(join(fixture.root, ".agentx"))) {
      expect(await readFile(file, "utf8")).not.toContain(TOKEN);
    }
  }, 30_000);

  it("fails a check that cannot run because the container has no bash, saying why", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    const { cli } = fakeCli(() => ({ exitCode: 127, stdout: "", stderr: NO_BASH }));
    const [check] = await runReadinessChecks(await realpath(fixture.root), fixture.invocation, await manifestOf(fixture), { devcontainerCli: cli });
    expect(check).toMatchObject({ index: 0, exitCode: -1, outcome: "failed" });
    expect(check!.stderr).toContain("the container has no bash");
  });

  it("refuses to publish when the devcontainer does not start, and pushes nothing", async () => {
    const fixture = await createFixture(true, "remote.git", { devcontainer: true });
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    const calls: string[][] = [];
    const cli: DevcontainerCli = {
      run: async (args) => {
        calls.push([...args]);
        return { exitCode: 1, stdout: "{\"outcome\":\"error\",\"message\":\"Docker is not running\"}", stderr: "" };
      },
    };
    const sink = vi.fn();
    await expect(publishWorkspace({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestSink: sink,
      devcontainerCli: cli,
    })).rejects.toThrow("devcontainer did not start: Docker is not running");
    expect(calls.map((args) => args[0])).toEqual(["up"]);
    expect(sink).not.toHaveBeenCalled();
    await expect(git(fixture.bare, ["rev-parse", `refs/heads/${fixture.invocation.payload.headBranch}`])).rejects.toThrow();
  });

  it("is what the project configuration guide says", async () => {
    const guide = await readFile("docs/project-configuration.md", "utf8");
    expect(guide).toContain(
      "Readiness runs when the workspace is prepared and again before each pull request is published or updated, "
      + "each time inside the dev container when the project has one.",
    );
  });
});

const NO_BASH = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown';
const UP_OUTPUT = "{\"outcome\":\"success\",\"containerId\":\"f832494aef96\",\"remoteUser\":\"node\",\"remoteWorkspaceFolder\":\"/workspaces/demo\"}";

/** A fake `devcontainer` CLI: `up` succeeds, and `exec` answers with `execResult`. */
function fakeCli(execResult: (args: readonly string[]) => DevcontainerProcess = () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const calls: string[][] = [];
  const cli: DevcontainerCli = {
    run: (args) => {
      calls.push([...args]);
      return Promise.resolve(args[0] === "up" ? { exitCode: 0, stdout: UP_OUTPUT, stderr: "" } : execResult(args));
    },
  };
  return { cli, calls };
}

/** A fake `devcontainer` CLI whose command runs until its client is aborted, and whose kill execs answer with `kill`. */
function stoppableCli(behaviour: { kill?: () => Promise<DevcontainerProcess> } = {}) {
  const calls: string[][] = [];
  const isKill = (args: readonly string[]) => args.some((arg) => arg.includes("kill -TERM") || arg.includes("kill -KILL"));
  const cli: DevcontainerCli = {
    run: (args, options) => {
      calls.push([...args]);
      if (args[0] === "up") return Promise.resolve({ exitCode: 0, stdout: UP_OUTPUT, stderr: "" });
      if (isKill(args)) return behaviour.kill?.() ?? Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      return new Promise((resolveRun) => {
        options.signal?.addEventListener("abort", () => resolveRun({ exitCode: null, stdout: "", stderr: "" }), { once: true });
      });
    },
  };
  return { cli, calls, kills: () => calls.filter(isKill) };
}

async function manifestOf(fixture: { root: string }): Promise<PreparationManifest> {
  return JSON.parse(await readFile(join(fixture.root, ".agentx", "preparation-manifest.json"), "utf8")) as PreparationManifest;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function createFixture(
  checkPasses: boolean | "timeout" = true,
  remoteName = "remote.git",
  options: { devcontainer?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "agentx-publish-test-"));
  temporaryDirectories.push(root);
  const bare = join(root, remoteName);
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
    ...(options.devcontainer === true ? { devcontainer: { repository: "demo" } } : {}),
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
    // Preparation records the devcontainer it started (#121).
    ...(options.devcontainer === true
      ? { devcontainer: { repository: "demo", configPath: "repo/demo/.devcontainer/devcontainer.json", containerId: "f832494aef96", startedAt: new Date().toISOString() } }
      : {}),
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
