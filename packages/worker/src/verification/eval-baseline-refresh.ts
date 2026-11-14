import { EvalBaseRecordSchema, evalBaseCacheKey } from "@agentx/contracts";
import { runEvalHealth, type EvalHealthInput, type EvalHealthResult } from "./eval-health.js";
export interface EvalBaselines {
  /** Start after each merge to main. The host owns and MUST join the returned promise on shutdown. */
  afterMerge(input: EvalHealthInput): Promise<EvalHealthResult | { status: "cached" }>;
  /** A task never waits for an already running setup/merge measurement; otherwise it takes a fresh baseline on a miss. */
  forTask(input: EvalHealthInput): Promise<"ready" | "measuring" | "unavailable">;
}
/** In-flight identities include company/project. The document cache owns persistent expiry and isolation. */
export function createEvalBaselines(): EvalBaselines {
  const running = new Map<string, Promise<EvalHealthResult | { status: "cached" }>>();
  const afterMerge: EvalBaselines["afterMerge"] = input => {
    let key: string;
    try { key = evalBaseCacheKey(input.key); } catch { return Promise.resolve({ status: "not_run", message: "Not run: baseline identity could not be read." }); }
    const existing = running.get(key);
    if (existing !== undefined) return existing;
    const work = (async () => {
      try {
        const base = EvalBaseRecordSchema.safeParse(await input.cache.read(input.key));
        if (base.success && base.data.questions !== undefined) return { status: "cached" as const };
        return await runEvalHealth(input);
      } catch { return { status: "not_run" as const, message: "Not run: baseline could not be read." }; }
    })();
    running.set(key, work);
    void work.then(() => running.delete(key), () => running.delete(key));
    return work;
  };
  return {
    afterMerge,
    async forTask(input) {
      try {
        if (running.has(evalBaseCacheKey(input.key))) return "measuring";
        const result = await afterMerge(input);
        return result.status === "cached" || (result.status === "measured" && result.baseline === "stored") ? "ready" : "unavailable";
      } catch { return "unavailable"; }
    },
  };
}
