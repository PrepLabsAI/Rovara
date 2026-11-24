// Task cost truth (money, stage 1): the broker's model-access answer carries the gateway's rate quote beside the run price, for PRICING only (never in the signed token), and ALSO to a reviewer key slot, which
// gets no run price. A quote that cannot be read is no quote: the answer is the one it always was. And the broker's quote reader: the same gateway route the run price comes from, cached, never raising.
import { describe, expect, it, vi } from "vitest";
import { RateQuoteV1Schema, type RateQuoteV1 } from "../../packages/contracts/src/index.js";

vi.mock("../../packages/broker/src/core/model-gateway/token.js", async (importOriginal) => ({ ...await importOriginal<object>(), mintTaskToken: vi.fn() }));
vi.mock("../../packages/broker/src/core/model-gateway/records.js", async (importOriginal) => ({ ...await importOriginal<object>(), readTaskTokenRecords: vi.fn(async () => ({})) }));
vi.mock("../../packages/broker/src/core/model-gateway/cx-a/request-scope.js", () => ({ taskTokenScope: vi.fn(() => ({ operationId: "op-1", workspaceId: "ws-1", fence: 1 })) }));

const { handleModelAccess } = await import("../../packages/broker/src/core/model-gateway/route.js");
const { mintTaskToken } = await import("../../packages/broker/src/core/model-gateway/token.js");
const { gatewayRateQuoteReader } = await import("../../packages/broker/src/core-host/gateway-quote-http.js");
const { signingWorld } = await import("../support/model-gateway.js");

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const at = new Date(Date.now() - 60_000).toISOString();
const quote: RateQuoteV1 = RateQuoteV1Schema.parse({
  version: 1, currency: "USD", unit: "micros_per_million_tokens", ref: { authority: "gateway", version: "10", hash: "a".repeat(64), fetchedAt: at },
  source: { kind: "rovara_ai", id: "s", name: "s", provider: "bedrock", connectionRevision: "r" }, model: { provider: "bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, region: "us-west-2",
  asOf: at, expiresAt: new Date(Date.now() + 300_000).toISOString(), base: { input: 1_100_000, output: 5_500_000, cacheRead: 110_000, cacheWrite5m: 1_375_000, cacheWrite1h: 2_200_000 }, longContext: [], derived: [],
});
const flow = { now: () => new Date(), log: () => undefined } as never;
const capabilities = {} as never;
const request = { method: "GET", path: "/v1/internal/model-access", headers: {} } as never;

async function answer(models: string[], gateway: { rateQuote?: (company: string, model: string) => Promise<RateQuoteV1 | undefined> }, runPrice?: object): Promise<Record<string, unknown>> {
  vi.mocked(mintTaskToken).mockResolvedValue({ token: "t", expiresAt: Date.now() + 900_000, companyId: COMPANY, models, ...(runPrice === undefined ? {} : { runPrice }) } as never);
  const response = await handleModelAccess(flow, capabilities, { signer: {} as never, issuer: "i", describer: {} as never, gatewayUrl: "https://gateway.example", ...gateway }, request);
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("the model-access answer", () => {
  it("carries the quote of the one model the token allows, beside nothing in the token (a reviewer key slot has no run price)", async () => {
    const asked: string[][] = [];
    const body = await answer(["claude-haiku-4-5"], { rateQuote: async (company, model) => { asked.push([company, model]); return quote; } });
    expect(asked).toEqual([[COMPANY, "claude-haiku-4-5"]]);
    expect(body["rateQuote"]).toEqual(quote);
    expect(body["runPrice"]).toBeUndefined();
  });

  it("is the answer it always was when the quote cannot be read, fails, or the token names several models", async () => {
    expect((await answer(["claude-haiku-4-5"], { rateQuote: async () => undefined }))["rateQuote"]).toBeUndefined();
    expect((await answer(["claude-haiku-4-5"], { rateQuote: async () => { throw new Error("down"); } }))["rateQuote"]).toBeUndefined();
    expect((await answer(["a", "b"], { rateQuote: async () => quote }))["rateQuote"]).toBeUndefined();
    expect((await answer(["claude-haiku-4-5"], {}))["rateQuote"]).toBeUndefined();
  });
});

describe("the broker's quote reader", () => {
  const signing = { signer: { publicJwk: async () => { throw new Error("no key"); } } as never, issuer: "https://code.example/v1/auth" };
  it("answers nothing, and never throws, without a signing key or for a malformed company or model", async () => {
    const read = gatewayRateQuoteReader({ gatewayUrl: "https://gateway.example", signing: () => signing });
    expect(await read(COMPANY, "claude-haiku-4-5").catch(() => "threw")).toBeUndefined();
    expect(await read("not-a-company", "claude-haiku-4-5")).toBeUndefined();
    expect(await read(COMPANY, "bad model!")).toBeUndefined();
    expect(await gatewayRateQuoteReader({ gatewayUrl: "https://gateway.example", signing: () => undefined })(COMPANY, "claude-haiku-4-5")).toBeUndefined();
  });
});

describe("the broker's quote reader against a gateway", () => {
  it("reads the quote from the rate-quote route with the service token, keeps it for the next read, and answers nothing for a stale, unreadable or refused answer", async () => {
    const world = signingWorld();
    const urls: string[] = [];
    let answer: () => Response = () => Response.json({ state: "available", value: quote });
    const read = gatewayRateQuoteReader({ gatewayUrl: "https://gateway.example", signing: () => ({ signer: world.signer, issuer: "https://install.example/v1/auth" }), fetch: (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>)["authorization"]).toMatch(/^Bearer /u);
      return answer();
    }) as never });
    expect(await read(COMPANY, "claude-haiku-4-5")).toEqual(quote);
    expect(await read(COMPANY, "claude-haiku-4-5")).toEqual(quote);
    expect(urls).toEqual([`https://gateway.example/v1/service/companies/${COMPANY}/rate-quote?model=claude-haiku-4-5`]);
    answer = () => Response.json({ state: "unavailable", reason: "missing_price" });
    expect(await read(COMPANY, "claude-sonnet-4-5")).toBeUndefined();
    answer = () => Response.json({ state: "available", value: { ...quote, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    expect(await read(COMPANY, "claude-opus-4-5")).toBeUndefined();
    answer = () => new Response("nope", { status: 401 });
    expect(await read(COMPANY, "claude-fable-5-2")).toBeUndefined();
    answer = () => Response.json({ state: "available", value: { ...quote, base: { ...quote.base, input: -1 } } });
    expect(await read(COMPANY, "claude-haiku-5-5")).toBeUndefined();
  });
});
