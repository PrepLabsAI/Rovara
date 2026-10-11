// The journey invariant checker can fail: each hand-built bad journey breaks one invariant and must be refused with that
// invariant's name, while the good journey they are built from passes.
import { describe, expect, it } from "vitest";
import { workflowMessage, workflowMessageKey } from "../../packages/broker/src/developer/workflow-messages.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { JourneyInvariantError, assertJourneyInvariants, type JourneyLedgerEntry, type JourneyView } from "../support/workflow-e2e-invariants.js";

const TASK = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const THREAD = "1695500000.000001";
const TREE = "a".repeat(40);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const FIX = "d".repeat(40);
const FIX_TREE = "e".repeat(40);
const DIGEST = "f".repeat(64);
const OWNER = { actorId: "a".repeat(64), actorRole: "TASK_OWNER" as const };

/** A Quick task waiting for its draft pull request's merge, after one approved PR feedback fix. */
const AT = "2026-10-11T00:00:00.000Z";
const CANDIDATE = createCandidateManifest([{ repositoryId: "demo", commitSha: FIX, treeSha: FIX_TREE, baseCommitSha: BASE }]);
const FIRST = createCandidateManifest([{ repositoryId: "demo", commitSha: BASE, treeSha: TREE, baseCommitSha: BASE }]);
const REVIEW_URL_BASE = "https://agentx.example.test";
const PLAN_DIGEST = "c".repeat(64);
/** The workflow as it stood when `candidate` was pushed: checked and reviewed on exactly that code. */
function pushedWorkflow(candidate = CANDIDATE): WorkflowSnapshot {
  const workflow = waitingWorkflow();
  return WorkflowSnapshotSchema.parse({ ...workflow, stage: "PULL_REQUEST", state: "RUNNING", candidate,
    verification: { ...workflow.verification!, candidateDigest: candidate.digest },
    reviews: workflow.reviews!.map((review) => ({ ...review, candidateDigest: candidate.digest })) });
}
function waitingWorkflow(): WorkflowSnapshot {
  const base = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: AT });
  return WorkflowSnapshotSchema.parse({
    ...base, revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING",
    artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: AT }],
    candidate: CANDIDATE,
    verification: { candidateDigest: CANDIDATE.digest, producer: "t", environmentId: "w", recordedAt: AT, results: [{ checkId: "required-1", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: CANDIDATE.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: AT })),
    decisions: [{ requestId: "11111111-1111-4111-8111-111111111111", workflowRevision: 2, decision: "APPROVE", ...OWNER, reason: "Approved in Slack", artifactDigest: PLAN_DIGEST, at: AT }],
    feedbackDecisions: [{ schemaVersion: 1, requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 7, decision: "APPROVE", ...OWNER,
      reviewDigest: DIGEST, proposalDigest: DIGEST, bundleDigests: [DIGEST], selectedFindingIds: ["finding-1"], selectedCommentIds: ["discussion:1"],
      candidates: [{ repositoryId: "demo", number: 1, headSha: HEAD, candidateDigest: DIGEST, commentSetDigest: DIGEST, bundleDigest: DIGEST }], at: AT }],
    pullRequests: [{ repositoryId: "demo", number: 1, url: "https://github.com/example/demo/pull/1", headSha: FIX, candidateDigest: CANDIDATE.digest, required: true, state: "OPEN" }],
  });
}

/** The message the notifier posts for `workflow`, as Slack received it in the thread. */
function said(workflow: WorkflowSnapshot, ts: string): { channel: string; ts: string; threadTs: string; text: string; blocks: unknown[]; method: string } {
  const page = `${REVIEW_URL_BASE}/review/${TASK}/task`;
  const message = workflowMessage({ taskId: TASK, workflow, findingsUrl: `${page}#findings`, taskPageUrl: page, newReplies: 0 })!;
  return { method: "chat.postMessage", channel: "C1", ts, threadTs: THREAD, text: message.text, blocks: message.blocks };
}

