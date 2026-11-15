// The eval's model-access port. Code never holds the customer's product key or decides the payer: an injected `EvalModelAccess`
// does. In production it is the gateway's product route reached with the task token Code mints (`/v1/internal/model-access`);
// in tests it is a script. This file turns one hold plus an egress into the `MonthlyMeter` the final-check eval already consumes.
//
// Rules, each with a test: the WHOLE estimate is held before any call; a call beyond the held count, or once settled spend reached the
// held cost, is refused before it reaches the egress (a budget refusal: cap with the cost known, and the refused call is not counted), and at most
// four calls are open at once; every call is ONE attempt (no retry, a retry can double-spend); a fault, a malformed or over-long answer
// or a deadline is "provider_error" with an UNKNOWN cost (NaN), so the stage stops and the spend is retained, never a pass;
// close joins every call and releases only what is known to be unspent; no provider words, header, key or error text leaves here.
import {
  EVAL_MAX_IN_FLIGHT_CEILING, MODEL_EGRESS_CLASSES,
  type EvalMeterCall, type EvalMeterReservation, type EvalSpendGrant, type ModelEgress, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressScope, type MonthlyMeter,
} from "@agentx/contracts";
import { EvalCallRefused } from "./eval-spend-guard.js";

/**
 * One whole-stage hold, issued by the gateway after it re-checked the grant against the company's and project's monthly room.
 * The gateway ENFORCES it: once the spend on this hold has reached the held cost (or the held call count), it must refuse the next call
 * without forwarding it. Following DEC 165 (the monthly cap's rule), it reserves per call and blocks after any call that settles above its
 * reservation, so the hold is passed by at most ONE call, which it flags with `overrun` on that call's settle; with several calls open at
 * once "at most one" holds only if the reservation is taken per call, not per stage. Code's own ceilings only look at settled spend, so they are a second line, not the first.
 */
export interface EvalModelHold {
  /** Forwards one frame under this hold only. The adapter holds the product key; the frame never names a company or project. */
  readonly egress: ModelEgress;
  /** Opaque: produced and read only by the adapter that issued it. */
  readonly scope: ModelEgressScope;
  /** Called once, after every call joined. `unknown` means a call's cost could not be read: give nothing back. */
  release(spent: { readonly calls: number; readonly costMicros: number; readonly unknown: boolean }): Promise<void>;
}
export interface EvalModelAccess {
  /** Enforcement rule for the hold it returns: reserve per call, refuse once spend reaches the hold, pass it by at most one call (the DEC 165 pattern), flagged `overrun`. Atomically hold the whole estimate within the monthly cap and the approved project budget. Undefined (or a throw) is a refusal with no call made. */
  hold(input: { readonly grant: EvalSpendGrant; readonly calls: number; readonly costMicros: number }): Promise<EvalModelHold | undefined>;
}
export interface EvalMeterOptions {
  /** One call's deadline. The egress is aborted at it; the call counts as an unknown spend. Default 2 minutes. */
  readonly callTimeoutMs?: number;
  /** All answer bytes one call may return. Default 10 MiB, the model bridge's own response limit. */
  readonly responseBytes?: number;
}
export const EVAL_CALL_TIMEOUT_MS = 120_000;
export const EVAL_RESPONSE_BYTES = 10 * 1024 * 1024;

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const stopped = (): Error => new Error("eval stage stopped");
const classes: readonly string[] = MODEL_EGRESS_CLASSES;
const unknownCall = (): EvalMeterCall => ({ class: "provider_error", calls: 1, costMicros: Number.NaN });
const positive = (n: unknown, fallback: number): number => (typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : fallback);

export function createEvalMeter(access: EvalModelAccess, options: EvalMeterOptions = {}): MonthlyMeter {
  const timeoutMs = positive(options.callTimeoutMs, EVAL_CALL_TIMEOUT_MS);
  const responseLimit = positive(options.responseBytes, EVAL_RESPONSE_BYTES);
  return {
    async reserve(input) {
      if (typeof access?.hold !== "function" || typeof input !== "object" || input === null) return undefined;
      const { approval, calls, costMicros } = input;
      if (!whole(calls) || calls < 1 || !whole(costMicros) || typeof approval !== "object" || approval === null) return undefined;
      let hold: EvalModelHold | undefined;
      try { hold = await access.hold({ grant: approval, calls, costMicros }); } catch { return undefined; }
      if (typeof hold !== "object" || hold === null || typeof hold.egress?.forward !== "function" || typeof hold.release !== "function" || typeof hold.scope !== "object" || hold.scope === null) {
        // Never keep a hold that cannot be used; a release that fails changes nothing for the refusal.
        try { await (hold as { release?: EvalModelHold["release"] } | undefined)?.release?.({ calls: 0, costMicros: 0, unknown: false }); } catch { /* fixed refusal below */ }
        return undefined;
      }
      return reservation(hold, calls, costMicros, timeoutMs, responseLimit);
    },
  };
}

