// Rovara Code (Plan 6 Task 17), with real Git: the worker merges the base branch into a workflow task's pull request branch (`git merge --no-ff`, never a rebase or a force-push), pushes only to the
// task's own branch on the head it was told, returns the merged tree, and on a conflict returns the conflicting files and leaves the merge's files in the workspace. A conflict round's fix is then
// pushed as a merge commit of exactly the reviewed tree.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WorkerInvocationSchema, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";
import { temporaryIndexTree } from "../../packages/worker/src/publish.js";
import { restoreFixStart } from "../../packages/worker/src/fix-start.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

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

type Maintain = Extract<WorkerInvocation, { kind: "maintain" }>;
/** Nothing is left running in the test's workspace, and no containers: the seams of a workflow push. */
const seams = { stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) };
const sink = () => vi.fn(async () => ({ url: "https://github.com/example/demo/pull/7", state: "open" as const, reconciled: false }));
const parentsOf = async (directory: string, commitSha: string): Promise<string[]> => (await git(directory, ["rev-list", "--parents", "-n", "1", commitSha])).trim().split(" ").slice(1);
const remoteHead = async (fixture: Fixture): Promise<string> => (await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim();

describe("a workflow task's merge of the base branch", () => {
  it("merges exactly the base commit it was told, with a merge commit whose first parent is the old head, and pushes it as a fast-forward of the task's own branch", async () => {
    const fixture = await createFixture();
    const base = await advanceBase(fixture, "UPSTREAM.md", "first change\n");
    // The base moves on again after the broker chose its commit: the merge takes exactly the commit it was told.
    const tip = await advanceBase(fixture, "LATER.md", "later change\n");
    expect(tip).not.toBe(base);
    const update = sink();
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update });
    expect(result).toMatchObject({ action: "sync", previousCommit: fixture.pullRequestHead, reconciled: false });
    expect(result.conflicts).toBeUndefined();
    expect(await parentsOf(fixture.checkout, result.commit)).toEqual([fixture.pullRequestHead, base]);
    // The remote's old head is an ancestor of the new one: a fast-forward, nothing rewritten.
    await expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.pullRequestHead, result.commit])).resolves.toBe("");
    expect(await remoteHead(fixture)).toBe(result.commit);
    // The merged tree is reported, and is the commit's.
    expect(result.treeSha).toBe((await git(fixture.checkout, ["rev-parse", `${result.commit}^{tree}`])).trim());
    expect(await readFile(join(fixture.checkout, "UPSTREAM.md"), "utf8")).toBe("first change\n");
    await expect(readFile(join(fixture.checkout, "LATER.md"), "utf8")).rejects.toThrow();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ action: "sync", previousCommit: fixture.pullRequestHead, commit: result.commit }));
    // Nothing but the task's own branch was written, and the base is as it was.
    expect((await git(fixture.bare, ["rev-parse", "refs/heads/main"])).trim()).toBe(tip);
  });

  it("pushes nothing when the branch already has the base commit: the head stays and the result says so", async () => {
    const fixture = await createFixture();
    const update = sink();
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, fixture.baseCommit), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update });
    expect(result).toMatchObject({ action: "sync", commit: fixture.pullRequestHead, reconciled: true });
    expect(result.conflicts).toBeUndefined();
    expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
  });

  it("refuses a base commit that is not part of the base branch, and one it does not have, before anything is pushed", async () => {
    const fixture = await createFixture();
    await advanceBase(fixture, "UPSTREAM.md", "first change\n");
    // A commit that is in the workspace but on no part of the base branch's history.
    await git(fixture.checkout, ["checkout", "--orphan", "stray"]);
    await commit(fixture.checkout, "stray");
    const stray = (await git(fixture.checkout, ["rev-parse", "HEAD"])).trim();
    await git(fixture.checkout, ["checkout", "--force", fixture.headBranch]);
    for (const base of [stray, "e".repeat(40)]) {
      const update = sink();
      await expect(maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update }), base).rejects.toThrow(/STALE_FENCE: the base commit is not part of the base branch/);
      expect(update).not.toHaveBeenCalled();
      expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
    }
  });

  it("refuses when the branch moved (a person pushed), and never pushes over it", async () => {
    const fixture = await createFixture();
    const base = await advanceBase(fixture, "UPSTREAM.md", "first change\n");
    await git(fixture.seed, ["fetch", "origin", fixture.headBranch]);
    await git(fixture.seed, ["checkout", "-B", "someone-else", "FETCH_HEAD"]);
    await writeFile(join(fixture.seed, "THEIRS.md"), "their commit\n", "utf8");
    await git(fixture.seed, ["add", "THEIRS.md"]);
    await commit(fixture.seed, "their commit");
    await git(fixture.seed, ["push", "origin", `someone-else:${fixture.headBranch}`]);
    const moved = await remoteHead(fixture);
    const update = sink();
    await expect(maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update })).rejects.toThrow(/STALE_FENCE: pull request head changed/);
    expect(update).not.toHaveBeenCalled();
    expect(await remoteHead(fixture)).toBe(moved);
  });

  it("looks at the branch again right before the push and refuses when it moved meanwhile", async () => {
    const fixture = await createFixture({ gates: true });
    const base = await advanceBase(fixture, "UPSTREAM.md", "first change\n");
    let moved = "";
    const update = sink();
    await expect(maintainPullRequest({
      rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update,
      codeBuildSink: async (request) => {
        await git(fixture.seed, ["fetch", "origin", fixture.headBranch]);
        await git(fixture.seed, ["checkout", "-B", "someone-else", "FETCH_HEAD"]);
        await writeFile(join(fixture.seed, "THEIRS.md"), "their commit\n", "utf8");
        await git(fixture.seed, ["add", "THEIRS.md"]);
        await commit(fixture.seed, "their commit");
        await git(fixture.seed, ["push", "origin", `someone-else:${fixture.headBranch}`]);
        moved = (await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim();
        return { gate: request.gate, projectName: request.projectName, buildId: `${request.projectName}:${crypto.randomUUID()}`, status: "SUCCEEDED", requestedSourceVersion: request.commit, resolvedSourceVersion: request.commit };
      },
    })).rejects.toThrow(/STALE_FENCE: pull request head changed/);
    expect(update).not.toHaveBeenCalled();
    expect(await remoteHead(fixture)).toBe(moved);
  });

  it("returns the conflicting files, pushes nothing, and leaves the merge's files in the workspace", async () => {
    const fixture = await createFixture({ conflict: true });
    const base = fixture.conflictBase!;
    const update = sink();
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update });
    expect(result).toMatchObject({ action: "sync", commit: fixture.pullRequestHead, previousCommit: fixture.pullRequestHead, reconciled: true, conflicts: ["README.md"] });
    expect(result.treeSha).toBeUndefined();
    // The workspace holds the merge's files: the conflicting one carries the markers, the index holds nothing unmerged (a candidate can be captured), and the branch is on a local merge commit of
    // the head and the base commit (so the history holds the base the round is reviewed against), never pushed.
    expect((await git(fixture.checkout, ["diff", "--name-only", "--diff-filter=U"])).trim()).toBe("");
    expect((await git(fixture.checkout, ["status", "--porcelain=v1"])).trim()).toBe("");
    expect(await parentsOf(fixture.checkout, "HEAD")).toEqual([fixture.pullRequestHead, base]);
    const marked = await readFile(join(fixture.checkout, "README.md"), "utf8");
    expect(marked).toContain("<<<<<<<");
    expect(marked).toContain(">>>>>>>");
    expect((await git(fixture.checkout, ["branch", "--show-current"])).trim()).toBe(fixture.headBranch);
    // Nothing was pushed, and the sink was told only that the head is as it was (so the broker has the pull request's link and state).
    expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ previousCommit: fixture.pullRequestHead, commit: fixture.pullRequestHead }));
  });

  it("names a file whose name has a space or a quote as it is", async () => {
    const fixture = await createFixture({ conflict: true, conflictFile: 'odd "name" here.md' });
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, fixture.conflictBase!), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect(result.conflicts).toEqual(['odd "name" here.md']);
  });

  it("starts from the recorded head whatever an abandoned conflict round left in the workspace (markers, edits, files)", async () => {
    const fixture = await createFixture({ conflict: true });
    await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, fixture.conflictBase!), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    await writeFile(join(fixture.checkout, "README.md"), "half way\n", "utf8");
    await writeFile(join(fixture.checkout, "LEFTOVER.md"), "from the coder\n", "utf8");
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, fixture.conflictBase!), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect(result).toMatchObject({ conflicts: ["README.md"], previousCommit: fixture.pullRequestHead });
    await expect(readFile(join(fixture.checkout, "LEFTOVER.md"), "utf8")).rejects.toThrow();
    expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
  });

  it("runs no readiness check for a merge that has nothing to merge (the branch already has the base)", async () => {
    const fixture = await createFixture({ failingReadiness: true });
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, fixture.baseCommit), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect(result).toMatchObject({ reconciled: true, checks: [] });
  });

  it("refuses a workspace with changes in it, as a sync that is not a workflow task's", async () => {
    const fixture = await createFixture();
    await advanceBase(fixture, "UPSTREAM.md", "first change\n");
    await writeFile(join(fixture.checkout, "UNSAVED.md"), "work\n", "utf8");
    await expect(maintainPullRequest({ rootPath: fixture.root, invocation: { ...fixture.invocation, payload: { ...fixture.invocation.payload, action: "sync" } }, credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() })).rejects.toThrow(/clean repository/);
    expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
  });

  it("puts the workspace back on the head and reports GitHub's refusal when the push is refused (workflow files), pushing nothing", async () => {
    const fixture = await createFixture();
    const base = await advanceBase(fixture, ".github/workflows/ci.yml", "name: ci\n");
    const hook = join(fixture.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission' >&2\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    const update = sink();
    const failure = await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toMatch(/without `workflows` permission/);
    expect(update).not.toHaveBeenCalled();
    expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
    // The merge is not left in the workspace: the next merge needs a clean one.
    expect((await git(fixture.checkout, ["rev-parse", "HEAD"])).trim()).toBe(fixture.pullRequestHead);
    expect((await git(fixture.checkout, ["status", "--porcelain=v1"])).trim()).toBe("");
  });

  it("a sync that is not a workflow task's keeps today's behaviour: the latest base, and a conflict is an error", async () => {
    const fixture = await createFixture({ conflict: true });
    const plain = { ...fixture.invocation, payload: { ...fixture.invocation.payload } } as Maintain;
    await expect(maintainPullRequest({ rootPath: fixture.root, invocation: plain, credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() })).rejects.toThrow(/conflicts with the latest base/i);
  });
});

