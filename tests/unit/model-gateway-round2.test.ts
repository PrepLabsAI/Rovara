import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Price } from "../../packages/model-gateway/src/price.js";
import { SecretScanner } from "../../packages/model-gateway/src/provider.js";
import { createTaskTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { call, setup, scope, now, claims, kid, jwk, mint, requestBody, answer, sse } from "./model-gateway-fixture.js";

it("R2 common JWT/key prefixes pass unchanged and settle real usage", async () => {
  const token = mint();
  const key = ["sk", "ant", "api03", randomUUID(), randomUUID()].join("-");
  const text = [Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url") + ".e30.x", mint({ jti: randomUUID() }), key.slice(0, 7), key.slice(0, 13)].join(" ");
  const f = setup({ keys: { keyFor: async () => key }, transport: async () => ({ status: 200, body: (async function* () { yield sse("content_block_delta", { delta: { text } }); yield* answer(); })() }) });
  const r = await call(f.deps, requestBody, token);
  expect(r.destroyed).toBe(false); expect(r.ended).toBe(true); expect(r.text()).toContain(text);
  expect((await f.deps.meter.read(scope))[0]?.spentMicros).toBe(23);
});

it.each(["key", "token", "key window", "token window", "encoded key", "encoded token"])("R2 kills real %s across three chunks before ANY fragment escapes", async (kind) => {
  const token = mint(); const f = setup();
  const secret = kind.includes("key") ? f.providerKey : token;
  const material = kind.endsWith("window") ? secret.slice(-32, -8) : kind.startsWith("encoded") ? Buffer.from(secret).toString("base64") : secret;
  const pieces = [material.slice(0, 7), material.slice(7, -7), material.slice(-7)] as const;
  f.deps.transport = async () => ({ status: 200, body: (async function* () {
    // Split inside one valid SSE data string, not across separate JSON envelopes.
    yield Buffer.from('data: {"type":"content_block_delta","delta":{"text":"' + "safe".repeat(2000) + pieces[0]);
    yield Buffer.from(pieces[1]); yield Buffer.from(pieces[2] + '"}}\n\n'); yield* answer();
  })() });
  const r = await call(f.deps, requestBody, token);
  expect(r.destroyed).toBe(true); expect(r.ended).toBe(false);
  for (const piece of pieces) expect(r.text()).not.toContain(piece);
  expect(JSON.stringify(f.logs)).not.toContain(material);
  expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
});

it("R2 scanner processes the response ceiling with maximum secret lengths in bounded time", () => {
  const scanner = new SecretScanner(["fixture-" + randomUUID().repeat(228).slice(0, 8184), mint()]);
  const start = performance.now();
  for (let i = 0; i < 160; i++) expect(scanner.push(Buffer.alloc(65536, 120)).hit).toBe(false);
  expect(performance.now() - start).toBeLessThan(5000);
});

it.each([false, true])("R2 admitted priced/estimated call outlives token expiry: estimated=%s", async (estimated) => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const f = setup({ now: Date.now, meter: new InMemoryMeter(Date.now), ...(estimated ? { prices: { priceFor: () => undefined } } : {}), transport: async () => ({ status: 200, body: (async function* () { await new Promise((r) => setTimeout(r, 12 * 60_000)); yield* answer(); })() }) });
  const running = call(f.deps, { ...requestBody, max_tokens: 128_000 }, mint({ iat: now / 1000 - 840, nbf: now / 1000 - 870, exp: now / 1000 + 60 }));
  try {
    await vi.advanceTimersByTimeAsync(61_000);
    if (estimated) {
      const competing = await call({ ...f.deps, transport: async () => ({ status: 200, body: answer() }) }, requestBody, mint({ tid: "competing" }));
      expect(competing.status).toBe(429);
    }
    await vi.advanceTimersByTimeAsync(12 * 60_000 - 61_000);
    const r = await running; expect(r.ended).toBe(true); expect(r.destroyed).toBe(false);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated, ...(!estimated ? { costMicros: 23 } : {}) }));
  } finally { await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); await running; vi.useRealTimers(); }
});

it.each([10, 6000, 128_000])("R2 deadline scales with applied max %s and never exceeds 60 minutes", async (maxTokens) => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let cancelled = false;
  const f = setup({ now: Date.now, meter: new InMemoryMeter(Date.now), transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  // 10 tokens/sec conservatively, plus 60 seconds for admission/first token.
  const duration = Math.min(60 * 60_000, 60_000 + Math.ceil(maxTokens / 10) * 1000);
  const running = call(f.deps, { ...requestBody, max_tokens: maxTokens });
  try {
    await vi.advanceTimersByTimeAsync(duration - 1); expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(cancelled).toBe(true); await running;
    expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
    // A call the deadline cut, with nothing received, on the company's own key: the input estimate (failed-call.ts, DEC 254zzz521), not the hold.
    expect((await f.deps.meter.read(scope))[0]?.spentMicros).toBe(Math.ceil(Buffer.byteLength(JSON.stringify({ ...requestBody, max_tokens: maxTokens })) / 4));
  } finally { await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); await running; vi.useRealTimers(); }
});

