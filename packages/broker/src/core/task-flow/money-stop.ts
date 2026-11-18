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
import { AGENTX_PROTOCOL_VERSION, budgetExhaustedWords, change, when, type WorkerInvocation } from "@agentx/contracts";
import { CallbackCapabilities } from "../../callbacks.js";
import type { TaskFlowDeps } from "./deps.js";
import { workspaceKeys } from "./workspace-location.js";
import { readTask } from "./reads.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { dispatchQueueName, iso, log } from "./support.js";

/** The admission action asked before each model run is handed to a worker (it holds nothing). */
export const RUN_START_ACTION = "run.start";
/** How long a Stop waits for the worker to send its usage and end, by default (a Stop runs inside one HTTP request, which API Gateway ends at about 29 s). */
export const USAGE_FLUSH_WAIT_MS = 15_000;
const FLUSH_POLL_MS = 250;
/** A cancel capability for no callback at all: the cancel is answered on its own request. */
const CANCEL_CAPABILITY_SECONDS = 120;

/** Why a run was stopped for money: the cap it reached, or spend that could not be read as dollars. */
export type SpendStopCode = "task_cap" | "company_day_cap" | "spend_unknown";
const SPEND_STOP_CODES: ReadonlySet<string> = new Set<SpendStopCode>(["task_cap", "company_day_cap", "spend_unknown"]);
export const isSpendStopCode = (value: unknown): value is SpendStopCode => typeof value === "string" && SPEND_STOP_CODES.has(value);

