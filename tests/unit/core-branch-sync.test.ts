// Rovara Code (Plan 6 Task 17): keeping a pull request's branch up to date. The contract moves (a merge of the base is queued, runs, ends or stops; its result is recorded; a conflict starts a
// round), the decisions (merge only when needed, at most four a day), and the plan of what a finished merge is (clean, conflicted, refused for workflow files, lost) from what the host shows.
// Nothing here force-pushes except the one case owner decision D1 allows (see branch-sync-restack.test.ts), and nothing a person did not leave to Rovara is overwritten.
// (Port lane L7b: the slots are exercised over plain inputs in branch-sync-deciders.test.ts; Cloud's tracking pass and its fake DynamoDB are lane L7a's.)
import { describe, expect, it } from "vitest";
import {
  BRANCH_SYNC_UNSURE_MESSAGE, SYNC_BACKOFF_MINUTES, SYNC_FAILURES_MAX, branchSyncGiveUpMessage, isBranchSyncGiveUpReason,
  branchConflictAskMessage, retryWorkflowBranchSync,
  BRANCH_SYNCS_PER_DAY_MAX, BRANCH_WORKFLOW_FILES_MESSAGE, CONFLICT_ROUNDS_MAX, WorkflowSnapshotSchema, WorkflowTransitionError, blockWorkflowBranchSync, branchConflictStopMessage, createCandidateManifest,
  createWorkflowSnapshot, endWorkflowBranchSync, isBranchSyncBlockReason, observeWorkflowPullRequest, recordWorkflowBranchSync, recordWorkflowPullRequestUpdate, recordWorkflowSyncConflict,
  recordWorkflowVerification, startWorkflowBranchSync, startWorkflowBranchSyncRun, startWorkflowFix, workflowFollowsOnlyMerge, type WorkflowProgram, type WorkflowSnapshot,
  autoFixDecision, workflowAutomaticRetryDecision, workflowAutoFixCounts, wholeTaskSpendUsd, WORKFLOW_BLOCK_REASONS, BASE_MERGED_RETRY_REASON, BASE_MERGED_RETRIES_PER_DAY, baseMergedRetriesToday,
  WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_AUTO_ACTION_LIMIT, workflowAutoActionRequestId, holdWorkflowCandidateOnPullRequests, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE,
} from "@rovara-code/contracts";
import type { MergeTrackingItem } from "../../packages/contracts/src/rovara-code.js";
import {
  branchSyncRequestId, bumpSyncs, classifySyncFailure, decideBranchSync, decideConflict, isWorkflowFilesRefusal, planBranchSyncOutcome, syncsToday, utcDay,
} from "../../packages/core/src/core/branch-sync/branch-sync.js";
import { baseMergedRechecksItself } from "../../packages/core/src/core/build-step/maintain.js";
import { candidateIsOnPullRequest } from "../../packages/core/src/core/build-step/results.js";

const TASK_ID = "00000000-0000-4000-8000-0000000000a1";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const at = "2026-10-25T12:00:00.000Z";
const OWNER = "a".repeat(64);
const BASE_OLD = "e".repeat(40);
const BASE_NEW = "f".repeat(40);
const MERGE = "9".repeat(40);
const MERGED_TREE = "c".repeat(40);

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: BASE_OLD }]);
const PULL_REQUEST = { repositoryId: "payments", number: 7, headSha: HEAD_A, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/acme/payments/pull/7" };
const reviewOf = (role: "CRITIC" | "SECURITY", digest: string) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: digest, role, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: at });

/** A task waiting for the merge of its one open pull request, as the schema takes it (version 2 with its program). */
function waiting(extra: Record<string, unknown> = {}, options: { version?: "1.0.0" | "1.1.0" } = {}): WorkflowSnapshot {
  const version = options.version ?? "1.1.0";
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: at, definitionVersion: version, ...(version === "1.1.0" ? { program: PROGRAM } : {}) }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", ...(version === "1.1.0" ? { programStepId: "pull_request" } : {}), candidate,
    reviewBase: [{ repositoryId: "payments", baseCommitSha: BASE_OLD }],
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [reviewOf("CRITIC", candidate.digest), reviewOf("SECURITY", candidate.digest)],
    pullRequests: [PULL_REQUEST], ...extra,
  });
}
/** The same task while the merge of the base runs. */
const syncing = (extra: Record<string, unknown> = {}, reason: "behind" | "conflict" = "behind"): WorkflowSnapshot =>
  startWorkflowBranchSyncRun(startWorkflowBranchSync(waiting(extra), { repositoryId: "payments", number: 7, reason, now: at }), at);
const clean = { repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: MERGED_TREE, baseCommitSha: BASE_NEW, previousHeadSha: HEAD_A, now: at };

describe("a merge of the base branch, as the workflow moves", () => {
  it("queues for the pull request's recorded head, runs, and ends back at the wait for the merge", () => {
    const queued = startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "behind", now: at });
    expect(queued).toMatchObject({ revision: 10, stage: "WAIT_FOR_MERGE", state: "READY", branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } });
    const running = startWorkflowBranchSyncRun(queued, at);
    expect(running).toMatchObject({ revision: 11, state: "RUNNING", branchSync: { expectedHeadCommit: HEAD_A } });
    for (const snapshot of [queued, running]) {
      const ended = endWorkflowBranchSync(snapshot, at);
      expect(ended).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
      expect(ended.branchSync).toBeUndefined();
      expect(WorkflowSnapshotSchema.safeParse(ended).success).toBe(true);
    }
    expect(() => endWorkflowBranchSync(waiting(), at)).toThrow(WorkflowTransitionError);
    expect(() => startWorkflowBranchSyncRun(waiting(), at)).toThrow(WorkflowTransitionError);
  });

  it("starts nothing while the owner's card waits, a fix or another merge is under way, or the pull request is not open or has no recorded head", () => {
    const start = (workflow: WorkflowSnapshot) => startWorkflowBranchSync(workflow, { repositoryId: "payments", number: 7, reason: "behind", now: at });
    const hash = (letter: string) => letter.repeat(64);
    const bundle = { schemaVersion: 1 as const, taskId: TASK_ID, repositoryId: "payments", number: 7, headSha: HEAD_A, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest,
      commentSetDigest: hash("c"), sha256: hash("e"), objectKey: `tasks/${TASK_ID}/feedback/${hash("e")}.json`, producer: "github-reconciler", version: "1", recordedAt: at,
      comments: [{ id: "c1", threadId: "t1", kind: "REVIEW_COMMENT" as const, url: "https://github.com/acme/payments/pull/7#c1", author: "reviewer", updatedAt: at, bodyDigest: hash("d"), bodyBytes: 7 }] };
    expect(() => start(waiting({ feedbackReview: { status: "COLLECTING", bundleRefs: [bundle], threadObservations: [] } }))).toThrow(/card/);
    expect(() => start(startWorkflowFix(waiting(), { source: "ci", problems: ["test"], now: at }))).toThrow(WorkflowTransitionError);
    expect(() => start(startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "behind", now: at }))).toThrow(WorkflowTransitionError);
    expect(() => start(waiting({ pullRequests: [{ ...PULL_REQUEST, state: "CLOSED" }] }))).toThrow(WorkflowTransitionError);
    expect(() => start(waiting({ pullRequests: [{ ...PULL_REQUEST, headSha: undefined }] }))).toThrow(WorkflowTransitionError);
    expect(() => startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 8, reason: "behind", now: at })).toThrow(WorkflowTransitionError);
  });

  it("a marker needs the wait for the merge", () => {
    expect(WorkflowSnapshotSchema.safeParse({ ...waiting(), branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } }).success).toBe(false);
  });

  it("follows only the merge while a merge of the base is queued or running, and while a person is to update the branch; an ordinary wait does not", () => {
    expect(workflowFollowsOnlyMerge(waiting())).toBe(false);
    expect(workflowFollowsOnlyMerge(startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "behind", now: at }))).toBe(true);
    expect(workflowFollowsOnlyMerge(syncing())).toBe(true);
    const stopped = blockWorkflowBranchSync(syncing(), { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at });
    expect(workflowFollowsOnlyMerge(stopped)).toBe(true);
    // An observation of the open pull request leaves the stop as it is; a merge still completes the task.
    const observed = observeWorkflowPullRequest(stopped, { repositoryId: "payments", number: 7, candidateDigest: candidate.digest, state: "OPEN", source: "GITHUB_API", observedAt: at }, at);
    expect(observed).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: BRANCH_WORKFLOW_FILES_MESSAGE });
    const merged = observeWorkflowPullRequest(stopped, { repositoryId: "payments", number: 7, candidateDigest: candidate.digest, state: "MERGED", source: "GITHUB_API", observedAt: at }, at);
    expect(merged).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
  });
});

