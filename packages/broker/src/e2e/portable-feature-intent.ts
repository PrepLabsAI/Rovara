import type { E2EFeaturePlanIntent, PlanDocument } from "@agentx/contracts";

export type PortableFeatureIntent =
  | { ok: true; intent: E2EFeaturePlanIntent }
  | { ok: false; reason: "canonical-e2e-intent-missing" | "application-e2e-intent-needs-application-verification" };

/**
 * The canonical plan's portable (schemaVersion 1) e2e intent, the only kind the portable feature dispatch and verification run. A plan with no
 * intent, or with a v2 application intent, has none: both paths refuse it (fail closed) until the application round path (Task 2.4) handles v2.
 */
export function portableFeatureIntentOf(plan: Pick<PlanDocument, "e2e">): PortableFeatureIntent {
  if (plan.e2e === undefined) return { ok: false, reason: "canonical-e2e-intent-missing" };
  if (plan.e2e.schemaVersion !== 1) return { ok: false, reason: "application-e2e-intent-needs-application-verification" };
  return { ok: true, intent: plan.e2e };
}
