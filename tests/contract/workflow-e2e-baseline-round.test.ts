import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_ARTIFACT_RETENTION_TAG, workflowSendBackOffered } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { prepareApplicationRound, startApplicationRound, type RoundCore } from "../support/e2e-application-round-harness.js";
import { FAIL, PASS, caseIdsOf, collectAll, operatorEvidenceWith, runRound, uploadAll } from "../support/e2e-application-round-run.js";
import { SHOT, SHOT_SHA } from "../support/e2e-scenario-results.js";
import { randomUUID } from "node:crypto";
import { MAYA } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { SECRET_ARN } from "../support/e2e-model-fixtures.js";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS } from "@agentx/contracts";
import { e2eModelBudgetKey } from "../../packages/broker/src/e2e/model-route-registry.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

// The gate itself is tested in e2e-driving-test-gate.test.ts; here every digest counts as driven (Task 4.10C).
assumeDrivingTestsPassed();

// M1.3 Task 3.7b, owner decision D2 (Review Focus 6 and the 3.7 review's findings F1, F3, F8, F9): when an application plan is approved, the approved scenarios run once on the
// UNCHANGED code, in a round of their own, for information only. It has its own admission (purpose and base commit signed), its own callbacks and its own completion path, writes
// one record keyed by the plan, the base commit and the attempt, and can never set `failedRound` or `qualifiedRound`, offer send-back, or touch publication.

afterEach(() => { vi.useRealTimers(); return disposeRealCandidates(); });

const brokerModule = () => import("../../packages/broker/src/aws/broker.js");
const baselineModule = () => import("../../packages/broker/src/aws/workflow-e2e-baseline.js");
const operations = (round: RoundCore) => round.operationRows(() => true);
const e2eOf = (round: RoundCore) => round.workflowNow().e2e as { contractDigest: string; qualifiedRound?: unknown; failedRound?: unknown; currentRoundId?: string; displayRef?: unknown };
const recordKey = (round: { taskId: string; workflowNow: () => { e2e?: Record<string, unknown> } }) => ({ pk: `DEVTASK#${round.taskId}`, sk: `E2E_BASELINE#${String(round.workflowNow().e2e!.contractDigest)}` });
const recordOf = (round: { taskId: string; harness: RoundCore["harness"]; workflowNow: () => { e2e?: Record<string, unknown> } }) => {
  const key = recordKey(round);
  return round.harness.db.get(key.pk, key.sk);
};
const resultsOf = async (round: RoundCore) =>
  (await brokerModule()).loadWorkflowE2EScenarioResults(round.harness.brokerInput as never, round.taskNow() as never, operations(round), "owner");
const publicationChecksOf = async (round: RoundCore) =>
  (await brokerModule()).loadWorkflowE2EPublicationChecks(round.harness.brokerInput as never, round.taskNow() as never, operations(round));

