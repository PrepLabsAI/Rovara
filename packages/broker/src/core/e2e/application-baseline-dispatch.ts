// The retired runBaselineRoundFirst policy on core record ports. A baseline holds the worker for a bounded time;
// its evidence is settled only by settleNonCandidateRound and never becomes candidate verification.
import type { OperationStatus } from "@agentx/contracts";
import { E2E_BASELINE_RUN_GRACE_MS, baselineStartFailureReason, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaselineRecord } from "./baseline.js";
import type { E2EStateStore } from "./state.js";
import type { TaskRecord } from "../task-flow/records.js";
import type { StepStart } from "../task-flow/stage-machine.js";

export interface BaselineDispatchPorts {
  start(): Promise<StepStart>;
  operation(id: string): Promise<{ id: string; status: OperationStatus } | undefined>;
  activeOperationId(): Promise<string | null | undefined>;
  cancel(id: string): Promise<void>;
  settle(id: string): Promise<void>;
}
const HOLD_LIMIT_MS = 20 * 60_000;
const terminal = new Set<OperationStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
export const BASELINE_STOPPED_REASON = "The check on the unchanged code was stopped, so the checks were stopped with it. Retry the checks when you are ready.";
export const BASELINE_STUCK_REASON = "The check on the unchanged code did not stop in time and still holds the workspace. Retry the checks once it has stopped.";

type BaselineTask = Pick<TaskRecord, "taskId" | "workflow">;
type BaselineRecord = NonNullable<Awaited<ReturnType<typeof readWorkflowE2EBaselineRecord>>>;
type BaselineOperation = Awaited<ReturnType<BaselineDispatchPorts["operation"]>>;
type BaselineResult = "WAIT" | "GO" | "STOPPED" | "STUCK";

async function startRequestedBaseline(state: E2EStateStore, task: BaselineTask, ports: BaselineDispatchPorts): Promise<BaselineResult> {
  try { return await ports.start() === "STALE" ? "GO" : "WAIT"; }
  catch (error) {
    await markWorkflowE2EBaselineUnavailable(state, task, baselineStartFailureReason(error), { from: ["REQUESTED"] });
    return "GO";
  }
}

async function settleTerminalBaseline(state: E2EStateStore, task: BaselineTask, ports: BaselineDispatchPorts, record: BaselineRecord, operation: BaselineOperation): Promise<BaselineResult> {
  if (record.state === "STARTED") {
    if (operation?.status === "SUCCEEDED") { await ports.settle(operation.id); return "GO"; }
    await markWorkflowE2EBaselineUnavailable(state, task, "run-failed", { from: ["STARTED"], ...(record.operationId === undefined ? {} : { operationId: record.operationId }) });
    return operation?.status === "CANCELLED" ? "STOPPED" : "GO";
  }
  if (record.state === "UNAVAILABLE" && record.reason === "stopped") {
    return await markWorkflowE2EBaselineUnavailable(state, task, "run-failed", { from: ["UNAVAILABLE"], ...(record.operationId === undefined ? {} : { operationId: record.operationId }) }) ? "STOPPED" : "GO";
  }
  return "GO";
}

async function waitForActiveBaseline(state: E2EStateStore, task: BaselineTask, ports: BaselineDispatchPorts, record: BaselineRecord, operation: NonNullable<BaselineOperation>): Promise<BaselineResult> {
  const now = (state.now?.() ?? new Date()).getTime();
  const timeUp = Date.parse(record.deadlineAt ?? "") + E2E_BASELINE_RUN_GRACE_MS;
  if (record.state === "STARTED" && Number.isFinite(timeUp) && now <= timeUp) return "WAIT";
  if (record.state === "STARTED") await markWorkflowE2EBaselineUnavailable(state, task, "timed-out", { from: ["STARTED"], operationId: operation.id });
  const markedAt = record.state === "UNAVAILABLE" ? Date.parse(record.recordedAt ?? "") : Number.NaN;
  if (record.state === "UNAVAILABLE" && (!Number.isFinite(markedAt) || now - markedAt > HOLD_LIMIT_MS)) {
    await markWorkflowE2EBaselineUnavailable(state, task, "cancel-unconfirmed", { from: ["UNAVAILABLE"], operationId: operation.id });
    return "STUCK";
  }
  if (await ports.activeOperationId() === operation.id && operation.status !== "CANCEL_REQUESTED") await ports.cancel(operation.id);
  return "WAIT";
}

export async function runBaselineRoundFirst(state: E2EStateStore, task: Pick<TaskRecord, "taskId" | "workflow">, ports: BaselineDispatchPorts): Promise<"WAIT" | "GO" | "STOPPED" | "STUCK"> {
  try {
    const record = await readWorkflowE2EBaselineRecord(state, task);
    if (record === undefined || record.state === "RECORDED") return "GO";
    if (record.state === "REQUESTED") return await startRequestedBaseline(state, task, ports);
    const operation = record.operationId === undefined ? undefined : await ports.operation(record.operationId);
    if (operation?.status === "INTERRUPTED" && await ports.activeOperationId() === operation.id) {
      await markWorkflowE2EBaselineUnavailable(state, task, "cancel-unconfirmed", { from: ["STARTED", "UNAVAILABLE"], operationId: operation.id });
      return "STUCK";
    }
    if (operation === undefined || terminal.has(operation.status)) return await settleTerminalBaseline(state, task, ports, record, operation);
    return await waitForActiveBaseline(state, task, ports, record, operation);
  } catch {
    // A baseline cannot prevent a candidate's own admission. Its ordinary workspace fence still prevents overlap.
    return "GO";
  }
}
