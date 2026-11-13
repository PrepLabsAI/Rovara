// Port lane L7a: the pure rules of the merge core (Cloud's, unchanged): what the checks say, whose approval counts, when the pull requests may be merged and in whose words.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, WORKFLOW_BLOCK_REASONS, type ChangeRequestStatus, type MergeTrackingItem } from "../../packages/contracts/src/index.js";
import { humanApprovalOf, latestReviewers } from "../../packages/core/src/core/merge/approval.js";
import { mergeReadiness, mergeViewFromReadiness, riskOfTask, type MergePullRequestFacts, type ReadinessInput } from "../../packages/core/src/core/merge/merge.js";
import { NO_CI_GRACE_MS, PERMISSION_LOOKUPS_MAX, readBranch, readCi, readHeadByRovara, readReviews, tracksMerge } from "../../packages/core/src/core/merge/merge-tracking.js";

const HEAD = "a".repeat(40);
const OLD = "1".repeat(40);
const NOW = Date.parse("2026-11-09T10:00:00.000Z");

function status(overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus {
  return {
    id: "7", state: "open", draft: false, headRevision: HEAD, targetBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0, checks: [], requiredChecks: [], targetHasRequiredChecks: false,
    headDefinesChecks: true, requestedReviewers: 0, reviews: [], ...overrides,
  };
}
const check = (name: string, state: "pending" | "completed", conclusion?: ChangeRequestStatus["checks"][number]["conclusion"], extra: Record<string, unknown> = {}): ChangeRequestStatus["checks"][number] =>
  ({ name, state, ...(conclusion === undefined ? {} : { conclusion }), required: false, url: "", ...extra });
const review = (login: string, state: ChangeRequestStatus["reviews"][number]["state"], at: string, revision = HEAD, type: "person" | "bot" | "other" = "person"): ChangeRequestStatus["reviews"][number] =>
  ({ reviewer: { login, hostUserId: `id-${login}` }, accountType: type, state, revision, submittedAt: at });

describe("readCi", () => {
  const input = { checksEverSeen: false, lastRovaraPushAt: undefined, now: NOW };
  it("counts every check on an unprotected base and the required ones on a protected one", () => {
    const checks = [check("unit", "completed", "success"), check("lint", "completed", "failure")];
    expect(readCi(status({ checks }), input)).toMatchObject({ ci: "failing", ciBasis: "all_checks", failingChecks: ["lint"] });
    expect(readCi(status({ checks: [check("unit", "completed", "success"), check("lint", "completed", "failure")], targetHasRequiredChecks: true, requiredChecks: [{ name: "unit" }] }), input))
      .toMatchObject({ ci: "passing", ciBasis: "required" });
  });
  it("is pending while a required check has not reported, and while a counted one is unfinished or needs action", () => {
    expect(readCi(status({ checks: [check("lint", "completed", "success")], targetHasRequiredChecks: true, requiredChecks: [{ name: "unit" }] }), input).ci).toBe("pending");
    expect(readCi(status({ checks: [check("unit", "pending")] }), input).ci).toBe("pending");
    expect(readCi(status({ checks: [check("unit", "completed", "action_required")] }), input).ci).toBe("pending");
    expect(readCi(status({ checks: [check("unit", "completed", "skipped")] }), input).ci).toBe("passing");
  });
  it("reads cancelled, timed-out and startup failures as failing, and keeps ten failing names at most, each once", () => {
    for (const conclusion of ["cancelled", "timed_out", "startup_failure", "error", "stale"] as const) expect(readCi(status({ checks: [check("unit", "completed", conclusion)] }), input).ci).toBe("failing");
    const many = Array.from({ length: 14 }, (_, n) => check(`job-${String(n)}`, "completed", "failure"));
    const read = readCi(status({ checks: [...many, check("job-0", "completed", "failure")] }), input);
    expect(read.failingChecks).toHaveLength(10);
    expect(new Set(read.failingChecks).size).toBe(10);
  });
  it("respects the app a required check names, and never reads unreadable checks as passing", () => {
    const required = { targetHasRequiredChecks: true, requiredChecks: [{ name: "unit", source: "app-a" }] };
    expect(readCi(status({ ...required, checks: [check("unit", "completed", "success", { source: "app-b" })] }), input).ci).toBe("pending");
    expect(readCi(status({ ...required, checks: [check("unit", "completed", "success", { source: "app-a" })] }), input).ci).toBe("passing");
    expect(readCi(status({ checks: [check("unit", "completed", "success")], checksUnavailable: true }), input).ci).toBe("pending");
  });
  it("hands a failing check's run id and the host's word that its log can be read to the fix, and never reads the source for it (item C4)", () => {
    const failing = check("unit", "completed", "failure", { source: "15368", runId: "77", logReadable: true });
    const plain = check("lint", "completed", "failure", { source: "15368", runId: "78" });
    const read = readCi(status({ checks: [failing, plain] }), input);
    expect(read.failingDetails).toEqual([
      expect.objectContaining({ name: "unit", jobId: "77", source: "15368", logReadable: true }),
      expect.not.objectContaining({ logReadable: true }),
    ]);
  });
  it("reads 'no CI' only when nothing ever reported, the head defines no checks and Rovara's push is a full sweep interval old", () => {
    const bare = status({ headDefinesChecks: false });
    expect(readCi(bare, { checksEverSeen: false, lastRovaraPushAt: NOW - 1_000, now: NOW })).toMatchObject({ ci: "pending", recheckAt: NOW - 1_000 + NO_CI_GRACE_MS });
    expect(readCi(bare, { checksEverSeen: false, lastRovaraPushAt: NOW - NO_CI_GRACE_MS, now: NOW }).ci).toBe("none");
    expect(readCi(bare, { checksEverSeen: true, lastRovaraPushAt: NOW - NO_CI_GRACE_MS, now: NOW }).ci).toBe("pending");
    expect(readCi(status({ headDefinesChecks: true }), { checksEverSeen: false, lastRovaraPushAt: NOW - NO_CI_GRACE_MS, now: NOW }).ci).toBe("pending");
  });
});

describe("readReviews", () => {
  const permissions = (table: Record<string, "admin" | "write" | "read" | "none">) => async (login: string) => table[login] ?? "none";
  it("counts the latest review of each person with write access, and a person asking for changes refuses", async () => {
    const reviews = [review("ana", "APPROVED", "2026-11-09T08:00:00Z"), review("bo", "CHANGES_REQUESTED", "2026-11-09T08:10:00Z"), review("bo", "COMMENTED", "2026-11-09T08:20:00Z")];
    expect(await readReviews(status({ reviews }), { requested: false, permission: permissions({ ana: "write", bo: "write" }) })).toEqual({ review: "changes_requested" });
    expect(await readReviews(status({ reviews: [reviews[0]!] }), { requested: false, permission: permissions({ ana: "write" }) }))
      .toMatchObject({ review: "approved", approval: { login: "ana", commitId: HEAD } });
  });
  it("does not count a bot, a reader, a dismissed review, or more reviewers than it looks up; a cut list reads as asked-for", async () => {
    expect(await readReviews(status({ reviews: [review("bot", "APPROVED", "2026-11-09T08:00:00Z", HEAD, "bot")] }), { requested: false, permission: permissions({ bot: "write" }) })).toEqual({ review: "not_requested" });
    expect(await readReviews(status({ reviews: [review("ana", "APPROVED", "2026-11-09T08:00:00Z")] }), { requested: false, permission: permissions({ ana: "read" }) })).toEqual({ review: "requested" });
    expect(await readReviews(status({ reviews: [review("ana", "APPROVED", "2026-11-09T08:00:00Z"), review("ana", "DISMISSED", "2026-11-09T08:30:00Z")] }), { requested: true, permission: permissions({ ana: "write" }) })).toEqual({ review: "requested" });
    const crowd = Array.from({ length: PERMISSION_LOOKUPS_MAX + 1 }, (_, n) => review(`p${String(n)}`, "APPROVED", "2026-11-09T08:00:00Z"));
    expect(await readReviews(status({ reviews: crowd }), { requested: false, permission: async () => "write" })).toEqual({ review: "requested" });
    expect(await readReviews(status({ reviews: [review("ana", "APPROVED", "2026-11-09T08:00:00Z")], reviewsIncomplete: true }), { requested: false, permission: async () => { throw new Error("no lookups"); } })).toEqual({ review: "requested" });
  });
});

describe("humanApprovalOf", () => {
  const base = (over: Partial<Parameters<typeof humanApprovalOf>[0]> = {}) => humanApprovalOf({
    reviews: [{ hostUserId: "1", login: "ana", accountType: "person", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-09T08:00:00Z" }], headSha: HEAD, syncedFrom: undefined, ciPassingOnHead: true,
    permissions: new Map([["ana", "write" as const]]), requesterHostUserIds: "unlinked", linkedHostUserIds: new Set(), allowSelfApproval: true, ...over,
  });
  it("counts a writer's approval of the head, with self-approval on, and names why not otherwise", () => {
    expect(base()).toMatchObject({ approved: true, by: { login: "ana" } });
    expect(base({ headSha: OLD })).toEqual({ approved: false, reason: "stale" });
    expect(base({ permissions: new Map([["ana", "read" as const]]) })).toEqual({ approved: false, reason: "no_write" });
    expect(base({ reviews: [] })).toEqual({ approved: false, reason: "none" });
  });
  it("carries an approval of the head before a clean sync only while checks pass on the merged head", () => {
    expect(base({ headSha: OLD, syncedFrom: HEAD, ciPassingOnHead: true })).toMatchObject({ approved: true });
    expect(base({ headSha: OLD, syncedFrom: HEAD, ciPassingOnHead: false })).toEqual({ approved: false, reason: "stale" });
  });
  it("with self-approval off needs a linked person who is not a requester", () => {
    expect(base({ allowSelfApproval: false })).toEqual({ approved: false, reason: "unlinked_requester" });
    expect(base({ allowSelfApproval: false, requesterHostUserIds: ["1"], linkedHostUserIds: new Set(["1"]) })).toEqual({ approved: false, reason: "self_only" });
    expect(base({ allowSelfApproval: false, requesterHostUserIds: ["2"], linkedHostUserIds: new Set(["1"]) })).toMatchObject({ approved: true });
  });
  it("never counts an excluded account (the Auditor), and latestReviewers drops dismissals and bots' ids", () => {
    expect(base({ excludedHostUserIds: new Set(["1"]) })).toEqual({ approved: false, reason: "no_write" });
    expect(latestReviewers([{ hostUserId: "1", login: "ana", accountType: "person", state: "DISMISSED", commitId: HEAD, submittedAt: "2026-11-09T08:00:00Z" }])).toEqual([]);
  });
});

describe("mergeReadiness", () => {
  const fact = (over: Partial<MergePullRequestFacts> = {}): MergePullRequestFacts => ({ repositoryId: "app", number: 7, headSha: HEAD, state: "open", draft: false, baseBranch: "main", ci: "passing", branch: "up_to_date", behindRequired: false, ...over });
  const approved = new Map([["app#7", { approved: true as const, by: { hostUserId: "1", login: "ana" }, commitId: HEAD, approvers: [{ hostUserId: "1", login: "ana" }] }]]);
  const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    pullRequests: [fact()], approvals: approved, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#7", "main"]]), presser: { hostUserId: "1" },
    allowSelfApproval: true, requesterName: "Priya", ...over,
  });
  const refused = (over: Partial<ReadinessInput>) => { const r = mergeReadiness(input(over)); return r.ready ? "ready" : r.message; };

  it("is ready when the pull request is open, on its base, not a draft, green, clean and approved", () => {
    expect(mergeReadiness(input())).toEqual({ ready: true });
  });
  it("says why not, in the exact words", () => {
    expect(refused({ pullRequests: [fact({ draft: true })] })).toBe(M.draft);
    expect(refused({ pullRequests: [fact({ ci: "failing" })] })).toBe(M.checks);
    expect(refused({ pullRequests: [fact({ ci: "pending" })] })).toBe(M.checks);
    expect(refused({ pullRequests: [fact({ branch: "conflicted" })] })).toBe(M.conflicted("main"));
    expect(refused({ pullRequests: [fact({ state: "closed" })] })).toBe(M.notOpen);
    expect(refused({ recordedBases: new Map([["app#7", "release"]]) })).toBe(M.baseChanged("main"));
    expect(refused({ approvals: new Map() })).toBe(M.needsWriteApproval("app"));
    expect(refused({ approvals: new Map(), allowSelfApproval: false })).toBe(M.needsOtherApproval("Priya"));
    expect(refused({ pullRequests: [fact({ branch: "behind", behindRequired: true })] })).toBe(M.behind("main"));
    expect(refused({ pullRequests: [fact({ branch: "behind", behindRequired: false })] })).toBe("ready");
    expect(refused({ pullRequests: [fact({ state: "merged" })] })).toBe(M.taskClosed);
  });
  it("tells a task that needs browser or API checks to update its branch itself (Rovara does not merge the base in), and a merged base that needs its checks again to Retry checks (decision 70(c))", () => {
    const behind = { pullRequests: [fact({ branch: "behind", behindRequired: true })] };
    expect(refused({ ...behind, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", e2e: { required: true } } })).toBe(M.behindByHand("main"));
    expect(M.behindByHand("main")).not.toContain("I'm bringing it up to date");
    expect(refused({ ...behind, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", e2e: { required: false } } })).toBe(M.behind("main"));
    // The base was merged in: not "still changing", but the owner's Retry checks.
    expect(refused({ workflow: { stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck } })).toBe(M.baseMerged);
    expect(refused({ workflow: { stage: "VERIFY", state: "BLOCKED", blockReason: "checks failed" } })).toBe(M.changing);
  });
  it("holds while the task is changing, blocked, closed, or a second review waits", () => {
    expect(refused({ workflow: { stage: "WAIT_FOR_MERGE", state: "RUNNING" } })).toBe(M.changing);
    expect(refused({ workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", fixSource: {} } })).toBe(M.changing);
    expect(refused({ workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" } } })).toBe(M.changing);
    expect(refused({ workflow: { stage: "REVIEW", state: "WAITING" } })).toBe(M.changing);
    expect(refused({ workflow: { stage: "MERGED", state: "COMPLETE" } })).toBe(M.taskClosed);
    expect(refused({ secondReviewWait: "A second review is waiting for you." })).toBe("A second review is waiting for you.");
  });
  it("names the repository when there are several pull requests", () => {
    const two = [fact(), fact({ repositoryId: "docs", number: 3, draft: true })];
    const approvals = new Map([...approved, ["docs#3", approved.get("app#7")!]]);
    expect(refused({ pullRequests: two, approvals, recordedBases: new Map([["app#7", "main"], ["docs#3", "main"]]) })).toBe(M.repository("docs", M.draft));
  });
  it("needs a linked account for whoever presses, unless the install turns that off; and the only approver cannot press when self-approval is off", () => {
    expect(refused({ presser: { hostUserId: undefined } })).toBe(M.linkGithub);
    expect(refused({ presser: { hostUserId: undefined }, requirePresserAccount: false })).toBe("ready");
    // With self-approval off the presser must be known whatever the flag says, or "the only approver cannot press" could not be checked.
    expect(refused({ presser: { hostUserId: undefined }, requirePresserAccount: false, allowSelfApproval: false })).toBe(M.linkGithub);
    expect(refused({ allowSelfApproval: false, requesterName: "Priya", approvals: new Map([["app#7", { ...approved.get("app#7")!, approvers: [{ hostUserId: "1", login: "ana" }] }]]), presser: { hostUserId: "1" } })).toBe(M.presserApproved);
    expect(refused({ allowSelfApproval: false, presser: { hostUserId: "9" } })).toBe("ready");
  });
  it("needs a code owner where the repository names one", () => {
    expect(refused({ codeOwners: new Map([["app#7", { ok: false, owners: "@acme/pay" } as never]]) })).toBe(M.needsCodeOwner("@acme/pay"));
    expect(refused({ codeOwners: new Map([["app#7", { ok: false, unreadable: true } as never]]) })).toBe(M.codeOwnersUnreadable);
  });
  it("cuts a long refusal at the view's bound without splitting a surrogate pair", () => {
    const view = mergeViewFromReadiness({ ready: false, message: `${"x".repeat(498)}\u{1F600}\u{1F600}` });
    expect(view.message!.length).toBeLessThanOrEqual(500);
    expect(view.message!.endsWith("…")).toBe(true);
    expect(mergeViewFromReadiness({ ready: true })).toEqual({ ready: true });
  });
});

describe("the branch, the head and the risk", () => {
  it("reads conflicted, behind, up to date and unknown", () => {
    expect(readBranch(status({ mergeable: false }))).toBe("conflicted");
    expect(readBranch(status({ mergeableState: "conflicted" }))).toBe("conflicted");
    expect(readBranch(status({ mergeableState: "behind" }))).toBe("behind");
    expect(readBranch(status({ mergeableState: "unknown" }))).toBe("unknown");
    expect(readBranch(status({ behindBy: 2 }))).toBe("behind");
    expect(readBranch(status({ behindBy: 0 }))).toBe("up_to_date");
  });
  it("calls a head Rovara's when it recorded it, keeps the prior reading while its own push is pending, and is false for a head that is neither", () => {
    expect(readHeadByRovara({ prior: false, head: HEAD, recorded: [HEAD], pushPending: false })).toBe(true);
    expect(readHeadByRovara({ prior: false, head: HEAD, recorded: [OLD], pushPending: true })).toBe(false);
    expect(readHeadByRovara({ prior: undefined, head: HEAD, recorded: [OLD], pushPending: true })).toBe(true);
    expect(readHeadByRovara({ prior: true, head: HEAD, recorded: [OLD], pushPending: false })).toBe(false);
  });
  it("tracks only a version 1.1.0 task with a pull request that is not finished", () => {
    const wf = (over: Record<string, unknown>) => ({ definitionVersion: "1.1.0", stage: "WAIT_FOR_MERGE", pullRequests: [{}], ...over }) as never;
    expect(tracksMerge(wf({}))).toBe(true);
    expect(tracksMerge(wf({ definitionVersion: "1.0.0" }))).toBe(false);
    expect(tracksMerge(wf({ stage: "MERGED" }))).toBe(false);
    expect(tracksMerge(wf({ pullRequests: [] }))).toBe(false);
    expect(tracksMerge(undefined)).toBe(false);
  });
  it("raises the risk to medium when none was judged, when it was judged for other code, or when someone else pushed", () => {
    const item = (headByRovara: boolean) => [{ headByRovara }];
    const wf = { risk: { level: "low", reasons: ["small"], candidateDigest: "c" }, candidate: { digest: "c" } } as never;
    expect(riskOfTask(undefined, item(true)).level).toBe("medium");
    expect(riskOfTask(wf, item(true))).toEqual({ level: "low", reasons: ["small"] });
    expect(riskOfTask({ ...(wf as object), candidate: { digest: "d" } } as never, item(true)).level).toBe("medium");
    expect(riskOfTask(wf, item(false)).level).toBe("medium");
    expect(riskOfTask({ risk: { level: "high", reasons: ["auth"], candidateDigest: "c" } } as never, item(false)).level).toBe("high");
  });
});

// A tracking item type check: the exported shape is what Cloud stores.
const _shape: Pick<MergeTrackingItem, "version"> = { version: 1 };
void _shape;