describe("the two stops, in the exact words", () => {
  it("says the branch still conflicts after the conflict rounds, naming the base, and that Rovara can't push workflow files", () => {
    expect(CONFLICT_ROUNDS_MAX).toBe(2);
    expect(branchConflictStopMessage("main")).toBe("The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task.");
    expect(BRANCH_WORKFLOW_FILES_MESSAGE).toBe("The base branch changed CI workflow files, which Rovara can't push. Update the branch on GitHub.");
    expect(isBranchSyncBlockReason(branchConflictStopMessage("develop"))).toBe(true);
    expect(isBranchSyncBlockReason(BRANCH_WORKFLOW_FILES_MESSAGE)).toBe(true);
    expect(isBranchSyncBlockReason("The pull request changed on GitHub.")).toBe(false);
    expect(isBranchSyncBlockReason(undefined)).toBe(false);
  });

  it("blocks the wait for the merge with the text, drops the marker, and refuses any other reason", () => {
    const stopped = blockWorkflowBranchSync(syncing(), { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at });
    expect(stopped).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: BRANCH_WORKFLOW_FILES_MESSAGE });
    expect(stopped.branchSync).toBeUndefined();
    expect(blockWorkflowBranchSync(waiting(), { reason: branchConflictStopMessage("main"), now: at }).blockReason).toBe(branchConflictStopMessage("main"));
    expect(() => blockWorkflowBranchSync(waiting(), { reason: "Some other reason", now: at })).toThrow(WorkflowTransitionError);
    expect(() => blockWorkflowBranchSync({ ...waiting(), stage: "IMPLEMENT", state: "READY" }, { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at })).toThrow(WorkflowTransitionError);
  });

  it("a base branch name from GitHub is one short redacted line in the text", () => {
    const text = branchConflictStopMessage(`main\n‮ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"} ${"x".repeat(300)}`);
    expect(text).not.toMatch(/[\n‮]/u);
    expect(text).not.toContain("A1b2C3d4E5f6");
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith(" after 2 tries. Resolve it on GitHub or close the task.")).toBe(true);
  });
});

