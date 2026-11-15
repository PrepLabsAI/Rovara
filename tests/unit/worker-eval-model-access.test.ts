// The eval's model-access port: a MonthlyMeter over an injected hold-and-egress (the gateway's product route in
// production, a script here). Money rules: whole-estimate hold, dispatch ceilings, one attempt, no retry, unknown usage
// retained, provider faults are Not run and never a pass.
import { describe, expect, it } from "vitest";
import type { EvalSpendGrant } from "@agentx/contracts";
import { createEvalMeter } from "../../packages/worker/src/verification/eval-model-access.js";
import { EvalCallRefused } from "../../packages/worker/src/verification/eval-spend-guard.js";
import { answer, classAnswer, frame, scriptedAccess, settle, type Script } from "../support/eval-model-access.js";

const grant: EvalSpendGrant = { company: "company-a", project: "project-a", selection: "eval", role: "owner", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
const reserve = (script: Script | undefined, options?: Parameters<typeof createEvalMeter>[1], estimate = { calls: 3, costMicros: 100 }) => {
  const world = scriptedAccess(script);
  return { world, meter: createEvalMeter(world.access, options), reserve: () => createEvalMeter(world.access, options).reserve({ approval: grant, ...estimate }) };
};
const ok = async (script?: Script, options?: Parameters<typeof createEvalMeter>[1], estimate?: { calls: number; costMicros: number }) => {
  const r = reserve(script, options, estimate); const reservation = await r.reserve(); expect(reservation).toBeDefined(); return { ...r, reservation: reservation! };
};
const never = (): Promise<never> => new Promise(() => undefined);

describe("hold", () => {
  it("asks for the whole estimate with the grant, once", async () => {
    const { world } = await ok();
    expect(world.holds).toEqual([{ grant, calls: 3, costMicros: 100 }]);
  });
  it.each(["undefined", "throw"] as const)("a refused hold (%s) is a refusal with nothing dispatched and nothing leaked", async mode => {
    const r = reserve(undefined); r.world.refuse(mode);
    expect(await r.reserve()).toBeUndefined();
    expect(r.world.forwarded).toEqual([]); expect(r.world.released).toEqual([]);
  });
  it.each([{ calls: 0, costMicros: 10 }, { calls: -1, costMicros: 10 }, { calls: 1.5, costMicros: 10 }, { calls: NaN, costMicros: 10 }, { calls: 1, costMicros: -1 }, { calls: 1, costMicros: NaN }, { calls: Number.MAX_SAFE_INTEGER + 1, costMicros: 1 }])("never asks the gateway for the estimate %j", async estimate => {
    const r = reserve(undefined, undefined, estimate);
    expect(await r.reserve()).toBeUndefined(); expect(r.world.holds).toEqual([]);
  });
  it("refuses a hold that is not an egress, a scope and a release", async () => {
    const access = { hold: async () => ({ egress: {}, scope: {}, release: async () => undefined }) } as never;
    expect(await createEvalMeter(access).reserve({ approval: grant, calls: 1, costMicros: 1 })).toBeUndefined();
    const noRelease = { hold: async () => ({ egress: { forward: () => [] }, scope: {} }) } as never;
    expect(await createEvalMeter(noRelease).reserve({ approval: grant, calls: 1, costMicros: 1 })).toBeUndefined();
  });
  it("refuses a missing access port without throwing", async () => {
    expect(await createEvalMeter(undefined as never).reserve({ approval: grant, calls: 1, costMicros: 1 })).toBeUndefined();
  });
});

describe("one call", () => {
  it("forwards the frame under the hold's own scope and returns the scrubbed events, one call, the settled cost", async () => {
    const { world, reservation } = await ok();
    const f = frame("hello");
    const result = await reservation.call(f);
    expect(result).toMatchObject({ class: "ok", calls: 1, costMicros: 10 });
    expect(result.events?.map(e => e.kind)).toEqual(["head", "chunk", "settle"]);
    expect(world.forwarded).toEqual([f]);
    expect(world.scopes).toHaveLength(1);
  });
  it.each([
    ["rate_limit", 429], ["quota", 429], ["overloaded", 503], ["key_refused", 401], ["cap", 429], ["provider_error", 502], ["refused", 403],
  ] as const)("returns class %s as settled and keeps no events for a call that was not good", async (cls, status) => {
    const { reservation } = await ok(() => classAnswer(cls, status, 3));
    const result = await reservation.call(frame());
    expect(result).toMatchObject({ class: cls, calls: 1, costMicros: 3 });
    expect(result.events).toBeUndefined();
  });
  it("makes one attempt: a rate limit is not retried", async () => {
    const { world, reservation } = await ok(() => classAnswer("rate_limit", 429));
    await reservation.call(frame());
    expect(world.forwarded).toHaveLength(1);
  });
});

describe("dispatch ceilings", () => {
  it("refuses a call beyond the held count before it reaches the egress", async () => {
    const { world, reservation } = await ok(undefined, undefined, { calls: 2, costMicros: 1000 });
    await reservation.call(frame()); await reservation.call(frame());
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
    expect(world.forwarded).toHaveLength(2);
  });
  it("stops after a call settled over its reservation", async () => {
    const { world, reservation } = await ok(() => answer({ overrun: true }), undefined, { calls: 5, costMicros: 1000 });
    expect((await reservation.call(frame())).class).toBe("ok");
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
    expect(world.forwarded).toHaveLength(1);
  });
  it("stops once the held cost is spent, and refuses the call that would start with nothing left", async () => {
    const { world, reservation } = await ok(() => answer({ costMicros: 10 }), undefined, { calls: 9, costMicros: 25 });
    await reservation.call(frame()); await reservation.call(frame());
    expect((await reservation.call(frame())).costMicros).toBe(10);
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
    expect(world.forwarded).toHaveLength(3);
  });
  it("refuses the next call when the spend equals the held cost exactly", async () => {
    const { world, reservation } = await ok(() => answer({ costMicros: 10 }), undefined, { calls: 9, costMicros: 20 });
    await reservation.call(frame()); await reservation.call(frame());
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
    expect(world.forwarded).toHaveLength(2);
  });
  it("says the spent-up refusal is a budget refusal (cap), and the count refusal too, but not a closed stage", async () => {
    const spent = await ok(() => answer({ costMicros: 20 }), undefined, { calls: 9, costMicros: 20 });
    await spent.reservation.call(frame());
    await expect(spent.reservation.call(frame())).rejects.toBeInstanceOf(EvalCallRefused);
    const count = await ok(undefined, undefined, { calls: 1, costMicros: 1000 });
    await count.reservation.call(frame());
    await expect(count.reservation.call(frame())).rejects.toBeInstanceOf(EvalCallRefused);
    const closed = await ok(); await closed.reservation.close();
    const error = await closed.reservation.call(frame()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(EvalCallRefused);
  });
  it("lets calls run in parallel up to the held count and counts each once", async () => {
    const { world, reservation } = await ok(undefined, undefined, { calls: 4, costMicros: 1000 });
    const all = await Promise.all([1, 2, 3, 4].map(() => reservation.call(frame())));
    expect(all.every(r => r.calls === 1)).toBe(true);
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
    expect(world.forwarded).toHaveLength(4);
  });
});

describe("calls in flight", () => {
  it("never has more than four open at once, queues the rest and runs them all", async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const gated: Script = async function* () { await gate; yield* answer({ costMicros: 1 }); } as never;
    const { world, reservation } = await ok(gated, undefined, { calls: 12, costMicros: 1000 });
    const all = Array.from({ length: 10 }, () => reservation.call(frame()));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(world.peak()).toBe(4); expect(world.forwarded).toHaveLength(4);
    open();
    const results = await Promise.all(all);
    expect(results.every(r => r.class === "ok")).toBe(true);
    expect(world.forwarded).toHaveLength(10); expect(world.peak()).toBe(4);
  });
  it("re-checks the ceilings when a queued call gets its turn", async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const gated: Script = async function* () { await gate; yield* answer({ costMicros: 10 }); } as never;
    const { world, reservation } = await ok(gated, undefined, { calls: 5, costMicros: 20 });
    const all = Array.from({ length: 5 }, () => reservation.call(frame()).then(() => "ran", () => "refused"));
    await new Promise(resolve => setTimeout(resolve, 20)); open();
    const outcomes = await Promise.all(all);
    expect(outcomes.filter(o => o === "ran").length).toBe(4);
    expect(outcomes.filter(o => o === "refused").length).toBe(1);
    expect(world.forwarded).toHaveLength(4);
  });
  it("refuses a queued call once the stage closed", async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const gated: Script = async function* () { await gate; yield* answer(); } as never;
    const { world, reservation } = await ok(gated, undefined, { calls: 9, costMicros: 1000 });
    const first = Array.from({ length: 4 }, () => reservation.call(frame()));
    const queued = reservation.call(frame()).then(() => "ran", () => "refused");
    await new Promise(resolve => setTimeout(resolve, 10));
    const closing = reservation.close();
    open(); await Promise.all(first); await closing;
    expect(await queued).toBe("refused"); expect(world.forwarded).toHaveLength(4);
  });
});

