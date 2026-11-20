import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { type E2EDisplayBaseline } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { E2E_BASELINE_RUN_GRACE_MS, baselineStartItem, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaseline, readWorkflowE2EBaselineRecord, requestWorkflowE2EBaselineRound, workflowE2EBaselineView } from "../../packages/broker/src/aws/workflow-e2e-baseline.js";
import { failedBaseline } from "../support/e2e-scenario-results.js";

// M1.3 Task 3.7b, review findings F1, F3, F8 and F9: the baseline round has a record of its own, beside the task. It is written once per approved plan, says when the round
// started and by when it must have ended, is keyed by the plan, the base commit and the attempt, and expires.

const PLAN = "a".repeat(64);
const BASE = "b".repeat(40);
const task = (overrides: Record<string, unknown> = {}) => ({ taskId: "11111111-1111-4111-8111-111111111111", ownerKey: "owner", workspaceId: "22222222-2222-4222-8222-222222222222",
  workflow: { e2e: { required: true, contractDigest: PLAN, applicationSelection: {} } }, ...overrides }) as never;
const store = () => { const db = new FakeDynamoDb(); return { db, documentClient: db as never, tableName: "state" }; };
const key = { pk: "DEVTASK#11111111-1111-4111-8111-111111111111", sk: `E2E_BASELINE#${PLAN}` };
const started = (overrides: Record<string, unknown> = {}) => ({ baseCommitSha: BASE, operationId: "op-1", roundId: "round-1", admissionSha256: "c".repeat(64),
  startedAt: "2026-10-21T10:00:00.000Z", deadlineAt: "2026-10-21T10:25:00.000Z", ...overrides });
const start = (s: ReturnType<typeof store>, overrides: Record<string, unknown> = {}) =>
  s.db.send(new TransactWriteCommand({ TransactItems: [baselineStartItem(s, task(), started(overrides))] }));

describe("asking for a baseline round at APPROVE (once per approved plan)", () => {

  it("asks at most once for a plan: a second approval of the same plan finds the record and changes nothing", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s);
    const before = JSON.stringify(await readWorkflowE2EBaselineRecord(s, task()));
    expect(await requestWorkflowE2EBaselineRound(s, task(), { enabled: true })).toBe("ALREADY");
    expect(JSON.stringify(await readWorkflowE2EBaselineRecord(s, task()))).toBe(before);
  });

});

describe("the sentence for a baseline that did not run shows without any candidate rows (F9) and after a dead runner (F3)", () => {
  const recordOf = async (s: ReturnType<typeof store>) => (await readWorkflowE2EBaselineRecord(s, task()))!;

  it("marks unavailable only the record it was meant for: not a recorded result, not another operation's round", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s);
    expect(await markWorkflowE2EBaselineUnavailable(s, task(), "run-failed", { from: ["STARTED"], operationId: "someone-else" })).toBe(false);
    expect(await recordOf(s)).toMatchObject({ state: "STARTED" });
    const recorded: E2EDisplayBaseline = failedBaseline();
    s.db.set({ ...s.db.get(key.pk, key.sk)!, state: "RECORDED", baseline: recorded, recordedAt: "2026-10-21T10:10:00.000Z" });
    expect(await markWorkflowE2EBaselineUnavailable(s, task(), "timed-out", { from: ["STARTED"], operationId: "op-1" })).toBe(false);
    expect(await readWorkflowE2EBaseline(s, task())).toEqual(recorded);
  });
});

// M1.4 Task 4.4c (BASEREASON): the reason a baseline did not run, and the AI-navigated scenarios a baseline that did run left out, ride on the record and into the baseline's view.
describe("the baseline says why it did not run, and which AI-navigated checks it left out (Task 4.4c)", () => {
  const SKIPPED = [{ scenarioId: "agent-orders", title: "Agent orders" }];
  const recordOf = async (s: ReturnType<typeof store>) => (await readWorkflowE2EBaselineRecord(s, task()))!;

  it("a plan that is all AI navigation reads agent-steps-only on the page, not the generic sentence", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    expect(await markWorkflowE2EBaselineUnavailable(s, task(), "agent-steps-only", { from: ["REQUESTED"] })).toBe(true);
    expect(await recordOf(s)).toMatchObject({ state: "UNAVAILABLE", reason: "agent-steps-only" });
    expect(workflowE2EBaselineView(await recordOf(s), Date.now())).toEqual({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" });
    expect(await readWorkflowE2EBaseline(s, task())).toEqual({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" });
  });

  it("does not show a skipped list from the record of a round that did not record (a started round has no baseline to attach it to)", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s, { skippedAiScenarios: SKIPPED });
    expect(workflowE2EBaselineView(await recordOf(s), Date.parse("2026-10-21T10:10:00.000Z"))).toBeUndefined();
    expect(workflowE2EBaselineView(await recordOf(s), Date.parse("2026-10-21T10:25:00.000Z") + E2E_BASELINE_RUN_GRACE_MS + 1)).toEqual({ status: "UNAVAILABLE", scenarios: [] });
  });
});
