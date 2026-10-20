import type { FeatureE2EPlanningContext } from "./feature-plan-planning-context.js";

/**
 * Prompt text naming which step and assertion kinds the planner may use for the executable targets (empty when none is executable).
 * Agent steps are never offered: they stay unavailable until M1.4.
 */
export function describeFeatureE2EExecutableKinds(context: Pick<FeatureE2EPlanningContext, "targets" | "unavailableTargetRefs" | "executableKinds">): string {
  const kinds = context.executableKinds ?? [];
  if (kinds.length === 0) return "";
  const unavailable = new Set((context.unavailableTargetRefs ?? []).map((item) => item.targetId));
  const executable = (kind: string) => context.targets.filter((target) => target.kind === kind && !unavailable.has(target.targetId)).map((target) => target.targetId);
  return [
    "Targets in runtimeRefs that are not in unavailableTargetRefs can run real browser or API scenarios. For those targets only, a scenario may use exactly these kinds:",
    ...kinds.map((item) => `- ${item.kind} targets (${executable(item.kind).join(", ")}): steps ${item.steps.join(", ")}; assertions ${item.assertions.join(", ")}.`),
    "Do not use `agent` steps; they stay unavailable. A target in unavailableTargetRefs cannot run application scenarios (unavailableReasons says why): list it there instead of proposing executable scenarios for it.",
  ].join("\n");
}
