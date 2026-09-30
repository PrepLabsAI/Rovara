import { runCollected } from "../collected-process.js";

export type GitRunner = (args: readonly string[]) => Promise<string>;

/** git in `repository`, trusting it although another user owns it: the copy keeps the image's owners. */
export function createGitRunner(repository: string): GitRunner {
  return async (args) => {
    const result = await runCollected("git", ["-c", "safe.directory=*", "-C", repository, ...args], { timeoutMs: 10 * 60_000 });
    if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).trim().slice(-500)}`);
    return result.stdout;
  };
}

/**
 * Leaves the copy with no way back to the upstream fix (FR-010): HEAD detached where the image left
 * it, no branch, tag, remote, stash or reflog, and no object HEAD cannot reach. Verified afterwards.
 * SWE-bench's images commit a "SWE-bench" setup commit on top of the task's base commit, so HEAD is
 * the base commit or a descendant of it. Returns HEAD, which the prediction is diffed against.
 */
export async function stripHistory(git: GitRunner, baseCommit: string): Promise<string> {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  try {
    await git(["merge-base", "--is-ancestor", baseCommit, head]);
  } catch {
    throw new Error(`the image's /testbed is at ${head}, which does not descend from the task's base commit ${baseCommit}`);
  }
  await git(["checkout", "--quiet", "--detach", head]);
  const refs = (await git(["for-each-ref", "--format=%(refname)"])).split("\n").filter((ref) => ref.length > 0);
  for (const ref of refs) await git(["update-ref", "-d", ref]);
  const remotes = (await git(["remote"])).split("\n").filter((remote) => remote.length > 0);
  for (const remote of remotes) await git(["remote", "remove", remote]);
  await git(["reflog", "expire", "--expire=now", "--all"]);
  await git(["gc", "--quiet", "--prune=now"]);
  const reachable = (await git(["rev-list", "--all", "HEAD"])).split("\n").filter((line) => line.length > 0).length;
  const fromHead = (await git(["rev-list", "HEAD"])).split("\n").filter((line) => line.length > 0).length;
  if (reachable !== fromHead) throw new Error("commits beyond the base commit are still reachable after stripping history");
  return head;
}

/** Untracked paths, so the prediction can tell the agent's new files from what the image left (FR-014). */
export async function untrackedFiles(git: GitRunner): Promise<Set<string>> {
  const output = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  return new Set(output.split("\0").filter((path) => path.length > 0));
}

/**
 * The prediction: every change to tracked files since the image's HEAD (the tree the harness applies
 * it to), plus the files the agent created (untracked, not ignored, absent before it started), as
 * one patch `git apply` takes.
 */
export async function predictionPatch(git: GitRunner, imageHead: string, untrackedBefore: ReadonlySet<string>): Promise<string> {
  const created = [...await untrackedFiles(git)].filter((path) => !untrackedBefore.has(path));
  if (created.length > 0) await git(["add", "--intent-to-add", "--", ...created]);
  return git(["diff", "--binary", imageHead]);
}
