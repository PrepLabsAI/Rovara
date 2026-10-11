import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";
import type { DevcontainerCli, DevcontainerProcess } from "../../packages/worker/src/devcontainer.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

// The fixtures' remotes are local bare repositories, which AgentX's hardened Git (HTTPS only) allows
// through its test seam; every other hardened setting stays in force.
// No real credential helper, global or system config, or HOME takes part either.
let disallowFileTransport: () => void = () => undefined;
beforeEach(async () => {
  disallowFileTransport = allowGitFileTransportForTests();
  const home = await mkdtemp(join(tmpdir(), "agentx-git-home-"));
  temporaryDirectories.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});

afterEach(async () => {
  disallowFileTransport();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pull request maintenance", () => {
  it("refuses to append to a Git LFS repository, and pushes nothing", async () => {
    const fixture = await createFixture("append");
    await writeFile(join(fixture.checkout, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n", "utf8");
    await writeFile(join(fixture.checkout, "model.bin"), "weights\n", "utf8");
    await expect(maintainPullRequest({
      rootPath: fixture.root,
      invocation: fixture.invocation,
      credentialProvider: async () => ({}),
      pullRequestUpdateSink: vi.fn(),
    })).rejects.toThrow(
      "CONFIG_INVALID: Git LFS repositories are not supported yet: this repository stores files with Git LFS (filter=lfs in .gitattributes).",
    );
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
  });

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

  describe("pushing a reviewed fix (workflow task)", () => {
    // The project's readiness check fails here: a reviewed fix's checks ran already, on this tree, so none may run again.
    const failingReadiness = (invocation: Extract<WorkerInvocation, { kind: "maintain" }>, workflowCandidateTreeSha: string, extra: Record<string, unknown> = {}) => ({
      ...invocation,
      payload: {
        ...invocation.payload,
        workflowCandidateTreeSha,
        ...extra,
        project: {
          ...invocation.payload.project,
          readiness: [{ cwd: "repo/demo", executable: process.execPath, args: ["-e", "process.exit(1)"], timeoutSeconds: 10 }],
        },
      },
    }) as Extract<WorkerInvocation, { kind: "maintain" }>;
    const sink = () => vi.fn(async () => ({ url: "https://github.com/example/demo/pull/7", state: "open" as const, reconciled: false }));
    // Nothing is left running from the workspace, so the real process and container sweeps are not needed.
    const pushFix = (options: Parameters<typeof maintainPullRequest>[0]) => maintainPullRequest({
      stopWorkspaceProcesses: async () => ({ stopped: 0 }),
      sweepWorkspaceContainers: async () => ({ removed: 0 }),
      ...options,
    });

    it("stops leftover processes and containers before the push credential is fetched", async () => {
      const fixture = await createFixture("append");
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      const order: string[] = [];
      await maintainPullRequest({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: fixture.baseCommit }),
        credentialProvider: async () => { order.push("credential"); return {}; },
        sweepWorkspaceContainers: async () => { order.push("containers"); return { removed: 0 }; },
        stopWorkspaceProcesses: async () => { order.push("processes"); return { stopped: 0 }; },
        pullRequestUpdateSink: sink(),
      });
      expect(order).toEqual(["containers", "processes", "containers", "credential"]);
    });

    it("fetches no credential and pushes nothing when leftover programs cannot be stopped", async () => {
      const fixture = await createFixture("append");
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      const credential = vi.fn(async () => ({}));
      await expect(maintainPullRequest({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: fixture.baseCommit }),
        credentialProvider: credential,
        sweepWorkspaceContainers: async () => ({ removed: 0 }),
        stopWorkspaceProcesses: async () => { throw new Error("AgentX could not stop every process left in the workspace, so it did not push"); },
        pullRequestUpdateSink: sink(),
      })).rejects.toThrow("did not push");
      expect(credential).not.toHaveBeenCalled();
      expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
    });

    it("pushes the reviewed fix tree to the existing PR branch as a fast-forward", async () => {
      const fixture = await createFixture("append");
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      const update = sink();
      const result = await pushFix({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: fixture.baseCommit }),
        credentialProvider: async () => ({}),
        pullRequestUpdateSink: update,
      });
      expect(result).toMatchObject({ action: "append", previousCommit: fixture.pullRequestHead, treeSha: reviewedTree, checks: [] });
      expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${result.commit}\n`);
      expect(await git(fixture.bare, ["rev-parse", `${result.commit}^{tree}`])).toBe(`${reviewedTree}\n`);
      expect(await git(fixture.bare, ["rev-list", "--parents", "-n", "1", result.commit])).toBe(`${result.commit} ${fixture.pullRequestHead}\n`);
      expect(await git(fixture.bare, ["log", "-1", "--format=%s", result.commit])).toBe("AgentX: address PR feedback\n");
      expect(await git(fixture.bare, ["rev-list", "--count", `${fixture.pullRequestHead}..${result.commit}`])).toBe("1\n");
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ previousCommit: fixture.pullRequestHead, commit: result.commit }));
    });

    it("refuses to push a fix whose tree differs from the reviewed tree", async () => {
      const fixture = await createFixture("append");
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback, then edited again\n", "utf8");
      const update = sink();
      await expect(pushFix({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: fixture.baseCommit }),
        credentialProvider: async () => ({}),
        pullRequestUpdateSink: update,
      })).rejects.toThrow("the code changed after its checks and reviews; AgentX did not publish it");
      expect(update).not.toHaveBeenCalled();
      expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
    });

    it("refuses to push a fix when the PR branch moved on GitHub", async () => {
      const fixture = await createFixture("append");
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      // Someone else pushes to the PR branch from another clone.
      await git(fixture.seed, ["fetch", "origin", fixture.headBranch]);
      await git(fixture.seed, ["checkout", "-b", "someone-else", "FETCH_HEAD"]);
      await writeFile(join(fixture.seed, "THEIRS.md"), "their commit\n", "utf8");
      await git(fixture.seed, ["add", "THEIRS.md"]);
      await commit(fixture.seed, "their commit");
      await git(fixture.seed, ["push", "origin", `someone-else:${fixture.headBranch}`]);
      const moved = (await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim();
      expect(moved).not.toBe(fixture.pullRequestHead);
      const update = sink();
      await expect(pushFix({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: fixture.baseCommit }),
        credentialProvider: async () => ({}),
        pullRequestUpdateSink: update,
      })).rejects.toThrow(/STALE_FENCE: pull request head changed/);
      expect(update).not.toHaveBeenCalled();
      expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${moved}\n`);
    });

    it("looks at the PR branch again right before the push, and refuses when it moved or is gone", async () => {
      // The validation gate runs after the commit is built and before the push: GitHub changes the branch meanwhile.
      for (const change of ["moved", "deleted"] as const) {
        const fixture = await createFixture("append");
        await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
        const reviewedTree = await workspaceTree(fixture.checkout);
        const invocation = failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: fixture.baseCommit });
        const gated = { ...invocation, payload: { ...invocation.payload, project: { ...invocation.payload.project,
          repositories: invocation.payload.project.repositories.map((repository) => ({ ...repository, codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 5 }] })) } } } as typeof invocation;
        let after: string | undefined;
        const update = sink();
        await expect(pushFix({
          rootPath: fixture.root,
          invocation: gated,
          credentialProvider: async () => ({}),
          codeBuildSink: async (request) => {
            if (change === "deleted") {
              // The pull request was merged and its branch deleted.
              await git(fixture.bare, ["update-ref", "-d", `refs/heads/${fixture.headBranch}`]);
            } else {
              await git(fixture.seed, ["fetch", "origin", fixture.headBranch]);
              await git(fixture.seed, ["checkout", "-B", "someone-else", "FETCH_HEAD"]);
              await writeFile(join(fixture.seed, "THEIRS.md"), "their commit\n", "utf8");
              await git(fixture.seed, ["add", "THEIRS.md"]);
              await commit(fixture.seed, "their commit");
              await git(fixture.seed, ["push", "origin", `someone-else:${fixture.headBranch}`]);
              after = (await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim();
            }
            return { gate: request.gate, projectName: request.projectName, buildId: `${request.projectName}:${crypto.randomUUID()}`, status: "SUCCEEDED",
              requestedSourceVersion: request.commit, resolvedSourceVersion: request.commit };
          },
          pullRequestUpdateSink: update,
        }), change).rejects.toThrow(/STALE_FENCE: pull request head changed/);
        expect(update).not.toHaveBeenCalled();
        if (change === "deleted") {
          // Never pushed back into existence.
          await expect(git(fixture.bare, ["rev-parse", "--verify", `refs/heads/${fixture.headBranch}`])).rejects.toThrow();
        } else {
          expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${after}\n`);
        }
      }
    });

    it("refuses a fix when the task's base commit is not in the workspace", async () => {
      const fixture = await createFixture("append");
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      await expect(pushFix({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: "e".repeat(40) }),
        credentialProvider: async () => ({}),
        pullRequestUpdateSink: sink(),
      })).rejects.toThrow("the task's base commit is missing from the workspace");
      expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
    });

    it("refuses a fix when the task's base commit is not an ancestor of the workspace", async () => {
      const fixture = await createFixture("append");
      // A commit that exists in the workspace but is not in its history.
      await git(fixture.checkout, ["checkout", "--orphan", "unrelated"]);
      await commit(fixture.checkout, "unrelated");
      const unrelated = (await git(fixture.checkout, ["rev-parse", "HEAD"])).trim();
      await git(fixture.checkout, ["checkout", "--force", fixture.headBranch]);
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      await expect(pushFix({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: unrelated }),
        credentialProvider: async () => ({}),
        pullRequestUpdateSink: sink(),
      })).rejects.toThrow("the code changed after its checks and reviews; AgentX did not publish it");
      expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
    });

    it("pushes a reviewed fix whose pinned base is an ancestor of the workspace", async () => {
      const fixture = await createFixture("append");
      const base = (await git(fixture.checkout, ["rev-parse", "main"])).trim();
      await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
      const reviewedTree = await workspaceTree(fixture.checkout);
      const result = await pushFix({
        rootPath: fixture.root,
        invocation: failingReadiness(fixture.invocation, reviewedTree, { workflowBaseCommit: base }),
        credentialProvider: async () => ({}),
        pullRequestUpdateSink: sink(),
      });
      expect(result.treeSha).toBe(reviewedTree);
    });
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

// #183: pull request updates run readiness where preparation did, like publication.
describe("pull request maintenance checks in a devcontainer (#183)", () => {
  const UP_OUTPUT = "{\"outcome\":\"success\",\"containerId\":\"f832494aef96\",\"remoteUser\":\"node\",\"remoteWorkspaceFolder\":\"/workspaces/demo\"}";
  function fakeCli(exec: () => DevcontainerProcess, up: () => DevcontainerProcess = () => ({ exitCode: 0, stdout: UP_OUTPUT, stderr: "" })) {
    const calls: string[][] = [];
    const cli: DevcontainerCli = {
      run: async (args) => {
        calls.push([...args]);
        return args[0] === "up" ? up() : exec();
      },
    };
    return { cli, calls };
  }
  const sink = async () => ({ url: "https://github.com/example/demo/pull/7", state: "open" as const, reconciled: false });

  it("runs an append's checks through devcontainer exec", async () => {
    const fixture = await createFixture("append", "remote.git", { devcontainer: true });
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    const { cli, calls } = fakeCli(() => ({ exitCode: 0, stdout: "checked in the container\n", stderr: "" }));
    const result = await maintainPullRequest({
      rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: sink, devcontainerCli: cli,
    });
    const workspaceFolder = join(await realpath(fixture.root), "repo/demo");
    expect(result.checks).toEqual([expect.objectContaining({ outcome: "passed", stdout: "checked in the container\n" })]);
    expect(calls.map((args) => args[0])).toEqual(["up", "exec"]);
    expect(calls[1]!.slice(0, 3)).toEqual(["exec", "--workspace-folder", workspaceFolder]);
    expect(calls[1]!.slice(9, 10)).toEqual([workspaceFolder]);
    expect(calls[1]!.slice(11)).toEqual([process.execPath, "-e", "process.exit(0)"]);
  });

  it("runs a sync's checks through devcontainer exec, and keeps the PR head when one fails there", async () => {
    const fixture = await createFixture("sync", "remote.git", { devcontainer: true });
    await writeFile(join(fixture.seed, "UPSTREAM.md"), "latest base\n", "utf8");
    await git(fixture.seed, ["add", "UPSTREAM.md"]);
    await commit(fixture.seed, "upstream");
    await git(fixture.seed, ["push", "origin", "main"]);
    const { cli, calls } = fakeCli(() => ({ exitCode: 1, stdout: "", stderr: "tests failed\n" }));
    const update = vi.fn();
    await expect(maintainPullRequest({
      rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: update, devcontainerCli: cli,
    })).rejects.toThrow(/readiness checks failed/i);
    expect(calls.map((args) => args[0])).toEqual(["up", "exec"]);
    expect(update).not.toHaveBeenCalled();
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(`${fixture.pullRequestHead}\n`);
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
  });

  it("resets a sync's merge when the devcontainer does not start, and pushes nothing", async () => {
    const fixture = await createFixture("sync", "remote.git", { devcontainer: true });
    await writeFile(join(fixture.seed, "UPSTREAM.md"), "latest base\n", "utf8");
    await git(fixture.seed, ["add", "UPSTREAM.md"]);
    await commit(fixture.seed, "upstream");
    await git(fixture.seed, ["push", "origin", "main"]);
    const { cli } = fakeCli(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      () => ({ exitCode: 1, stdout: "{\"outcome\":\"error\",\"message\":\"Docker is not running\"}", stderr: "" }),
    );
    const update = vi.fn();
    await expect(maintainPullRequest({
      rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: update, devcontainerCli: cli,
    })).rejects.toThrow("devcontainer did not start: Docker is not running");
    expect(update).not.toHaveBeenCalled();
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(`${fixture.pullRequestHead}\n`);
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
  });

  it("still says why the checks could not run when the sync's merge cannot be undone either", async () => {
    const fixture = await createFixture("sync", "remote.git", { devcontainer: true });
    await writeFile(join(fixture.seed, "UPSTREAM.md"), "latest base\n", "utf8");
    await git(fixture.seed, ["add", "UPSTREAM.md"]);
    await commit(fixture.seed, "upstream");
    await git(fixture.seed, ["push", "origin", "main"]);
    const { cli } = fakeCli(
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
      () => {
        // Another Git process holds the index, so the reset after this failure fails too.
        writeFileSync(join(fixture.checkout, ".git", "index.lock"), "");
        return { exitCode: 1, stdout: "{\"outcome\":\"error\",\"message\":\"Docker is not running\"}", stderr: "" };
      },
    );
    const failure = await maintainPullRequest({
      rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: vi.fn(), devcontainerCli: cli,
    }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("devcontainer did not start: Docker is not running");
    expect(failure?.message).toContain("the merge could not be undone");
    expect(await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).toBe(`${fixture.pullRequestHead}\n`);
  });

  it("still says the checks failed when the sync's merge cannot be undone either", async () => {
    const fixture = await createFixture("sync", "remote.git", { devcontainer: true });
    await writeFile(join(fixture.seed, "UPSTREAM.md"), "latest base\n", "utf8");
    await git(fixture.seed, ["add", "UPSTREAM.md"]);
    await commit(fixture.seed, "upstream");
    await git(fixture.seed, ["push", "origin", "main"]);
    const { cli } = fakeCli(() => {
      writeFileSync(join(fixture.checkout, ".git", "index.lock"), "");
      return { exitCode: 1, stdout: "", stderr: "tests failed\n" };
    });
    const failure = await maintainPullRequest({
      rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: vi.fn(), devcontainerCli: cli,
    }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("one or more registered readiness checks failed");
    expect(failure?.message).toContain("the merge could not be undone");
  });

  it("runs checks on the host when preparation recorded no devcontainer", async () => {
    const fixture = await createFixture("append");
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    const { cli, calls } = fakeCli(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const result = await maintainPullRequest({
      rootPath: fixture.root, invocation: fixture.invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: sink, devcontainerCli: cli,
    });
    expect(result.checks).toEqual([expect.objectContaining({ outcome: "passed", exitCode: 0 })]);
    expect(calls).toEqual([]);
  });
});

async function createFixture(action: "append" | "sync", remoteName = "remote.git", options: { devcontainer?: boolean } = {}) {
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
    ...(options.devcontainer === true ? { devcontainer: { repository: "demo" } } : {}),
    orchestratorInstructions: "Delegate coding work.",
  };
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
    // Preparation records the devcontainer it started (#121).
    ...(options.devcontainer === true
      ? { devcontainer: { repository: "demo", configPath: "repo/demo/.devcontainer/devcontainer.json", containerId: "f832494aef96", startedAt: new Date().toISOString() } }
      : {}),
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
  } satisfies Extract<WorkerInvocation, { kind: "maintain" }>;
  return { root, bare, seed, checkout, invocation, headBranch, pullRequestHead, baseCommit: preparedCommit };
}

/** The workspace's tree as the reviewers would have computed it: HEAD plus every change; the index is put back. */
async function workspaceTree(directory: string): Promise<string> {
  await git(directory, ["add", "--all"]);
  const tree = (await git(directory, ["write-tree"])).trim();
  await git(directory, ["reset", "--quiet"]);
  return tree;
}

async function commit(directory: string, message: string): Promise<void> {
  await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message]);
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout;
}
