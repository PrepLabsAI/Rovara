// Moved to @agentx/contracts in feature 013 so the Slack orchestrator's turn records share the shape.
export {
  createTaskUsageTelemetry,
  effectiveCacheRetention,
  type PiCacheRetention,
  type TaskUsageOutcome,
  type TaskUsageTelemetry,
} from "@agentx/contracts";

/**
 * Spec 053: usage as the control plane receives it, in a usage event or an eval result callback. A
 * control plane built before the thinking level parses usage strictly and would refuse the record,
 * and the worker or runner image can ship before it. Only an invocation or run config that carried a
 * level proves a control plane that parses one, so the level is sent only then. The usage.json and
 * result.json artifacts, which the control plane does not parse, always keep it.
 */
export function usageForControlPlane<T>(usage: T, requested: { thinkingLevel?: unknown }): T {
  if (requested.thinkingLevel !== undefined || typeof usage !== "object" || usage === null || !("thinkingLevel" in usage)) return usage;
  const rest: Record<string, unknown> = { ...usage };
  delete rest.thinkingLevel;
  return rest as T;
}
