import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_ARTIFACT_RETENTION_TAG, indexExpiresAt, workflowSendBackOffered } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { prepareApplicationRound, startApplicationRound, type RoundCore } from "../support/e2e-application-round-harness.js";
import { FAIL, PASS, caseIdsOf, collectAll, operatorEvidenceWith, runRound, uploadAll } from "../support/e2e-application-round-run.js";
import { SHOT, SHOT_SHA } from "../support/e2e-scenario-results.js";
import { call } from "../support/slack-broker.js";

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
const implementInvocation = (prepared: { harness: RoundCore["harness"] }) =>
  prepared.harness.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "IMPLEMENT")
    .map((item) => item.invocation as { payload: Record<string, unknown> })[0];

describe("asking for a baseline round at APPROVE", () => {
  it("records the request once, for the approved application plan, and has the coding run export the unchanged code", async () => {
    const prepared = await prepareApplicationRound({ baseline: "source" });
    const approved = await prepared.approve();
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const key = { pk: `DEVTASK#${prepared.taskId}`, sk: `E2E_BASELINE#${String(prepared.workflowNow().e2e!.contractDigest)}` };
    expect(prepared.harness.db.get(key.pk, key.sk)).toMatchObject({ entityType: "WORKFLOW_E2E_BASELINE", state: "REQUESTED", purpose: "baseline", attempt: 1 });
    expect(implementInvocation(prepared)?.payload.workflowE2EBaselineSource).toBe(true);
    expect(prepared.workflowNow()).toMatchObject({ stage: "IMPLEMENT" });
  });

  it("asks for nothing when the project switched the baseline off: no record, and the coding run is not asked to export anything", async () => {
    const prepared = await prepareApplicationRound({ baseline: "off" });
    expect((await prepared.approve()).status).toBe(200);
    expect(prepared.harness.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("E2E_BASELINE#"))).toEqual([]);
    expect(implementInvocation(prepared)?.payload.workflowE2EBaselineSource).toBeUndefined();
  });
});

describe("the baseline round has its own admission, and runs before the candidate's CHECKS", () => {
  it("starts one CHECKS operation for the unchanged code, with the purpose and the base commit signed into the admission and the operation, and leaves the workflow as it was", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    const base = round.real.baseline!;
    expect(round.admissionRef).toMatchObject({ kind: "application", purpose: "baseline", baseCommitSha: base.baseCommitSha, attempt: 1 });
    expect(round.operationNow().workflowE2EAdmission).toMatchObject({ purpose: "baseline", baseCommitSha: base.baseCommitSha, attempt: 1 });
    expect(round.admission.baseline).toEqual({ purpose: "baseline", baseCommitSha: base.baseCommitSha, attempt: 1 });
    expect(round.admission.candidateCommitSha).toBe(base.baseCommitSha);
    expect(round.admission.sourceSnapshot.treePaths).not.toContain("src/orders.js");
    // The invocation the worker receives carries the same signed reference.
    const invocation = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === round.operationId)[0]!.invocation as { payload: { workflowE2EAdmission: unknown; readiness?: unknown } };
    expect(invocation.payload.workflowE2EAdmission).toMatchObject({ purpose: "baseline", baseCommitSha: base.baseCommitSha });
    expect(invocation.payload.readiness).toBeUndefined();
    // The workflow is exactly as the coding run left it: no round, no revision, no state change.
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    expect(e2eOf(round).currentRoundId).toBeUndefined();
    expect(recordOf(round)).toMatchObject({ state: "STARTED", attempt: 1, baseCommitSha: base.baseCommitSha, operationId: round.operationId, roundId: round.admissionRef.roundId,
      admissionSha256: round.admissionRef.admissionRef.sha256 });
    expect(typeof recordOf(round)!.deadlineAt).toBe("string");
    expect(Date.parse(String(recordOf(round)!.deadlineAt))).toBeGreaterThan(Date.now());
  });

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

  it("accepts the baseline's group and aggregate evidence uploads, which are bound to its own admission", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    const groups = await collectAll(round, [PASS]);
    await uploadAll(round, groups);
    expect(round.operationNow().workflowE2EEvidenceRef).toBeDefined();
  });
});

