import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2EModelRouteDefinition } from "../../packages/contracts/src/e2e-model-channel.js";
import { MissingProviderSecret } from "../../packages/model-runtime/src/config.js";
import { E2EPayloadRefusedError, createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvokeInput } from "../../packages/model-runtime/src/e2e-route.js";
import * as modelRuntime from "../../packages/model-runtime/src/index.js";
import { createE2EProviderInvoke } from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { createE2EProviderInvokeForTesting } from "../../packages/model-runtime/src/e2e-provider-invoke-testing.js";
import * as invokeModule from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { PROVIDER_KEY, SECRET_ARN, TOOLS, bedrockRoute, call, channelRequest, installationEnvironment, keyedRoute } from "../support/e2e-model-fixtures.js";
import {
  anthropicSse, bedrockLoopback, bedrockStartOnly, bedrockStreamBody, brokenSse, fakeFetch, jsonError, openaiResponsesSse, openrouterSse,
  type BedrockLoopback, type RecordedRequest,
} from "../support/e2e-provider-fakes.js";

beforeEach(() => { cleanRedirectingEnvironment(); });
afterEach(() => { vi.unstubAllEnvs(); });

const readSecret = async (arn: string) => (arn === SECRET_ARN ? PROVIDER_KEY : undefined);
const TAP = { id: "call_tap_1", name: "tap", input: { target: "n1" } };
const signal = () => new AbortController().signal;
interface ToolConfig { toolChoice: unknown; tools: Array<{ toolSpec: { name: string } }> }
const toolConfigOf = (body: Record<string, unknown>) => body["toolConfig"] as ToolConfig;

function input(definition: E2EModelRouteDefinition, overrides: Partial<E2EInvokeInput> = {}): E2EInvokeInput {
  return {
    target: { provider: definition.provider, identifier: definition.inferenceProfileArn ?? definition.modelId, region: definition.region },
    call: call(), maxOutputTokens: 1024, sampling: "provider-default", thinking: "off", effort: definition.effort, signal: signal(), ...overrides,
  };
}

const forbiddenSampling = ["temperature", "top_p", "top_k", "topP", "topK"];
const hasNoSampling = (body: Record<string, unknown>) => forbiddenSampling.every((key) => !(key in body));

