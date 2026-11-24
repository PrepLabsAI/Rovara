// Moved to @agentx/contracts in feature 013 so the Slack orchestrator's turn records share the shape.
import { SECOND_REVIEW_OPERATION_TAG, createTaskUsageTelemetry as telemetryOf, type TaskUsageOutcome as Outcome, type UsageStats } from "@agentx/contracts";
import { MODEL_QUOTA_DETAIL, budgetExhaustedFromMarker, modelNotAllowedFromMarker } from "@agentx/model-runtime";
import { sanitizeModelCallEvent } from "./model-call-monitor.js";
import { redactCredentials, WORKER_EVENT_PAYLOAD_MAX_BYTES } from "./events.js";
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
  // Unit history is optional. Preserve the accounting envelope when its history would
  // exceed the event bound; usage.json still keeps every call, and older readers use
  // the aggregate as session-granularity history rather than a partial call count.
  if (typeof usage === "object" && usage !== null && "calls" in usage && Buffer.byteLength(JSON.stringify(usage), "utf8") > WORKER_EVENT_PAYLOAD_MAX_BYTES) {
    const { calls: _calls, ...aggregate } = usage;
    void _calls;
    return usageForControlPlane(aggregate, requested) as T;
  }
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
    ...(stats.calls === undefined ? {} : { calls: stats.calls.filter((call) => !baseline.calls?.some((previous) => previous.callId === call.callId)) }),
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

/**
 * Per-run dollar stop (core money stop): a run asked for usage checkpoints reports what it spent since its last report at most this often, after a model call ends. A deployed install books
 * each one and stops the run at its cap, so a run can spend past a cap by at most what it spends in this time plus the call that was going.
 */
export const USAGE_CHECKPOINT_MS = 15_000;

/** The model a usage report names (a session's own, with the configured cache retention). */
export type UsageModel = Parameters<typeof telemetryOf>[1];

/**
 * Usage checkpoints of one model session (per-run dollar stop): every session of a run asked for `usageCheckpoints` (the main run, each parallel part, each reviewer, an agent step) reports
 * what it spent since its last report after a model call ends, at most every `intervalMs`, as a `usage` event marked `checkpoint`; at its end it reports what is left, marked `final`
 * when checkpoints went before (so an end with nothing left is still told, as a zero). Off: nothing is sent until the end, which reports everything since the baseline, unmarked (as before).
 */
export interface UsageCheckpointer {
  /** A session event: after an assistant message ends, a checkpoint when one is due. */
  observe(event: unknown): void;
  /** A checkpoint now, whatever the wait (a stop: what was spent leaves before anything else the ending does). */
  checkpointNow(): void;
  /** The end's report of `stats` (the session's stats now): what is left since the last checkpoint. Undefined when there is nothing to tell (no checkpoint went before and nothing was spent). */
  endReport(stats: UsageStats, model: UsageModel, outcome: Outcome, requested: { thinkingLevel?: unknown }): Record<string, unknown> | undefined;
  readonly checkpointed: boolean;
}

// Fixed refusal sentences emitted by model-runtime.safeError, including routed
// models whose Pi provider name is not a member of the provider catalog.
const PRE_STREAM_REFUSAL_DETAILS = new Set([
  "upstream unavailable; check provider status before retrying",
  "the provider is overloaded; wait before retrying",
  "rate limited; wait before retrying",
  "rate limited or out of credits; check the key's usage limits before retrying",
  "the model gateway does not offer this model",
  MODEL_QUOTA_DETAIL,
  "the request was refused; check the model's context and output limits",
  "check the API key and its permissions",
  "the API key was refused; check that it is valid and has not expired",
  "the model is not available for this account",
  "check the key's credit balance and spending limit",
  "check model availability and the provider allowlist",
  "check the model ID and that the key's organization can use it",
  "the ChatGPT connection was refused, so connect ChatGPT again",
  "your ChatGPT plan's usage limit may be reached, see https://chatgpt.com/settings/usage",
  "your ChatGPT plan may not allow this model",
]);

/**
 * Reads a session's events for the calls that were MISSING their usage: an assistant call whose response stream began (so a gateway may have settled it) and that was not refused before the stream, yet reported no
 * tokens and no cost. The ONE place this rule lives: the usage checkpointer counts these calls for the broker (`usageMissingCalls`), and a setup run's spend meter counts them as spend.
 * Feed it every event of the session, in order. `observe` answers undefined for any event that is not an assistant message's end, and for that end whether the call is a missing-usage one.
 */
