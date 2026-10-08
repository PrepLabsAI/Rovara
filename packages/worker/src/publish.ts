import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  PullRequestResultSchema,
  PullRequestLifecycleResultSchema,
  AgentXError,
  WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE,
  agentXError,
  type CheckEntry,
  type PublicationCheckResult,
  type PullRequestResult,
  type PullRequestLifecycleResult,
  type WorkerInvocation,
} from "@agentx/contracts";
import { AGENTX_GIT_EMAIL, AGENTX_GIT_NAME, assertNoEmbeddedRepositories, assertNoLfsFiles, gitHardenedEnvironment } from "./git.js";
import { assertCredentialFreeRemote, pushCommitFromIsolatedRepository, runGitWithCredential } from "./git-auth.js";
import { stopWorkspaceProcesses } from "./workspace-processes.js";
import { sweepWorkspaceContainers } from "./workspace-containers.js";
import type { PullRequestSink } from "./callback-client.js";
import { runCodeBuildGates, type CodeBuildSink } from "./codebuild.js";
import type { RepositoryCredentialProvider } from "./repository-credentials.js";
import { runProjectCommand, type PreparationCommandRunner, type PreparationManifest } from "./prepare.js";
import { storedCommandOutput } from "./command-failure.js";
import { planChecks, publicationCheckEntries } from "./verification/checks.js";
import type { CommandResult } from "./readiness.js";
import {
  createDevcontainerCli,
  ensureDevcontainer,
  preparedDevcontainerTarget,
  runDevcontainerCommand,
  type DevcontainerCli,
} from "./devcontainer.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1_048_576;
type PublishInvocation = Extract<WorkerInvocation, { kind: "publish" }>;
type CheckedInvocation = Extract<WorkerInvocation, { kind: "publish" | "maintain" }>;

export interface PublishWorkspaceOptions {
  rootPath: string;
  invocation: PublishInvocation;
  credentialProvider: RepositoryCredentialProvider;
  pullRequestSink: PullRequestSink;
  codeBuildSink?: CodeBuildSink;
  /** The `devcontainer` CLI, as a seam for tests. */
  devcontainerCli?: DevcontainerCli;
  /**
   * Stops every process left running from the workspace before the push credential is fetched, failing when it cannot
   * (see workspace-processes.ts for what it covers). A seam for tests; the default stops them for real.
   */
  stopWorkspaceProcesses?: (rootPath: string) => Promise<{ stopped: number } | void>;
  /**
   * Removes every container but the worker's own before the push credential is fetched, failing when it cannot (see
   * workspace-containers.ts). A seam for tests; the default removes them for real in the worker container.
   */
  sweepWorkspaceContainers?: (rootPath: string) => Promise<{ removed: number }>;
}

const CONTAINMENT_ROUNDS = 4;

/**
 * Removes the containers, then stops the processes, until one round finds neither and a last check finds no container
 * either, since either can start the other. Fails closed when they keep coming back. Runs before every credential
 * request of a publication.
 */