describe("a conflict round's fix, pushed as a merge commit", () => {
  /** The conflict round up to the fix: the merge conflicted, and the coder resolved the file. */
  async function resolved(options: { resolution?: string; ignored?: boolean; extras?: boolean; failingReadiness?: boolean } = {}) {
    const fixture = await createFixture({ conflict: true, ...(options.ignored === true ? { ignored: true } : {}), ...(options.extras === true ? { extras: true } : {}) });
    const base = fixture.conflictBase!;
    await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    await writeFile(join(fixture.checkout, "README.md"), options.resolution ?? "both versions\n", "utf8");
    const tree = await temporaryIndexTree({ directory: fixture.checkout });
    return { fixture, base, tree };
  }
  const pushOf = (fixture: Fixture, tree: string, mergeBase: string | undefined): Maintain => ({
    ...fixture.invocation,
    payload: { ...fixture.invocation.payload, action: "append", workflowCandidateTreeSha: tree, workflowBaseCommit: fixture.baseCommit, workflowFix: { source: "conflict" },
      ...(mergeBase === undefined ? {} : { workflowMergeBase: mergeBase }) },
  });

  it("is a commit of exactly the reviewed tree with the old head first and the base commit second, a fast-forward of the branch", async () => {
    const { fixture, base, tree } = await resolved();
    const update = sink();
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update });
    expect(result).toMatchObject({ action: "append", previousCommit: fixture.pullRequestHead, treeSha: tree });
    expect(await parentsOf(fixture.checkout, result.commit)).toEqual([fixture.pullRequestHead, base]);
    expect((await git(fixture.checkout, ["rev-parse", `${result.commit}^{tree}`])).trim()).toBe(tree);
    expect(await remoteHead(fixture)).toBe(result.commit);
    await expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.pullRequestHead, result.commit])).resolves.toBe("");
    expect((await git(fixture.checkout, ["log", "-1", "--format=%s", result.commit])).trim()).toBe("Rovara: resolve conflict with the base branch");
  });

  it("is pushed even when the coder resolved to exactly the head's own tree (the merge is still worth recording)", async () => {
    const { fixture, base, tree } = await resolved({ resolution: "pull request version\n" });
    expect(tree).toBe((await git(fixture.checkout, ["rev-parse", `${fixture.pullRequestHead}^{tree}`])).trim());
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect(await parentsOf(fixture.checkout, result.commit)).toEqual([fixture.pullRequestHead, base]);
  });

  it("refuses a workspace that is not the reviewed tree, a base commit it does not have, and one that is not part of the base branch; nothing is pushed", async () => {
    const { fixture, base, tree } = await resolved();
    const attempt = async (invocation: Maintain) => {
      const update = sink();
      await expect(maintainPullRequest({ rootPath: fixture.root, invocation, credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update })).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
    };
    await attempt(pushOf(fixture, "1".repeat(40), base));
    await attempt(pushOf(fixture, tree, "e".repeat(40)));
    // The pull request's own head is a commit of the repository, but not of the base branch.
    await attempt(pushOf(fixture, tree, fixture.pullRequestHead));
  });

  it("refuses a fix whose tree drops what the base brought: a tracked file the repository ignores, or a file the coder took back (it need not be in conflict)", async () => {
    for (const drop of ["ignored", "reverted"] as const) {
      const { fixture, base } = await resolved({ ignored: drop === "ignored", extras: true });
      await rm(join(fixture.checkout, drop === "reverted" ? "BASE.md" : "dist/app.js"));
      const tree = await temporaryIndexTree({ directory: fixture.checkout });
      const update = sink();
      const failure = await maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: update }).then(() => undefined, (error: unknown) => error as Error);
      expect(failure?.message, drop).toMatch(/would drop changes the base branch made/);
      // And it says why, and what is allowed: the files that conflicted and the coder's own files, not one the base changed cleanly.
      expect(failure?.message).toMatch(/may change the files that conflicted and its own new files, not a file the base branch changed without a conflict/);
      expect(failure?.message).toContain(drop === "ignored" ? "dist/app.js" : "BASE.md");
      expect(update).not.toHaveBeenCalled();
      expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
    }
  });

  it("keeps a file the base tracks under an ignored folder: the merge's own commit holds it, so the fix's tree does too", async () => {
    const { fixture, base, tree } = await resolved({ ignored: true, extras: true });
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect((await git(fixture.checkout, ["show", `${result.commit}:dist/app.js`]))).toBe("built\n");
  });

  it("takes a fix that resolves the conflict and also changes other files of its own", async () => {
    const { fixture, base } = await resolved({ extras: true });
    await writeFile(join(fixture.checkout, "FEATURE.md"), "feature, adapted to the base\n", "utf8");
    await writeFile(join(fixture.checkout, "NEW.md"), "added by the coder\n", "utf8");
    const tree = await temporaryIndexTree({ directory: fixture.checkout });
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, base), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect(await parentsOf(fixture.checkout, result.commit)).toEqual([fixture.pullRequestHead, base]);
    expect((await git(fixture.checkout, ["show", `${result.commit}:BASE.md`]))).toBe("from the base\n");
  });

  it("an append over unresolved conflicts is still refused, unless it is the push of a merge: its tree is the reviewed one, whatever the index says", async () => {
    const fixture = await createFixture({ conflict: true });
    // A merge made in the workspace by hand leaves unmerged entries in its index.
    await git(fixture.checkout, ["-c", "protocol.file.allow=always", "fetch", "origin", "main"]);
    // git refuses to start a merge without a committer identity (a CI runner has none configured, and its host name gives no usable address), so the hand merge names one, as `commit` does.
    await expect(git(fixture.checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "merge", fixture.conflictBase!])).rejects.toThrow();
    expect((await git(fixture.checkout, ["diff", "--name-only", "--diff-filter=U"])).trim()).toBe("README.md");
    await writeFile(join(fixture.checkout, "README.md"), "both versions\n", "utf8");
    const tree = await temporaryIndexTree({ directory: fixture.checkout });
    await expect(maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, undefined), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() })).rejects.toThrow(/unresolved merge conflicts/);
    expect(await remoteHead(fixture)).toBe(fixture.pullRequestHead);
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: pushOf(fixture, tree, fixture.conflictBase), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    expect(await parentsOf(fixture.checkout, result.commit)).toEqual([fixture.pullRequestHead, fixture.conflictBase]);
  });
});