const keyedCases = [
  {
    provider: "anthropic" as const, toolCallId: "call_tap_1", response: (model: string) => anthropicSse({ model, tool: TAP }), served: "claude-haiku-5-5-20261001",
    toolsOf: (body: RecordedRequest["body"]) => (body["tools"] as Array<{ name: string }>).map((tool) => tool.name),
    choiceOf: (body: RecordedRequest["body"]) => body["tool_choice"] as unknown, keyHeader: (headers: Record<string, string>) => headers["x-api-key"],
    required: { type: "any" }, auto: { type: "auto" }, named: { type: "tool", name: "complete_step" },
  },
  {
    provider: "openai" as const, toolCallId: "call_tap_1.fc_1", response: (model: string) => openaiResponsesSse({ model, tool: TAP }), served: "gpt-5.4-mini-2026-09-01",
    toolsOf: (body: RecordedRequest["body"]) => (body["tools"] as Array<{ name: string }>).map((tool) => tool.name),
    choiceOf: (body: RecordedRequest["body"]) => body["tool_choice"] as unknown, keyHeader: (headers: Record<string, string>) => headers["authorization"]?.replace(/^Bearer /, ""),
    required: "required", auto: "auto", named: { type: "function", name: "complete_step" },
  },
  {
    provider: "openrouter" as const, toolCallId: "call_tap_1", response: (model: string) => openrouterSse({ model, tool: TAP, upstream: "Anthropic" }), served: "anthropic/claude-haiku-5.5",
    toolsOf: (body: RecordedRequest["body"]) => (body["tools"] as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
    choiceOf: (body: RecordedRequest["body"]) => body["tool_choice"] as unknown, keyHeader: (headers: Record<string, string>) => headers["authorization"]?.replace(/^Bearer /, ""),
    required: "required", auto: "auto", named: { type: "function", function: { name: "complete_step" } },
  },
];

describe.each(keyedCases)("e2e provider invoke through pi-ai: $provider", (spec) => {
  const definition = keyedRoute(spec.provider);
  const pinned = definition.modelId;
  const make = async (handler: Parameters<typeof fakeFetch>[0], extra: Partial<Parameters<typeof createE2EProviderInvoke>[1]> = {}) => {
    const fake = fakeFetch(handler);
    return { invoke: await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fake.fetch, ...extra }), ...fake };
  };

  it("round-trips a tool call, with the key only in the auth header and the pinned model in the payload", async () => {
    const { invoke, requests } = await make(() => spec.response(spec.served));
    const output = await invoke(input(definition));
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(spec.keyHeader(request.headers)).toBe(PROVIDER_KEY);
    expect(request.bodyText).not.toContain(PROVIDER_KEY);
    expect(request.body["model"]).toBe(pinned);
    expect(spec.toolsOf(request.body).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    expect(output).toMatchObject({
      servedModelId: spec.served,
      content: [{ type: "tool-call", toolCallId: spec.toolCallId, toolName: "tap", input: JSON.stringify({ target: "n1" }) }],
      finishReason: { unified: "tool-calls" }, usage: { inputTokens: 900, outputTokens: 40 },
    });
    expect(output.providerPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    if (spec.provider === "openrouter") expect(output.servedUpstream).toBe("Anthropic");
  });

  it("sends no sampling parameter, the route's output cap, and no cache or retry settings", async () => {
    const { invoke, requests } = await make(() => spec.response(pinned));
    await invoke(input(definition, { maxOutputTokens: 300 }));
    const body = requests[0]!.body;
    expect(hasNoSampling(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(JSON.stringify(body)).not.toContain("prompt_cache");
    const cap = (body["max_tokens"] ?? body["max_output_tokens"] ?? body["max_completion_tokens"]) as number;
    expect(cap).toBe(300);
    expect(body["stream"]).toBe(true);
  });

  it("maps the channel's tool choices to the provider's", async () => {
    const { invoke, requests } = await make(() => spec.response(pinned));
    await invoke(input(definition, { call: { ...call(), toolChoice: { type: "required" } } }));
    await invoke(input(definition, { call: { ...call(), toolChoice: { type: "auto" } } }));
    await invoke(input(definition, { call: { ...call(), toolChoice: { type: "tool", toolName: "complete_step" } } }));
    expect(requests.map((request) => spec.choiceOf(request.body))).toEqual([spec.required, spec.auto, spec.named]);
  });

  it("carries the earlier turns: the assistant's tool call and the tool result", async () => {
    const { invoke, requests } = await make(() => spec.response(pinned));
    await invoke(input(definition, { call: call("#n2 textbox", { typed: "orders.csv", toolResult: "Typed." }) }));
    const text = requests[0]!.bodyText;
    expect(text).toContain("call_1");
    expect(text).toContain("orders.csv");
    expect(text).toContain("Typed.");
  });

  it("makes exactly one request when the provider answers 429, and the error carries only the status", async () => {
    const { invoke, requests } = await make(() => jsonError(429));
    const failure = await invoke(input(definition)).then(() => undefined, (error: unknown) => error as Error & { status?: number });
    expect(requests).toHaveLength(1);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.status).toBe(429);
    expect(String(failure!.message)).not.toContain("hunter2-echo");
  });

  it("makes exactly one request on a 500, and on a dropped connection", async () => {
    const down = await make(() => jsonError(500, { error: "boom" }));
    await expect(down.invoke(input(definition))).rejects.toBeInstanceOf(Error);
    expect(down.requests).toHaveLength(1);
    const dropped = await make(() => { throw new TypeError("fetch failed"); });
    await expect(dropped.invoke(input(definition))).rejects.toBeInstanceOf(Error);
    expect(dropped.requests).toHaveLength(1);
  });

  it("reports an answer that stopped for length, and one with no usage as no usage", async () => {
    const long = await make(() => (spec.provider === "anthropic" ? anthropicSse({ model: pinned, text: "cut off", stop: "length" }) : spec.provider === "openai" ? openaiResponsesSse({ model: pinned, text: "x" }) : openrouterSse({ model: pinned, text: "cut off", stop: "length", upstream: "Anthropic" })));
    if (spec.provider !== "openai") expect((await long.invoke(input(definition))).finishReason.unified).toBe("length");
    const empty = await make(() => (spec.provider === "anthropic" ? anthropicSse({ model: pinned, tool: TAP, inputTokens: 0 }) : spec.provider === "openai" ? openaiResponsesSse({ model: pinned, tool: TAP, inputTokens: 0 }) : openrouterSse({ model: pinned, tool: TAP, inputTokens: 0, upstream: "Anthropic" })));
    expect((await empty.invoke(input(definition))).usage).toBeUndefined();
  });

  it("gives the final payload to the proxy's check before it is sent, and sends nothing when the check refuses", async () => {
    const seen: unknown[] = [];
    const { invoke, requests } = await make(() => spec.response(pinned));
    await invoke(input(definition, { inspectPayload: (payload) => { seen.push(payload); } }));
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<string, unknown>)["model"]).toBe(pinned);
    await expect(invoke(input(definition, { inspectPayload: () => { throw new E2EPayloadRefusedError(); } }))).rejects.toBeInstanceOf(E2EPayloadRefusedError);
    expect(requests).toHaveLength(1);
  });

  it("holds the provider key as a secret value, for the proxy's credential scan", async () => {
    const { invoke } = await make(() => spec.response(pinned));
    expect(invoke.secrets).toEqual([PROVIDER_KEY]);
  });

  it("answers provider-error with no fallback and no request when the provider secret is missing", async () => {
    const fake = fakeFetch(() => spec.response(pinned));
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret: async () => undefined, fetch: fake.fetch });
    await expect(invoke(input(definition))).rejects.toBeInstanceOf(MissingProviderSecret);
    expect(fake.requests).toHaveLength(0);
    const route = createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const { result, receipt } = await route.generate(channelRequest());
    expect(result).toMatchObject({ status: "error", code: "provider-error" });
    expect(receipt.outcome).toBe("provider-error");
    expect(fake.requests).toHaveLength(0);
  });

  it("goes through the governed route to a valid receipt that names the served model", async () => {
    const { invoke } = await make(() => spec.response(spec.served));
    const route = createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const { result, receipt } = await route.generate(channelRequest());
    expect(result.status).toBe("ok");
    expect(receipt).toMatchObject({ outcome: "ok", provider: spec.provider, modelId: pinned, servedModelId: spec.served, inputTokens: 900, outputTokens: 40 });
  });

  it("is refused by the route when another model served the call", async () => {
    const { invoke } = await make(() => spec.response("some-other-model"));
    const route = createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const { result, receipt } = await route.generate(channelRequest());
    expect(result).toMatchObject({ status: "error", code: "invalid-output" });
    expect(receipt).toMatchObject({ outcome: "invalid-output", servedModelId: "some-other-model" });
  });
});

