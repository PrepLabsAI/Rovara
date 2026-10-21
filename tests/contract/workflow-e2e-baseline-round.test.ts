import { afterEach, describe, expect, it } from "vitest";
import { workflowSendBackOffered, type E2EDisplayBaseline } from "@agentx/contracts";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { prepareApplicationRound, startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";
import { FAIL, PASS, caseIdsOf, operatorEvidenceWith, runRound } from "../support/e2e-application-round-run.js";
import { OTHER_SHOT, OTHER_SHOT_SHA, SHOT, SHOT_SHA, failedBaseline, row } from "../support/e2e-scenario-results.js";

// M1.3 Task 3.7, owner decision D2 (Review Focus 6): the baseline round runs the approved scenarios once on the unchanged code, for information only. It is asked for at
// APPROVE, recorded apart from the candidate rounds, and it never gates: it cannot satisfy or block publication, trigger send-back, or be taken for a candidate round.

afterEach(disposeRealCandidates);

const brokerModule = () => import("../../packages/broker/src/aws/broker.js");
const baselineModule = () => import("../../packages/broker/src/aws/workflow-e2e-baseline.js");
const operations = (round: ApplicationRound) => round.operationRows(() => true);
const e2eOf = (round: ApplicationRound) => round.workflowNow().e2e as { qualifiedRound?: unknown; failedRound?: unknown; currentRoundId?: string };
const resultsOf = async (round: ApplicationRound) =>
  (await brokerModule()).loadWorkflowE2EScenarioResults(round.harness.brokerInput as never, round.taskNow() as never, operations(round), "owner");
const publicationChecksOf = async (round: ApplicationRound) =>
  (await brokerModule()).loadWorkflowE2EPublicationChecks(round.harness.brokerInput as never, round.taskNow() as never, operations(round));
const record = async (round: ApplicationRound, baseline: E2EDisplayBaseline, artifacts: ReadonlyArray<{ sha256: string; bytes: Uint8Array }> = []) =>
  (await baselineModule()).recordWorkflowE2EBaseline(round.harness.brokerInput as never, round.taskNow() as never, { baseline, artifacts: artifacts.map((item) => ({ ...item, contentType: "image/jpeg" as const })) });
const readBaseline = async (round: ApplicationRound) => (await baselineModule()).readWorkflowE2EBaseline(round.harness.brokerInput as never, round.taskNow() as never);

describe("asking for a baseline round at APPROVE", () => {
  it("asks the broker's baseline runner once, for the approved application plan, with purpose baseline", async () => {
    const asked: Array<{ purpose: string; taskId: string; stage: string | undefined }> = [];
    const prepared = await prepareApplicationRound({ brokerExtra: { e2eBaselineRound: async (input: { purpose: string; task: { taskId: string; workflow?: { stage?: string } } }) => {
      asked.push({ purpose: input.purpose, taskId: input.task.taskId, stage: input.task.workflow?.stage }); } } });
    const approved = await prepared.approve();
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(asked).toEqual([{ purpose: "baseline", taskId: prepared.taskId, stage: "IMPLEMENT" }]);
    expect(prepared.workflowNow()).toMatchObject({ stage: "IMPLEMENT" });
  });

  it("asks for nothing when the broker has no baseline runner: no row, no mention on the page", async () => {
    const round = await startApplicationRound();
    expect(await readBaseline(round)).toBeUndefined();
    await runRound(round, [PASS]);
    expect((await resultsOf(round))?.baseline).toBeUndefined();
  });

  it("asks for nothing when the approved plan is not an application plan", async () => {
    const baseline = await baselineModule();
    const calls: string[] = [];
    const outcome = await baseline.requestWorkflowE2EBaselineRound({ documentClient: {} as never, tableName: "state", startBaseline: async () => { calls.push("asked"); } },
      { taskId: "t", workflow: { e2e: { required: true, contractDigest: "a".repeat(64) } } } as never);
    expect(outcome).toBe("NOT_REQUESTED");
    expect(calls).toEqual([]);
  });

  it("a baseline that cannot start leaves APPROVE and the candidate's CHECKS exactly as they are, and the display says the unchanged code could not be checked", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => { throw new Error("no source for the unchanged code"); } } });
    // APPROVE went through (the round started from an approved plan); the baseline row says why there is no baseline.
    expect(await readBaseline(round)).toEqual({ status: "UNAVAILABLE", scenarios: [] });
    await runRound(round, [PASS]);
    expect(round.workflowNow(), JSON.stringify(round.workflowNow())).toMatchObject({ stage: "REVIEW" });
    expect(e2eOf(round).qualifiedRound).toBeDefined();
    const found = await resultsOf(round);
    expect(found?.baseline).toEqual({ status: "UNAVAILABLE", scenarios: [] });
    expect(found?.scenarios.map((item) => item.status)).toEqual(["PASSED"]);
    expect(JSON.stringify((await (await brokerModule()).loadWorkflowE2EPresentation(round.harness.brokerInput as never, round.taskNow() as never, operations(round), "owner"))!.slackBlocks))
      .toContain("Couldn't run the checks on the unchanged code.");
  });
});

