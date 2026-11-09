// Rovara Code (Plan 6 Task 17): a CI or feedback fix starts from the head the pull request has. A conflict round that was abandoned leaves the workspace on a local merge commit with conflict markers (and
// whatever the coder had edited), and a fix that began there would be told about the wrong code. Only the first run of a round restores: a run that goes on after a stop keeps its partial work.
import { runIsolatedGit } from "./isolated-repository.js";

const OPTIONS = { timeout: 120_000, maxBuffer: 1_048_576 };

/** Puts the workspace's repository on `startFrom` (its branch, and its files; untracked files too) when it is on another commit of the same repository. Answers whether it did. A commit the workspace lacks changes nothing. */
export async function restoreFixStart(directory: string, startFrom: string): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/u.test(startFrom)) return false;
  const head = (await runIsolatedGit(directory, ["rev-parse", "HEAD"], OPTIONS)).trim();
  if (head === startFrom) return false;
  const present = await runIsolatedGit(directory, ["cat-file", "-e", `${startFrom}^{commit}`], OPTIONS).then(() => true, () => false);
  if (!present) return false;
  const branch = (await runIsolatedGit(directory, ["branch", "--show-current"], OPTIONS)).trim();
  await runIsolatedGit(directory, ["checkout", "--force", ...(branch === "" ? ["--detach"] : ["-B", branch]), startFrom], OPTIONS);
  await runIsolatedGit(directory, ["clean", "--force", "-d", "--quiet"], OPTIONS);
  return true;
}
