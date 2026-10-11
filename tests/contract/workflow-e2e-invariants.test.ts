// The journey invariant checker can fail: each hand-built bad journey breaks one invariant and must be refused with that
// invariant's name, while the good journey they are built from passes.
import { describe, expect, it } from "vitest";
import { workflowMessageKey } from "../../packages/broker/src/developer/workflow-messages.js";
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
function waitingWorkflow(): WorkflowSnapshot {
  const base = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: AT });
  return WorkflowSnapshotSchema.parse({
    ...base, revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING",
    artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: AT }],
    candidate: CANDIDATE,
    verification: { candidateDigest: CANDIDATE.digest, producer: "t", environmentId: "w", recordedAt: AT, results: [{ checkId: "required-1", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: CANDIDATE.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: AT })),
    decisions: [{ requestId: "11111111-1111-4111-8111-111111111111", workflowRevision: 2, decision: "APPROVE", ...OWNER, reason: "Approved in Slack", at: AT }],
    feedbackDecisions: [{ schemaVersion: 1, requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 7, decision: "APPROVE", ...OWNER,
      reviewDigest: DIGEST, proposalDigest: DIGEST, bundleDigests: [DIGEST], selectedFindingIds: ["finding-1"], selectedCommentIds: ["discussion:1"],
      candidates: [{ repositoryId: "demo", number: 1, headSha: HEAD, candidateDigest: DIGEST, commentSetDigest: DIGEST, bundleDigest: DIGEST }], at: AT }],
    pullRequests: [{ repositoryId: "demo", number: 1, url: "https://github.com/example/demo/pull/1", headSha: FIX, candidateDigest: CANDIDATE.digest, required: true, state: "OPEN" }],
  });
}

