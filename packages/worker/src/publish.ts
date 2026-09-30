import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  PullRequestResultSchema,
  PullRequestLifecycleResultSchema,
  agentXError,
  type PublicationCheckResult,
  type PullRequestResult,
  type PullRequestLifecycleResult,
  type WorkerInvocation,
} from "@agentx/contracts";
import { gitSafeEnvironment } from "./git.js";
import { assertCredentialFreeRemote, runGitWithCredential } from "./git-auth.js";
import type { PullRequestSink } from "./callback-client.js";
import { runCodeBuildGates, type CodeBuildSink } from "./codebuild.js";
import type { RepositoryCredentialProvider } from "./repository-credentials.js";
import { runProjectCommand, type PreparationManifest } from "./prepare.js";
import { storedCommandOutput } from "./command-failure.js";
import type { CommandResult } from "./readiness.js";

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

  const remoteUrl = (await git(repositoryPath, ["remote", "get-url", "origin"])).trim();
  assertCredentialFreeRemote(remoteUrl);
  if (remoteUrl !== repository.url) {
    throw agentXError("CONFIG_INVALID", "repository remote does not match the registered project");
  }
  const conflicts = await git(repositoryPath, ["diff", "--name-only", "--diff-filter=U"]);
  if (conflicts.trim()) throw agentXError("CONFIG_INVALID", "repository has unresolved merge conflicts");

  const currentBranch = await git(repositoryPath, ["branch", "--show-current"]);
  const currentCommit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
  const status = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const retryingCommittedPublication =
    currentBranch.trim() === invocation.payload.headBranch && status.trim().length === 0;
  const hasCommittedChanges = currentCommit !== manifestRepository.resolvedCommit;
  if (mode !== "revert" && !retryingCommittedPublication && status.trim().length === 0 && !hasCommittedChanges) {
    throw agentXError("CONFIG_INVALID", "repository has no changes to publish");
  }

  const credential = await options.credentialProvider(repository);
  let commit: string;
  if (retryingCommittedPublication) {
    commit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
  } else if (mode === "revert") {
    if (!invocation.payload.revertCommit) {
      throw agentXError("CONFIG_INVALID", "revert publication is missing the merged commit");
    }
    commit = await prepareRevertCommit({
      repositoryPath,
      baseBranch: repository.defaultBranch,
      headBranch: invocation.payload.headBranch,
      revertCommit: invocation.payload.revertCommit,
      credential,
    });
  } else {
    commit = await prepareCleanPublicationCommit({
      repositoryPath,
      baseBranch: repository.defaultBranch,
      preparationCommit: manifestRepository.resolvedCommit,
      headBranch: invocation.payload.headBranch,
      title: invocation.payload.title,
      credential,
    });
  }

  const checks: PublicationCheckResult[] = await runReadinessChecks(rootPath, invocation);
  if (checks.some((check) => check.outcome !== "passed")) {
    throw agentXError("CONFIG_INVALID", "one or more registered readiness checks failed");
  }

  try {
    await runGitWithCredential({
      directory: repositoryPath,
      args: [
        "-C",
        repositoryPath,
        "push",
        "--porcelain",
        "origin",
        `HEAD:refs/heads/${invocation.payload.headBranch}`,
      ],
      credential,
      timeout: 300_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git push failed";
    throw agentXError("RUNTIME_UNAVAILABLE", sanitizeGitError(message));
  }

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
  if (mode === "create") return PullRequestResultSchema.parse(baseResult);
  return PullRequestLifecycleResultSchema.parse({
    ...baseResult,
    action: mode,
    state: "open",
    ...(mode === "replace" && invocation.payload.targetPullRequestNumber !== undefined
      ? { replacementFor: invocation.payload.targetPullRequestNumber }
      : {}),
  });
}

async function prepareRevertCommit(input: {
  repositoryPath: string;
  baseBranch: string;
  headBranch: string;
  revertCommit: string;
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>;
}): Promise<string> {
  try {
    await runGitWithCredential({
      directory: input.repositoryPath,
      args: [
        "-C", input.repositoryPath, "fetch", "--no-tags", "origin",
        `refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`,
      ],
      credential: input.credential,
      timeout: 300_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch (error) {
    throw agentXError("RUNTIME_UNAVAILABLE", sanitizeGitError(error instanceof Error ? error.message : "Git fetch failed"));
  }
  const baseCommit = (await git(input.repositoryPath, ["rev-parse", `refs/remotes/origin/${input.baseBranch}^{commit}`])).trim();
  if (!(await isAncestor(input.repositoryPath, input.revertCommit, baseCommit))) {
    throw agentXError("STALE_FENCE", "merged pull request commit is not reachable from the latest base");
  }
  await git(input.repositoryPath, ["checkout", "--force", "-B", input.headBranch, baseCommit]);
  const parents = (await git(input.repositoryPath, ["rev-list", "--parents", "-n", "1", input.revertCommit]))
    .trim().split(/\s+/u);
  if (parents.length < 2) throw agentXError("CONFIG_INVALID", "cannot revert a root commit");
  try {
    await git(input.repositoryPath, [
      "-c", "user.name=AgentX", "-c", "user.email=agentx@noreply.local",
      "revert", "--no-edit", ...(parents.length > 2 ? ["-m", "1"] : []), input.revertCommit,
    ]);
  } catch {
    await git(input.repositoryPath, ["revert", "--abort"]).catch(() => undefined);
    await git(input.repositoryPath, ["reset", "--hard", baseCommit]);
    throw agentXError("CONFIG_INVALID", "merged pull request cannot be reverted cleanly");
  }
  const commit = (await git(input.repositoryPath, ["rev-parse", "HEAD"])).trim();
  if (commit === baseCommit) throw agentXError("CONFIG_INVALID", "revert produced no change");
  return commit;
}

async function prepareCleanPublicationCommit(input: {
  repositoryPath: string;
  baseBranch: string;
  preparationCommit: string;
  headBranch: string;
  title: string;
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>;
}): Promise<string> {
  await git(input.repositoryPath, ["add", "--all"]);
  const workspaceTree = (await git(input.repositoryPath, ["write-tree"])).trim();
  const workspaceCommit = (await git(input.repositoryPath, [
    "-c",
    "user.name=AgentX",
    "-c",
    "user.email=agentx@noreply.local",
    "commit-tree",
    workspaceTree,
    "-p",
    input.preparationCommit,
    "-m",
    "AgentX workspace snapshot",
  ])).trim();

  try {
    await runGitWithCredential({
      directory: input.repositoryPath,
      args: [
        "-C",
        input.repositoryPath,
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`,
      ],
      credential: input.credential,
      timeout: 300_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git fetch failed";
    throw agentXError("RUNTIME_UNAVAILABLE", sanitizeGitError(message));
  }

  const baseCommit = (await git(input.repositoryPath, [
    "rev-parse",
    `refs/remotes/origin/${input.baseBranch}^{commit}`,
  ])).trim();
  const mergedTree = await mergeWorkspaceTree(input.repositoryPath, baseCommit, workspaceCommit);
  const baseTree = (await git(input.repositoryPath, ["rev-parse", `${baseCommit}^{tree}`])).trim();
  if (mergedTree === baseTree) {
    throw agentXError("CONFIG_INVALID", "repository has no changes to publish against the latest base");
  }

  const commit = (await git(input.repositoryPath, [
    "-c",
    "user.name=AgentX",
    "-c",
    "user.email=agentx@noreply.local",
    "commit-tree",
    mergedTree,
    "-p",
    baseCommit,
    "-m",
    `AgentX: ${input.title}`,
  ])).trim();
  await git(input.repositoryPath, ["checkout", "--force", "-B", input.headBranch, commit]);
  return commit;
}

async function mergeWorkspaceTree(
  repositoryPath: string,
  baseCommit: string,
  workspaceCommit: string,
): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", repositoryPath, "merge-tree", "--write-tree", baseCommit, workspaceCommit],
      {
        timeout: 120_000,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        env: gitSafeEnvironment(repositoryPath),
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

async function isAncestor(repositoryPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repositoryPath, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: 120_000,
      maxBuffer: MAX_GIT_OUTPUT,
      env: gitSafeEnvironment(repositoryPath),
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

export async function runReadinessChecks(
  rootPath: string,
  invocation: CheckedInvocation,
): Promise<PublicationCheckResult[]> {
  const results: PublicationCheckResult[] = [];
  for (const [index, command] of invocation.payload.project.readiness.entries()) {
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
    const result = await runProjectCommand(command, index, rootPath);
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

async function git(directory: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", directory, ...args], {
      timeout: 120_000,
      maxBuffer: MAX_GIT_OUTPUT,
      encoding: "utf8",
      env: gitSafeEnvironment(directory),
    });
    return result.stdout;
  } catch (error) {
    const processError = error as Error & { stderr?: string };
    throw agentXError("CONFIG_INVALID", sanitizeGitError(processError.stderr ?? processError.message));
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

function sanitizeGitError(value: string): string {
  // Redacted before it is cut to its last 16 KiB, where Git says what failed (#170).
  return storedCommandOutput(value
    .replace(/https:\/\/[^@\s/]+@/giu, "https://[redacted]@")
    .replace(/(authorization:)[^\r\n]*/giu, "$1 [redacted]"), 16_384) || "Git command failed";
}
