// FEEDBACK-REVIEW-USAGE-FIX (1): a PR-feedback review run's usage, as the worker sends it, is booked by the broker like any other run's, so the hosted task-spend reader (`createCompanyTaskSpend`) counts it and the
// NEXT paid move on the task (a Fix, a Retry) is admitted instead of refusing with `run_unreported`. Fixtures use the worker's real usage payloads (`createTaskUsageTelemetry`, `createUsageCheckpointer`), not hand-made ones.
// Negative controls keep the reader strict: a run whose usage was never booked still refuses (mutant M6: never exempt FEEDBACK_REVIEW from the check).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHostedMetering } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { TASK_SPEND_UNKNOWN, createCompanyTaskSpend, type TaskSpendRefusal } from "../../packages/broker/src/core-host/company-task-spend.js";
import { admitRound } from "../../packages/broker/src/core/task-flow/owner-round.js";
import { feedbackRoundOptions } from "../../packages/broker/src/core/pr-feedback/money.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createTaskUsageTelemetry, createUsageCheckpointer, usageForControlPlane } from "../../packages/worker/src/usage.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { companyDayKey } from "../../packages/broker/src/core/cost/ledger.js";
import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";

const COMPANY = COMPANY_A_ID as OrgId;
const NOW = new Date("2026-11-23T05:57:00.000Z");
const HAIKU = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" };
const PRICE = { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 5_000_000 };
const metering = createHostedMetering({
  find: (model) => (model.modelId === HAIKU.modelId ? { price: PRICE, currency: "USD", origin: "catalog" } : undefined),
  findCap: (model) => (model.modelId === HAIKU.modelId ? { price: PRICE, currency: "USD", origin: "catalog" } : undefined),
});