function goodJourney(): JourneyView & { db: FakeDynamoDb; ledger: JourneyLedgerEntry[] } {
  const db = new FakeDynamoDb();
  const workflow = waitingWorkflow();
  db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, share: { threadTs: THREAD }, workflow });
  db.set({ pk: `DEVTASK#${TASK}`, sk: `NOTICE#${TASK}:said:${workflowMessageKey(workflow)}`, deliveredAt: workflow.updatedAt });
  const tokens = new Map<string, "clone" | "push">([["ghs_clone", "clone"], ["ghs_push_1", "push"], ["ghs_push_2", "push"]]);
  return {
    db,
    invocations: [{ kind: "task", operationId: "op-plan", payload: { workflowMode: "PLAN" } }, { kind: "task", operationId: "op-code", payload: { workflowMode: "IMPLEMENT" } }],
    ledger: [
      { operationId: "op-plan", kind: "task", mode: "PLAN", ownerDecisions: 0, feedbackApprovals: 0 },
      { operationId: "op-code", kind: "task", mode: "IMPLEMENT", ownerDecisions: 1, feedbackApprovals: 0 },
      { operationId: "op-publish", kind: "publish", ownerDecisions: 1, feedbackApprovals: 0 },
      { operationId: "op-fix", kind: "task", mode: "IMPLEMENT", ownerDecisions: 1, feedbackApprovals: 1 },
      { operationId: "op-push", kind: "maintain", ownerDecisions: 1, feedbackApprovals: 1 },
    ],
    reviewedTrees: [TREE, FIX_TREE],
    checkRuns: [{ tree: TREE }, { tree: FIX_TREE }],
    credentialAttempts: [{ during: "prepare", status: 200 }, { during: "task", status: 403 }],
    github: {
      tokens,
      minted: [{ token: "ghs_clone", access: "clone", during: "prepare" }, { token: "ghs_push_1", access: "push", during: "publish" }, { token: "ghs_push_2", access: "push", during: "maintain" }],
      pushLog: [
        { branch: "agentx/x", commit: HEAD, tree: TREE, parents: [BASE], token: "ghs_push_1", during: "publish" },
        { branch: "agentx/x", commit: FIX, tree: FIX_TREE, parents: [HEAD], token: "ghs_push_2", during: "maintain" },
      ],
      pullRequests: [{ number: 1, headBranch: "agentx/x" }],
    },
    slack: { posts: [{ channel: "C1", ts: THREAD, text: "Working on it." }, { channel: "C1", ts: "2", threadTs: THREAD, text: "Pushed the fix to PR #1." }], updates: [] },
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
    journey.ledger[3] = { ...journey.ledger[3]!, feedbackApprovals: 0 };
    journey.ledger[4] = { ...journey.ledger[4]!, feedbackApprovals: 0 };
    expect(violations(journey).filter((violation) => violation.startsWith("INV-CLICK"))).toEqual([
      expect.stringMatching(/coding run op-fix started with no owner decision/), expect.stringMatching(/fix push op-push started with no owner approval/),
    ]);
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

  it("INV-CODE: a pushed tree that is not the reviewed tree", () => {
    const journey = goodJourney();
    journey.reviewedTrees = [TREE];
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-CODE: AgentX pushed tree e{40}/)]);
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
    ]);
  });

  it("INV-VOICE: a BLOCKED task whose thread has no message for it", () => {
    const journey = goodJourney();
    const blocked = WorkflowSnapshotSchema.parse({ ...waitingWorkflow(), revision: 10, state: "BLOCKED", blockReason: "I couldn't push the fix to the pull request." });
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: blocked });
    expect(violations(journey)).toEqual([expect.stringMatching(/^INV-VOICE: task .* is WAIT_FOR_MERGE\/BLOCKED, and its thread has no message for that \(revision:10\)/)]);
  });

  it("INV-VOICE: a failed feedback review with no Retry review card", () => {
    const journey = goodJourney();
    const failed = { ...waitingWorkflow(), feedbackReview: { status: "PENDING", bundleRefs: [], reviewRef: { status: "FAILED" } } } as unknown as WorkflowSnapshot;
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: failed });
    expect(violations(journey).filter((violation) => violation.startsWith("INV-VOICE"))).toContainEqual(expect.stringMatching(/feedback review failed and its thread has no Retry review card/));
  });

  it("INV-VOICE: jargon, and a message past the brief limit", () => {
    const journey = goodJourney();
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, { channel: "C1", ts: "3", threadTs: THREAD, text: "The implementation operation ended failed." },
      { channel: "C1", ts: "4", threadTs: THREAD, text: "x".repeat(1_201) }] };
    expect(violations(journey)).toEqual([
      expect.stringMatching(/^INV-VOICE: a thread message uses "operation"/),
      expect.stringMatching(/^INV-VOICE: a thread message runs to 1201 characters, past the brief limit of 1200/),
    ]);
  });

  it("INV-ONCE: one request recorded twice, more fix pushes than approvals, and one message posted twice in a row", () => {
    const journey = goodJourney();
    journey.github = { ...journey.github, pushLog: [...journey.github.pushLog, { branch: "agentx/x", commit: "9".repeat(40), tree: FIX_TREE, parents: [FIX], token: "ghs_push_2", during: "maintain" }] };
    const workflow = waitingWorkflow();
    const twice = { ...workflow, decisions: [workflow.decisions[0]!, { ...workflow.decisions[0]!, workflowRevision: 3 }] };
    journey.db.set({ ...journey.db.get(`DEVTASK#${TASK}`, "META")!, workflow: twice });
    journey.slack = { ...journey.slack, posts: [...journey.slack.posts, journey.slack.posts[1]!] };
    expect(violations(journey)).toEqual([
      expect.stringMatching(/^INV-ONCE: one request recorded more than one decision/),
      expect.stringMatching(/^INV-ONCE: 2 fix pushes for 1 approved fixes/),
      expect.stringMatching(/^INV-ONCE: the same message was posted twice in a row/),
    ]);
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