describe("a clean merge of the base, recorded", () => {
  it("moves the candidate to the merge on the new base, keeps the checks and reviews for it, and records the head before the merge", () => {
    const next = recordWorkflowBranchSync(syncing(), clean);
    expect(next).toMatchObject({ revision: 12, stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(next.branchSync).toBeUndefined();
    expect(next.candidate?.digest).not.toBe(candidate.digest);
    expect(next.candidate?.repositories).toEqual([{ repositoryId: "payments", commitSha: MERGE, treeSha: MERGED_TREE, baseCommitSha: BASE_NEW }]);
    // The next review diffs only Rovara's change.
    expect(next.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    expect(next.pullRequests?.[0]).toMatchObject({ headSha: MERGE, headTreeSha: MERGED_TREE, candidateDigest: next.candidate?.digest, syncedFrom: HEAD_A, state: "OPEN" });
    expect(next.verification?.candidateDigest).toBe(next.candidate?.digest);
    expect(next.reviews?.map((review) => review.candidateDigest)).toEqual([next.candidate?.digest, next.candidate?.digest]);
    expect(next.pullRequestUpdatedAt).toBe(at);
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("keeps the risk, the accepted findings and a second pull request with the new candidate", () => {
    const two = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: BASE_OLD }, { repositoryId: "billing", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: BASE_OLD }]);
    const risk = { level: "medium" as const, reasons: ["Changes 500 lines, more than 400."], candidateDigest: two.digest };
    const accepted = { candidateDigest: two.digest, role: "CRITIC" as const, fingerprint: "a".repeat(64), text: "A thing", reason: "fine", actorId: OWNER, at };
    const other = { ...PULL_REQUEST, repositoryId: "billing", number: 8, url: "https://github.com/acme/billing/pull/8" };
    const workflow = waiting({ candidate: two, risk, acceptedFindings: [accepted], pullRequests: [{ ...PULL_REQUEST, candidateDigest: two.digest }, { ...other, candidateDigest: two.digest }],
      reviewBase: [{ repositoryId: "payments", baseCommitSha: BASE_OLD }, { repositoryId: "billing", baseCommitSha: BASE_OLD }],
      verification: { candidateDigest: two.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [reviewOf("CRITIC", two.digest), reviewOf("SECURITY", two.digest)] });
    const next = recordWorkflowBranchSync(startWorkflowBranchSyncRun(startWorkflowBranchSync(workflow, { repositoryId: "payments", number: 7, reason: "behind", now: at }), at), clean);
    const digest = next.candidate!.digest;
    expect(next.risk?.candidateDigest).toBe(digest);
    expect(next.acceptedFindings?.[0]?.candidateDigest).toBe(digest);
    // The other repository's entry and base are untouched; its pull request holds the same code under the new candidate.
    expect(next.candidate?.repositories.find((entry) => entry.repositoryId === "billing")).toMatchObject({ commitSha: "1".repeat(40), baseCommitSha: BASE_OLD });
    expect(next.reviewBase).toEqual([{ repositoryId: "billing", baseCommitSha: BASE_OLD }, { repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    expect(next.pullRequests?.find((entry) => entry.number === 8)).toMatchObject({ candidateDigest: digest, headSha: HEAD_A });
    expect(next.pullRequests?.find((entry) => entry.number === 8)?.syncedFrom).toBeUndefined();
  });

  it("a second clean merge keeps the head from before the run of merges, so an approval of it can carry", () => {
    const first = recordWorkflowBranchSync(syncing(), clean);
    const second = recordWorkflowBranchSync(startWorkflowBranchSyncRun(startWorkflowBranchSync(first, { repositoryId: "payments", number: 7, reason: "behind", now: at }), at),
      { ...clean, headSha: "8".repeat(40), headTreeSha: "d".repeat(40), baseCommitSha: "7".repeat(40), previousHeadSha: MERGE });
    expect(second.pullRequests?.[0]).toMatchObject({ headSha: "8".repeat(40), syncedFrom: HEAD_A });
  });

  it("a fix pushed after a clean merge forgets it: what a person approved before the merge is not what the pull request holds", () => {
    const merged = recordWorkflowBranchSync(syncing(), clean);
    expect(merged.pullRequests?.[0]?.syncedFrom).toBe(HEAD_A);
    const started = startWorkflowFix(merged, { source: "ci", problems: ["test"], now: at });
    const fixed = createCandidateManifest([{ repositoryId: "payments", commitSha: "5".repeat(40), treeSha: "4".repeat(40), baseCommitSha: BASE_NEW }]);
    const pushing = WorkflowSnapshotSchema.parse({
      ...started, revision: 30, stage: "PULL_REQUEST", state: "RUNNING", candidate: fixed,
      verification: { candidateDigest: fixed.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [reviewOf("CRITIC", fixed.digest), reviewOf("SECURITY", fixed.digest)],
    });
    const landed = recordWorkflowPullRequestUpdate(pushing, { updates: [{ repositoryId: "payments", number: 7, headSha: "6".repeat(40), headTreeSha: "4".repeat(40) }], now: at });
    expect(landed.pullRequests?.[0]?.headSha).toBe("6".repeat(40));
    expect(landed.pullRequests?.[0]?.syncedFrom).toBeUndefined();
  });

  it("is refused for a head the workflow did not record, when no merge is running, for a pull request that is not open, and for a bad commit", () => {
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, previousHeadSha: HEAD_B })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, previousHeadSha: undefined } as never)).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, headSha: HEAD_A })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(waiting(), clean)).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing({ pullRequests: [{ ...PULL_REQUEST, state: "MERGED" }] }), clean)).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, headSha: "zz" })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, number: 8 })).toThrow(WorkflowTransitionError);
    // A merge for another head than the one the marker names.
    const marked = { ...syncing(), branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_B, reason: "behind" as const } };
    expect(() => recordWorkflowBranchSync(marked, clean)).toThrow(WorkflowTransitionError);
  });

  it("a CI fix after a clean merge is reviewed against the new base only (Finding 8); the old base is refused", () => {
    const merged = recordWorkflowBranchSync(syncing(), clean);
    const started = startWorkflowFix(merged, { source: "ci", problems: ["test"], now: at });
    const fixAt = (base: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: "5".repeat(40), treeSha: "4".repeat(40), baseCommitSha: base }]);
    const verifying = (workflow: WorkflowSnapshot) => ({ ...workflow, stage: "VERIFY" as const, state: "WAITING" as const });
    const checks = (digest: string) => ({ candidateDigest: digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" as const }] });
    const good = fixAt(BASE_NEW);
    expect(recordWorkflowVerification(verifying(started), { candidate: good, checks: checks(good.digest), now: at }).reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    const bad = fixAt(BASE_OLD);
    expect(() => recordWorkflowVerification(verifying(started), { candidate: bad, checks: checks(bad.digest), now: at })).toThrow(/base commit changed/);
  });
});

describe("a conflict, recorded", () => {
  const conflicted = (paths: readonly string[], extra: Record<string, unknown> = {}) => recordWorkflowSyncConflict(syncing(extra, "conflict"), { paths, baseCommit: BASE_NEW, now: at });

  it("starts a conflict round: back at coding, counted, with the first conflicting files by name", () => {
    const next = conflicted(["src/a.ts", "src/b.ts"]);
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["src/a.ts", "src/b.ts"], fixRounds: { ci: 0, conflict: 1, feedbackAuto: 0 }, programStepId: "build", conflictBase: BASE_NEW });
    expect(next.branchSync).toBeUndefined();
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("pins the round's review base to the base commit whose merge conflicted, so the reviewers' diff shows a base change the fix took back", () => {
    const next = conflicted(["src/a.ts"]);
    expect(next.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    // The candidate the round makes is on that base; the one on the pull request stays on the old base until the fix lands.
    expect(next.candidate?.repositories[0]?.baseCommitSha).toBe(BASE_OLD);
  });

  it("names at most five files, one clean line each, and counts rounds of its own kind", () => {
    const many = Array.from({ length: 30 }, (_, index) => `src/file-${String(index)}.ts`);
    expect(conflicted(many).fixProblems).toEqual(many.slice(0, 5));
    expect(conflicted([`src/\n‮evil ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}.ts`]).fixProblems?.[0]).not.toMatch(/[\n‮]|A1b2C3d4E5f6/u);
    expect(conflicted(["a"], { fixRounds: { ci: 3, conflict: 0, feedbackAuto: 2 } }).fixRounds).toEqual({ ci: 3, conflict: 1, feedbackAuto: 2 });
  });

  it("keeps the base commit of the conflict only for a conflict round", () => {
    expect(WorkflowSnapshotSchema.safeParse({ ...waiting(), conflictBase: BASE_NEW }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...conflicted(["a"]), conflictBase: BASE_NEW }).success).toBe(true);
    expect(() => recordWorkflowSyncConflict(syncing({}, "conflict"), { paths: ["a"], baseCommit: "short", now: at })).toThrow(WorkflowTransitionError);
  });

  it("is refused once the conflict rounds are used up, and when no merge is running", () => {
    expect(() => conflicted(["a"], { fixRounds: { ci: 0, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: 0 } })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowSyncConflict(waiting(), { paths: ["a"], baseCommit: BASE_NEW, now: at })).toThrow(WorkflowTransitionError);
  });

  it("the fix pushed as a merge commit is recorded on the new base, with no head to carry an approval from", () => {
    const started = conflicted(["src/a.ts"]);
    const fixed = createCandidateManifest([{ repositoryId: "payments", commitSha: "5".repeat(40), treeSha: "4".repeat(40), baseCommitSha: BASE_OLD }]);
    const pushing = WorkflowSnapshotSchema.parse({
      ...started, revision: 30, stage: "PULL_REQUEST", state: "RUNNING", candidate: fixed,
      verification: { candidateDigest: fixed.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [reviewOf("CRITIC", fixed.digest), reviewOf("SECURITY", fixed.digest)],
    });
    const landed = recordWorkflowPullRequestUpdate(pushing, { updates: [{ repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: "4".repeat(40) }], now: at });
    const next = recordWorkflowBranchSync(landed, { repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: "4".repeat(40), baseCommitSha: BASE_NEW, now: at });
    expect(next).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { conflict: 1 } });
    // The base commit of the conflict is kept only while the round runs.
    expect(landed.conflictBase).toBeUndefined();
    expect(next.candidate?.repositories).toEqual([{ repositoryId: "payments", commitSha: MERGE, treeSha: "4".repeat(40), baseCommitSha: BASE_NEW }]);
    expect(next.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    expect(next.pullRequests?.[0]).toMatchObject({ headSha: MERGE, candidateDigest: next.candidate?.digest });
    // Code Rovara wrote carries no approval over.
    expect(next.pullRequests?.[0]?.syncedFrom).toBeUndefined();
    expect(next.reviews?.every((review) => review.candidateDigest === next.candidate?.digest)).toBe(true);
    // The pull request must hold the fix: another head or tree is refused.
    expect(() => recordWorkflowBranchSync(landed, { repositoryId: "payments", number: 7, headSha: HEAD_B, headTreeSha: "4".repeat(40), baseCommitSha: BASE_NEW, now: at })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(landed, { repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: "3".repeat(40), baseCommitSha: BASE_NEW, now: at })).toThrow(WorkflowTransitionError);
  });
});

