import { expect, it, vi } from "vitest";
import { previewRateQuoteReader } from "../../packages/broker/src/core-host/start-estimates-rate-read.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { localSigner } from "../support/developer-fakes.js";
const companyId = "org_corehost00000000000a", issuer = "https://api.example/v1/auth", now = Date.parse("2026-11-18T12:00:00.000Z");
const quote = () => ({ state: "available", value: { version: 1, currency: "USD", unit: "micros_per_million_tokens", model: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, source: { kind: "company_key", id: "key-1", name: "Company AI", provider: "anthropic", connectionRevision: "1" }, ref: { authority: "gateway", version: "1", hash: "a".repeat(64), fetchedAt: "2026-11-18T11:00:00.000Z" }, asOf: "2026-11-18T12:00:00.000Z", expiresAt: "2026-11-18T12:05:00.000Z", region: "global", base: { input: 1, output: 2, cacheRead: 1, cacheWrite5m: 2, cacheWrite1h: 3 }, longContext: [], derived: [] } });
it("reads only the approved company/model rate route using a 60-second service token with E's audience", async () => {
 const fetcher = vi.fn(async () => new Response(JSON.stringify(quote())));
 const reader = previewRateQuoteReader({ gatewayUrl: "https://gateway.example", issuer, signer: taskKeySigner(localSigner()), now: () => now, fetch: fetcher });
 const result = await reader(companyId, "claude-sonnet-4-6");
 expect(result?.source.connectionRevision).toBe("1");
 const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
 expect(url).toBe("https://gateway.example/v1/service/companies/org_corehost00000000000a/rate-quote?model=claude-sonnet-4-6");
 expect(init.method).toBe("GET");expect(init.body).toBeUndefined();expect(init.redirect).toBe("error");
 const token = (init.headers as Record<string,string>).authorization!.slice(7), parts = token.split(".");
 const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as Record<string,unknown>;
 const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string,unknown>;
 expect(header.typ).toBe("rovara-service+jwt");
 expect(claims).toMatchObject({ iss: issuer, cid: companyId, aud: "rovara-model-gateway-rate-quote", iat: now / 1000, exp: now / 1000 + 60 });
});
it("rejects invalid company/model before signing and fails unavailable on stale, malformed and oversized rate reads", async () => {
 const signer = taskKeySigner(localSigner()), sign = vi.spyOn(signer, "sign");
 const fetcher = vi.fn(async () => new Response(JSON.stringify(quote())));
 const reader = previewRateQuoteReader({ gatewayUrl: "https://gateway.example", issuer, signer, now: () => now, fetch: fetcher, timeoutMs: 20 });
 expect(await reader("other", "claude-sonnet-4-6")).toBeUndefined();expect(await reader(companyId, "bad?model")).toBeUndefined();expect(sign).not.toHaveBeenCalled();
 for (const body of [{ ...quote(), value: { ...quote().value, currency: "EUR" } }, { ...quote(), value: { ...quote().value, expiresAt: "2026-11-18T11:59:00.000Z" } }, { ...quote(), value: { ...quote().value, base: { ...quote().value.base, input: -1 } } }, "x".repeat(70_000)]) {
  fetcher.mockImplementationOnce(async () => new Response(JSON.stringify(body)));
  expect(await reader(companyId, "claude-sonnet-4-6")).toBeUndefined();
 }
});
