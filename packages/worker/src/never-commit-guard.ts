// TE-B9 (O38): the worker's half of the never-commit rule for Rovara's own working files (the list is `ROVARA_NEVER_COMMIT`, contracts/src/never-commit.ts). Three parts:
//   1. every `git add` leaves the listed paths out (the exclude pathspecs are spread into each one: isolated-git.ts, publish.ts, maintain-pull-request.ts);
//   2. `unstageRovaraWorkingFiles`: a path a task force-added stays in the real index through `add --all` (an exclude only keeps Git from staging NEW changes), so it is taken out of the index, never out of the work tree;
//   3. the check on the commit about to be pushed, which fails closed with a fixed sentence (`neverCommitRefusal`). It looks at what the commit INTRODUCES (added, modified or type-changed paths; a deletion is not a commit of
//      the file), against the base for a publication or against every parent for a push onto an existing pull request, as the lessons-file guard does: a file the customer's repository already held is not Rovara's to refuse.
// Git does the matching, with the same pathspecs `git add` used, so the exclude and the check cannot drift apart. A diff that cannot be read fails closed.
import { ROVARA_NEVER_COMMIT, agentXError, neverCommitRefusal } from "@agentx/contracts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Paths to a `git rm --cached` call, so no command line grows past what an environment allows. */
const UNSTAGE_CHUNK = 200;

type Git = (args: string[]) => Promise<string>;

const names = (listed: string): string[] => listed.split("\0").filter((name) => name !== "");
const UNREADABLE = "Rovara could not read the list of files this change touches, so it did not push";

/** Listed paths that differ between `from` (a commit) and `to` (a commit; undefined means the index) by an addition or a change (`filter` is Git's own `--diff-filter`: all but deletions by default). */
async function introduced(git: Git, from: string, to: string | undefined, filter = "d"): Promise<string[]> {
  const range = to === undefined ? ["--cached", from] : [from, to];
  return names(await git(["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none", `--diff-filter=${filter}`, ...range, "--", ...ROVARA_NEVER_COMMIT]));
}

/**
 * Throws (CONFIG_INVALID, the fixed sentence naming the first path, in Git's path order) when the commits from `base` to `commit` introduce a listed path. With no `base` the commit's first parent is the base (the empty
 * tree for a root commit): a publication commit is one commit on the latest base. `git` runs a Git command in the workspace's isolated repository and returns its output.
 */
export async function assertNoRovaraWorkingFiles(git: Git, commit: string, base?: string): Promise<void> {
  let from = base;
  if (from === undefined) from = (await git(["rev-parse", "--verify", "--quiet", `${commit}^1`]).catch(() => "")).trim() || EMPTY_TREE;
  let found: string[];
  try { found = await introduced(git, from, commit); } catch { throw agentXError("CONFIG_INVALID", UNREADABLE); }
  if (found.length > 0) throw agentXError("CONFIG_INVALID", neverCommitRefusal(found[0]!));
}

/**
 * The same check for a push that adds a commit on top of a pull request that already exists (a fix round, a conflict round, a base merge). What counts is what THIS commit introduces: a path is flagged only when the commit
 * differs from EVERY parent in it, so a clean merge of the base, or a leak an earlier push already put on the branch, is not flagged again. A root commit is compared with the empty tree.
 */
export async function assertPushCarriesNoRovaraWorkingFiles(git: Git, commit: string): Promise<void> {
  let parents: string[];
  try { parents = (await git(["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/u).slice(1); } catch { throw agentXError("CONFIG_INVALID", UNREADABLE); }
  const against = parents.length === 0 ? [EMPTY_TREE] : parents;
  const counts = new Map<string, number>();
  for (const parent of against) {
    let found: string[];
    try { found = await introduced(git, parent, commit); } catch { throw agentXError("CONFIG_INVALID", UNREADABLE); }
    for (const path of new Set(found)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const flagged = [...counts].filter(([, count]) => count === against.length).map(([path]) => path).sort();
  if (flagged.length > 0) throw agentXError("CONFIG_INVALID", neverCommitRefusal(flagged[0]!));
}

/**
 * Takes every listed path that is in the real index but not in `base` out of the index (`git rm --cached`; the files stay in the work tree). Run after `git add --all` with the exclude pathspecs and before `write-tree`: a task
 * that force-added a working file put it in the index, and an exclude cannot remove it. A path the base already tracks is left alone. A failure to list or to unstage fails closed.
 */
export async function unstageRovaraWorkingFiles(git: Git, base: string): Promise<void> {
  // Only entries the base does not have (filter A): one the base tracks and the task changed is left for the final check, which refuses it.
  let unstage: string[];
  try { unstage = await introduced(git, base, undefined, "A"); } catch { throw agentXError("CONFIG_INVALID", UNREADABLE); }
  for (let at = 0; at < unstage.length; at += UNSTAGE_CHUNK) {
    try { await git(["rm", "--cached", "--quiet", "--force", "--ignore-unmatch", "--", ...unstage.slice(at, at + UNSTAGE_CHUNK).map((path) => `:(top,literal)${path}`)]); } catch { throw agentXError("CONFIG_INVALID", "Rovara could not take its own working files out of the change, so it did not push"); }
  }
}