it("R2 an ended task stops an idle admitted stream and stays company scoped", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let cancelled = false;
  const f = setup({ now: Date.now, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const running = call(f.deps);
  try {
    await vi.advanceTimersByTimeAsync(1);
    f.ended.end(scope.iss, `org_${"b".repeat(20)}`, scope.tid);
    await vi.advanceTimersByTimeAsync(1000); expect(cancelled).toBe(false);
    f.ended.end(scope.iss, scope.cid, scope.tid);
    await vi.advanceTimersByTimeAsync(1000); expect(cancelled).toBe(true); await running;
    expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
  } finally { await vi.runAllTimersAsync(); await running; vi.useRealTimers(); }
});

it("R2 ended admission is isolated by company and issuer", async () => {
  const f = setup();
  f.ended.end(scope.iss, scope.cid, scope.tid);
  expect((await call(f.deps)).status).toBe(403);
  expect((await call(f.deps, requestBody, mint({ cid: `org_${"b".repeat(20)}` }))).status).toBe(200);
  expect(await f.ended.isEnded("https://other.invalid", scope.cid, scope.tid)).toBe(false);
});

it.each([["5m", 200], ["1h", 200], ["unknown", 200], ["mixed", 200], ["explicit", 175]])("R2 cache-write %s rate settles through provider usage", async (tier, expected) => {
  const detail = tier === "5m" ? { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } : tier === "1h" ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } : tier === "mixed" ? { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } : undefined;
  const row = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, ...(tier === "explicit" ? { cacheWriteMicrosPerMTok: 1_750_000 } : {}) };
  const f = setup({ prices: { priceFor: () => row }, transport: async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100, ...(detail === undefined ? {} : { cache_creation: detail }) } } });
    yield sse("message_delta", { usage: { output_tokens: 0 } }); yield sse("message_stop");
  })() }) });
  expect((await call(f.deps)).ended).toBe(true);
  expect((await f.deps.meter.read(scope))[0]?.spentMicros).toBe(expected);
});

it("R2 tool system prompt fits in the reserved ceiling", async () => {
  let held = 0;
  const f = setup({ transport: async () => {
    held = (await f.deps.meter.read(scope))[0]!.reservedMicros;
    return { status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 4096 } } }); yield sse("message_delta", { usage: { output_tokens: 10 } }); yield sse("message_stop"); })() };
  } });
  const r = await call(f.deps, { ...requestBody, tools: [{ name: "fixture", input_schema: { type: "object" } }] });
  expect(r.ended).toBe(true); expect(held).toBeGreaterThanOrEqual(4116);
  expect((await f.deps.meter.read(scope))[0]).toMatchObject({ spentMicros: 4116, overrun: false });
});

it.each([429, 529])("R2 provider %s rejection bills neither input nor output and exposes fixed words", async (status) => {
  const f = setup({ transport: async () => ({ status, body: (async function* () { throw new Error("secret-rejection"); yield Buffer.alloc(0); })() }) });
  const r = await call(f.deps);
  expect(r.text()).toBe('{"error":{"type":"provider_error","message":"provider unavailable"}}');
  expect((await f.deps.meter.read(scope))[0]).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
  expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: false, costMicros: 0 }));
  expect(JSON.stringify(f.logs)).not.toContain("secret-rejection");
});

it("R2 failed JWKS rotation retains last good keys only until cache expiry; registry revocation is immediate", async () => {
  let clock = now; let fail = false; let revoked = false; let reads = 0;
  const entry = { issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid, "rotation"] };
  const registry = new StaticInstallRegistry([entry]);
  const verify = createTaskTokenVerifier({ registry: { find: (iss) => revoked ? { ...entry, taskKids: [] } : registry.find(iss) }, now: () => clock, readJwks: async () => { reads++; if (fail) throw new Error("private-cause"); return [jwk]; } });
  expect(await verify(mint())).toEqual(claims);
  clock += 60_000; fail = true;
  expect(await verify(mint({}, { kid: "rotation" }))).toBeUndefined();
  expect(await verify(mint())).toEqual(claims); expect(reads).toBe(2);
  revoked = true; expect(await verify(mint())).toBeUndefined(); revoked = false;
  clock = now + 900_000;
  const fresh = mint({ iat: clock / 1000, nbf: clock / 1000 - 30, exp: clock / 1000 + 900 });
  expect(await verify(fresh)).toBeUndefined(); expect(reads).toBe(3);
});

