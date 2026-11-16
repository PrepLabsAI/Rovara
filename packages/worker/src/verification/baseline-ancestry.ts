// TE-C1, the worker's half. The engine offers a few commits whose baseline it holds (the task plan's `baselineCandidates`, shas only). At the start of its checks round, before any check runs, the worker finds the nearest one that is on
// the task's base commit's FIRST-PARENT line and at most 50 commits back, and reports `{ sha, commitsBack }` in `evidence-raw.json`. The engine uses it only for a sha it offered itself.
//
// The coding agent owns `.git/objects` from its step on, and git does not re-hash a commit's parents while it walks (`merge-base --is-ancestor`, `rev-list`, the commit graph): a loose object overwritten, or a newer hand-made pack
// whose index relabels a forged commit, makes git say a commit is an ancestor when it is not. So this does not ask git about ancestry at all. It reads each commit on the line itself (`cat-file commit`), RE-HASHES it
// (`hash-object -t commit --stdin` must give back the commit's own name), and takes the next commit from the verified commit's own `parent` header. A commit that is missing, malformed or whose bytes do not hash to its name ends
// the walk with no answer. The line is first-parent only, consistently (a commit that is only on a merged side is not on it).
//
// Every git call runs in the isolated environment (`withIsolatedGit`): a throwaway repository that reads the candidate's OBJECTS and nothing else of it (no refs, replace refs, shallow file, grafts, config or inherited GIT_* variable).
// Any fault is a miss: this never throws, and "no answer" leaves the engine on today's behaviour.
import { BASELINE_ANCESTOR_MAX, BASELINE_CANDIDATES_MAX, type RawBaseline } from "@agentx/contracts";
import { withIsolatedGit } from "../isolated-git.js";

const HEX40 = /^[a-f0-9]{40}$/u;
const GIT_TIMEOUT_MS = 30_000;
/** A commit object larger than this is not read (a miss). */
const COMMIT_MAX_BYTES = 1_048_576;

export interface FindBaselineAncestorInput {
  /** The repository's directory (the one repository of the task). */
  directory: string;
  /** The task's base commit, as the broker pinned it. */
  baseCommit: string | undefined;
  /** The engine's candidates: the nearest to the base is kept. */
  candidates: ReadonlyArray<{ sha: string }> | undefined;
  signal?: AbortSignal | undefined;
}

/** The first `parent` of a commit's header (the lines before the first blank line), or undefined for a root commit. */
function firstParentOf(body: Buffer): string | undefined {
  const header = body.toString("latin1").split("\n\n", 1)[0] ?? "";
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ")) {
      const sha = line.slice(7);
      return HEX40.test(sha) ? sha : undefined;
    }
  }
  return undefined;
}

/** The nearest candidate on the first-parent line of `baseCommit` within `BASELINE_ANCESTOR_MAX` commits, every commit up to it re-hashed, or undefined. Never throws. */
export async function findBaselineAncestor(input: FindBaselineAncestorInput): Promise<RawBaseline | undefined> {
  const base = input.baseCommit;
  if (base === undefined || !HEX40.test(base) || input.candidates === undefined) return undefined;
  const candidates = new Set(input.candidates.slice(0, BASELINE_CANDIDATES_MAX).map((candidate) => candidate.sha).filter((sha) => HEX40.test(sha)));
  if (candidates.size === 0) return undefined;
  try {
    return await withIsolatedGit(input.directory, "read", async (git) => {
      const options = { index: "none", timeout: GIT_TIMEOUT_MS, maxBuffer: COMMIT_MAX_BYTES, ...(input.signal === undefined ? {} : { signal: input.signal }) } as const;
      let current: string | undefined = base;
      for (let back = 0; current !== undefined && back <= BASELINE_ANCESTOR_MAX; back += 1) {
        // The commit's bytes must hash to its name (this also refuses a missing object and a base that is not a commit).
        const body = await git.bytes(["cat-file", "commit", current], options);
        const hashed = (await git.text(["hash-object", "-t", "commit", "--stdin"], { ...options, input: body })).trim();
        if (hashed !== current) return undefined;
        if (candidates.has(current)) return { sha: current, commitsBack: back };
        current = firstParentOf(body);
      }
      return undefined;
    });
  } catch {
    return undefined;
  }
}
