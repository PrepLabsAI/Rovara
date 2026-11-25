import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const estimated = { provider: "anthropic", model: "private-model", kind: "chat" as const, usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, settledAt: now };
it("atomic estimated settle corrects all four items, frees room, audits once and never re-corrects", async () => {
  const { costView } = await import("../../packages/model-gateway/src/meter.js");
  const meter = new InMemoryMeter(() => now);
  const cap = { ...caps, task: 100 };
  const r = await meter.reserve({ scope, caps: cap, estimateMicros: 100 }); expect(r.ok).toBe(true); if (!r.ok) return;
  await meter.settle(r.reservation, 80, estimated);
  const key = JSON.stringify([scope.iss, scope.cid, r.reservation.id]);
  expect(costView(await meter.read(scope)).every((row) => row.estimated && row.spentMicros === 80)).toBe(true);
  expect((await meter.reserve({ scope, caps: cap, estimateMicros: 30 })).ok).toBe(false);
  const input = { callKey: key, realMicros: 20, caps: cap, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: now }, runId: "run", now };
  expect(await meter.correct(input)).toEqual({ status: "corrected", deltaMicros: -60 });
  expect((await meter.read(scope)).every((row) => row.spentMicros === 20 && row.estimatedMicros === 0 && row.committed === 20)).toBe(true);
  expect(costView(await meter.read(scope)).every((row) => !row.estimated)).toBe(true);
  expect(await meter.correct(input)).toEqual({ status: "already" });
  expect(await meter.pendingFor({ provider: estimated.provider, model: estimated.model }, 10)).toEqual({ items: [] });
  expect(meter.ledger(key)).toMatchObject({ status: "corrected", correctedFrom: 80, correctedTo: 20, deltaMicros: -60, runId: "run", priceSource: { source: "litellm", fetchedAt: now } });
  expect((await meter.reserve({ scope, caps: cap, estimateMicros: 30 })).ok).toBe(true);
});
it("upward corrections set overrun, lowering clears it; zero is refused, expiry keeps estimate", async () => {
  const meter = new InMemoryMeter(() => now); const cap = { ...caps, companyMonth: 100 };
  const r = await meter.reserve({ scope, caps: cap, estimateMicros: 80 }); if (!r.ok) throw new Error("fixture");
  await meter.settle(r.reservation, 80, estimated);
  const input = { callKey: JSON.stringify([scope.iss, scope.cid, r.reservation.id]), realMicros: 101, caps: cap, priceVersion: 1, estimated: false, priceSource: { source: "aws" as const, fetchedAt: now }, runId: "run", now };
  expect(await meter.correct({ ...input, realMicros: 0 })).toEqual({ status: "busy" });
  expect(await meter.correct(input)).toEqual({ status: "corrected", deltaMicros: 21, capExceeded: true });
  expect((await meter.read(scope)).find((row) => row.item === "company")?.overrun).toBe(true);
  expect((await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps, estimateMicros: 1 })).ok).toBe(false);
  const expiring = new InMemoryMeter(() => now); const e = await expiring.reserve({ scope, caps, estimateMicros: 80 }); if (!e.ok) throw new Error("fixture");
  await expiring.settle(e.reservation, 80, estimated);
  expect(await expiring.correct({ ...input, callKey: JSON.stringify([scope.iss, scope.cid, e.reservation.id]), now: now + 63 * 86_400_000 })).toEqual({ status: "expired" });
  expect((await expiring.read(scope))[0]).toMatchObject({ spentMicros: 80, estimatedMicros: 80 });
});
it("correction runner only uses real rates, limits total work, logs no customer fields", async () => {
  const { runCorrections } = await import("../../packages/model-gateway/src/correction.js");
  const meter = new InMemoryMeter(() => now);
  for (let i = 0; i < 201; i++) { const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 100, estimated); }
  const logs: unknown[] = [];
  const args = { meter, prices: { priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => caps }, now, runId: "private-run", log: (line: unknown) => logs.push(line) };
  const first = await runCorrections(args); expect(first).toMatchObject({ corrected: 199, more: true });
  expect(await runCorrections(args)).toMatchObject({ corrected: 2, more: false });
  expect(await runCorrections(args)).toMatchObject({ corrected: 0 });
  expect(JSON.stringify(logs)).not.toMatch(/private|org_|https|task_1/);
});
it("requires real price provenance instead of inventing audit fields", async () => {
  const { runCorrections } = await import("../../packages/model-gateway/src/correction.js");
  const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 100, estimated);
  const prices = { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }) };
  const result = await runCorrections({ meter, prices, caps: { capsFor: async () => caps }, now, runId: "run" });
  expect(result.corrected).toBe(0); expect((await meter.read(scope))[0]?.spentMicros).toBe(100);
});
it("bounds a hung caps source and does not commit after the run deadline", async () => {
  const { vi } = await import("vitest");
  const { runCorrections } = await import("../../packages/model-gateway/src/correction.js");
  const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 100, estimated);
  vi.useFakeTimers();
  try {
    let release!: (value: typeof caps) => void;
    const pending = runCorrections({ meter, prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: () => new Promise((resolve) => { release = resolve; }) }, now, runId: "run", clock: Date.now });
    await vi.advanceTimersByTimeAsync(25_000); expect(await pending).toMatchObject({ corrected: 0, more: true });
    release(caps); await Promise.resolve(); expect((await meter.read(scope))[0]?.spentMicros).toBe(100);
  } finally { vi.useRealTimers(); }
}, 1000);
it("full gateway outcome: cautious hold, usage settlement, refresh correction and freed task budget", async () => {
  const { setup, call, answer } = await import("./model-gateway-fixture.js");
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const { PriceRefresher } = await import("../../packages/model-gateway/src/price-refresh.js");
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const { runCorrections } = await import("../../packages/model-gateway/src/correction.js");
  const { costView } = await import("../../packages/model-gateway/src/meter.js");
  const { FixedCapsSource } = await import("../../packages/model-gateway/src/caps.js");
  const store = new InMemoryPriceSnapshotStore();
  await store.save({ version: 1, sources: { litellm: { fetchedAt: now, count: 1, entries: [{ provider: "anthropic", model: "old", kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }] } } }, 0);
  const prices = new SnapshotPriceSource(store, { now: () => now }); await prices.reload(); const cap = { ...caps, task: 400 }; const f = setup({ prices, caps: new FixedCapsSource(cap) });
  let held = 0; f.deps.transport = async () => { held = (await f.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
  expect((await call(f.deps)).status).toBe(200); expect(held).toBe(189);
  expect(costView(await f.meter.read(scope)).every((row) => row.spentMicros === 35 && row.estimated)).toBe(true);
  expect((await f.meter.reserve({ scope, caps: cap, estimateMicros: 370 })).ok).toBe(false);
  const ll = { old: { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }, "claude-sonnet-4-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-6, cache_creation_input_token_cost: 2e-6, cache_creation_input_token_cost_above_1hr: 2e-6 } };
  const refresher = new PriceRefresher({ store, prices, litellm: (previous) => fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(ll)) }) }, { previous, now, minModels: 1 }), aws: async () => ({ ok: false, reason: "invalid source" }), correctedKeys: async () => { await runCorrections({ meter: f.meter, prices, caps: new FixedCapsSource(cap), now, runId: "outcome" }); } });
  await refresher.run(now);
  expect(costView(await f.meter.read(scope)).every((row) => row.spentMicros === 23 && !row.estimated)).toBe(true);
  expect((await f.meter.reserve({ scope, caps: cap, estimateMicros: 370 })).ok).toBe(true);
  expect((await runCorrections({ meter: f.meter, prices, caps: new FixedCapsSource(cap), now, runId: "repeat" })).corrected).toBe(0);
});
it("known or reported-cost settlements never enter the correction ledger", async () => {
  const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 19);
  expect((await meter.read(scope))[0]?.estimatedMicros).toBe(0); expect(await meter.pendingKeys(10)).toEqual({ items: [] });
});
it("lowering an estimated overrun clears it and admits the next company call", async () => {
  const cap = { ...caps, task: 100, personMonth: 100, projectMonth: 100, companyMonth: 100 };
  const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps: cap, estimateMicros: 80 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 101, estimated);
  expect((await meter.read(scope)).every((row) => row.overrun)).toBe(true);
  const result = await meter.correct({ callKey: JSON.stringify([scope.iss, scope.cid, r.reservation.id]), realMicros: 20, caps: cap, priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now }, runId: "lower", now });
  expect(result.status).toBe("corrected"); expect((await meter.read(scope)).every((row) => !row.overrun)).toBe(true);
  expect((await meter.reserve({ scope, caps: cap, estimateMicros: 80 })).ok).toBe(true);
});
it("uses one total item budget even when every caps read is invalid", async () => {
  const { runCorrections } = await import("../../packages/model-gateway/src/correction.js");
  const meter = new InMemoryMeter(() => now);
  for (let key = 0; key < 3; key++) for (let i = 0; i < 80; i++) {
    const r = await meter.reserve({ scope, caps, estimateMicros: 1 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 1, { ...estimated, model: `model-${key}` });
  }
  let reads = 0;
  const report = await runCorrections({ meter, prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => { reads++; return { ...caps, task: NaN }; } }, now, runId: "bounded" });
  expect(report).toMatchObject({ corrected: 0, more: true }); expect(reads).toBe(197);
});
