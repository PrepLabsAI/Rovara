import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  WorkspaceClosePreflightResultSchema,
  agentXError,
  type WorkspaceClosePreflightResult,
  type WorkspaceCloseReason,
} from "@agentx/contracts";
import { gitSafeEnvironment } from "./git.js";
import type { PreparationManifest } from "./prepare.js";
import { storedCommandOutput } from "./command-failure.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1_048_576;

export async function inspectWorkspaceForClose(rootPathValue: string): Promise<WorkspaceClosePreflightResult> {
  const rootPath = await realpath(resolve(rootPathValue));
  const manifest = JSON.parse(
    await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (manifest.schemaVersion !== 2 || !manifest.complete) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation is incomplete");
  }
  if (manifest.repositories.length > 32) {
    throw agentXError("CONFIG_INVALID", "workspace manifest contains too many repositories");
  }

  const repositories: WorkspaceClosePreflightResult["repositories"] = [];
  for (const repository of manifest.repositories) {
    const configured = containedPath(rootPath, repository.path);
    const metadata = await stat(configured).catch(() => undefined);
    if (!metadata?.isDirectory()) throw agentXError("WORKSPACE_NOT_READY", `prepared repository is missing: ${repository.name}`);
    const directory = await realpath(configured);
    assertContained(rootPath, directory);
    const reasons: WorkspaceCloseReason[] = [];
    const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const statusLines = status.split("\n").filter(Boolean);
    if (statusLines.some((line) => !line.startsWith("??"))) reasons.push("worktree_changes");
    if (statusLines.some((line) => line.startsWith("??"))) reasons.push("untracked_files");
    if ((await git(directory, ["for-each-ref", "--format=%(refname)", "--contains", "HEAD", "refs/remotes"])).trim() === "") {
      reasons.push("unpushed_head");
    }
    if ((await git(directory, ["rev-list", "--branches", "--not", "--remotes"])).trim() !== "") {
      reasons.push("unpushed_branch");
    }
    if (reasons.length > 0) repositories.push({ name: repository.name, reasons });
  }
  return WorkspaceClosePreflightResultSchema.parse({ safeToClose: repositories.length === 0, repositories });
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
    // Redacted before it is cut to its last 16 KiB, where Git says what failed (#170).
    throw agentXError("CONFIG_INVALID", storedCommandOutput(processError.stderr ?? processError.message, 16_384));
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
