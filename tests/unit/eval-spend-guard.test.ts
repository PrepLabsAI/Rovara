import { describe, expect, it } from "vitest";
import type { EvalMeterCall, EvalSpendGrant, MonthlyMeter } from "../../packages/contracts/src/ports/eval-health.js";
import type { ModelEgressFrame } from "../../packages/contracts/src/model-egress/frame.js";
import { EvalCallRefused, openMeteredStage } from "../../packages/worker/src/verification/eval-spend-guard.js";
const frame = {} as ModelEgressFrame;
const grant: EvalSpendGrant = { company: "company-a", project: "p", selection: "eval", role: "owner", inputsDigest: "a".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
function world(output: EvalMeterCall = { calls: 1, costMicros: 10, class: "ok" }) {
  const dispatched: string[] = []; const closed: string[] = []; const holds: unknown[] = [];
  const meter: MonthlyMeter = { reserve: async request => { holds.push(request); return { call: async () => { dispatched.push(request.approval.company); return output; }, close: async () => { closed.push(request.approval.company); } }; } };
  return { meter, dispatched, closed, holds };
}
describe("one metered eval stage", () => {
  it("a call the reservation refused for budget is cap with the cost still known, and is not counted", async () => {
    let n = 0; const closed: string[] = [];
    const meter: MonthlyMeter = { reserve: async () => ({ call: async () => { if (n++ === 2) throw new EvalCallRefused("cap"); return { calls: 1, costMicros: 10, class: "ok" }; }, close: async () => { closed.push("x"); } }) };
    const stage = await openMeteredStage({ grant, meter, calls: 5, costMicros: 20 });
    await stage!.call(frame); await stage!.call(frame);
    await expect(stage!.call(frame)).rejects.toThrow("eval stage stopped");
    expect(stage!.failure()).toBe("cap"); expect(stage!.callFailure()).toBe("cap");
    expect(stage!.usage()).toEqual({ calls: 2, costMicros: 20 });
    await stage!.close(); expect(closed).toEqual(["x"]);
  });
  it("a call that throws after dispatch is an unknown cost even when another call already set the failure", async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const meter: MonthlyMeter = { reserve: async () => ({ call: async () => { await gate; throw new Error("boom"); }, close: async () => undefined }) };
    const stage = await openMeteredStage({ grant, meter, calls: 1, costMicros: 20 });
    const first = stage!.call(frame).then(() => "ran", () => "stopped");
    await expect(stage!.call(frame)).rejects.toThrow("eval stage stopped");
    expect(stage!.failure()).toBe("cap");
    open(); expect(await first).toBe("stopped");
    expect(stage!.failure()).toBe("cap"); expect(stage!.usage()).toEqual({ calls: 1 });
  });
  it("any other reservation fault is still an unknown cost", async () => {
    const meter: MonthlyMeter = { reserve: async () => ({ call: async () => { throw new Error("boom"); }, close: async () => undefined }) };
    const stage = await openMeteredStage({ grant, meter, calls: 2, costMicros: 20 });
    await expect(stage!.call(frame)).rejects.toThrow("eval stage stopped");
    expect(stage!.failure()).toBe("provider_error"); expect(stage!.usage()).toEqual({ calls: 1 });
  });
  it.each([{ calls: 0, costMicros: 10 }, { calls: 1.5, costMicros: 10 }, { calls: 1, costMicros: NaN }, { calls: 401, costMicros: 10 }, { calls: 1, costMicros: 4_000_001 }])("refuses invalid or over-grant estimate %j before reserve", async estimate => {
    const w = world(); expect(await openMeteredStage({ grant, meter: w.meter, ...estimate })).toBeUndefined(); expect(w.holds).toEqual([]);
  });
  it.each([{ calls: 0, costMicros: 10, class: "ok" }, { calls: 2, costMicros: 10, class: "ok" }, { calls: 1, costMicros: -1, class: "ok" }, { calls: 1, costMicros: 0.5, class: "ok" }, { calls: 1, costMicros: Infinity, class: "ok" }, { calls: 1, costMicros: 101, class: "ok" }, { calls: 1, costMicros: 10, class: "provider_error" }, { calls: 1, costMicros: 10, class: "unknown-secret" }])("stops after invalid or failed usage %j", async output => {
    const w = world(output as EvalMeterCall); const stage = (await openMeteredStage({ grant, meter: w.meter, calls: 2, costMicros: 100 }))!;
    await expect(stage.call(frame)).rejects.toThrow("eval stage stopped");
    await expect(stage.call(frame)).rejects.toThrow("eval stage stopped"); await stage.close();
    expect(w.dispatched).toHaveLength(1); expect(w.closed).toHaveLength(1);
    expect(JSON.stringify(stage.usage())).not.toContain("unknown-secret");
  });
});

it.each([null, {}, { grant: null, meter: {}, calls: 1, costMicros: 1 }])("refuses malformed runtime stage input %j without throwing", async input => {
  await expect(openMeteredStage(input as never)).resolves.toBeUndefined();
});
it.each([null, {}, { call: "private-secret", close: async () => {} }])("refuses a malformed reservation before exposing a call", async reservation => {
  await expect(openMeteredStage({ grant, calls: 1, costMicros: 10, meter: { reserve: async () => reservation as never } })).resolves.toBeUndefined();
});
it("a failed close has fixed words and never supplies guessed cost for another attempt", async () => {
  const stage = (await openMeteredStage({ grant, calls: 1, costMicros: 10, meter: { reserve: async () => ({ call: async () => ({ calls: 1, costMicros: 10, class: "ok" }), close: async () => { throw new Error("private-close-cause"); } }) } }))!;
  await stage.call(frame); await stage.close(); expect(stage.failure()).toBe("provider_error"); expect(stage.usage()).toEqual({ calls: 1 });
  await expect(stage.call(frame)).rejects.toThrow(/^eval stage stopped$/);
});
