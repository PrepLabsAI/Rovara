import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { bedrockRoute, channelRequest, installationEnvironment } from "../support/e2e-model-fixtures.js";

// M1.4 Task 4.10B fix round 1 (review I-1) for Bedrock: a transport failure with no response reaches the invoke as pi-ai's error message (the AWS SDK's text); the stream function is
// replaced by one that ends with that message, and everything after it (classification, the route's receipt) is the real code. A real connect timeout cannot be made on a loopback.
let errorMessage = "";
vi.mock("@earendil-works/pi-ai/api/bedrock-converse-stream", () => ({
  stream: (model: { api: string; provider: string; id: string }) => {
    const events = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", errorMessage, timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    queueMicrotask(() => { events.push({ type: "error", reason: "error", error: message }); events.end(); });
    return events;
  },
}));

beforeEach(() => { cleanRedirectingEnvironment(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Bedrock transport failures with no response", () => {
  const definition = bedrockRoute();
  const run = async (text: string) => {
    errorMessage = text;
    const { createE2EProviderInvoke } = await import("../../packages/model-runtime/src/e2e-provider-invoke.js");
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition) });
    return createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() }).generate(channelRequest());
  };

  it("a connect timeout whose text says both 'timed out' and ETIMEDOUT is unreachable", async () => {
    expect((await run("Connection timed out after 1000 ms: connect ETIMEDOUT 10.0.0.1:443")).receipt.failure).toEqual({ class: "unreachable", signal: "ETIMEDOUT" });
  });
  it("UND_ERR_CONNECT_TIMEOUT in the text is unreachable", async () => {
    expect((await run("Request timed out. Connect Timeout Error UND_ERR_CONNECT_TIMEOUT")).receipt.failure).toEqual({ class: "unreachable", signal: "UND_ERR_CONNECT_TIMEOUT" });
  });
  it("a name resolution failure is unreachable", async () => {
    expect((await run("getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com")).receipt.failure).toEqual({ class: "unreachable", signal: "ENOTFOUND" });
  });
  it("a timeout with no network code is a provider outage with the signal timeout (control)", async () => {
    expect((await run("Request timed out.")).receipt.failure).toEqual({ class: "provider-outage", signal: "timeout" });
  });
});
