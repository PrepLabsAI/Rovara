// T7c GROUND-FLOW: a coding plan with must-not-change scenarios is held back (nothing submitted, no card) while those scenarios run on the unchanged app; every exit calls the one finish.
import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { groundingScenarioIds, planQualityFinding, type PlanDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { csvScenario, planFixture } from "../support/e2e-application-plan-fixtures.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { agentXError } from "@agentx/contracts";
import { failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import type { DurableOutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import type { finishPlanGrounding as FinishPlanGrounding, startPlanGroundingRound } from "../../packages/broker/src/aws/broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { groundingStartItem, markWorkflowE2EGroundingUnavailable, readWorkflowE2EGroundingRecord, requestWorkflowE2EGroundingRound } from "../../packages/broker/src/aws/workflow-e2e-grounding.js";
import { PLAN_GROUNDING_HOLD_LINE, workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { PlanSelfCheckRecordSchema } from "../../packages/broker/src/developer/plan-self-check.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
type Mode = "start" | "unavailable" | "throw";
type StoredTask = Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot; planGrounding?: { artifactId: string; artifactSha256: string; attempt: number; deadlineAt: string }; planGroundingAbandoned?: string; planSelfCheck?: unknown };

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The check on the current app is a stub (the real one builds an admission from an exported source, covered by workflow-e2e-grounding-round.test.ts): it makes the record the real one makes. */
function stub(mode: Mode, calls: { count: number } = { count: 0 }): typeof startPlanGroundingRound {
  return (async (dependencies, _route, input) => {
    calls.count += 1;
    if (mode === "throw") throw new Error("boom: /home/ci/secret-path");
    const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
    const ref = { taskId: input.task.taskId, planArtifactSha256: input.artifact.sha256, attempt: input.attempt ?? 1 };
    await requestWorkflowE2EGroundingRound(store, ref, { scenarioIds: groundingScenarioIds(input.plan), planArtifactId: input.artifact.id });
    if (mode === "unavailable") {
      await markWorkflowE2EGroundingUnavailable(store, ref, "runtime-not-ready", { from: ["REQUESTED"] });
      return { outcome: "UNAVAILABLE", reason: "runtime-not-ready" };
    }
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [groundingStartItem(store, ref, { baseCommitSha: "a".repeat(40), operationId: "grounding-op", roundId: "round-1",
      admissionSha256: "b".repeat(64), selectionDigest: "c".repeat(64), startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString() })] }));
    return { outcome: "STARTED" };
  });
}

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const planRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN");
const activePlanning = (harness: Harness, workspaceId: string) => planRuns(harness, workspaceId).find((item) => item.status === "ACCEPTED")!;
const taskOf = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as StoredTask;
const workflowOf = (harness: Harness, taskId: string) => taskOf(harness, taskId).workflow;
const rows = (harness: Harness) => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const promptOf = (harness: Harness, operationId: unknown) =>
  String((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload: { prompt: string } }).payload.prompt);

