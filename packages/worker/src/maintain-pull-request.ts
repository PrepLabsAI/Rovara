import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AgentXError,
  CONFLICT_PATHS_MAX,
  WORKFLOW_FIX_DROPS_BASE_CHANGES,
  PullRequestLifecycleResultSchema,
  WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE,
  agentXError,
  type WorkerInvocation,
  type PullRequestLifecycleResult,
} from "@agentx/contracts";
import { AGENTX_GIT_EMAIL, AGENTX_GIT_NAME } from "./git.js";
import { assertCredentialFreeRemote, type GitCredential } from "./git-auth.js";
import { assertWorkspaceIsPlain, runIsolatedGit, withIsolatedRepository } from "./isolated-repository.js";
import type { PullRequestUpdateSink } from "./callback-client.js";
import { runCodeBuildGates, type CodeBuildSink } from "./codebuild.js";
import type { RepositoryCredentialProvider } from "./repository-credentials.js";
import { CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC } from "./isolated-git.js";
import { containWorkspace, runReadinessChecks, temporaryIndexTree, type OtherOperationWait } from "./publish.js";
import type { TaskShellSelection } from "./task-sandbox.js";
import { stopWorkspaceProcesses } from "./workspace-processes.js";
import { sweepWorkspaceContainers } from "./workspace-containers.js";
import { storedCommandOutput } from "./command-failure.js";
import type { PreparationManifest } from "./prepare.js";
import type { DevcontainerCli } from "./devcontainer.js";

const MAX_GIT_OUTPUT = 1_048_576;
type MaintainInvocation = Extract<WorkerInvocation, { kind: "maintain" }>;