describe("a baseline never gates", () => {
  const runBaseline = async (round: RoundCore, outcome: typeof PASS | typeof FAIL, withShots = true) => {
    const [caseId] = caseIdsOf(round);
    return runRound(round, [outcome], { tweak: withShots ? (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } : () => undefined });
  };

  it("records what the unchanged code did, derived from the evidence the broker verified, and moves nothing in the workflow", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    const before = round.workflowNow();
    await runBaseline(round, FAIL);
    const stored = recordOf(round)!;
    expect(stored).toMatchObject({ state: "RECORDED", attempt: 1, operationId: round.operationId });
    expect((stored.baseline as { status: string }).status).toBe("FAILED");
    expect((stored.baseline as { scenarios: unknown[] }).scenarios).toHaveLength(1);
    // The baseline's result changed nothing in the workflow. What moved is the step it was holding back: the candidate's CHECKS started, on a round of their own.
    const candidateChecks = round.checksOperations().filter((row) => row.id !== round.operationId);
    expect(candidateChecks).toHaveLength(1);
    expect((candidateChecks[0]!.workflowE2EAdmission as { purpose?: string }).purpose).toBeUndefined();
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING", revision: before.revision + 1 });
    expect(e2eOf(round).currentRoundId).toBe((candidateChecks[0]!.workflowE2EAdmission as { roundId: string }).roundId);
    expect(e2eOf(round).currentRoundId).not.toBe(round.admissionRef.roundId);
    expect(JSON.stringify(round.workflowNow())).not.toMatch(/baseline/iu);
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(e2eOf(round).qualifiedRound).toBeUndefined();
    expect(e2eOf(round).displayRef).toBeUndefined();
    expect(workflowSendBackOffered(round.workflowNow() as never)).toBe(false);
    expect(await publicationChecksOf(round)).toBeUndefined();
  });

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

  it("is a record of its own, beside the task: the workflow snapshot holds no trace of it, and the record expires", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    await runBaseline(round, FAIL);
    const rows = round.harness.db.find((item) => item.pk === `DEVTASK#${round.taskId}` && String(item.sk).startsWith("E2E_BASELINE#"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexExpiresAt).toBe(indexExpiresAt(String(rows[0]!.recordedAt)));
  });

  it("is shown for the plan it ran against only: a changed plan has no baseline", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    await runBaseline(round, FAIL);
    const task = round.taskNow() as { workflow: { e2e: Record<string, unknown> } };
    const changed = { ...task, workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, contractDigest: "e".repeat(64) } } };
    expect(await (await baselineModule()).readWorkflowE2EBaseline(round.harness.brokerInput as never, changed as never)).toBeUndefined();
    expect((await (await baselineModule()).readWorkflowE2EBaseline(round.harness.brokerInput as never, task as never))?.status).toBe("FAILED");
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

  it("records only what the broker derived from the evidence: nothing the worker says about itself reaches the record", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    const groups = await collectAll(round, [FAIL]);
    const aggregate = await uploadAll(round, groups, (groupRun) => {
      // A worker that claims the baseline passed, and ships rows of its own.
      groupRun.scenarios = [{ scenarioId: "forged", status: "PASSED" }];
      groupRun.display = { status: "PASSED" };
      groupRun.verdict = "PASS";
    });
    await round.finishChecks(aggregate);
    const stored = recordOf(round)!;
    expect(JSON.stringify(stored)).not.toContain("forged");
    expect(stored.state === "RECORDED" ? (stored.baseline as { status: string }).status : stored.state).not.toBe("PASSED");
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

describe("a baseline whose runner never answers (F3)", () => {
  it("shows that the unchanged code could not be checked once its deadline and grace have passed, and stops waiting for it: the candidate's CHECKS go on", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.markRunning();
    const { E2E_BASELINE_RUN_GRACE_MS } = await baselineModule();
    const deadline = Date.parse(String(recordOf(round)!.deadlineAt));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline + E2E_BASELINE_RUN_GRACE_MS + 1_000);
    expect(await resultsOf(round)).toEqual({ scenarios: [], baseline: { status: "UNAVAILABLE", scenarios: [] } });
    // The dispatch stops waiting: it marks the record, and asks for the dead round to be cancelled, which frees the workspace for the candidate.
    await round.runDispatch();
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "timed-out" });
    expect(round.operationNow().status).toBe("CANCEL_REQUESTED");
    await round.harness.finish(round.workspaceId, round.operationId, "CANCELLED");
    // The cancelled baseline never blocks the workflow: the candidate's CHECKS go on.
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    expect(round.workflowNow().blockReason).toBeUndefined();
    const candidate = await round.nextRound();
    expect(candidate.admissionRef.purpose).toBeUndefined();
    expect(candidate.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
  });

  it("treats a baseline operation that ended without its result as ended: the record is marked and the candidate goes on", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    round.harness.db.set({ ...round.operationNow(), status: "FAILED" });
    const { activeOperationId: _active, ...freed } = round.harness.db.get(`WORKSPACE#${round.workspaceId}`, "META")!;
    void _active;
    round.harness.db.set({ ...freed, status: "READY" });
    const candidate = await round.nextRound();
    expect(recordOf(round)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    expect(candidate.admissionRef.purpose).toBeUndefined();
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

describe("the baseline admission is a real admission of the unchanged code", () => {
  it("is decodable by the worker's own decoder and names the base commit's source, not the candidate's", async () => {
    const round = await startApplicationRound({ baseline: "source" });
    const decoded = decodeE2EApplicationExecutionAdmission(round.admissionBytes);
    expect(decoded.candidateCommitSha).toBe(round.real.baseline!.baseCommitSha);
    expect(decoded.candidateDigest).not.toBe(round.candidate.digest);
    expect(operations(round).filter((row) => row.workflowMode === "CHECKS")).toHaveLength(1);
  });
});
