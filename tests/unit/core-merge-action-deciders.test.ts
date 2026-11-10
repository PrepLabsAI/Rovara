// The three deciders this lane fills into merge tracking's slots (conflict, ci_fix, sync), over plain inputs: what each hands back is data (the next workflow, the rows it owns, the dispatch it is due for and
// the milestones), committed by the tracking pass (lane L7a) with the task-flow core's dispatch row (L6a) and the notifications module's milestone rows (L6b).
import { describe, expect, it } from "vitest";
import {
  BRANCH_SYNCS_PER_DAY_MAX, CI_FAILED_JOBS_MAX, CI_FIX_ROUNDS_MAX, CI_OUTPUT_BLOCK_HEADER, WorkflowSnapshotSchema, branchConflictAskMessage, branchConflictStopMessage, ciFixAskMessage, ciFixStopMessage,
  createCandidateManifest, createWorkflowSnapshot, startWorkflowFix, type Autonomy, type MergeTrackingItem, type OrgId, type WorkflowProgram, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { conflictDecider, installBranchSyncDeciders, syncDecider, uninstallBranchSyncDeciders } from "../../packages/broker/src/core/branch-sync/branch-sync.js";
import { ciFixDecider, installCiFixDecider, readCiEvidence, readLatestCiEvidence, uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, type MergeActionContext, type MergeActionDecider, type MergeActionInput, type MergeActionRequest, type MergeActionSlot } from "../../packages/broker/src/core/branch-sync/merge-action.js";

const at = "2026-10-25T12:00:00.000Z";
const NOW = Date.parse(at);
const TASK = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TASK = "00000000-0000-4000-8000-0000000000b2";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const HEAD_A = "a".repeat(40);
const OWNER = "a".repeat(64);
const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const PULL_REQUEST = { repositoryId: "payments", number: 7, headSha: HEAD_A, candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/acme/payments/pull/7" };

function waiting(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK, ownerId: OWNER, now: at, definitionVersion: "1.1.0", program: PROGRAM }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: [PULL_REQUEST], ...extra,
  });
}

const item = (overrides: Partial<MergeTrackingItem> = {}): MergeTrackingItem => ({
  orgId: ORG, taskId: TASK, repositoryId: "payments", number: 7, version: 1, headSha: HEAD_A, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true,
  failingChecks: [], review: "approved", approval: { hostUserId: "1", login: "maint", commitId: HEAD_A }, branch: "behind", headByRovara: true, nudges: { count: 0 },
  syncs: { day: "2026-10-25", count: 0 }, decisionDigest: "d".repeat(64), observedAt: at, ...overrides,
});

const context = (overrides: Partial<MergeActionContext> = {}): MergeActionContext => ({
  orgId: ORG, taskId: TASK, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", repositoryId: "payments", pullRequestNumber: 7, pullRequestUrl: PULL_REQUEST.url, headSha: HEAD_A, failing: [], behindRequired: true, ...overrides,
});
const input = (overrides: Partial<MergeActionInput> & { itemOverrides?: Partial<MergeTrackingItem>; ctx?: Partial<MergeActionContext> } = {}): MergeActionInput => ({
  item: item(overrides.itemOverrides), workflow: overrides.workflow ?? waiting(), autonomy: overrides.autonomy ?? "prepare", now: NOW, context: context(overrides.ctx), ...("context" in overrides ? { context: overrides.context } : {}),
});

