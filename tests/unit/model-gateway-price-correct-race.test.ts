import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const estimated = { provider: "anthropic", model: "m", kind: "chat" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: now };
it("two corrections apply once and a concurrent settle survives the delta", async () => {
  let interleave: (() => Promise<void>) | undefined;
  const meter = new InMemoryMeter(() => now, () => false, async (operation) => { if (operation === "correct") { const f = interleave; interleave = undefined; await f?.(); } });
  const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); const s = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok || !s.ok) throw new Error("fixture");
  await meter.settle(r.reservation, 80, estimated);
  interleave = () => meter.settle(s.reservation, 30);
  const input = { callKey: JSON.stringify([scope.iss, scope.cid, r.reservation.id]), realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: now }, runId: "run", now };
  const result = await Promise.all([meter.correct(input), meter.correct(input)]);
  expect(result.map((x) => x.status).sort()).toEqual(["already", "corrected"]);
  expect((await meter.read(scope)).every((row) => row.spentMicros === 50 && row.estimatedMicros === 0)).toBe(true);
});
it("own settle race is missing then correctable; original month and company stay isolated", async () => {
  let clock = Date.UTC(2026, 0, 31); const meter = new InMemoryMeter(() => clock);
  const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture");
  const input = { callKey: JSON.stringify([scope.iss, scope.cid, r.reservation.id]), realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: clock }, runId: "run", now: clock };
  expect(await meter.correct(input)).toEqual({ status: "missing" });
  await meter.settle(r.reservation, 80, { ...estimated, settledAt: clock });
  clock = Date.UTC(2026, 1, 1); expect(await meter.correct({ ...input, now: clock })).toMatchObject({ status: "corrected" });
  expect((await meter.read(scope)).find((row) => row.item === "company")?.spentMicros).toBe(0);
  clock = Date.UTC(2026, 0, 31); expect((await meter.read(scope)).every((row) => row.spentMicros === 20)).toBe(true);
  expect((await meter.read({ ...scope, cid: `org_${"b".repeat(20)}` })).every((row) => row.spentMicros === 0)).toBe(true);
  await meter.settle(r.reservation, 500, estimated); expect((await meter.read(scope))[0]?.spentMicros).toBe(20);
});
it("below-zero guard writes nothing when a corrupted item is injected before the transaction", async () => {
  let corrupt = false;
  const meter = new InMemoryMeter(() => now, () => false, (operation, rows) => { if (operation === "correct" && corrupt) { for (const row of rows ?? []) row.spentMicros = 0; } });
  const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture"); await meter.settle(r.reservation, 80, estimated);
  const input = { callKey: JSON.stringify([scope.iss, scope.cid, r.reservation.id]), realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: now }, runId: "run", now };
  corrupt = true; expect(await meter.correct(input)).toEqual({ status: "busy" });
  expect((await meter.read(scope)).every((row) => row.spentMicros === 0 && row.estimatedMicros === 80 && row.committed === 80)).toBe(true);
  expect(meter.ledger(input.callKey)?.status).toBe("pending");
});
it("a failing pre-write hook leaves ledger and rows atomic; missing usage stays estimated with a pending record", async () => {
  const meter = new InMemoryMeter(() => now, () => false, () => { throw new Error("fixture"); });
  const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture");
  await expect(meter.settle(r.reservation, 80, estimated)).rejects.toThrow();
  expect((await meter.read(scope)).every((row) => row.spentMicros === 0 && row.reservedMicros === 100)).toBe(true);
  expect(await meter.pendingKeys(10)).toEqual({ items: [] });
  const clean = new InMemoryMeter(() => now); const other = await clean.reserve({ scope, caps, estimateMicros: 100 }); if (!other.ok) throw new Error("fixture");
  await clean.settle(other.reservation, 100, { provider: "anthropic", model: "m", kind: "chat", settledAt: now });
  expect((await clean.read(scope))[0]).toMatchObject({ spentMicros: 100, estimatedMicros: 100 }); expect(await clean.pendingKeys(10)).toEqual({ items: [{ provider: "anthropic", model: "m" }] });
});