type Decided = JourneyLedgerEntry["decided"];
function goodJourney(): JourneyView & { db: FakeDynamoDb; ledger: JourneyLedgerEntry[] } {
  const db = new FakeDynamoDb();
  const workflow = waitingWorkflow();
  db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, share: { threadTs: THREAD }, workflow });
  db.set({ pk: `DEVTASK#${TASK}`, sk: `NOTICE#${TASK}:said:${workflowMessageKey(workflow)}`, deliveredAt: workflow.updatedAt });
  const none: Decided = { decisions: [], feedbackDecisions: [], artifacts: workflow.artifacts };
  const approved: Decided = { ...none, decisions: workflow.decisions };
  const fixApproved: Decided = { ...approved, feedbackDecisions: workflow.feedbackDecisions };
  const posts = [{ channel: "C1", ts: THREAD, text: "Working on it." }, said(workflow, "2")];
  const tokens = new Map<string, "clone" | "push">([["ghs_clone", "clone"], ["ghs_push_1", "push"], ["ghs_push_2", "push"]]);
  return {
    db,
    invocations: [{ kind: "task", operationId: "op-plan", payload: { workflowMode: "PLAN" } }, { kind: "task", operationId: "op-code", payload: { workflowMode: "IMPLEMENT" } }],
    ledger: [
      { operationId: "op-plan", kind: "task", mode: "PLAN", decided: none },
      { operationId: "op-code", kind: "task", mode: "IMPLEMENT", decided: approved },
      { operationId: "op-publish", kind: "publish", decided: approved },
      { operationId: "op-fix", kind: "task", mode: "IMPLEMENT", decided: fixApproved },
      { operationId: "op-push", kind: "maintain", decided: fixApproved },
    ],
    reviewedTrees: [TREE, FIX_TREE],
    checkRuns: [{ tree: TREE }, { tree: FIX_TREE }],
    credentialAttempts: [{ during: "prepare", status: 200 }, { during: "task", status: 403 }],
    pushedWorkflows: [{ commit: HEAD, workflow: pushedWorkflow(FIRST) }, { commit: FIX, workflow: pushedWorkflow() }],
    reviewUrlBase: REVIEW_URL_BASE,
    github: {
      tokens,
      minted: [{ token: "ghs_clone", access: "clone", during: "prepare" }, { token: "ghs_push_1", access: "push", during: "publish" }, { token: "ghs_push_2", access: "push", during: "maintain" }],
      pushLog: [
        { branch: "agentx/x", commit: HEAD, tree: TREE, parents: [BASE], token: "ghs_push_1", during: "publish" },
        { branch: "agentx/x", commit: FIX, tree: FIX_TREE, parents: [HEAD], token: "ghs_push_2", during: "maintain" },
      ],
      pullRequests: [{ number: 1, headBranch: "agentx/x" }],
    },
    slack: { posts, updates: [], timeline: posts.map((post) => ({ method: "chat.postMessage", ...post })) },
    briefLimit: 1_200,
  };
}

function violations(journey: JourneyView, options: { logs?: string[] } = {}): string[] {
  try {
    assertJourneyInvariants(journey, options);
    return [];
  } catch (error) {
    if (!(error instanceof JourneyInvariantError)) throw error;
    return error.violations;
  }
}