async function startTask(harness: Harness) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = taskOf(harness, taskId);
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(record.workspaceId, String(operations(harness, record.workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  return { taskId, workspaceId: record.workspaceId };
}

const CHECKS = { checks: [{ label: "Unit tests", cwd: "repo/demo", executable: "npx", args: ["vitest"], proves: ["1.1", "2", "nc1"] }], none_reason: null };
/** A coding plan whose scenario export-csv proves the Not changing entry nc1. */
const groundedPlan = (): PlanDocument => planDocument({ e2e: planFixture({}).intent, scenarioProves: { [csvScenario.scenarioId]: ["nc1"] } });
const groundedAnswer = () => planAnswer(groundedPlan(), { checks: CHECKS });

/** The planning step in flight ends with `answer`; its run is marked as asked for the unchanged code on an application plan, as delivery marks it. */
async function finishPlanning(harness: Harness, workspaceId: string, answer: string, asked = true) {
  const active = activePlanning(harness, workspaceId);
  harness.db.set({ ...active, ...(asked ? { groundingSourceAsked: true } : {}), workflowE2EPlanVersion: 2 });
  await harness.artifact(workspaceId, String(active.id), "plan.md", answer);
  await harness.finish(workspaceId, String(active.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
}

async function setup(mode: Mode, calls?: { count: number }) {
  const harness = await createDeveloperTaskBroker({ brokerExtra: { planSelfCheck: true, startPlanGrounding: stub(mode, calls) } });
  return { harness, ...(await startTask(harness)) };
}

/** The held plan's check ended with this result (what settleGroundingRound writes); the row is made due and the recovery sweep runs. */
async function settle(harness: Harness, taskId: string, result: { findings?: unknown[]; unavailable?: string }) {
  const hold = taskOf(harness, taskId).planGrounding!;
  const key = { pk: `DEVTASK#${taskId}`, sk: `E2E_GROUNDING#${hold.artifactSha256}#${hold.attempt}` };
  const record = harness.db.get(key.pk, key.sk)!;
  harness.db.set(result.unavailable !== undefined ? { ...record, state: "UNAVAILABLE", reason: result.unavailable }
    : { ...record, state: "RECORDED", results: { status: "FAILED", scenarios: [] }, findings: result.findings ?? [] });
  await sweep(harness);
}
async function sweep(harness: Harness) {
  for (const row of rows(harness)) harness.db.set({ ...row, nextAttemptAt: "2000-01-01T00:00:00.000Z", dispatchDueSk: `2000-01-01T00:00:00.000Z#${String(row.sk)}` });
  const response = await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
  expect(response.statusCode).toBe(200);
}
const quality = (harness: Harness, taskId: string) => {
  const artifact = workflowOf(harness, taskId).artifacts.at(-1)!;
  const raw = harness.s3.objects.get(String(artifact.objectKey).replace(/\.json$/u, ".quality.json"));
  return raw === undefined ? undefined : PlanSelfCheckRecordSchema.parse(JSON.parse(raw));
};
const MISMATCH = planQualityFinding({ code: "scenario-base-mismatch", scenarioIds: [csvScenario.scenarioId], steps: [{ scenarioId: csvScenario.scenarioId, assertionKind: "csv" }] });

let finishPlanGrounding: typeof FinishPlanGrounding;
beforeAll(async () => { finishPlanGrounding = (await loadSlackBroker() as unknown as { finishPlanGrounding: typeof FinishPlanGrounding }).finishPlanGrounding; });

describe("a plan with must-not-change scenarios is held back while they run on the current app", () => {
  it("holds the plan: no card, no submitted artifact, one GROUNDING row, the hold on the task with a 15 minute deadline; nothing can be approved", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const task = taskOf(harness, taskId);
    expect(task.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect(task.workflow.artifacts).toHaveLength(0);
    const hold = task.planGrounding!;
    expect(Date.parse(hold.deadlineAt) - Date.parse(String((task.planGrounding as unknown as { heldAt: string }).heldAt))).toBe(15 * 60_000);
    expect(rows(harness)).toMatchObject([{ kind: "GROUNDING", candidateDigest: hold.artifactSha256 }]);
    expect(harness.db.get(`DEVTASK#${taskId}`, `E2E_GROUNDING#${hold.artifactSha256}#1`)).toMatchObject({ state: "STARTED" });
    // The held plan is the one that will be submitted: its canonical bytes are saved and hash to the held digest.
    const saved = [...harness.s3.objects.entries()].find(([key]) => key.endsWith(`${(task.planGrounding as unknown as { artifactId: string }).artifactId}.json`))!;
    expect(sha(saved[1])).toBe(hold.artifactSha256);
    // No Approve while held: nothing was submitted, so a decision is refused and the workflow does not move.
    const before = JSON.stringify(workflowOf(harness, taskId));
    const approve = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: task.workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: hold.artifactSha256 });
    expect(approve.status).not.toBe(200);
    expect(JSON.stringify(workflowOf(harness, taskId))).toBe(before);
  });

  it("a check that found nothing wrong: the plan is submitted as held (same digest), the hold and the row are gone, the card follows", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const held = taskOf(harness, taskId).planGrounding!.artifactSha256;
    await settle(harness, taskId, { findings: [] });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(workflowOf(harness, taskId).artifacts.at(-1)!.sha256).toBe(held);
    expect(taskOf(harness, taskId).planGrounding).toBeUndefined();
    expect(rows(harness)).toEqual([]);
    expect(quality(harness, taskId)).toMatchObject({ status: "checked", artifactSha256: held });
    expect(planRuns(harness, workspaceId)).toHaveLength(1);
  });

  it("a mismatch with the revision left sends the planner back once with the fixed line and posts no card; the corrected plan is checked once more and then shown with the warning", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    await settle(harness, taskId, { findings: [MISMATCH] });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect(workflowOf(harness, taskId).artifacts).toHaveLength(0);
    expect(taskOf(harness, taskId).planGrounding).toBeUndefined();
    expect(taskOf(harness, taskId).planSelfCheck).toEqual({ artifactType: "plan", version: 1, used: 1 });
    expect(planRuns(harness, workspaceId)).toHaveLength(2);
    expect(promptOf(harness, activePlanning(harness, workspaceId).id)).toContain("scenario-base-mismatch: scenario export-csv");
    // The corrected plan is held again (attempt 2) and checked once more; a second mismatch is a warning, with no third run.
    await finishPlanning(harness, workspaceId, groundedAnswer());
    expect(taskOf(harness, taskId).planGrounding).toMatchObject({ attempt: 2 });
    await settle(harness, taskId, { findings: [MISMATCH] });
    expect(planRuns(harness, workspaceId)).toHaveLength(2);
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(harness, taskId)).toMatchObject({ findings: [{ code: "scenario-base-mismatch", scenarioIds: ["export-csv"] }], autoRevisions: 1 });
  });

  it("every way the check gives no result ends the hold with the card and a fixed 'Not checked against the current app' reason: refused start, failed start, stopped, lost delivery, deadline", async () => {
    // A start the starter refused with a reason.
    const refused = await setup("unavailable");
    await finishPlanning(refused.harness, refused.workspaceId, groundedAnswer());
    expect(workflowOf(refused.harness, refused.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(refused.harness, refused.taskId)!.notes).toMatchObject([{ code: "checks-not-tried" }, { code: "grounding-not-checked", ownerSentence: "Not checked against the current app: the test environment was not ready." }]);

    // A start that threw (a fault outside the starter's own handling): the one finish ends the hold, and nothing the error said is kept.
    const threw = await setup("throw");
    await finishPlanning(threw.harness, threw.workspaceId, groundedAnswer());
    expect(workflowOf(threw.harness, threw.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(threw.harness, threw.taskId)!.notes.at(-1)).toEqual({ code: "grounding-not-checked", ownerSentence: "Not checked against the current app: the check could not be started." });
    expect(JSON.stringify([...threw.harness.s3.objects.values()])).not.toContain("secret-path");
    expect(taskOf(threw.harness, threw.taskId).planGrounding).toBeUndefined();

    // Stopped, and a lost delivery: the record says so and the next look at the row finishes.
    for (const reason of ["stopped", "worker-too-old"]) {
      const run = await setup("start");
      await finishPlanning(run.harness, run.workspaceId, groundedAnswer());
      await settle(run.harness, run.taskId, { unavailable: reason });
      expect(workflowOf(run.harness, run.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      expect(quality(run.harness, run.taskId)!.notes.at(-1)!.ownerSentence).toBe(reason === "stopped" ? "Not checked against the current app: it was stopped."
        : "Not checked against the current app: the runner is too old for this check.");
    }

    // The deadline: a check still running when the hold's time is up is read as timed out; the round is marked so a late result changes nothing.
    const late = await setup("start");
    await finishPlanning(late.harness, late.workspaceId, groundedAnswer());
    const hold = taskOf(late.harness, late.taskId).planGrounding!;
    late.harness.db.set({ ...taskOf(late.harness, late.taskId), planGrounding: { ...hold, deadlineAt: "2000-01-01T00:00:00.000Z" } });
    await sweep(late.harness);
    expect(workflowOf(late.harness, late.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(late.harness, late.taskId)!.notes.at(-1)!.ownerSentence).toBe("Not checked against the current app: it ran out of time.");
    expect(late.harness.db.get(`DEVTASK#${late.taskId}`, `E2E_GROUNDING#${hold.artifactSha256}#1`)).toMatchObject({ state: "UNAVAILABLE", reason: "timed-out" });
  });

  it("the finish is idempotent: a second call (or a late settle) after the plan was shown changes nothing", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    await settle(harness, taskId, { findings: [] });
    const before = JSON.stringify([taskOf(harness, taskId), rows(harness)]);
    expect(await finishPlanGrounding(harness.brokerInput as never, taskId)).toBe("NOOP");
    expect(await finishPlanGrounding(harness.brokerInput as never, taskId, { force: "stopped" })).toBe("NOOP");
    expect(JSON.stringify([taskOf(harness, taskId), rows(harness)])).toBe(before);
  });

  it("while the check runs and is not overdue the finish waits and changes nothing", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const before = JSON.stringify(taskOf(harness, taskId));
    expect(await finishPlanGrounding(harness.brokerInput as never, taskId)).toBe("WAITING");
    expect(JSON.stringify(taskOf(harness, taskId))).toBe(before);
  });

  it("Close during the hold marks the hold abandoned (and stops the round)", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const closed = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.status).toBe(200);
    expect(taskOf(harness, taskId).planGroundingAbandoned).toBe(taskOf(harness, taskId).planGrounding!.artifactSha256);
  });

  it("an abandoned hold is cleared by the finish and asks nobody anything (no card, no planner run), whatever the check found", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const hold = taskOf(harness, taskId).planGrounding!;
    harness.db.set({ ...taskOf(harness, taskId), planGroundingAbandoned: hold.artifactSha256 });
    // The check ends with a fixable mismatch: an owner who is still asked would get a planner run (control: the third test above); an abandoned hold gets nothing.
    await settle(harness, taskId, { findings: [MISMATCH] });
    expect(taskOf(harness, taskId).planGrounding).toBeUndefined();
    expect(taskOf(harness, taskId).planGroundingAbandoned).toBeUndefined();
    // Planning is stopped (never left running with nothing running), and nobody is asked: no card, no planner run.
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    expect(workflowOf(harness, taskId).artifacts).toHaveLength(0);
    expect(planRuns(harness, workspaceId)).toHaveLength(1);
    expect(rows(harness)).toEqual([]);
  });

  it("a result for a plan other than the one held is not applied to it: the plan reads as not checked", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const hold = taskOf(harness, taskId).planGrounding!;
    const key = (sha: string) => ({ pk: `DEVTASK#${taskId}`, sk: `E2E_GROUNDING#${sha}#${hold.attempt}` });
    const record = harness.db.get(key(hold.artifactSha256).pk, key(hold.artifactSha256).sk)!;
    // The task now names another digest than the plan the answer re-reads to (a plan that changed while it was held).
    const other = "f".repeat(64);
    harness.db.set({ ...taskOf(harness, taskId), planGrounding: { ...hold, artifactSha256: other } });
    harness.db.set({ ...record, ...key(other), planArtifactSha256: other, state: "RECORDED", results: { status: "PASSED", scenarios: [] }, findings: [] });
    for (const row of rows(harness)) harness.db.set({ ...row, candidateDigest: other });
    await sweep(harness);
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(harness, taskId)!.notes.at(-1)!.ownerSentence).toBe("Not checked against the current app: the check was refused for this plan.");
  });

  it("plans that are not grounded are not held: no must-not-change scenario, a run not asked for the unchanged code, and the check switched off (control: T5 behaviour)", async () => {
    const calls = { count: 0 };
    for (const variant of ["no-scenario", "not-asked", "off"] as const) {
      const harness = await createDeveloperTaskBroker({ brokerExtra: { planSelfCheck: true, startPlanGrounding: stub("start", calls), ...(variant === "off" ? { planGrounding: false } : {}) } });
      const { taskId, workspaceId } = await startTask(harness);
      const answer = variant === "no-scenario" ? planAnswer(planDocument({ e2e: planFixture({}).intent }), { checks: CHECKS }) : groundedAnswer();
      await finishPlanning(harness, workspaceId, answer, variant !== "not-asked");
      expect(taskOf(harness, taskId).planGrounding).toBeUndefined();
      // (A plan with no scenario proving a Not changing entry may be sent back by the plan rules, as in T5; it is never held.)
      if (variant !== "no-scenario") expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      expect(rows(harness).filter((row) => row.kind === "GROUNDING")).toEqual([]);
    }
    expect(calls.count).toBe(0);
  });
});

