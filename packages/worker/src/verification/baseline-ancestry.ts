// TE-C1, the worker's half. The engine offers a few commits whose baseline it holds (the task plan's `baselineCandidates`, shas only). At the start of its checks round, before any check runs, the worker finds the nearest one that is
// an ANCESTOR of the task's base commit and at most 50 commits back, and reports `{ sha, commitsBack }` in `evidence-raw.json`. The engine uses it only for a sha it offered itself.
//
// Every git call runs in the isolated environment (`withIsolatedGit`): a throwaway repository that reads the candidate's OBJECTS and nothing else of it. Its refs, replace refs, shallow file, grafts and config are not read and no
// inherited GIT_* variable applies, so what an agent or a check left in `.git` (a rewritten ref, a `git replace`, a `.git/shallow`) cannot make a commit an ancestor or hide one. A candidate that is not an ancestor (the base was
// force-pushed or rewritten), is not in the repository (a shallow clone), or is not a commit is a miss. Any fault is a miss: this never throws, and "no answer" leaves the engine on today's behaviour.
import { BASELINE_ANCESTOR_MAX, BASELINE_CANDIDATES_MAX, type RawBaseline } from "@agentx/contracts";
import { withIsolatedGit } from "../isolated-git.js";

const HEX40 = /^[a-f0-9]{40}$/u;
const GIT_TIMEOUT_MS = 30_000;

export interface FindBaselineAncestorInput {
  /** The repository's directory (the one repository of the task). */
  directory: string;
  /** The task's base commit, as the broker pinned it. */
  baseCommit: string | undefined;
  /** The engine's candidates, nearest-first or not: the nearest to the base is kept. */
  candidates: ReadonlyArray<{ sha: string }> | undefined;
  signal?: AbortSignal | undefined;
}

/** The nearest candidate that is an ancestor of `baseCommit` within `BASELINE_ANCESTOR_MAX` commits (counted on the base's first-parent line), or undefined. Never throws. */
export async function findBaselineAncestor(input: FindBaselineAncestorInput): Promise<RawBaseline | undefined> {
  const base = input.baseCommit;
  if (base === undefined || !HEX40.test(base) || input.candidates === undefined) return undefined;
  const candidates = [...new Set(input.candidates.slice(0, BASELINE_CANDIDATES_MAX).map((candidate) => candidate.sha).filter((sha) => HEX40.test(sha)))];
  if (candidates.length === 0) return undefined;
  try {
    return await withIsolatedGit(input.directory, "read", async (git) => {
      const options = { index: "none", timeout: GIT_TIMEOUT_MS, maxBuffer: 4096, ...(input.signal === undefined ? {} : { signal: input.signal }) } as const;
      // The base must be a commit this repository holds.
      if (await git.text(["cat-file", "-e", `${base}^{commit}`], options).then(() => false, () => true)) return undefined;
      let nearest: RawBaseline | undefined;
      for (const sha of candidates) {
        // The base itself: nothing to walk (and a shallow clone's base has no parent to walk to).
        if (sha === base) { nearest = { sha, commitsBack: 0 }; break; }
        // `--is-ancestor` exits 1 for "no" and 128 for an object that is missing or not a commit: both are a miss.
        if (await git.text(["merge-base", "--is-ancestor", sha, base], options).then(() => false, () => true)) continue;
        // At most 51 commits are counted, so a far ancestor of a huge history costs a bounded walk.
        const counted = await git.text(["rev-list", "--count", "--first-parent", `--max-count=${String(BASELINE_ANCESTOR_MAX + 1)}`, `${sha}..${base}`], options).then((text) => Number(text.trim()), () => undefined);
        if (counted === undefined || !Number.isInteger(counted) || counted < 0 || counted > BASELINE_ANCESTOR_MAX) continue;
        if (nearest === undefined || counted < nearest.commitsBack) nearest = { sha, commitsBack: counted };
      }
      return nearest;
    });
  } catch {
    return undefined;
  }
}