// ---- the day, the count, the decisions

const itemOf = (overrides: Partial<MergeTrackingItem> = {}): Pick<MergeTrackingItem, "branch" | "review" | "approval" | "syncs" | "headByRovara" | "headSha"> => ({
  headSha: HEAD_A, branch: "behind", review: "approved", approval: { hostUserId: "1", login: "maint", commitId: HEAD_A }, syncs: { day: "2026-10-25", count: 0 }, headByRovara: true, ...overrides,
});
const DAY = Date.parse("2026-10-25T12:00:00.000Z");

describe("the day's count of merges", () => {
  it("is the UTC day, and a count of another day is no count", () => {
    expect(utcDay(Date.parse("2026-10-25T23:59:59.999Z"))).toBe("2026-10-25");
    expect(utcDay(Date.parse("2026-10-26T00:00:00.000Z"))).toBe("2026-10-26");
    expect(syncsToday({ day: "2026-10-25", count: 3 }, DAY)).toBe(3);
    expect(syncsToday({ day: "2026-10-24", count: 4 }, DAY)).toBe(0);
    expect(bumpSyncs({ day: "2026-10-25", count: 3 }, DAY)).toEqual({ day: "2026-10-25", count: 4 });
    expect(bumpSyncs({ day: "2026-10-24", count: 4 }, DAY)).toEqual({ day: "2026-10-25", count: 1 });
  });

  it("is capped: the fifth of a day is not counted past the schema's bound", () => {
    expect(BRANCH_SYNCS_PER_DAY_MAX).toBe(4);
    expect(() => bumpSyncs({ day: "2026-10-25", count: 4 }, DAY)).toThrow(/day/);
  });
});

describe("when to merge the base", () => {
  it("only when behind, GitHub says the base requires it, a counted approval is there and the day's merges are not used up", () => {
    const decide = (item: ReturnType<typeof itemOf>, behindRequired = true, now = DAY) => decideBranchSync({ item, behindRequired, now });
    expect(decide(itemOf())).toBe("sync");
    // No approval: nobody needs the branch up to date yet.
    expect(decide(itemOf({ review: "requested", approval: undefined }))).toBe("none");
    expect(decide(itemOf({ review: "approved", approval: undefined }))).toBe("none");
    expect(decide(itemOf({ review: "changes_requested" }))).toBe("none");
    // Behind by a commit count alone, with a base that does not require it: not needed.
    expect(decide(itemOf(), false)).toBe("none");
    for (const branch of ["up_to_date", "conflicted", "unknown"] as const) expect(decide(itemOf({ branch }))).toBe("none");
    expect(decide(itemOf({ syncs: { day: "2026-10-25", count: 3 } }))).toBe("sync");
    expect(decide(itemOf({ syncs: { day: "2026-10-25", count: 4 } }))).toBe("none");
    // Yesterday's four do not count today.
    expect(decide(itemOf({ syncs: { day: "2026-10-24", count: 4 } }))).toBe("sync");
    expect(decide(itemOf({ syncs: { day: "2026-10-25", count: 4 } }), true, Date.parse("2026-10-26T00:00:00.000Z"))).toBe("sync");
  });

  it("a conflict is a merge to try, until the conflict rounds are used up; then the stop; with the day's merges used up it waits", () => {
    const decide = (item: ReturnType<typeof itemOf>, conflict = 0, autonomy: "suggest" | "prepare" | "run" = "prepare", approved?: string[]) =>
      decideConflict({ item, workflow: { fixRounds: { ci: 0, conflict, feedbackAuto: 0 }, ...(approved === undefined ? {} : { conflictApproved: approved }) }, autonomy, now: DAY });
    expect(decide(itemOf({ branch: "conflicted", review: "requested", approval: undefined }))).toBe("sync");
    expect(decide(itemOf({ branch: "conflicted" }), 1)).toBe("sync");
    expect(decide(itemOf({ branch: "conflicted" }), CONFLICT_ROUNDS_MAX)).toBe("stop");
    expect(decide(itemOf({ branch: "conflicted", syncs: { day: "2026-10-25", count: 4 } }), 0)).toBe("none");
    // The stop does not wait for the day: it needs no machine.
    expect(decide(itemOf({ branch: "conflicted", syncs: { day: "2026-10-25", count: 4 } }), CONFLICT_ROUNDS_MAX)).toBe("stop");
    for (const branch of ["behind", "up_to_date", "unknown"] as const) expect(decide(itemOf({ branch }))).toBe("none");
    expect(decideConflict({ item: itemOf({ branch: "conflicted" }), workflow: {}, autonomy: "run", now: DAY })).toBe("sync");
    // With the agent set to suggest a conflict is asked about, never left silent (even when the day's merges are used up: asking needs no machine); a go-ahead for this head lets it go on.
    const conflicted = itemOf({ branch: "conflicted" });
    expect(decide(conflicted, 0, "suggest")).toBe("ask");
    expect(decide(itemOf({ branch: "conflicted", syncs: { day: "2026-10-25", count: 4 } }), 0, "suggest")).toBe("ask");
    expect(decide(conflicted, 1, "suggest")).toBe("ask");
    expect(decide(conflicted, 0, "suggest", [HEAD_A])).toBe("sync");
    expect(decide(conflicted, 0, "suggest", [HEAD_B])).toBe("ask");
    expect(decide(conflicted, CONFLICT_ROUNDS_MAX, "suggest", [HEAD_A])).toBe("stop");
  });
});

