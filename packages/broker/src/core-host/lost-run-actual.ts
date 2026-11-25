// LOST-RUN-ACTUAL-SPEND: what an ended run that owes a usage report is counted at. Rovara counts only what was actually spent, so the figure is the model gateway's own record of the run's calls
// (`gateway-run-charges-http.ts`); a run lost through no fault of the person is no longer charged the hold's whole amount for being lost.
//
//   gateway answered, seen, complete, every call settled   -> booked at once ("settled"): what the worker's bookings do not hold yet, then the hold is given back.
//   gateway answered, complete, some call still an estimate -> waited for (the gateway settles it by itself) up to `ACTUAL_FIGURE_WAIT_MS` after the run's end, then booked as an estimate of the gateway's own.
//   no answer (read failed, refused, a call still open, a run it has not seen, a run created before the gateway began indexing by run: `indexedSince`) -> "wait": the spend stays unreadable, the hold stays open, nothing is booked and nothing is $0 (fail closed: Approve and Retry both read it).
//   no answer within `ACTUAL_FIGURE_WAIT_MS` of the end     -> "estimate": the hold's room as a marked estimate (`keepHoldAsEstimate`, two runs per task at most), so a task is never stuck for good.
//   the route is not served (404/501) or there is no gateway reader at all (the laptop, a test): there is no actual to be had, so "estimate" at once, exactly as SPEND-UNREPORTED-RUN did. This keeps an install that is deployed
//   BEFORE the gateway serves the route (GATEWAY-RUN-CHARGES-ROUTE; the route ships first, GATES.md G-GATEWAY-FIRST) from refusing every lost run for an hour.
//   A dispatcher holds no signing key (`deferEstimate`): it NEVER estimates, whatever the age, because the broker's own read is the one place that can ask the gateway; it settles only a run that never reached a machine.
import type { OrgId } from "@agentx/contracts";
import type { MoneyStop } from "../core/task-flow/money-stop.js";
import type { OperationRecord, TaskRecord } from "../core/task-flow/records.js";
import type { GatewayRunChargesReader, RunCharges } from "./gateway-run-charges-http.js";

/** How long after a run's end the settler waits for the gateway's complete, settled record before it counts the hold's room as an estimate. */
export const ACTUAL_FIGURE_WAIT_MS = 3_600_000;

export interface ActualFigureDeps {
  companyId: OrgId;
  moneyStop: MoneyStop;
  now: () => Date;
  /** The gateway's record of a run's calls. Absent: this install has no gateway to ask. */
  gatewayCharges?: GatewayRunChargesReader | undefined;
  /** This process cannot read the gateway (the dispatcher) but the broker can: never estimate, at any age. */
  deferEstimate?: boolean | undefined;
}
export type ActualFigure = "settled" | "wait" | "estimate";

/** Decides, and for "settled" books, the figure of one ended run past its grace. Throws what the booking throws (the caller's refusal). */
export async function settleActualFigure(deps: ActualFigureDeps, task: TaskRecord, run: OperationRecord): Promise<ActualFigure> {
  const canSettle = deps.moneyStop.settleFromGateway !== undefined;
  const reader = deps.gatewayCharges;
  const waitedOut = deps.now().getTime() - Date.parse(run.updatedAt) >= ACTUAL_FIGURE_WAIT_MS;
  const answer = reader === undefined ? undefined : await reader(deps.companyId, task.taskId, run.id).catch(() => undefined);
  // A run created before the gateway began indexing by run can read as complete with a smaller sum than it spent: UNKNOWN, never a final figure (an unreadable creation time is unknown too; so is an answer with no `indexedSince`, which the reader does not read).
  const indexed = (read: RunCharges): boolean => Date.parse(run.createdAt) >= read.indexedSinceMs;
  const charge = answer === "not_served" || answer === undefined || !indexed(answer) ? undefined : answer;
  if (charge?.complete === true && canSettle) {
    // Settled calls are the actual figure. A call that is still the gateway's own estimate is waited for; past the wait it is booked as that estimate, marked.
    if (!charge.final && !waitedOut) return "wait";
    await deps.moneyStop.settleFromGateway?.(task.admissionReservationId, { operationId: run.id, taskId: task.taskId }, { actualMicros: charge.actualMicros, final: charge.final });
    return "settled";
  }
  // The broker's own read decides to estimate; a dispatcher never does.
  if (deps.deferEstimate === true) return "wait";
  return reader === undefined || !canSettle || answer === "not_served" || waitedOut ? "estimate" : "wait";
}
