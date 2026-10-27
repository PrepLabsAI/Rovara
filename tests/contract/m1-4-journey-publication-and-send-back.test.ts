import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { workflowSendBackOffered, type WorkflowSnapshot } from "@agentx/contracts";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import type { ObservedApiOutcome } from "../support/e2e-application-evidence-fixture.js";
import { MAYA } from "../support/developer-task-broker.js";
import { apiRowKey, startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";

// JOURNEY46 (M1.4 Task 4.4a review, m6), Docker-free. The agent journeys (agent-renamed-export, agent-wrong-action) end in two broker decisions that their own asserts never checked:
// a passing round leaves the final-effect checks publication will take (journey 32), and a failing round records its failed round so Send back is offered (journey 33).
// Here the real broker takes a round's worker evidence and decides; nothing below builds a workflow, a block reason or a check list by hand. Every expectation comes from the
// stores or fixtures (the project's rows, the runtime catalog key, the developer, the uploaded aggregate's digest), never from the broker's output being asserted.
// The evidence is the application harness's (an API case observed to answer 200, or 503 where the case asserts 200): the model-driven navigation itself needs the real executor image and
// stays in tests/e2e/m1-4-journeys.test.ts and tests/contract/workflow-e2e-agent-evidence.test.ts (Docker); the broker's decision after the evidence is what this file drives.

afterEach(async () => { await disposeRealCandidates(); });

const PASS = { kind: "http-status", status: 200 } as const satisfies ObservedApiOutcome;
const WRONG = { kind: "http-status", status: 503 } as const satisfies ObservedApiOutcome;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// The broker module reads its environment when it loads, so it is imported only once the harness (which sets that environment up) has started.
const brokerModule = () => import("../../packages/broker/src/aws/broker.js");
const operations = (round: ApplicationRound) => round.operationRows(() => true);
const publicationChecksOf = async (round: ApplicationRound) => (await brokerModule()).loadWorkflowE2EPublicationChecks(round.harness.brokerInput as never, round.taskNow() as never, operations(round));
const workflowOf = (round: ApplicationRound) => round.workflowNow() as unknown as WorkflowSnapshot;
type Failed = { status: string; candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string };
const e2eOf = (round: ApplicationRound) => round.workflowNow().e2e as { qualifiedRound?: unknown; failedRound?: Failed };

/** What the worker does for one round: every group's evidence, the aggregate, then the operation's terminal result. Returns the aggregate's digest as uploaded. */
async function runRound(round: ApplicationRound, outcome: ObservedApiOutcome): Promise<string> {
  const groups = [];
  for (const groupId of round.groupIds) groups.push(await round.collectGroup(groupId, outcome));
  round.markRunning();
  const runs: Record<string, unknown>[] = [];
  for (const group of groups) {
    const groupRun = clone(group.groupRun);
    runs.push(groupRun);
    const uploaded = await round.upload(round.groupEnvelope(groupRun), { groupRunId: group.runId });
    expect(uploaded.response.status, JSON.stringify(uploaded.response.body)).toBe(200);
  }
  const aggregate = await round.upload(round.aggregateEnvelope(runs));
  expect(aggregate.response.status, JSON.stringify(aggregate.response.body)).toBe(200);
  await round.finishChecks(aggregate.response.body as { key: string; sha256: string });
  return aggregate.digest;
}

/**
 * The harness's task selects no check of its own (a review-only task), and a review-only task is offered Send back for any block, whether or not a failed round was recorded. A project
 * with a required check is the usual one, and for it the recorded failed round is the only thing that offers Send back (this is the project's configuration, set after the round as the send-back suite does; it records no outcome).
 */
const CHECK_POLICY = { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] };
const withProjectCheck = (round: ApplicationRound) => {
  const task = round.taskNow() as { workflow: Record<string, unknown> };
  round.harness.db.set({ ...task, workflow: { ...task.workflow, checkPolicy: CHECK_POLICY } });
};

/** The final-effect fences the published change must still stand on, from the rows the round was admitted against (not from the broker's list). */
function expectedFenceKeys(round: ApplicationRound): { required: string[]; accountRows: string[] } {
  const projects = round.harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments") as Array<{ pk: string; sk: string; revision?: number }>;
  const latest = projects.reduce((best, row) => (row.sk > best.sk ? row : best));
  // The creator's authority (the Slack channel binding the task was started from) and the project's account row, as the store holds them.
  const channelBindings = round.harness.db.find((row) => String(row.pk).startsWith("SLACK_BINDING#") && row.projectName === "payments") as Array<{ pk: string; sk: string }>;
  const accounts = round.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#")) as Array<{ pk: string; sk: string }>;
  expect(channelBindings.length, "the fixture's creator has a channel binding").toBeGreaterThan(0);
  expect(accounts.length, "the fixture's project has an account row").toBeGreaterThan(0);
  const keys = [
    ...channelBindings.map((row) => ({ pk: row.pk, sk: row.sk })),
    { pk: "PROJECT_CATALOG", sk: "PROJECT#payments" },
    { pk: latest.pk, sk: latest.sk },
    { pk: `DEVELOPER#${MAYA.developerId}`, sk: "META" },
    { pk: apiRowKey.pk, sk: apiRowKey.sk },
  ];
  // The store holds a latest-row per account profile of the project; the round fences those of the accounts it was admitted on, so at least one of them must be in the list.
  return { required: keys.map((key) => `${key.pk}|${key.sk}`).sort(), accountRows: accounts.map((row) => `${row.pk}|${row.sk}`) };
}