// ---- what a finished merge is

describe("every open pull request already holds the candidate (a merge of the base that was checked and reviewed again)", () => {
  const atPullRequest = (extra: Record<string, unknown> = {}) => WorkflowSnapshotSchema.parse({ ...waiting(), stage: "PULL_REQUEST", state: "READY", ...extra });

  it("moves the task to waiting for the merge, with a fix round finished and a publication block lifted", () => {
    const ready = holdWorkflowCandidateOnPullRequests(atPullRequest(), at);
    expect(ready).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 10 });
    expect(ready.blockReason).toBeUndefined();
    // The owner's Retry at a publication block does the same (it is not left blocked, nor refused).
    const blocked = holdWorkflowCandidateOnPullRequests(atPullRequest({ state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE }), at);
    expect(blocked).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(blocked.blockReason).toBeUndefined();
    const fixed = holdWorkflowCandidateOnPullRequests(atPullRequest({ fixSource: "ci", fixProblems: ["test"] }), at);
    expect(fixed.fixSource).toBeUndefined();
  });

  it("is refused when any open pull request holds other code, when a merge of the base is marked, when none is open, or when the step is not a publication", () => {
    const other = { ...PULL_REQUEST, candidateDigest: "7".repeat(64) };
    expect(() => holdWorkflowCandidateOnPullRequests(atPullRequest({ pullRequests: [other] }), at)).toThrow(WorkflowTransitionError);
    expect(() => holdWorkflowCandidateOnPullRequests(atPullRequest({ pullRequests: [{ ...PULL_REQUEST, headTreeSha: "8".repeat(40) }] }), at)).toThrow(WorkflowTransitionError);
    expect(() => holdWorkflowCandidateOnPullRequests(atPullRequest({ pullRequests: [{ ...PULL_REQUEST, state: "MERGED" as const }] }), at)).toThrow(WorkflowTransitionError);
    expect(() => holdWorkflowCandidateOnPullRequests(atPullRequest({ pullRequests: [PULL_REQUEST, { ...PULL_REQUEST, repositoryId: "other", number: 8, candidateDigest: "7".repeat(64) }] }), at)).toThrow(WorkflowTransitionError);
    expect(() => holdWorkflowCandidateOnPullRequests(waiting(), at)).toThrow(WorkflowTransitionError);
    expect(() => holdWorkflowCandidateOnPullRequests(atPullRequest({ state: "RUNNING" }), at)).toThrow(WorkflowTransitionError);
  });
});

describe("whether the candidate is the code the pull requests hold (the refusal of checks that ran on other code)", () => {
  const two = (secondHead: string) => {
    const candidate2 = createCandidateManifest([
      { repositoryId: "payments", commitSha: HEAD_A, treeSha: "b".repeat(40), baseCommitSha: BASE_OLD },
      { repositoryId: "ledger", commitSha: "5".repeat(40), treeSha: "6".repeat(40), baseCommitSha: BASE_OLD },
    ]);
    return { ...waiting(), candidate: candidate2, pullRequests: [PULL_REQUEST, { ...PULL_REQUEST, repositoryId: "ledger", number: 8, headSha: secondHead }] } as unknown as WorkflowSnapshot;
  };
  it("needs every open pull request to be on the candidate's commit, not just one of them", () => {
    expect(candidateIsOnPullRequest(two("5".repeat(40)))).toBe(true);
    // One repository's pull request holds other code (a fix did not reach it): a rerun whose digest differs is not "other code than the pull requests".
    expect(candidateIsOnPullRequest(two("4".repeat(40)))).toBe(false);
    expect(candidateIsOnPullRequest({ ...waiting(), pullRequests: [] })).toBe(false);
  });
});

describe("the checks re-run by themselves after a merge of the base (decision 70(c)): the policy", () => {
  const { verification: _v, reviews: _r, ...base } = waiting();
  void _v; void _r;
  const recheck = (decisions: unknown[] = []) => WorkflowSnapshotSchema.parse({ ...base, stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck, decisions });
  const retryFor = (digest: string, n: number) => ({ requestId: workflowAutoActionRequestId(TASK_ID, 100 + n, "AUTO_RETRY"), workflowRevision: 100 + n, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID,
    actorRole: "AGENTX", reason: "Rovara retried the checks by itself.", source: "AUTO_RETRY", auto: { stage: "VERIFY", candidateDigest: digest }, at });
  const budget = (over: Partial<Parameters<typeof autoFixDecision>[2]> = {}): Parameters<typeof autoFixDecision>[2] => ({ enabled: true, spend: { spentUsd: wholeTaskSpendUsd(1), roundEstimateUsd: 3, capUsd: 15 }, dayBudgetHasRoom: true, baselineRequests: 0, ...over });
  const cause = { blockCause: "base-merged" as const };

  it("retries the checks once for the merged candidate, while a pull request is open (any other block with one open asks a person)", () => {
    expect(autoFixDecision(recheck(), cause, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["base-merged"] });
    const without = autoFixDecision(recheck(), {}, budget());
    expect(without).toMatchObject({ action: "ASK", reason: "needs-a-person" });
    expect("codes" in without && without.codes).toContain("pull-request-open");
  });

  it("asks when the spend is over the cap, cannot be read, or the day budget has no room", () => {
    expect(autoFixDecision(recheck(), cause, budget({ spend: { spentUsd: wholeTaskSpendUsd(14), roundEstimateUsd: 3, capUsd: 15 } }))).toMatchObject({ action: "ASK", reason: "spend-cap" });
    expect(autoFixDecision(recheck(), cause, budget({ spend: { spentUsd: wholeTaskSpendUsd(Number.NaN), roundEstimateUsd: 3, capUsd: 15 } }))).toMatchObject({ action: "ASK", reason: "inputs-missing" });
    expect(autoFixDecision(recheck(), cause, budget({ dayBudgetHasRoom: false }))).toMatchObject({ action: "ASK", reason: "day-budget" });
  });

  it("allows one automatic retry per candidate (a base that keeps moving is bounded by the re-run's daily allowance below)", () => {
    const digest = candidate.digest;
    // The retry was already used for this code: the second asks.
    expect(autoFixDecision(recheck([retryFor(digest, 0)]), cause, budget())).toMatchObject({ action: "ASK", reason: "retry-limit" });
    // Another candidate (the base moved again) has its own retry, until the task's automatic actions run out.
    const others = Array.from({ length: WORKFLOW_AUTO_ACTION_LIMIT - 1 }, (_, n) => retryFor(`${String(n + 1).repeat(64)}`.slice(0, 64), n));
    expect(autoFixDecision(recheck(others), cause, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["base-merged"] });
    // The task's lifetime automatic actions (its send backs and ordinary retries) are not the re-run's: with them used up a merged base still has its own daily allowance, while any other transient block asks.
    const lifetime = [...others, retryFor("a".repeat(64), 50)];
    expect(autoFixDecision(recheck(lifetime), cause, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["base-merged"] });
    expect(autoFixDecision({ ...recheck(lifetime), pullRequests: [] }, { blockCause: "run-lost" }, budget())).toMatchObject({ action: "ASK", reason: "total-limit" });
  });
});