function reservation(hold: EvalModelHold, maxCalls: number, maxCost: number, timeoutMs: number, responseLimit: number): EvalMeterReservation {
  let dispatched = 0; let spent = 0; let unknown = false; let closed = false; let stop = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  /** Reads one answer: exactly one head, any chunks, exactly one settle, in that order and no more. Anything else is unreadable. */
  async function read(frame: ModelEgressFrame, signal: AbortSignal): Promise<EvalMeterCall> {
    const events: ModelEgressEvent[] = [];
    let state: "start" | "body" | "done" = "start"; let bytes = 0; let settled: Extract<ModelEgressEvent, { kind: "settle" }> | undefined;
    for await (const event of hold.egress.forward(hold.scope, frame, { signal })) {
      if (typeof event !== "object" || event === null) return unknownCall();
      if (event.kind === "head") { if (state !== "start") return unknownCall(); state = "body"; events.push(event); continue; }
      if (event.kind === "chunk") {
        if (state !== "body" || !(event.bytes instanceof Uint8Array)) return unknownCall();
        bytes += event.bytes.byteLength;
        if (bytes > responseLimit) return unknownCall();
        events.push(event); continue;
      }
      if (event.kind === "settle") { if (state !== "body") return unknownCall(); state = "done"; settled = event; events.push(event); continue; }
      return unknownCall();
    }
    if (settled === undefined || state !== "done") return unknownCall();
    if (!whole(settled.costMicros) || !classes.includes(settled.class)) return unknownCall();
    if (settled.overrun === true) stop = true;
    return { class: settled.class, calls: 1, costMicros: settled.costMicros, ...(settled.class === "ok" ? { events } : {}) };
  }
  // At most EVAL_MAX_IN_FLIGHT_CEILING calls are open at once; the rest wait their turn. Spend is only known when a call settles, so this bounds how far
  // the held cost can be passed (by that many calls) before the next dispatch check sees it; the gateway enforces the hold itself.
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => (inFlight < EVAL_MAX_IN_FLIGHT_CEILING ? (inFlight++, Promise.resolve()) : new Promise<void>(resolve => { waiting.push(() => { inFlight++; resolve(); }); }));
  const freeSlot = (): void => { inFlight--; waiting.shift()?.(); };
  /** Why a call may not start: a closed, stopped or unknown-spend stage is a plain stop; a used-up held count or cost is a budget refusal (cap, cost known). */
  const refusal = (): Error | undefined => (closed || stop || unknown ? stopped() : dispatched >= maxCalls || spent >= maxCost ? new EvalCallRefused("cap") : undefined);
  const call: EvalMeterReservation["call"] = frame => {
    const first = refusal();
    if (first !== undefined) return Promise.reject(first);
    const work: Promise<EvalMeterCall> = (async () => {
      await acquire();
      try {
        // Re-checked after waiting: the stage may have closed, stopped or spent up in the meantime.
        const again = refusal();
        if (again !== undefined) throw again;
        dispatched++;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<EvalMeterCall>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unknownCall()); }, timeoutMs); });
        try {
          // A fault of any kind, including one whose words hold a key, is the one fixed unknown outcome.
          const result = await Promise.race([read(frame, controller.signal).catch(unknownCall), deadline]);
          if (!whole(result.costMicros)) { unknown = true; return result; }
          spent += result.costMicros;
          if (!Number.isSafeInteger(spent)) unknown = true;
          return result;
        } finally { if (timer !== undefined) clearTimeout(timer); }
      } finally { freeSlot(); }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  return {
    call,
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...pending]);
        try { await hold.release({ calls: dispatched, costMicros: Number.isSafeInteger(spent) ? spent : Number.MAX_SAFE_INTEGER, unknown }); } catch { throw new Error("eval hold could not be released"); }
      })();
      return closing;
    },
  };
}
