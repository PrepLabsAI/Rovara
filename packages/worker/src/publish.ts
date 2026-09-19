import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  PullRequestResultSchema,
  agentXError,
  type PublicationCheckResult,
  type PullRequestResult,
  type WorkerInvocation,
} from "@agentx/contracts";
import { gitSafeEnvironment } from "./git.js";
import { assertCredentialFreeRemote, runGitWithCredential } from "./git-auth.js";
import type { PullRequestSink } from "./callback-client.js";
import type { RepositoryCredentialProvider } from "./repository-credentials.js";
import { runProjectCommand, type PreparationManifest } from "./prepare.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1_048_576;
type PublishInvocation = Extract<WorkerInvocation, { kind: "publish" }>;

export interface PublishWorkspaceOptions {
  rootPath: string;
  invocation: PublishInvocation;
  credentialProvider: RepositoryCredentialProvider;
  pullRequestSink: PullRequestSink;
}

export async function publishWorkspace(options: PublishWorkspaceOptions): Promise<PullRequestResult> {
  const { invocation } = options;
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
  if (!retryingCommittedPublication && status.trim().length === 0 && !hasCommittedChanges) {
    throw agentXError("CONFIG_INVALID", "repository has no changes to publish");
  }

  const checks = await runReadinessChecks(rootPath, invocation);
  if (checks.some((check) => check.outcome !== "passed")) {
    throw agentXError("CONFIG_INVALID", "one or more registered readiness checks failed");
  }

  let commit: string;
  if (retryingCommittedPublication) {
    commit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
  } else {
    await git(repositoryPath, ["checkout", "-B", invocation.payload.headBranch]);
    await git(repositoryPath, ["add", "--all"]);
    await git(repositoryPath, [
      "-c",
      "user.name=AgentX",
      "-c",
      "user.email=agentx@noreply.local",
      "commit",
      "--no-gpg-sign",
      ...(status.trim().length === 0 ? ["--allow-empty"] : []),
      "-m",
      `AgentX: ${invocation.payload.title}`,
    ]);
    commit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
  }

  const credential = await options.credentialProvider(repository);
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

  const pullRequest = await options.pullRequestSink({
    repository: repository.name,
    repositoryUrl: repository.url,
    headBranch: invocation.payload.headBranch,
    baseBranch: repository.defaultBranch,
    commit,
    title: invocation.payload.title,
    ...(invocation.payload.body === undefined ? {} : { body: invocation.payload.body }),
  });
  return PullRequestResultSchema.parse({
    repository: repository.name,
    number: pullRequest.number,
    url: pullRequest.url,
    headBranch: invocation.payload.headBranch,
    baseBranch: repository.defaultBranch,
    commit,
    checks,
    reconciled: pullRequest.reconciled,
  });
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
    manifest.projectRevision !== invocation.projectRevision ||
    manifest.environmentDigest !== invocation.payload.project.environment.image
  ) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation manifest is incomplete or stale");
  }
  return manifest;
}

async function runReadinessChecks(
  rootPath: string,
  invocation: PublishInvocation,
): Promise<PublicationCheckResult[]> {
  const results: PublicationCheckResult[] = [];
  for (const [index, command] of invocation.payload.project.readiness.entries()) {
    const startedAt = new Date().toISOString();
    const result = await runProjectCommand(command, index, rootPath);
    results.push({
      index,
      cwd: command.cwd,
      executable: command.executable,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 1_048_576),
      stderr: result.stderr.slice(0, 1_048_576),
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: result.exitCode === 0 ? "passed" : result.exitCode === -1 ? "timed_out" : "failed",
    });
  }
  return results;
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
  return value
    .replace(/https:\/\/[^@\s/]+@/giu, "https://[redacted]@")
    .replace(/(authorization:)[^\r\n]*/giu, "$1 [redacted]")
    .slice(0, 16_384) || "Git command failed";
}
