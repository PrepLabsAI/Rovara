// #1145: may the release skip its own typecheck, lint and tests because GitHub CI already passed on exactly this code?
//
// The release pipeline runs on a mainline merge commit; CI ran on the pull request's head. They are the same code only when their
// file trees are identical, which holds whenever the pull request was up to date with mainline when it merged. So the proof is:
//   1. a candidate commit whose tree is byte-for-byte the release commit's tree: the release commit itself, or its second parent
//      (the pull request's head, for a merge commit);
//   2. that candidate's latest `local` check run (CI's gate job, scripts/ci-gate.ts) completed with success, reported by GitHub Actions.
// Anything else (a pull request that was behind mainline, CI failed or still running, GitHub unreachable or rate limited, no git
// history) is "not proven", and the release runs every check as before. A failure to prove never fails the release.
import { spawnSync } from "node:child_process";

export const CI_GATE_CHECK = "local";
const GITHUB_ACTIONS = "github-actions";
const SHA = /^[0-9a-f]{40}$/u;

export interface CheckRun { status: string; conclusion: string | null; completed_at: string | null; id: number; app?: { slug?: string } | null }
export interface ProofInput {
  repository: string;
  commit: string;
  git: (...args: string[]) => string | undefined;
  checkRuns: (sha: string) => Promise<CheckRun[] | undefined>;
}
export type Proof = { proven: true; candidate: string; reason: string } | { proven: false; reason: string };

/** The latest run of CI's gate check on one commit, among GitHub Actions' own runs (a rerun makes a newer one). */
export function latestGateRun(runs: readonly CheckRun[]): CheckRun | undefined {
  return runs.filter((run) => run.app?.slug === GITHUB_ACTIONS).sort((a, b) => b.id - a.id)[0];
}

export async function ciProof(input: ProofInput): Promise<Proof> {
  const commit = input.git("rev-parse", "--verify", `${input.commit}^{commit}`);
  if (commit === undefined || !SHA.test(commit)) return { proven: false, reason: `no commit ${input.commit} in this checkout` };
  const tree = input.git("rev-parse", `${commit}^{tree}`);
  const parents = input.git("rev-list", "--parents", "-n", "1", commit)?.split(" ").slice(1) ?? [];
  if (tree === undefined) return { proven: false, reason: "the commit's tree could not be read" };
  // The pull request's head first: CI never runs on mainline's own merge commits.
  const candidates = [...(parents.length === 2 ? [parents[1]!] : []), commit];
  const looked: string[] = [];
  for (const candidate of candidates) {
    if (!SHA.test(candidate)) continue;
    if (input.git("rev-parse", `${candidate}^{tree}`) !== tree) { looked.push(`${candidate.slice(0, 9)}: different code (it was behind mainline)`); continue; }
    const runs = await input.checkRuns(candidate);
    if (runs === undefined) { looked.push(`${candidate.slice(0, 9)}: GitHub's check runs could not be read`); continue; }
    const gate = latestGateRun(runs);
    if (gate === undefined) { looked.push(`${candidate.slice(0, 9)}: no CI gate run`); continue; }
    if (gate.status !== "completed" || gate.conclusion !== "success") { looked.push(`${candidate.slice(0, 9)}: CI gate ${gate.status}/${gate.conclusion ?? "none"}`); continue; }
    return { proven: true, candidate, reason: `${commit.slice(0, 9)} has the same code as ${candidate.slice(0, 9)}, whose CI gate passed at ${gate.completed_at ?? "?"}` };
  }
  return { proven: false, reason: looked.length === 0 ? "no candidate commit" : looked.join("; ") };
}

/** GitHub's REST API, without a token: the repository is public. Ten seconds, then "unknown". */
export function githubCheckRuns(repository: string, fetchImplementation: typeof fetch = fetch): (sha: string) => Promise<CheckRun[] | undefined> {
  return async (sha) => {
    try {
      const response = await fetchImplementation(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?check_name=${CI_GATE_CHECK}&per_page=100`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "rovara-release", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { check_runs?: unknown };
      return Array.isArray(body.check_runs) ? body.check_runs as CheckRun[] : undefined;
    } catch { return undefined; }
  };
}

const git = (...args: string[]): string | undefined => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

if (process.argv[1]?.endsWith("release-ci-proof.ts")) {
  const at = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const repository = at("--repository");
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    process.stderr.write("usage: node scripts/release-ci-proof.ts --repository OWNER/NAME [--commit REV]\n");
    process.exit(2);
  }
  const proof = await ciProof({ repository, commit: at("--commit") ?? "HEAD", git, checkRuns: githubCheckRuns(repository) });
  process.stdout.write(`release CI proof: ${proof.proven ? "PROVEN" : "not proven"}: ${proof.reason}\n`);
  // Exit 0 only when proven: the buildspec then passes --skip-checks; any other exit runs every check.
  process.exit(proof.proven ? 0 : 1);
}
