import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { expect, it, vi } from "vitest";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { call, setup, scope, caps, now, claims, mint, requestBody, answer, sse } from "./model-gateway-fixture.js";

const limits = { maxOutputTokens: () => 128_000 };
const overrun = (deadlineSeconds = now / 1000 + 60, tokenExpiresSeconds = now / 1000 + 900) => ({ deadlineSeconds, tokenExpiresSeconds });
const next = { ...scope, tid: "task_2" };
it("ADDENDUM-3 defaults to the model row's own maximum and records the applied limit", async () => {
  let sent: Record<string, unknown> | undefined;
  const f = setup({ transport: async (r) => { sent = JSON.parse(r.body.toString()) as Record<string, unknown>; return { status: 200, body: answer() }; } });
  const deps = { ...f.deps, modelLimits: limits };
  expect((await call(deps, { ...requestBody, max_tokens: undefined })).status).toBe(200);
  expect(sent?.max_tokens).toBe(128_000);
  expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", appliedMaxOutputTokens: 128_000 }));
});
it("ADDENDUM-3 refuses above the model maximum before holding or sending, with fixed words", async () => {
  const f = setup(); const deps = { ...f.deps, modelLimits: limits };
  const r = await call(deps, { ...requestBody, max_tokens: 128_001, messages: [{ role: "user", content: "secret-canary" }] });
  expect(r.status).toBe(400); expect(r.text()).toBe('{"error":{"type":"invalid_request","message":"request not allowed"}}');
  expect(f.calls).toHaveLength(0); expect((await f.meter.read(scope))[0]?.reservedMicros).toBe(0);
  expect(JSON.stringify(f.logs)).not.toContain("secret-canary");
  expect((await call(deps, { ...requestBody, max_tokens: 128_000 })).status).toBe(200);
});
it("ADDENDUM-3 refuses missing or malformed model limits without echoing their cause", async () => {
  for (const value of [undefined, 0, -1, NaN, Infinity, 1.5, "private-limit"]) {
    const f = setup();
    const deps = { ...f.deps, modelLimits: { maxOutputTokens: () => value } };
    const r = await call(deps);
    expect(r.status).toBe(400); expect(r.text()).toBe('{"error":{"type":"invalid_request","message":"request not allowed"}}'); expect(f.calls).toHaveLength(0);
  }
  const f = setup(); const r = await call({ ...f.deps, ...{ modelLimits: { maxOutputTokens: () => { throw new Error("secret-limit"); } } } });
  expect(r.text()).toBe('{"error":{"type":"invalid_request","message":"request not allowed"}}');
});
it("ADDENDUM-3 N parallel priced calls at the cap use full input ceilings and never overrun", async () => {
  const f = setup({ prices: { priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000 }) } });
  const body = { ...requestBody, messages: [{ role: "user", content: "x".repeat(2_100_000) }] };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const perCall = bytes + 10;
  f.deps.caps = new FixedCapsSource({ ...caps, companyMonth: perCall * 2 });
  let release!: () => void; const paused = new Promise<void>((r) => { release = r; });
  let sent = 0;
  f.deps.transport = async () => { sent++; return { status: 200, body: (async function* () { await paused; yield sse("message_start", { message: { usage: { input_tokens: bytes, cache_creation_input_tokens: 0 } } }); yield sse("message_delta", { usage: { output_tokens: 10 } }); yield sse("message_stop"); })() }; };
  const running = Array.from({ length: 8 }, (_, i) => call(f.deps, body, mint({ tid: `priced_${i}` })));
  // A microtask barrier at the provider ensures all admissions have reached reserve without timers.
  for (let i = 0; i < 100; i++) await Promise.resolve();
  try { expect(sent).toBe(2); expect((await f.meter.read(scope)).find((r) => r.item === "company")?.reservedMicros).toBe(perCall * 2); }
  finally { release(); }
  const results = await Promise.all(running);
  expect(results.filter((r) => r.status === 200)).toHaveLength(2);
  expect(results.filter((r) => r.status === 429)).toHaveLength(6);
  expect((await f.meter.read(scope)).find((r) => r.item === "company")).toMatchObject({ spentMicros: perCall * 2, reservedMicros: 0, overrun: false });
});
it("ADDENDUM-3 parallel overrun calls admit one, count each retryable busy and allow priced calls", async () => {
  let busyCount = 0;
  const f = setup({ prices: { priceFor: () => undefined } });
  const deps = { ...f.deps, metrics: { overrunBusy: (iss: string, company: string) => { expect(iss).toBe(claims.iss); expect(company).toBe(claims.cid); busyCount++; } } };
  let release!: () => void; let opened!: () => void;
  const paused = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { opened = r; });
  let entered = 0;
  f.deps.transport = async () => ({ status: 200, body: (async function* () { opened(); if (++entered === 1) await paused; yield* answer(); })() });
  deps.transport = f.deps.transport;
  const running = call(deps); await started;
  try {
    for (let i = 0; i < 2; i++) {
      const busy = await call(deps, requestBody, mint({ tid: `other_${i}` }));
      expect(busy.status).toBe(429); expect(busy.headers["retry-after"]).toBe("2");
      expect(busy.text()).toBe('{"error":{"type":"busy","message":"Another call for this company may exceed its reserved cost right now; try again in a moment."}}');
    }
    expect(f.logs.filter((x) => (x as { event: string }).event === "overrun_busy")).toEqual([
      { event: "overrun_busy", company: claims.cid }, { event: "overrun_busy", company: claims.cid },
    ]);
    expect(busyCount).toBe(2);
    const priced = setup({ meter: f.meter }); expect((await call(priced.deps)).status).toBe(200);
  } finally { release(); await running; }
  expect((await call({ ...f.deps, transport: async () => ({ status: 200, body: answer() }) })).status).toBe(200);
});
it("ADDENDUM-3 two overrun-capable reservations leave the company at most one call over", async () => {
  const meter = new InMemoryMeter(() => now);
  const args = { scope, caps: { ...caps, companyMonth: 100 }, estimateMicros: 40, overrun: overrun() };
  const results = await Promise.all([meter.reserve(args), meter.reserve({ ...args, scope: next })]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ reason: "busy", overrunInFlight: true });
  for (const r of results) if (r.ok) await meter.settle(r.reservation, 120);
  expect((await meter.read(scope)).find((r) => r.item === "company")).toMatchObject({ spentMicros: 120, reservedMicros: 0, overrun: true });
  expect(await meter.reserve({ ...args, scope: next })).toMatchObject({ reason: "overrun", item: "company" });
});
it("ADDENDUM-3 crashed marker expires exactly at deadline but its hold stays counted", async () => {
  let clock = now; const meter = new InMemoryMeter(() => clock);
  const args = { scope, caps: { ...caps, companyMonth: 100 }, estimateMicros: 40, overrun: overrun(now / 1000 + 10) };
  const old = await meter.reserve(args); expect(old.ok).toBe(true);
  clock += 9_999;
  expect(await meter.reserve({ ...args, scope: next, overrun: overrun() })).toMatchObject({ reason: "busy" });
  clock++;
  const newer = await meter.reserve({ ...args, scope: next, overrun: overrun() }); expect(newer.ok).toBe(true);
  expect((await meter.read(scope)).find((r) => r.item === "company")?.reservedMicros).toBe(80);
  // Closing the expired owner must not erase the replacement's marker.
  if (old.ok) await meter.settle(old.reservation, 40);
  expect(await meter.reserve({ ...args, estimateMicros: 10, overrun: overrun() })).toMatchObject({ reason: "busy", overrunInFlight: true });
  if (newer.ok) await meter.settle(newer.reservation, 40);
  expect(await meter.reserve({ ...args, estimateMicros: 30, overrun: overrun() })).toMatchObject({ reason: "cap" });
});
it("ADDENDUM-3 marker never outlives token expiry or fifteen minutes, and never crosses companies", async () => {
  for (const lifetime of [5, 900]) {
    let clock = now; const meter = new InMemoryMeter(() => clock);
    const args = { scope, caps, estimateMicros: 40, overrun: overrun(now / 1000 + 3600, now / 1000 + (lifetime === 5 ? 5 : 3600)) };
    expect((await meter.reserve(args)).ok).toBe(true);
    expect((await meter.reserve({ ...args, scope: { ...scope, cid: `org_${"b".repeat(20)}` } })).ok).toBe(true);
    clock += lifetime * 1000 - 1;
    expect(await meter.reserve({ ...args, scope: next })).toMatchObject({ reason: "busy" });
    clock++;
    expect((await meter.reserve({ ...args, scope: next, overrun: overrun(clock / 1000 + 60, clock / 1000 + 900) })).ok).toBe(true);
    expect((await meter.read(scope)).find((r) => r.item === "company")?.reservedMicros).toBe(80);
  }
});
it("ADDENDUM-3 malformed or expired marker metadata refuses atomically", async () => {
  const meter = new InMemoryMeter(() => now);
  for (const value of [null, true, {}, { deadlineSeconds: "secret", tokenExpiresSeconds: now / 1000 + 900 }, overrun(NaN), overrun(now / 1000), overrun(now / 1000 + 60, now / 1000)]) {
    const args = { scope, caps, estimateMicros: 40, overrun: value };
    expect(await meter.reserve(args as Parameters<InMemoryMeter["reserve"]>[0])).toEqual({ ok: false, reason: "busy" });
    expect((await meter.read(scope))[0]?.reservedMicros).toBe(0);
  }
});
it("ADDENDUM-3 known-price media with no byte ceiling still takes the company marker", async () => {
  const f = setup();
  let release!: () => void; let opened!: () => void;
  const pause = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { opened = r; });
  let entered = 0;
  f.deps.transport = async () => ({ status: 200, body: (async function* () { opened(); if (++entered === 1) await pause; yield* answer(); })() });
  // A document block stays unbounded and admitted; a remote image is now refused before any hold (see the next test).
  const media = { ...requestBody, messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://example.invalid/private" } }] }] };
  const running = call(f.deps, media);
  // Never wait on the provider alone: a refused first call must fail this test at once instead of hanging it.
  await Promise.race([started, running.then((r) => { throw new Error(`first call settled without reaching the provider: ${r.status}`); })]);
  try { expect((await call(f.deps, media, mint({ tid: "second" }))).status).toBe(429); }
  finally { release(); await running; }
});
it("ADDENDUM-3 a remote image is refused before any hold, send or company marker", async () => {
  const f = setup(); let sent = 0;
  f.deps.transport = async () => { sent++; return { status: 200, body: answer() }; };
  const media = { ...requestBody, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/private" } }] }] };
  const first = await call(f.deps, media);
  expect(first.status).toBe(409); expect(first.text()).toMatch(/run_price_authorization_required/u);
  expect(first.text()).toContain("This image can't be priced (only inline png, jpeg, gif or webp up to the size limit can be sent). Send it inline or leave it out."); expect(first.text()).not.toMatch(/AI source or price changed/u);
  expect(sent).toBe(0);
  expect((await f.meter.read(scope)).find((r) => r.item === "company")?.reservedMicros ?? 0).toBe(0);
  // No marker was left behind, so a different task is not told the company is busy.
  expect((await call(f.deps, media, mint({ tid: "second" }))).status).toBe(409);
});

it("ADDENDUM-3 stops the provider when the admission-bounded marker expires", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let cancelled = false;
  const f = setup({ now: Date.now, meter: new InMemoryMeter(Date.now), prices: { priceFor: () => undefined }, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const running = call(f.deps, { ...requestBody, max_tokens: 128_000 }, mint({ iat: now / 1000 - 899, nbf: now / 1000 - 929, exp: now / 1000 + 1 }));
  try {
    await vi.advanceTimersByTimeAsync(899_999); expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toBe(true);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
  } finally { await vi.runAllTimersAsync(); await running; vi.useRealTimers(); }
});
it("ADDENDUM-3 aligns the provider deadline with the marker's integer-second expiry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now + 250);
  let cancelled = false;
  const f = setup({ now: Date.now, timeoutMs: 1500, meter: new InMemoryMeter(Date.now), prices: { priceFor: () => undefined }, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const running = call(f.deps);
  try { await vi.advanceTimersByTimeAsync(750); expect(cancelled).toBe(true); }
  finally { await vi.runAllTimersAsync(); await running; vi.useRealTimers(); }
});
it("ADDENDUM-3 the provider cannot outlive the marker's fifteen-minute ceiling", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let cancelled = false;
  const f = setup({ now: Date.now, timeoutMs: 3_600_000, meter: new InMemoryMeter(Date.now), prices: { priceFor: () => undefined }, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const running = call(f.deps, requestBody, mint({ iat: now / 1000 + 30, nbf: now / 1000, exp: now / 1000 + 930 }));
  try { await vi.advanceTimersByTimeAsync(900_000); expect(cancelled).toBe(true); }
  finally { await vi.runAllTimersAsync(); await running; vi.useRealTimers(); }
});
it("ADDENDUM-3 refuses malformed applied limits and leaves no marker on failed admission", async () => {
  let conflict = false;
  const meter = new InMemoryMeter(() => now, () => conflict);
  for (const appliedMaxOutputTokens of [0, -1, NaN, Infinity, 1.5, "secret"]) {
    const args = { scope, caps, estimateMicros: 40, appliedMaxOutputTokens, overrun: overrun() };
    expect(await meter.reserve(args as Parameters<InMemoryMeter["reserve"]>[0])).toEqual({ ok: false, reason: "busy" });
    expect((await meter.read(scope))[0]?.reservedMicros).toBe(0);
  }
  const args = { scope, caps, estimateMicros: 40, overrun: overrun() };
  expect(await meter.reserve({ ...args, caps: { ...caps, companyMonth: 0 } })).toMatchObject({ reason: "cap" });
  conflict = true; expect(await meter.reserve(args)).toEqual({ ok: false, reason: "busy" }); conflict = false;
  const admitted = await meter.reserve({ ...args, appliedMaxOutputTokens: 128_000 }); expect(admitted.ok).toBe(true);
  if (admitted.ok) expect(admitted.reservation).toMatchObject({ appliedMaxOutputTokens: 128_000 });
});
