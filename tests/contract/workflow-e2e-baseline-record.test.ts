import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { indexExpiresAt, type E2EDisplayBaseline } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import {
  E2E_BASELINE_ATTEMPT, E2E_BASELINE_RUN_GRACE_MS, baselineStartItem, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaseline, readWorkflowE2EBaselineRecord,
  requestWorkflowE2EBaselineRound, workflowE2EBaselineView,
} from "../../packages/broker/src/aws/workflow-e2e-baseline.js";
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
  it("writes a REQUESTED record for an approved application plan, with the plan digest, the attempt and an expiry", async () => {
    const s = store();
    expect(await requestWorkflowE2EBaselineRound(s, task(), { enabled: true })).toBe("REQUESTED");
    const stored = s.db.get(key.pk, key.sk);
    expect(stored).toMatchObject({ entityType: "WORKFLOW_E2E_BASELINE", taskId: "11111111-1111-4111-8111-111111111111", contractDigest: PLAN, purpose: "baseline",
      attempt: E2E_BASELINE_ATTEMPT, state: "REQUESTED" });
    expect(typeof stored!.requestedAt).toBe("string");
    // F8 (owner decision D4): it expires on the table's TTL attribute, 30 days after it was written.
    expect(stored!.indexExpiresAt).toBe(indexExpiresAt(String(stored!.requestedAt)));
  });

  it("asks at most once for a plan: a second approval of the same plan finds the record and changes nothing", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s);
    const before = JSON.stringify(await readWorkflowE2EBaselineRecord(s, task()));
    expect(await requestWorkflowE2EBaselineRound(s, task(), { enabled: true })).toBe("ALREADY");
    expect(JSON.stringify(await readWorkflowE2EBaselineRecord(s, task()))).toBe(before);
  });

  it("asks for nothing when the project switched the baseline off, or the approved plan is not an application plan", async () => {
    const off = store();
    expect(await requestWorkflowE2EBaselineRound(off, task(), { enabled: false })).toBe("NOT_REQUESTED");
    expect(off.db.items.size).toBe(0);
    const portable = store();
    expect(await requestWorkflowE2EBaselineRound(portable, task({ workflow: { e2e: { required: true, contractDigest: PLAN } } }), { enabled: true })).toBe("NOT_REQUESTED");
    expect(await requestWorkflowE2EBaselineRound(portable, task({ workflow: {} }), { enabled: true })).toBe("NOT_REQUESTED");
    expect(portable.db.items.size).toBe(0);
  });

  it("a different approved plan is a different record: its own request, and the first plan's result is not shown for it", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    const other = task({ workflow: { e2e: { required: true, contractDigest: "d".repeat(64), applicationSelection: {} } } });
    expect(await readWorkflowE2EBaselineRecord(s, other)).toBeUndefined();
    expect(await requestWorkflowE2EBaselineRound(s, other, { enabled: true })).toBe("REQUESTED");
  });
});

describe("starting the baseline round writes a started record, once", () => {
  it("moves REQUESTED to STARTED with the operation, the round, the base commit, the admission and the deadline", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s);
    expect(await readWorkflowE2EBaselineRecord(s, task())).toMatchObject({ state: "STARTED", attempt: 1, baseCommitSha: BASE, operationId: "op-1", roundId: "round-1",
      admissionSha256: "c".repeat(64), startedAt: "2026-10-21T10:00:00.000Z", deadlineAt: "2026-10-21T10:25:00.000Z" });
  });

  it("starts at most once: a second start (a retry, another dispatcher) is refused by the record", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s);
    await expect(start(s, { operationId: "op-2", roundId: "round-2" })).rejects.toThrow();
    expect(await readWorkflowE2EBaselineRecord(s, task())).toMatchObject({ operationId: "op-1" });
  });

  it("cannot start a plan that was never requested", async () => {
    const s = store();
    await expect(start(s)).rejects.toThrow();
  });
});

describe("the sentence for a baseline that did not run shows without any candidate rows (F9) and after a dead runner (F3)", () => {
  const at = (iso: string) => Date.parse(iso);
  const recordOf = async (s: ReturnType<typeof store>) => (await readWorkflowE2EBaselineRecord(s, task()))!;

  it("shows nothing while the baseline is only requested, or while it is running within its time", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    expect(workflowE2EBaselineView(await recordOf(s), at("2026-10-21T10:30:00.000Z"))).toBeUndefined();
    await start(s);
    expect(workflowE2EBaselineView(await recordOf(s), at("2026-10-21T10:10:00.000Z"))).toBeUndefined();
    expect(workflowE2EBaselineView(await recordOf(s), at("2026-10-21T10:25:00.000Z") + E2E_BASELINE_RUN_GRACE_MS)).toBeUndefined();
  });

  it("shows that the unchanged code could not be checked once a started round is past its deadline and the grace, with no result", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    await start(s);
    expect(workflowE2EBaselineView(await recordOf(s), at("2026-10-21T10:25:00.000Z") + E2E_BASELINE_RUN_GRACE_MS + 1)).toEqual({ status: "UNAVAILABLE", scenarios: [] });
  });

  it("shows the same for a round that was marked unavailable, with the reason on the record", async () => {
    const s = store();
    await requestWorkflowE2EBaselineRound(s, task(), { enabled: true });
    expect(await markWorkflowE2EBaselineUnavailable(s, task(), "not-exported", { from: ["REQUESTED"] })).toBe(true);
    expect(await recordOf(s)).toMatchObject({ state: "UNAVAILABLE", reason: "not-exported" });
    expect(workflowE2EBaselineView(await recordOf(s), Date.now())).toEqual({ status: "UNAVAILABLE", scenarios: [] });
    expect(await readWorkflowE2EBaseline(s, task())).toEqual({ status: "UNAVAILABLE", scenarios: [] });
  });

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