/** The short words of a task's own stop, where a line is only a reason (a reviewer that did not run for want of room). The run's own end says which limit (`spendStopReason`). */
export const SPEND_STOP_REASON = "Stopped: this task reached its spending limit";
/** The fixed words a run stopped because its spend could not be read ends with. */
export const SPEND_UNKNOWN_STOP_REASON = "Stopped: this task's spending could not be worked out";
/** The fixed words a run's end carries: the limit it reached (the task's own, or the company's day) and what to do (lead 4 TA12), or that its spend could not be read. */
export const spendStopReason = (code: SpendStopCode): string => (code === "spend_unknown" ? SPEND_UNKNOWN_STOP_REASON : budgetExhaustedWords(code === "company_day_cap" ? "company_day" : "task"));

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The id of one cancel of `operation`, asked at `at` (a uuid): each Stop, close or spend stop is its own cancel at the worker. */
function cancelIdOf(operation: Pick<OperationRecord, "id">, at: string): string {
  const hex = createHash("sha256").update(`cancel\n${operation.id}\n${at}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The worker's cancel invocation of `operation`: no callback right (it is answered on its own request). Built by the dispatcher, which holds the worker's address. */
export function cancelInvocation(deps: Pick<TaskFlowDeps, "callbackSigningKey">, workspace: Pick<WorkspaceRecord, "id" | "projectRevision">, operation: Pick<OperationRecord, "id" | "fence">, cancelId: string): WorkerInvocation {
  return {
    protocolVersion: AGENTX_PROTOCOL_VERSION, kind: "cancel", operationId: cancelId, workspaceId: workspace.id, fence: operation.fence, projectRevision: workspace.projectRevision,
    callbackCapability: new CallbackCapabilities(Buffer.from(deps.callbackSigningKey)).issue({ workspaceId: workspace.id, operationId: cancelId, fence: operation.fence, actions: [], expiresInSeconds: CANCEL_CAPABILITY_SECONDS }),
    payload: { targetOperationId: operation.id },
  };
}

/** The cancel a dispatch message carries (`cancel`: the cancel's own id), or undefined for an ordinary dispatch message. */
export function queuedCancelOf(body: unknown): string | undefined {
  const cancel = (body as { cancel?: unknown } | null | undefined)?.cancel;
  return typeof cancel === "string" && UUID.test(cancel) ? cancel : undefined;
}

/**
 * Queues the worker's cancel of `operation` (the broker never reaches a worker itself: the dispatcher, which does, delivers it). The message is staged in the outbox and relayed at once;
 * a relay that fails here is left to the outbox's own relay (the State stream with lane L9, else the 1-minute backstop). True when the message was staged.
 */
async function queueCancel(deps: TaskFlowDeps, operation: OperationRecord): Promise<boolean> {
  const cancelId = cancelIdOf(operation, iso(deps));
  try {
    const staged = await deps.store.transact([deps.outbox.stage({
      id: cancelId, companyId: deps.companyId, queue: dispatchQueueName(deps), attributes: { kind: "cancel" },
      body: { v: 1, companyId: deps.companyId, workspaceId: operation.workspaceId, operationId: operation.id, cancel: cancelId },
    })]);
    if (!staged.applied) return false;
  } catch (error) {
    log(deps, { event: "task_flow.cancel_not_queued", error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
  await deps.outbox.relay({ companyId: deps.companyId, ids: [cancelId] }).catch((error: unknown) => log(deps, { event: "task_flow.relay_failed", error: error instanceof Error ? error.name : "unknown" }));
  return true;
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
  void workspace;
  const waitMs = stop.flushWaitMs ?? USAGE_FLUSH_WAIT_MS;
  const sleep = stop.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const started = (deps.now?.() ?? new Date()).getTime();
  const queued = await queueCancel(deps, operation);
  const location = await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId);
  for (let current = await deps.store.get(location.operationKey(operation.id)); ; current = await deps.store.get(location.operationKey(operation.id))) {
    const status = current?.["status"];
    if (typeof status === "string" && ENDED.has(status)) return "flushed";
    const left = waitMs - elapsedSince(deps, started);
    // Not ended in time: taken as not flushed, even for a run that never reported an event (its worker may have spent while its sends failed; over-counting is the safe side).
    if (!queued || left <= 0) return "not_flushed";
    await sleep(Math.min(stop.pollMs ?? FLUSH_POLL_MS, left));
  }
}

/**
 * Before a task is closed with a model run going (a deployed install): the run is asked to stop and send its usage, as a Stop does, and waited for a bounded time. A run whose end did not
 * come keeps its task's whole hold as spent, marked estimated; the close then ends it INTERRUPTED as before.
 */
export async function flushBeforeClose(deps: TaskFlowDeps, workspace: WorkspaceRecord | undefined): Promise<void> {
  if (deps.moneyStop === undefined || workspace === undefined || workspace.activeOperationId == null) return;
  const operation = await deps.store.get((await workspaceKeys({ store: deps.store, companyId: workspace.companyId }, workspace.id)).operationKey(workspace.activeOperationId)) as unknown as OperationRecord | undefined;
  if (operation === undefined || operation.companyId !== deps.companyId || !reportsUsage(operation) || ENDED.has(operation.status)) return;
  await deps.store.update({
    key: (await workspaceKeys({ store: deps.store, companyId: operation.companyId }, workspace.id)).operationKey(operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
  });
  if (await askWorkerToFlush(deps, workspace, operation) === "not_flushed") await endUnflushed(deps, operation);
}

/** The task a workspace's operation belongs to. */
async function taskOfOperation(deps: TaskFlowDeps, operation: Pick<OperationRecord, "workspaceId" | "companyId">) {
  const taskId = (await deps.store.get((await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId)).taskPointerKey()))?.["taskId"];
  return typeof taskId === "string" && taskId !== "" ? await readTask(deps, taskId) : undefined;
}

/**
 * A model run ended without its usage (a Stop or a close the worker did not answer in time, a lost worker): the operation is marked `usageUnflushed`, and the task's whole start hold is
 * kept as spent, marked estimated. Best effort: a failure here leaves the hold open, and closing the task then keeps it all the same (`releaseOrKeep`).
 */
export async function endUnflushed(deps: TaskFlowDeps, operation: OperationRecord): Promise<void> {
  if (deps.moneyStop === undefined || !reportsUsage(operation)) return;
  try {
    // Once per run: a run already taken as unflushed has kept its hold or its estimate.
    const marked = await deps.store.update({ key: (await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId)).operationKey(operation.id), ops: [change.set("usageUnflushed", true)], condition: when.and(when.present(), when.notExists("usageUnflushed")) });
    if (!marked.applied) return;
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
    key: (await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId)).operationKey(operation.id),
    ops: [change.set("status", "CANCEL_REQUESTED"), change.set("stopReason", code), change.set("stopRequestedAt", now), change.set("updatedAt", now)],
    condition: when.and(when.eq("fence", operation.fence), when.or(when.eq("status", "ACCEPTED"), when.eq("status", "DISPATCHING"), when.eq("status", "RUNNING"))),
  });
  if (!asked.applied) return false;
  log(deps, { event: "task_flow.spend_stop_requested", code });
  await queueCancel(deps, operation);
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
