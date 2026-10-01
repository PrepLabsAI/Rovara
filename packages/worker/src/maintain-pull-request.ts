import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  AgentXError,
  PullRequestLifecycleResultSchema,
  agentXError,
  type WorkerInvocation,
  type PullRequestLifecycleResult,
} from "@agentx/contracts";
import { AGENTX_GIT_EMAIL, AGENTX_GIT_NAME, gitSafeEnvironment } from "./git.js";
import { assertCredentialFreeRemote, runGitWithCredential } from "./git-auth.js";
import type { PullRequestUpdateSink } from "./callback-client.js";
import { runCodeBuildGates, type CodeBuildSink } from "./codebuild.js";
import type { RepositoryCredentialProvider } from "./repository-credentials.js";
import { runReadinessChecks } from "./publish.js";
import { storedCommandOutput } from "./command-failure.js";
import type { PreparationManifest } from "./prepare.js";
import type { DevcontainerCli } from "./devcontainer.js";

const execFileAsync = promisify(execFile);
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
}): Promise<PullRequestLifecycleResult> {
  const { invocation } = options;
  // In the devcontainer preparation recorded, as at publication (#183).
  const readinessOptions = options.devcontainerCli !== undefined ? { devcontainerCli: options.devcontainerCli } : {};
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

  const credential = await options.credentialProvider(repository);
  await credentialedGit(repositoryPath, [
    "-C", repositoryPath, "fetch", "--no-tags", "origin",
    `refs/heads/${invocation.payload.headBranch}:refs/remotes/origin/${invocation.payload.headBranch}`,
    `refs/heads/${invocation.payload.baseBranch}:refs/remotes/origin/${invocation.payload.baseBranch}`,
  ], credential, "Git fetch failed");
  const remoteHead = (await git(repositoryPath, ["rev-parse", `refs/remotes/origin/${invocation.payload.headBranch}^{commit}`])).trim();
  if (remoteHead !== invocation.payload.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request head changed since AgentX last observed it");
  }
  const conflicts = await git(repositoryPath, ["diff", "--name-only", "--diff-filter=U"]);
  if (conflicts.trim()) throw agentXError("CONFIG_INVALID", "repository has unresolved merge conflicts");

  let commit: string;
  let reconciled = false;
  if (invocation.payload.action === "append") {
    const currentHead = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
    if (!(await isAncestor(repositoryPath, remoteHead, currentHead))) {
      throw agentXError("STALE_FENCE", "workspace history is not a fast-forward of the pull request head");
    }
    const status = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (currentHead === remoteHead && !status.trim()) {
      throw agentXError("CONFIG_INVALID", "repository has no new changes to append");
    }
    const checks = await runReadinessChecks(rootPath, invocation, manifest, readinessOptions);
    if (checks.some((check) => check.outcome !== "passed")) {
      throw agentXError("CONFIG_INVALID", "one or more registered readiness checks failed");
    }
    await git(repositoryPath, ["add", "--all"]);
    const workspaceTree = (await git(repositoryPath, ["write-tree"])).trim();
    const publishedTree = (await git(repositoryPath, ["rev-parse", `${remoteHead}^{tree}`])).trim();
    if (workspaceTree === publishedTree) {
      throw agentXError("CONFIG_INVALID", "repository has no effective changes to append");
    }
    commit = (await git(repositoryPath, [
      "-c", `user.name=${AGENTX_GIT_NAME}`, "-c", `user.email=${AGENTX_GIT_EMAIL}`,
      "commit-tree", workspaceTree, "-p", remoteHead,
      "-m", `AgentX: update PR #${invocation.payload.pullRequestNumber}`,
    ])).trim();
    await git(repositoryPath, ["checkout", "--force", "-B", invocation.payload.headBranch, commit]);
    const codeBuildChecks = await validateCandidate(
      repositoryPath,
      invocation,
      repository.name,
      repository.codeBuildGates ?? [],
      commit,
      credential,
      options.codeBuildSink,
    );
    await push(repositoryPath, invocation.payload.headBranch, credential);
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
      checks, codeBuildChecks, reconciled: callback.reconciled,
    });
  }

  const status = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) throw agentXError("CONFIG_INVALID", "sync requires a clean repository");
  await git(repositoryPath, ["checkout", "--force", "-B", invocation.payload.headBranch, remoteHead]);
  const remoteBase = (await git(repositoryPath, ["rev-parse", `refs/remotes/origin/${invocation.payload.baseBranch}^{commit}`])).trim();
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
      await git(repositoryPath, ["merge", "--abort"]).catch(() => undefined);
      throw agentXError("CONFIG_INVALID", "pull request branch conflicts with the latest base");
    }
    commit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
  }
  let checks: Awaited<ReturnType<typeof runReadinessChecks>>;
  try {
    checks = await runReadinessChecks(rootPath, invocation, manifest, readinessOptions);
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
      repository.codeBuildGates ?? [],
      commit,
      credential,
      options.codeBuildSink,
    );
  if (!reconciled) await push(repositoryPath, invocation.payload.headBranch, credential);
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
    checks, codeBuildChecks, reconciled: reconciled || callback.reconciled,
  });
}

async function validateCandidate(
  repositoryPath: string,
  invocation: MaintainInvocation,
  repository: string,
  gates: NonNullable<MaintainInvocation["payload"]["project"]["repositories"][number]["codeBuildGates"]>,
  commit: string,
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>,
  sink: CodeBuildSink | undefined,
) {
  if (gates.length === 0) return [];
  const validationBranch = `agentx/${invocation.operationId}`;
  await push(repositoryPath, validationBranch, credential);
  return runCodeBuildGates({
    repository,
    commit,
    gates,
    ...(sink === undefined ? {} : { sink }),
  });
}

async function push(directory: string, branch: string, credential: Awaited<ReturnType<RepositoryCredentialProvider>>) {
  await credentialedGit(directory, ["-C", directory, "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], credential, "Git push failed");
}

async function credentialedGit(
  directory: string,
  args: string[],
  credential: Awaited<ReturnType<RepositoryCredentialProvider>>,
  fallback: string,
): Promise<void> {
  try {
    await runGitWithCredential({ directory, args, credential, timeout: 300_000, maxBuffer: MAX_GIT_OUTPUT });
  } catch (error) {
    throw agentXError("RUNTIME_UNAVAILABLE", sanitize(error instanceof Error ? error.message : fallback));
  }
}

async function isAncestor(directory: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", directory, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT, env: gitSafeEnvironment(directory),
    });
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

async function git(directory: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", directory, ...args], {
      timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT, encoding: "utf8", env: gitSafeEnvironment(directory),
    });
    return result.stdout;
  } catch (error) {
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