describe("a grounding round lost at delivery", () => {
  it("an old runner (the delivery refusal names the grounding feature) is recorded as worker-too-old, any other loss as run-failed; neither blocks the plan step", async () => {
    for (const [error, reason] of [["the plan grounding round needs a worker that runs grounding rounds (it must list task.workflowE2EGroundingChecks.v1); this worker predates it", "worker-too-old"], ["delivery gave up", "run-failed"]] as const) {
      const { harness, taskId, workspaceId } = await setup("start");
      await finishPlanning(harness, workspaceId, groundedAnswer());
      const hold = taskOf(harness, taskId).planGrounding!;
      const operationId = randomUUID();
      harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "ACCEPTED", fence: 9,
        workflowE2EAdmission: { purpose: "grounding", taskId, planArtifactSha256: hold.artifactSha256, attempt: hold.attempt } });
      harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", ...(harness.db.get(`WORKSPACE#${workspaceId}`, "META") as object), activeOperationId: operationId, fence: 9 });
      harness.db.set({ pk: `DEVTASK#${taskId}`, sk: `E2E_GROUNDING#${hold.artifactSha256}#${hold.attempt}`, ...(harness.db.get(`DEVTASK#${taskId}`, `E2E_GROUNDING#${hold.artifactSha256}#1`) as object), operationId });
      const lost = { id: randomUUID(), pk: `OUTBOX#x`, sk: "OUTBOX", entityType: "OUTBOX", status: "DISPATCHING", workspaceId, operationId, invocation: { kind: "task", fence: 9 } } as unknown as DurableOutboxRecord;
      harness.db.set(lost as never);
      await failOutboxOperation(harness.brokerInput.documentClient as never, "state", lost, error);
      expect(await readWorkflowE2EGroundingRecord({ documentClient: harness.brokerInput.documentClient as never, tableName: "state" }, { taskId, planArtifactSha256: hold.artifactSha256, attempt: hold.attempt })).toMatchObject({ state: "UNAVAILABLE", reason });
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
      // The row's next look finishes the hold.
      await sweep(harness);
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    }
  });
});

