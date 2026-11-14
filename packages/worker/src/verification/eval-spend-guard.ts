// One whole-stage hold. The runner cannot supply accounting or retain a usable call after close.
import { EVAL_NOT_RUN_CLASSES, type EvalNotRunReason } from "@agentx/contracts";
import type { EvalMeterReservation, EvalSpendGrant, MonthlyMeter } from "@agentx/contracts";
export interface MeteredEvalStage {
  call: EvalMeterReservation["call"];
  close(): Promise<void>;
  usage(): { calls: number; costMicros?: number };
  failure(): EvalNotRunReason | undefined;
  callFailure(): EvalNotRunReason | undefined;
}
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const stopped = (): Error => new Error("eval stage stopped");
export async function openMeteredStage(input: { grant: EvalSpendGrant; meter: MonthlyMeter; calls: number; costMicros: number }): Promise<MeteredEvalStage | undefined> {
  if (typeof input !== "object" || input === null) return undefined;
  const { grant, meter, calls, costMicros } = input;
  if (typeof grant !== "object" || grant === null) return undefined;
  if (!whole(calls) || calls < 1 || !whole(costMicros) || !whole(grant.maxCalls) || !whole(grant.maxCostMicros) || calls > grant.maxCalls || costMicros > grant.maxCostMicros) return undefined;
  let reservation: EvalMeterReservation | undefined;
  try { reservation = await meter.reserve({ approval: grant, calls, costMicros }); } catch { return undefined; }
  if (typeof reservation !== "object" || reservation === null || typeof reservation.call !== "function" || typeof reservation.close !== "function") return undefined;
  const held = reservation;
  let dispatched = 0; let cost = 0; let costKnown = true; let closed = false;
  let failure: EvalNotRunReason | undefined; let closing: Promise<void> | undefined;
  let callFailure: EvalNotRunReason | undefined;
  const pending = new Set<Promise<unknown>>();
  const call: EvalMeterReservation["call"] = frame => {
    if (closed || failure !== undefined || dispatched >= calls) return Promise.reject(stopped());
    dispatched++;
    const work = (async () => {
      try {
        const result = await held.call(frame);
        if (!whole(result.costMicros)) costKnown = false;
        else { cost += result.costMicros; if (!Number.isSafeInteger(cost)) costKnown = false; }
        if (result.calls !== 1 || !costKnown) { failure = "provider_error"; throw stopped(); }
        if (cost > costMicros) { failure = "cap"; throw stopped(); }
        if (result.class !== "ok") {
          failure = EVAL_NOT_RUN_CLASSES.find(reason => reason === result.class) ?? "provider_error";
          throw stopped();
        }
        return result;
      } catch {
        if (failure === undefined) { failure = "provider_error"; costKnown = false; }
        callFailure = failure;
        throw stopped();
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  return {
    call,
    usage: () => ({ calls: dispatched, ...(costKnown ? { costMicros: cost } : {}) }),
    failure: () => failure,
    callFailure: () => callFailure,
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...pending]);
        try { await held.close(); } catch { failure ??= "provider_error"; costKnown = false; }
      })();
      return closing;
    },
  };
}
