import { closeContentDigest, readCloseManifest } from "./close-content.js";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  WorkspaceClosePreflightResultSchema,
  AgentXError,
  agentXError,
  type WorkspaceClosePreflightResult,
  type WorkspaceCloseReason,
} from "@agentx/contracts";
import { runIsolatedGit } from "./isolated-repository.js";
import { storedCommandOutput } from "./command-failure.js";
import { OperationJournal } from "./journal.js";
import type { WorkerInvocation } from "@agentx/contracts";

const MAX_GIT_OUTPUT = 1_048_576;

export async function inspectWorkspaceForClose(rootPathValue: string): Promise<WorkspaceClosePreflightResult> {
  const rootPath = await realpath(resolve(rootPathValue));
  const manifest = await readCloseManifest(rootPath);

  const repositories: WorkspaceClosePreflightResult["repositories"] = [];
  for (const repository of manifest.repositories) {
    const configured = containedPath(rootPath, repository.path);
    const metadata = await stat(configured).catch(() => undefined);
    if (!metadata?.isDirectory()) throw agentXError("WORKSPACE_NOT_READY", `prepared repository is missing: ${repository.name}`);
    const directory = await realpath(configured);
    assertContained(rootPath, directory);
    const reasons: WorkspaceCloseReason[] = [];
    const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=dirty"]);
    const statusLines = status.split("\n").filter(Boolean);
    // Porcelain hides these index flags and stashes leave the worktree clean.
    const hiddenIndex = (await git(directory, ["ls-files", "-v", "-z"])).split("\0").some((entry) => /^[a-zS] /u.test(entry));
    const localRefs = await hasLocalRefs(directory);
    if (statusLines.some((line) => !line.startsWith("??")) || hiddenIndex || localRefs) reasons.push("worktree_changes");
    if (statusLines.some((line) => line.startsWith("??"))) reasons.push("untracked_files");
    if ((await git(directory, ["for-each-ref", "--format=%(refname)", "--contains", "HEAD", "refs/remotes"])).trim() === "") {
      reasons.push("unpushed_head");
    }
    if ((await git(directory, ["rev-list", "--branches", "--not", "--remotes"])).trim() !== "") {
      reasons.push("unpushed_branch");
    }
    if (reasons.length > 0) repositories.push({ name: repository.name, reasons });
  }
  repositories.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const contentDigest = await closeContentDigest(rootPath, manifest);
  return WorkspaceClosePreflightResultSchema.parse({ safeToClose: repositories.length === 0, repositories, contentDigest });
}

/** A published tag needs both the same name and the same object, including annotated tag identity.
 * Preparation saves remote tag refs separately. Missing evidence stays local; reachability alone cannot publish a tag.
 */
async function hasLocalRefs(directory: string): Promise<boolean> {
  const remoteTags = "refs/rovara/remote-tags/origin/";
  const refs = new Map((await git(directory, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).split("\n").filter(Boolean).map((line) => {
    const [name, object] = line.split("\0"); return [name!, object!] as const;
  }));
  for (const [ref, object] of refs) {
    if (ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/") || ref.startsWith(remoteTags)) continue;
    if (ref.startsWith("refs/tags/") && refs.get(remoteTags + ref.slice("refs/tags/".length)) === object) continue;
    return true;
  }
  return false;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  try {
    // In a throwaway repository that never reads the workspace repository's config (isolated-repository.ts).
    return await runIsolatedGit(directory, args, { timeout: 120_000, maxBuffer: MAX_GIT_OUTPUT });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
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

/**
 * The worker's answer to a close invocation (058-stop-close): the check judges a workspace nothing is writing to. While another operation is active here (an old run whose stop did not land, say), its
 * answer could be stale a moment later, so it refuses, and the close fails without deleting anything.
 * OperationJournal.accept raises the durable workspace fence before this check
 * runs, so delayed older invocations cannot write after a completed inspection.
 */
export async function closeInvocationResult(
  rootPath: string,
  otherOperationActive: () => boolean,
  invocation?: Pick<WorkerInvocation, "workspaceId" | "fence">,
): Promise<WorkspaceClosePreflightResult> {
  // The server raises at append too; retain the barrier for direct executor
  // calls, including a close whose busy check or inspection later fails.
  if (invocation !== undefined) await new OperationJournal(rootPath).raiseFence(invocation.workspaceId, invocation.fence);
  if (otherOperationActive()) throw agentXError("WORKSPACE_BUSY", "another operation is still active in this workspace; the close check cannot judge it");
  return inspectWorkspaceForClose(rootPath);
}
