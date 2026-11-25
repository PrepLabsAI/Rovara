import { createHash } from "node:crypto";
import type { ReserveInput } from "../../packages/model-gateway/src/meter.js";
import type { ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, now, setup, sse, scope, caps, mint } from "./model-gateway-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import type { ChargeReceiptV1, SettleV2 } from "../../packages/model-gateway/src/charge-receipt.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
beforeAll(denyNetwork);
it("negotiates receipts, binds a call and fingerprint before forwarding, and retains its own reservation after truncation", async () => {
  let initial: ChargeReceiptV1 | undefined, settled: ChargeReceiptV1 | undefined, fingerprint: unknown;
  const meter = new InMemoryMeter(() => now);
  const reserve = meter.reserve.bind(meter);
  meter.reserve = async input => { const charge = Reflect.get(input, "charge"); initial = charge?.receipt; fingerprint = charge?.requestFingerprint; return reserve(input); };
  const v2 = Reflect.get(meter, "settleV2").bind(meter);
  Reflect.set(meter, "settleV2", async (v: SettleV2) => { settled = v.receipt; return v2(v); });
  const f = setup({ meter, transport: async () => { expect(initial).toMatchObject({ operationId: claims.op, status: "awaiting_usage" }); expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u); return { status: 200, body: (async function* () { yield Buffer.from('data: {"type":"message_start"}\\n\\n'); })() }; } });
  Reflect.set(f.deps, "chargeReceipts", { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" }) });
  await call(f.deps);
  expect(settled).toMatchObject({ status: "awaiting_usage", reason: "missing_usage", callId: initial?.callId, operationId: claims.op, originalReservationMicros: initial?.amountMicros, amountMicros: initial?.amountMicros });
});
it("keeps authoritative provider money separate when the response contains no token usage", async () => {
  const meter = new InMemoryMeter(() => now);
  let settled: ChargeReceiptV1 | undefined;
  const v2 = meter.settleV2.bind(meter);
  meter.settleV2 = async input => { settled = input.receipt; return v2(input); };
  const f = setup({ meter, transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from("event: ping\ndata: {\"type\":\"ping\"}\n\n"); })(), reportedCostMicros: () => 30 }) });
  Reflect.set(f.deps, "chargeReceipts", { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" }) });
  await call(f.deps);
  expect(settled).toMatchObject({ status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 30 }, providerCostMicros: { state: "available", value: 30 }, usage: { state: "unavailable" }, usageComplete: false });
});
it("an all-zero usage placeholder cannot claim complete usage", async () => {
  const { finishCharge } = await import("../../packages/model-gateway/src/charge-producer.js");
  const { chargeReceipt } = await import("./model-gateway-charge-receipt-fixture.js");
  const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false, usageEstimated: false };
  const r = finishCharge(chargeReceipt(), { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, price, notSent: false, now });
  expect(r).toMatchObject({ status: "awaiting_usage", usageComplete: false });
});

it("the gateway uses forwarded bytes after a synthetic-zero-only stream is cut off", async () => {
  const { chargeReceipt } = await import("./model-gateway-charge-receipt-fixture.js");
  const meter = new InMemoryMeter(() => now);
  const time = new Date(now).toISOString();
  for (let n = 0; n < 20; n++) {
    const r = await meter.reserve({ scope, caps, estimateMicros: 80 }); if (!r.ok) throw new Error("reserve");
    await meter.settleV2({ reservationId: r.reservation.id, receipt: chargeReceipt({ callId: r.reservation.id, issuer: claims.iss, model: { provider: "anthropic", modelId: claims.mdl[0]! }, status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 1 }, providerCostMicros: { state: "available", value: 1 }, usageComplete: true, usage: { state: "available", value: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } }, occurredAt: time, recordedAt: time, accountingDay: time.slice(0, 10), accountingMonth: time.slice(0, 7) }) });
  }
  const f = setup({ meter, transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }); })() }) });
  f.deps.chargeReceipts = { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" }) };
  await call(f.deps);
  const pending = (await meter.pendingFor({ provider: "anthropic", model: claims.mdl[0]! }, 10)).items;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ estimateBasis: "input_bytes_bound", outputEstimateBasis: "p90_history", chargeStatus: "awaiting_usage" });
  expect(pending[0]!.settledMicros).toBeGreaterThan(2);
});