export async function maintainPullRequest(options: {
  rootPath: string;
  invocation: MaintainInvocation;
  credentialProvider: RepositoryCredentialProvider;
  pullRequestUpdateSink: PullRequestUpdateSink;
  codeBuildSink?: CodeBuildSink;
  /** The `devcontainer` CLI, as a seam for tests. */
  devcontainerCli?: DevcontainerCli;
  /** Where readiness checks run in a project without a devcontainer (R56). Default: from the worker's environment. */
  taskShell?: TaskShellSelection;
  /** A workflow task's fix stops every process left from the workspace before the push credential is fetched. A seam for tests, as in publication. */
  stopWorkspaceProcesses?: (rootPath: string) => Promise<{ stopped: number } | void>;
  /** A workflow task's fix removes every container but the worker's own before the push credential is fetched. A seam for tests, as in publication. */
  sweepWorkspaceContainers?: (rootPath: string) => Promise<{ removed: number }>;
  /** Whether another operation is still running in this worker (server.ts). As in publication, the push waits a bounded time for it to end and then fails closed. Default: none. */
  otherOperationActive?: () => boolean;
  /** How long the push waits for it. A seam for tests. */
  otherOperationWait?: OtherOperationWait;
}): Promise<PullRequestLifecycleResult> {
  const { invocation } = options;
  // In the devcontainer preparation recorded, as at publication (#183).
  const readinessOptions = {
    ...(options.devcontainerCli !== undefined ? { devcontainerCli: options.devcontainerCli } : {}),
    ...(options.taskShell !== undefined ? { taskShell: options.taskShell } : {}),
  };
  const rootPath = await realpath(resolve(options.rootPath));
  const manifest = await loadManifest(rootPath, invocation);
  const repository = invocation.payload.project.repositories.find(
    (candidate) => candidate.name === invocation.payload.repository,
  );
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const prepared = manifest.repositories.find((candidate) => candidate.name === repository.name);
  if (!prepared || prepared.path !== repository.path) {
    throw agentXError("WORKSPACE_NOT_READY", "prepared repository is missing from the workspace manifest");
  }
  const repositoryPath = containedPath(rootPath, repository.path);
  if (!(await stat(repositoryPath).catch(() => undefined))?.isDirectory()) {
    throw agentXError("WORKSPACE_NOT_READY", "prepared repository checkout is missing");
  }
  assertContained(rootPath, await realpath(repositoryPath));
  const remoteUrl = (await git(repositoryPath, ["remote", "get-url", "origin"])).trim();
  assertCredentialFreeRemote(remoteUrl);
  if (remoteUrl !== repository.url) throw agentXError("CONFIG_INVALID", "repository remote does not match the registered project");

  // A workflow task's fix runs no readiness checks, so nothing but leftover programs from the fix's own run could
  // reach the push token. As in publication, none is left before the credential is fetched. (A merge of the base branch runs the checks, but the
  // coder's leftovers are just as unwelcome.)
  if (invocation.payload.workflowCandidateTreeSha !== undefined || invocation.payload.workflowSync !== undefined) {
    await containWorkspace(rootPath, {
      sweep: options.sweepWorkspaceContainers ?? ((root: string) => sweepWorkspaceContainers({ rootPath: root })),
      stop: options.stopWorkspaceProcesses ?? ((root: string) => stopWorkspaceProcesses({ rootPath: root })),
      ...(options.otherOperationActive === undefined ? {} : { otherOperationActive: options.otherOperationActive }),
      ...(options.otherOperationWait === undefined ? {} : { otherOperationWait: options.otherOperationWait }),
    });
  }
  const credential = await options.credentialProvider(repository);
  await credentialedGit(repositoryPath, [
    // From the registered URL, never the remote's name, so a repository remote setting cannot redirect it.
    "fetch", "--no-tags", repository.url,
    `refs/heads/${invocation.payload.headBranch}:refs/remotes/origin/${invocation.payload.headBranch}`,
    `refs/heads/${invocation.payload.baseBranch}:refs/remotes/origin/${invocation.payload.baseBranch}`,
  ], credential, "Git fetch failed", { mode: "write", refs: true });
  const remoteHead = (await git(repositoryPath, ["rev-parse", `refs/remotes/origin/${invocation.payload.headBranch}^{commit}`])).trim();
  if (remoteHead !== invocation.payload.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request head changed since AgentX last observed it");
  }
  // A conflict round's fix is pushed from the workspace the conflicting merge left (its tree is the reviewed one, whatever the index says), so only that push may start with unmerged paths.
  const conflicts = await git(repositoryPath, ["diff", "--name-only", "--diff-filter=U", "--ignore-submodules=dirty"]);
  const mergeBase = invocation.payload.workflowMergeBase;
  if (conflicts.trim() && mergeBase === undefined) throw agentXError("CONFIG_INVALID", "repository has unresolved merge conflicts");

  let commit: string;
  let reconciled = false;
  if (invocation.payload.action === "append") {
    const currentHead = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
    if (!(await isAncestor(repositoryPath, remoteHead, currentHead))) {
      throw agentXError("STALE_FENCE", "workspace history is not a fast-forward of the pull request head");
    }
    const status = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=dirty"]);
    if (currentHead === remoteHead && !status.trim() && mergeBase === undefined) {
      throw agentXError("CONFIG_INVALID", "repository has no new changes to append");
    }
    // A conflict round's fix is a merge commit of the base: the commit it merges must be one the workspace has and the base branch holds, so the push cannot name any other commit as a parent.
    if (mergeBase !== undefined) {
      await git(repositoryPath, ["cat-file", "-e", `${mergeBase}^{commit}`]).catch(() => {
        throw agentXError("WORKSPACE_NOT_READY", "the base commit of the merge is missing from the workspace");
      });
      if (!(await isAncestor(repositoryPath, mergeBase, `refs/remotes/origin/${invocation.payload.baseBranch}`))) {
        throw agentXError("CONFIG_INVALID", "the base commit of the merge is not part of the base branch");
      }
    }
    // A workflow task's fix runs no project command here: its checks already ran, on this same tree, before its
    // reviews, and the tree is checked again below. Any other append runs the project's readiness checks.
    const reviewedTree = invocation.payload.workflowCandidateTreeSha;
    const baseCommit = invocation.payload.workflowBaseCommit;
    if (reviewedTree !== undefined && baseCommit !== undefined) {
      await git(repositoryPath, ["cat-file", "-e", `${baseCommit}^{commit}`]).catch(() => {
        throw agentXError("WORKSPACE_NOT_READY", "the task's base commit is missing from the workspace");
      });
      if (!(await isAncestor(repositoryPath, baseCommit, currentHead))) {
        throw agentXError("CONFIG_INVALID", WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE);
      }
    }
    const checks = reviewedTree === undefined ? await runReadinessChecks(rootPath, invocation, manifest, readinessOptions) : [];
    if (checks.some((check) => check.outcome !== "passed")) {
      throw agentXError("CONFIG_INVALID", "one or more registered readiness checks failed");
    }
    try {
      await assertWorkspaceIsPlain(repositoryPath);
    } catch (error) {
      if (error instanceof AgentXError) throw error;
      throw agentXError("CONFIG_INVALID", "Git could not read the repository's files");
    }
    let workspaceTree: string;
    if (reviewedTree === undefined) {
      await git(repositoryPath, ["add", "--all", "--", ".", CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC]);
      workspaceTree = (await git(repositoryPath, ["write-tree"])).trim();
    } else {
      // In a temporary index, as the reviewed tree was computed, so the real index is untouched.
      workspaceTree = await temporaryIndexTree({ directory: repositoryPath });
      if (workspaceTree !== reviewedTree) throw agentXError("CONFIG_INVALID", WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE);
    }
    const publishedTree = (await git(repositoryPath, ["rev-parse", `${remoteHead}^{tree}`])).trim();
    // The fix is the merge of the base: whatever the base changed outside the files that conflicted must be in the tree. The candidate is captured from the working tree, so a file the repository ignores,
    // or one the coder took back, would be missing here, and a merge commit that names the base as a parent would make GitHub treat its change as merged: merging the pull request would delete it.
    if (mergeBase !== undefined) await assertKeepsBaseChanges(repositoryPath, remoteHead, mergeBase, workspaceTree);
    // A merge commit is worth recording even when its tree is the head's own (every change of the base lay in the conflicting files, and the conflict was resolved to the pull request's side). (A round
    // that changed nothing at all is stopped earlier, by the broker.)
    if (workspaceTree === publishedTree && mergeBase === undefined) {
      throw agentXError("CONFIG_INVALID", "repository has no effective changes to append");
    }
    commit = (await git(repositoryPath, [
      "-c", `user.name=${AGENTX_GIT_NAME}`, "-c", `user.email=${AGENTX_GIT_EMAIL}`,
      "commit-tree", workspaceTree, "-p", remoteHead, ...(mergeBase === undefined ? [] : ["-p", mergeBase]),
      "-m", reviewedTree === undefined ? `AgentX: update PR #${invocation.payload.pullRequestNumber}` : reviewedFixMessage(invocation.payload.workflowFix?.source),
    ])).trim();
    await git(repositoryPath, ["checkout", "--force", "-B", invocation.payload.headBranch, commit]);
    const codeBuildChecks = await validateCandidate(
      repositoryPath,
      invocation,
      repository.name,
      repository.url,
      repository.codeBuildGates ?? [],
      commit,
      credential,
      options.codeBuildSink,
    );
    // A workflow task's fix is pushed onto the head AgentX recorded and nothing else: GitHub is asked again right before
    // the push, so a branch that moved or was deleted (the pull request merged) meanwhile is never pushed to.
    if (reviewedTree !== undefined
      && await remoteBranchHead(repositoryPath, repository.url, invocation.payload.headBranch, credential) !== remoteHead) {
      throw agentXError("STALE_FENCE", "pull request head changed since AgentX last observed it");
    }
    await push(repositoryPath, repository.url, invocation.payload.headBranch, credential);
    const callback = await options.pullRequestUpdateSink({
      repository: repository.name,
      pullRequestNumber: invocation.payload.pullRequestNumber,
      action: "append",
      headBranch: invocation.payload.headBranch,
      baseBranch: invocation.payload.baseBranch,
      previousCommit: remoteHead,
      commit,
    });
    return PullRequestLifecycleResultSchema.parse({
      action: "append", repository: repository.name, number: invocation.payload.pullRequestNumber,
      url: callback.url, state: callback.state, headBranch: invocation.payload.headBranch,
      baseBranch: invocation.payload.baseBranch, previousCommit: remoteHead, commit,
      ...(reviewedTree === undefined ? {} : { treeSha: workspaceTree }),
      checks, codeBuildChecks, reconciled: callback.reconciled,
    });
  }

  const status = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=dirty"]);
  if (status.trim() && invocation.payload.workflowSync === undefined) throw agentXError("CONFIG_INVALID", "sync requires a clean repository");
  // A workflow task's merge starts only while the task waits for the merge, when nothing of Rovara's is in flight: whatever an abandoned conflict round left (markers, half a resolution, files) goes, so the
  // merge starts from the recorded head and is not refused for it every time.
  if (status.trim()) await git(repositoryPath, ["clean", "--force", "-d", "--quiet"]);
  await git(repositoryPath, ["checkout", "--force", "-B", invocation.payload.headBranch, remoteHead]);
  const baseTip = (await git(repositoryPath, ["rev-parse", `refs/remotes/origin/${invocation.payload.baseBranch}^{commit}`])).trim();
  // A workflow task's merge takes exactly the base commit the broker named (never whatever the base is by now), and only one the base branch holds.
  const workflowSync = invocation.payload.workflowSync;
  const remoteBase = workflowSync?.baseCommit ?? baseTip;
  if (workflowSync !== undefined) {
    const present = await git(repositoryPath, ["cat-file", "-e", `${remoteBase}^{commit}`]).then(() => true, () => false);
    if (!present || !(await isAncestor(repositoryPath, remoteBase, baseTip))) {
      throw agentXError("STALE_FENCE", "the base commit is not part of the base branch as AgentX last observed it");
    }
  }
  if (await isAncestor(repositoryPath, remoteBase, remoteHead)) {
    commit = remoteHead;
    reconciled = true;
  } else {
    try {
      await git(repositoryPath, [
        "-c", `user.name=${AGENTX_GIT_NAME}`, "-c", `user.email=${AGENTX_GIT_EMAIL}`,
        "merge", "--no-edit", "--no-ff", remoteBase,
      ]);
    } catch {
      // A workflow task's merge that conflicted is a result, not an error: the conflicting files are returned and the workspace is left with the merge's files (markers in the conflicting ones, the branch
      // still on the pull request's head) for the coding round that resolves them. Nothing is pushed.
      const unmerged = workflowSync === undefined ? [] : await unmergedPaths(repositoryPath);
      if (unmerged.length > 0) {
        // The merge's files stay as it left them (markers in the conflicting ones, the base's new files in place), and the branch of the workspace moves to a local merge commit of them (parents: the
        // head, then the base commit; never pushed). A candidate cannot be captured from a repository with unmerged index entries, and one is compared with the base commit it is reviewed against,
        // which the workspace's history must therefore hold; the coder resolving the files by editing them, as it edits anything, must not also have to mark each one in Git.
        await git(repositoryPath, ["add", "--all", "--", ".", CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC]);
        const markedTree = (await git(repositoryPath, ["write-tree"])).trim();
        const marked = (await git(repositoryPath, [
          "-c", `user.name=${AGENTX_GIT_NAME}`, "-c", `user.email=${AGENTX_GIT_EMAIL}`,
          "commit-tree", markedTree, "-p", remoteHead, "-p", remoteBase, "-m", "Rovara: the base branch merged in, conflicts not yet resolved (local, not pushed)",
        ])).trim();
        await git(repositoryPath, ["checkout", "--force", "-B", invocation.payload.headBranch, marked]);
        const callback = await options.pullRequestUpdateSink({
          repository: repository.name,
          pullRequestNumber: invocation.payload.pullRequestNumber,
          action: "sync",
          headBranch: invocation.payload.headBranch,
          baseBranch: invocation.payload.baseBranch,
          previousCommit: remoteHead,
          commit: remoteHead,
        });
        return PullRequestLifecycleResultSchema.parse({
          action: "sync", repository: repository.name, number: invocation.payload.pullRequestNumber,
          url: callback.url, state: callback.state, headBranch: invocation.payload.headBranch,
          baseBranch: invocation.payload.baseBranch, previousCommit: remoteHead, commit: remoteHead,
          conflicts: unmerged, checks: [], codeBuildChecks: [], reconciled: true,
        });
      }
      // The merge ran in a throwaway repository, so no MERGE_HEAD exists for `merge --abort`: the workspace was clean before it (checked above), so putting it back
      // on the pull request head, with the index the failed merge left, removes everything the merge wrote.
      await git(repositoryPath, ["reset", "--hard", remoteHead]).catch(() => undefined);
      throw agentXError("CONFIG_INVALID", "pull request branch conflicts with the latest base");
    }
    commit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
  }
  let checks: Awaited<ReturnType<typeof runReadinessChecks>>;
  try {
    // A workflow task's merge that has nothing to merge pushes nothing, so its checks would cost a machine's time for no reason.
    checks = reconciled && workflowSync !== undefined ? [] : await runReadinessChecks(rootPath, invocation, manifest, readinessOptions);
  } catch (error) {
    // For example, the devcontainer did not start: the merge is not kept either.
    throw reconciled ? error : await undoMerge(repositoryPath, remoteHead, error);
  }
  if (checks.some((check) => check.outcome !== "passed")) {
    const failure = agentXError("CONFIG_INVALID", "one or more registered readiness checks failed");
    throw reconciled ? failure : await undoMerge(repositoryPath, remoteHead, failure);
  }
  const codeBuildChecks = reconciled
    ? []
    : await validateCandidate(
      repositoryPath,
      invocation,
      repository.name,
      repository.url,
      repository.codeBuildGates ?? [],
      commit,
      credential,
      options.codeBuildSink,
    );
  if (!reconciled && workflowSync !== undefined) {
    // A workflow task's merge is pushed onto the head AgentX recorded and nothing else: GitHub is asked again right before the push, so a branch a person moved (or deleted) meanwhile is never
    // pushed over. A push GitHub refuses (the App can't push workflow files) leaves the workspace as it was, on the pull request's head.
    try {
      if (await remoteBranchHead(repositoryPath, repository.url, invocation.payload.headBranch, credential) !== remoteHead) {
        throw agentXError("STALE_FENCE", "pull request head changed since AgentX last observed it");
      }
      await push(repositoryPath, repository.url, invocation.payload.headBranch, credential);
    } catch (error) {
      throw await undoMerge(repositoryPath, remoteHead, error);
    }
  } else if (!reconciled) {
    await push(repositoryPath, repository.url, invocation.payload.headBranch, credential);
  }
  const callback = await options.pullRequestUpdateSink({
    repository: repository.name,
    pullRequestNumber: invocation.payload.pullRequestNumber,
    action: "sync",
    headBranch: invocation.payload.headBranch,
    baseBranch: invocation.payload.baseBranch,
    previousCommit: remoteHead,
    commit,
  });
  return PullRequestLifecycleResultSchema.parse({
    action: "sync", repository: repository.name, number: invocation.payload.pullRequestNumber,
    url: callback.url, state: callback.state, headBranch: invocation.payload.headBranch,
    baseBranch: invocation.payload.baseBranch, previousCommit: remoteHead, commit,
    // The merged tree, for the broker to check against what GitHub shows.
    ...(workflowSync === undefined || reconciled ? {} : { treeSha: (await git(repositoryPath, ["rev-parse", `${commit}^{tree}`])).trim() }),
    checks, codeBuildChecks, reconciled: reconciled || callback.reconciled,
  });
}

