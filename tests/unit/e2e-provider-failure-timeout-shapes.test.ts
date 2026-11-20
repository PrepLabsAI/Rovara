import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2EModelRouteDefinition } from "../../packages/contracts/src/e2e-model-channel.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2EProviderInvoke } from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { PROVIDER_KEY, SECRET_ARN, channelRequest, installationEnvironment, keyedRoute } from "../support/e2e-model-fixtures.js";
import { fakeFetch } from "../support/e2e-provider-fakes.js";

// M1.4 Task 4.10B fix round 1 (review I-1, M-4): the SDKs rewrite a connect timeout into "Request timed out.", and the invoke must still say unreachable when a network code was captured.
// Test 18 made realistic: undici-shaped transport errors go through each keyed SDK as they do in production.
beforeEach(() => { cleanRedirectingEnvironment(); });
afterEach(() => { vi.unstubAllEnvs(); });

const readSecret = async (arn: string) => (arn === SECRET_ARN ? PROVIDER_KEY : undefined);
const viaRoute = (invoke: Parameters<typeof createGovernedE2EModelRoute>[1]["invoke"], definition: E2EModelRouteDefinition) =>
  createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() }).generate(channelRequest());

/** What undici throws from `fetch` when the connection cannot be made, as the SDKs see it: a TypeError("fetch failed") whose cause is the real error. */
const undiciConnectTimeout = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error (attempted address: api.example.com:443, timeout: 10000ms)"), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" }) });
const systemEtimedout = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT", errno: -60, syscall: "connect" }) });
const noCodeTimeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

describe.each(["anthropic", "openai", "openrouter"] as const)("keyed SDK rewrite of a transport timeout: %s", (provider) => {
  const definition = keyedRoute(provider);
  const run = async (thrown: () => unknown) => {
    const fake = fakeFetch(() => { throw thrown(); });
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fake.fetch });
    return viaRoute(invoke, definition);
  };

  it("a connect timeout (UND_ERR_CONNECT_TIMEOUT) is unreachable, not an outage", async () => {
    expect((await run(undiciConnectTimeout)).receipt.failure).toEqual({ class: "unreachable", signal: "UND_ERR_CONNECT_TIMEOUT" });
  });

  it("a system connect timeout (ETIMEDOUT) is unreachable, not an outage", async () => {
    expect((await run(systemEtimedout)).receipt.failure).toEqual({ class: "unreachable", signal: "ETIMEDOUT" });
  });

  it("a timeout with no network code is still a provider outage with the signal timeout (control)", async () => {
    expect((await run(noCodeTimeout)).receipt.failure).toEqual({ class: "provider-outage", signal: "timeout" });
  });
});