describe("the re-run's own allowance and its row writer (decision 70(c))", () => {
  const { verification: _v, reviews: _r, ...base } = waiting();
  void _v; void _r;
  const recheck = (decisions: unknown[] = []) => WorkflowSnapshotSchema.parse({ ...base, stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck, decisions });
  const merged = (n: number, hoursAgo: number, digest = candidate.digest) => ({ requestId: workflowAutoActionRequestId(TASK_ID, 200 + n, "AUTO_RETRY"), workflowRevision: 200 + n, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID,
    actorRole: "AGENTX", reason: BASE_MERGED_RETRY_REASON, source: "AUTO_RETRY", auto: { stage: "VERIFY", candidateDigest: digest }, at: new Date(Date.parse(at) - hoursAgo * 3_600_000).toISOString() });
  const budget = (): Parameters<typeof autoFixDecision>[2] => ({ enabled: true, spend: { spentUsd: wholeTaskSpendUsd(1), roundEstimateUsd: 3, capUsd: 15 }, dayBudgetHasRoom: true, baselineRequests: 0, nowMs: Date.parse(at) });
  const cause = { blockCause: "base-merged" as const };

  it("gives a task three re-runs a day, of its own: they do not use the task's lifetime automatic actions, and a day later the allowance is back", () => {
    const three = [0, 1, 2].map((n) => merged(n, n + 1, `${String(n + 1).repeat(64)}`.slice(0, 64)));
    expect(baseMergedRetriesToday(recheck(three).decisions, Date.parse(at))).toBe(BASE_MERGED_RETRIES_PER_DAY);
    // The third is the last: the fourth in the same day asks, with its own reason (not "total-limit").
    expect(autoFixDecision(recheck(three), cause, budget())).toMatchObject({ action: "ASK", reason: "base-merged-limit" });
    expect(autoFixDecision(recheck(three.slice(0, 2)), cause, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["base-merged"] });
    // Re-runs older than a day are not counted.
    const old = [0, 1, 2].map((n) => merged(n, 25 + n, `${String(n + 1).repeat(64)}`.slice(0, 64)));
    expect(autoFixDecision(recheck(old), cause, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["base-merged"] });
    // Many re-runs over many days never use the task's six lifetime actions: the lifetime limit does not ask here.
    const many = Array.from({ length: 10 }, (_, n) => merged(n, 25 + n, `${String(n % 9 + 1).repeat(64)}`.slice(0, 64)));
    expect(autoFixDecision(recheck(many), cause, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["base-merged"] });
  });

  it("does not count the re-runs in the task's lifetime automatic actions: later ordinary actions still have all six", () => {
    const three = [0, 1, 2].map((n) => merged(n, n + 1, `${String(n + 1).repeat(64)}`.slice(0, 64)));
    // Five ordinary automatic retries of other candidates (the task's lifetime actions: five of six).
    const ordinary = Array.from({ length: 5 }, (_, n) => ({ ...merged(10 + n, 30 + n, `${String(n + 4).repeat(64)}`.slice(0, 64)), reason: "Rovara retried the checks by itself." }));
    const decisions = recheck([...three, ...ordinary]).decisions;
    expect(workflowAutoFixCounts(decisions).actions).toBe(5);
    // An ordinary transient block still gets its action (5 < 6); with the three re-runs counted it would have 8 and ask.
    expect(autoFixDecision({ ...recheck([...three, ...ordinary]), pullRequests: [] }, { blockCause: "run-lost" }, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["run-lost"] });
  });

  it("holds the daily allowance again in the system move: a fourth re-run in 24 hours is refused there too, an ordinary retry is not", () => {
    const three = [0, 1, 2].map((n) => merged(n, n + 1, `${String(n + 1).repeat(64)}`.slice(0, 64)));
    const input = (reason: string) => ({ expectedRevision: recheck(three).revision, stage: "VERIFY" as const, reason, spend: { spentUsd: wholeTaskSpendUsd(1), roundEstimateUsd: 3, capUsd: 15 }, now: at });
    expect(() => workflowAutomaticRetryDecision(recheck(three), input(BASE_MERGED_RETRY_REASON))).toThrow(/used up for today/u);
    expect(workflowAutomaticRetryDecision(recheck(three), input("Rovara retried the checks by itself.")).source).toBe("AUTO_RETRY");
    // Two earlier today: the third is allowed.
    expect(workflowAutomaticRetryDecision(recheck(three.slice(0, 2)), { ...input(BASE_MERGED_RETRY_REASON), expectedRevision: recheck(three.slice(0, 2)).revision }).reason).toBe(BASE_MERGED_RETRY_REASON);
  });

  it("re-runs by itself only where automatic fixing is on and no E2E (a clean conflict merge on an E2E task stays the owner's)", () => {
    const e2e = { e2e: { required: true } } as never;
    expect(baseMergedRechecksItself({ autofix: { enabled: true, capUsd: 15, roundEstimateUsd: 3 } }, {})).toBe(true);
    expect(baseMergedRechecksItself({ autofix: { enabled: true, capUsd: 15, roundEstimateUsd: 3 } }, e2e)).toBe(false);
    expect(baseMergedRechecksItself({ autofix: { enabled: false, capUsd: 15, roundEstimateUsd: 3 } }, {})).toBe(false);
    // Code's own switch is on unless it says false (Cloud's is off unless it says true).
    expect(baseMergedRechecksItself({}, {})).toBe(true);
  });
});


