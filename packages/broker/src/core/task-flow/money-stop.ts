// The per-run dollar stop and the usage flush on Stop (lane core-money-stop). A deployed install's worker reports a model run's usage only through its events (core-host/usage-booking.ts),
// so two things must hold there that the laptop (which books every call at its model proxy) does not need:
//
//   1. A run is stopped at its cap while it runs. The worker reports its usage as it goes (`usageCheckpoints`); each booking is followed by the admission's reading of the task's and the
//      day's spend (core-host/hosted-modules.ts `runSpendState`), and a run past a cap is asked to stop (`requestSpendStop`): the operation becomes CANCEL_REQUESTED with its reason, and
//      the worker is sent a cancel. The worker then stops, sends what it spent, and reports CANCELLED; that end blocks the step with a fixed reason the owner reads (`SPEND_STOP_REASON`),
//      and the owner is told the way any step that needs them is (the session's "Needs you" notice). Before each model run is handed to a worker, the same reading is asked
//      (`RUN_START_ACTION`), so a task at its cap starts no new run.
//   2. A Stop (and a close of a task with a run going) never loses spend. The worker is asked to stop and send its usage first (`askWorkerToFlush`), and the flow waits for its end a bounded
//      time (`USAGE_FLUSH_WAIT_MS`). When the worker's end does not come in time, the run's usage is taken as lost: the task's whole start hold is kept as spent, never less, marked
//      estimated for reconciliation (`endUnflushed`), and the operation says so (`usageUnflushed`).
//
// Absent `moneyStop` (the laptop, and any install that does not wire it), Stop, close and dispatch are exactly as before.
import { createHash } from "node:crypto";
import { AGENTX_PROTOCOL_VERSION, change, when, type WorkerInvocation } from "@agentx/contracts";
import { CallbackCapabilities } from "../../callbacks.js";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, taskPointerKey, workspaceKey } from "./keys.js";
import { readTask } from "./reads.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { iso, log } from "./support.js";

/** The admission action asked before each model run is handed to a worker (it holds nothing). */
export const RUN_START_ACTION = "run.start";
/** How long a Stop waits for the worker to send its usage and end, by default. */
export const USAGE_FLUSH_WAIT_MS = 20_000;
const FLUSH_POLL_MS = 250;
/** A cancel capability for no callback at all: the cancel is answered on its own request. */
const CANCEL_CAPABILITY_SECONDS = 120;

/** Why a run was stopped for money: the cap it reached, or spend that could not be read as dollars. */
export type SpendStopCode = "task_cap" | "company_day_cap" | "spend_unknown";
const SPEND_STOP_CODES: ReadonlySet<string> = new Set<SpendStopCode>(["task_cap", "company_day_cap", "spend_unknown"]);
export const isSpendStopCode = (value: unknown): value is SpendStopCode => typeof value === "string" && SPEND_STOP_CODES.has(value);

/** The fixed words a run stopped at its cap ends with (the task and the day alike: the owner's next move is the same). */
export const SPEND_STOP_REASON = "Stopped: this task reached its spending limit";
/** The fixed words a run stopped because its spend could not be read ends with. */
export const SPEND_UNKNOWN_STOP_REASON = "Stopped: this task's spending could not be worked out";
export const spendStopReason = (code: SpendStopCode): string => (code === "spend_unknown" ? SPEND_UNKNOWN_STOP_REASON : SPEND_STOP_REASON);

export interface MoneyStop {
  /** How long a Stop waits for the worker's end. Default `USAGE_FLUSH_WAIT_MS`. */
  flushWaitMs?: number;
  /** How often the wait reads the operation. */
  pollMs?: number;
  /** Waits (tests drive the clock). */
  sleep?: (ms: number) => Promise<void>;
  /** Keeps the task's whole start hold as spent, marked estimated for `operationId` (the hosted admission's holds). A hold already closed keeps what it kept. */
  keepWholeHold(reservationId: string | undefined, mark: { operationId: string; taskId: string }): Promise<void>;
}