describe("a fault is Not run, never a pass", () => {
  const bad: Array<[string, Script]> = [
    ["the egress throws", () => Promise.reject(new Error("key-CANARY-123 provider words"))],
    ["the stream ends with no settle", () => [{ kind: "head", status: 200, headers: [] }, { kind: "chunk", bytes: new Uint8Array(2) }]],
    ["a settle comes before the head", () => [settle(), { kind: "head", status: 200, headers: [] }]],
    ["two settles", () => [{ kind: "head", status: 200, headers: [] }, settle(), settle()]],
    ["two heads", () => [{ kind: "head", status: 200, headers: [] }, { kind: "head", status: 200, headers: [] }, settle()]],
    ["a chunk after the settle", () => [{ kind: "head", status: 200, headers: [] }, settle(), { kind: "chunk", bytes: new Uint8Array(1) }]],
    ["an empty stream", () => []],
    ["a negative cost", () => answer({ costMicros: -1 })],
    ["a fractional cost", () => answer({ costMicros: 1.5 })],
    ["a cost that is not a number", () => answer({ costMicros: NaN })],
    ["an unknown class", () => answer({ class: "great" as never })],
  ];
  it.each(bad)("%s: provider_error, unknown cost, nothing leaked", async (_name, script) => {
    const { world, reservation } = await ok(script);
    const result = await reservation.call(frame());
    expect(result.class).toBe("provider_error"); expect(result.calls).toBe(1); expect(Number.isNaN(result.costMicros)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("CANARY"); expect(result.events).toBeUndefined();
    await reservation.close();
    expect(world.released).toEqual([{ calls: 1, costMicros: 0, unknown: true }]);
  });
  it("never hands the gateway an unsafe spend total: an overflowing sum is unknown and capped at the largest safe number", async () => {
    const costs = [Number.MAX_SAFE_INTEGER - 2, 5]; let i = 0;
    const { world, reservation } = await ok(() => answer({ costMicros: costs[i++]! }), undefined, { calls: 2, costMicros: Number.MAX_SAFE_INTEGER });
    await reservation.call(frame()); await reservation.call(frame()); await reservation.close();
    expect(world.released).toEqual([{ calls: 2, costMicros: Number.MAX_SAFE_INTEGER, unknown: true }]);
  });
  it("takes no further call after an unknown spend", async () => {
    const { world, reservation } = await ok(() => Promise.reject(new Error("boom")));
    await reservation.call(frame());
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
    expect(world.forwarded).toHaveLength(1);
  });
  it("cuts a response over the byte limit, even in small pieces", async () => {
    const pieces: Script = () => [{ kind: "head", status: 200, headers: [] }, { kind: "chunk", bytes: new Uint8Array(6) }, { kind: "chunk", bytes: new Uint8Array(6) }, settle()];
    const { reservation } = await ok(pieces, { responseBytes: 10 });
    const result = await reservation.call(frame());
    expect(result.class).toBe("provider_error"); expect(Number.isNaN(result.costMicros)).toBe(true);
  });
  it("accepts a response exactly at the byte limit", async () => {
    const exact: Script = () => [{ kind: "head", status: 200, headers: [] }, { kind: "chunk", bytes: new Uint8Array(10) }, settle()];
    const { reservation } = await ok(exact, { responseBytes: 10 });
    expect((await reservation.call(frame())).class).toBe("ok");
  });
  it("ends a call that outlives its deadline and aborts the egress", async () => {
    let aborted = false;
    const slow: Script = async (_f, _i, signal) => { await new Promise<void>(resolve => signal?.addEventListener("abort", () => { aborted = true; resolve(); })); throw new Error("late-secret"); };
    const { world, reservation } = await ok(slow, { callTimeoutMs: 20 });
    const result = await reservation.call(frame());
    expect(result.class).toBe("provider_error"); expect(Number.isNaN(result.costMicros)).toBe(true); expect(aborted).toBe(true);
    await reservation.close(); expect(world.released[0]?.unknown).toBe(true);
  });
  it("ends a call whose egress ignores the abort", async () => {
    const { reservation } = await ok(never, { callTimeoutMs: 20 });
    const result = await reservation.call(frame());
    expect(result.class).toBe("provider_error");
    await reservation.close();
  });
});

describe("close", () => {
  it("joins calls still running before it releases, then refuses more calls", async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const slow: Script = async function* () { await gate; yield* answer(); } as never;
    const { world, reservation } = await ok(slow);
    const running = reservation.call(frame());
    await new Promise(resolve => setTimeout(resolve, 5));
    const closing = reservation.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(world.released).toEqual([]);
    finish();
    await running; await closing;
    expect(world.released).toEqual([{ calls: 1, costMicros: 10, unknown: false }]);
    await expect(reservation.call(frame())).rejects.toThrow("eval stage stopped");
  });
  it("releases exactly once however often it is closed", async () => {
    const { world, reservation } = await ok();
    await reservation.call(frame());
    await Promise.all([reservation.close(), reservation.close()]); await reservation.close();
    expect(world.released).toEqual([{ calls: 1, costMicros: 10, unknown: false }]);
  });
  it("reports a release that failed with fixed words, so the spend is treated as unknown", async () => {
    const { world, reservation } = await ok();
    world.failRelease();
    const error = await reservation.close().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error); expect(String((error as Error).message)).not.toContain("secret");
  });
  it("a hold with nothing dispatched releases it whole", async () => {
    const { world, reservation } = await ok();
    await reservation.close();
    expect(world.released).toEqual([{ calls: 0, costMicros: 0, unknown: false }]);
  });
});
