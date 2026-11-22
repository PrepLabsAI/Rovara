import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";
import { randomUUID } from "node:crypto";
import { change, type MeterEntry } from "@agentx/contracts";
import { createHarness } from "./task-flow-harness.js";
import { createTaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { companyDayKey } from "../../packages/broker/src/core/cost/ledger.js";
import { holdKey } from "../../packages/broker/src/core/cost/holds.js";
import { createHostedAdmission, createHostedLedger, createHostedMoneyStop } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { createTaskSessionItems, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { recordRunCost, runCostInputOf } from "../../packages/broker/src/core/cost/estimate.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";

export async function closeRecoveryHarness(options: { money?: boolean; session?: boolean; flushed?: boolean; flushWaitMs?: number; deferUsage?: boolean } = {}) {
  const h = createHarness({ audit: "recording", companyId: COMPANY_A_ID });
  const now = () => new Date(h.clock.now);
  const metering = { async price() { return null; }, async record(e: MeterEntry) { return { cost: { micros: e.usage.tokens.input, currency: "USD" }, source: "price-table" as const }; } };
  const ledger = createHostedLedger({ store: h.store, metering, now });
  const booking = createUsageBooking({ store: h.store, metering, now });
  const settings = { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };
  if (options.money) {
    h.deps.admission = createHostedAdmission({ store: h.store, ledger, now, settings, runStopWired: true });
    h.deps.moneyStop = createHostedMoneyStop({ store: h.store, companyId: h.deps.companyId, now, settings }, { flushWaitMs: options.flushWaitMs ?? 0 });
  }
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "recover close" });
  const tk = taskKey(task.taskId), wk = workspaceKey(h.deps.companyId, task.workspaceId);
  const workspace = (await h.store.get(wk))!;
  const holder = textField(workspace, "activeOperationId"), inspected = operationKey(h.deps.companyId, task.workspaceId, holder);
  await h.store.update({ key: inspected, ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
  const runId = randomUUID(), runKey = operationKey(h.deps.companyId, task.workspaceId, runId);
  await h.store.put({ item: { ...(await h.store.get(inspected))!, ...runKey, id: runId, kind: "task", status: options.flushed ? "CANCELLED" : "RUNNING", machineId: "retained-machine", fence: 0 } });
  await h.store.update({ key: wk, ops: [change.set("machine", { machineId: "retained-machine", machineKey: "original" })] });
  const run: OperationRecord = (await readOperation(h.deps, task.workspaceId, runId))!;
  const sessionId = taskSessionId(task.taskId);
  if (options.session) {
    await h.store.transact(createTaskSessionItems({ orgId: h.deps.companyId, sessionId, taskId: task.taskId, project: "payments", agent: { agentId: "rovara-code", name: "Code", version: 1 }, title: "recover close", owner: h.owner.principal, origin: "app", payer: { kind: "member", developerId: "a".repeat(64) }, now: task.createdAt }));
    await h.store.update({ key: tk, ops: [change.set("sessionId", sessionId)] });
  }
  const usage = [{ type: "usage", timestamp: now().toISOString(), payload: { provider: "test", modelId: "m", checkpoint: !options.flushed, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } }];
  if (options.money && !options.deferUsage) await booking.bookOperationEvents(run, usage);
  let exclusive = true;
  const destroyed = new Set<string>(), terminated = new Set<string>(), cleaned = new Set<string>();
  h.machines.terminate = async (id) => { terminated.add(id); };
  h.deps.taskEnded = async ({ taskId }) => { cleaned.add(taskId); };
  h.deps.onTaskClosed = async (closed, closedAt) => { await recordRunCost({ store: h.store }, { orgId: h.deps.companyId, project: closed.project, taskId: closed.taskId, path: "FULL", endedAt: closedAt, ...runCostInputOf(await ledger.taskCost(h.deps.companyId, closed.taskId)) }); };
  h.deps.closeInspection = {
    async raiseFence() {},
    async inspectWorkspaceForClose() { return { inspection: { safeToClose: true, repositories: [], contentDigest: "a".repeat(64) }, retentionId: "snapshot" }; },
    async retained() { return exclusive; },
    async destroyRetained(input) {
      if (destroyed.has(input.effectId)) return true;
      if (!exclusive || input.retentionId !== "snapshot" || input.contentDigest !== "a".repeat(64)) return false;
      for (const id of input.machineIds) await h.machines.terminate(id);
      destroyed.add(input.effectId); return true;
    },
  };
  await prepareCloseInspection(h.deps, task.workspaceId, holder);
  const preview = await h.flow.previewClose(h.owner, task.taskId, "close");
  if (preview.preview === null) throw new Error("no preview");
  const input = { requestId: randomUUID(), expectedPreviewDigest: preview.preview.digest };
  const restart = () => { delete h.deps.resumeAcceptedClose; h.flow = createTaskFlow(h.deps); };
  const pump = async () => { await h.flow.relayOnce(); h.clock.advance(31); await h.flow.dispatchOnce({ maxMessages: 10 }); };
  const accepted = async (): Promise<OperationRecord | undefined> => {
    const row = (await h.store.get(tk))!;
    return readOperation(h.deps, task.workspaceId, textField(row, "closeOperationId"));
  };
  const money = async () => {
    const day = await h.store.get(companyDayKey(h.deps.companyId, "2026-11-09"));
    const record = (await readTask(h.deps, task.taskId))!;
    const hold = record.admissionReservationId === undefined ? undefined : await h.store.get(holdKey(h.deps.companyId, record.admissionReservationId));
    const cost = await ledger.taskCost(h.deps.companyId, task.taskId);
    return { micros: cost.micros, entries: cost.entries, unpriced: cost.unpricedEntries, load: day?.loadMicros, usd: day?.usdMicros, reserved: day?.reservedMicros, settled: day?.settledMicros, estimated: day?.estimatedMicros, hold: hold?.state, kept: hold?.keptMicros };
  };
  return { h, task, tk, wk, inspected, input, restart, pump, accepted, money, ledger, booking, usage, run, runKey, sessionId, destroyed, terminated, cleaned, loseProof: () => { exclusive = false; } };
}

export function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`missing ${key}`);
  return value;
}
