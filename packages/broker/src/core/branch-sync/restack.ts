// Owner decision D1 (2026-11-08), RESTACK: Rovara may force-push the branches only Rovara writes to, to restack milestone pull requests (so each shows a clean diff after the milestone below it merges).
// Branches a person pushed to are never rewritten; Rovara falls back to a merge there. This REPLACES branch-sync.ts's old "never force-push" rule for Rovara-only branches and for nothing else.
//
// This file holds the rules and the checks, as pure functions, so the executor (the worker's restack operation, started by the dispatch of a branch sync) and the broker apply the same ones:
//  - `decideBranchMethod`: restack or merge for one pull request, from what Rovara itself recorded (`BranchWriters`), never from a branch name or from what the host says of authors;
//  - `forcePushLease`: the ONLY way a force-push is spelled: `--force-with-lease=refs/heads/<branch>:<expected head>`, on the task's own branch, never on the base or the default branch, and never plain `--force`;
//  - `planRestackOutcome`: what a finished restack is, from what the host shows (never from the worker's word alone). A restack never carries a person's approval to the new head (the head's history was
//    rewritten; decision 4's carry-over covers a clean merge only), so the outcome is recorded as unverified-for-carry-over and the pull request needs its review again.
// Preconditions before anything may call `forcePushLease` are listed in the lane report (round 1 review). Needs both the contracts and the worker to carry the method (see the lane report): the workflow's branch-sync marker has no `method` yet, and the worker has no restack operation.
import { recordWorkflowBranchSync, WorkflowTransitionError, endWorkflowBranchSync, type Autonomy, type CodeHost, type HostScope, type RepositoryRef, type WorkflowSnapshot, COMMIT_ID_PATTERN } from "@agentx/contracts";
import type { BranchWriters } from "./branch-writers.js";
import { isTransientSyncFailure, type BranchSyncGithub } from "./branch-sync.js";

export type BranchMethod = "restack" | "merge";
export type MergeFallbackReason = "person_pushed" | "writers_unknown" | "head_not_rovaras" | "restack_refused" | "ask_first" | "base_is_head_branch";

export interface BranchMethodInput {
  writers: BranchWriters;
  /** Strict: the head is one of the commits Rovara recorded pushing. Never merge tracking's optimistic `headByRovara` (it reads "mine" while a Rovara push is pending). */
  headByRovara: boolean;
  autonomy: Autonomy;
  /** The branch Rovara pushes this pull request's head to. */
  recordedBranch: string;
  /** The pull request's base branch and the repository's default branch (the default may be undefined where the host does not say). */
  baseBranch: string;
  defaultBranch?: string | undefined;
}

/**
 * Restack only when it is proved that nobody but Rovara ever wrote to the branch, the head is Rovara's now, Rovara may act on its own, the branch is the task's own (never the base or the default branch), and the
 * host has not refused a force-push here before. Anything else is the merge, which is what Rovara did before D1.
 */
export function decideBranchMethod(input: BranchMethodInput): { method: "restack" } | { method: "merge"; reason: MergeFallbackReason } {
  if (input.autonomy === "suggest") return { method: "merge", reason: "ask_first" };
  if (input.writers.state === "unknown") return { method: "merge", reason: "writers_unknown" };
  if (input.writers.state === "person_pushed") return { method: "merge", reason: "person_pushed" };
  if (!input.headByRovara) return { method: "merge", reason: "head_not_rovaras" };
  if (input.writers.restackRefused) return { method: "merge", reason: "restack_refused" };
  const own = plainBranchName(input.recordedBranch);
  const others = [input.baseBranch, input.defaultBranch].flatMap((other) => (other === undefined ? [] : [plainBranchName(other) ?? other.toLowerCase()]));
  if (own === undefined || others.includes(own)) return { method: "merge", reason: "base_is_head_branch" };
  return { method: "restack" };
}

/** A commit id of any hash length (item C4): the core never decides it is SHA-1. */
const SHA = COMMIT_ID_PATTERN;
/** A branch name safe to put in a git argument: no leading dash or slash, no control characters, spaces, `:`, `?`, `*`, `[`, `\`, `~`, `^`, `..`, `@{`, no `.lock` end. */
const SAFE_BRANCH = /^(?!-)(?!\/)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/+-]{1,250}(?<![/.])$/u;

/**
 * The branch as it is compared to the base and default branches: lower case, and a `refs/heads/` spelling reduced to the name. Returns undefined for a name that is not a plain branch name: a
 * leading `refs/` that is not `refs/heads/`, `HEAD`, a leading `+` (a force marker in a refspec), or a path part that starts with a dot.
 */