describe("asking for a baseline round at APPROVE", () => {

  it("asks again on a retried coding run while the baseline is still only requested (review 3.7b finding 5)", async () => {
    const prepared = await prepareApplicationRound({ baseline: "source" });
    expect((await prepared.approve()).status).toBe(200);
    const implementOps = () => prepared.harness.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT");
    const first = implementOps()[0]!;
    prepared.harness.db.set({ ...first, status: "RUNNING" });
    const workspaceId = String(first.workspaceId);
    await prepared.harness.finish(workspaceId, String(first.id), "FAILED", { error: "the run died" });
    expect(prepared.workflowNow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    const retried = await prepared.harness.dev(MAYA, "POST", `/v1/dev/tasks/${prepared.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Run the implementation again" });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const invocations = prepared.harness.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "IMPLEMENT")
      .map((item) => item.invocation as { payload: Record<string, unknown> });
    expect(invocations).toHaveLength(2);
    expect(invocations.map((item) => item.payload.workflowE2EBaselineSource)).toEqual([true, true]);
  });

});

describe("the baseline round has its own admission, and runs before the candidate's CHECKS", () => {

  it("holds the candidate's CHECKS while the baseline runs, without spending the dispatch's attempts or blocking the workflow", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    await round.runDispatch();
    await round.runDispatch();
    expect(round.checksOperations()).toHaveLength(1);
    const rows = round.harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === round.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts ?? 0).toBe(0);
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "WAITING" });
  });

  it("runs the candidate's CHECKS at once, and says why there is no baseline, when the worker exported nothing or the export was refused", async () => {
    for (const [mode, reason] of [["missing", "not-exported"], ["refused", "refused"]] as const) {
      const round = await startApplicationRound({ baseline: mode });
      expect(round.admissionRef.purpose).toBeUndefined();
      expect(round.checksOperations()).toHaveLength(1);
      expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason });
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    }
  });

  it("holds the exported tree to the tree GitHub has for the pinned base (review 3.7b finding 4)", async () => {
    const matching = await startApplicationRound({ baseline: "source", githubBaseTree: "match" });
    expect(matching.admissionRef.purpose).toBe("baseline");
    expect(recordOf(matching)).toMatchObject({ state: "STARTED" });
    // A worker that labels other code as the base: the tree differs from GitHub's, so no baseline runs, and the candidate goes on.
    const forged = await startApplicationRound({ baseline: "source", githubBaseTree: "mismatch" });
    expect(forged.admissionRef.purpose).toBeUndefined();
    expect(recordOf(forged)).toMatchObject({ state: "UNAVAILABLE", reason: "refused" });
    // GitHub cannot be asked: the tree cannot be confirmed, so it is not run either.
    const unreachable = await startApplicationRound({ baseline: "source", githubBaseTree: "unreachable" });
    expect(unreachable.admissionRef.purpose).toBeUndefined();
    expect(recordOf(unreachable)).toMatchObject({ state: "UNAVAILABLE", reason: "start-failed" });
  });

  it("runs the candidate's CHECKS, and says so, when the exported unchanged code is not the base the task pinned", async () => {
    const round = await startApplicationRound({ baseline: "source", baselinePin: "other" });
    expect(round.admissionRef.purpose).toBeUndefined();
    expect(round.checksOperations()).toHaveLength(1);
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "refused" });
  });
});

describe("the baseline round's callbacks accept a round that is not the workflow's current one", () => {
  const readAdmission = (round: RoundCore, overrides: Record<string, unknown> = {}) => call(round.harness.handler, { method: "POST",
    path: `/v1/internal/workspaces/${round.workspaceId}/operations/${round.operationId}/e2e-admission`, headers: { "x-agentx-callback-capability": round.capabilityFor(round.operationId) },
    body: { stage: "read", offset: 0, sha256: round.admissionRef.admissionRef.sha256, ...overrides } });

  it("serves the baseline admission to its running operation while the workflow waits at VERIFY with no current round", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    const read = await readAdmission(round);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(Buffer.from(String(read.body.chunkBase64), "base64").length).toBeGreaterThan(0);
  });

  it("refuses it once the record no longer says this operation is the baseline's started round", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    const key = recordKey(round);
    round.harness.db.set({ ...recordOf(round)!, state: "UNAVAILABLE", reason: "timed-out" });
    expect((await readAdmission(round)).status).toBe(409);
    round.harness.db.set({ ...recordOf(round)!, state: "STARTED", operationId: "someone-else" });
    expect((await readAdmission(round)).status).toBe(409);
    void key;
  });

});

describe("a baseline never gates", () => {
  const runBaseline = async (round: RoundCore, outcome: typeof PASS | typeof FAIL, withShots = true) => {
    const [caseId] = caseIdsOf(round);
    return runRound(round, [outcome], { tweak: withShots ? (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } : () => undefined });
  };

  it("a baseline that FAILED sets no failedRound and offers no send-back, and the candidate's PASS still reaches review and publication", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    await runBaseline(round, FAIL);
    const candidate = await round.nextRound();
    expect(candidate.admissionRef.purpose).toBeUndefined();
    await runRound(candidate, [PASS]);
    expect(candidate.workflowNow(), JSON.stringify(candidate.workflowNow())).toMatchObject({ stage: "REVIEW" });
    expect(e2eOf(candidate).qualifiedRound).toBeDefined();
    expect(e2eOf(candidate).failedRound).toBeUndefined();
    expect(workflowSendBackOffered(candidate.workflowNow() as never)).toBe(false);
    expect((await publicationChecksOf(candidate))?.length ?? 0).toBeGreaterThan(0);
    const found = await resultsOf(candidate);
    expect(found?.baseline?.status).toBe("FAILED");
    expect(found?.scenarios.map((item) => item.status)).toEqual(["PASSED"]);
  });

  it("a baseline that PASSED does not rescue a failed candidate: its failure is recorded, send-back is offered and nothing is offered for publication", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    await runBaseline(round, PASS);
    const candidate = await round.nextRound();
    await runRound(candidate, [FAIL]);
    expect(candidate.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(e2eOf(candidate).failedRound).toMatchObject({ status: "FAILED" });
    expect(e2eOf(candidate).qualifiedRound).toBeUndefined();
    expect(workflowSendBackOffered(candidate.workflowNow() as never)).toBe(true);
    expect(await publicationChecksOf(candidate)).toBeUndefined();
    expect((await resultsOf(candidate))?.baseline?.status).toBe("PASSED");
  });

  it("cannot be mistaken for the candidate round even when it looks like the workflow's current one: its result sets no qualifiedRound and no failedRound", async () => {
    for (const outcome of [PASS, FAIL]) {
      const round = await startApplicationRound({ baseline: "source" });
      // The attack: the workflow is at VERIFY/RUNNING with the baseline's round as its current round.
      const task = round.taskNow() as { workflow: Record<string, unknown> & { revision: number; e2e: Record<string, unknown> } };
      const looksCurrent = { ...task, workflow: { ...task.workflow, state: "RUNNING", e2e: { ...task.workflow.e2e, currentRoundId: round.admissionRef.roundId, currentGroupRunIds: round.admissionRef.groupRunIds } } };
      round.harness.db.set(looksCurrent);
      const before = JSON.stringify(round.workflowNow());
      await runBaseline(round, outcome);
      expect(recordOf(round)).toMatchObject({ state: "RECORDED" });
      expect(JSON.stringify(round.workflowNow())).toBe(before);
      expect(e2eOf(round).qualifiedRound).toBeUndefined();
      expect(e2eOf(round).failedRound).toBeUndefined();
      expect(await publicationChecksOf(round)).toBeUndefined();
    }
  });

});

describe("the baseline's record is written conditionally (F1)", () => {
  it("does not overwrite a record that is no longer this round's: another attempt, another base commit, another operation", async () => {
    for (const edit of [{ attempt: 2 }, { baseCommitSha: "9".repeat(40) }, { operationId: "another-operation" }]) {
      const round = await startApplicationRound({ baseline: "source" });
      const groups = await collectAll(round, [FAIL]);
      const aggregate = await uploadAll(round, groups);
      const newer = { ...recordOf(round)!, ...edit };
      round.harness.db.set(newer);
      await round.finishChecks(aggregate);
      expect(round.operationNow().status).toBe("SUCCEEDED");
      // The round's own result was not written over the newer record. (A record that names an operation that does not exist is reconciled as not run, which is not a result.)
      expect(recordOf(round)).toMatchObject("operationId" in edit ? { operationId: "another-operation" } : newer);
      expect(recordOf(round)!.baseline).toBeUndefined();
      expect(recordOf(round)!.state).not.toBe("RECORDED");
    }
  });

  it("a baseline operation that failed records that the unchanged code could not be checked, and the candidate goes on", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    await round.harness.finish(round.workspaceId, round.operationId, "FAILED", { error: "the runner died" });
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY" });
    // F9: the sentence is there before the candidate round has a single row.
    expect(await resultsOf(round)).toEqual({ scenarios: [], baseline: { status: "UNAVAILABLE", scenarios: [] } });
    const candidate = await round.nextRound();
    expect(candidate.admissionRef.purpose).toBeUndefined();
    await runRound(candidate, [PASS]);
    expect(candidate.workflowNow()).toMatchObject({ stage: "REVIEW" });
    expect((await resultsOf(candidate))?.baseline).toEqual({ status: "UNAVAILABLE", scenarios: [] });
  });
});

describe("a baseline never holds the candidate for ever (review 3.7b finding 3)", () => {
  it("fails open on a started record whose deadline cannot be read: it is treated as late, marked, and cancelled, and the candidate goes on", async () => {
    for (const deadlineAt of ["not-a-date", undefined]) {
      const round = await startApplicationRound({ baseline: "source" });
      round.markRunning();
      const { deadlineAt: _kept, ...without } = recordOf(round)!;
      void _kept;
      round.harness.db.set(deadlineAt === undefined ? without : { ...without, deadlineAt });
      await round.runDispatch();
      expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "timed-out" });
      expect(round.operationNow().status).toBe("CANCEL_REQUESTED");
      await round.harness.finish(round.workspaceId, round.operationId, "CANCELLED");
      const candidate = await round.nextRound();
      expect(candidate.admissionRef.purpose).toBeUndefined();
      expect(candidate.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    }
  });

  it("after the cancel's grace, still held: the candidate is blocked with a reason that names the check on the unchanged code, and its attempts are not spent", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    const { E2E_BASELINE_RUN_GRACE_MS } = await baselineModule();
    const deadline = Date.parse(String(recordOf(round)!.deadlineAt));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline + E2E_BASELINE_RUN_GRACE_MS + 1_000);
    await round.runDispatch();
    expect(round.operationNow().status).toBe("CANCEL_REQUESTED");
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "timed-out" });
    // The worker never confirms the cancel; 25 minutes pass (the hold limit is 20).
    vi.setSystemTime(deadline + E2E_BASELINE_RUN_GRACE_MS + 25 * 60_000);
    await round.runDispatch();
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "cancel-unconfirmed" });
    expect(round.workflowNow().state).toBe("BLOCKED");
    expect(round.workflowNow().blockReason).toMatch(/unchanged code/iu);
    expect(round.workflowNow().blockReason).toMatch(/still|did not stop/iu);
    const rows = round.harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === round.taskId);
    expect(rows.every((row) => (row.attempts ?? 0) === 0)).toBe(true);
    expect(e2eOf(round).failedRound).toBeUndefined();
  });
});

describe("a baseline that is stuck is never waited on and never spends the candidate's attempts (3.7c)", () => {
  const spent = (round: RoundCore) => round.harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === round.taskId).map((row) => row.attempts ?? 0);
  const expectStuck = (round: RoundCore) => {
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "cancel-unconfirmed" });
    expect(round.workflowNow().state).toBe("BLOCKED");
    expect(round.workflowNow().blockReason).toMatch(/unchanged code/iu);
    expect(round.workflowNow().blockReason).toMatch(/still|did not stop/iu);
    expect(spent(round).every((attempts) => attempts === 0)).toBe(true);
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(e2eOf(round).qualifiedRound).toBeUndefined();
  };

  // R2: an operation whose cancel failed ends INTERRUPTED but keeps its workspace, as it might still run. That is a baseline that did not stop, not one that failed.
  it.each([
    ["STOPPED", "STOPPED"],
  ] as const)("an INTERRUPTED baseline that the %s workspace still names as active is stuck: marked cancel-unconfirmed, and the candidate is blocked without spending attempts", async (_name, workspaceStatus) => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    round.harness.db.set({ ...round.operationNow(), status: "INTERRUPTED" });
    const workspaceKey = { pk: `WORKSPACE#${round.workspaceId}`, sk: "META" };
    const held = round.harness.db.get(workspaceKey.pk, workspaceKey.sk)!;
    expect(held.activeOperationId).toBe(round.operationId);
    round.harness.db.set({ ...held, status: workspaceStatus });
    await round.runDispatch();
    expectStuck(round);
    expect(round.checksOperations()).toHaveLength(1);
  });

  it("an INTERRUPTED baseline that the workspace no longer names goes on: the candidate is not blocked", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    round.harness.db.set({ ...round.operationNow(), status: "INTERRUPTED" });
    const { activeOperationId: _active, ...freed } = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, "META")!;
    void _active;
    round.harness.db.set({ ...freed, status: "READY" });
    const candidate = await round.nextRound();
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    expect(candidate.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
  });

});

describe("the owner's Stop during the baseline stops the whole CHECKS step (review 3.7b finding 7)", () => {
  const stop = async (round: RoundCore) => round.harness.dev(MAYA, "POST", `/v1/dev/tasks/${round.taskId}/cancel`, { requestId: randomUUID() });

  it("does not start the candidate's CHECKS afterwards: the workflow stops with the reason a stopped check gives, and the owner can retry", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    const stopped = await stop(round);
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(round.operationNow().status).toBe("CANCEL_REQUESTED");
    // The worker confirms: the baseline operation ends CANCELLED.
    await round.harness.finish(round.workspaceId, round.operationId, "CANCELLED");
    await round.runDispatch();
    expect(round.checksOperations()).toHaveLength(1);
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(String(round.workflowNow().blockReason)).toMatch(/stopped/iu);
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE" });
  });

});

