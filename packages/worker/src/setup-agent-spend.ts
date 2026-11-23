// What a setup run has spent and what it reports (money). Split from setup-agent-run.ts so the run reads as the run and the money rules sit in one place:
//   - `SetupSpendMeter`: the run's OWN count of its spend, from each assistant turn's tokens, every token class at its own rate (`turnCostUsd`), and the next-turn reserve the governor keeps in hand.
//   - `createSetupUsageReporter`: books the run's model sessions (the setup session, and the stand-in writer's) through the worker's usual `usage` event, so the broker's usage booking puts the cost on the task.
import { SETUP_AGENT_MAX_OUTPUT_TOKENS, estimateNextTurnCents } from "./setup-agent-journal.js";
import { SETUP_NEXT_TURN_MARGIN_TOKENS, dearestInputPerMTok, priceForInputTokens, tokensOfUsage, turnCostUsd, type ModelPrice } from "./setup-agent-price.js";
import { createMissingUsageDetector, createTaskUsageTelemetry, createUsageCheckpointer, spentNothing, usageForControlPlane, type PiCacheRetention, type TaskUsageOutcome, type UsageCheckpointer, type UsageStats } from "./usage.js";
import { redactCredentials } from "./events.js";
import type { PiSessionHandle } from "./pi-session.js";

/** Pi's `message.usage` of an assistant message. */
export interface TurnUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

export class SetupSpendMeter {
  /** The last turn's whole input (plain, cache read and cache write; a first turn's size is not known: 20,000) and output, for the next-turn reserve. */
  private lastInputTokens = 20_000;
  private lastOutputTokens = 0;
  private readonly detector = createMissingUsageDetector();
  /** What the turns' tokens cost, in dollars (this is what is booked: `bookedUsd`). */
  ownUsd = 0;
  /** What was counted for failed calls with no usage that began (see `observe`). */
  private reserveUsd = 0;
  turns = 0;
  /** What is booked on the task as cost: the tokens' price, never the reserve (the broker books a missing-usage call itself). */
  get bookedUsd(): number { return this.ownUsd; }
  /** True once a turn reported any tokens: spend that is known even when its priced amount is 0 (a cache read priced at 0 with no output), so it is never read as unreadable. */
  sawTokens = false;
  constructor(private readonly price: ModelPrice) {}

  /**
   * The most the next model turn can cost, in whole cents, and never cheaper than it can be: the whole last context, the last output and 4 KiB more, ALL at the dearest input rate (the cache may have gone cold, e.g. while the run
   * waited for a website, so the context is written again; the write rate already holds the write premium), and the full output cap as output. A single call's bound, recomputed each time, not a running sum.
   */
  reserveCents(): number {
    const inputTokens = this.lastInputTokens + this.lastOutputTokens + SETUP_NEXT_TURN_MARGIN_TOKENS;
    // The next call is bounded at the size above: inside the base band it is bounded at the base rates, else at the pooled ones.
    return estimateNextTurnCents({
      inputTokens, inputPerMTok: dearestInputPerMTok(this.price, inputTokens),
      maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS, outputPerMTok: priceForInputTokens(this.price, inputTokens).outputPerMTok,
    });
  }

  /**
   * Every session event goes in (in order). When an assistant message ends, the turn is counted: every token class at its own rate. A call that BEGAN streaming, was not refused before its stream, and ended `error` or `aborted`
   * with NO usage may still have been settled by the gateway (at a cautious figure when its usage was missing), so the whole reserve as it stood before the turn is counted as spend for it, for the governor only (the
   * broker books such a call itself as a missing-usage call, so the reserve is kept out of `bookedUsd`). A call that never started (a 429, an overload, `fetch failed`, a refusal) was not settled and counts nothing, however
   * often Pi retries it. "Began and not refused" is read by the same detector the usage checkpoints use.
   */
  observe(event: unknown): void {
    const missing = this.detector.observe(event);
    if (missing === undefined) return;
    const message = (event as { message?: { usage?: TurnUsage; stopReason?: string } }).message;
    const reserveBefore = this.reserveCents();
    const tokens = tokensOfUsage(message?.usage);
    const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    this.turns += 1;
    if (input > 0) this.lastInputTokens = input;
    if (input + tokens.output > 0) this.sawTokens = true;
    this.lastOutputTokens = tokens.output;
    this.ownUsd += turnCostUsd(this.price, tokens);
    const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
    // A failed call that never began (a 429, an overload, `fetch failed`, a refusal) was not settled: known spend of 0, never the fail-closed "unreadable".
    if (failed && !missing) this.sawTokens = true;
    if (missing && failed && input + tokens.output === 0 && Number.isFinite(reserveBefore)) { this.reserveUsd += reserveBefore / 100; this.sawTokens = true; }
  }

