import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2EScenarioResultsSchema } from "@agentx/contracts";
import { workflowE2ENotifierBlocks } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA } from "../support/developer-task-broker.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";
import { FAIL, PASS, caseIdsOf, operatorEvidenceWith, runRound } from "../support/e2e-application-round-run.js";
import { OTHER_SHOT, SHOT, SHOT_SHA } from "../support/e2e-scenario-results.js";

// M1.3 Task 3.7 on the real broker: the rows of an application round are derived from the evidence the broker verified itself, shown on the page and in Slack, and kept
// (with the screenshots) in the display the notifier reads. Nothing the worker says about itself becomes a row, and no email or credential reaches one.

afterEach(disposeRealCandidates);

const brokerModule = () => import("../../packages/broker/src/aws/broker.js");
const operations = (round: ApplicationRound) => round.operationRows(() => true);
const scenarioResultsOf = async (round: ApplicationRound, actor: "owner" | "viewer" = "owner") =>
  (await brokerModule()).loadWorkflowE2EScenarioResults(round.harness.brokerInput as never, round.taskNow() as never, operations(round), actor);
const presentationOf = async (round: ApplicationRound) =>
  (await brokerModule()).loadWorkflowE2EPresentation(round.harness.brokerInput as never, round.taskNow() as never, operations(round), "owner");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const e2eOf = (round: ApplicationRound) => round.workflowNow().e2e as { qualifiedRound?: unknown; failedRound?: unknown; displayRef?: { key: string; sha256: string } };
const SECRETS = ["ops@tenant-a.example", "hunter2-secret", "tenant-a-session-cookie-9f8e7d6c"];
const dirtyLog = `${SECRETS[0]} signed in with password=${SECRETS[1]} cookie=${SECRETS[2]}`;