describe("assertJourneyInvariants", () => {
  it("passes a good journey", () => {
    expect(violations(goodJourney())).toEqual([]);
  });

  it("INV-STATE: a workflow that does not parse", () => {
    const journey = goodJourney();
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: { ...waitingWorkflow(), stage: "NOWHERE" } });
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-STATE: /)]);
  });

  it("INV-CLICK: a coding run with no owner click since the last one", () => {
    const journey = goodJourney();
    journey.ledger[3] = { ...journey.ledger[3]!, decided: journey.ledger[2]!.decided };
    journey.ledger[4] = { ...journey.ledger[4]!, decided: journey.ledger[2]!.decided };
    expect(violations(journey).filter((violation) => violation.startsWith("INV-CLICK"))).toEqual([
      expect.stringMatching(/coding run op-fix started with no owner decision/), expect.stringMatching(/fix push op-push started with no owner approval/),
    ]);
  });

  it("INV-CLICK: a decision that authorises no code (requesting plan changes, approving the requirements) is not a click for coding", () => {
    const journey = goodJourney();
    const workflow = waitingWorkflow();
    const requirements = { ...workflow.artifacts[0]!, id: "requirements-v1", type: "requirements" as const, sha256: "9".repeat(64) };
    const changes = { ...workflow.decisions[0]!, decision: "REQUEST_CHANGES" as const };
    const requirementsApproved = { ...workflow.decisions[0]!, artifactDigest: requirements.sha256 };
    for (const decision of [changes, requirementsApproved]) {
      journey.ledger[1] = { ...journey.ledger[1]!, decided: { decisions: [decision], feedbackDecisions: [], artifacts: [...workflow.artifacts, requirements] } };
      expect(violations(journey)).toEqual([expect.stringMatching(/^INV-CLICK: coding run op-code started with no owner decision that authorises code/)]);
    }
    // Retry coding is the owner's own press.
    journey.ledger[1] = { ...journey.ledger[1]!, ownerRetry: true };
    expect(violations(journey)).toEqual([]);
  });

  it("INV-CLICK: a push token minted during a task run, or a task run with a grant or a credential", () => {
    const journey = goodJourney();
    journey.github = { ...journey.github, minted: [...journey.github.minted, { token: "ghs_push_3", access: "push", during: "task" }] };
    journey.invocations = [...journey.invocations, { kind: "task", operationId: "op-review", payload: { workflowMode: "REVIEW", repositoryGrant: "grant" } }];
    journey.credentialAttempts = [...journey.credentialAttempts, { during: "task", status: 200 }];
    expect(violations(journey)).toEqual([
      expect.stringMatching(/^INV-CLICK: a push token was minted during task/), expect.stringMatching(/^INV-CLICK: task run op-review was given a repository grant/),
      expect.stringMatching(/^INV-CLICK: a task run got a repository credential/),
    ]);
  });

  it("INV-CODE: a pushed tree that is not the task's current code, even if some review saw it", () => {
    const journey = goodJourney();
    journey.pushedWorkflows = [journey.pushedWorkflows[0]!, { commit: FIX, workflow: pushedWorkflow(FIRST) }];
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-CODE: AgentX pushed d{40} \(tree e{40}\) to agentx\/x, which is not the task's current code/)]);
  });

  it("INV-CODE: pushed code whose review did not pass, whose review is of other code, or whose checks are of other code", () => {
    const failedReview = pushedWorkflow();
    failedReview.reviews = failedReview.reviews!.map((review) => (review.role === "SECURITY" ? { ...review, status: "FAILED" as const } : review));
    const otherReview = pushedWorkflow();
    otherReview.reviews = otherReview.reviews!.map((review) => (review.role === "CRITIC" ? { ...review, candidateDigest: FIRST.digest } : review));
    const otherChecks = pushedWorkflow();
    otherChecks.verification = { ...otherChecks.verification!, candidateDigest: FIRST.digest };
    const open = pushedWorkflow();
    open.reviews = open.reviews!.map((review) => (review.role === "CRITIC" ? { ...review, status: "FINDINGS" as const, findings: [{ text: "greet drops a letter.", origin: "INTRODUCED" as const }] } : review));
    const expected = [/its security review did not finish/, /no code review was bound to that code/, /the checks were not recorded on that code/, /review findings on it were still open/];
    for (const [index, workflow] of [failedReview, otherReview, otherChecks, open].entries()) {
      const journey = goodJourney();
      journey.pushedWorkflows = [journey.pushedWorkflows[0]!, { commit: FIX, workflow }];
      expect(violations(journey)).toEqual([expect.stringMatching(expected[index]!)]);
    }
  });

  it("INV-CODE: two pull requests for one task in one repository, from different branches", () => {
    const journey = goodJourney();
    const workflow = waitingWorkflow();
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: { ...workflow, pullRequests: [...workflow.pullRequests!, { ...workflow.pullRequests![0]!, number: 2, url: "https://github.com/example/demo/pull/2", required: false }] } });
    expect(violations(journey).filter((violation) => violation.startsWith("INV-CODE"))).toEqual([expect.stringMatching(/^INV-CODE: task .* has 2 pull requests in demo/)]);
  });

  it("INV-CODE: two pull requests on GitHub for one task, from two of its branches; one the product closed is allowed", () => {
    const journey = goodJourney();
    const second = "8".repeat(40);
    journey.github = { ...journey.github,
      pushLog: [...journey.github.pushLog, { branch: "agentx/y", commit: second, tree: TREE, parents: [BASE], token: "ghs_push_1", during: "publish" }],
      pullRequests: [...journey.github.pullRequests, { number: 2, headBranch: "agentx/y", state: "open" }] };
    journey.pushedWorkflows = [...journey.pushedWorkflows, { commit: second, workflow: pushedWorkflow(FIRST) }];
    expect(violations(journey).filter((violation) => violation.startsWith("INV-CODE"))).toEqual([expect.stringMatching(/^INV-CODE: task .* has 2 pull requests on GitHub \(#1, #2\)/)]);
    journey.github = { ...journey.github, pullRequests: [journey.github.pullRequests[0]!, { number: 2, headBranch: "agentx/y", state: "closed" }] };
    expect(violations(journey).filter((violation) => violation.startsWith("INV-CODE"))).toEqual([]);
  });

  it("INV-CODE: reviewed code that was not checked, a fix that is not a fast-forward, and two pull requests from one branch", () => {
    const journey = goodJourney();
    journey.checkRuns = [{ tree: TREE }];
    journey.github = { ...journey.github,
      pushLog: [journey.github.pushLog[0]!, { ...journey.github.pushLog[1]!, parents: [BASE] }],
      pullRequests: [...journey.github.pullRequests, { number: 2, headBranch: "agentx/x" }] };
    expect(violations(journey)).toEqual([
      expect.stringMatching(/^INV-CODE: a review run was given tree e{40}, on which no check ran/),
      expect.stringMatching(/^INV-CODE: the fix push d{40} to agentx\/x is not a fast-forward/),
      expect.stringMatching(/^INV-CODE: branch agentx\/x has more than one pull request/),
      expect.stringMatching(/^INV-CODE: task .* has 2 pull requests on GitHub \(#1, #2\)/),
    ]);
  });

  it("INV-VOICE: a BLOCKED task whose thread has no message for it", () => {
    const journey = goodJourney();
    const blocked = WorkflowSnapshotSchema.parse({ ...waitingWorkflow(), revision: 10, state: "BLOCKED", blockReason: "I couldn't push the fix to the pull request." });
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: blocked });
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-VOICE: task .* is WAIT_FOR_MERGE\/BLOCKED \(revision 10\), and the newest workflow message in its thread is not the message for that/)]);
  });

  it("INV-VOICE: the product's own delivered marker is not enough: the thread's newest message must be the current one", () => {
    const journey = goodJourney();
    const blocked = WorkflowSnapshotSchema.parse({ ...waitingWorkflow(), revision: 10, state: "BLOCKED", blockReason: "I couldn't push the fix to the pull request." });
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: blocked });
    journey.db.set({ pk: `DEVTASK#${TASK}`, sk: `NOTICE#${TASK}:said:${workflowMessageKey(blocked)}`, deliveredAt: blocked.updatedAt });
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-VOICE: task .* is WAIT_FOR_MERGE\/BLOCKED/)]);
    // Said, then followed by an older step's message: still not where things stand.
    const current = said(blocked, "3");
    const stale = said(waitingWorkflow(), "4");
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, current, stale], timeline: [...journey.slack.timeline, current, stale] };
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-VOICE: task .* is WAIT_FOR_MERGE\/BLOCKED/)]);
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts.slice(0, -1)], timeline: [...journey.slack.timeline.slice(0, -1)] };
    expect(violations(journey)).toEqual([]);
  });

  it("INV-VOICE: a failed feedback review with no Retry review card", () => {
    const journey = goodJourney();
    const failed = { ...waitingWorkflow(), feedbackReview: { status: "PENDING", bundleRefs: [], reviewRef: { status: "FAILED" } } } as unknown as WorkflowSnapshot;
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: failed });
    expect(violations(journey).filter((violation) => violation.startsWith("INV-VOICE"))).toContainEqual(expect.stringMatching(/feedback review failed and its thread has no Retry review card/));
  });

  it("INV-VOICE: jargon, and a message past the brief limit", () => {
    const journey = goodJourney();
    const extra = [{ channel: "C1", ts: "3", threadTs: THREAD, text: "The implementation operation ended failed." }, { channel: "C1", ts: "4", threadTs: THREAD, text: "x".repeat(1_201) }];
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, ...extra], timeline: [...journey.slack.timeline, ...extra.map((post) => ({ method: "chat.postMessage", ...post }))] };
    expect(violations(journey)).toEqual([
      expect.stringMatching(/^INV-VOICE: a thread message uses "operation"/),
      expect.stringMatching(/^INV-VOICE: a thread message runs to 1201 characters, past the brief limit of 1200/),
    ]);
  });

  it("INV-VOICE: jargon and length in a message's blocks (a button, a section), and a status word only when shouted", () => {
    const journey = goodJourney();
    const card = { channel: "C1", ts: "3", threadTs: THREAD, text: "Coding stopped before it failed to finish.",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "y".repeat(1_190) } }, { type: "actions", elements: [{ type: "button", action_id: "x", text: { type: "plain_text", text: "Retry the operation" }, value: "{\"revision\":2}" }] }] };
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, card], timeline: [...journey.slack.timeline, { method: "chat.postMessage", ...card }] };
    expect(violations(journey).filter((violation) => !violation.includes("newest workflow message"))).toEqual([
      expect.stringMatching(/^INV-VOICE: a thread message uses "operation": Retry the operation/),
      expect.stringMatching(/^INV-VOICE: a thread message runs to \d+ characters, past the brief limit of 1200/),
    ]);
  });

  it("INV-VOICE: a Retry review card is a Retry review button, not a mention of its action", () => {
    const journey = goodJourney();
    const failed = { ...waitingWorkflow(), feedbackReview: { status: "PENDING", bundleRefs: [], reviewRef: { status: "FAILED" } } } as unknown as WorkflowSnapshot;
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: failed });
    const fake = { channel: "C1", ts: "3", threadTs: THREAD, text: "agentx_feedback_review_retry", blocks: [{ type: "section", text: { type: "mrkdwn", text: "\"action_id\":\"agentx_feedback_review_retry\"" } }] };
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, fake], timeline: [...journey.slack.timeline, { method: "chat.postMessage", ...fake }] };
    expect(violations(journey)).toContainEqual(expect.stringMatching(/feedback review failed and its thread has no Retry review card/));
  });

  it("INV-ONCE: one request recorded twice, more fix pushes than approvals, and one message posted twice in a row", () => {
    const journey = goodJourney();
    journey.github = { ...journey.github, pushLog: [...journey.github.pushLog, { branch: "agentx/x", commit: "9".repeat(40), tree: FIX_TREE, parents: [FIX], token: "ghs_push_2", during: "maintain" }] };
    journey.pushedWorkflows = [...journey.pushedWorkflows, { commit: "9".repeat(40), workflow: pushedWorkflow() }];
    const workflow = waitingWorkflow();
    const twice = { ...workflow, decisions: [workflow.decisions[0]!, { ...workflow.decisions[0]!, workflowRevision: 3 }] };
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: twice });
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, journey.slack.posts[1]!], timeline: [...journey.slack.timeline, journey.slack.timeline[1]!] };
    expect(violations(journey)).toEqual([
      expect.stringMatching(/^INV-ONCE: one request recorded more than one decision/),
      expect.stringMatching(/^INV-ONCE: 2 fix pushes for 1 approved fixes/),
      expect.stringMatching(/^INV-ONCE: the same message was posted twice in a row/),
    ]);
  });

  it("INV-ONCE: fix pushes are counted per task: another task's approved fix and push are not this task's", () => {
    const journey = goodJourney();
    const other = "7e1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const otherFix = "6".repeat(40);
    const otherWorkflow = WorkflowSnapshotSchema.parse({ ...waitingWorkflow(), taskId: other });
    journey.db.set({ pk: `DEVTASK#${other}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: other, workflow: otherWorkflow });
    journey.github = { ...journey.github, pushLog: [...journey.github.pushLog, { branch: "agentx/x", commit: otherFix, tree: FIX_TREE, parents: [FIX], token: "ghs_push_2", during: "maintain" }] };
    journey.pushedWorkflows = [...journey.pushedWorkflows, { commit: otherFix, workflow: WorkflowSnapshotSchema.parse({ ...pushedWorkflow(), taskId: other }) }];
    expect(violations(journey).filter((violation) => violation.startsWith("INV-ONCE"))).toEqual([]);
  });

  it("INV-DDB: a request DynamoDB refused, or a broker log line naming one", () => {
    const journey = goodJourney();
    void journey.db.send({ constructor: { name: "UpdateCommand" }, input: { TableName: "state", Key: { pk: "a", sk: "b" }, UpdateExpression: "SET x = :x", ExpressionAttributeValues: { ":x": 1, ":unused": 2 } } }).catch(() => undefined);
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(violations(journey, { logs: ['{"event":"x","error":"ValidationException"}'] })).toEqual([
        expect.stringMatching(/^INV-DDB: DynamoDB refused a UpdateCommand: Value provided in ExpressionAttributeValues unused/),
        expect.stringMatching(/^INV-DDB: a broker log line names a ValidationException/),
      ]);
    });
  });
});