describe("final payload shape per provider (Haiku 5.5 rejects temperature 0 and thinks by default)", () => {
  const one = async (definition: E2EModelRouteDefinition, response: () => Response) => {
    const fake = fakeFetch(response);
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fake.fetch });
    await invoke(input(definition));
    return fake.requests[0]!.body;
  };

  it("Anthropic: thinking disabled and effort low, no top-level sampling", async () => {
    const body = await one(keyedRoute("anthropic"), () => anthropicSse({ model: "claude-haiku-5-5", tool: TAP }));
    expect(body["thinking"]).toEqual({ type: "disabled" });
    expect(body["output_config"]).toMatchObject({ effort: "low" });
    expect(hasNoSampling(body)).toBe(true);
  });

  it("OpenAI: low reasoning effort, no sampling", async () => {
    const body = await one(keyedRoute("openai"), () => openaiResponsesSse({ model: "gpt-5.4-mini", tool: TAP }));
    expect(body["reasoning"]).toMatchObject({ effort: "low" });
    expect(hasNoSampling(body)).toBe(true);
  });

  it("OpenRouter: the route's routing policy, no router fields, a pinned model and no thinking", async () => {
    const policy = { allowFallbacks: false, requireParameters: true, dataCollection: "deny", only: ["anthropic"] };
    const body = await one(keyedRoute("openrouter", { openRouter: policy }), () => openrouterSse({ model: "anthropic/claude-haiku-5.5", tool: TAP, upstream: "Anthropic" }));
    expect(body["provider"]).toEqual({ allow_fallbacks: false, require_parameters: true, data_collection: "deny", only: ["anthropic"], order: ["anthropic"] });
    expect(body).not.toHaveProperty("models");
    expect(body).not.toHaveProperty("route");
    expect(body["model"]).toBe("anthropic/claude-haiku-5.5");
    expect(body["reasoning"]).toEqual({ effort: "none" });
    expect(hasNoSampling(body)).toBe(true);
  });

  it("OpenRouter without an allowlist sends no only or order", async () => {
    const body = await one(keyedRoute("openrouter"), () => openrouterSse({ model: "anthropic/claude-haiku-5.5", tool: TAP, upstream: "Anthropic" }));
    expect(body["provider"]).toEqual({ allow_fallbacks: false, require_parameters: true, data_collection: "deny" });
  });
});