describe("the invocation", () => {
  it("takes a merge of the base only as a sync of the recorded head with no reviewed tree, and a merge base only with the reviewed tree", async () => {
    const fixture = await createFixture();
    // The schema takes only HTTPS repositories; the fixture's remote is a local path.
    const project = { ...fixture.invocation.payload.project, repositories: fixture.invocation.payload.project.repositories.map((repository) => ({ ...repository, url: "https://github.com/example/demo" })) };
    const parses = (value: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ ...fixture.invocation, payload: { ...fixture.invocation.payload, project, ...value } }).success;
    const head = fixture.pullRequestHead;
    expect(parses({ action: "sync", workflowSync: { baseCommit: "b".repeat(40), expectedHeadCommit: head } })).toBe(true);
    expect(parses({ action: "sync", workflowSync: { baseCommit: "b".repeat(40), expectedHeadCommit: "c".repeat(40) } })).toBe(false);
    expect(parses({ action: "append", workflowSync: { baseCommit: "b".repeat(40), expectedHeadCommit: head } })).toBe(false);
    expect(parses({ action: "sync", workflowSync: { baseCommit: "b".repeat(40), expectedHeadCommit: head }, workflowCandidateTreeSha: "d".repeat(40), workflowBaseCommit: "e".repeat(40) })).toBe(false);
    expect(parses({ action: "sync", workflowSync: { baseCommit: "short", expectedHeadCommit: head } })).toBe(false);
    expect(parses({ action: "append", workflowCandidateTreeSha: "d".repeat(40), workflowBaseCommit: "e".repeat(40), workflowMergeBase: "b".repeat(40) })).toBe(true);
    expect(parses({ action: "append", workflowMergeBase: "b".repeat(40) })).toBe(false);
    expect(parses({ action: "sync", workflowMergeBase: "b".repeat(40) })).toBe(false);
  });
});

