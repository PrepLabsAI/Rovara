// Moved to @agentx/contracts in feature 013 so the Slack orchestrator's turn records share the shape.
import { SECOND_REVIEW_OPERATION_TAG, type UsageStats } from "@agentx/contracts";
export {
  createTaskUsageTelemetry,
  effectiveCacheRetention,
  type PiCacheRetention,
  type TaskUsageOutcome,
  type TaskUsageTelemetry,
  type UsageStats,
} from "@agentx/contracts";

/**
 * Spec 053: usage as the control plane receives it, in a usage event or an eval result callback. A
 * control plane built before the thinking level parses usage strictly and would refuse the record,
 * and the worker or runner image can ship before it. Only an invocation or run config that carried a
 * level proves a control plane that parses one, so the level is sent only then. The usage.json and
 * result.json artifacts, which the control plane does not parse, always keep it.
 */
/** The artifact a reviewer's usage is kept in: the first reviews' own names, and `workflow-second-review-<try>-usage.json` for the second reviewer's tries (tagged `second-review` by name; the usage event itself is never changed). */
export const reviewUsageArtifactName = (role: string, secondReviewTry: number | undefined): string =>
  secondReviewTry === undefined ? `workflow-review-${role.toLowerCase()}-usage.json` : `workflow-${SECOND_REVIEW_OPERATION_TAG}-${String(secondReviewTry)}-usage.json`;

export function usageForControlPlane<T>(usage: T, requested: { thinkingLevel?: unknown }): T {
  if (requested.thinkingLevel !== undefined || typeof usage !== "object" || usage === null || !("thinkingLevel" in usage)) return usage;
  const rest: Record<string, unknown> = { ...usage };
  delete rest.thinkingLevel;
  return rest as T;
}

/**
 * What a session spent since `baseline`. A reopened conversation's Pi session adds up every message of the saved transcript, the earlier operations' too, so its raw stats are the
 * conversation's running total. A usage event is one operation's own spend, so a run that reopened a session reports its stats minus the stats it opened with (a session made new for
 * the run has no baseline). Never below zero.
 */
export function statsSince<T extends UsageStats>(stats: T, baseline: UsageStats | undefined): T {
  if (baseline === undefined) return stats;
  const tokens = (now: number, before: number) => Math.max(0, now - before);
  return {
    ...stats,
    tokens: {
      input: tokens(stats.tokens.input, baseline.tokens.input), output: tokens(stats.tokens.output, baseline.tokens.output),
      cacheRead: tokens(stats.tokens.cacheRead, baseline.tokens.cacheRead), cacheWrite: tokens(stats.tokens.cacheWrite, baseline.tokens.cacheWrite),
      total: tokens(stats.tokens.total, baseline.tokens.total),
    },
    cost: Math.max(0, Math.round((stats.cost - baseline.cost) * 1e9) / 1e9),
  };
}

/** Whether a session did nothing since its baseline: no tokens and no cost. A run that only read a reopened session's transcript spent nothing and sends no usage event. */
export const spentNothing = (stats: UsageStats): boolean => stats.tokens.total === 0 && stats.tokens.input === 0 && stats.tokens.output === 0 && stats.tokens.cacheRead === 0 && stats.tokens.cacheWrite === 0 && stats.cost === 0;