/**
 * Refuses a conflict round's tree that does not hold everything the base branch brought outside the conflicting files: for each path Git's own merge (`merge-tree`) changed from the head and did not
 * conflict on, the reviewed tree must have the merged content. The coder may change the conflicting files as it needs to, and any other file of its own. All in one throwaway repository: the tree the
 * merge writes exists only in it.
 */
async function assertKeepsBaseChanges(directory: string, head: string, base: string, reviewedTree: string): Promise<void> {
  const options = { index: "none" as const, timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT };
  const dropped = await withIsolatedRepository(directory, "write", { refs: false }, async (repository) => {
    let output: string;
    try {
      output = await repository.text(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", head, base], options);
    } catch (error) {
      // A merge with conflicts exits 1 and still prints the tree it made (the conflicting files as they would be written with markers) and the names of the conflicting paths, NUL-separated.
      const printed = (error as { stdout?: unknown }).stdout;
      if (typeof printed !== "string" || printed === "") throw error;
      output = printed;
    }
    const [tree = "", ...names] = output.split("\0");
    if (!/^[a-f0-9]{40}$/u.test(tree)) throw agentXError("CONFIG_INVALID", "Git could not work out the merge of the base branch");
    const conflicted = new Set(names.filter((name) => name !== ""));
    const paths = async (from: string, to: string): Promise<string[]> =>
      (await repository.text(["diff-tree", "-r", "--name-only", "-z", "--no-renames", from, to], options)).split("\0").filter((name) => name !== "");
    const brought = (await paths(`${head}^{tree}`, tree)).filter((path) => !conflicted.has(path));
    const different = new Set(await paths(tree, reviewedTree));
    return brought.filter((path) => different.has(path));
  }).catch((error: unknown) => {
    if (error instanceof AgentXError) throw error;
    throw agentXError("CONFIG_INVALID", "Git could not work out the merge of the base branch");
  });
  if (dropped.length > 0) {
    const shown = dropped.slice(0, 3).map((path) => path.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 120)).join(", ");
    throw agentXError("CONFIG_INVALID", `${WORKFLOW_FIX_DROPS_BASE_CHANGES} (${shown}${dropped.length > 3 ? ` and ${String(dropped.length - 3)} more` : ""}), so it was not pushed: a fix may change the files that conflicted and its own new files, not a file the base branch changed without a conflict`);
  }
}