describe("the thread says it is checking the plan while the plan is held", () => {
  it("says the hold line only while the hold is on (no buttons: nothing to approve); the planning line is unchanged otherwise", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const workflow = workflowOf(harness, taskId);
    const held = workflowMessage({ taskId, ownerSlackUserId: "U1", workflow, planGroundingHeld: true })!;
    expect(held.text).toBe(PLAN_GROUNDING_HOLD_LINE);
    expect(JSON.stringify(held.blocks)).not.toContain("agentx_workflow_approve");
    const plain = workflowMessage({ taskId, ownerSlackUserId: "U1", workflow })!;
    expect(plain.text).toContain("Working on the coding plan.");
    expect(plain.text).not.toBe(held.text);
  });
});

/** A grounding round in flight for the held plan: its operation holds the workspace, and its record is STARTED under it. */
function plantRunningRound(harness: Harness, taskId: string, workspaceId: string, status = "RUNNING") {
  const hold = taskOf(harness, taskId).planGrounding!;
  const operationId = randomUUID();
  harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status, fence: 9, eventSequence: 0,
    requestId: randomUUID(), payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    workflowE2EAdmission: { purpose: "grounding", taskId, planArtifactSha256: hold.artifactSha256, attempt: hold.attempt, baseCommitSha: "a".repeat(40), roundId: "round-1", admissionRef: { key: "k", sha256: "b".repeat(64), byteLength: 1 } } });
  harness.db.set({ ...(harness.db.get(`WORKSPACE#${workspaceId}`, "META") as object), pk: `WORKSPACE#${workspaceId}`, sk: "META", activeOperationId: operationId, fence: 9, status: "READY" });
  const key = { pk: `DEVTASK#${taskId}`, sk: `E2E_GROUNDING#${hold.artifactSha256}#${hold.attempt}` };
  harness.db.set({ ...harness.db.get(key.pk, key.sk)!, operationId });
  return { operationId, hold, key };
}
const freeWorkspace = (harness: Harness, workspaceId: string) => {
  const { activeOperationId: _active, ...meta } = harness.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
  void _active;
  harness.db.set({ ...meta, pk: `WORKSPACE#${workspaceId}`, sk: "META" });
};

