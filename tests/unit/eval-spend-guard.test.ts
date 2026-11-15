import { describe, expect, it } from "vitest";
import type { EvalMeterCall, EvalSpendGrant, MonthlyMeter } from "../../packages/contracts/src/ports/eval-health.js";
import type { ModelEgressFrame } from "../../packages/contracts/src/model-egress/frame.js";
import { openMeteredStage } from "../../packages/worker/src/verification/eval-spend-guard.js";
const frame = {} as ModelEgressFrame;
const grant: EvalSpendGrant = { company: "company-a", project: "p", selection: "eval", role: "owner", inputsDigest: "a".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
function world(output: EvalMeterCall = { calls: 1, costMicros: 10, class: "ok" }) {
  const dispatched: string[] = []; const closed: string[] = []; const holds: unknown[] = [];
  const meter: MonthlyMeter = { reserve: async request => { holds.push(request); return { call: async () => { dispatched.push(request.approval.company); return output; }, close: async () => { closed.push(request.approval.company); } }; } };
  return { meter, dispatched, closed, holds };
}
describe("one metered eval stage", () => {
  it("holds the whole stage and owns actual counts, closing exactly once", async () => {
    const w = world(); const stage = await openMeteredStage({ grant, meter: w.meter, calls: 3, costMicros: 30 });
    expect(stage).toBeDefined();
    await stage!.call(frame); await stage!.call(frame);
    await stage!.close(); await stage!.close();
    expect(stage!.usage()).toEqual({ calls: 2, costMicros: 20 });
    expect(w.holds).toEqual([{ approval: grant, calls: 3, costMicros: 30 }]);
    expect(w.closed).toEqual(["company-a"]);
    await expect(stage!.call(frame)).rejects.toThrow("eval stage stopped");
    expect(w.dispatched).toEqual(["company-a", "company-a"]);
  });
  it("does not dispatch when the hold is refused", async () => {
    const stage = await openMeteredStage({ grant, meter: { reserve: async () => undefined }, calls: 1, costMicros: 10 });
    expect(stage).toBeUndefined();
  });
  it.each([{ calls: 0, costMicros: 10 }, { calls: 1.5, costMicros: 10 }, { calls: 1, costMicros: NaN }, { calls: 401, costMicros: 10 }, { calls: 1, costMicros: 4_000_001 }])("refuses invalid or over-grant estimate %j before reserve", async estimate => {
    const w = world(); expect(await openMeteredStage({ grant, meter: w.meter, ...estimate })).toBeUndefined(); expect(w.holds).toEqual([]);
  });
  it("stops at the dispatch count even when calls overlap", async () => {
    const w = world(); const stage = (await openMeteredStage({ grant, meter: w.meter, calls: 1, costMicros: 100 }))!;
    const first = stage.call(frame); await expect(stage.call(frame)).rejects.toThrow("eval stage stopped"); await first; await stage.close();
    expect(w.dispatched).toHaveLength(1);
  });
  it.each([{ calls: 0, costMicros: 10, class: "ok" }, { calls: 2, costMicros: 10, class: "ok" }, { calls: 1, costMicros: -1, class: "ok" }, { calls: 1, costMicros: 0.5, class: "ok" }, { calls: 1, costMicros: Infinity, class: "ok" }, { calls: 1, costMicros: 101, class: "ok" }, { calls: 1, costMicros: 10, class: "provider_error" }, { calls: 1, costMicros: 10, class: "unknown-secret" }])("stops after invalid or failed usage %j", async output => {
    const w = world(output as EvalMeterCall); const stage = (await openMeteredStage({ grant, meter: w.meter, calls: 2, costMicros: 100 }))!;
    await expect(stage.call(frame)).rejects.toThrow("eval stage stopped");
    await expect(stage.call(frame)).rejects.toThrow("eval stage stopped"); await stage.close();
    expect(w.dispatched).toHaveLength(1); expect(w.closed).toHaveLength(1);
    expect(JSON.stringify(stage.usage())).not.toContain("unknown-secret");
  });
  it("joins every pending call before closing and never leaks a provider error", async () => {
    let settle!: (value: EvalMeterCall) => void; const order: string[] = [];
    const stage = (await openMeteredStage({ grant, calls: 2, costMicros: 100, meter: { reserve: async () => ({ call: () => new Promise(resolve => { settle = resolve; }), close: async () => { order.push("close"); } }) } }))!;
    const pending = stage.call(frame); const closing = stage.close(); await Promise.resolve(); expect(order).toEqual([]);
    settle({ class: "ok", calls: 1, costMicros: 10 }); await pending; order.push("joined"); await closing; expect(order).toEqual(["joined", "close"]);
    const failed = (await openMeteredStage({ grant, calls: 2, costMicros: 100, meter: { reserve: async () => ({ call: async () => { throw new Error("secret-header"); }, close: async () => {} }) } }))!;
    await expect(failed.call(frame)).rejects.toThrow(/^eval stage stopped$/); await expect(failed.call(frame)).rejects.toThrow(/^eval stage stopped$/); await failed.close();
    expect(failed.usage()).toEqual({ calls: 1 });
  });
  it("keeps company holds and ledgers independent", async () => {
    const w = world(); const a = (await openMeteredStage({ grant, meter: w.meter, calls: 1, costMicros: 10 }))!;
    const b = (await openMeteredStage({ grant: { ...grant, company: "company-b" }, meter: w.meter, calls: 1, costMicros: 10 }))!;
    await b.call(frame); await b.close(); await a.call(frame); await a.close();
    expect(w.dispatched).toEqual(["company-b", "company-a"]); expect(w.closed).toEqual(["company-b", "company-a"]);
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