describe("what a finished merge of the base is", () => {
  const binding = { repositoryId: "payments", number: 7, baseCommit: BASE_NEW, expectedHeadCommit: HEAD_A };
  const result = (overrides: Record<string, unknown> = {}) => ({
    action: "sync" as const, repository: "payments", number: 7, url: PULL_REQUEST.url, state: "open" as const, headBranch: "agentx/00000000-0000-4000-8000-000000000001", baseBranch: "main",
    previousCommit: HEAD_A, commit: MERGE, treeSha: MERGED_TREE, checks: [], codeBuildChecks: [], reconciled: false, ...overrides,
  });
  const github = (overrides: Record<string, unknown> = {}) => ({ state: "open" as const, headBranch: "agentx/00000000-0000-4000-8000-000000000001", headCommit: MERGE, headTreeSha: MERGED_TREE, parents: [HEAD_A, BASE_NEW], ...overrides });
  const plan = (input: { askFirst?: boolean; workflow?: WorkflowSnapshot; status?: "SUCCEEDED" | "FAILED"; error?: string; result?: Record<string, unknown> | undefined; github?: ReturnType<typeof github> | undefined; baseBranch?: string }) =>
    planBranchSyncOutcome({
      workflow: input.workflow ?? syncing(), binding, terminalStatus: input.status ?? "SUCCEEDED", ...(input.error === undefined ? {} : { terminalError: input.error }),
      result: "result" in input ? input.result as never : result(), github: "github" in input ? input.github : github(), baseBranch: input.baseBranch ?? "main",
      recordedBranch: "agentx/00000000-0000-4000-8000-000000000001", now: at, ...(input.askFirst === undefined ? {} : { askFirst: input.askFirst }),
    });

  it("is a clean merge when GitHub shows the merge commit on the recorded head and the base, with the tree the worker said", () => {
    const outcome = plan({});
    expect(outcome.kind).toBe("synced");
    if (outcome.kind !== "synced") return;
    expect(outcome.workflow).toMatchObject({ state: "WAITING", pullRequests: [expect.objectContaining({ headSha: MERGE, syncedFrom: HEAD_A })] });
    expect(outcome).toMatchObject({ headSha: MERGE, headTreeSha: MERGED_TREE, previousHeadSha: HEAD_A, baseCommitSha: BASE_NEW });
  });

  it("is a merge even when the worker's result was lost, if GitHub shows exactly [recorded head, asked base]: the same new candidate, but no head is kept for an approval to carry from (decision 67b)", () => {
    for (const status of ["FAILED", "INTERRUPTED", "CANCELLED"] as never[]) {
      const outcome = plan({ status, error: "RUNTIME_UNAVAILABLE: compute lost", result: undefined });
      expect(outcome.kind, status).toBe("synced");
      if (outcome.kind !== "synced") continue;
      expect(outcome.workflow.pullRequests?.[0], status).toMatchObject({ headSha: MERGE });
      expect(outcome.workflow.pullRequests?.[0]?.syncedFrom, status).toBeUndefined();
      expect(outcome.workflow.candidate?.repositories[0], status).toMatchObject({ commitSha: MERGE, baseCommitSha: BASE_NEW });
    }
    // The same merge with its result in hand is one Rovara's checks passed on.
    const verified = plan({});
    expect(verified.kind === "synced" && verified.workflow.pullRequests?.[0]?.syncedFrom).toBe(HEAD_A);
    // A failed run is still not recorded when the host does not show exactly that merge.
    for (const bad of [{ parents: [HEAD_A] }, { parents: [HEAD_A, "1".repeat(40)] }, { parents: undefined }]) {
      expect(plan({ status: "FAILED", error: "RUNTIME_UNAVAILABLE: compute lost", result: undefined, github: github(bad) }).kind, JSON.stringify(bad)).toBe("unchanged");
    }
  });

  it("is refused when the merge commit's second parent is not the base commit, or its first is not the recorded head, or the tree is not the one reported", () => {
    for (const bad of [{ parents: [HEAD_A, "1".repeat(40)] }, { parents: [HEAD_B, BASE_NEW] }, { parents: [BASE_NEW, HEAD_A] }, { parents: [HEAD_A] }, { parents: [HEAD_A, BASE_NEW, MERGE] }, { parents: undefined }]) {
      expect(plan({ github: github(bad) }).kind, JSON.stringify(bad)).toBe("unchanged");
    }
    expect(plan({ github: github({ headTreeSha: "3".repeat(40) }) }).kind).toBe("unchanged");
    expect(plan({ github: github({ headCommit: "1".repeat(40) }) }).kind).toBe("unchanged");
    expect(plan({ github: github({ headBranch: "agentx/other" }) }).kind).toBe("unchanged");
    expect(plan({ github: github({ state: "closed" }) }).kind).toBe("unchanged");
    expect(plan({ github: undefined }).kind).toBe("unchanged");
  });

  it("is not a conflict round when the head moved meanwhile (a person pushed): nothing is started over their push", () => {
    const outcome = plan({ result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_B, parents: [HEAD_A] }) });
    expect(outcome.kind).toBe("unchanged");
  });

  it("is nothing to record when the branch already had the base, or when GitHub shows a head that is not the merge (a person pushed)", () => {
    const upToDate = plan({ result: result({ commit: HEAD_A, reconciled: true }), github: github({ headCommit: HEAD_A, headTreeSha: "b".repeat(40), parents: [BASE_OLD] }) });
    expect(upToDate.kind).toBe("unchanged");
    if (upToDate.kind === "unchanged") expect(upToDate.workflow).toMatchObject({ state: "WAITING" });
    expect(plan({ github: github({ headCommit: HEAD_B, parents: [HEAD_A] }) }).kind).toBe("unchanged");
  });

  it("is a conflict round when the merge conflicted, naming the files; the workflow starts the fix", () => {
    const outcome = plan({ result: result({ commit: HEAD_A, previousCommit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["src/a.ts", "src/b.ts"] }), github: github({ headCommit: HEAD_A, headTreeSha: "b".repeat(40), parents: [BASE_OLD] }) });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(outcome.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["src/a.ts", "src/b.ts"], fixRounds: { conflict: 1 } });
  });

  it("asks instead of starting the round when the agent is set to suggest by now and the merge was not approved (autonomy is read again at the paid step)", () => {
    const outcome = plan({ result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }), askFirst: true });
    expect(outcome).toMatchObject({ kind: "asked", message: branchConflictAskMessage("main") });
    if (outcome.kind === "asked") expect(outcome.workflow).toMatchObject({ state: "BLOCKED", blockReason: outcome.message });
    expect(plan({ result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }), askFirst: false }).kind).toBe("conflict");
  });

  it("stops with the exact text when it conflicts after the conflict rounds, naming the pull request's base branch", () => {
    const used = syncing({ fixRounds: { ci: 0, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: 0 } }, "conflict");
    const outcome = plan({ workflow: used, baseBranch: "develop", result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }) });
    expect(outcome).toMatchObject({ kind: "stopped", message: "The branch still conflicts with develop after 2 tries. Resolve it on GitHub or close the task." });
    if (outcome.kind === "stopped") expect(outcome.workflow).toMatchObject({ state: "BLOCKED", blockReason: outcome.message });
  });

  it("stops with the exact text when GitHub refused the push of workflow files, and not as a conflict round", () => {
    const refused = "RUNTIME_UNAVAILABLE: ! [remote rejected] HEAD -> agentx/x (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)";
    expect(isWorkflowFilesRefusal(refused)).toBe(true);
    const outcome = plan({ status: "FAILED", error: refused, result: undefined, github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }) });
    expect(outcome).toMatchObject({ kind: "stopped", message: "The base branch changed CI workflow files, which Rovara can't push. Update the branch on GitHub." });
    if (outcome.kind === "stopped") expect(outcome.workflow.fixRounds).toBeUndefined();
  });

  it("is told from other failures: a failed check, a moved head, a lost machine end the merge with nothing recorded", () => {
    for (const error of ["CONFIG_INVALID: one or more registered readiness checks failed", "STALE_FENCE: pull request head changed since AgentX last observed it", "RUNTIME_UNAVAILABLE: compute lost", "CONFIG_INVALID: pull request branch conflicts with the latest base"]) {
      expect(isWorkflowFilesRefusal(error), error).toBe(false);
      const outcome = plan({ status: "FAILED", error, result: undefined, github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }) });
      expect(outcome.kind, error).toBe("unchanged");
      if (outcome.kind === "unchanged") expect(outcome.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    }
    expect(isWorkflowFilesRefusal(undefined)).toBe(false);
  });
});