async function containWorkspace(
  rootPath: string,
  steps: { sweep: (rootPath: string) => Promise<{ removed: number }>; stop: (rootPath: string) => Promise<{ stopped: number } | void> },
): Promise<void> {
  for (let round = 0; round < CONTAINMENT_ROUNDS; round += 1) {
    const { removed } = await steps.sweep(rootPath);
    const stopped = (await steps.stop(rootPath))?.stopped ?? 0;
    if (removed === 0 && stopped === 0 && (await steps.sweep(rootPath)).removed === 0) return;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX kept finding programs or containers started from the workspace, so it did not push");
}

export async function publishWorkspace(
  options: PublishWorkspaceOptions,
): Promise<PullRequestResult | PullRequestLifecycleResult> {
  const { invocation } = options;
  const mode = invocation.payload.mode ?? "create";
  const rootPath = await realpath(resolve(options.rootPath));
  const manifest = await loadCompleteManifest(rootPath, invocation);
  const repository = invocation.payload.project.repositories.find(
    (candidate) => candidate.name === invocation.payload.repository,
  );
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const manifestRepository = manifest.repositories.find((candidate) => candidate.name === repository.name);
  if (!manifestRepository || manifestRepository.path !== repository.path) {
    throw agentXError("WORKSPACE_NOT_READY", "prepared repository is missing from the workspace manifest");
  }
  const repositoryPath = containedPath(rootPath, repository.path);
  const metadata = await stat(repositoryPath).catch(() => undefined);
  if (!metadata?.isDirectory()) throw agentXError("WORKSPACE_NOT_READY", "prepared repository checkout is missing");
  const canonicalRepositoryPath = await realpath(repositoryPath);
  assertContained(rootPath, canonicalRepositoryPath);
  // Every Git call below, up to the readiness checks, shares one hardened environment. The checks run
  // project code, so the push after them computes its own.
  const git = await repositoryGit(repositoryPath);

  const remoteUrl = (await git(["remote", "get-url", "origin"])).trim();
  assertCredentialFreeRemote(remoteUrl);
  if (remoteUrl !== repository.url) {
    throw agentXError("CONFIG_INVALID", "repository remote does not match the registered project");
  }
  const conflicts = await git(["diff", "--name-only", "--diff-filter=U", "--ignore-submodules=dirty"]);
  if (conflicts.trim()) throw agentXError("CONFIG_INVALID", "repository has unresolved merge conflicts");

  const currentBranch = await git(["branch", "--show-current"]);
  const currentCommit = (await git(["rev-parse", "HEAD"])).trim();
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=dirty"]);
  const retryingCommittedPublication =
    currentBranch.trim() === invocation.payload.headBranch && status.trim().length === 0;
  const hasCommittedChanges = currentCommit !== manifestRepository.resolvedCommit;
  const candidateTreeSha = invocation.payload.candidateTreeSha;
  if (candidateTreeSha === undefined && mode !== "revert" && !retryingCommittedPublication && status.trim().length === 0 && !hasCommittedChanges) {
    throw agentXError("CONFIG_INVALID", "repository has no changes to publish");
  }

  // Every credential this publication asks for (it can push) is fetched only once no process or container the task
  // started is left: each such process runs as this worker's user, so it could read the token or rewrite what Git
  // reads; a container is out of the worker's process view (workspace-containers.ts). Nothing is fetched or pushed when
  // they cannot all be stopped. A fetch of the latest base, for an ordinary publication or a revert, takes its own
  // credential before the readiness checks run, so it is preceded by its own stop too.
  const fetchCredential = async () => {
    await containWorkspace(rootPath, {
      sweep: options.sweepWorkspaceContainers ?? ((root: string) => sweepWorkspaceContainers({ rootPath: root })),
      stop: options.stopWorkspaceProcesses ?? ((root: string) => stopWorkspaceProcesses({ rootPath: root })),
    });
    return options.credentialProvider(repository);
  };
  let commit: string;
  if (candidateTreeSha !== undefined) {
    // A workflow publication: exactly the tree that passed its checks and reviews, on the task's own base: the base the
    // broker pinned for the task when it sends one (never the agent-writable manifest's), else the commit preparation
    // checked out. It is not replayed onto the latest base; GitHub shows any conflict on the pull request.
    const pinnedBase = invocation.payload.workflowBaseCommit;
    if (pinnedBase !== undefined) {
      await git(["cat-file", "-e", `${pinnedBase}^{commit}`]).catch(() => {
        throw agentXError("WORKSPACE_NOT_READY", "the task's base commit is missing from the workspace");
      });
    }
    commit = await prepareCandidatePublicationCommit({
      git,
      preparationCommit: pinnedBase ?? manifestRepository.resolvedCommit,
      headBranch: invocation.payload.headBranch,
      title: invocation.payload.title,
      candidateTreeSha,
      retrying: retryingCommittedPublication,
    });
  } else if (retryingCommittedPublication) {
    commit = (await git(["rev-parse", "HEAD"])).trim();
  } else if (mode === "revert") {
    if (!invocation.payload.revertCommit) {
      throw agentXError("CONFIG_INVALID", "revert publication is missing the merged commit");
    }
    commit = await prepareRevertCommit({
      git,
      remoteUrl: repository.url,
      baseBranch: repository.defaultBranch,
      headBranch: invocation.payload.headBranch,
      revertCommit: invocation.payload.revertCommit,
      credential: await fetchCredential(),
    });
  } else {
    commit = await prepareCleanPublicationCommit({
      git,
      remoteUrl: repository.url,
      baseBranch: repository.defaultBranch,
      preparationCommit: manifestRepository.resolvedCommit,
      headBranch: invocation.payload.headBranch,
      title: invocation.payload.title,
      credential: await fetchCredential(),
    });
  }

  // A workflow publication runs no project command here: its checks already ran, on this same tree, before its reviews,
  // and the tree is checked again above. Only an ordinary publication runs the project's readiness checks.
  let checks: PublicationCheckResult[] = [];
  let checkEntries: CheckEntry[] | undefined;
  if (candidateTreeSha === undefined) {
    checks = await runReadinessChecks(rootPath, invocation, manifest, {
      ...(options.devcontainerCli !== undefined ? { devcontainerCli: options.devcontainerCli } : {}),
    });
    // Spec 051 P-2 (D-7, Ruling S): a broker that asks for the checks opens a draft pull request when one fails, so a
    // failing check no longer refuses the publication. A broker built before it would open a normal one, so it still refuses.
    const reportChecks = invocation.payload.reportChecks === true;
    if (!reportChecks && checks.some((check) => check.outcome !== "passed")) {
      throw agentXError("CONFIG_INVALID", "one or more registered readiness checks failed");
    }
    checkEntries = reportChecks ? judgedChecks(invocation, manifest, checks) : undefined;
  }
  // The object store the push borrows, read before anything is stopped; the push reads nothing else from the workspace.
  const objectsDirectory = (await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"])).trim();

  // Again after the readiness checks, which ran project code.
  const credential = await fetchCredential();
  try {
    // The commit built above, by its ID (project code may have moved HEAD since), to the registered URL (never the
    // remote's name), from a repository AgentX made for the push: the command that holds the token never reads the
    // workspace's config, hooks or attributes.
    await pushCommitFromIsolatedRepository({
      objectsDirectory,
      url: repository.url,
      commit,
      branch: invocation.payload.headBranch,
      credential,
      timeout: 300_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    const message = error instanceof Error ? error.message : "Git push failed";
    throw agentXError("RUNTIME_UNAVAILABLE", sanitizeGitError(message));
  }
  // A push to a URL updates no remote-tracking branch; record it as a push to origin would have.
  await (await repositoryGit(repositoryPath))(["update-ref", `refs/remotes/origin/${invocation.payload.headBranch}`, commit]);

  const codeBuildChecks = await runCodeBuildGates({
    repository: repository.name,
    commit,
    gates: repository.codeBuildGates ?? [],
    ...(options.codeBuildSink === undefined ? {} : { sink: options.codeBuildSink }),
  });

  const pullRequest = await options.pullRequestSink({
    repository: repository.name,
    repositoryUrl: repository.url,
    headBranch: invocation.payload.headBranch,
    baseBranch: repository.defaultBranch,
    commit,
    title: invocation.payload.title,
    ...(invocation.payload.body === undefined ? {} : { body: invocation.payload.body }),
    ...(checkEntries === undefined ? {} : { checks: checkEntries }),
  });
  const baseResult = {
    repository: repository.name,
    number: pullRequest.number,
    url: pullRequest.url,
    headBranch: invocation.payload.headBranch,
    baseBranch: repository.defaultBranch,
    commit,
    checks,
    codeBuildChecks,
    reconciled: pullRequest.reconciled,
  };
  if (mode === "create") return PullRequestResultSchema.parse({ ...baseResult, ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }) });
  return PullRequestLifecycleResultSchema.parse({
    ...baseResult,
    action: mode,
    state: "open",
    ...(mode === "replace" && invocation.payload.targetPullRequestNumber !== undefined
      ? { replacementFor: invocation.payload.targetPullRequestNumber }
      : {}),
  });
}

/**
 * Each readiness result judged against the preparation baseline (Ruling S). The pull request is the workspace's whole
 * change since preparation, so a command preparation ran (and so passed: the workspace was READY) is "passed" before,
 * and any other command, including every command of a workspace prepared before spec 051, has no earlier result. The
 * task history in .agentx/last-checks.json is never read here: an earlier task's failure is not "before this change".
 */
function judgedChecks(
  invocation: PublishInvocation,
  manifest: PreparationManifest,
  results: readonly PublicationCheckResult[],
): CheckEntry[] {
  const baseline = { lastOutcomes: {}, preparedKeys: manifest.readinessCommandKeys ?? [] };
  const plan = planChecks(invocation.payload.project.readiness, { firstRuns: () => [] }, baseline);
  return publicationCheckEntries(plan, results);
}

/** Fetches the base branch from the registered URL (never the remote's name) into origin's tracking branch. */
async function fetchBase(input: {
  git: RepositoryGit;
  remoteUrl: string;
  baseBranch: string;
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>;
}): Promise<void> {
  try {
    await runGitWithCredential({
      directory: input.git.directory,
      args: [
        "-C", input.git.directory, "fetch", "--no-tags", input.remoteUrl,
        `refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`,
      ],
      credential: input.credential,
      timeout: 300_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch (error) {
    // A refusal of the repository's own config is the project's to fix, not a runtime failure.
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", sanitizeGitError(error instanceof Error ? error.message : "Git fetch failed"));
  }
}

async function prepareRevertCommit(input: {
  git: RepositoryGit;
  remoteUrl: string;
  baseBranch: string;
  headBranch: string;
  revertCommit: string;
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>;
}): Promise<string> {
  await fetchBase(input);
  const baseCommit = (await input.git(["rev-parse", `refs/remotes/origin/${input.baseBranch}^{commit}`])).trim();
  if (!(await isAncestor(input.git, input.revertCommit, baseCommit))) {
    throw agentXError("STALE_FENCE", "merged pull request commit is not reachable from the latest base");
  }
  await input.git(["checkout", "--force", "-B", input.headBranch, baseCommit]);
  const parents = (await input.git(["rev-list", "--parents", "-n", "1", input.revertCommit]))
    .trim().split(/\s+/u);
  if (parents.length < 2) throw agentXError("CONFIG_INVALID", "cannot revert a root commit");
  try {
    await input.git([
      "-c", `user.name=${AGENTX_GIT_NAME}`, "-c", `user.email=${AGENTX_GIT_EMAIL}`,
      "revert", "--no-edit", ...(parents.length > 2 ? ["-m", "1"] : []), input.revertCommit,
    ]);
  } catch {
    await input.git(["revert", "--abort"]).catch(() => undefined);
    await input.git(["reset", "--hard", baseCommit]);
    throw agentXError("CONFIG_INVALID", "merged pull request cannot be reverted cleanly");
  }
  const commit = (await input.git(["rev-parse", "HEAD"])).trim();
  if (commit === baseCommit) throw agentXError("CONFIG_INVALID", "revert produced no change");
  return commit;
}

/**
 * The commit for a workflow publication: the workspace's tree, which must be the tree its checks and reviews passed on,
 * with the commit preparation checked out as its only parent. The tree is computed in a temporary index, as the
 * candidate's was, so the real index is untouched. A retry of the same publication reuses the commit it already made.
 */
async function prepareCandidatePublicationCommit(input: {
  git: RepositoryGit;
  preparationCommit: string;
  headBranch: string;
  title: string;
  candidateTreeSha: string;
  retrying: boolean;
}): Promise<string> {
  try {
    await assertNoEmbeddedRepositories(input.git.directory, input.git.env);
    await assertNoLfsFiles(input.git.directory, input.git.env);
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("CONFIG_INVALID", "Git could not read the repository's files");
  }
  const workspaceTree = await temporaryIndexTree(input.git);
  if (workspaceTree !== input.candidateTreeSha) throw agentXError("CONFIG_INVALID", WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE);
  if (input.retrying) {
    const head = (await input.git(["rev-parse", "HEAD"])).trim();
    const headTree = (await input.git(["rev-parse", "HEAD^{tree}"])).trim();
    const parent = (await input.git(["rev-parse", "HEAD^"]).catch(() => "")).trim();
    if (headTree === input.candidateTreeSha && parent === input.preparationCommit) return head;
  }
  const preparedTree = (await input.git(["rev-parse", `${input.preparationCommit}^{tree}`])).trim();
  if (workspaceTree === preparedTree) throw agentXError("CONFIG_INVALID", "repository has no changes to publish");
  const commit = (await input.git([
    "-c", `user.name=${AGENTX_GIT_NAME}`, "-c", `user.email=${AGENTX_GIT_EMAIL}`,
    "commit-tree", workspaceTree, "-p", input.preparationCommit, "-m", `AgentX: ${input.title}`,
  ])).trim();
  await input.git(["checkout", "--force", "-B", input.headBranch, commit]);
  return commit;
}

/** The tree of HEAD plus every tracked and untracked change, staged in a throwaway index under the same hardened Git. */
async function temporaryIndexTree(git: RepositoryGit): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "agentx-publish-index-"));
  const env = { ...git.env, GIT_INDEX_FILE: join(temporary, "index") };
  const run = async (args: readonly string[]): Promise<string> => {
    try {
      return (await execFileAsync("git", ["-C", git.directory, ...args], { timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT, encoding: "utf8", env })).stdout;
    } catch (error) {
      const processError = error as Error & { stderr?: string };
      throw agentXError("CONFIG_INVALID", sanitizeGitError(processError.stderr ?? processError.message));
    }
  };
  try {
    await run(["read-tree", "HEAD"]);
    await run(["add", "--all", "--", "."]);
    return (await run(["write-tree"])).trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function prepareCleanPublicationCommit(input: {
  git: RepositoryGit;
  remoteUrl: string;
  baseBranch: string;
  preparationCommit: string;
  headBranch: string;
  title: string;
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>;
}): Promise<string> {
  try {
    await assertNoEmbeddedRepositories(input.git.directory, input.git.env);
    await assertNoLfsFiles(input.git.directory, input.git.env);
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("CONFIG_INVALID", "Git could not read the repository's files");
  }
  await input.git(["add", "--all"]);
  const workspaceTree = (await input.git(["write-tree"])).trim();
  const workspaceCommit = (await input.git([
    "-c",
    `user.name=${AGENTX_GIT_NAME}`,
    "-c",
    `user.email=${AGENTX_GIT_EMAIL}`,
    "commit-tree",
    workspaceTree,
    "-p",
    input.preparationCommit,
    "-m",
    "AgentX workspace snapshot",
  ])).trim();

  await fetchBase(input);

  const baseCommit = (await input.git([
    "rev-parse",
    `refs/remotes/origin/${input.baseBranch}^{commit}`,
  ])).trim();
  const mergedTree = await mergeWorkspaceTree(input.git, baseCommit, workspaceCommit);
  const baseTree = (await input.git(["rev-parse", `${baseCommit}^{tree}`])).trim();
  if (mergedTree === baseTree) {
    throw agentXError("CONFIG_INVALID", "repository has no changes to publish against the latest base");
  }

  const commit = (await input.git([
    "-c",
    `user.name=${AGENTX_GIT_NAME}`,
    "-c",
    `user.email=${AGENTX_GIT_EMAIL}`,
    "commit-tree",
    mergedTree,
    "-p",
    baseCommit,
    "-m",
    `AgentX: ${input.title}`,
  ])).trim();
  await input.git(["checkout", "--force", "-B", input.headBranch, commit]);
  return commit;
}

async function mergeWorkspaceTree(
  git: RepositoryGit,
  baseCommit: string,
  workspaceCommit: string,
): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", git.directory, "merge-tree", "--write-tree", baseCommit, workspaceCommit],
      {
        timeout: 120_000,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        env: git.env,
      },
    );
    const tree = result.stdout.trim().split(/\s/u)[0];
    if (!tree || !/^[a-f0-9]{40,64}$/u.test(tree)) {
      throw agentXError("CONFIG_INVALID", "Git did not produce a merged workspace tree");
    }
    return tree;
  } catch (error) {
    if (error instanceof Error && error.name === "AgentXError") throw error;
    throw agentXError("CONFIG_INVALID", "workspace changes conflict with the latest default branch");
  }
}

async function isAncestor(git: RepositoryGit, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", git.directory, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: 120_000,
      maxBuffer: MAX_GIT_OUTPUT,
      env: git.env,
    });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw agentXError("CONFIG_INVALID", "Git could not validate merged commit ancestry");
  }
}

