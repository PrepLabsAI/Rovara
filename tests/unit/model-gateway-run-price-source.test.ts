import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, MemorySink } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
beforeAll(denyNetwork);
const model = claims.mdl[0]!;
const id = "us.anthropic.claude-sonnet-4-5-v1:0";
const sourceId = "arn:aws:iam::123456789012:role/gateway@us-west-2";
async function world(defaultBilled = false) {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "bedrock", model: id, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const rovara = { sourceId, models: new Map([[model, id]]), exempt: new Set(defaultBilled ? [] : [claims.cid]) };
  const keys = { connected: async () => false, keyFor: async () => undefined };
  const sources = { sourceFor: async () => defaultBilled ? undefined : "rovara" as const };
  const quote = async (identity: string | undefined) => answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources, keys,
    rovara: { models: rovara.models, exempt: rovara.exempt, ...(identity === undefined ? {} : { sourceId: identity }) }, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) },
  { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  return { prices, rovara, keys, sources, quote };
}
it("only authorizes the operator source with a deployed account and Region identity", async () => {
  const w = await world();
  expect((await w.quote(sourceId)).body).toMatchObject({ runPrice: { sourceId, catalogModel: id } });
  const legacy = (await w.quote(undefined)).body;
  expect(legacy).toMatchObject({ state: "available" });
  expect(legacy).not.toHaveProperty("runPrice");
});
it("pauses a newly admitted operator account before any reservation or provider call", async () => {
  const w = await world();
  const grant = ((await w.quote(sourceId)).body as { runPrice: RunPrice }).runPrice;
  for (const admitted of [sourceId, sourceId.replace("123456789012", "999999999999")]) {
    const f = setup({ prices: w.prices, agentKeys: w.keys });
    f.deps.agentAi = { sources: w.sources, rovara: { ...w.rovara, sourceId: admitted, transport: f.deps.transport } };
    const reserve = vi.spyOn(f.meter, "reserve");
    const answer = await call(f.deps, undefined, mint({ runPrice: grant }));
    if (admitted === sourceId) { expect(answer.status).toBe(200); expect(reserve).toHaveBeenCalledTimes(1); expect(f.calls).toHaveLength(1); }
    else { expect(answer.status).toBe(409); expect(answer.text()).toContain("run_price_authorization_required"); expect(reserve).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); }
  }
});
it("qualifies signed admission separately from having a price snapshot", async () => {
  const f = setup({ runPriceReady: () => 9 });
  const sink = new MemorySink();
  await handleGateway(f.deps, { method: "GET", url: "/healthz", headers: {}, body: (async function* () {})() }, sink);
  expect(JSON.parse(sink.text())).toEqual({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 9 } });
});

it("keeps an exact micro-rate ceiling valid without rounding a smaller authorization up", async () => {
  const { parseTaskClaims } = await import("../../packages/model-gateway/src/model-gateway-token.js");
  const { runPriceAllows } = await import("../../packages/model-gateway/src/run-price.js");
  const w = await world();
  const base = ((await w.quote(sourceId)).body as { runPrice: RunPrice }).runPrice;
  const rate = 1_000_001;
  const price = { estimated: false, priceVersion: 9, inputMicrosPerMTok: rate, outputMicrosPerMTok: rate, cacheReadMicrosPerMTok: rate, cacheWrite5mMicrosPerMTok: rate, cacheWrite1hMicrosPerMTok: rate };
  const runPrice = { ...base, inputUsdPerMillion: rate / 1_000_000, outputUsdPerMillion: rate / 1_000_000, cacheReadUsdPerMillion: rate / 1_000_000, cacheWriteUsdPerMillion: rate / 1_000_000 };
  const source = { source: { kind: "rovara_ai" as const, id: sourceId, name: "Operator AI", provider: "bedrock", connectionRevision: base.connectionRevision }, billing: "customer" as const };
  expect(runPriceAllows(parseTaskClaims({ ...claims, runPrice })!, "bedrock", id, source, price, now)).toBe(true);
  expect(runPriceAllows(parseTaskClaims({ ...claims, runPrice: { ...runPrice, inputUsdPerMillion: (rate - 0.1) / 1_000_000 } })!, "bedrock", id, source, price, now)).toBe(false);
});

it("a non-exempt default gets a usable exact operator quote and customer receipt", async () => {
  const w = await world(true);
  const grant = ((await w.quote(sourceId)).body as { runPrice: RunPrice }).runPrice;
  expect(grant).toMatchObject({ companyId: claims.cid, sourceId, provider: "bedrock", catalogModel: id, snapshotVersion: 9 });
  const f = setup({ prices: w.prices, agentKeys: w.keys, chargeReceipts: { source: (_claims, _model, resolved) => resolved } });
  f.deps.agentAi = { sources: w.sources, rovara: { ...w.rovara, transport: f.deps.transport } };
  const settle = vi.spyOn(f.meter, "settleV2");
  expect((await call(f.deps, undefined, mint({ runPrice: grant }))).status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ billing: "customer", source: { kind: "rovara_ai", id: sourceId }, usage: { state: "available" } });
});