/** The files a conflicting merge left unmerged, by name as Git has them (NUL-separated, so a name with a quote or a line break is not misread), at most as many as a result carries. */
async function unmergedPaths(repositoryPath: string): Promise<string[]> {
  const listed = await git(repositoryPath, ["diff", "--name-only", "-z", "--diff-filter=U", "--ignore-submodules=dirty"]).catch(() => "");
  return listed.split("\0").filter((name) => name !== "").slice(0, CONFLICT_PATHS_MAX).map((name) => name.slice(0, 1024));
}

async function validateCandidate(
  repositoryPath: string,
  invocation: MaintainInvocation,
  repository: string,
  url: string,
  gates: NonNullable<MaintainInvocation["payload"]["project"]["repositories"][number]["codeBuildGates"]>,
  commit: string,
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>,
  sink: CodeBuildSink | undefined,
) {
  if (gates.length === 0) return [];
  const validationBranch = `agentx/${invocation.operationId}`;
  await push(repositoryPath, url, validationBranch, credential);
  return runCodeBuildGates({
    repository,
    commit,
    gates,
    ...(sink === undefined ? {} : { sink }),
  });
}

/**
 * Pushes HEAD to the registered URL, never the remote's name: a repository's remote.origin.pushurl would send the
 * push, and the token with it, elsewhere. Then records origin's tracking branch, as a push to origin would have.
 */