const ENDED: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const elapsedSince = (deps: Pick<TaskFlowDeps, "now">, started: number): number => (deps.now?.() ?? new Date()).getTime() - started;

/** The cancel invocation of one target: one id per target, so a Stop pressed twice is one cancel at the worker. */
function cancelInvocation(deps: Pick<TaskFlowDeps, "callbackSigningKey">, workspace: Pick<WorkspaceRecord, "id" | "projectRevision">, operation: Pick<OperationRecord, "id" | "fence">): WorkerInvocation {
  const hex = createHash("sha256").update(`cancel\n${operation.id}`).digest("hex");
  const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    protocolVersion: AGENTX_PROTOCOL_VERSION, kind: "cancel", operationId, workspaceId: workspace.id, fence: operation.fence, projectRevision: workspace.projectRevision,
    callbackCapability: new CallbackCapabilities(Buffer.from(deps.callbackSigningKey)).issue({ workspaceId: workspace.id, operationId, fence: operation.fence, actions: [], expiresInSeconds: CANCEL_CAPABILITY_SECONDS }),
    payload: { targetOperationId: operation.id },
  };
}

/** Sends the worker the cancel of `operation`, giving up after `maxMs`. True when the worker took it. */
async function deliverCancel(deps: TaskFlowDeps, workspace: Pick<WorkspaceRecord, "id" | "projectRevision">, operation: OperationRecord, maxMs: number): Promise<boolean> {
  const machineId = operation.machineId;
  if (machineId === undefined) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.machines.deliver(machineId, cancelInvocation(deps, workspace, operation)).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, maxMs)); timer.unref?.(); }),
    ]);
  } catch (error) {
    log(deps, { event: "task_flow.cancel_not_delivered", error: error instanceof Error ? error.name : "unknown" });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether an operation is a model run whose usage only its worker can report (a task run handed to a machine). */
export const reportsUsage = (operation: Pick<OperationRecord, "kind" | "machineId">): boolean => operation.kind === "task" && operation.machineId !== undefined;

/**
 * Asks the worker running `operation` (already CANCEL_REQUESTED) to stop and send its usage, and waits for the operation's end (the worker's result) a bounded time.
 * `flushed`: it ended (its usage came before its result). `not_flushed`: the worker could not be told, or did not end in time. `nothing_to_flush`: no model run of a worker.
 */
export async function askWorkerToFlush(deps: TaskFlowDeps, workspace: Pick<WorkspaceRecord, "id" | "projectRevision">, operation: OperationRecord): Promise<"flushed" | "not_flushed" | "nothing_to_flush"> {
  const stop = deps.moneyStop;
  if (stop === undefined || !reportsUsage(operation) || ENDED.has(operation.status)) return "nothing_to_flush";
  const waitMs = stop.flushWaitMs ?? USAGE_FLUSH_WAIT_MS;
  const sleep = stop.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const started = (deps.now?.() ?? new Date()).getTime();
  if (!(await deliverCancel(deps, workspace, operation, waitMs))) return "not_flushed";
  for (;;) {
    const current = await deps.store.get(operationKey(operation.workspaceId, operation.id));
    const status = current?.["status"];
    if (typeof status === "string" && ENDED.has(status)) return "flushed";
    const left = waitMs - elapsedSince(deps, started);
    if (left <= 0) return "not_flushed";
    await sleep(Math.min(stop.pollMs ?? FLUSH_POLL_MS, left));
  }
}

/**
 * Before a task is closed with a model run going (a deployed install): the run is asked to stop and send its usage, as a Stop does, and waited for a bounded time. A run whose end did not
 * come keeps its task's whole hold as spent, marked estimated; the close then ends it INTERRUPTED as before.
 */
export async function flushBeforeClose(deps: TaskFlowDeps, workspace: WorkspaceRecord | undefined): Promise<void> {
  if (deps.moneyStop === undefined || workspace === undefined || workspace.activeOperationId == null) return;
  const operation = await deps.store.get(operationKey(workspace.id, workspace.activeOperationId)) as unknown as OperationRecord | undefined;
  if (operation === undefined || operation.companyId !== deps.companyId || !reportsUsage(operation) || ENDED.has(operation.status)) return;
  await deps.store.update({
    key: operationKey(workspace.id, operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
  });
  if (await askWorkerToFlush(deps, workspace, operation) === "not_flushed") await endUnflushed(deps, operation);
}

/** The task a workspace's operation belongs to. */
async function taskOfOperation(deps: TaskFlowDeps, operation: Pick<OperationRecord, "workspaceId">) {
  const taskId = (await deps.store.get(taskPointerKey(operation.workspaceId)))?.["taskId"];
  return typeof taskId === "string" && taskId !== "" ? await readTask(deps, taskId) : undefined;
}

/**
 * A model run ended without its usage (a Stop or a close the worker did not answer in time, a lost worker): the operation is marked `usageUnflushed`, and the task's whole start hold is
 * kept as spent, marked estimated. Best effort: a failure here leaves the hold open, and closing the task then keeps it all the same (`releaseOrKeep`).
 */
export async function endUnflushed(deps: TaskFlowDeps, operation: OperationRecord): Promise<void> {
  if (deps.moneyStop === undefined || !reportsUsage(operation)) return;
  try {
    await deps.store.update({ key: operationKey(operation.workspaceId, operation.id), ops: [change.set("usageUnflushed", true)], condition: when.present() });
    const task = await taskOfOperation(deps, operation);
    if (task === undefined || task.companyId !== deps.companyId) return;
    await deps.moneyStop.keepWholeHold(task.admissionReservationId, { operationId: operation.id, taskId: task.taskId });
    log(deps, { event: "task_flow.usage_not_flushed", taskId: task.taskId });
  } catch (error) {
    log(deps, { event: "task_flow.usage_not_flushed_unkept", error: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Stops a run at its cap (called after its usage was booked): the operation becomes CANCEL_REQUESTED with the reason, and its worker is sent a cancel. Nothing waits here (the caller is
 * the worker's own events callback). True when this asked for the stop; false when the run had already ended or was already being stopped.
 */
export async function requestSpendStop(deps: TaskFlowDeps, operation: OperationRecord, code: SpendStopCode): Promise<boolean> {
  if (deps.moneyStop === undefined || !isSpendStopCode(code)) return false;
  const now = iso(deps);
  const asked = await deps.store.update({
    key: operationKey(operation.workspaceId, operation.id),
    ops: [change.set("status", "CANCEL_REQUESTED"), change.set("stopReason", code), change.set("stopRequestedAt", now), change.set("updatedAt", now)],
    condition: when.and(when.eq("fence", operation.fence), when.or(when.eq("status", "ACCEPTED"), when.eq("status", "DISPATCHING"), when.eq("status", "RUNNING"))),
  });
  if (!asked.applied) return false;
  log(deps, { event: "task_flow.spend_stop_requested", code });
  const workspace = await deps.store.get(workspaceKey(operation.workspaceId));
  const projectRevision = workspace?.["projectRevision"];
  if (typeof projectRevision === "number") await deliverCancel(deps, { id: operation.workspaceId, projectRevision }, operation, 5_000);
  return true;
}

/**
 * The backstop of a spend stop whose worker never ended the run (the run-lost sweep): past the flush wait, the machine is stopped, the run is taken as unflushed, and its end is
 * recorded CANCELLED with the reason. True when it is time to; the caller records the end.
 */
export function spendStopOverdue(deps: TaskFlowDeps, operation: OperationRecord): boolean {
  if (deps.moneyStop === undefined || operation.status !== "CANCEL_REQUESTED" || !isSpendStopCode(operation.stopReason) || typeof operation.stopRequestedAt !== "string") return false;
  const asked = Date.parse(operation.stopRequestedAt);
  return Number.isFinite(asked) && elapsedSince(deps, asked) >= (deps.moneyStop.flushWaitMs ?? USAGE_FLUSH_WAIT_MS);
}