// ---- fixtures

interface Fixture {
  root: string;
  bare: string;
  seed: string;
  checkout: string;
  invocation: Maintain;
  headBranch: string;
  pullRequestHead: string;
  /** The base commit the pull request branched from. */
  baseCommit: string;
  /** With `conflict`: the base commit that conflicts with the branch. */
  conflictBase?: string;
}

/** The merge of `baseCommit`, as the broker would ask for it. */
function syncOf(fixture: Fixture, baseCommit: string): Maintain {
  return { ...fixture.invocation, payload: { ...fixture.invocation.payload, action: "sync", workflowSync: { baseCommit, expectedHeadCommit: fixture.pullRequestHead } } };
}

/** One more commit on the base branch (a new file), pushed; its sha. */
async function advanceBase(fixture: Fixture, file: string, content: string): Promise<string> {
  await mkdir(join(fixture.seed, file, ".."), { recursive: true });
  await writeFile(join(fixture.seed, file), content, "utf8");
  await git(fixture.seed, ["add", file]);
  await commit(fixture.seed, `upstream ${file}`);
  await git(fixture.seed, ["push", "origin", "main"]);
  return (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
}

async function createFixture(options: { conflict?: boolean; conflictFile?: string; gates?: boolean; ignored?: boolean; extras?: boolean; failingReadiness?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agentx-workflow-sync-test-"));
  temporaryDirectories.push(root);
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "repo", "demo");
  const conflictFile = options.conflictFile ?? "README.md";
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await git(root, ["init", "--initial-branch=main", seed]);
  await writeFile(join(seed, conflictFile), "initial\n", "utf8");
  await git(seed, ["add", conflictFile]);
  // With `ignored`, the repository ignores dist/: the base can still track a file there (added with -f), which no `git add --all` of a workspace would pick up.
  if (options.ignored === true) {
    await writeFile(join(seed, ".gitignore"), "dist/\n", "utf8");
    await git(seed, ["add", ".gitignore"]);
  }
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
  if (options.conflict === true) {
    await writeFile(join(checkout, conflictFile), "pull request version\n", "utf8");
    await git(checkout, ["add", conflictFile]);
  }
  await commit(checkout, "feature");
  await git(checkout, ["push", "origin", headBranch]);
  const pullRequestHead = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const remoteUrl = (await git(checkout, ["remote", "get-url", "origin"])).trim();
  const project = {
    name: "demo", revision: 1,
    repositories: [{ name: "demo", url: remoteUrl, path: "repo/demo", defaultBranch: "main", credentialRef: "github-app",
      ...(options.gates === true ? { codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 5 }] } : {}) }],
    setup: [], readiness: [{ cwd: "repo/demo", executable: process.execPath, args: ["-e", options.failingReadiness === true ? "process.exit(1)" : "process.exit(0)"], timeoutSeconds: 10 }],
    orchestratorInstructions: "Delegate coding work.",
  };
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "demo", projectRevision: 1, environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: preparedCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "test", complete: true, updatedAt: new Date().toISOString(),
  }), "utf8");
  const invocation = {
    protocolVersion: 1, kind: "maintain", operationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), fence: 3, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { action: "sync", project, repository: "demo", pullRequestNumber: 7, headBranch, baseBranch: "main", expectedHeadCommit: pullRequestHead, repositoryGrant: "push-grant" },
  } satisfies Extract<WorkerInvocation, { kind: "maintain" }>;
  const fixture: Fixture = { root: await realpath(root), bare, seed, checkout, invocation, headBranch, pullRequestHead, baseCommit: preparedCommit };
  if (options.conflict === true) {
    // The base changes the same file differently.
    await writeFile(join(seed, conflictFile), "base version\n", "utf8");
    await git(seed, ["add", conflictFile]);
    // What the base brings that does not conflict: an ordinary new file, and a file under dist/ (tracked with -f when the repository ignores that folder).
    if (options.extras === true || options.ignored === true) {
      await mkdir(join(seed, "dist"), { recursive: true });
      await writeFile(join(seed, "dist", "app.js"), "built\n", "utf8");
      await writeFile(join(seed, "BASE.md"), "from the base\n", "utf8");
      await git(seed, ["add", "BASE.md"]);
      await git(seed, options.ignored === true ? ["add", "-f", "dist/app.js"] : ["add", "dist/app.js"]);
    }
    await commit(seed, "base conflict");
    await git(seed, ["push", "origin", "main"]);
    fixture.conflictBase = (await git(seed, ["rev-parse", "HEAD"])).trim();
  }
  return fixture;
}

