import type { FeatureE2EPlanningContext, FeatureE2EPlanningContextResult } from "./feature-plan-planning-context.js";

/**
 * Prompt text naming which step and assertion kinds the planner may use for the executable targets (empty when none is executable).
 * Agent steps are listed only when the project's approved AI navigation route is the installation's latest and a web runtime declares them (Task 4.2).
 */
export function describeFeatureE2EExecutableKinds(context: Pick<FeatureE2EPlanningContext, "targets" | "unavailableTargetRefs" | "unavailableReasons" | "executableKinds">): string {
  const kinds = context.executableKinds ?? [];
  if (kinds.length === 0) return "";
  // A target that is unavailable for any reason is not executable, whether or not it has an unavailableTargetRefs entry (a no-source-identity target has none).
  const unavailable = new Set([...(context.unavailableTargetRefs ?? []).map((item) => item.targetId), ...(context.unavailableReasons ?? []).map((item) => item.targetId)]);
  const executable = (kind: string) => context.targets.filter((target) => target.kind === kind && !unavailable.has(target.targetId)).map((target) => target.targetId);
  return [
    "Targets in runtimeRefs that are not in unavailableTargetRefs can run real browser or API scenarios. For those targets only, a scenario may use exactly these kinds:",
    ...kinds.map((item) => `- ${item.kind} targets (${executable(item.kind).join(", ")}): steps ${item.steps.join(", ")}; assertions ${item.assertions.join(", ")}.`),
    kinds.some((item) => item.steps.includes("agent"))
      ? "Use deterministic steps where test IDs are known and stable. Use an `agent` step only for UI the request changes, or where no test ID is approved, and make its goal name the outcome (for example \"Export the orders as a CSV file\"), not a selector. An agent step only navigates: it takes at most 8 actions, a group runs at most 3 agent steps, and every scenario with an agent step needs deterministic assertions after it, because the checks decide the result."
      : "Do not use `agent` steps; they stay unavailable.",
    "A target in unavailableTargetRefs cannot run application scenarios (unavailableReasons says why): list it there instead of proposing executable scenarios for it.",
    "A target whose unavailableReasons entry is no-source-identity has no source-owned application identity, so it has no entry in runtimeRefs or unavailableTargetRefs: give it no scenario and do not name it in the plan.",
  ].join("\n");
}

/**
 * Whether a planning context offers executable kinds, so the planner is asked for the v2 application intent (and the worker is negotiated to
 * parse it). The kinds are present only for a policy with a target on a qualified runtime profile (Ruling AQ) and listed only for a target whose
 * runtime is READY now, so a P0 or portable-only context never asks for v2.
 */
export function offersApplicationE2EPlan(context: FeatureE2EPlanningContextResult | undefined): boolean {
  return context?.status === "available" && (context.executableKinds?.length ?? 0) > 0;
}