async function loadCompleteManifest(
  rootPath: string,
  invocation: PublishInvocation,
): Promise<PreparationManifest> {
  let manifest: PreparationManifest;
  try {
    manifest = JSON.parse(await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8")) as PreparationManifest;
  } catch {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation manifest is missing or invalid");
  }
  if (
    manifest.schemaVersion !== 2 ||
    !manifest.complete ||
    manifest.projectName !== invocation.payload.project.name ||
    manifest.projectRevision !== invocation.projectRevision
  ) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation manifest is incomplete or stale");
  }
  return manifest;
}

/**
 * Runs the project's readiness checks where preparation ran them (#183): in the devcontainer that the
 * preparation manifest records, through the same runner (its timeout stops the command inside the
 * container, #174), otherwise on the host. The devcontainer is started first, as for a task: on a
 * resumed instance its containers are stopped. A devcontainer that does not start fails the call.
 */
export async function runReadinessChecks(
  rootPath: string,
  invocation: CheckedInvocation,
  manifest: Pick<PreparationManifest, "devcontainer" | "repositories">,
  options: { devcontainerCli?: DevcontainerCli } = {},
): Promise<PublicationCheckResult[]> {
  const readiness = invocation.payload.project.readiness;
  let runner: PreparationCommandRunner = runProjectCommand;
  const target = preparedDevcontainerTarget(rootPath, manifest);
  if (target !== undefined && readiness.length > 0) {
    const cli = options.devcontainerCli ?? createDevcontainerCli();
    await ensureDevcontainer(cli, target);
    runner = (command) => runDevcontainerCommand(cli, target, command);
  }
  const results: PublicationCheckResult[] = [];
  for (const [index, command] of readiness.entries()) {
    const startedAt = new Date().toISOString();
    // Readiness comes from the project's latest revision, which may name a repository this
    // workspace was never prepared with. Fail the check rather than skip a gate.
    const missing = await missingCommandDirectory(rootPath, command.cwd);
    if (missing) {
      results.push({
        index,
        cwd: command.cwd,
        executable: command.executable,
        exitCode: 127,
        stdout: "",
        stderr: storedCommandOutput(`readiness command ${index} cannot run: ${command.cwd} is not a directory in this workspace`),
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: "failed",
      });
      continue;
    }
    let result: CommandResult;
    try {
      result = await runner(command, index, rootPath);
    } catch (error) {
      // For example, the devcontainer has no bash (#174). A failed check, as at preparation.
      result = { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : "readiness command could not run" };
    }
    results.push({
      index,
      cwd: command.cwd,
      executable: command.executable,
      exitCode: result.exitCode,
      // Redacted, then cut to the last lines (#170).
      stdout: storedCommandOutput(result.stdout),
      stderr: storedCommandOutput(withEnding(result.stderr, index, command.timeoutSeconds, result)),
      startedAt,
      completedAt: new Date().toISOString(),
      // Timed out only when its own timer fired: a signal or a failed start is a failure (#170).
      outcome: result.timedOut === true ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
    });
  }
  return results;
}

