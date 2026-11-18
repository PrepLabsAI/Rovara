// The plan summary of the task log on a hosted company (`core/task-log/plan-summary-source.ts`), from the company's OWN records: its task, its plan document (only this task's own stored document is read) and the risk tier
// its decision gate grades the plan at (the same approvers point and workflow subject the decision cards use, so the summary says what the card says). Built when first asked, so a company whose gate cannot be made gets
// no summary (the log's other entries are written) and the runtime still builds. A read that fails is the caller's to catch: the log then has no `plan_summary`.
import type { AdapterRegistry, OrgId } from "@agentx/contracts";
import { createDecisionService } from "../services/decisions.js";
import type { PlanSummaryFacts } from "../core/task-log/milestones.js";
import { planSummarySourceOf } from "../core/task-log/plan-summary-source.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";

export function hostedPlanSummaryOf(input: { flow: TaskFlowDeps; registry: Pick<AdapterRegistry, "require">; companyId: OrgId; now: () => Date }): (orgId: OrgId, taskId: string) => Promise<PlanSummaryFacts | undefined> {
  let source: ReturnType<typeof planSummarySourceOf> | undefined;
  return async (orgId, taskId) => {
    // This company's summary only: a task id of another company reads nothing here.
    if (orgId !== input.companyId) return undefined;
    if (source === undefined) {
      const { flow, registry, companyId, now } = input;
      const blobs = registry.require("object-storage");
      const decisions = createDecisionService({ flow, blobs, store: flow.store, approvers: registry.require("approvers"), audit: flow.audit, companyId, identity: registry.require("identity"), now });
      source = planSummarySourceOf({ store: flow.store, artifacts: blobs, gate: decisions.gate });
    }
    return source(orgId, taskId);
  };
}
