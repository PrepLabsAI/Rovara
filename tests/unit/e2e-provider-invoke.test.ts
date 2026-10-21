import { afterEach, describe, expect, it } from "vitest";
import type { E2EModelRouteDefinition } from "../../packages/contracts/src/e2e-model-channel.js";
import { MissingProviderSecret } from "../../packages/model-runtime/src/config.js";
import { E2EPayloadRefusedError, createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvokeInput } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2EProviderInvoke } from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { PROVIDER_KEY, SECRET_ARN, TOOLS, bedrockRoute, call, channelRequest, keyedRoute } from "../support/e2e-model-fixtures.js";
import {
  anthropicSse, bedrockLoopback, bedrockStreamBody, fakeFetch, jsonError, openaiResponsesSse, openrouterSse,
  type BedrockLoopback, type RecordedRequest,
} from "../support/e2e-provider-fakes.js";

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
    return { invoke: await createE2EProviderInvoke(definition, { environment: {}, readSecret, fetch: fake.fetch, ...extra }), ...fake };
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
    const invoke = await createE2EProviderInvoke(definition, { environment: {}, readSecret: async () => undefined, fetch: fake.fetch });
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
    const invoke = await createE2EProviderInvoke(definition, { environment: {}, readSecret, fetch: fake.fetch });
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
    return createE2EProviderInvoke(definition, { environment: {}, testing: { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } } });
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
    const invoke = await createE2EProviderInvoke(withArn, { environment: {}, testing: { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } } });
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