async function commit(directory: string, message: string): Promise<void> {
  await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message]);
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout;
}

describe("a fix round that starts after an abandoned conflict round", () => {
  it("starts from the pull request's head: the markers, the edits and the local merge commit the abandoned round left are gone", async () => {
    const fixture = await createFixture({ conflict: true });
    await maintainPullRequest({ rootPath: fixture.root, invocation: syncOf(fixture, fixture.conflictBase!), credentialProvider: async () => ({}), ...seams, pullRequestUpdateSink: sink() });
    await writeFile(join(fixture.checkout, "README.md"), "half way\n", "utf8");
    await writeFile(join(fixture.checkout, "LEFTOVER.md"), "from the coder\n", "utf8");
    expect((await git(fixture.checkout, ["rev-parse", "HEAD"])).trim()).not.toBe(fixture.pullRequestHead);
    await restoreFixStart(fixture.checkout, fixture.pullRequestHead);
    expect((await git(fixture.checkout, ["rev-parse", "HEAD"])).trim()).toBe(fixture.pullRequestHead);
    expect((await git(fixture.checkout, ["branch", "--show-current"])).trim()).toBe(fixture.headBranch);
    expect((await git(fixture.checkout, ["status", "--porcelain=v1"])).trim()).toBe("");
    expect(await readFile(join(fixture.checkout, "README.md"), "utf8")).toBe("pull request version\n");
  });

  it("leaves a workspace that is on the head alone (a resumed run keeps its partial work), and one that lacks the head", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "PARTIAL.md"), "partial work\n", "utf8");
    await restoreFixStart(fixture.checkout, fixture.pullRequestHead);
    expect(await readFile(join(fixture.checkout, "PARTIAL.md"), "utf8")).toBe("partial work\n");
    await restoreFixStart(fixture.checkout, "e".repeat(40));
    expect(await readFile(join(fixture.checkout, "PARTIAL.md"), "utf8")).toBe("partial work\n");
  });
});