export function plainBranchName(branch: string): string | undefined {
  const name = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
  if (name === "" || name.startsWith("refs/") || name.toUpperCase() === "HEAD" || name.startsWith("+") || name.split("/").some((part) => part.startsWith("."))) return undefined;
  return SAFE_BRANCH.test(name) ? name.toLowerCase() : undefined;
}

export type ForcePushRefusal = "not_a_sha" | "unsafe_branch" | "base_or_default_branch" | "not_the_tasks_branch" | "not_rovara_only" | "ask_first" | "head_not_recorded";

/**
 * The lease for one force-push, or the reason there is none. The expected head is NOT supplied by the caller: it is derived from the workflow (the head the running merge/restack marker was queued for, which must
 * also be the head the workflow recorded for the pull request), so an executor cannot fill it from a fresh fetch and make the lease protect nothing. The executor passes `argument` and `refspecFor(localSha)`
 * to git and nothing else: the lease names the branch AND the head Rovara expects, so a push by a person since Rovara looked makes git refuse the update instead of overwriting it, and the destination is
 * spelled in full (`refs/heads/<branch>`), so it cannot name another ref.
 */
export function forcePushLease(input: {
  branch: string;
  /** The branch the task owns (recorded when the pull request was opened). */
  recordedBranch: string;
  baseBranch: string;
  defaultBranch?: string | undefined;
  workflow: Pick<WorkflowSnapshot, "branchSync" | "pullRequests">;
  writers: BranchWriters;
  /** Strict: the head is one of the commits Rovara recorded pushing (not merge tracking's optimistic `headByRovara`). */
  headIsRecordedRovaraPush: boolean;
  autonomy: Autonomy;
}): { ok: true; argument: string; branch: string; expectedHead: string; refspecFor(localSha: string): string } | { ok: false; reason: ForcePushRefusal } {
  const marker = input.workflow.branchSync;
  const recorded = marker === undefined ? undefined : input.workflow.pullRequests?.find((pullRequest) => pullRequest.repositoryId === marker.repositoryId && pullRequest.number === marker.number);
  const expectedHead = marker?.expectedHeadCommit;
  if (expectedHead === undefined || !SHA.test(expectedHead)) return { ok: false, reason: "not_a_sha" };
  if (recorded?.headSha !== expectedHead) return { ok: false, reason: "head_not_recorded" };
  if (!SAFE_BRANCH.test(input.branch) || plainBranchName(input.branch) === undefined || input.branch.startsWith("refs/")) return { ok: false, reason: "unsafe_branch" };
  const name = plainBranchName(input.branch)!;
  const reserved = [input.baseBranch, input.defaultBranch].flatMap((other) => (other === undefined ? [] : [plainBranchName(other) ?? other.toLowerCase()]));
  if (reserved.includes(name)) return { ok: false, reason: "base_or_default_branch" };
  if (input.branch !== input.recordedBranch) return { ok: false, reason: "not_the_tasks_branch" };
  if (input.autonomy === "suggest") return { ok: false, reason: "ask_first" };
  const method = decideBranchMethod({ writers: input.writers, headByRovara: input.headIsRecordedRovaraPush, autonomy: input.autonomy, recordedBranch: input.recordedBranch, baseBranch: input.baseBranch, defaultBranch: input.defaultBranch });
  if (method.method !== "restack") return { ok: false, reason: "not_rovara_only" };
  const branch = input.branch;
  return {
    ok: true, argument: `--force-with-lease=refs/heads/${branch}:${expectedHead}`, branch, expectedHead,
    refspecFor: (localSha: string) => {
      if (!SHA.test(localSha)) throw new Error("a restack pushes a full commit id");
      return `${localSha}:refs/heads/${branch}`;
    },
  };
}

/** Whether the host's refusal of a push means a force-push is not allowed here (a protected branch, a rule that forbids rewriting): the next try is a merge, and `noteRestackRefused` records it. */
export function isForcePushRefusal(error: string | undefined): boolean {
  return error !== undefined && (/protected branch/iu.test(error) || /non-fast-forward/iu.test(error) || /forbids? force/iu.test(error) || /force[- ]push(?:es)? (?:are|is) (?:not allowed|disabled|prohibited)/iu.test(error) || /stale info/iu.test(error));
}

/** The most commits one walk from a head looks at before it gives up (a restacked branch is a few commits above its base). */
export const ANCESTRY_WALK_MAX = 200;

/**
 * Whether `head` builds on `base`: `base` is `head` or reachable through the commits' parents. Reads only `commitParents`, at most `ANCESTRY_WALK_MAX` commits; true/false, or undefined when it could not be told
 * (the host failed, or the walk was cut). A restack is on the branch only when the host SHOWS the new head on top of the base; the worker's word is not enough.
 */
