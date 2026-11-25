import { completePrice, ratesForUsage, usageEstimated } from "./price-tiers.js";
import { record, whole } from "./model-gateway-token.js";
import { CORRECTION_RUN_MAX, CORRECTION_RUN_MS, MAX_ENTRIES_PER_SOURCE } from "./price-constants.js";
import { mediaEstimated, usageCost } from "./estimate.js";
import { validCaps, type CapsSource } from "./caps.js";
import { validPrice, type PriceOrigin, type PriceSource } from "./price.js";
import type { CorrectionResult, Meter } from "./meter.js";
import type { PriceKey } from "./price-snapshot.js";
export interface CorrectionReport { corrected: number; already: number; skipped: number; expired: number; unknown: number; more: boolean }
export interface CorrectionLog { event: "price_corrected" | "price_expired" | "price_correction_busy" | "price_correction_unknown" | "price_correction_operator_review" | "price_correction_cap_exceeded"; deltaMicros?: number }
interface RunOptions { meter: Meter; now: number; runId: string; log?: (line: CorrectionLog) => void; clock?: () => number }
interface Continuation { resumes?: Map<string, string>; keys?: string; active?: { key: PriceKey; nextKey?: string; calls?: string } }
// Owned by the runner, scoped to the meter instance. A restarted process safely rescans from the start.
// Concurrent runs may revisit a page; only the meter's pending-status transaction arbitrates writes.
const continuations = new WeakMap<Meter, Continuation>();
const retries = new WeakMap<Meter, Map<string, { attempts: number; after: number }>>();
const MAX_UNKNOWN_ATTEMPTS = 3;
const UNKNOWN_BACKOFF_MS = 60_000;
const ATTEMPT_MS = 1000;
const expiryContinuations = new WeakMap<Meter, string>();
function runContext(options: RunOptions) {
  const report: CorrectionReport = { corrected: 0, already: 0, skipped: 0, expired: 0, unknown: 0, more: false };
  const clock = options.clock ?? performance.now.bind(performance); const deadline = clock() + CORRECTION_RUN_MS;
  const controller = new AbortController(); let visited = 0;
  const timer = setTimeout(() => controller.abort(), CORRECTION_RUN_MS);
  const expired = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("correction deadline")), { once: true }));
  void expired.catch(() => undefined);
  const room = () => {
    if (clock() >= deadline) controller.abort();
    return !controller.signal.aborted && visited < CORRECTION_RUN_MAX;
  };
  const wait = async <T>(operation: T | Promise<T>): Promise<T> => {
    if (clock() >= deadline) controller.abort();
    const promise = Promise.resolve(operation); void promise.catch(() => undefined);
    if (controller.signal.aborted) throw new Error("correction deadline");
    return Promise.race([promise, expired]);
  };
  const log = (line: CorrectionLog) => { try { options.log?.(line); } catch { /* Observability never changes a transaction. */ } };
  const unknown = () => { report.unknown++; report.more = true; log({ event: "price_correction_unknown" }); };
  const transaction = async (operation: () => Promise<CorrectionResult>): Promise<boolean> => {
    try {
      const result = await wait(operation());
      if (result.status === "unknown") { unknown(); return false; }
      if (result.status === "corrected" && Number.isSafeInteger(result.deltaMicros)) { report.corrected++; log({ event: "price_corrected", deltaMicros: result.deltaMicros }); if (result.capExceeded === true && result.deltaMicros > 0) log({ event: "price_correction_cap_exceeded" }); }
      else if (result.status === "already") report.already++;
      else if (result.status === "expired") { report.expired++; log({ event: "price_expired" }); }
      else if (result.status === "busy" || result.status === "missing") { report.skipped++; report.more = true; if (result.status === "busy") log({ event: "price_correction_busy" }); }
      else { unknown(); return false; }
      return true;
    } catch { unknown(); return false; }
  };
  const attempt = async (operation: (signal: AbortSignal) => Promise<CorrectionResult>): Promise<boolean> => {
    const local = new AbortController(); const abort = () => local.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    const timer = setTimeout(abort, ATTEMPT_MS);
    const unknown = new Promise<CorrectionResult>((resolve) => local.signal.addEventListener("abort", () => resolve({ status: "unknown" }), { once: true }));
    try { return await transaction(() => Promise.race([Promise.resolve().then(() => operation(local.signal)), unknown])); }
    finally { clearTimeout(timer); local.abort(); controller.signal.removeEventListener("abort", abort); }
  };
  return { report, room, wait, transaction, attempt, log, signal: controller.signal, visit: () => { visited++; }, remaining: () => CORRECTION_RUN_MAX - visited, close: () => { clearTimeout(timer); controller.abort(); } };
}
function validRun(options: RunOptions): boolean { return whole(options.now) && typeof options.runId === "string" && options.runId.length > 0 && options.runId.length <= 512; }
export async function runCorrections(options: RunOptions & { prices: PriceSource; caps: CapsSource }): Promise<CorrectionReport> {
  const ctx = runContext(options); const { report } = ctx;
  const retry = retries.get(options.meter) ?? new Map<string, { attempts: number; after: number }>(); retries.set(options.meter, retry);
  const state = structuredClone(continuations.get(options.meter) ?? {});
  const resumes = state.resumes ?? new Map<string, string>(); state.resumes = resumes;
  try {
    if (!validRun(options)) { report.more = true; return report; }
    while (ctx.room()) {
      if (state.active === undefined) {
        const page = await ctx.wait(options.meter.pendingKeys(1, state.keys));
        if (page.items.length === 0) { delete state.keys; break; }
        ctx.visit();
        state.active = { key: page.items[0]!, ...(page.cursor === undefined ? {} : { nextKey: page.cursor }) };
      }
      const active = state.active;
      const keyId = JSON.stringify(active.key); const resume = resumes.get(keyId);
      if (active.calls === undefined && resume !== undefined) active.calls = resume;
      resumes.delete(keyId);
      const finishKey = () => { delete state.active; if (active.nextKey === undefined) delete state.keys; else state.keys = active.nextKey; };
      const partial = options.prices.correctionFor !== undefined;
      const price = await ctx.wait(partial ? options.prices.correctionFor!(active.key.provider, active.key.model) : options.prices.priceFor(active.key.provider, active.key.model, ctx.signal));
      const priceVersion = record(price)?.priceVersion;
      const valid = partial ? typeof record(price)?.estimated === "boolean" && whole(priceVersion) && validPrice({ ...price, estimated: false }, Number.MAX_SAFE_INTEGER) : validPrice(price) && whole(priceVersion);
      const rawOrigin = record(record(price)?.origin);
      if (!valid || price === undefined || rawOrigin === undefined || typeof rawOrigin.source !== "string" || !["litellm", "aws", "override"].includes(rawOrigin.source) || !whole(rawOrigin.fetchedAt)) {
        report.skipped++; finishKey(); if (active.nextKey === undefined) break; continue;
      }
      if (!ctx.room()) { report.more = true; break; }
      const priceSource: PriceOrigin = { source: rawOrigin.source as PriceOrigin["source"], fetchedAt: rawOrigin.fetchedAt };
      const page = await ctx.wait(options.meter.pendingFor(active.key, ctx.remaining(), active.calls));
      let complete = true;
      for (const call of page.items) {
        if (!ctx.room()) { complete = false; break; }
        ctx.visit();
        // Price evidence cannot resolve missing usage, including the placeholder zero counts.
        if (call.chargeStatus === "awaiting_usage") { report.skipped++; report.more = true; continue; }
        const priorAttempt = retry.get(call.callKey);
        if (priorAttempt !== undefined && (priorAttempt.attempts >= MAX_UNKNOWN_ATTEMPTS || options.now < priorAttempt.after)) { report.skipped++; report.more = true; continue; }
        if (priorAttempt === undefined && retry.size >= MAX_ENTRIES_PER_SOURCE) { report.skipped++; report.more = true; ctx.log({ event: "price_correction_operator_review" }); continue; }
        const caps = await ctx.wait(options.caps.capsFor(call, ctx.signal));
        if (!validCaps(caps)) { report.skipped++; report.more = true; continue; }
        // Last item may consume the count budget, but must still finish within the shared time bound.
        await ctx.wait(undefined);
        const rates = ratesForUsage(price, call.usage.input + call.usage.cacheRead + call.usage.cacheWrite);
        const usedRates = [[call.usage.input, rates.inputMicrosPerMTok], [call.usage.output, rates.outputMicrosPerMTok],
          [call.usage.cacheRead, rates.cacheReadMicrosPerMTok!], [call.usage.cacheWrite5m ?? call.usage.cacheWrite, rates.cacheWrite5mMicrosPerMTok!],
          [call.usage.cacheWrite1h ?? call.usage.cacheWrite, rates.cacheWrite1hMicrosPerMTok!]];
        // A media call is re-priced with the model's current audio/video rates; none: saturates to operator review below.
        let media; try { media = options.prices.mediaFor?.(active.key.provider, active.key.model); } catch { media = undefined; }
        const saturatingPrice = { ...price, estimated: true, ...(media === undefined ? {} : { media }) };
        const realMicros = Math.max(1, usageCost(call.usage, saturatingPrice));
        if (completePrice(price).operatorReview || usedRates.some(([count, rate]) => count! > 0 && rate! >= Number.MAX_SAFE_INTEGER) || realMicros >= Number.MAX_SAFE_INTEGER) {
          report.skipped++; report.more = true; ctx.log({ event: "price_correction_operator_review" }); continue;
        }
        // Reserve retry state before awaiting: concurrent runners cannot each start an attempt.
        if (retry.get(call.callKey) !== priorAttempt) { report.skipped++; report.more = true; continue; }
        const attempts = (priorAttempt?.attempts ?? 0) + 1;
        retry.set(call.callKey, { attempts, after: options.now + UNKNOWN_BACKOFF_MS * 2 ** (attempts - 1) });
        if (!await ctx.attempt((signal) => options.meter.correct({ callKey: call.callKey, realMicros, caps, priceSource, priceVersion: priceVersion as number, estimated: (partial && usageEstimated(price, call.usage)) || mediaEstimated(call.usage, saturatingPrice), now: options.now, runId: options.runId, signal }))) {
          if (attempts >= MAX_UNKNOWN_ATTEMPTS) ctx.log({ event: "price_correction_operator_review" });
          continue; // Keep the pending ledger row, but advance this page for other calls.
        }
        retry.delete(call.callKey);
      }
      if (!complete) { report.more = true; break; }
      if (page.cursor !== undefined) {
        active.calls = page.cursor; report.more = true;
        // Yield after one page even for the last key; resume its calls on the next traversal.
        if (resumes.size >= MAX_ENTRIES_PER_SOURCE) resumes.delete(resumes.keys().next().value!);
        resumes.set(keyId, page.cursor); finishKey();
        break;
      }
      finishKey(); if (active.nextKey === undefined) break;
    }
    if (state.active !== undefined || state.keys !== undefined || resumes.size > 0) report.more = true;
  } catch { report.more = true; }
  finally { continuations.set(options.meter, state); ctx.close(); }
  return report;
}
/** Independent maintenance run: no price or caps read and no fabricated correction provenance. */
export async function runExpirySweep(options: RunOptions): Promise<CorrectionReport> {
  const ctx = runContext(options); const { report } = ctx;
  try {
    if (!validRun(options)) { report.more = true; return report; }
    const page = await ctx.wait(options.meter.pendingExpired(options.now, ctx.remaining(), expiryContinuations.get(options.meter)));
    for (const call of page.items) {
      if (!ctx.room()) { report.more = true; return report; }
      ctx.visit();
      if (!await ctx.transaction(() => options.meter.expire({ callKey: call.callKey, now: options.now, runId: options.runId, signal: ctx.signal }))) return report;
    }
    if (page.cursor === undefined) expiryContinuations.delete(options.meter);
    else { expiryContinuations.set(options.meter, page.cursor); report.more = true; }
  } catch { report.more = true; }
  finally { ctx.close(); }
  return report;
}