async function push(directory: string, url: string, branch: string, credential: Awaited<ReturnType<RepositoryCredentialProvider>>) {
  assertCredentialFreeRemote(url);
  await credentialedGit(directory, ["push", "--porcelain", url, `HEAD:refs/heads/${branch}`], credential, "Git push failed",
    { mode: "read", refs: true, after: ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"] });
}

/** The commit a branch of the registered URL points at, or undefined when the branch does not exist. */
async function remoteBranchHead(directory: string, url: string, branch: string, credential: Awaited<ReturnType<RepositoryCredentialProvider>>): Promise<string | undefined> {
  assertCredentialFreeRemote(url);
  const listed = await credentialedGit(directory, ["ls-remote", url, `refs/heads/${branch}`], credential, "Git ls-remote failed", { mode: "read" });
  return listed.split("\n").map((line) => line.split("\t")).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
}

/**
 * A credentialed command run in a throwaway repository (isolated-repository.ts), never in the workspace repository: the token reaches no Git process whose
 * config the agent controls, whenever the agent wrote it. `after` runs in the same session, so refs it writes are applied to the workspace with the command's.
 */
async function credentialedGit(
  directory: string,
  args: string[],
  credential: GitCredential,
  fallback: string,
  options: { mode: "read" | "write"; refs?: boolean; after?: readonly string[] },
): Promise<string> {
  try {
    return await withIsolatedRepository(directory, options.mode, { refs: options.refs === true }, async (repository) => {
      await repository.assertNetworkSafe();
      const stdout = await repository.credentialed(args, credential, { timeout: 300_000, maxBuffer: MAX_GIT_OUTPUT });
      if (options.after !== undefined) await repository.text(options.after, { index: "none" });
      return stdout;
    });
  } catch (error) {
    // A refusal of the repository's own config is the project's to fix, not a runtime failure.
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", sanitize(error instanceof Error ? error.message : fallback));
  }
}

async function isAncestor(directory: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runIsolatedGit(directory, ["merge-base", "--is-ancestor", ancestor, descendant], { timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT });
    return true;
  } catch (error) {
    const exitCode = (error as { code?: unknown }).code;
    if (exitCode === 1) return false;
    throw agentXError("CONFIG_INVALID", "Git could not compare pull request history");
  }
}

/**
 * Resets a sync's merge after its checks failed or could not run, and returns the error to throw: the
 * original one, which also says when the reset failed, so a failed reset never hides why.
 */
async function undoMerge(repositoryPath: string, remoteHead: string, error: unknown): Promise<unknown> {
  try {
    await git(repositoryPath, ["reset", "--hard", remoteHead]);
    return error;
  } catch (resetError) {
    const reason = `the merge could not be undone: ${resetError instanceof AgentXError ? resetError.message.replace(/^[A-Z_]+: /u, "") : "Git reset failed"}`;
    if (error instanceof AgentXError) return agentXError(error.code, `${error.message.replace(`${error.code}: `, "")}; ${reason}`);
    return new Error(`${error instanceof Error ? error.message : "readiness checks could not run"}; ${reason}`);
  }
}

async function loadManifest(rootPath: string, invocation: MaintainInvocation): Promise<PreparationManifest> {
  try {
    const manifest = JSON.parse(await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8")) as PreparationManifest;
    if (
      manifest.schemaVersion !== 2 || !manifest.complete ||
      manifest.projectName !== invocation.payload.project.name ||
      manifest.projectRevision !== invocation.projectRevision
    ) throw new Error("stale");
    return manifest;
  } catch {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation manifest is missing or stale");
  }
}

/**
 * Git for the workspace repository, each command in a throwaway repository that never reads the workspace's config, hooks or attributes files (see
 * isolated-repository.ts): readiness checks (project code) and the agent's own processes can write those at any moment, so a read of them made before a call
 * would not hold during it.
 */
async function git(directory: string, args: readonly string[]): Promise<string> {
  try {
    // `remote get-url` reads one value of the repository's config, from a private copy of the file; nothing in it is run.
    if (args.length === 3 && args[0] === "remote" && args[1] === "get-url") {
      const url = await withIsolatedRepository(directory, "read", {}, (repository) => repository.remoteUrl(args[2]));
      if (url === undefined) throw new Error(`No such remote '${args[2]}'`);
      return `${url}\n`;
    }
    return await runIsolatedGit(directory, args, { timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    const processError = error as Error & { stderr?: string };
    throw agentXError("CONFIG_INVALID", sanitize(processError.stderr ?? processError.message));
  }
}

function containedPath(rootPath: string, configuredPath: string): string {
  if (isAbsolute(configuredPath)) throw agentXError("CONFIG_INVALID", "repository path must be relative");
  const candidate = resolve(rootPath, configuredPath);
  assertContained(rootPath, candidate);
  return candidate;
}

function assertContained(rootPath: string, candidate: string): void {
  const fromRoot = relative(rootPath, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw agentXError("CONFIG_INVALID", "repository path escapes the workspace root");
  }
}

function sanitize(value: string): string {
  // Redacted before it is cut to its last 16 KiB, where Git says what failed (#170).
  return storedCommandOutput(value.replace(/https:\/\/[^@\s/]+@/giu, "https://[redacted]@"), 16_384) || "Git command failed";
}

/** The message of a reviewed fix's commit: what the fix is for, when the broker says (Plan 6 Task 15), else the one PR feedback fixes always had. */
function reviewedFixMessage(source: "ci" | "conflict" | "feedback" | undefined): string {
  return source === "ci" ? "Rovara: fix failing CI" : source === "conflict" ? "Rovara: resolve conflict with the base branch" : "AgentX: address PR feedback";
}
