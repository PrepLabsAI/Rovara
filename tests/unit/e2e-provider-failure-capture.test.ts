import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2EModelRouteDefinition } from "../../packages/contracts/src/e2e-model-channel.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2EProviderInvoke } from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { createE2EProviderInvokeForTesting } from "../../packages/model-runtime/src/e2e-provider-invoke-testing.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { PROVIDER_KEY, SECRET_ARN, bedrockRoute, channelRequest, installationEnvironment, keyedRoute } from "../support/e2e-model-fixtures.js";
import { bedrockLoopback, fakeFetch, jsonError, type BedrockLoopback } from "../support/e2e-provider-fakes.js";

// M1.4 Task 4.10B, tests 17-19 and the route's use of them: the failure class is captured where the provider's answer is, carried on the receipt, and never carries message text.
beforeEach(() => { cleanRedirectingEnvironment(); });
afterEach(() => { vi.unstubAllEnvs(); });

const readSecret = async (arn: string) => (arn === SECRET_ARN ? PROVIDER_KEY : undefined);
const viaRoute = (invoke: E2EInvoke, definition: E2EModelRouteDefinition, options: Parameters<ReturnType<typeof createGovernedE2EModelRoute>["generate"]>[1] = {}) =>
  createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() }).generate(channelRequest(), options);

describe("17. Bedrock: the error type header becomes the receipt's failure", () => {
  let loopback: BedrockLoopback | undefined;
  afterEach(async () => { await loopback?.close(); loopback = undefined; });
  const definition = bedrockRoute();
  const bedrock = async (respond: Parameters<typeof bedrockLoopback>[0]) => {
    loopback = await bedrockLoopback(respond);
    return createE2EProviderInvokeForTesting(definition, { environment: installationEnvironment(definition) }, { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } });
  };
  const answer = (status: number, errorType?: string) => () => ({ status, body: JSON.stringify({ message: "Too many requests with the prompt echoed: hunter2-echo" }), ...(errorType === undefined ? {} : { errorType }) });

  it("the TEST incident: a 429 with the coral-suffixed ThrottlingException is limit-or-rate-limited, after exactly one request", async () => {
    const invoke = await bedrock(answer(429, "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/"));
    const { result, receipt } = await viaRoute(invoke, definition);
    expect(result).toMatchObject({ status: "error", code: "provider-error" });
    expect(receipt.outcome).toBe("provider-error");
    expect(receipt.failure).toEqual({ class: "limit-or-rate-limited", signal: "ThrottlingException" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(loopback!.requests).toHaveLength(1);
    expect(JSON.stringify({ result, receipt })).not.toContain("hunter2-echo");
  });

  it("other error types: validation, access, not found and an outage", async () => {
    const cases: Array<[number, string, string, string]> = [
      [400, "ValidationException", "request-rejected", "ValidationException"],
      [403, "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.bedrock/", "key-rejected", "AccessDeniedException"],
      [404, "ResourceNotFoundException", "model-not-found", "ResourceNotFoundException"],
      [503, "ServiceUnavailableException", "provider-outage", "ServiceUnavailableException"],
      [429, "ModelNotReadyException", "provider-outage", "ModelNotReadyException"],
    ];
    for (const [status, header, failureClass, signal] of cases) {
      const invoke = await bedrock(answer(status, header));
      const { receipt } = await viaRoute(invoke, definition);
      expect(receipt.failure, header).toEqual({ class: failureClass, signal });
      await loopback!.close();
    }
  });

  it("a header outside the allow-list pattern gives no signal, and the status decides", async () => {
    for (const header of ["Throttling Exception with the prompt hunter2-echo", "Throttling-Exception", "x".repeat(80), "1234"]) {
      const invoke = await bedrock(answer(429, header));
      const { receipt } = await viaRoute(invoke, definition);
      expect(receipt.failure, header).toEqual({ class: "limit-or-rate-limited", signal: null });
      await loopback!.close();
    }
  });

  it("no header at all: the status decides and there is no signal", async () => {
    const invoke = await bedrock(answer(500));
    const { receipt } = await viaRoute(invoke, definition);
    expect(receipt.failure).toEqual({ class: "provider-outage", signal: null });
  });

  it("no endpoint to talk to is unreachable, with the network code as the signal", async () => {
    const closed = await bedrockLoopback(() => ({ status: 200, body: "" }));
    const endpoint = closed.endpoint;
    await closed.close();
    const invoke = await createE2EProviderInvokeForTesting(definition, { environment: installationEnvironment(definition) }, { bedrockEndpoint: endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } });
    const { receipt } = await viaRoute(invoke, definition);
    expect(receipt.outcome).toBe("provider-error");
    expect(receipt.failure).toEqual({ class: "unreachable", signal: "ECONNREFUSED" });
  }, 30_000);
});