  /** The run's own count for the governor: what the turns cost plus the reserve counted for calls that may have been settled with no usage. */
  get spentUsd(): number { return this.ownUsd + this.reserveUsd; }
}

/** What the stand-in writer's session spent, read just before it was closed. */
export interface WriterUsage { stats: UsageStats; model: { provider: string; modelId: string }; spendCents: number }

/** The usage event of the stand-in writer's session (the same shape as the setup session's), or undefined when it spent nothing. */
export function writerUsagePayload(used: WriterUsage, cacheRetention: PiCacheRetention | undefined, outcome: TaskUsageOutcome): Record<string, unknown> | undefined {
  // The cost is what the run's cap counted for the writer (never below it); a writer that used no tokens and cost nothing is not reported (an empty report would be charged a floor).
  const stats = { ...used.stats, cost: Math.max(used.stats.cost, used.spendCents / 100) };
  if (spentNothing(stats)) return undefined;
  const telemetry = redactCredentials(createTaskUsageTelemetry(stats, { ...used.model, ...(cacheRetention === undefined ? {} : { cacheRetention }) }, outcome)) as Record<string, unknown>;
  return usageForControlPlane(telemetry, {});
}

/** The outcome a usage report names: a person's Stop, a session that failed, or neither. */
function endOutcome(end: { cancelled: boolean; failed: boolean }): TaskUsageOutcome {
  if (end.cancelled) return "CANCELLED";
  return end.failed ? "FAILED" : "SUCCEEDED";
}

export interface SetupUsageReporter {
  /** The setup session is open: checkpoints start. */
  open(session: PiSessionHandle): void;
  /** A session event (after the run's own count of the turn, so a checkpoint carries it). */
  observe(event: unknown): void;
  /** The stand-in writer's usage, to be reported with the end. */
  setWriterUsage(used: WriterUsage): void;
  /** The last reports, once; never throws. A session that spent nothing sends nothing. */
  finish(session: PiSessionHandle | undefined, end: { cancelled: boolean; failed: boolean }): Promise<void>;
}

/**
 * The run's usage goes in checkpoints (most of the spend is booked even if the worker dies) and a last report at the end. The cost sent is the larger of the session's own and the run's count (the governor's figure), so what the
 * ledger books is never below what the run's budget counted. Without `report`, nothing is sent.
 */
export function createSetupUsageReporter(input: { report: ((payload: Record<string, unknown>) => Promise<void>) | undefined; cacheRetention: PiCacheRetention | undefined; ownUsd: () => number }): SetupUsageReporter {
  let tracker: UsageCheckpointer | undefined;
  let writer: WriterUsage | undefined;
  let finished = false;
  const modelOf = (session: PiSessionHandle) => ({ ...session.getModel(), ...(input.cacheRetention === undefined ? {} : { cacheRetention: input.cacheRetention }) });
  const statsOf = (session: PiSessionHandle): UsageStats => { const stats = session.getSessionStats(); return { ...stats, cost: Math.max(stats.cost, input.ownUsd()) }; };
  const send = async (payload: Record<string, unknown> | undefined): Promise<void> => {
    try { if (payload !== undefined) await input.report?.(payload); } catch { /* not reported now: the worker's batch is sent again */ }
  };
  return {
    open(session) {
      tracker = createUsageCheckpointer({ enabled: input.report !== undefined, baseline: undefined, stats: () => statsOf(session), model: () => modelOf(session), requested: {}, send: (payload) => { void send(payload); } });
    },
    observe(event) { tracker?.observe(event); },
    setWriterUsage(used) { writer = used; },
    async finish(session, end) {
      if (finished || input.report === undefined) return;
      finished = true;
      const outcome: TaskUsageOutcome = endOutcome(end);
      try { await send(session === undefined ? undefined : tracker?.endReport(statsOf(session), modelOf(session), outcome, {})); } catch { /* stats that cannot be read are not reported */ }
      try { await send(writer === undefined ? undefined : writerUsagePayload(writer, input.cacheRetention, outcome)); } catch { /* not reported */ }
    },
  };
}