describe("a baseline never gates", () => {
  it("a baseline that FAILED sets no failedRound and offers no send-back, and the candidate's PASS still reaches review and publication", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    await record(round, failedBaseline(), [{ sha256: SHOT_SHA, bytes: SHOT }, { sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT }]);
    // Before any candidate round: the baseline alone moves nothing.
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(e2eOf(round).qualifiedRound).toBeUndefined();
    await runRound(round, [PASS]);
    expect(round.workflowNow(), JSON.stringify(round.workflowNow())).toMatchObject({ stage: "REVIEW" });
    expect(e2eOf(round).qualifiedRound).toBeDefined();
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(workflowSendBackOffered(round.workflowNow() as never)).toBe(false);
    expect((await publicationChecksOf(round))?.length ?? 0).toBeGreaterThan(0);
    const found = await resultsOf(round);
    expect(found?.baseline?.status).toBe("FAILED");
    expect(found?.scenarios.map((item) => item.status)).toEqual(["PASSED"]);
  });

  it("a baseline that PASSED does not rescue a failed candidate: its failure is recorded, send-back is offered and nothing is offered for publication", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    await record(round, { status: "PASSED", scenarios: [row({ scenarioId: "orders-health-0", title: "Orders health 0", kind: "api" })] });
    await runRound(round, [FAIL]);
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(e2eOf(round).failedRound).toMatchObject({ status: "FAILED" });
    expect(e2eOf(round).qualifiedRound).toBeUndefined();
    expect(workflowSendBackOffered(round.workflowNow() as never)).toBe(true);
    expect(await publicationChecksOf(round)).toBeUndefined();
    expect((await resultsOf(round))?.baseline?.status).toBe("PASSED");
  });

  it("is a record of its own, beside the task: the workflow snapshot holds no trace of it", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    const before = JSON.stringify(round.workflowNow());
    await record(round, failedBaseline(), [{ sha256: SHOT_SHA, bytes: SHOT }, { sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT }]);
    expect(JSON.stringify(round.workflowNow())).toBe(before);
    expect(JSON.stringify(round.workflowNow())).not.toMatch(/baseline/iu);
    const rows = round.harness.db.find((item) => item.pk === `DEVTASK#${round.taskId}` && String(item.sk).startsWith("E2E_BASELINE#"));
    expect(rows).toHaveLength(1);
  });

  it("is shown for the plan it ran against only: a changed plan has no baseline", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    await record(round, failedBaseline(), [{ sha256: SHOT_SHA, bytes: SHOT }, { sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT }]);
    expect((await readBaseline(round))?.status).toBe("FAILED");
    const task = round.taskNow() as { workflow: { e2e: Record<string, unknown> } };
    const changed = { ...task, workflow: { ...task.workflow, e2e: { ...task.workflow.e2e, contractDigest: "e".repeat(64) } } };
    expect(await (await baselineModule()).readWorkflowE2EBaseline(round.harness.brokerInput as never, changed as never)).toBeUndefined();
  });
});

describe("recording a baseline", () => {
  it("keeps a screenshot ref only when its bytes are in hand and are the bytes of that digest, and stores them as private objects", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    const withRefs = failedBaseline();
    await record(round, withRefs, [{ sha256: SHOT_SHA, bytes: SHOT }, { sha256: OTHER_SHOT_SHA, bytes: SHOT }]);
    const stored = (await readBaseline(round))!;
    const refs = stored.scenarios.map((item) => item.screenshotRef?.sha256);
    expect(refs).toContain(SHOT_SHA);
    expect(refs).not.toContain(OTHER_SHOT_SHA);
    const task = round.taskNow() as { ownerKey: string; workspaceId: string };
    const binary = (round.harness.s3 as unknown as { binary: Map<string, Buffer> }).binary;
    expect(binary.has(`private/${task.ownerKey}/${task.workspaceId}/workflow-e2e-artifacts/${SHOT_SHA}`)).toBe(true);
    expect(binary.has(`private/${task.ownerKey}/${task.workspaceId}/workflow-e2e-artifacts/${OTHER_SHOT_SHA}`)).toBe(false);
  });

  it("scrubs an email or a credential that reaches a row, and refuses a baseline that is not a baseline", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    await record(round, { status: "FAILED", scenarios: [row({ status: "FAILED", reason: "received ops@tenant-a.example password=hunter2-secret" })] });
    const stored = JSON.stringify(await readBaseline(round));
    expect(stored).not.toContain("ops@tenant-a.example");
    expect(stored).not.toContain("hunter2-secret");
    await expect(record(round, { status: "UNAVAILABLE", scenarios: [row()] })).rejects.toThrow();
    await expect(record(round, { status: "FAILED", scenarios: Array.from({ length: 65 }, (_, index) => row({ scenarioId: `s-${index}` })) })).rejects.toThrow();
  });

  it("serves the baseline's screenshot through the task's display once a candidate round has been recorded", async () => {
    const round = await startApplicationRound({ brokerExtra: { e2eBaselineRound: async () => undefined } });
    const [caseId] = caseIdsOf(round);
    await record(round, failedBaseline(), [{ sha256: SHOT_SHA, bytes: SHOT }, { sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT }]);
    await runRound(round, [PASS], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } });
    const task = round.taskNow() as never;
    const artifact = await (await brokerModule()).loadWorkflowE2EArtifact(round.harness.brokerInput as never, task, OTHER_SHOT_SHA);
    expect(artifact?.contentType).toBe("image/jpeg");
    expect(Buffer.from(artifact!.bytes).equals(OTHER_SHOT)).toBe(true);
  });
});