describe("the sync slot", () => {
  it("queues the merge of the base into a behind branch with a counted approval: the workflow, the SYNC dispatch for it and the day's count one more; no row of its own", () => {
    const request = syncDecider(input())!;
    expect(request).toMatchObject({ slot: "sync", steps: [], milestones: [], syncs: { day: "2026-10-25", count: 1 } });
    expect(request.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "READY", branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } });
    expect(request.dispatch).toEqual({ kind: "SYNC", workflowRevision: request.workflow.revision, candidateDigest: candidate.digest, at });
  });

  it("does nothing without an approval, with a base that does not require it, when the day's merges are used up, or with the agent set to suggest", () => {
    expect(syncDecider(input({ itemOverrides: { review: "requested", approval: undefined } }))).toBeUndefined();
    expect(syncDecider(input({ ctx: { behindRequired: false } }))).toBeUndefined();
    expect(syncDecider(input({ itemOverrides: { syncs: { day: "2026-10-25", count: BRANCH_SYNCS_PER_DAY_MAX } } }))).toBeUndefined();
    expect(syncDecider(input({ autonomy: "suggest" }))).toBeUndefined();
    expect(syncDecider(input({ context: undefined }))).toBeUndefined();
  });

  it("waits for a head the workflow has not recorded yet, and uses no merge of the day on it", () => {
    expect(syncDecider(input({ ctx: { headSha: "c".repeat(40) } }))).toBeUndefined();
  });

  it("does not start while another action holds the task, or a merge is under way", () => {
    const busy = syncDecider(input())!.workflow;
    expect(syncDecider(input({ workflow: busy }))).toBeUndefined();
  });

  it("does not try a head the merge gave up on, nor one whose last failure's delay is not over; a new head starts from none", () => {
    const gaveUp = waiting({ syncFailures: { headSha: HEAD_A, count: 2 } });
    expect(syncDecider(input({ workflow: gaveUp }))).toBeUndefined();
    const delayed = waiting({ syncFailures: { headSha: HEAD_A, count: 1, retryAfter: new Date(NOW + 60_000).toISOString() } });
    expect(syncDecider(input({ workflow: delayed }))).toBeUndefined();
    const over = waiting({ syncFailures: { headSha: HEAD_A, count: 1, retryAfter: new Date(NOW - 1).toISOString() } });
    expect(syncDecider(input({ workflow: over }))).toBeDefined();
    expect(syncDecider(input({ workflow: waiting({ syncFailures: { headSha: "9".repeat(40), count: 2 } }) }))).toBeDefined();
  });
});