const stats = (input: number, output: number, cost: number) => ({ sessionFile: "s", sessionId: "s", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output }, cost });
/** The worker's end report for a session that spent `cost` (no checkpoints): `usageForControlPlane(createTaskUsageTelemetry(...))`. */
const endReport = (cost: number, input = 4000, output = 600, outcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED") => usageForControlPlane(createTaskUsageTelemetry(stats(input, output, cost), HAIKU, outcome), {});
const event = (payload: unknown, timestamp = NOW.toISOString()) => ({ type: "usage", timestamp, payload });

interface Run { id: string; mode: string; status: string; machine?: boolean }
async function world(runs: Run[]) {
  const store = new MemoryDocumentStore();
  const taskId = randomUUID(), workspaceId = randomUUID();
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: COMPANY, workspaceId, project: "demo", developerId: "a".repeat(64), ownerKey: "owner" } });
  await store.put({ item: { ...workspaceKey(COMPANY, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: COMPANY, orgId: COMPANY } });
  await store.put({ item: { ...taskPointerKey(COMPANY, workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
  let n = 0;
  for (const run of runs) {
    n += 1;
    await store.put({ item: { ...operationKey(COMPANY, workspaceId, run.id), entityType: "OPERATION", id: run.id, companyId: COMPANY, workspaceId, kind: "task", workflowMode: run.mode, status: run.status, ...(run.machine === false ? {} : { machineId: "machine-1" }), createdAt: `2026-11-23T05:0${n}:00.000Z`, fence: n } });
  }
  const booking = createUsageBooking({ store, metering, now: () => NOW });
  const book = (runId: string, ...payloads: unknown[]) => booking.bookOperationEvents({ id: runId, workspaceId, companyId: COMPANY }, payloads.map((payload) => event(payload)));
  const reasons: TaskSpendRefusal[] = [];
  const spend = createCompanyTaskSpend({ store, companyId: COMPANY, refused: (reason) => { reasons.push(reason); } });
  const entries = async () => (await store.query({ pk: costPartition(COMPANY, taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items;
  return { store, taskId, workspaceId, book, spend, reasons, entries };
}
const HEALTHY: Run[] = [{ id: "run-impl", mode: "IMPLEMENT", status: "SUCCEEDED" }, { id: "run-review", mode: "REVIEW", status: "SUCCEEDED" }];
const WITH_FEEDBACK: Run[] = [...HEALTHY, { id: "run-feedback", mode: "FEEDBACK_REVIEW", status: "SUCCEEDED" }];

describe("a PR-feedback review's usage reaches the cost ledger", () => {
  it("before the fix a task whose feedback review reported nothing refuses its spend read (run_unreported): the strict reader is not loosened", async () => {
    const w = await world(WITH_FEEDBACK);
    await w.book("run-impl", endReport(0.3));
    await w.book("run-review", endReport(0.0875));
    await expect(w.spend(w.taskId)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    expect(w.reasons).toEqual(["run_unreported"]);
  });

  it("with the feedback run's end report booked, the spend is the sum INCLUDING the review and the next Fix is admitted", async () => {
    const w = await world(WITH_FEEDBACK);
    await w.book("run-impl", endReport(0.3));
    await w.book("run-review", endReport(0.0875));
    await w.book("run-feedback", endReport(0.0346, 5200, 640));
    // 0.3 + 0.0875 + 0.0346 (each priced at max(table, reported), so the reported cost, which is higher than the small table price)
    expect(await w.spend(w.taskId)).toBeCloseTo(0.4221, 6);
    expect(w.reasons).toEqual([]);
    const deps = { companyId: COMPANY, taskCapUsd: async () => 1, taskSpendUsd: w.spend, projects: { latest: async () => ({ archived: false }) }, access: { checkStep: async () => ({ allowed: true }) },
      admission: { admit: async () => ({ allowed: true }), release: async () => undefined } } as unknown as TaskFlowDeps;
    const task = { taskId: w.taskId, project: "demo" } as never;
    await expect(admitRound(deps, feedbackRoundOptions(deps), { task, caller: { principal: { personId: "a".repeat(64), roles: [] } } as never, requestId: "fix-1" })).resolves.toBeUndefined();
    // The same move on the same task without the feedback run's usage refuses, exactly as on the owner's task.
    const broken = await world(WITH_FEEDBACK);
    await broken.book("run-impl", endReport(0.3));
    await broken.book("run-review", endReport(0.0875));
    const brokenDeps = { ...deps, taskSpendUsd: broken.spend } as unknown as TaskFlowDeps;
    await expect(admitRound(brokenDeps, feedbackRoundOptions(brokenDeps), { task: { taskId: broken.taskId, project: "demo" } as never, caller: { principal: { personId: "a".repeat(64), roles: [] } } as never, requestId: "fix-1" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("the booked entry is the standard usage entry of that run (usage:<operation>:...), counted once when the batch is sent again", async () => {
    const w = await world(WITH_FEEDBACK);
    const report = endReport(0.0346);
    expect(await w.book("run-feedback", report)).toEqual({ booked: 1, unreadable: 0 });
    expect(await w.book("run-feedback", report)).toEqual({ booked: 0, unreadable: 0 });
    const rows = (await w.entries()).filter((row) => String(row["sk"]).startsWith("ENTRY#usage:run-feedback:"));
    expect(rows).toHaveLength(1);
    expect(await w.store.get({ pk: costPartition(COMPANY, w.taskId), sk: "TOTAL" })).toMatchObject({ entries: 1, unpricedEntries: 0 });
  });

  it("with checkpoints, the checkpoints and the final end report tell the spend once, and the run counts as reported only by its end report", async () => {
    const w = await world(WITH_FEEDBACK);
    await w.book("run-impl", endReport(0.3));
    await w.book("run-review", endReport(0.0875));
    // The worker's own checkpointer, driven with real stats: a checkpoint after the first model call, then the end report with what is left.
    const sent: Array<Record<string, unknown>> = [];
    let current = stats(2000, 300, 0.02);
    const checkpointer = createUsageCheckpointer({ enabled: true, intervalMs: 0, baseline: undefined, stats: () => current, model: () => HAIKU, requested: {}, send: (payload) => { sent.push(payload); } });
    checkpointer.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 2000, output: 300, cost: { total: 0.02 } }, content: [{ type: "text", text: "x" }] } });
    expect(sent).toHaveLength(1);
    await w.book("run-feedback", ...sent);
    // Checkpoints alone never make the run reported.
    await expect(w.spend(w.taskId)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    current = stats(3000, 450, 0.03);
    const end = checkpointer.endReport(current, HAIKU, "SUCCEEDED", {});
    expect(end).toBeDefined();
    await w.book("run-feedback", end);
    expect(await w.spend(w.taskId)).toBeCloseTo(0.3 + 0.0875 + 0.03, 6);
  });

  it("a feedback run that FAILED after reaching a machine is accepted only with its end report booked", async () => {
    const runs: Run[] = [...HEALTHY, { id: "run-feedback", mode: "FEEDBACK_REVIEW", status: "FAILED" }];
    const without = await world(runs);
    await without.book("run-impl", endReport(0.3));
    await without.book("run-review", endReport(0.0875));
    await expect(without.spend(without.taskId)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    const withReport = await world(runs);
    await withReport.book("run-impl", endReport(0.3));
    await withReport.book("run-review", endReport(0.0875));
    await withReport.book("run-feedback", endReport(0.01, 800, 100, "FAILED"));
    expect(await withReport.spend(withReport.taskId)).toBeCloseTo(0.3975, 6);
  });

  // C3: the laptop wires no booking hook (it meters at its own model proxy), so the new event is stored with the run's events and adds nothing to any ledger there.
  it("on a install with no booking hook (the laptop) the feedback review's usage event is stored and books nothing: the ledger total is unchanged", async () => {
    const opId = randomUUID();
    const w = await world([...HEALTHY, { id: opId, mode: "FEEDBACK_REVIEW", status: "RUNNING" }]);
    const key = "k".repeat(40);
    await w.store.put({ item: { ...operationKey(COMPANY, w.workspaceId, opId), entityType: "OPERATION", id: opId, workspaceId: w.workspaceId, companyId: COMPANY, kind: "task", status: "RUNNING", fence: 1, eventSequence: 0 } });
    const flow = { store: w.store, companyId: COMPANY, callbackSigningKey: key, now: () => NOW, log: () => undefined } as unknown as TaskFlowDeps;
    const handler = createCallbackHandler({ flow, blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } } });
    const token = new CallbackCapabilities(Buffer.from(key)).issue({ workspaceId: w.workspaceId, operationId: opId, fence: 1, actions: ["events"], expiresInSeconds: 600 });
    const answer = await handler({ method: "POST", path: `/v1/internal/workspaces/${w.workspaceId}/operations/${opId}/events`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ events: [event(endReport(0.0346))] }) });
    expect(answer.statusCode).toBe(200);
    expect(await w.entries()).toEqual([]);
    expect(await w.store.get({ pk: costPartition(COMPANY, w.taskId), sk: "TOTAL" })).toBeUndefined();
    expect(await w.store.get(companyDayKey(COMPANY, "2026-11-23"))).toBeUndefined();
  });
});