describe("the request of a merge", () => {
  it("is the same for the same attempt and another for another base commit or revision", () => {
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).toBe(branchSyncRequestId(TASK_ID, 10, BASE_NEW));
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).not.toBe(branchSyncRequestId(TASK_ID, 10, BASE_OLD));
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).not.toBe(branchSyncRequestId(TASK_ID, 12, BASE_NEW));
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("a merge that keeps failing", () => {
  const binding = { repositoryId: "payments", number: 7, baseCommit: BASE_NEW, expectedHeadCommit: HEAD_A };
  const failed = (workflow: WorkflowSnapshot, error: string | undefined) => planBranchSyncOutcome({
    workflow, binding, terminalStatus: "FAILED", ...(error === undefined ? {} : { terminalError: error }), result: undefined,
    github: { state: "open", headBranch: "agentx/00000000-0000-4000-8000-000000000001", headCommit: HEAD_A, headTreeSha: "b".repeat(40), parents: [BASE_OLD] },
    baseBranch: "main", recordedBranch: "agentx/00000000-0000-4000-8000-000000000001", now: at,
  });
  const CHECKS = "CONFIG_INVALID: one or more registered readiness checks failed";
  const again = (workflow: WorkflowSnapshot, reason: "behind" | "conflict" = "behind") => startWorkflowBranchSyncRun(startWorkflowBranchSync(workflow, { repositoryId: "payments", number: 7, reason, now: at }), at);

  it("a behind merge that really failed twice on the same head gives up without blocking the task: it stays behind and says so, once", () => {
    expect(SYNC_FAILURES_MAX).toBe(2);
    const first = failed(syncing(), CHECKS);
    expect(first.kind).toBe("unchanged");
    if (first.kind !== "unchanged") return;
    expect(first.workflow).toMatchObject({ state: "WAITING", syncFailures: { headSha: HEAD_A, count: 1 } });
    const second = failed(again(first.workflow), CHECKS);
    const text = "Rovara couldn't bring the branch up to date: the project's checks fail once the base is merged in. Update it on GitHub.";
    expect(second).toMatchObject({ kind: "gave_up", message: text });
    if (second.kind !== "gave_up") return;
    // Not blocked: CI fixes, feedback and conflict rounds go on; this head is simply not tried again.
    expect(second.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", syncFailures: { headSha: HEAD_A, count: SYNC_FAILURES_MAX } });
    expect(second.workflow.blockReason).toBeUndefined();
    expect(branchSyncGiveUpMessage("other")).toBe("Rovara couldn't bring the branch up to date: the merge did not go through. Update it on GitHub.");
    expect(isBranchSyncGiveUpReason(text)).toBe(true);
    expect(isBranchSyncBlockReason(branchSyncGiveUpMessage("other"))).toBe(true);
  });

  it("a conflict merge that really failed twice blocks the task (a conflict has to be dealt with), and its Retry is one more try", () => {
    const first = failed(syncing({}, "conflict"), CHECKS);
    if (first.kind !== "unchanged") throw new Error("expected unchanged");
    const second = failed(again(first.workflow, "conflict"), CHECKS);
    expect(second.kind).toBe("stopped");
    if (second.kind !== "stopped") return;
    expect(second.workflow).toMatchObject({ state: "BLOCKED", blockReason: second.message });
    const retried = retryWorkflowBranchSync(second.workflow, at);
    expect(retried).toMatchObject({ state: "WAITING", syncFailures: { headSha: HEAD_A, count: SYNC_FAILURES_MAX - 1 } });
    expect(retried.blockReason).toBeUndefined();
    // One more try, and a failure of it stops again.
    const third = failed(again(retried, "conflict"), CHECKS);
    expect(third.kind).toBe("stopped");
  });

  it("only a real merge failure counts: GitHub errors, a lost machine and a stale fence retry with a growing delay and never stop", () => {
    let workflow = syncing();
    for (const [index, error] of ["RUNTIME_UNAVAILABLE: GitHub answered 503", undefined, "OPERATION_INTERRUPTED: spot reclaimed", "RUNTIME_UNAVAILABLE: rate limited"].entries()) {
      const outcome = failed(workflow, error);
      expect(outcome.kind, String(error)).toBe("unchanged");
      if (outcome.kind !== "unchanged") return;
      expect(outcome.workflow.syncFailures).toMatchObject({ headSha: HEAD_A, count: 0, transient: index + 1 });
      const wait = Date.parse(outcome.workflow.syncFailures!.retryAfter!) - Date.parse(at);
      expect(wait).toBe(Math.min(SYNC_BACKOFF_MINUTES.max, SYNC_BACKOFF_MINUTES.first * 2 ** index) * 60_000);
      workflow = again(outcome.workflow);
    }
    // A moved head is a person's push: nothing is counted.
    const moved = failed(syncing(), "STALE_FENCE: pull request head changed since AgentX last observed it");
    expect(moved.kind === "unchanged" && moved.workflow.syncFailures).toBeFalsy();
  });

  it("names the failure in fixed words: the project's checks, or the merge not going through, never the worker's own text", () => {
    expect(classifySyncFailure(CHECKS)).toBe("checks");
    expect(classifySyncFailure("CONFIG_INVALID: Git could not read the repository's files")).toBe("other");
    expect(classifySyncFailure(`CONFIG_INVALID: ${"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"} boom`)).toBe("other");
    expect(classifySyncFailure(undefined)).toBe("other");
  });

  it("a success clears the count", () => {
    expect(recordWorkflowBranchSync(syncing({ syncFailures: { headSha: HEAD_A, count: 1 } }), clean).syncFailures).toBeUndefined();
  });
});

describe("when GitHub cannot be read for a lost merge through the whole retry budget", () => {
  it("says so: the task stops with a plain text, and the text is a branch-sync stop", () => {
    expect(BRANCH_SYNC_UNSURE_MESSAGE).toBe("Rovara couldn't tell whether the merge of the base branch went through, because GitHub couldn't be read. Check the pull request on GitHub.");
    expect(isBranchSyncBlockReason(BRANCH_SYNC_UNSURE_MESSAGE)).toBe(true);
    const stopped = blockWorkflowBranchSync(syncing(), { reason: BRANCH_SYNC_UNSURE_MESSAGE, now: at });
    expect(stopped).toMatchObject({ state: "BLOCKED", blockReason: BRANCH_SYNC_UNSURE_MESSAGE });
    expect(stopped.branchSync).toBeUndefined();
  });
});