describe("the baseline's screenshots (F8, owner decision D4)", () => {
  it("are kept as private objects tagged for the 30-day expiry, and served to the task's readers before any candidate round exists", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } });
    const task = round.taskNow() as { ownerKey: string; workspaceId: string };
    const key = `private/${task.ownerKey}/${task.workspaceId}/workflow-e2e-artifacts/${SHOT_SHA}`;
    expect((round.harness.s3 as unknown as { binary: Map<string, Buffer> }).binary.has(key)).toBe(true);
    const puts = (round.harness.s3.send as unknown as { mock: { calls: Array<[{ constructor: { name: string }; input: { Key?: string; Tagging?: string } }]> } }).mock.calls
      .map(([command]) => command).filter((command) => command.constructor.name === "PutObjectCommand" && command.input.Key === key);
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((command) => command.input.Tagging === E2E_ARTIFACT_RETENTION_TAG)).toBe(true);
    const found = await resultsOf(round);
    expect(found?.baseline?.scenarios[0]?.screenshotRef?.sha256).toBe(SHOT_SHA);
    const artifact = await (await brokerModule()).loadWorkflowE2EArtifact(round.harness.brokerInput as never, round.taskNow() as never, SHOT_SHA);
    expect(artifact?.contentType).toBe("image/jpeg");
    expect(Buffer.from(artifact!.bytes).equals(SHOT)).toBe(true);
    // A digest no row names is still not served.
    expect(await (await brokerModule()).loadWorkflowE2EArtifact(round.harness.brokerInput as never, round.taskNow() as never, "0".repeat(64))).toBeUndefined();
  });
});

