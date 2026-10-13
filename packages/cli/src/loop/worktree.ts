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

/**
 * #392: a checkout for Codex. Its sandbox lets nothing write a `.git` directory, even one it is told it may write, so a
 * worktree (whose git data lives in the developer's checkout's .git) can't take its commits. A local clone whose git
 * directory is `gitDir`, not named .git, can, with that directory writable. It fetches from and pushes to the developer
 * checkout's origin. `from`: the refspec to fetch and the ref to start from, instead of origin's default branch.
 */
export async function ensureClone(exec: Exec, repoPath: string, dir: string, gitDir: string, branch: string, defaultBranch: string, from?: { fetch: string; ref: string }): Promise<void> {
  if (await access(dir).then(() => true, () => false)) return;
  const origin = (await run(exec, "git", ["-C", repoPath, "remote", "get-url", "origin"])).trim();
  // A local clone shares the checkout's objects by hard links, so it is quick and needs no network.
  await run(exec, "git", ["clone", "--quiet", "--no-checkout", `--separate-git-dir=${gitDir}`, repoPath, dir]);
  await run(exec, "git", ["-C", dir, "remote", "set-url", "origin", origin]);
  // Best effort, as for a worktree: offline, the clone starts from what the checkout had.
  const fetched = (await exec("git", ["-C", dir, "fetch", "--quiet", "origin"])).code === 0;
  if (from !== undefined) await run(exec, "git", ["-C", dir, "fetch", "--quiet", "origin", from.fetch]);
  const base = from?.ref ?? (fetched ? `origin/${defaultBranch}` : `origin/HEAD`);
  await run(exec, "git", ["-C", dir, "checkout", "--quiet", "-b", branch, base]);
}