describe("journey 32 (agent-renamed-export), the broker's side: a passing round leaves publication a real set of checks", () => {
  it("before the round has produced evidence there is nothing to publish on, then after it passes the broker's check list names the project, the policy revision, the creator (developer and channel binding), the account and the admitted runtime row, each of which exists", async () => {
    const round = await startApplicationRound();
    // Negative control: the same loader, before any evidence, gives nothing (a list that is always non-empty would pass the assert below for the wrong reason).
    expect(await publicationChecksOf(round)).toBeUndefined();
    expect(e2eOf(round).qualifiedRound).toBeUndefined();

    const evidenceSha256 = await runRound(round, PASS);
    expect(round.workflowNow(), JSON.stringify(round.workflowNow())).toMatchObject({ stage: "REVIEW" });
    expect(e2eOf(round).qualifiedRound).toMatchObject({ roundId: round.admissionRef.roundId, evidenceSha256 });

    const checks = await publicationChecksOf(round);
    expect(checks, "the broker offers publication the final-effect checks of the passing round").toBeDefined();
    expect(checks!.length).toBeGreaterThan(0);
    const fences = checks!.map((item) => (item as { ConditionCheck: { TableName: string; Key: { pk: string; sk: string }; ConditionExpression: string } }).ConditionCheck);
    // Every item is a condition check on the broker's table (a Put or Delete here would write something at the final effect).
    expect(fences).toHaveLength(checks!.length);
    for (const fence of fences) expect(fence.ConditionExpression.length).toBeGreaterThan(0);
    // The checks that matter are named: project catalog entry, the exact project revision, the creator and its channel binding, the account row, the runtime row. Every expected row is in the broker's list.
    const keys = fences.map((fence) => `${fence.Key.pk}|${fence.Key.sk}`);
    const expected = expectedFenceKeys(round);
    for (const key of expected.required) expect(keys, key).toContain(key);
    expect(keys.some((key) => expected.accountRows.includes(key)), "an account row of the project is fenced").toBe(true);
    // A fence on a row that does not exist could never be satisfied: every named row is really in the store the checks run against.
    for (const fence of fences) expect(round.harness.db.get(fence.Key.pk, fence.Key.sk), `${fence.Key.pk}|${fence.Key.sk}`).toBeDefined();
  });

  it("the checks are the passing round's and no one else's: a round that did not pass gives none, so the list is a consequence of the verdict", async () => {
    const passing = await startApplicationRound();
    await runRound(passing, PASS);
    expect((await publicationChecksOf(passing))?.length ?? 0).toBeGreaterThan(0);
    const failing = await startApplicationRound();
    await runRound(failing, WRONG);
    expect(await publicationChecksOf(failing)).toBeUndefined();
  });
});

describe("journey 33 (agent-wrong-action), the broker's side: a failing round is recorded and Send back is offered because of it", () => {
  it("records the failed round from the uploaded evidence, and the task offers Send back through the card and the route; the passing round before it did neither", async () => {
    const round = await startApplicationRound();
    // Before the round: no failed round, and nothing to send back.
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(workflowSendBackOffered(workflowOf(round))).toBe(false);

    const evidenceSha256 = await runRound(round, WRONG);
    withProjectCheck(round);
    // The broker, not the test, recorded the failure, bound to this round's admission, groups and the evidence the worker uploaded.
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(e2eOf(round).failedRound).toEqual({ status: "FAILED", candidateDigest: round.candidate.digest, roundId: round.admissionRef.roundId, groupRunIds: round.admissionRef.groupRunIds,
      admissionSha256: round.admissionRef.admissionRef.sha256, evidenceSha256 });
    expect(e2eOf(round).qualifiedRound).toBeUndefined();

    // Offered, on the stored state the broker wrote: in the rule, on the card the owner sees, and by the route that acts on it.
    expect(workflowSendBackOffered(workflowOf(round))).toBe(true);
    const buttons = workflowMessage({ taskId: round.taskId, workflow: workflowOf(round) })!.blocks.filter((block) => block.type === "actions")
      .flatMap((block) => (block.elements as Array<{ action_id: string }>).map((button) => button.action_id));
    expect(buttons).toContain("agentx_workflow_send_back");
    const before = round.workflowNow();
    const requestId = randomUUID();
    const sent = await round.harness.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/workflow/send-back`,
      { requestId, expectedRevision: before.revision, instructions: "Fix the problems listed above, then report what changed." });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(round.workflowNow()).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", revision: before.revision + 2 });
    // The failure is what the coder is told: the fixed sentence for a failed required check.
    const operation = round.operationRows((row) => row.requestId === requestId && row.workflowMode === "IMPLEMENT")[0]!;
    const outbox = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0];
    expect(String((outbox?.invocation as { payload: { prompt: string } }).payload.prompt)).toContain("required E2E verification failed for the current round");
  });

  it("is offered because of the recorded failed round: the same blocked task, with the broker's record of the failure taken out of the store, is not offered and the route refuses", async () => {
    const round = await startApplicationRound();
    await runRound(round, WRONG);
    withProjectCheck(round);
    expect(workflowSendBackOffered(workflowOf(round))).toBe(true);
    // Remove only the recorded failure (the block reason, stage and state stay exactly as the broker wrote them).
    const task = round.taskNow() as { workflow: { e2e: Record<string, unknown> } & Record<string, unknown> };
    const { failedRound: _failed, ...e2eWithoutFailure } = task.workflow.e2e;
    void _failed;
    round.harness.db.set({ ...task, workflow: { ...task.workflow, e2e: e2eWithoutFailure } });
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: "one or more admitted E2E groups failed" });
    expect(workflowSendBackOffered(workflowOf(round))).toBe(false);
    const refused = await round.harness.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/workflow/send-back`,
      { requestId: randomUUID(), expectedRevision: round.workflowNow().revision, instructions: "Fix the problems listed above, then report what changed." });
    expect(refused.status).toBe(400);
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
  });
});