describe("the rows of an application round on the real broker", () => {
  it("a failed case shows its expected and actual, its account label and a link to its screenshot, on the page, in Slack and in the stored display", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }], { executorLogHead: dirtyLog }); } });
    expect(round.workflowNow(), JSON.stringify(round.workflowNow())).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(e2eOf(round).failedRound).toBeDefined();

    const found = await scenarioResultsOf(round);
    expect(found?.scenarios).toHaveLength(1);
    expect(found!.scenarios[0]).toMatchObject({ scenarioId: "orders-health-0", title: "Orders health 0", kind: "api", status: "FAILED", reason: "expected 200, received 503",
      failedAssertion: { kind: "http-status", expected: "200", actual: "503" }, screenshotRef: { sha256: SHOT_SHA, bytes: SHOT.byteLength, contentType: "image/jpeg" }, mockedOrigins: [] });
    expect(found!.scenarios[0]!.accountLabel).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    expect(E2EScenarioResultsSchema.safeParse(found).success).toBe(true);

    const presentation = (await presentationOf(round))!;
    expect(presentation.pageHtml).toContain('data-e2e-row="orders-health-0"');
    expect(presentation.pageHtml).toContain("expected 200, received 503");
    expect(JSON.stringify(presentation.slackBlocks)).toContain("Browser and API checks: 0 passed, 1 failed, 0 incomplete");
    expect(JSON.stringify(presentation.slackBlocks)).toContain("Orders health 0 — failed: expected 200, received 503");

    // The display the notifier reads is version 2 and carries the rows; the screenshot is a private object by its digest.
    const task = round.taskNow() as { ownerKey: string; workspaceId: string; taskId: string };
    const display = round.harness.s3.objects.get(e2eOf(round).displayRef!.key)!;
    expect(JSON.parse(display)).toMatchObject({ displaySchemaVersion: 2, scenarios: [{ scenarioId: "orders-health-0", status: "FAILED", reason: "expected 200, received 503" }] });
    const stored = (round.harness.s3 as unknown as { binary: Map<string, Buffer> }).binary.get(`private/${task.ownerKey}/${task.workspaceId}/workflow-e2e-artifacts/${SHOT_SHA}`);
    expect(stored && sha(stored)).toBe(SHOT_SHA);

    const blocks = await workflowE2ENotifierBlocks({ task: round.taskNow() as never, taskPageUrl: `https://agentx.test/review/${task.taskId}/task`,
      readPrivateObject: async (key) => { const text = round.harness.s3.objects.get(key); return text === undefined ? undefined : Buffer.from(text, "utf8"); } });
    expect(JSON.stringify(blocks)).toContain("Orders health 0 — failed: expected 200, received 503");
  });

  it("shows no seeded email or credential on any surface, the stored display included", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }], { executorLogHead: dirtyLog });
      (groupRun as { diagnostics: unknown }).diagnostics = { note: dirtyLog }; } });
    const presentation = (await presentationOf(round))!;
    const surfaces = [JSON.stringify(await scenarioResultsOf(round)), presentation.pageHtml, JSON.stringify(presentation.slackBlocks), JSON.stringify(presentation.shared),
      round.harness.s3.objects.get(e2eOf(round).displayRef!.key)!];
    for (const surface of surfaces) for (const secret of SECRETS) expect(surface).not.toContain(secret);
  });

  it("ignores every display field the worker supplies: the rows are what the broker verified", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => {
      groupRun.scenarios = [{ scenarioId: "orders-health-0", title: "Everything is fine", status: "PASSED" }];
      groupRun.display = { scenarios: [{ status: "PASSED" }] };
      groupRun.operatorEvidence = { ...operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]), scenarios: [{ status: "PASSED" }], verdict: "PASS" };
    } });
    const found = await scenarioResultsOf(round);
    expect(found!.scenarios.map((item) => [item.scenarioId, item.title, item.status])).toEqual([["orders-health-0", "Orders health 0", "FAILED"]]);
    expect(JSON.stringify(found)).not.toContain("Everything is fine");
    expect(e2eOf(round).failedRound).toBeDefined();
  });

  it("never shows an actual value the collector did not re-derive: a value the worker changed after the fact makes the case incomplete, with no failure detail", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => {
      const captures = (groupRun.actual as { collection: { applicationCaptures: Array<{ assertions: Array<{ value: unknown }> }> } }).collection.applicationCaptures;
      captures[0]!.assertions[0]!.value = 418;
      groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]);
    } });
    const found = await scenarioResultsOf(round);
    expect(found!.scenarios).toHaveLength(1);
    expect(found!.scenarios[0]).toMatchObject({ status: "UNKNOWN", reason: "this check could not be verified" });
    expect(found!.scenarios[0]!.failedAssertion).toBeUndefined();
    expect(JSON.stringify(found)).not.toContain("418");
    expect(e2eOf(round).failedRound).toBeUndefined();
  });

  it("keeps a screenshot only for a case of the group, as a JPEG of the listed digest, and never for a case that passed", async () => {
    const round = await startApplicationRound({ applications: 2 });
    const [first, second] = caseIdsOf(round);
    // Every case of the group is offered a screenshot, and so is a case the group does not have; only the failed case's can be shown.
    await runRound(round, [[PASS, FAIL]], { tweak: (groupRun) => {
      groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: first!, bytes: SHOT }, { caseId: second!, bytes: OTHER_SHOT }, { caseId: randomUUID(), bytes: Buffer.concat([SHOT, Buffer.from([1])]) }]);
    } });
    const found = await scenarioResultsOf(round);
    const byStatus = (status: string) => found!.scenarios.filter((item) => item.status === status);
    expect(byStatus("PASSED")).toHaveLength(1);
    expect(byStatus("PASSED")[0]!.screenshotRef).toBeUndefined();
    expect(byStatus("FAILED")).toHaveLength(1);
    expect([sha(SHOT), sha(OTHER_SHOT)]).toContain(byStatus("FAILED")[0]!.screenshotRef?.sha256);
  });

  it("shows a passed round as passed rows with no failure detail and no screenshots", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [PASS], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } });
    expect(round.workflowNow()).toMatchObject({ stage: "REVIEW" });
    const found = await scenarioResultsOf(round);
    expect(found!.scenarios).toHaveLength(1);
    expect(found!.scenarios[0]).toMatchObject({ status: "PASSED" });
    expect(found!.scenarios[0]!.failedAssertion).toBeUndefined();
    expect(found!.scenarios[0]!.screenshotRef).toBeUndefined();
    expect(JSON.stringify((await presentationOf(round))!.slackBlocks)).toContain("Browser and API checks: 1 passed, 0 failed, 0 incomplete");
  });

  it("labels two accounts of one application by their profile ids", async () => {
    const round = await startApplicationRound({ accounts: ["orders-owner", "orders-viewer"] });
    await runRound(round, [[PASS, PASS]]);
    const found = await scenarioResultsOf(round);
    expect(found!.scenarios.map((item) => item.accountLabel).sort()).toEqual(["orders-owner", "orders-viewer"]);
  });

  it("shows nothing while the round has no accepted evidence, and a round that is running as incomplete", async () => {
    const round = await startApplicationRound();
    expect(await scenarioResultsOf(round)).toBeUndefined();
    round.markRunning();
    const groups = await round.collectGroup(round.groupIds[0]!, PASS);
    const uploaded = await round.upload(round.groupEnvelope(groups.groupRun), { groupRunId: groups.runId });
    expect(uploaded.response.status).toBe(200);
    const found = await scenarioResultsOf(round);
    expect(found?.scenarios.every((item) => item.status === "UNKNOWN")).toBe(true);
    expect(found?.scenarios[0]?.reason).toBe("the checks have not finished");
  });

  it("a task closed after its round keeps showing the rows recorded in its display", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } });
    const task = round.taskNow() as Record<string, unknown>;
    round.harness.db.set({ ...task, closedAt: new Date().toISOString() });
    const closed = await scenarioResultsOf(round);
    expect(closed?.scenarios.map((item) => item.status)).toEqual(["FAILED"]);
  });

  it("is on the task page's document view, for its owner", async () => {
    const round = await startApplicationRound();
    const [caseId] = caseIdsOf(round);
    await runRound(round, [FAIL], { tweak: (groupRun) => { groupRun.operatorEvidence = operatorEvidenceWith([{ caseId: caseId!, bytes: SHOT }]); } });
    const maya = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name };
    const input = round.harness.brokerInput as { documentClient: never; tableName: string; developer: never };
    const broker = await brokerModule();
    const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: round.harness.actions as never,
      ...broker.workflowApplicationRouteDependencies(round.harness.brokerInput as never) }, maya);
    const view = await getTaskDocumentView(deps, maya, round.taskId);
    expect(view.e2eResults?.scenarios.map((item) => [item.scenarioId, item.status, item.reason])).toEqual([["orders-health-0", "FAILED", "expected 200, received 503"]]);
    expect(view.e2eResults?.scenarios[0]?.screenshotRef?.sha256).toBe(SHOT_SHA);
  });
});