/** Adds a line saying how a check ended, when a timeout or a signal ended it (#170). */
function withEnding(stderr: string, index: number, timeoutSeconds: number, result: CommandResult): string {
  const ending = result.timedOut === true
    ? `readiness command ${index} timed out after ${timeoutSeconds} s`
    : result.signal !== undefined
      ? `readiness command ${index} was killed by ${result.signal}`
      : undefined;
  if (ending === undefined) return stderr;
  return `${stderr}${stderr === "" || stderr.endsWith("\n") ? "" : "\n"}${ending}\n`;
}

async function missingCommandDirectory(rootPath: string, cwd: string): Promise<boolean> {
  try {
    return !(await stat(resolve(rootPath, cwd))).isDirectory();
  } catch {
    return true;
  }
}

/** Git in one repository under one hardened environment, computed once when it is created. */
interface RepositoryGit {
  (args: readonly string[]): Promise<string>;
  readonly directory: string;
  readonly env: NodeJS.ProcessEnv;
}

async function repositoryGit(directory: string): Promise<RepositoryGit> {
  let env: NodeJS.ProcessEnv;
  try {
    env = await gitHardenedEnvironment(directory);
  } catch (error) {
    const processError = error as Error & { stderr?: string };
    throw agentXError("CONFIG_INVALID", sanitizeGitError(processError.stderr ?? processError.message));
  }
  const run = async (args: readonly string[]): Promise<string> => {
    try {
      const result = await execFileAsync("git", ["-C", directory, ...args], {
        timeout: 120_000,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        env,
      });
      return result.stdout;
    } catch (error) {
      const processError = error as Error & { stderr?: string };
      throw agentXError("CONFIG_INVALID", sanitizeGitError(processError.stderr ?? processError.message));
    }
  };
  return Object.assign(run, { directory, env });
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

function sanitizeGitError(value: string): string {
  // Redacted before it is cut to its last 16 KiB, where Git says what failed (#170).
  return storedCommandOutput(value
    .replace(/https:\/\/[^@\s/]+@/giu, "https://[redacted]@")
    .replace(/(authorization:)[^\r\n]*/giu, "$1 [redacted]"), 16_384) || "Git command failed";
}
