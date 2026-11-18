// Shared post-commit filing for every plan approval surface. A report fault never changes the approval's answer.
import type { FeatureStoreDeps } from "./feature-store.js";
import { createFeatureStore } from "./feature-store.js";
import { log } from "../task-flow/support.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";

export async function confirmPlanFeature(deps: FeatureStoreDeps & Pick<TaskFlowDeps, "log">, taskId: string, personId: string): Promise<void> {
  try {
    await createFeatureStore(deps).confirmTaskFeatureAtPlan(taskId, { type: "person", id: personId });
  } catch {
    log(deps, { event: "report.plan_feature_confirmation_skipped", code: "FEATURE_CONFIRMATION_UNAVAILABLE" });
  }
}
