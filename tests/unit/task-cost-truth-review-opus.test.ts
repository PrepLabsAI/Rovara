// Opus money review of task cost truth stage 1 (232e9fe21): tests the reviewer found missing. UNCOMMITTED.
// 1. A long run renews its model access every few minutes. The accepted run price (the ceiling) keeps the FIRST answer's `expiresAt`, so after ~5 minutes it reads as expired;
//    whenever the latest answer has no usable quote (a failed broker read, or a cached quote that expires before the run price it travels with), a runtime opened then must
//    still price from the gateway's rates, never fall back to the catalog's direct row (the 9 percent low bug this lane fixes).
// 2. The reviewer-slot quote is never handed to the token mint (it is read only after the token is signed).
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateQuoteV1Schema, RunPriceSchema, type RateQuoteV1, type RunPrice } from "../../packages/contracts/src/index.js";
import { gatewayModelCost } from "../../packages/model-runtime/src/gateway-cost.js";
import { lazyModelProxy, modelAccessSource } from "../../packages/worker/src/model-access.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const NAME = "claude-haiku-4-5";
const CATALOG = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);

const quoteAt = (asOf: number, expiresAt: number): RateQuoteV1 => RateQuoteV1Schema.parse({
  version: 1, currency: "USD", unit: "micros_per_million_tokens", ref: { authority: "gateway", version: "10", hash: "a".repeat(64), fetchedAt: new Date(asOf).toISOString() },
  source: { kind: "rovara_ai", id: "src", name: "src", provider: "bedrock", connectionRevision: "r1" }, model: { provider: "bedrock", modelId: CATALOG }, region: "us-west-2",
  asOf: new Date(asOf).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  base: { input: 1_100_000, output: 5_500_000, cacheRead: 110_000, cacheWrite5m: 1_375_000, cacheWrite1h: 2_200_000 }, longContext: [], derived: [],
});
const runPriceAt = (expiresAt: number): RunPrice => RunPriceSchema.parse({
  companyId: COMPANY, model: NAME, provider: "bedrock", sourceId: "src", connectionRevision: "r1", catalogModel: CATALOG, snapshotHash: "b".repeat(64), snapshotVersion: 10, expiresAt,
  inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5, cacheReadUsdPerMillion: 0.11, cacheWriteUsdPerMillion: 2.2,
});

afterEach(() => { vi.useRealTimers(); });

describe("a long run's later sessions keep the gateway's rates", () => {
  async function pricingAfterRenewal(secondQuote: (now: number) => RateQuoteV1 | undefined, readAt: number): Promise<ReturnType<typeof gatewayModelCost>> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const answers = [
      () => ({ baseUrl: "https://gateway.example", apiKey: "k1", expiresAt: T0 + 900_000, runPrice: runPriceAt(T0 + 300_000), rateQuote: quoteAt(T0, T0 + 300_000) }),
      () => { const now = Date.now(); const quote = secondQuote(now); return { baseUrl: "https://gateway.example", apiKey: "k2", expiresAt: T0 + 900_000, runPrice: runPriceAt(now + 300_000), ...(quote === undefined ? {} : { rateQuote: quote }) }; },
    ];
    let asked = 0;
    const transport = (async () => new Response(JSON.stringify(answers[Math.min(asked++, 1)]!()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const proxy = lazyModelProxy({ baseUrl: "https://gateway.example", source: modelAccessSource({ controlPlaneUrl: "https://broker.example", capability: "cap", fetch: transport, requiredPriceModel: NAME }) });
    expect(gatewayModelCost({ ...await proxy.gatewayPricing(), now: Date.now() })?.basis).toBe("rate_quote");
    vi.setSystemTime(T0 + 301_000); // the first run price expired: the source renews
    await proxy.apiKey.call({ baseUrl: "" });
    expect(asked).toBe(2);
    vi.setSystemTime(readAt);
    const stated = await proxy.gatewayPricing();
    expect(asked).toBe(2); // still the renewed answer
    return gatewayModelCost({ ...stated, now: Date.now() });
  }

  it("a renewal whose quote read failed still prices from the accepted run price, not the catalog row", async () => {
    const found = await pricingAfterRenewal(() => undefined, T0 + 400_000);
    expect(found).toBeDefined();
    expect(found!.cost.input).toBeCloseTo(1.1, 9);
  });

  it("a renewal that carries a cached quote expiring before its run price still prices from the gateway in the gap", async () => {
    // The broker keeps a quote up to 60 s, so the quote it sends can expire up to 60 s before the fresh run price beside it.
    const found = await pricingAfterRenewal((now) => quoteAt(now - 60_000, now + 240_000), T0 + 301_000 + 270_000);
    expect(found).toBeDefined();
    expect(found!.cost.input).toBeCloseTo(1.1, 9);
  });
});

describe("the reviewer-slot quote never reaches the token", () => {
  it("the token is minted before the quote is read, and the mint is never given a quote", async () => {
    vi.resetModules();
    const order: string[] = [];
    const mint = vi.fn<(deps: Record<string, unknown>) => Promise<{ token: string; expiresAt: number; companyId: string; models: string[] }>>(async () => { order.push("mint"); return { token: "t", expiresAt: Date.now() + 120_000, companyId: COMPANY, models: [NAME] }; });
    vi.doMock("../../packages/broker/src/core/model-gateway/token.js", async (importOriginal) => ({ ...await importOriginal<object>(), mintTaskToken: mint }));
    vi.doMock("../../packages/broker/src/core/model-gateway/records.js", async (importOriginal) => ({ ...await importOriginal<object>(), readTaskTokenRecords: vi.fn(async () => ({})) }));
    vi.doMock("../../packages/broker/src/core/model-gateway/cx-a/request-scope.js", () => ({ taskTokenScope: vi.fn(() => ({ operationId: "op-1", workspaceId: "ws-1", fence: 1, reviewerSlot: "r1" })) }));
    const { handleModelAccess } = await import("../../packages/broker/src/core/model-gateway/route.js");
    const quote = quoteAt(Date.now() - 1_000, Date.now() + 300_000);
    const response = await handleModelAccess({ now: () => new Date(), log: () => undefined } as never, {} as never,
      { signer: {} as never, issuer: "i", describer: {} as never, gatewayUrl: "https://gateway.example", rateQuote: async () => { order.push("quote"); return quote; } },
      { method: "GET", path: "/v1/internal/model-access", headers: {} });
    expect(order).toEqual(["mint", "quote"]);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["apiKey"]).toBe("t");
    expect(body["rateQuote"]).toEqual(quote);
    // The mint is handed the gateway deps (incl. the reader FUNCTION), never a quote value; token.ts never reads `rateQuote`.
    const given = mint.mock.calls[0]![0];
    if (given === undefined) throw new Error("the mint was not called with its deps");
    expect(typeof given["rateQuote"] === "function" || given["rateQuote"] === undefined).toBe(true);
  });
});
