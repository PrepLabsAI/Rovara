import { run, type Exec } from "./exec.js";

export interface CandidateSnapshot {
  branch: string;
  commitSha: string;
  treeSha: string;
  baseCommitSha: string;
}

export class CandidateHoldError extends Error {
  constructor(readonly reasonCode: string) { super(`publication held: ${reasonCode}`); }
}

/** Captures the exact committed candidate and refuses a dirty worktree or unexpected branch. */
export async function captureCandidate(exec: Exec, worktree: string, expectedBranch: string, baseRef: string): Promise<CandidateSnapshot> {
  const [branch, commitSha, treeSha, baseCommitSha, worktreeChanges] = await Promise.all([
    run(exec, "git", ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]),
    run(exec, "git", ["-C", worktree, "rev-parse", "--verify", "HEAD"]),
    run(exec, "git", ["-C", worktree, "rev-parse", "--verify", "HEAD^{tree}"]),
    run(exec, "git", ["-C", worktree, "rev-parse", "--verify", baseRef]),
    run(exec, "git", ["-C", worktree, "status", "--porcelain"]),
  ]);
  if (branch.trim() !== expectedBranch) throw new CandidateHoldError("candidate_branch_changed");
  if (worktreeChanges !== "") {
    const reasonCode = worktreeChanges.split("\n").some((line) => line.startsWith("??"))
      ? "candidate_untracked_changes"
      : "candidate_tracked_changes";
    throw new CandidateHoldError(reasonCode);
  }
  if (!/^[a-f0-9]{40}$/u.test(commitSha.trim()) || !/^[a-f0-9]{40}$/u.test(treeSha.trim()) || !/^[a-f0-9]{40}$/u.test(baseCommitSha.trim())) {
    throw new CandidateHoldError("candidate_identity_invalid");
  }
  return { branch: branch.trim(), commitSha: commitSha.trim(), treeSha: treeSha.trim(), baseCommitSha: baseCommitSha.trim() };
}

export function sameCandidate(left: CandidateSnapshot | undefined, right: CandidateSnapshot | undefined): boolean {
  return left !== undefined && right !== undefined && left.branch === right.branch && left.commitSha === right.commitSha &&
    left.treeSha === right.treeSha && left.baseCommitSha === right.baseCommitSha;
}