describe("Bedrock through pi-ai on a loopback endpoint (Step 0)", () => {
  let loopback: BedrockLoopback | undefined;
  afterEach(async () => { await loopback?.close(); loopback = undefined; });

  const definition = bedrockRoute();
  const make = async (respond: Parameters<typeof bedrockLoopback>[0]) => {
    loopback = await bedrockLoopback(respond);
    return createE2EProviderInvokeForTesting(definition, { environment: installationEnvironment(definition) }, { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } });
  };

  it("sends a throttled call to the endpoint exactly once: the SDK's own retries are cut off", async () => {
    const invoke = await make(() => ({ status: 429, body: JSON.stringify({ message: "Too many requests with the prompt echoed: hunter2-echo" }), errorType: "ThrottlingException" }));
    const failure = await invoke(input(definition)).then(() => undefined, (error: unknown) => error as Error & { status?: number });
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.status).toBe(429);
    expect(String(failure!.message)).not.toContain("hunter2-echo");
    // Give a hidden retry its backoff before counting.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(loopback!.requests).toHaveLength(1);
  });

  it("sends a 500 to the endpoint exactly once", async () => {
    const invoke = await make(() => ({ status: 500, body: JSON.stringify({ message: "internal" }), errorType: "InternalServerException" }));
    await expect(invoke(input(definition))).rejects.toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(loopback!.requests).toHaveLength(1);
  });

  it("round-trips a tool call, with the pinned model in the path, no sampling, thinking disabled and a forced tool choice", async () => {
    const invoke = await make(() => ({ status: 200, body: bedrockStreamBody({ tool: TAP }) }));
    const output = await invoke(input(definition));
    expect(loopback!.requests).toHaveLength(1);
    const request = loopback!.requests[0]!;
    expect(decodeURIComponent(request.path)).toBe(`/model/${definition.modelId}/converse-stream`);
    expect(request.body["inferenceConfig"]).toEqual({ maxTokens: 1024 });
    expect(request.body["additionalModelRequestFields"]).toEqual({ thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(toolConfigOf(request.body).toolChoice).toEqual({ any: {} });
    expect(JSON.stringify(request.body)).not.toContain("cachePoint");
    expect(hasNoSampling(request.body)).toBe(true);
    expect(toolConfigOf(request.body).tools.map((tool) => tool.toolSpec.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    expect(output).toMatchObject({
      servedModelId: null,
      content: [{ type: "tool-call", toolCallId: "call_tap_1", toolName: "tap", input: JSON.stringify({ target: "n1" }) }],
      finishReason: { unified: "tool-calls" }, usage: { inputTokens: 900, outputTokens: 40 },
    });
  });

  it("maps auto and a named tool to Bedrock's tool choices", async () => {
    const invoke = await make(() => ({ status: 200, body: bedrockStreamBody({ tool: TAP }) }));
    await invoke(input(definition, { call: { ...call(), toolChoice: { type: "auto" } } }));
    await invoke(input(definition, { call: { ...call(), toolChoice: { type: "tool", toolName: "complete_step" } } }));
    expect(loopback!.requests.map((request) => toolConfigOf(request.body).toolChoice)).toEqual([{ auto: {} }, { tool: { name: "complete_step" } }]);
  });

  it("invokes the inference profile ARN when the route has one", async () => {
    const arn = `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${definition.modelId}`;
    const withArn = bedrockRoute({ inferenceProfileArn: arn });
    loopback = await bedrockLoopback(() => ({ status: 200, body: bedrockStreamBody({ tool: TAP }) }));
    const invoke = await createE2EProviderInvokeForTesting(withArn, { environment: installationEnvironment(withArn) }, { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } });
    await invoke(input(withArn));
    expect(decodeURIComponent(loopback.requests[0]!.path)).toBe(`/model/${arn}/converse-stream`);
  });

  it("goes through the governed route to a valid receipt with no served model", async () => {
    const invoke = await make(() => ({ status: 200, body: bedrockStreamBody({ tool: TAP }) }));
    const route = createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const { result, receipt } = await route.generate(channelRequest());
    expect(result.status).toBe("ok");
    expect(receipt).toMatchObject({ outcome: "ok", provider: "amazon-bedrock", servedModelId: null, inputTokens: 900 });
  });

  it("does not call a provider at all for a scripted route", async () => {
    await expect(createE2EProviderInvoke({ ...definition, provider: "rovara-scripted" } as never, { environment: {} })).rejects.toThrow(/scripted/);
  });
});

describe("fix round 2 (re-review of amendment A1)", () => {
  let loopback: BedrockLoopback | undefined;
  afterEach(async () => { await loopback?.close(); loopback = undefined; });

  const bedrock = bedrockRoute();
  const bedrockInvoke = async (respond: Parameters<typeof bedrockLoopback>[0]) => {
    loopback = await bedrockLoopback(respond);
    return createE2EProviderInvokeForTesting(bedrock, { environment: installationEnvironment(bedrock) }, { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } });
  };
  const viaRoute = (invoke: Awaited<ReturnType<typeof createE2EProviderInvoke>>, definition: E2EModelRouteDefinition = bedrock) =>
    createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() }).generate(channelRequest());

  it("R1: a Bedrock connection dropped before any response may be retried by the SDK inside one receipt, which charges the reserved bound", async () => {
    const invoke = await bedrockInvoke(() => ({ status: 200, body: "", drop: true }));
    const { result, receipt, chargedInputTokens } = await viaRoute(invoke);
    expect(result).toMatchObject({ status: "error", code: "provider-error" });
    expect(receipt.outcome).toBe("provider-error");
    expect(receipt.inputTokens).toBeGreaterThan(500);
    expect(chargedInputTokens).toBe(receipt.inputTokens);
    // The SDK may make up to its three attempts; they all sit inside this one receipt.
    expect(loopback!.requests.length).toBeGreaterThanOrEqual(1);
    expect(loopback!.requests.length).toBeLessThanOrEqual(3);
  });

  it("R1: an HTTP error still stops after one attempt and charges nothing; a keyed provider's dropped connection charges the bound", async () => {
    const throttled = await bedrockInvoke(() => ({ status: 429, body: JSON.stringify({ message: "x" }), errorType: "ThrottlingException" }));
    const { receipt } = await viaRoute(throttled);
    expect(receipt).toMatchObject({ outcome: "provider-error", inputTokens: 0 });
    expect(loopback!.requests).toHaveLength(1);
    const definition = keyedRoute("anthropic");
    const dropped = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fakeFetch(() => { throw new TypeError("fetch failed"); }).fetch });
    const keyed = await viaRoute(dropped, definition);
    expect(keyed.receipt.outcome).toBe("provider-error");
    expect(keyed.receipt.inputTokens).toBeGreaterThan(500);
  });

  it("R5: a 2xx response that is cut mid-stream is charged the reserved bound, on Bedrock and on a keyed provider", async () => {
    const invoke = await bedrockInvoke(() => ({ status: 200, body: bedrockStartOnly(), cutAfterBody: true }));
    const cut = await viaRoute(invoke);
    expect(cut.result).toMatchObject({ status: "error", code: "provider-error" });
    expect(cut.receipt.inputTokens).toBeGreaterThan(500);
    expect(cut.chargedInputTokens).toBe(cut.receipt.inputTokens);
    for (const provider of ["anthropic", "openai", "openrouter"] as const) {
      const definition = keyedRoute(provider);
      const answer = () => (provider === "anthropic" ? anthropicSse({ model: definition.modelId, tool: TAP }) : provider === "openai" ? openaiResponsesSse({ model: definition.modelId, tool: TAP }) : openrouterSse({ model: definition.modelId, tool: TAP, upstream: "Anthropic" }));
      const keyed = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fakeFetch(() => brokenSse(answer())).fetch });
      const outcome = await viaRoute(keyed, definition);
      expect(outcome.result, provider).toMatchObject({ status: "error", code: "provider-error" });
      expect(outcome.receipt.inputTokens, provider).toBeGreaterThan(500);
    }
  });

  it("R2: refuses a route whose provider or secret differs from the worker's own settings, and never calls a provider", async () => {
    const definition = keyedRoute("anthropic");
    const cases: Array<[string, Record<string, string>]> = [
      ["another provider", { ...installationEnvironment(definition), AGENTX_MODEL_PROVIDER: "openai" }],
      ["no provider setting (Bedrock)", {}],
      ["another secret", { ...installationEnvironment(definition), AGENTX_ANTHROPIC_SECRET_ARN: SECRET_ARN.replace("AbCdEf", "ZzZzZz") }],
      ["no secret", { AGENTX_MODEL_PROVIDER: "anthropic" }],
    ];
    for (const [label, environment] of cases) {
      const fake = fakeFetch(() => anthropicSse({ model: definition.modelId, tool: TAP }));
      const invoke = await createE2EProviderInvoke(definition, { environment, readSecret, fetch: fake.fetch });
      await expect(invoke(input(definition)), label).rejects.toThrow(/model-route-changed-reapprove/);
      expect(fake.requests, label).toHaveLength(0);
    }
    const onBedrock = await createE2EProviderInvoke(bedrock, { environment: { AGENTX_MODEL_PROVIDER: "anthropic" } });
    await expect(onBedrock(input(bedrock))).rejects.toThrow(/model-route-changed-reapprove/);
    // An unset provider setting is Bedrock, as for the coding agent.
    const fine = await createE2EProviderInvokeForTesting(bedrock, { environment: {} }, { bedrockEndpoint: "http://127.0.0.1:1", providerEnv: {} });
    expect(fine.secrets).toEqual([]);
  });

  it("R3: reads the process environment whatever the caller passes, on every call", async () => {
    const definition = keyedRoute("anthropic");
    const fake = fakeFetch(() => anthropicSse({ model: definition.modelId, tool: TAP }));
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fake.fetch });
    await invoke(input(definition));
    expect(fake.requests).toHaveLength(1);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:3128");
    await expect(invoke(input(definition))).rejects.toThrow(/environment can redirect model calls/);
    vi.stubEnv("HTTPS_PROXY", undefined);
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/creds");
    await expect(invoke(input(definition))).rejects.toThrow(/AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/);
    expect(fake.requests).toHaveLength(1);
  });

  it("R4: a Bedrock route always names the standard regional endpoint, and a keyed route has none", async () => {
    const invoke = await createE2EProviderInvoke(bedrock, { environment: installationEnvironment(bedrock) });
    expect(invoke.endpoint).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    const other = bedrockRoute({ region: "eu-west-1" });
    expect((await createE2EProviderInvoke(other, { environment: installationEnvironment(other) })).endpoint).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com");
    const keyed = keyedRoute("anthropic");
    expect((await createE2EProviderInvoke(keyed, { environment: installationEnvironment(keyed), readSecret })).endpoint).toBeUndefined();
  });

  it("R6: the loopback and environment overrides are not reachable from the production entry point", async () => {
    // The production factory ignores a testing argument smuggled in through a cast.
    const smuggled = await createE2EProviderInvoke(bedrock, { environment: installationEnvironment(bedrock), testing: { bedrockEndpoint: "http://127.0.0.1:9", providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } } } as never);
    expect(smuggled.endpoint).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    // The test factory is not in the package's exports, and nothing but tests imports it.
    expect(Object.keys(modelRuntime).filter((name) => /testing|internal/i.test(name))).toEqual([]);
    const manifest = JSON.parse(readFileSync(new URL("../../packages/model-runtime/package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(JSON.stringify(manifest.exports)).not.toMatch(/e2e-provider-invoke/);
    const { readdirSync, statSync } = await import("node:fs");
    const offenders: string[] = [];
    const mentions = /e2e-provider-invoke-testing|createE2EProviderInvokeForTesting|buildE2EProviderInvoke|E2EProviderInvokeTesting/;
    const allowed = ["e2e-provider-invoke-testing.ts", "e2e-provider-invoke.ts"];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = `${dir}/${name}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && !allowed.includes(name) && mentions.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    for (const pkg of readdirSync(new URL("../../packages", import.meta.url).pathname)) {
      const src = new URL(`../../packages/${pkg}/src`, import.meta.url).pathname;
      if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src);
    }
    expect(offenders).toEqual([]);
  });

  it("N3: the builder is not exported from its module; the test factory is the one way in, re-exported by the test module alone", () => {
    expect(Object.keys(invokeModule).sort()).toEqual(["createE2EProviderInvoke", "createE2EProviderInvokeForTesting"]);
    const main = readFileSync(new URL("../../packages/model-runtime/src/e2e-provider-invoke.ts", import.meta.url), "utf8");
    expect(main).not.toMatch(/export (?:async )?function build|export interface E2EProviderInvokeTesting|export type E2EProviderInvokeTesting/);
    const testing = readFileSync(new URL("../../packages/model-runtime/src/e2e-provider-invoke-testing.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(testing.trim()).toBe('export { createE2EProviderInvokeForTesting } from "./e2e-provider-invoke.js";');
  });

  it("N1: a worker with PI_CACHE_RETENTION set (as every deployed worker has it) serves a call, and no cache point is sent", async () => {
    vi.stubEnv("PI_CACHE_RETENTION", "long");
    const definition = keyedRoute("anthropic");
    const fake = fakeFetch(() => anthropicSse({ model: definition.modelId, tool: TAP }));
    const keyed = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret, fetch: fake.fetch });
    expect((await viaRoute(keyed, definition)).result.status).toBe("ok");
    expect(fake.requests[0]!.bodyText).not.toContain("cache_control");
    const viaBedrock = await bedrockInvoke(() => ({ status: 200, body: bedrockStreamBody({ tool: TAP }) }));
    expect((await viaRoute(viaBedrock)).result.status).toBe("ok");
    expect(JSON.stringify(loopback!.requests[0]!.body)).not.toContain("cachePoint");
  });

  it("N2: a route is checked against the process environment's settings, whatever environment the invoke is given", async () => {
    vi.stubEnv("AGENTX_MODEL_PROVIDER", "openrouter");
    const onBedrock = await createE2EProviderInvoke(bedrock, { environment: installationEnvironment(bedrock) });
    await expect(onBedrock(input(bedrock))).rejects.toThrow(/model-route-changed-reapprove/);
  });

  it("N4: a dropped first attempt followed by a 429 on the retry still charges the bound", async () => {
    const invoke = await bedrockInvoke((_request, count) => (count === 1 ? { status: 200, body: "", drop: true } : { status: 429, body: JSON.stringify({ message: "x" }), errorType: "ThrottlingException" }));
    const { receipt, chargedInputTokens } = await viaRoute(invoke);
    expect(loopback!.requests).toHaveLength(2);
    expect(receipt.outcome).toBe("provider-error");
    expect(receipt.inputTokens).toBeGreaterThan(500);
    expect(chargedInputTokens).toBe(receipt.inputTokens);
  });

  it("N4: a setup, guard, mismatch or credential refusal sent nothing, so it charges 0 and releases the day reservation", async () => {
    const days: Array<ReturnType<typeof createInMemoryE2EDayBudget>> = [];
    const route = (invoke: Awaited<ReturnType<typeof createE2EProviderInvoke>>, definition: E2EModelRouteDefinition) => {
      const dayBudget = createInMemoryE2EDayBudget();
      days.push(dayBudget);
      return createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget }).generate(channelRequest());
    };
    const keyedDefinition = keyedRoute("anthropic");
    const fake = fakeFetch(() => anthropicSse({ model: keyedDefinition.modelId, tool: TAP }));
    const outcomes = [
      // a missing provider secret (setup)
      await route(await createE2EProviderInvoke(keyedDefinition, { environment: installationEnvironment(keyedDefinition), readSecret: async () => undefined, fetch: fake.fetch }), keyedDefinition),
      // a route that is not the installation's (mismatch)
      await route(await createE2EProviderInvoke(keyedDefinition, { environment: { AGENTX_MODEL_PROVIDER: "openai" }, readSecret, fetch: fake.fetch }), keyedDefinition),
    ];
    // a redirecting environment (guard)
    const guarded = await createE2EProviderInvoke(keyedDefinition, { environment: installationEnvironment(keyedDefinition), readSecret, fetch: fake.fetch });
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:3128");
    outcomes.push(await route(guarded, keyedDefinition));
    vi.stubEnv("HTTPS_PROXY", undefined);
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.result, String(index)).toMatchObject({ status: "error", code: "provider-error" });
      expect(outcome.receipt.inputTokens, String(index)).toBe(0);
      expect(outcome.chargedInputTokens, String(index)).toBe(0);
      expect(days[index]!.snapshot().usedInputTokens, String(index)).toBe(0);
    }
    expect(fake.requests).toHaveLength(0);
    // a payload the credential scan refused
    const dayBudget = createInMemoryE2EDayBudget();
    const scanned = await createE2EProviderInvoke(keyedDefinition, { environment: installationEnvironment(keyedDefinition), readSecret, fetch: fake.fetch });
    const refused = await createGovernedE2EModelRoute(keyedDefinition, { invoke: scanned, now: Date.now, dayBudget }).generate(channelRequest(), { inspectPayload: () => { throw new E2EPayloadRefusedError(); } });
    expect(refused.result).toMatchObject({ code: "refused-credential-match" });
    expect(dayBudget.snapshot().usedInputTokens).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});