// Ruling CX (the M1.3 -> M1.4 merge): on a project whose setup approval pinned an AI navigation route, the baseline round still carries no route and no agent steps.
describe("the baseline round on a project whose policy pins a model route", () => {
  it("is admitted with modelRoute null, group bindings with modelRouteRevision null, and a reference with no agentSteps", async () => {
    const round = await startApplicationRound({ baseline: "source", brokerExtra: { e2eAgentInstallation: async () => ({ provider: "anthropic", secretArn: SECRET_ARN }) } });
    expect(round.policy.modelRouteRevision).toMatch(/^r1-[a-f0-9]{12}$/);
    expect(round.admissionRef.purpose).toBe("baseline");
    expect(round.admissionRef.agentSteps).toBeUndefined();
    const decoded = decodeE2EApplicationExecutionAdmission(round.admissionBytes);
    expect(decoded.modelRoute).toBeNull();
    expect(decoded.round.groupBindings.every((binding) => binding.modelRouteRevision === null)).toBe(true);
    expect((round.operationNow().workflowE2EAdmission as { agentSteps?: unknown }).agentSteps).toBeUndefined();
  });
});

// The AI day budget belongs to the candidate's AI navigation steps. A baseline round has none, so it is never refused by the budget precheck and never charged by the callback.
describe("the baseline round and the project's AI day budget", () => {
  it("still dispatches when the project's day budget is spent: the baseline path never asks the budget's precheck", async () => {
    const exhausted = { ...e2eModelBudgetKey(TEST_ORG, "payments", new Date().toISOString().slice(0, 10)), entityType: "E2E_MODEL_BUDGET",
      inputTokens: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxInputTokensPerProjectDay, calls: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxCallsPerProjectDay };
    const round = await startApplicationRound({ baseline: "source", beforeDispatch: (harness) => harness.db.set(exhausted) });
    expect(round.admissionRef.purpose).toBe("baseline");
    expect(recordOf(round)).toMatchObject({ state: "STARTED", operationId: round.operationId });
  });

  it("refuses the e2e-model-budget callback for a baseline operation, even with the grant and an agentSteps reference, and writes no budget row", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    const route = (capability: string) => call(round.harness.handler, { method: "POST", path: `/v1/internal/workspaces/${round.workspaceId}/operations/${round.operationId}/e2e-model-budget`,
      headers: { "x-agentx-callback-capability": capability }, body: { schemaVersion: "rovara-e2e-model-budget/v1", reservationId: randomUUID(), stage: "reserve", groupRunId: round.admissionRef.groupRunIds[0], inputTokens: 1_000 } });
    // The capability a baseline operation is issued does not carry the grant.
    expect((await route(round.capabilityFor(round.operationId))).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    // Defense in depth: a grant and an agentSteps reference are still refused for the baseline purpose.
    const operation = round.operationNow();
    round.harness.db.set({ ...operation, pk: `WORKSPACE#${round.workspaceId}`, sk: `OPERATION#${round.operationId}`, workflowE2EAdmission: { ...operation.workflowE2EAdmission, agentSteps: true } });
    const granted = issueCapability(round.harness.brokerInput as { callbackSigningKey: string }, round.workspaceId, round.operationId, operation.fence, false, false, false, false, false, true, true);
    expect((await route(granted)).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(round.harness.db.find((item) => String(item.sk).startsWith("E2E_MODEL_BUDGET"))).toEqual([]);
  });
});