describe("fix round 1 (review of T7c)", () => {
  it("M5: a hold whose task was closed leaves no marker behind: the next look at it deletes the marker and nothing else is asked", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    expect(harness.db.find((item) => item.pk === "PLAN_GROUNDING_HOLD")).toHaveLength(1);
    harness.db.set({ ...taskOf(harness, taskId), closedAt: new Date().toISOString() });
    expect(await finishPlanGrounding(harness.brokerInput as never, taskId)).toBe("NOOP");
    expect(harness.db.find((item) => item.pk === "PLAN_GROUNDING_HOLD")).toEqual([]);
    expect(planRuns(harness, workspaceId)).toHaveLength(1);
  });

  it("B1: a held plan whose row gave up (the finish keeps failing) is not left running for ever: planning is blocked with its Retry, the hold, the row and the marker are gone", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const hold = taskOf(harness, taskId).planGrounding!;
    // The saved answer cannot be read, so every finish throws.
    for (const key of [...harness.s3.objects.keys()]) if (key.includes("/ARTIFACT") || key.endsWith("plan.md") || key.includes(hold.artifactId)) harness.s3.objects.delete(key);
    harness.db.set({ ...harness.db.get(`WORKSPACE#${workspaceId}`, `ARTIFACT#${hold.artifactId}`)!, objectKey: "private/missing/answer.md" });
    // The round ended, so every look goes on to read the answer back, and that keeps failing.
    const recordKey = { pk: `DEVTASK#${taskId}`, sk: `E2E_GROUNDING#${hold.artifactSha256}#${hold.attempt}` };
    harness.db.set({ ...harness.db.get(recordKey.pk, recordKey.sk)!, state: "RECORDED", results: { status: "PASSED", scenarios: [] }, findings: [] });
    for (let look = 0; look < 12; look += 1) await sweep(harness);
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    expect(taskOf(harness, taskId).planGrounding).toBeUndefined();
    expect(rows(harness)).toEqual([]);
    expect(harness.db.find((item) => item.pk === "PLAN_GROUNDING_HOLD")).toEqual([]);
  });

  it("B1: a hold whose row is gone is still found by the sweep and ended at its deadline, with the card and the timed-out reason", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const hold = taskOf(harness, taskId).planGrounding!;
    for (const row of rows(harness)) harness.db.delete?.(row.pk as string, row.sk as string);
    harness.db.set({ ...taskOf(harness, taskId), planGrounding: { ...hold, deadlineAt: "2000-01-01T00:00:00.000Z" } });
    for (const marker of harness.db.find((item) => item.pk === "PLAN_GROUNDING_HOLD")) harness.db.set({ ...marker, deadlineAt: "2000-01-01T00:00:00.000Z" });
    expect(harness.db.find((item) => item.pk === "PLAN_GROUNDING_HOLD")).toHaveLength(1);
    expect(rows(harness)).toEqual([]);
    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(harness, taskId)!.notes.at(-1)!.ownerSentence).toBe("Not checked against the current app: it ran out of time.");
    expect(harness.db.find((item) => item.pk === "PLAN_GROUNDING_HOLD")).toEqual([]);
  });

  it("I1: Close while the round runs stops it and closes the task (no TASK_BUSY); the abandoned finish never leaves PLAN/RUNNING with nothing running", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    plantRunningRound(harness, taskId, workspaceId, "CANCEL_REQUESTED");
    setTimeout(() => freeWorkspace(harness, workspaceId), 800);
    const closed = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    // And with no close following (the owner only pressed it once the round could not be stopped): the finish blocks planning instead of leaving it running.
    const other = await setup("start");
    await finishPlanning(other.harness, other.workspaceId, groundedAnswer());
    const hold = taskOf(other.harness, other.taskId).planGrounding!;
    other.harness.db.set({ ...taskOf(other.harness, other.taskId), planGroundingAbandoned: hold.artifactSha256 });
    expect(await finishPlanGrounding(other.harness.brokerInput as never, other.taskId)).toBe("FINISHED");
    expect(workflowOf(other.harness, other.taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    expect(taskOf(other.harness, other.taskId).planGrounding).toBeUndefined();
  });

  it("I2: a transient fault while the round runs does not mark it start-failed or stop it; a busy workspace at start waits", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const { key } = plantRunningRound(harness, taskId, workspaceId);
    const hold = taskOf(harness, taskId).planGrounding!;
    const saved = new Map(harness.s3.objects);
    for (const k of [...harness.s3.objects.keys()]) if (k.includes(hold.artifactId)) harness.s3.objects.delete(k);
    harness.db.set({ ...harness.db.get(`WORKSPACE#${workspaceId}`, `ARTIFACT#${hold.artifactId}`)!, objectKey: "private/missing/answer.md" });
    // The round ended well; reading the held plan back faults once.
    harness.db.set({ ...harness.db.get(key.pk, key.sk)!, state: "RECORDED", results: { status: "PASSED", scenarios: [] }, findings: [] });
    await sweep(harness);
    expect(harness.db.get(key.pk, key.sk)).toMatchObject({ state: "RECORDED" });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect(rows(harness)).toHaveLength(1);
    void saved;

    const busy = await createDeveloperTaskBroker({ brokerExtra: { planSelfCheck: true, startPlanGrounding: (async () => { throw agentXError("WORKSPACE_BUSY", "busy"); }) } });
    const run = await startTask(busy);
    await finishPlanning(busy, run.workspaceId, groundedAnswer());
    expect(workflowOf(busy, run.taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect(rows(busy)).toHaveLength(1);
  });

  it("M2: a mismatch names what the plan expected, in the plan's own words, never what the app showed", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    await settle(harness, taskId, { findings: [MISMATCH] });
    await finishPlanning(harness, workspaceId, groundedAnswer());
    await settle(harness, taskId, { findings: [MISMATCH] });
    const sentence = quality(harness, taskId)!.findings[0]!.ownerSentence;
    expect(sentence).toContain("The plan expects: 2 columns, 1 row.");
    expect(sentence).not.toContain("secret");
  });

  it("M4: the worker's terminal callback for the round ends the hold without any sweep", async () => {
    const { harness, taskId, workspaceId } = await setup("start");
    await finishPlanning(harness, workspaceId, groundedAnswer());
    const { operationId } = plantRunningRound(harness, taskId, workspaceId);
    harness.db.set({ pk: `OUTBOX#${operationId}`, sk: "OUTBOX", entityType: "OUTBOX", id: operationId, status: "DISPATCHED", workspaceId, operationId,
      invocation: { kind: "task", fence: 9, callbackCapability: issueCapability(harness.brokerInput, workspaceId, operationId, 9, false) } });
    await harness.finish(workspaceId, operationId, "CANCELLED");
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(quality(harness, taskId)!.notes.at(-1)!.ownerSentence).toBe("Not checked against the current app: it was stopped.");
  });
});