export function createMissingUsageDetector(): { observe(event: unknown): boolean | undefined } {
  let streamStarted = false;
  return {
    observe(event) {
      const value = event as { type?: unknown; assistantMessageEvent?: { type?: unknown }; message?: { role?: unknown; stopReason?: unknown; errorMessage?: string; status?: unknown; content?: { type?: unknown; text?: unknown; thinking?: unknown }[]; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } } | null | undefined;
      // Pi emits message_start both for a provider start (unfinished stop reason)
      // and for a first-event refusal (already error/aborted). Only the former is evidence.
      if (value?.type === "message_start" && value.message?.role === "assistant" && ["pending", "stop", "length", "toolUse"].includes(String(value.message.stopReason))) streamStarted = true;
      if (value?.type === "message_update" && value.message?.role === "assistant") {
        const kind = value.assistantMessageEvent?.type;
        if (typeof kind === "string" && (kind === "start" || /^(text|thinking|toolcall)_(start|delta|end)$/u.test(kind))) streamStarted = true;
        return undefined;
      }
      if (value?.type !== "message_end" || value.message?.role !== "assistant") return undefined;
      const message = value.message, u = message.usage;
      const began = streamStarted || (Array.isArray(message.content) && message.content.some(c => c.type === "toolCall" || (typeof c.text === "string" && c.text.length > 0) || (typeof c.thinking === "string" && c.thinking.length > 0)));
      streamStarted = false; // a retry is a separate attempt, with its own stream evidence
      const failure = sanitizeModelCallEvent(event)?.modelCall;
      const text = message.errorMessage;
      const status = message.status ?? (failure?.outcome === "failed" ? failure.status : undefined)
        ?? Number(typeof text === "string" ? (/^([4-5]\d\d)(?=[\s:]|$)/u.exec(text) ?? /^[A-Za-z][A-Za-z0-9 ._-]{0,40} API error \(([4-5]\d\d)\)/u.exec(text))?.[1] : undefined);
      const refusal = !began && (message.stopReason === "error" || message.stopReason === "aborted") && (
        (typeof status === "number" && status >= 300 && status <= 599)
        || (failure?.outcome === "failed" && ["key-rejected", "limit-or-rate-limited", "model-not-found", "request-rejected"].includes(failure.class))
        || (typeof text === "string" && PRE_STREAM_REFUSAL_DETAILS.has(/^[A-Za-z][A-Za-z0-9 ._-]{0,30} request failed; ([^\n]{1,200})$/u.exec(text)?.[1] ?? ""))
        || budgetExhaustedFromMarker(text) !== undefined || modelNotAllowedFromMarker(text) !== undefined || text === "Retry cancelled" || text === "Model request refused: the conversation holds tool calls but declares no tools"
      );
      // Only a started response stream can be a missing-usage call.
      return began && !refusal && (u === undefined || ![u.input, u.output, u.cacheRead, u.cacheWrite, u.cost?.total].some(n => typeof n === "number" && Number.isFinite(n) && n > 0));
    },
  };
}

export function createUsageCheckpointer(input: {
  enabled: boolean;
  intervalMs?: number;
  /** What the session's stats held before this run (a reopened conversation); undefined: a session made new. */
  baseline: UsageStats | undefined;
  stats: () => UsageStats;
  model: () => UsageModel;
  requested: { thinkingLevel?: unknown };
  send: (payload: Record<string, unknown>) => void;
  now?: () => number;
}): UsageCheckpointer {
  const now = input.now ?? Date.now;
  const interval = input.intervalMs ?? USAGE_CHECKPOINT_MS;
  let reported: UsageStats | undefined = input.baseline;
  let checkpointed = false;
  const detector = createMissingUsageDetector();
  let missingCalls = 0;
  let reportedMissingCalls = 0;
  let last = now();
  const report = (): void => {
    try {
      const stats = input.stats();
      const spent = statsSince(stats, reported);
      if (spentNothing(spent) && missingCalls === reportedMissingCalls) return;
      const usage = redactCredentials(telemetryOf(spent, input.model(), "SUCCEEDED")) as Record<string, unknown>;
      const usageMissingCalls = missingCalls - reportedMissingCalls;
      reportedMissingCalls = missingCalls;
      reported = stats;
      checkpointed = true;
      last = now();
      // `checkpoint`: the spend so far, not the session's end (its outcome is not known yet).
      input.send(usageForControlPlane({ ...usage, ...(usageMissingCalls > 0 ? { usageMissingCalls } : {}), checkpoint: true }, input.requested));
    } catch { /* stats that cannot be read now are reported at the end */ }
  };
  return {
    get checkpointed() { return checkpointed; },
    observe(event) {
      const missing = detector.observe(event);
      // Only an assistant message's end goes on; only a started response stream can contribute a missing-usage call.
      if (missing === undefined) return;
      if (missing) missingCalls += 1;
      if (!input.enabled || now() - last < interval) return;
      report();
    },
    checkpointNow() {
      if (input.enabled) report();
    },
    endReport(stats, model, outcome, requested) {
      const left = statsSince(stats, reported);
      const usageMissingCalls = missingCalls - reportedMissingCalls;
      if (!checkpointed && spentNothing(left) && usageMissingCalls === 0) return undefined;
      const usage = redactCredentials(telemetryOf(left, model, outcome)) as Record<string, unknown>;
      return usageForControlPlane({ ...usage, ...(usageMissingCalls > 0 ? { usageMissingCalls } : {}), ...(checkpointed ? { final: true } : {}) }, requested);
    },
  };
}
