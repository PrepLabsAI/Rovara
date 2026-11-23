// DEC 350: the automatic round's dollar gate. This reads allowance only; every model call still needs its own gateway price, hold and receipt.
import type { DocumentStore } from "@agentx/contracts";
import { companyOfReservation, openHoldRoom, readDayLoad } from "../core/cost/holds.js";
import { costPartition } from "../core/cost/ledger.js";
import { taskKey } from "../core/task-flow/keys.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { HostedAdmissionSettings } from "./hosted-modules.js";

/** Same company-day authority as runSpendState, but require room for the entire fitted round. The task's own current-day open hold was promised to it already: count it once, even at a full day. */
export function hostedAutofixDayBudgetHasRoom(deps: { store: DocumentStore; companyId: string; settings: HostedAdmissionSettings | undefined; now: () => Date }): NonNullable<TaskFlowDeps["autofixDayBudgetHasRoom"]> {
  // A dollar reading that cannot be had THROWS (the caller turns it into "unreadable": no round, and the owner is asked and told so). A refusal on what is read (no cap, another company, no room) returns false.
  return async (task, roundEstimateUsd) => {
    const cap = deps.settings?.companyDayCapMicros;
    const need = Math.ceil(roundEstimateUsd * 1_000_000);
    if (cap === undefined || !Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(need) || need <= 0 || task.companyId !== deps.companyId) return false;
    const stored = await deps.store.get(taskKey(task.taskId));
    if (stored?.["companyId"] !== deps.companyId) return false;
    const day = deps.now().toISOString().slice(0, 10);
    const load = await readDayLoad(deps.store, deps.companyId, day);
    if (load === "unknown") throw new Error("the company's day load cannot be told");
    const total = await deps.store.get({ pk: costPartition(deps.companyId, task.taskId), sk: "TOTAL" });
    const holdId = total?.["holdId"];
    const ownRoom = companyOfReservation(holdId) === deps.companyId ? await openHoldRoom(deps.store, holdId, day) : 0;
    return need <= Math.max(0, cap - load) + ownRoom;
  };
}
