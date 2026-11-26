import { afterEach, beforeEach, vi } from "vitest";
export const readyCoreEngine = { modelGatewayUrl: "https://gateway.example", agentModel: "claude-sonnet-4-6" };
export const builtInGatewayHost = "gw12345678.execute-api.us-east-1.amazonaws.com";
export const controlPlaneOrigin = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const brokerTemplate = () => JSON.stringify({ Parameters: { CoreModelGatewayHost: {}, CoreAgentModel: {} }, Outputs: { ModelRunPriceVersion: { Value: "1" } } });
export function installGatewayFixture(): void {
  beforeEach(() => {
    const browserFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.href === `${readyCoreEngine.modelGatewayUrl}/healthz` || url.href === `https://${builtInGatewayHost}/healthz`) {
        return Response.json({ runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } });
      }
      if (url.href === `${controlPlaneOrigin}/v1/auth/.well-known/jwks.json`) {
        return Response.json({ keys: [{ kid: "abcdefghijklmnop", rovara_purpose: "task" }] });
      }
      // Keep real localhost wizard streams and GitHub callbacks. Nothing else may reach a network.
      if (url.protocol === "http:" && url.hostname === "127.0.0.1") return browserFetch(input, init);
      throw new Error(`test setup: unexpected fetch target ${url.origin}${url.pathname}`);
    });
  });
  afterEach(() => vi.unstubAllGlobals());
}