export async function headBuildsOnBase(codeHost: Pick<CodeHost, "commitParents">, repository: RepositoryRef, head: string, base: string, scope: HostScope): Promise<boolean | undefined> {
  if (head === base) return true;
  const queue = [head];
  const seen = new Set<string>(queue);
  let looked = 0;
  while (queue.length > 0) {
    if (looked >= ANCESTRY_WALK_MAX) return undefined;
    const next = queue.shift()!;
    looked += 1;
    let parents: string[];
    try { parents = await codeHost.commitParents(repository, next, scope); } catch { return undefined; }
    for (const parent of parents) {
      if (parent === base) return true;
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
  }
  return false;
}

export type RestackOutcome =
  /** The rewritten branch is on the host: its head is a new commit that builds on the base, with the tree the worker reported. */
  | { kind: "restacked"; workflow: WorkflowSnapshot; headSha: string; headTreeSha: string; previousHeadSha: string; baseCommitSha: string }
  /** The host refused the force-push (or the lease failed): nothing was rewritten and the next try is a merge. */
  | { kind: "refused"; workflow: WorkflowSnapshot }
  /** Nothing was rewritten, or nothing the host shows is the restack. */
  | { kind: "unchanged"; workflow: WorkflowSnapshot };

/**
 * What a finished restack is, from what the host shows. Recorded only when the head is a NEW commit on the task's own branch, in a pull request that is still open, that builds on the base commit the restack
 * was made onto, with the tree the worker reported (when it reported one). A head that moved to something else, a person's push included, is never recorded. A restack is never recorded with a carried approval.
 */
export function planRestackOutcome(input: {
  workflow: WorkflowSnapshot;
  binding: { repositoryId: string; number: number; baseCommit: string; expectedHeadCommit: string };
  terminalStatus: string;
  terminalError?: string | undefined;
  /** What the worker says it pushed: the new head and its tree. Both are required and must equal what the host shows. */
  reported?: { headSha: string; treeSha: string } | undefined;
  github: BranchSyncGithub | undefined;
  /** Whether the host shows the new head on top of the base commit (`headBuildsOnBase`); undefined where it could not be told. */
  buildsOnBase: boolean | undefined;
  recordedBranch: string;
  now: string;
}): RestackOutcome {
  const { workflow, binding, github } = input;
  const unchanged = (): RestackOutcome => ({ kind: "unchanged", workflow: endWorkflowBranchSync(workflow, input.now) });
  // Only a restack that SUCCEEDED and told what it pushed can be the one on the host: a failed run, or one that reported nothing, never turns a head that moved (a person's merge of the base onto the
  // branch, say) into Rovara's own restacked head, with Rovara's checks and reviews re-keyed to it.
  const landed = input.terminalStatus === "SUCCEEDED" && input.reported !== undefined && github !== undefined && github.state === "open" && github.headBranch === input.recordedBranch
    && github.headCommit !== binding.expectedHeadCommit && SHA.test(github.headCommit) && SHA.test(github.headTreeSha) && input.buildsOnBase === true
    && input.reported.headSha === github.headCommit && input.reported.treeSha === github.headTreeSha;
  if (landed) {
    try {
      // `unverified: true`: no earlier head is kept for an approval to carry from. The history was rewritten, so a person's approval of the old head does not stand for this one.
      const next = recordWorkflowBranchSync(workflow, {
        repositoryId: binding.repositoryId, number: binding.number, headSha: github.headCommit, headTreeSha: github.headTreeSha, baseCommitSha: binding.baseCommit,
        previousHeadSha: binding.expectedHeadCommit, now: input.now, unverified: true,
      });
      return { kind: "restacked", workflow: next, headSha: github.headCommit, headTreeSha: github.headTreeSha, previousHeadSha: binding.expectedHeadCommit, baseCommitSha: binding.baseCommit };
    } catch (error) {
      if (!(error instanceof WorkflowTransitionError)) throw error;
      return unchanged();
    }
  }
  const headMoved = github !== undefined && github.headCommit !== binding.expectedHeadCommit;
  if (input.terminalStatus !== "SUCCEEDED" && !headMoved && isForcePushRefusal(input.terminalError)) {
    return { kind: "refused", workflow: endWorkflowBranchSync(workflow, input.now, { failed: "transient" }) };
  }
  // A failure that is not the restack's own only delays the next try; the restack's own failure is counted like a merge's.
  if (input.terminalStatus !== "SUCCEEDED" && !headMoved && !isTransientSyncFailure(input.terminalError)) {
    return { kind: "unchanged", workflow: endWorkflowBranchSync(workflow, input.now, { failed: "real" }) };
  }
  if (input.terminalStatus !== "SUCCEEDED" && !headMoved && isTransientSyncFailure(input.terminalError)) {
    return { kind: "unchanged", workflow: endWorkflowBranchSync(workflow, input.now, { failed: "transient" }) };
  }
  return unchanged();
}
