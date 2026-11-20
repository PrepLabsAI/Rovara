import type { DocumentStore } from "@agentx/contracts";
import type { CoreService } from "../core-host/core-runtime.js";

export const CORE_PASS_MAX_MS = 20_000;
export const CORE_PASS_MAX_OPERATIONS = 512;
export const CORE_PASS_MAX_ITEMS = 1000;
export const CORE_PASS_MAX_BYTES = 4 * 1024 * 1024;
class PassExhausted extends Error {}

/** Cooperative bound: join every awaited call; never race storage against a timeout and leave a late writer behind. */
export function boundedCorePass(store: DocumentStore, now: () => number, work: (store: DocumentStore, deadlineMs: number) => Promise<Record<string, unknown>>, reserveMs = 0): CoreService {
  return {
    async pass({ budgetMs }) {
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { complete: false, reason: "budget" };
      const ms = Math.min(budgetMs, CORE_PASS_MAX_MS);
      const deadline = now() + ms;
      const hardDeadline = deadline + reserveMs;
      let operations = 0, bytes = 0, items = 0, expired = false, exhausted = false;
      const check = () => { if (expired || now() >= hardDeadline || bytes > CORE_PASS_MAX_BYTES || items > CORE_PASS_MAX_ITEMS) { exhausted = true; throw new PassExhausted(); } };
      const timer = setTimeout(() => { expired = true; }, ms + reserveMs);
      timer.unref();
      // Guard every store operation, including internal reads/writes of the existing services. No key rewriting or tenant inference here.
      const limited = new Proxy(store, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            check();
            if (operations >= CORE_PASS_MAX_OPERATIONS) { exhausted = true; throw new PassExhausted(); }
            operations += 1;
            const result: unknown = await Reflect.apply(value, target, args);
            items += Array.isArray(result) ? result.length : result !== null && typeof result === "object" && Array.isArray((result as { items?: unknown }).items) ? (result as { items: unknown[] }).items.length : result === undefined ? 0 : 1;
            bytes += Buffer.byteLength(JSON.stringify(result) ?? "");
            check();
            return result;
          };
        },
      });
      try {
        const result = await work(limited, deadline);
        check();
        return result;
      } catch {
        if (exhausted) return { complete: false, reason: "budget" };
        throw new Error("the core job could not finish");
      } finally { clearTimeout(timer); }
    },
  };
}