describe("18. a keyed provider: only the error's type or code is kept, never its message", () => {
  const anthropic = keyedRoute("anthropic");
  const make = async (definition: E2EModelRouteDefinition, handler: Parameters<typeof fakeFetch>[0], extra: { readSecret?: typeof readSecret } = {}) => {
    const fake = fakeFetch(handler);
    return { invoke: await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fake.fetch, ...extra }), ...fake };
  };

  it("a 401 whose body carries a key gives authentication_error, and nothing of the body is kept", async () => {
    let clones = 0;
    const body = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-SECRETVALUE and the prompt echoed" } };
    const counted = () => {
      const response = new Response(JSON.stringify(body), { status: 401, headers: { "content-type": "application/json" } });
      const clone = response.clone.bind(response);
      Object.defineProperty(response, "clone", { value: () => { clones += 1; return clone(); } });
      return response;
    };
    const { invoke, requests } = await make(anthropic, counted);
    const outcome = await viaRoute(invoke, anthropic);
    expect(requests).toHaveLength(1);
    expect(outcome.receipt.outcome).toBe("provider-error");
    expect(outcome.receipt.failure).toEqual({ class: "key-rejected", signal: "authentication_error" });
    // The positive control: the body really was read, once, so the absence below is not an untested path.
    expect(clones).toBe(1);
    const serialized = JSON.stringify(outcome);
    for (const secret of ["SECRETVALUE", "x-api-key", "sk-ant", "prompt echoed", "invalid x-api"]) expect(serialized).not.toContain(secret);
    const direct = await invoke({ target: { provider: "anthropic", identifier: anthropic.modelId, region: null }, call: channelRequest().call, maxOutputTokens: 1024, sampling: "provider-default", thinking: "off", effort: "low", signal: new AbortController().signal })
      .then(() => undefined, (error: unknown) => error as Error);
    expect(JSON.stringify({ ...direct, message: direct?.message })).not.toContain("SECRETVALUE");
  });

  it("OpenAI: the error code, else the type; OpenRouter: the numeric code", async () => {
    const openai = keyedRoute("openai");
    const first = await make(openai, () => jsonError(401, { error: { message: "Incorrect API key provided: sk-proj-SECRETVALUE", type: "invalid_request_error", code: "invalid_api_key" } }));
    expect((await viaRoute(first.invoke, openai)).receipt.failure).toEqual({ class: "key-rejected", signal: "invalid_api_key" });
    const second = await make(openai, () => jsonError(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: null } }));
    expect((await viaRoute(second.invoke, openai)).receipt.failure).toEqual({ class: "limit-or-rate-limited", signal: "insufficient_quota" });
    const openrouter = keyedRoute("openrouter");
    const third = await make(openrouter, () => jsonError(402, { error: { code: 402, message: "Insufficient credits for sk-or-SECRETVALUE" } }));
    const outcome = await viaRoute(third.invoke, openrouter);
    expect(outcome.receipt.failure).toEqual({ class: "limit-or-rate-limited", signal: "402" });
    expect(JSON.stringify(outcome)).not.toContain("SECRETVALUE");
  });

  it("the class of each provider's 404, 400 and 5xx", async () => {
    const cases: Array<[number, string, string | null]> = [[404, "model-not-found", "not_found_error"], [400, "request-rejected", "invalid_request_error"], [529, "provider-outage", "overloaded_error"], [429, "limit-or-rate-limited", "rate_limit_error"]];
    for (const [status, failureClass, type] of cases) {
      const { invoke } = await make(anthropic, () => jsonError(status, { type: "error", error: { type, message: "x" } }));
      expect((await viaRoute(invoke, anthropic)).receipt.failure, String(status)).toEqual({ class: failureClass, signal: type });
    }
  });

  it("an unreadable body, or a type outside the pattern, gives no signal and the status decides", async () => {
    for (const body of ["<html>bad gateway</html>", JSON.stringify({ error: { type: "Authentication Error with sk-ant-SECRETVALUE" } }), JSON.stringify({ error: "just a string" }), "x".repeat(20_000)]) {
      const { invoke } = await make(anthropic, () => new Response(body, { status: 401 }));
      const outcome = await viaRoute(invoke, anthropic);
      expect(outcome.receipt.failure, body.slice(0, 20)).toEqual({ class: "key-rejected", signal: null });
      expect(JSON.stringify(outcome)).not.toContain("SECRETVALUE");
    }
  });

  it("an unknown status is the unknown class, still with the receipt", async () => {
    const { invoke } = await make(anthropic, () => jsonError(418, { error: { type: "teapot_error" } }));
    expect((await viaRoute(invoke, anthropic)).receipt.failure).toEqual({ class: "unknown", signal: "teapot_error" });
  });

  it("a dropped connection is unreachable with the network code; a name resolution failure too", async () => {
    for (const code of ["ECONNRESET", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]) {
      const { invoke } = await make(anthropic, () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo with a hostname"), { code }) }); });
      expect((await viaRoute(invoke, anthropic)).receipt.failure, code).toEqual({ class: "unreachable", signal: code });
    }
  });

  it("a network failure with a code outside the allow-list is not classified, and keeps no code", async () => {
    const { invoke } = await make(anthropic, () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "SOMETHING_ODD" }) }); });
    expect((await viaRoute(invoke, anthropic)).receipt.failure).toEqual({ class: "unknown", signal: null });
  });
});