it.each(["openai", "converse"] as const)("%s binds the translated wire bytes and tool allowance before forwarding", async adapter => {
  const meter = new InMemoryMeter(() => now);
  let reserved: ReserveInput | undefined;
  let forwarded: Buffer | undefined;
  const reserve = meter.reserve.bind(meter);
  meter.reserve = async input => { reserved = input; return reserve(input); };
  const transport: ProviderTransport = async request => {
    forwarded = Buffer.from(request.body);
    return { status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0 } } }); })() };
  };
  const model = adapter === "openai" ? "gpt-5-mini" : "amazon.nova-pro-v1:0";
  const f = setup({ meter, agentKeys: { connected: async () => true, keyFor: async () => "fixture-key" }, agentAi: {
    sources: { sourceFor: async () => adapter === "openai" ? "openai_key" : "rovara" },
    switchedOn: new Set(["openai"]),
    ...(adapter === "openai" ? { openai: { transport } } : { rovara: { transport, models: new Map([[model, model]]), exempt: new Set([claims.cid]) } }),
  } });
  f.deps.chargeReceipts = { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "openai", connectionRevision: "7" }, billing: "external_provider" }) };
  const result = await call(f.deps, { model, max_tokens: 100, stream: true, tools: [{ name: "ping", description: "Ping", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hello" }] }, mint({ mdl: [model] }));
  expect(result.status).toBe(200);
  expect(forwarded).toBeDefined();
  const body = JSON.parse(forwarded!.toString()) as Record<string, unknown>;
  expect(body).toHaveProperty(adapter === "openai" ? "tools" : "toolConfig");
  expect(body).not.toHaveProperty("max_tokens");
  expect(reserved?.provisional).toMatchObject({ requestBytes: forwarded!.length, toolInputAllowanceTokens: 4096 });
  expect(reserved?.charge?.requestFingerprint).toBe(createHash("sha256").update(forwarded!).digest("hex"));
});

it.each(["anthropic", "openai", "openrouter"] as const)("%s receipts keep the admitted credential revision and bound key", async provider => {
  const model = provider === "anthropic" ? "claude-sonnet-5-5" : provider === "openai" ? "gpt-5-mini" : "openai/gpt-5-mini";
  const meter = new InMemoryMeter(() => now);
  let reserved: ReserveInput | undefined;
  const reserve = meter.reserve.bind(meter);
  meter.reserve = async input => { reserved = input; return reserve(input); };
  const sent: string[] = [];
  const transport: ProviderTransport = async request => { sent.push(request.key); return { status: 200, body: (async function* () {})() }; };
  const source = { kind: "company_key" as const, id: `saved_${provider}`, name: "Company key", provider, connectionRevision: "revision_7" };
  const f = setup({ meter, transport, agentKeys: {
    connected: async () => true,
    keyFor: async () => { throw new Error("must use the pinned credential"); },
    resolveForCharge: async (_iss, _cid, actualProvider) => { expect(actualProvider).toBe(provider); return { source, key: async () => "pinned-key" }; },
  }, agentAi: {
    sources: { sourceFor: async () => `${provider}_key` }, switchedOn: new Set([provider]),
    ...(provider === "anthropic" ? {} : { [provider]: { transport } }),
  }, chargeReceipts: { source: (_claims, _model, resolved) => resolved } });
  let runPrice: RunPrice | undefined;
  if (provider === "openrouter") {
    const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0", input_cache_read: "0", input_cache_write: "0.000001" }, max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture" };
    const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
    f.deps.prices = prices; f.deps.openRouterTariffs = [tariff];
    const quote = await answerRateQuote({ prices, keys: { ...f.deps.agentKeys!, identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) }, sources: { sourceFor: async () => "openrouter_key" }, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
    runPrice = (quote.body as { runPrice: RunPrice }).runPrice;
  }
  expect((await call(f.deps, { model, max_tokens: 10, messages: [{ role: "user", content: "hello" }], stream: true }, mint({ mdl: [model], ...(runPrice === undefined ? {} : { runPrice }) }))).status).toBe(200);
  expect(sent).toEqual(["pinned-key"]);
  expect(reserved?.charge?.receipt.source).toEqual(source);
});

it.each(["anthropic_key", "rovara"] as const)("fallback to %s binds only the winning source's receipt", async winner => {
  const meter = new InMemoryMeter(() => now);
  let reserved: ReserveInput | undefined;
  const reserve = meter.reserve.bind(meter);
  meter.reserve = async input => { reserved = input; return reserve(input); };
  const model = "claude-sonnet-5-5";
  const used: string[] = [];
  const resolvedProviders: string[] = [];
  const transport: ProviderTransport = async request => { used.push(request.key); return { status: 200, body: (async function* () {})() }; };
  const f = setup({ meter, transport, agentKeys: {
    connected: async () => true, keyFor: async () => { throw new Error("unpinned key"); },
    resolveForCharge: async (_iss, _cid, provider) => {
      resolvedProviders.push(provider);
      return { source: { kind: "company_key", id: `saved_${provider}`, name: "Company key", provider, connectionRevision: "revision_7" }, key: async () => { used.push(`${provider}-key-read`); return `${provider}-pinned`; } };
    },
  }, agentAi: {
    sources: { sourceFor: async () => "openai_key", orderFor: async () => ({ source: "openai_key", fallback: [winner] }) },
    switchedOn: new Set(["openai"]), openai: { transport }, rovara: { transport, models: new Map([[model, "us.anthropic.claude-sonnet-5-5-v1:0"]]), exempt: new Set([claims.cid]) },
  }, chargeReceipts: { source: (_claims, _model, resolved) => resolved } });
  expect((await call(f.deps, { model, max_tokens: 10, messages: [{ role: "user", content: "hello" }], stream: true }, mint({ mdl: [model] }))).status).toBe(200);
  expect(reserved?.charge?.receipt.source).toMatchObject(winner === "rovara" ? { kind: "rovara_ai", id: "rovara-ai", provider: "bedrock", connectionRevision: createHash("sha256").update(JSON.stringify([[model, "us.anthropic.claude-sonnet-5-5-v1:0"]])).digest("hex") } : { id: "saved_anthropic", provider: "anthropic", connectionRevision: "revision_7" });
  expect(used).not.toContain("openai-key-read");
  expect(resolvedProviders).toEqual(winner === "rovara" ? ["openai"] : ["openai", "anthropic"]);
  if (winner === "anthropic_key") expect(used).toEqual(["anthropic-key-read", "anthropic-pinned"]);
  expect(f.logs).toContainEqual({ event: "agent_source", company: claims.cid, source: winner === "rovara" ? "rovara" : "company_key", via: "fallback" });
});
