import { EvalBaseRecordSchema, evalBaseCacheKey, type EvalBaseCacheKeyParts } from "@agentx/contracts";
import { evalHealthKey, runEvalHealth, type EvalHealthInput, type EvalHealthResult } from "./eval-health.js";
type RefreshResult = EvalHealthResult | { status: "cached" | "measuring" };
export interface EvalBaselines {
  /** Start after each merge to main. The host owns and MUST join the returned promise on shutdown. */
  afterMerge(input: EvalHealthInput): Promise<RefreshResult>;
  /** A task never waits for a running setup/merge measurement; a real miss still takes an in-task baseline. */
  forTask(input: EvalHealthInput): Promise<"ready" | "measuring" | "awaiting_confirmation" | "unavailable">;
}
const unavailable = (): EvalHealthResult => ({ status: "not_run", reason: "unavailable", message: "Not run: baseline could not be read." });
const cached = async (input: EvalHealthInput, parts: EvalBaseCacheKeyParts): Promise<boolean> => {
  const base = EvalBaseRecordSchema.safeParse(await input.cache.read(parts));
  return base.success && base.data.questions !== undefined;
};
/** The cache owns company-scoped marks and expiry; the map only shortcuts same-host work. */
export function createEvalBaselines(): EvalBaselines {
  const running = new Map<string, Promise<RefreshResult>>();
  const refresh = (input: EvalHealthInput, parts: EvalBaseCacheKeyParts, cacheChecked: boolean): Promise<RefreshResult> => {
    const key = evalBaseCacheKey(parts);
    if (running.has(key)) return Promise.resolve({ status: "measuring" });
    const work = (async (): Promise<RefreshResult> => {
      try {
        if (!cacheChecked && await cached(input, parts)) return { status: "cached" };
        const cache = input.cache;
        if (cache.startMeasurement === undefined || cache.finishMeasurement === undefined) return unavailable();
        const claim = await cache.startMeasurement(parts);
        if (claim.status === "measuring") return { status: "measuring" };
        if (claim.status !== "started") return unavailable();
        try {
          // Another host may have saved the baseline while this claim was waiting.
          if (await cached(input, parts)) return { status: "cached" };
          return await runEvalHealth(input);
        }
        finally {
          // A store outage leaves the bounded stale mark. It cannot erase measured results.
          await cache.finishMeasurement(parts, claim.mark).catch(() => {});
        }
      } catch { return unavailable(); }
    })();
    running.set(key, work);
    void work.then(() => running.delete(key), () => running.delete(key));
    return work;
  };
  return {
    afterMerge(input) {
      try { return refresh(input, evalHealthKey(input), false); }
      catch { return Promise.resolve({ status: "not_run", reason: "invalid_identity", message: "Not run: baseline identity could not be read." }); }
    },
    async forTask(input) {
      try {
        const parts = evalHealthKey(input); const key = evalBaseCacheKey(parts);
        if (await cached(input, parts)) return "ready";
        if (running.has(key)) return "measuring";
        const state = await input.cache.readMeasurement?.(parts);
        if (state === "measuring") return "measuring";
        if (state !== "idle") return "unavailable";
        const result = await refresh(input, parts, true);
        if (result.status === "cached" || (result.status === "measured" && result.baseline === "stored")) return "ready";
        if (result.status === "measuring") return "measuring";
        return result.status === "not_run" && result.reason === "not_confirmed" ? "awaiting_confirmation" : "unavailable";
      } catch { return "unavailable"; }
    },
  };
}
