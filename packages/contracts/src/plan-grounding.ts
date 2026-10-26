import { isNotChangingReference } from "./workflow-proposed-checks.js";
import type { PlanDocument } from "./workflow-plan-document.js";

/**
 * T7a PLANGROUNDING: which scenarios of a coding plan are tried on the unchanged code before the owner is asked. They are the scenarios of an application intent (schema version 2)
 * that `scenarioProves` ties to a "Not changing" entry, in the intent's order, without those that have an AI navigation (`agent`) step: those need a model, and a check before
 * approval never spends one. An empty answer means there is nothing to ground.
 */
export function groundingScenarioIds(plan: Pick<PlanDocument, "e2e" | "scenarioProves" | "notChanging">): string[] {
  const intent = plan.e2e;
  const proves = plan.scenarioProves;
  if (intent === undefined || intent.schemaVersion !== 2 || proves === undefined) return [];
  const seen = new Set<string>();
  return intent.scenarios.flatMap((scenario) => {
    if (seen.has(scenario.scenarioId)) return [];
    seen.add(scenario.scenarioId);
    const claims = proves[scenario.scenarioId] ?? [];
    if (!claims.some((id) => isNotChangingReference(id, plan.notChanging.length))) return [];
    if (scenario.steps.some((step) => step.kind === "agent")) return [];
    return [scenario.scenarioId];
  });
}

/** True when the plan has scenarios that prove a "Not changing" entry but every one of them needs AI navigation, so none can be tried before approval. */
export function groundingScenariosAllAiOnly(plan: Pick<PlanDocument, "e2e" | "scenarioProves" | "notChanging">): boolean {
  const intent = plan.e2e;
  const proves = plan.scenarioProves;
  if (intent === undefined || intent.schemaVersion !== 2 || proves === undefined || groundingScenarioIds(plan).length > 0) return false;
  return intent.scenarios.some((scenario) => (proves[scenario.scenarioId] ?? []).some((id) => isNotChangingReference(id, plan.notChanging.length)));
}