describe("the conflict slot", () => {
  const conflicted = { branch: "conflicted" as const, review: "requested" as const, approval: undefined };

  it("tries the merge on a conflicted branch whether or not it is approved: the workflow queues it for a conflict", () => {
    const request = conflictDecider(input({ itemOverrides: conflicted }))!;
    expect(request).toMatchObject({ slot: "conflict", steps: [], milestones: [], dispatch: { kind: "SYNC" } });
    expect(request.workflow.branchSync?.reason).toBe("conflict");
  });

  it("two conflict rounds that did not help stop with the exact text and a stuck milestone, and start no machine", () => {
    const used = waiting({ fixRounds: { ci: 0, conflict: 2, feedbackAuto: 0 } });
    const request = conflictDecider(input({ itemOverrides: { ...conflicted, syncs: { day: "2026-10-25", count: BRANCH_SYNCS_PER_DAY_MAX } }, workflow: used }))!;
    expect(request.dispatch).toBeUndefined();
    expect(request.syncs).toBeUndefined();
    expect(request.workflow).toMatchObject({ state: "BLOCKED", blockReason: branchConflictStopMessage("main") });
    expect(request.milestones).toEqual([{ n: request.workflow.revision, milestone: { kind: "stuck", orgId: ORG, taskId: TASK, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", at, text: branchConflictStopMessage("main"), pullRequests: [{ repository: "payments", number: 7, url: PULL_REQUEST.url }] } }]);
  });

  it("with the agent set to suggest, a conflict is asked about before any machine or paid round; a go-ahead for this head lets it go on", () => {
    const asked = conflictDecider(input({ itemOverrides: conflicted, autonomy: "suggest" }))!;
    expect(asked.workflow).toMatchObject({ state: "BLOCKED", blockReason: branchConflictAskMessage("main") });
    expect(asked.dispatch).toBeUndefined();
    const approved = conflictDecider(input({ itemOverrides: conflicted, autonomy: "suggest", workflow: waiting({ conflictApproved: [HEAD_A] }) }))!;
    expect(approved.dispatch).toMatchObject({ kind: "SYNC" });
  });

  it("waits when the day's merges are used up, and is not stopped for it", () => {
    expect(conflictDecider(input({ itemOverrides: { ...conflicted, syncs: { day: "2026-10-25", count: BRANCH_SYNCS_PER_DAY_MAX } } }))).toBeUndefined();
  });
});

describe("the CI slot", () => {
  const failing = { branch: "up_to_date" as const, ci: "failing" as const, failingChecks: ["test"] };
  const check = { name: "test", conclusion: "failure", url: "https://github.com/acme/payments/actions/runs/1/job/4242", jobId: "4242", source: "15368", logReadable: true };

  it("starts one round: the counted workflow, the block of what CI said as a row of its own, the coding run's dispatch and a 'fixing' milestone", async () => {
    const read: string[] = [];
    const request = (await ciFixDecider(input({ itemOverrides: failing, ctx: { failing: [check], readJobLog: async (jobId) => { read.push(jobId); return "FAIL src/retry.test.ts\nExpected 3 got 2"; } } })))!;
    expect(read).toEqual(["4242"]);
    expect(request.slot).toBe("ci_fix");
    expect(request.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "ci", fixRounds: { ci: 1 } });
    expect(request.dispatch).toEqual({ kind: "IMPLEMENT", workflowRevision: request.workflow.revision, candidateDigest: candidate.digest, at });
    expect(request.milestones[0]).toMatchObject({ n: request.workflow.revision, milestone: { kind: "fixing", text: `CI is failing on test, so Rovara is fixing it (round 1 of ${String(CI_FIX_ROUNDS_MAX)}).` } });
    expect(request.steps).toHaveLength(1);
    expect(request.steps[0]).toMatchObject({ kind: "put", condition: { op: "notExists" }, item: { pk: `DEVTASK#${TASK}`, sk: `CI_EVIDENCE#${String(request.workflow.revision).padStart(9, "0")}`, entityType: "CI_EVIDENCE", orgId: ORG, taskId: TASK } });
  });

  it("keeps the block until the fix starts: written in the pass's transaction, read back for its task and company only, and only as a CI block", async () => {
    const store = new MemoryDocumentStore();
    const request = (await ciFixDecider(input({ itemOverrides: failing, ctx: { failing: [check], readJobLog: async () => "boom" } })))!;
    expect(await store.transact(request.steps)).toEqual({ applied: true });
    const revision = request.workflow.revision;
    const block = await readCiEvidence(store, TASK, ORG, revision);
    expect(block?.startsWith(CI_OUTPUT_BLOCK_HEADER)).toBe(true);
    expect(block).toContain("boom");
    expect(await readCiEvidence(store, TASK, "org_zzzzzzzzzzzzzzzzzzzz", revision)).toBeUndefined();
    expect(await readCiEvidence(store, TASK, ORG, revision + 1)).toBeUndefined();
    expect(await readCiEvidence(store, OTHER_TASK, ORG, revision)).toBeUndefined();
    // A repeated pass cannot write a second block for the same revision.
    expect(await store.transact(request.steps)).toMatchObject({ applied: false, reason: "condition_failed" });
    expect(await readLatestCiEvidence(store, TASK, ORG)).toBe(block);
    expect(await readLatestCiEvidence(store, OTHER_TASK, ORG)).toBeUndefined();
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "CI_EVIDENCE#999999999", entityType: "CI_EVIDENCE", orgId: ORG, taskId: TASK, block: "not a block" } });
    expect(await readLatestCiEvidence(store, TASK, ORG)).toBeUndefined();
  });

  it("the newest round's block is the latest one", async () => {
    const store = new MemoryDocumentStore();
    const first = (await ciFixDecider(input({ itemOverrides: failing, ctx: { failing: [check], readJobLog: async () => "first" } })))!;
    await store.transact(first.steps);
    const later = startWorkflowFix(waiting(), { source: "ci", problems: ["test"], now: at });
    const second = (await ciFixDecider(input({ itemOverrides: failing, workflow: WorkflowSnapshotSchema.parse({ ...waiting(), revision: later.revision + 5 }), ctx: { failing: [check], readJobLog: async () => "second" } })))!;
    await store.transact(second.steps);
    expect(await readLatestCiEvidence(store, TASK, ORG)).toContain("second");
  });

  it("with the rounds used up it stops with the exact text and the first line of the failing log, and starts no machine; a person's go-ahead is one round more, not counted", async () => {
    const used = waiting({ fixRounds: { ci: CI_FIX_ROUNDS_MAX, conflict: 0, feedbackAuto: 0 } });
    const stopped = (await ciFixDecider(input({ itemOverrides: failing, workflow: used, ctx: { failing: [check], readJobLog: async () => "\nError: boom\nmore" } })))!;
    expect(stopped.workflow).toMatchObject({ state: "BLOCKED", blockReason: ciFixStopMessage("test", "Error: boom") });
    expect(stopped.dispatch).toBeUndefined();
    expect(stopped.steps).toEqual([]);
    const approvedRound = (await ciFixDecider(input({ itemOverrides: failing, workflow: waiting({ fixRounds: { ci: CI_FIX_ROUNDS_MAX, conflict: 0, feedbackAuto: 0 }, ciFixApproved: [HEAD_A] }), ctx: { failing: [check], readJobLog: async () => "x" } })))!;
    expect(approvedRound.workflow.fixRounds?.ci).toBe(CI_FIX_ROUNDS_MAX);
    expect(approvedRound.milestones[0]!.milestone.text).toContain("trying once more because you asked");
  });

  it("with the agent set to suggest it asks first: a block and a stuck milestone, no log read, no machine", async () => {
    const read: string[] = [];
    const asked = (await ciFixDecider(input({ itemOverrides: failing, autonomy: "suggest", ctx: { failing: [check], readJobLog: async (id) => { read.push(id); return "x"; } } })))!;
    expect(read).toEqual([]);
    expect(asked.workflow).toMatchObject({ state: "BLOCKED", blockReason: ciFixAskMessage("test") });
    expect(asked.dispatch).toBeUndefined();
    expect(asked.milestones[0]!.milestone.kind).toBe("stuck");
  });

  it("decides nothing when nothing fails, without a context, and does not swallow the pass's own limits", async () => {
    expect(await ciFixDecider(input({ itemOverrides: { ci: "passing" } }))).toBeUndefined();
    expect(await ciFixDecider(input({ itemOverrides: failing, context: undefined }))).toBeUndefined();
    const cap = Object.assign(new Error("cap"), { name: "TrackingRequestCapError" });
    await expect(ciFixDecider(input({ itemOverrides: failing, ctx: { failing: [check], readJobLog: async () => { throw cap; } } }))).rejects.toBe(cap);
  });

  it("tells and reads the logs of at most CI_FAILED_JOBS_MAX failing checks, and writes the block's expiry under the attribute the store sweeps", async () => {
    const many = Array.from({ length: 14 }, (_, index) => ({ ...check, name: `job ${String(index)}`, jobId: String(index) }));
    const read: string[] = [];
    const request = (await ciFixDecider(input({ itemOverrides: { ...failing, failingChecks: many.map((entry) => entry.name).slice(0, 10) }, ctx: { failing: many, readJobLog: async (id) => { read.push(id); return "x"; } } })))!;
    expect(read).toHaveLength(CI_FAILED_JOBS_MAX);
    const row = request.steps[0] as { item: Record<string, unknown> };
    expect(row.item["indexExpiresAt"]).toBeTypeOf("number");
    const custom = (await ciFixDecider(input({ itemOverrides: failing, ctx: { failing: [check], readJobLog: async () => "x", ttlAttribute: "expiresAt" } })))!.steps[0] as { item: Record<string, unknown> };
    expect(custom.item["expiresAt"]).toBeTypeOf("number");
    expect(custom.item["indexExpiresAt"]).toBeUndefined();
  });

  it("decides nothing for a head someone else pushed or a version 1 task's pull request that is not open (merge tracking does not call the slot; the slot itself refuses a closed one)", async () => {
    expect(await ciFixDecider(input({ itemOverrides: { ...failing, state: "closed", ci: "none", failingChecks: [] } }))).toBeUndefined();
  });

  it("uses the all-zero digest where the task has no candidate yet", () => {
    expect(WORKFLOW_NO_CANDIDATE_DIGEST).toBe("0".repeat(64));
  });
});

describe("filling the slots", () => {
  function registry() {
    const slots = new Map<MergeActionSlot, MergeActionDecider>();
    return { slots, register: (slot: MergeActionSlot, decide: MergeActionDecider) => { if (slots.has(slot)) throw new Error("taken"); slots.set(slot, decide); return () => { slots.delete(slot); }; } };
  }

  it("fills the conflict, ci_fix and sync slots once through the registry it is given, and gives them back", () => {
    const { slots, register } = registry();
    installBranchSyncDeciders(register);
    installBranchSyncDeciders(register);
    installCiFixDecider(register);
    installCiFixDecider(register);
    expect([...slots.keys()].sort()).toEqual(["ci_fix", "conflict", "sync"]);
    uninstallBranchSyncDeciders();
    uninstallCiFixDecider();
    expect(slots.size).toBe(0);
    installBranchSyncDeciders(register);
    expect(slots.size).toBe(2);
    uninstallBranchSyncDeciders();
  });

  it("a request the slots hand back is a plain MergeActionRequest", () => {
    const request: MergeActionRequest | undefined = syncDecider(input());
    expect(request?.slot).toBe("sync");
    const autonomy: Autonomy = "run";
    expect(syncDecider(input({ autonomy }))).toBeDefined();
  });
});
