import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { runCorrections } from "../../packages/model-gateway/src/correction.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
const real = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } };
async function add(meter: InMemoryMeter, model: string, settledAt = now) {
  const r = await meter.reserve({ scope, caps, estimateMicros: 10 }); if (!r.ok) throw new Error("fixture");
  await meter.settle(r.reservation, 10, { provider: "anthropic", model, kind: "chat", usage, settledAt });
  return JSON.stringify([scope.iss, scope.cid, r.reservation.id]);
}
it("continues beyond 201 older unpriced keys within two bounded runs", async () => {
  const meter = new InMemoryMeter(() => now); for (let i = 0; i < 201; i++) await add(meter, `unpriced-${i}`, now + i);
  const id = await add(meter, "priced", now + 202); let reads = 0;
  const options = { meter, prices: { priceFor: (_: string, model: string) => { reads++; return model === "priced" ? real : undefined; } }, caps: { capsFor: async () => caps }, now, runId: "secret-run" };
  const first = await runCorrections(options); expect(first).toMatchObject({ corrected: 0, more: true }); expect(reads).toBeLessThanOrEqual(200);
  expect(await runCorrections(options)).toMatchObject({ corrected: 1 }); expect(reads).toBeLessThanOrEqual(400); expect(meter.ledger(id)?.status).toBe("corrected");
  expect(JSON.stringify(first)).not.toMatch(/secret|unpriced|anthropic|org_|https/);
});
it("paginates calls past a stuck caps prefix and revisits it after a full traversal", async () => {
  const meter = new InMemoryMeter(() => now); for (let i = 0; i < 201; i++) await add(meter, "same", now + i);
  const last = await add(meter, "same", now + 202); let reads = 0; let healthy = false;
  const options = { meter, prices: { priceFor: () => real }, caps: { capsFor: async (call: unknown) => { reads++; return healthy || (call as { callKey: string }).callKey === last ? caps : { ...caps, task: NaN }; } }, now, runId: "run" };
  await runCorrections(options); expect(reads).toBeLessThanOrEqual(200);
  await runCorrections(options); expect(meter.ledger(last)?.status).toBe("corrected");
  healthy = true; for (let i = 0; i < 3; i++) await runCorrections(options);
  expect((await meter.read(scope))[0]?.estimatedMicros).toBe(0);
});
it("keyset pages remain stable when earlier calls are corrected and reject malformed cursors with fixed words", async () => {
  const meter = new InMemoryMeter(() => now); const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await add(meter, "same", now + i));
  const key = { provider: "anthropic", model: "same" };
  const first = await meter.pendingFor(key, 2); expect(first.items.map((c) => c.callKey)).toEqual(ids.slice(0, 2)); expect(first.cursor).toBeTypeOf("string");
  await meter.correct({ callKey: ids[0]!, realMicros: 1, caps, now, runId: "run", priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now } });
  const second = await meter.pendingFor(key, 2, first.cursor); expect(second.items.map((c) => c.callKey)).toEqual(ids.slice(2)); expect(second.cursor).toBeUndefined();
  first.items[0]!.usage.input = 999; expect(meter.ledger(ids[0]!)?.usage.input).toBe(1);
  for (const cursor of ["secret", "null", '["secret",1]', JSON.stringify(["keys", 1, "x".repeat(5000)]), JSON.stringify(["keys", 1, ""])]) {
    await expect(meter.pendingKeys(1, cursor)).rejects.toThrow(/^pending unavailable$/);
    await expect(meter.pendingFor(key, 1, cursor)).rejects.toThrow(/^pending unavailable$/);
  }
});
it("large unpriced input uses one total bounded key budget and never walks the full ledger", async () => {
  const meter = new InMemoryMeter(() => now); for (let i = 0; i < 1000; i++) await add(meter, `model-${i}`, now + i);
  let reads = 0; const started = performance.now();
  const report = await runCorrections({ meter, prices: { priceFor: () => { reads++; return undefined; } }, caps: { capsFor: async () => caps }, now, runId: "run" });
  expect(reads).toBe(200); expect(report).toMatchObject({ skipped: 200, more: true }); expect(performance.now() - started).toBeLessThan(1000);
});
it("page limits and cursor scope fail closed, and oldest keys advance after deletion", async () => {
  const meter = new InMemoryMeter(() => now); const a = await add(meter, "a", now); await add(meter, "b", now + 1); await add(meter, "c", now + 2);
  const first = await meter.pendingKeys(1); expect(first.items).toEqual([{ provider: "anthropic", model: "a" }]);
  await meter.correct({ callKey: a, realMicros: 1, caps, now, runId: "run", priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now } });
  expect((await meter.pendingKeys(2, first.cursor)).items.map((key) => key.model)).toEqual(["b", "c"]);
  for (const limit of [0, -1, 201, 1.5, NaN, "secret"]) await expect(meter.pendingKeys(limit as number)).rejects.toThrow(/^pending unavailable$/);
  await expect(meter.pendingFor({ provider: "anthropic", model: "b" }, 1, first.cursor)).rejects.toThrow(/^pending unavailable$/);
  await expect(meter.pendingExpired(NaN, 1)).rejects.toThrow(/^pending unavailable$/);
  await expect(meter.pendingFor({ provider: "secret", model: "b" }, 1)).rejects.toThrow(/^pending unavailable$/);
});
it("concurrent runners apply each delta once and continuation finishes the remaining calls", async () => {
  const meter = new InMemoryMeter(() => now); const ids: string[] = []; for (let i = 0; i < 202; i++) ids.push(await add(meter, "same", now + i));
  const options = { meter, prices: { priceFor: () => real }, caps: { capsFor: async () => caps }, now, runId: "run" };
  const results = await Promise.all([runCorrections(options), runCorrections(options)]);
  expect(results.reduce((sum, report) => sum + report.corrected, 0)).toBeLessThanOrEqual(202);
  for (let i = 0; i < 3; i++) await runCorrections(options);
  expect(ids.every((id) => meter.ledger(id)?.status === "corrected")).toBe(true);
  expect((await meter.read(scope)).every((row) => row.spentMicros === 202 && row.estimatedMicros === 0)).toBe(true);
});
