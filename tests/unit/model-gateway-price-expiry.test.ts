import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { runExpirySweep, runCorrections } from "../../packages/model-gateway/src/correction.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const age = 62 * 86_400_000;
async function add(meter: InMemoryMeter, settledAt = now - age - 1) {
  const r = await meter.reserve({ scope, caps, estimateMicros: 10 }); if (!r.ok) throw new Error("fixture");
  await meter.settle(r.reservation, 10, { provider: "anthropic", model: "secret-model", kind: "chat", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, settledAt });
  return JSON.stringify([scope.iss, scope.cid, r.reservation.id]);
}
it("expires unpriced records after 62 days once, retaining estimated spend and truthful audit", async () => {
  const meter = new InMemoryMeter(() => now); const old = await add(meter); const boundary = await add(meter, now - age); const fresh = await add(meter, now);
  const before = await meter.read(scope); const logs: unknown[] = [];
  const options = { meter, now, runId: "secret-run", log: (line: unknown) => logs.push(line) };
  expect(await runExpirySweep(options)).toMatchObject({ expired: 1, more: false });
  expect(await meter.read(scope)).toEqual(before);
  expect(meter.ledger(old)).toMatchObject({ status: "expired", runId: "secret-run", expiredAt: now });
  for (const field of ["priceSource", "correctedFrom", "correctedTo", "deltaMicros"]) expect(meter.ledger(old)).not.toHaveProperty(field);
  expect(meter.ledger(boundary)?.status).toBe("pending"); expect(meter.ledger(fresh)?.status).toBe("pending");
  expect(await runExpirySweep(options)).toMatchObject({ expired: 0, already: 0 }); expect(await meter.pendingExpired(now, 200)).toEqual({ items: [] }); expect(logs).toEqual([{ event: "price_expired" }]);
  expect(JSON.stringify(logs)).not.toMatch(/secret|org_|https|task_/);
});
it("bounds the entire expiry sweep and continues without starving later records", async () => {
  const meter = new InMemoryMeter(() => now); for (let i = 0; i < 201; i++) await add(meter);
  expect(await runExpirySweep({ meter, now, runId: "run" })).toMatchObject({ expired: 200, more: true });
  expect(await runExpirySweep({ meter, now, runId: "run" })).toMatchObject({ expired: 1, more: false });
  expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 2010, estimatedMicros: 2010 });
});
it("expiry and correction race on pending status so only one wins, with no forged provenance", async () => {
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const meter = new InMemoryMeter(() => now, () => false, async (op) => { if (op === "expire") { entered(); await new Promise<void>((resolve) => { release = resolve; }); } });
  const id = await add(meter); const expiry = meter.expire({ callKey: id, now, runId: "expiry" }); await started;
  expect(await meter.correct({ callKey: id, realMicros: 1, caps, now: now - 2, runId: "correction", priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now } })).toMatchObject({ status: "corrected" });
  release(); expect(await expiry).toEqual({ status: "already" }); expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 1, estimatedMicros: 0 });
  const other = new InMemoryMeter(() => now); const id2 = await add(other);
  expect(await other.expire({ callKey: id2, now, runId: "expiry" })).toEqual({ status: "expired" });
  expect(await other.correct({ callKey: id2, realMicros: 1, caps, now: now - 2, runId: "correction", priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now } })).toEqual({ status: "already" });
  expect(other.ledger(id2)).not.toHaveProperty("priceSource");
});
it("hung transaction is an unknown outcome, retries idempotently and cannot write after abort", async () => {
  let release!: () => void; let hang = true;
  const meter = new InMemoryMeter(() => now, () => false, async (op) => { if (op === "correct" && hang) await new Promise<void>((resolve) => { release = resolve; }); });
  const id = await add(meter, now); const logs: unknown[] = [];
  const options = { meter, prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => caps }, now, runId: "secret-run", log: (line: unknown) => logs.push(line) };
  vi.useFakeTimers();
  try {
    const run = runCorrections(options); await vi.advanceTimersByTimeAsync(25_000);
    expect(await run).toMatchObject({ unknown: 1, corrected: 0, more: true });
    release(); await Promise.resolve(); expect(meter.ledger(id)?.status).toBe("pending"); expect((await meter.read(scope))[0]?.spentMicros).toBe(10);
    hang = false; expect(await runCorrections({ ...options, now: now + 60_000 })).toMatchObject({ corrected: 1 });
    expect(await runCorrections(options)).toMatchObject({ corrected: 0 });
    expect(logs).toContainEqual({ event: "price_correction_unknown" }); expect(JSON.stringify(logs)).not.toMatch(/secret|org_|https/);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("bounded expiry hook validates input, aborts hangs, and has no late writer", async () => {
  let release!: () => void;
  const meter = new InMemoryMeter(() => now, () => false, async (op) => { if (op === "expire") await new Promise<void>((resolve) => { release = resolve; }); });
  const id = await add(meter); const input = { callKey: id, now, runId: "run" };
  for (const invalid of [null, { ...input, now: NaN }, { ...input, runId: "" }, { ...input, signal: {} }]) expect(await meter.expire(invalid as never)).toEqual({ status: "busy" });
  vi.useFakeTimers();
  try { const run = runExpirySweep({ meter, now, runId: "secret" }); await vi.advanceTimersByTimeAsync(25_000); expect(await run).toMatchObject({ unknown: 1, more: true }); release(); await Promise.resolve(); expect(meter.ledger(id)?.status).toBe("pending"); expect(vi.getTimerCount()).toBe(0); }
  finally { vi.useRealTimers(); }
});
it("unconfirmed adapter writes are reported as unknown and replay cannot double-charge", async () => {
  const meter = new InMemoryMeter(() => now); const id = await add(meter, now);
  const correct = meter.correct.bind(meter); let loseAcknowledgement = true;
  meter.correct = async (input) => { const result = await correct(input); if (loseAcknowledgement) throw new Error("secret acknowledgement"); return result; };
  const logs: unknown[] = [];
  const args = { meter, now, runId: "secret", prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => caps }, log: (line: unknown) => logs.push(line) };
  expect(await runCorrections(args)).toMatchObject({ unknown: 1, corrected: 0, more: true });
  loseAcknowledgement = false; expect(await runCorrections(args)).toMatchObject({ corrected: 0 });
  expect(meter.ledger(id)?.deltaMicros).toBe(-9); expect((await meter.read(scope))[0]?.spentMicros).toBe(1);
  expect(logs).toEqual([{ event: "price_correction_unknown" }]);
});
it("malformed transaction results and sync throws have fixed unknown-outcome reports", async () => {
  for (const reply of [() => { throw new Error("secret"); }, () => Promise.resolve({ status: "secret" })]) {
    const meter = new InMemoryMeter(() => now); await add(meter, now); meter.correct = reply as typeof meter.correct;
    const logs: unknown[] = [];
    const result = await runCorrections({ meter, now, runId: "secret", prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => caps }, log: (line: unknown) => logs.push(line) });
    expect(result).toMatchObject({ unknown: 1, corrected: 0, more: true }); expect(logs).toEqual([{ event: "price_correction_unknown" }]); expect(JSON.stringify(result)).not.toContain("secret");
  }
});
it("expiry cursor advances past busy records and completes their retry on a later cycle", async () => {
  const meter = new InMemoryMeter(() => now); const ids: string[] = []; for (let i = 0; i < 201; i++) ids.push(await add(meter, now - age - 1000 + i));
  const expire = meter.expire.bind(meter); let healthy = false; let writes = 0;
  meter.expire = async (input) => { writes++; return healthy || input.callKey === ids.at(-1) ? expire(input) : { status: "busy" }; };
  expect(await runExpirySweep({ meter, now, runId: "run" })).toMatchObject({ skipped: 200, expired: 0, more: true }); expect(writes).toBe(200);
  expect(await runExpirySweep({ meter, now, runId: "run" })).toMatchObject({ expired: 1 });
  healthy = true; expect(await runExpirySweep({ meter, now, runId: "run" })).toMatchObject({ expired: 200 });
});
it("transaction input guards return fixed results and the standalone adapter bounds its own hook", async () => {
  let release!: () => void; const meter = new InMemoryMeter(() => now, () => false, async (op) => { if (op === "correct") await new Promise<void>((resolve) => { release = resolve; }); });
  const id = await add(meter, now); const input = { callKey: id, realMicros: 1, caps, now, runId: "run", priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: now } };
  for (const invalid of [null, { ...input, signal: {} }, { ...input, callKey: "" }, { ...input, runId: "x".repeat(513) }, { ...input, priceSource: { source: "secret", fetchedAt: now } }, { ...input, priceSource: { source: Object.create(null) as unknown, fetchedAt: now } }]) expect(await meter.correct(invalid as never)).toEqual({ status: "busy" });
  const controller = new AbortController(); controller.abort(); expect(await meter.correct({ ...input, signal: controller.signal })).toEqual({ status: "unknown" });
  vi.useFakeTimers();
  try { const pending = meter.correct(input); await vi.advanceTimersByTimeAsync(25_000); expect(await pending).toEqual({ status: "unknown" }); release(); await Promise.resolve(); expect(meter.ledger(id)?.status).toBe("pending"); expect(vi.getTimerCount()).toBe(0); }
  finally { vi.useRealTimers(); }
});
it("total deadline bounds even a nonconforming adapter that never acknowledges its write", async () => {
  const meter = new InMemoryMeter(() => now); await add(meter, now); meter.correct = () => new Promise(() => undefined);
  vi.useFakeTimers();
  try {
    const run = runCorrections({ meter, now, runId: "run", prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => caps } });
    await vi.advanceTimersByTimeAsync(25_000); expect(await run).toMatchObject({ unknown: 1, more: true }); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
}, 1000);
it("transaction receives only the time remaining after caps and cannot write after that shorter deadline", async () => {
  let release!: () => void;
  const meter = new InMemoryMeter(() => now, () => false, async (op) => { if (op === "correct") await new Promise<void>((resolve) => { release = resolve; }); });
  const id = await add(meter, now);
  vi.useFakeTimers();
  try {
    const run = runCorrections({ meter, now, runId: "run", prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => { await new Promise((resolve) => setTimeout(resolve, 24_000)); return caps; } } });
    await vi.advanceTimersByTimeAsync(25_000); expect(await run).toMatchObject({ unknown: 1, more: true });
    release(); await vi.advanceTimersByTimeAsync(0); expect(meter.ledger(id)?.status).toBe("pending"); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("expiry conflict and nonexpired direct writes leave every field unchanged", async () => {
  const meter = new InMemoryMeter(() => now); const fresh = await add(meter, now); const original = meter.ledger(fresh);
  expect(await meter.expire({ callKey: fresh, now, runId: "run" })).toEqual({ status: "busy" }); expect(meter.ledger(fresh)).toEqual(original);
  let conflict = false; const conflicted = new InMemoryMeter(() => now, () => conflict); const id = await add(conflicted); const ledger = conflicted.ledger(id); conflict = true;
  expect(await conflicted.expire({ callKey: id, now, runId: "run" })).toEqual({ status: "busy" }); expect(conflicted.ledger(id)).toEqual(ledger);
  expect(await meter.expire({ callKey: "missing", now, runId: "run" })).toEqual({ status: "missing" });
});
it("invalid run metadata refuses all reads and writes with a fixed report", async () => {
  const meter = new InMemoryMeter(() => now); await add(meter); let reads = 0;
  meter.pendingKeys = async () => { reads++; return { items: [] }; }; meter.pendingExpired = async () => { reads++; return { items: [] }; };
  for (const invalid of [{ now: NaN, runId: "run" }, { now: -1, runId: "run" }, { now, runId: "" }, { now, runId: null }, { now, runId: "x".repeat(513) }]) {
    const options = { meter, ...invalid, prices: { priceFor: () => undefined }, caps: { capsFor: async () => caps } };
    expect(await runCorrections(options as never)).toEqual({ corrected: 0, already: 0, skipped: 0, expired: 0, unknown: 0, more: true });
    expect(await runExpirySweep(options as never)).toEqual({ corrected: 0, already: 0, skipped: 0, expired: 0, unknown: 0, more: true });
  }
  expect(reads).toBe(0);
});
it("elapsed time after a caps read prevents starting a transaction even before the timer callback", async () => {
  const meter = new InMemoryMeter(() => now); const id = await add(meter, now); let time = 0; let writes = 0;
  const correct = meter.correct.bind(meter); meter.correct = async (input) => { writes++; return correct(input); };
  const result = await runCorrections({ meter, now, runId: "run", clock: () => time, prices: { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: { capsFor: async () => { time = 25_000; return caps; } } });
  expect(result).toMatchObject({ corrected: 0, more: true }); expect(writes).toBe(0); expect(meter.ledger(id)?.status).toBe("pending");
});
