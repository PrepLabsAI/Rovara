import { OfferedAgentModelsSchema, type DocumentStore, type Metering, type OrgId } from "@agentx/contracts";
import { createHostedLedger, taskCapOf, type HostedAdmissionSettings, type ProjectTaskCap } from "./hosted-modules.js";
import { costUsdOf } from "../core/cost/ledger.js";
import { readGuardrailsWithRevision } from "../core/agents/guardrails.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";

/** Uncached: provider disconnects and lowered company limits apply to the next grant. The existing HTTP reader bounds the whole read. */
export async function reviewerAuthority(input: { companyId: OrgId; offered?: ((companyId: OrgId) => Promise<unknown>) | undefined }) {
  try {
    const parsed = OfferedAgentModelsSchema.safeParse(await input.offered?.(input.companyId));
    const access = parsed.success ? parsed.data.reviewerAccess : undefined;
    if (access === undefined || access.companyId !== input.companyId || !(access.companyLimitUsd > 0)) return undefined;
    return access;
  } catch { return undefined; }
}

export function hostedAutonomy(input: { store: DocumentStore; companyId: OrgId }): NonNullable<TaskFlowDeps["autonomy"]> {
  return async (task) => {
    if (task.companyId !== input.companyId) return { autonomy: "suggest", noCompany: true };
    try {
      const result = await readGuardrailsWithRevision({ store: input.store, now: Date.now }, input.companyId);
      return result.revision === 0 ? { autonomy: "suggest", unreadable: true } : { autonomy: result.guardrails.maxAutonomy };
    }
    catch { return { autonomy: "suggest", unreadable: true }; }
  };
}

/** Current task room from the main AI's ledger and cap resolver. Company MONTHLY room comes from reviewerAuthority's existing gateway reader. Unknown money closes review access. */
export async function reviewerRoomUsd(input: { store: DocumentStore; metering: Metering; companyId: OrgId; settings: HostedAdmissionSettings | undefined; now: () => Date; projectTaskCap?: ProjectTaskCap | undefined }, task: { companyId: string; taskId: string; project: string }): Promise<number> {
  if (input.settings === undefined || task.companyId !== input.companyId) return 0;
  try {
    const ledger = createHostedLedger(input);
    const cap = await taskCapOf({ ...input, settings: input.settings }, input.companyId, task.taskId, task.project);
    const spent = costUsdOf(await ledger.taskCost(input.companyId, task.taskId));
    return spent === undefined ? 0 : Math.max(0, cap.micros / 1_000_000 - spent);
  } catch { return 0; }
}
