// Who pays a hosted task, told from the task itself when no charge receipt names a payer (the hosted broker stores none yet). Used by `readTaskMoney`.
//
// True ONLY when the model gateway would charge the task's own member for every run: the gateway's payer for a run is the operation's requester under the shared `resolvePayer` rule (`resolveTaskPayer`, with
// `projectPays` false), so every task operation must have been requested by the task's developer and the rule must answer exactly that member. A wiki build or setup draft (`purpose`), Linear (the gateway refuses
// it), an offer, an upkeep / test / event / schedule / chain origin, a developer id that is not a person's, or a charge counter that is not this developer's own all stay unavailable. Billing (Rovara AI, exempt, own
// key) is never claimed here: the member pays in all three, which is what a receipt would say.
import { ROVARA_CODE_AGENT_ID, WorkOriginSchema, resolvePayer, type MoneyField, type MoneyPayer } from "@agentx/contracts";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";

const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
type PayerTask = Partial<Pick<TaskRecord, "developerId" | "developerName" | "project" | "origin" | "purpose" | "charge">>;

/** The task's own facts that must hold before any run is looked at. */
function taskMayHaveMemberPayer(task: PayerTask): task is PayerTask & { developerId: string; developerName: string; project: string } {
  const { developerId } = task;
  return typeof developerId === "string" && DEVELOPER_ID.test(developerId) && typeof task.project === "string" && typeof task.developerName === "string" && task.developerName.trim() !== ""
    && task.purpose === undefined && task.charge?.member?.pk === `DEVELOPER_LIMIT#${developerId}`;
}

/** What the shared payer rule answers for this task's starter, or undefined where the gateway refuses or charges someone else. */
function ruleMemberOf(task: { developerId: string; project: string; origin?: TaskRecord["origin"] | undefined }): string | undefined {
  const origin = WorkOriginSchema.optional().safeParse(task.origin);
  if (!origin.success || origin.data === "linear") return undefined;
  const payer = origin.data === undefined ? { kind: "member" as const, developerId: task.developerId }
    : resolvePayer({ origin: origin.data, project: task.project, projectPays: false, agentId: ROVARA_CODE_AGENT_ID, startedBy: { developerId: task.developerId } });
  return payer.kind === "member" ? payer.developerId : undefined;
}

/**
 * Whether the model gateway charges a MEMBER (the step's requester) for this task's runs: the same guard `memberPayerOf` applies, without the starter-only checks (a task handed over has runs for several members). False for a
 * setup run or wiki build (`purpose`), a Linear task, and any origin whose payer the shared rule says is not a member (a project-paid, event, schedule or chain origin): a surface says nothing of who pays then.
 */
export function gatewayChargesMember(task: PayerTask & { developerId?: string; project?: string }): boolean {
  if (task.purpose !== undefined || typeof task.developerId !== "string" || typeof task.project !== "string") return false;
  try { return ruleMemberOf({ developerId: task.developerId, project: task.project, origin: task.origin }) === task.developerId; } catch { return false; }
}

/** The task's member as a payer, or undefined. */
export function memberPayerOf(task: PayerTask, operations: readonly Pick<OperationRecord, "kind" | "requester">[]): MoneyPayer | undefined {
  try {
    if (!taskMayHaveMemberPayer(task)) return undefined;
    const runs = operations.filter(operation => operation.kind === "task");
    if (runs.length === 0 || runs.some(operation => operation.requester?.personId !== task.developerId)) return undefined;
    return ruleMemberOf(task) === task.developerId ? { kind: "member", id: task.developerId, name: task.developerName.trim().slice(0, 200) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The payer `readTaskMoney` serves: the receipts' (already in `current`) when any named one; otherwise, for a hosted read that may reveal the payer, the task's own member when the gateway would charge exactly that member. No
 * branch of `readTaskMoney` depends on it: it hands back `current` whenever it has nothing truer.
 */
export function hostedPayerOf(
  read: { hosted?: boolean | undefined; revealPayer?: boolean | undefined; task: PayerTask },
  current: MoneyField<MoneyPayer>,
  receiptAllocations: number,
  operations: readonly Pick<OperationRecord, "kind" | "requester">[] | undefined,
): MoneyField<MoneyPayer> {
  if (receiptAllocations > 0 || read.hosted !== true || read.revealPayer !== true || operations === undefined) return current;
  const member = memberPayerOf(read.task, operations);
  return member === undefined ? current : { state: "available", value: member };
}