it.each([null, "secret-tier", { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 101 }, { ephemeral_5m_input_tokens: 101, ephemeral_1h_input_tokens: -1 }, { ephemeral_5m_input_tokens: 101, ephemeral_1h_input_tokens: 0 }, { ephemeral_5m_input_tokens: 100 }, { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0, future_tier: 1 }])("R2 invalid cache tier detail fails the whole stream: %j", async (detail) => {
  const f = setup({ transport: async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 0, cache_creation_input_tokens: 100, cache_creation: detail } } });
    yield sse("message_delta", { usage: { output_tokens: 0 } }); yield sse("message_stop");
  })() }) });
  const r = await call(f.deps); expect(r.destroyed).toBe(true); expect(r.ended).toBe(false);
  expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
  expect(JSON.stringify(f.logs)).not.toContain("secret-tier");
});

it.each([0, -1, NaN, Infinity, "private-price"])("R2 invalid explicit cache price uses cautious pricing: %s", async (rate) => {
  const row = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheWriteMicrosPerMTok: rate };
  const f = setup({ prices: { priceFor: () => row as unknown as Price } });
  expect((await call(f.deps)).ended).toBe(true);
  expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
  expect(JSON.stringify(f.logs)).not.toContain("private-price");
});

it("R2 one-hour ceiling cannot be raised by a timeout override", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let cancelled = false;
  const f = setup({ timeoutMs: 7_200_000, now: Date.now, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const running = call(f.deps, { ...requestBody, max_tokens: 128_000 });
  try { await vi.advanceTimersByTimeAsync(3_600_000); expect(cancelled).toBe(true); await running; }
  finally { await vi.runAllTimersAsync(); await running; vi.useRealTimers(); }
});

it("R2 streamed provider error after accepted head still charges the full hold", async () => {
  const f = setup({ transport: async () => ({ status: 200, body: (async function* () { yield sse("error", { error: { type: "overloaded_error", message: "private-error" } }); })() }) });
  const r = await call(f.deps); expect(r.destroyed).toBe(true);
  expect((await f.deps.meter.read(scope))[0]?.spentMicros).toBeGreaterThan(0);
  expect(f.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
});

it("R2 ended check refuses the next chunk without waiting for the idle poll", async () => {
  const f = setup();
  f.deps.transport = async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 1 } } });
    f.ended.end(scope.iss, scope.cid, scope.tid);
    yield sse("content_block_delta", { delta: { text: "after-ended" } }); yield* answer();
  })() });
  const r = await call(f.deps); expect(r.destroyed).toBe(true); expect(r.ended).toBe(false); expect(r.text()).not.toContain("after-ended");
});

it("R2 a failed idle ended check aborts with fixed words and the fault charge", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let checks = 0; let cancelled = false;
  const f = setup({ now: Date.now, ended: { isEnded: async () => { if (++checks > 1) throw new Error("private-ended"); return false; } }, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const running = call(f.deps);
  try { await vi.advanceTimersByTimeAsync(1000); expect(cancelled).toBe(true); await running; expect(JSON.stringify(f.logs)).not.toContain("private-ended"); }
  finally { await vi.runAllTimersAsync(); await running; vi.useRealTimers(); }
});

it("R2 cached tool definitions take the company marker at cache-write prices", async () => {
  const f = setup(); let release!: () => void; let opened!: () => void; let sent = 0;
  const paused = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { opened = r; });
  const body = { ...requestBody, tools: [{ name: "fixture", description: "x".repeat(5000), input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }] };
  f.deps.transport = async () => ({ status: 200, body: (async function* () { if (++sent === 1) { opened(); await paused; } yield* answer(); })() });
  const running = call(f.deps, body); await started;
  try { expect((await call(f.deps, body, mint({ tid: "cached_tools_second" }))).status).toBe(429); }
  finally { release(); await running; }
});

it("R2 a later cache total without tiers discards stale five-minute pricing", async () => {
  const f = setup({ transport: async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 0, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } } });
    yield sse("message_delta", { usage: { output_tokens: 0, cache_creation_input_tokens: 200 } }); yield sse("message_stop");
  })() }) });
  expect((await call(f.deps)).ended).toBe(true);
  expect((await f.deps.meter.read(scope))[0]?.spentMicros).toBe(400);
});
