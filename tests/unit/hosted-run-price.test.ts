import { describe, expect, it, vi } from "vitest";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";
import { invocationModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { assertGatewayRunPrices } from "../../packages/cli/src/deploy/gateway-price-preflight.js";
const route = { alias: "company-alias", catalog: "zai.glm-5", api: "anthropic-messages" } as const;
const price = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", model: route.alias, provider: "bedrock", sourceId: "operator-ai", connectionRevision: "r1", catalogModel: "zai.glm-5", snapshotHash: "a".repeat(64), snapshotVersion: 7, inputUsdPerMillion: 10,
  outputUsdPerMillion: 40, cacheWriteUsdPerMillion: 30, cacheReadUsdPerMillion: 2, expiresAt: Date.now() + 300_000 };
const answer = (runPrice: unknown) => ({ baseUrl: "https://gateway.example", apiKey: "fixture-key", expiresAt: Date.now() + 900_000, runPrice });
function proxy(runPrice: unknown, fetcher?: typeof fetch) {
  return operationModelProxy({ payload: { modelRoute: route, workflowMode: "WIKI_BUILD" }, controlPlaneUrl: "https://broker.example", capability: "fixture", proxyUrl: undefined,
    fetch: fetcher ?? (async () => Response.json(answer(runPrice))) })!;
}
describe("hosted run price authority", () => {
  it("gets the governor's bounds through the exact access source used by the adapter, above catalog rates", async () => {
    const read = vi.fn(async () => Response.json(answer(price)));
    const selected = proxy(price, read);
    expect(await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, selected)).toEqual({ inputPerMTok: 30, outputPerMTok: 40 });
    const request = { ...selected };
    expect(await (request.apiKey as () => Promise<string>).call(request)).toBe("fixture-key");
    expect(request.baseUrl).toBe("https://gateway.example");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, { ...price, model: "wrong" }, { ...price, inputUsdPerMillion: 0 }, { ...price, outputUsdPerMillion: Infinity },
    { ...price, cacheWriteUsdPerMillion: -1 }, { ...price, cacheReadUsdPerMillion: NaN }, { ...price, snapshotVersion: 0 }, { ...price, expiresAt: 1 }])("refuses absent or invalid authority before a model session", async (bad) => {
    await expect(invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, proxy(bad))).rejects.toThrow("model's price");
  });
  it("retains laptop catalog lookup", async () => {
    expect(await invocationModelPrice({ provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" })).toEqual({ inputPerMTok: 11, outputPerMTok: 55 });
  });
});
describe("gateway-first installation", () => {
  it.each([{}, { runPrice: { version: 1, snapshotVersion: 7 } }, { runPrice: { version: 1, snapshotVersion: 0 } }, { runPrice: { version: 2, snapshotVersion: 7 } }])("blocks old, empty or incompatible gateway readiness", async (body) => {
    await expect(assertGatewayRunPrices("https://gateway.example", async () => Response.json(body))).rejects.toThrow("gateway must serve run prices");
  });
  it("accepts a gateway serving a versioned price snapshot", async () => {
    const read = vi.fn(async () => Response.json({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } }));
    await assertGatewayRunPrices("https://gateway.example", read);
    expect(read.mock.calls).toHaveLength(1);
  });
});

describe("signed gateway price read", () => {
  it("signs the authenticated company and rejects mismatched company/model/expiry before forwarding", async () => {
    const { runPriceReader } = await import("../../packages/broker/src/core-host/run-price-http.js");
    const { signingWorld } = await import("../support/model-gateway.js");
    const signed = signingWorld();
    for (const change of [{}, { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { model: "foreign" }, { expiresAt: 1 }, { cacheReadUsdPerMillion: -1 }]) {
      const asked: string[] = [];
      const read = runPriceReader({ gatewayUrl: "https://gateway.example", issuer: "https://install.example/v1/auth", signer: signed.signer,
        fetch: async (url, init) => {
          asked.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
          const token = new Headers(init?.headers).get("authorization")!.slice(7);
          const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { cid: string; aud: string };
          expect(claims).toMatchObject({ cid: price.companyId, aud: "rovara-model-gateway-rate-quote" });
          return Response.json({ runPrice: { ...price, ...change } });
        } });
      const answer = await read(price.companyId, route.alias);
      expect(answer).toEqual(Object.keys(change).length === 0 ? price : undefined);
      expect(asked).toEqual([`https://gateway.example/v1/service/companies/${price.companyId}/rate-quote?model=${route.alias}&runPrice=1`]);
    }
  });
});


it.each(["SETUP_AGENT", "WIKI_BUILD"])("preserves local routed %s catalog pricing and HTTP access only with trusted local context", async workflowMode => {
  const fetcher = async () => Response.json({ baseUrl: "http://broker-relay:3000", apiKey: "local-fixture", expiresAt: Date.now() + 900_000 });
  const input = { payload: { workflowMode, modelRoute: route }, proxyUrl: "http://boot-relay:3000", controlPlaneUrl: "http://broker-relay:3000", capability: "fixture", fetch: fetcher };
  const local = operationModelProxy({ ...input, environment: { AGENTX_ENVIRONMENT_KIND: "local" } })!;
  expect(await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, local)).toMatchObject({ inputPerMTok: 1, outputPerMTok: 3.2 });
  expect(await (local.apiKey as () => Promise<string>).call(local)).toBe("local-fixture");
  expect(local.baseUrl).toBe("http://broker-relay:3000");
  const hosted = operationModelProxy({ ...input, environment: { AGENTX_ENVIRONMENT_KIND: "named", AGENTX_RUNTIME: "ec2" } })!;
  await expect(invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, hosted)).rejects.toThrow("proxy address");
});
