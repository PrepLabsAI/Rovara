// rovara loop (#355): each work item gets its own git worktree and branch, beside the developer's checkout,
// so the agent never touches the files they are working on.
import { access } from "node:fs/promises";
import { run, type Exec } from "./exec.js";

/**
 * `defaultBranch` is the repository's default branch as GitHub names it; the worktree starts from origin's copy of it,
 * or (#359) from `from`, a ref the caller fetched (Contribute: someone else's pull request's head).
 */
export async function ensureWorktree(exec: Exec, repoPath: string, dir: string, branch: string, defaultBranch: string, from?: string): Promise<void> {
  if (await access(dir).then(() => true, () => false)) return;
  // Best effort: an offline machine still gets a worktree, from what it already has.
  await exec("git", ["-C", repoPath, "fetch", "--quiet", "origin"]);
  const fetched = from !== undefined || (await exec("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${defaultBranch}`])).code === 0;
  const base = from ?? (fetched ? `origin/${defaultBranch}` : "HEAD");
  const existing = (await exec("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  await run(exec, "git", ["-C", repoPath, "worktree", "add", ...(existing ? [dir, branch] : ["-b", branch, dir, base])]);
}
