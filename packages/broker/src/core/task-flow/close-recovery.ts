import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord } from "./records.js";
import { readAcceptedClose, type AcceptedClose } from "./close-recovery-state.js";
import { flushAcceptedClose, planCloseAccounting, accountAcceptedClose } from "./close-recovery-account.js";
import { destroyAcceptedClose, releaseCloseReservations, finalizeAcceptedClose, projectClosedTask, notifyClosedTask, recordClosedCost } from "./close-recovery-finish.js";

type Phase = (deps: TaskFlowDeps, op: AcceptedClose) => Promise<boolean>;
const phases: ReadonlyArray<[string, Phase]> = [
  ["flush", flushAcceptedClose], ["decision", planCloseAccounting], ["account", accountAcceptedClose],
  ["terminate", destroyAcceptedClose], ["reservations", releaseCloseReservations], ["finish", finalizeAcceptedClose],
  ["projection", projectClosedTask], ["notify", notifyClosedTask], ["cost", recordClosedCost],
];

/** Driven exclusively by the stored acceptance, never by a retried POST's fresh intent/deadline. */
export async function resumeAcceptedClose(deps: TaskFlowDeps, input: OperationRecord): Promise<boolean> {
  for (const [receipt, phase] of phases) {
    const op = await readAcceptedClose(deps, input.workspaceId, input.id);
    if (op === undefined) return false;
    if (op.closeAcceptance.phase === "complete") return true;
    // Replaying flush also repairs a crash after its commit but before the inline relay.
    if (receipt !== "flush" && op.closeAcceptance.receipts[receipt] !== undefined) continue;
    if (!await phase(deps, op)) return false;
  }
  return (await readAcceptedClose(deps, input.workspaceId, input.id))?.closeAcceptance.phase === "complete";
}