describe("failures before any request goes out", () => {
  it("an unreadable key secret is secret-unreadable with the fixed signal secret-unreadable, and nothing is sent", async () => {
    const definition = keyedRoute("anthropic");
    const fake = fakeFetch(() => jsonError(500));
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret: async () => undefined, fetch: fake.fetch });
    const { receipt } = await viaRoute(invoke, definition);
    expect(receipt).toMatchObject({ outcome: "provider-error", inputTokens: 0, failure: { class: "secret-unreadable", signal: "secret-unreadable" } });
    expect(fake.requests).toHaveLength(0);
  });

  it("a secret read that throws is also secret-unreadable, and the error's text is not kept", async () => {
    const definition = keyedRoute("openai");
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret: async () => { throw new Error("AccessDeniedException: not authorized for arn:aws:secretsmanager hunter2-echo"); } });
    const outcome = await viaRoute(invoke, definition);
    expect(outcome.receipt.failure).toEqual({ class: "secret-unreadable", signal: "secret-unreadable" });
    expect(JSON.stringify(outcome)).not.toContain("hunter2-echo");
  });

  it("a keyed model the pinned catalog lacks is not-in-catalog with the signal not-in-catalog", async () => {
    const definition = keyedRoute("anthropic", { modelId: "claude-no-such-model-9" });
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret });
    const { receipt } = await viaRoute(invoke, definition);
    expect(receipt.failure).toEqual({ class: "not-in-catalog", signal: "not-in-catalog" });
  });

  it("a Bedrock model the pinned catalog lacks is not-in-catalog with the signal not-in-catalog", async () => {
    const definition = bedrockRoute({ modelId: "us.anthropic.claude-no-such-model-9" });
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition) });
    const { receipt } = await viaRoute(invoke, definition);
    expect(receipt.failure).toEqual({ class: "not-in-catalog", signal: "not-in-catalog" });
  });

  it("another refusal before sending (an environment that could redirect) carries no failure at all", async () => {
    const definition = bedrockRoute();
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "http://127.0.0.1:9");
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition) });
    const { receipt } = await viaRoute(invoke, definition);
    expect(receipt.outcome).toBe("provider-error");
    expect(receipt.failure).toBeUndefined();
    expect("failure" in receipt).toBe(false);
  });
});

describe("the route's own use of a failure", () => {
  const definition = bedrockRoute();
  const throwing = (error: unknown): E2EInvoke => async () => { throw error; };

  it("a call that hit its time limit is a timeout receipt with the class provider-outage and the signal timeout", async () => {
    const hanging: E2EInvoke = (input) => new Promise((_resolve, reject) => { input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    const { receipt, result } = await viaRoute(hanging, definition, { budgets: { callTimeoutMs: 30 } });
    expect(result).toMatchObject({ status: "error", code: "timeout" });
    expect(receipt).toMatchObject({ outcome: "timeout", failure: { class: "provider-outage", signal: "timeout" } });
  });

  it("an error that carries no failure (an older invoke) leaves the receipt exactly as before", async () => {
    const { receipt } = await viaRoute(throwing(Object.assign(new Error("boom"), { status: 500 })), definition);
    expect(receipt.outcome).toBe("provider-error");
    expect("failure" in receipt).toBe(false);
  });

  it("a failure that is not a valid one (a free-text signal, an unknown class) is dropped, never copied", async () => {
    for (const failure of [{ class: "limit-or-rate-limited", signal: "the model said: hello sk-ant-SECRETVALUE" }, { class: "made-up", signal: null }, "text", { class: "unknown", signal: null, note: "x" }]) {
      const { receipt } = await viaRoute(throwing(Object.assign(new Error("boom"), { failure })), definition);
      expect("failure" in receipt, JSON.stringify(failure)).toBe(false);
    }
  });

  it("a valid failure on the error becomes the receipt's failure", async () => {
    const { receipt } = await viaRoute(throwing(Object.assign(new Error("boom"), { failure: { class: "model-not-found", signal: "ResourceNotFoundException" } })), definition);
    expect(receipt.failure).toEqual({ class: "model-not-found", signal: "ResourceNotFoundException" });
  });

  it("the channel's answer keeps its fixed message: the signal is not repeated in it", async () => {
    const { result } = await viaRoute(throwing(Object.assign(new Error("boom"), { name: "ThrottlingException", status: 429, failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" } })), definition);
    expect(result).toEqual({ status: "error", code: "provider-error", message: "provider call failed (ThrottlingException, HTTP 429)" });
  });
});
