import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2EModelChannelResponseSchema,
  E2EModelReceiptSchema,
  e2eModelRouteInvokedIdentifier,
  e2eModelRouteRevision,
} from "../../packages/contracts/src/e2e-model-channel.js";
import * as modelRuntime from "../../packages/model-runtime/src/index.js";
import {
  createGovernedE2EModelRoute,
  createInMemoryE2EDayBudget,
  type E2EInvoke,
  type E2EInvokeInput,
} from "../../packages/model-runtime/src/e2e-route.js";
import { createBedrockE2EInvoke, createBedrockRuntimeClient } from "../../packages/model-runtime/src/e2e-bedrock-invoke.js";
import { MODEL_ID, RUN_ID, bedrockRoute, call, channelRequest, loweredBudgets, tapAnswer } from "../support/e2e-model-fixtures.js";

afterEach(() => { vi.useRealTimers(); });

function routeWith(invoke: E2EInvoke, definition = bedrockRoute(), extra: Partial<Parameters<typeof createGovernedE2EModelRoute>[1]> = {}) {
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  return createGovernedE2EModelRoute(definition, { invoke, now: () => (clock += 5), ...extra });
}

describe("governed e2e model route: the call it makes", () => {
  it("invokes the pinned model with temperature 0 and the route's output cap, and writes a valid receipt", async () => {
    const seen: E2EInvokeInput[] = [];
    const route = routeWith(async (input) => { seen.push(input); return tapAnswer(); });
    const { result, receipt } = await route.generate(channelRequest());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ identifier: MODEL_ID, region: "us-east-1", temperature: 0, maxOutputTokens: 1024 });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({ status: "ok", finishReason: { unified: "tool-calls" }, usage: { inputTokens: 900, outputTokens: 40 } });
    expect(E2EModelReceiptSchema.parse(receipt)).toMatchObject({
      outcome: "ok", provider: "amazon-bedrock", modelId: MODEL_ID, routeId: "rovara-e2e-default", runId: RUN_ID,
      callIndex: 0, stepIndex: 0, inputTokens: 900, outputTokens: 40,
    });
    expect(receipt.routeRevision).toBe(e2eModelRouteRevision(route.definition));
    expect(route.routeRevision).toBe(receipt.routeRevision);
    expect(receipt.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(E2EModelChannelResponseSchema.safeParse({ schemaVersion: "rovara-e2e-model-channel/v1", receiptId: receipt.receiptId, result }).success).toBe(true);
  });

  it("invokes the inference profile ARN when the route has one", async () => {
    const arn = `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${MODEL_ID}`;
    const seen: E2EInvokeInput[] = [];
    const definition = bedrockRoute({ inferenceProfileArn: arn });
    const route = routeWith(async (input) => { seen.push(input); return tapAnswer({ servedModelId: arn }); }, definition);
    const { receipt } = await route.generate(channelRequest());
    expect(seen[0]!.identifier).toBe(e2eModelRouteInvokedIdentifier(definition));
    expect(seen[0]!.identifier).toBe(arn);
    expect(receipt.outcome).toBe("ok");
    expect(receipt.modelId).toBe(MODEL_ID);
  });

  it("answers invalid-output when a different model served the call", async () => {
    const route = routeWith(async () => tapAnswer({ servedModelId: "us.anthropic.claude-opus-5" }));
    const { result, receipt } = await route.generate(channelRequest());
    expect(result).toMatchObject({ status: "error", code: "invalid-output" });
    expect(receipt.outcome).toBe("invalid-output");
    expect(receipt.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("answers invalid-output for a tool the request did not offer, and for a malformed tool input", async () => {
    const unoffered = routeWith(async () => tapAnswer({ content: [{ type: "tool-call", toolCallId: "c1", toolName: "scroll", input: "{}" }] }));
    expect((await unoffered.generate(channelRequest())).result).toMatchObject({ status: "error", code: "invalid-output" });
    const notJson = routeWith(async () => tapAnswer({ content: [{ type: "tool-call", toolCallId: "c1", toolName: "tap", input: "not json" }] }));
    expect((await notJson.generate(channelRequest())).result).toMatchObject({ status: "error", code: "invalid-output" });
    const notObject = routeWith(async () => tapAnswer({ content: [{ type: "tool-call", toolCallId: "c1", toolName: "tap", input: "[1]" }] }));
    expect((await notObject.generate(channelRequest())).result).toMatchObject({ status: "error", code: "invalid-output" });
    const empty = routeWith(async () => tapAnswer({ content: [] }));
    expect((await empty.generate(channelRequest())).result).toMatchObject({ status: "error", code: "invalid-output" });
  });

  it("never lets a truncated, filtered or failed finish look like success", async () => {
    for (const unified of ["length", "content-filter", "other"]) {
      const route = routeWith(async () => tapAnswer({ finishReason: { unified, raw: unified } }));
      const { result, receipt } = await route.generate(channelRequest());
      expect(result, unified).toMatchObject({ status: "error", code: "invalid-output" });
      expect(receipt.outcome).toBe("invalid-output");
    }
    const failed = routeWith(async () => tapAnswer({ finishReason: { unified: "error", raw: "error" } }));
    const outcome = await failed.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "provider-error" });
    expect(outcome.receipt.responseSha256).toBeNull();
  });

  it("answers invalid-output when usage is above the route's own bounds", async () => {
    const heavy = routeWith(async () => tapAnswer({ usage: { inputTokens: 32_001, outputTokens: 10 } }));
    expect((await heavy.generate(channelRequest())).result).toMatchObject({ status: "error", code: "invalid-output" });
    const verbose = routeWith(async () => tapAnswer({ usage: { inputTokens: 100, outputTokens: 1025 } }));
    expect((await verbose.generate(channelRequest())).result).toMatchObject({ status: "error", code: "invalid-output" });
    const lowered = routeWith(async () => tapAnswer({ usage: { inputTokens: 2_001, outputTokens: 10 } }), bedrockRoute({ budgets: loweredBudgets({ maxInputTokens: 2_000 }) }));
    const outcome = await lowered.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "invalid-output" });
    expect(E2EModelReceiptSchema.safeParse(outcome.receipt).success).toBe(true);
  });
});

describe("governed e2e model route: timeouts and provider errors", () => {
  it("aborts a call that takes 30001 ms and answers timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const route = createGovernedE2EModelRoute(bedrockRoute(), {
      now: () => Date.now(),
      invoke: (input) => { signal = input.signal; return new Promise(() => undefined); },
    });
    const pending = route.generate(channelRequest());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const { result, receipt } = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ status: "error", code: "timeout" });
    expect(receipt).toMatchObject({ outcome: "timeout", responseSha256: null });
    expect(receipt.latencyMs).toBeGreaterThanOrEqual(30_000);
    expect(E2EModelReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("times out at the route's own lowered timeout", async () => {
    vi.useFakeTimers();
    const route = createGovernedE2EModelRoute(bedrockRoute({ budgets: loweredBudgets({ callTimeoutMs: 5_000 }) }), {
      now: () => Date.now(), invoke: () => new Promise(() => undefined),
    });
    const pending = route.generate(channelRequest());
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).result).toMatchObject({ status: "error", code: "timeout" });
  });

  it("does not call the provider after the run's deadline", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const route = routeWith(invoke);
    const { result, receipt } = await route.generate(channelRequest(), { deadlineAt: 1 });
    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error", code: "timeout" });
    expect(receipt.outcome).toBe("timeout");
  });

  it("does not retry a provider 429: one invoke, outcome provider-error, and the provider's words are not passed on", async () => {
    const invoke = vi.fn(async () => { throw Object.assign(new Error("Too many requests for the prompt: hunter2-secret-echo"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }); });
    const route = routeWith(invoke);
    const { result, receipt } = await route.generate(channelRequest());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "error", code: "provider-error" });
    expect(JSON.stringify(result)).not.toContain("hunter2-secret-echo");
    expect(JSON.stringify(result)).toContain("429");
    expect(receipt).toMatchObject({ outcome: "provider-error", responseSha256: null });
  });

  it("answers provider-error when the run aborts a call in flight", async () => {
    const controller = new AbortController();
    const route = routeWith(() => new Promise(() => undefined));
    const pending = route.generate(channelRequest(), { signal: controller.signal });
    controller.abort();
    const { result } = await pending;
    expect(result).toMatchObject({ status: "error", code: "provider-error" });
  });
});

describe("governed e2e model route: checks against the route's own budgets", () => {
  it("refuses a prompt above the route's lowered prompt bound, and an output cap above its own, before invoke", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const route = routeWith(invoke, bedrockRoute({ budgets: loweredBudgets({ maxPromptBytes: 4_096, maxOutputTokens: 256 }) }));
    const big = await route.generate(channelRequest({ callOverride: call("x".repeat(5_000)) }));
    expect(big.result).toMatchObject({ status: "error", code: "refused-protocol" });
    const greedy = await route.generate(channelRequest({ callOverride: { ...call(), maxOutputTokens: 512 } }));
    expect(greedy.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
    expect(big.receipt).toMatchObject({ outcome: "refused-protocol", inputTokens: 0, outputTokens: 0, responseSha256: null });
    const ok = await route.generate(channelRequest({ callOverride: { ...call(), maxOutputTokens: 200 } }));
    expect(ok.result.status).toBe("ok");
  });

  it("sends the smaller of the route's output cap and the call's", async () => {
    const seen: E2EInvokeInput[] = [];
    const route = routeWith(async (input) => { seen.push(input); return tapAnswer(); }, bedrockRoute({ budgets: loweredBudgets({ maxOutputTokens: 300 }) }));
    await route.generate(channelRequest());
    await route.generate(channelRequest({ callOverride: { ...call(), maxOutputTokens: 100 } }));
    expect(seen.map((item) => item.maxOutputTokens)).toEqual([300, 100]);
  });

  it("refuses a request that is not a valid channel request", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const route = routeWith(invoke);
    const { result } = await route.generate({ ...channelRequest(), extra: true } as never);
    expect(result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses with model-route-budget-exhausted once the project's day cap of 2000000 input tokens would be passed", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const dayBudget = createInMemoryE2EDayBudget({ maxInputTokens: 2_000_000, maxCalls: 400, usedInputTokens: 1_999_000 });
    const route = routeWith(invoke, bedrockRoute(), { dayBudget });
    const { result, receipt } = await route.generate(channelRequest({ callOverride: call("x".repeat(6_000)) }));
    expect(result).toMatchObject({ status: "error", code: "budget" });
    expect((result as { message: string }).message).toMatch(/^model-route-budget-exhausted/);
    expect(receipt).toMatchObject({ outcome: "budget", inputTokens: 0, responseSha256: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("settles the day budget with the tokens a call used, and stops at the day's call cap", async () => {
    const dayBudget = createInMemoryE2EDayBudget({ maxInputTokens: 2_000_000, maxCalls: 2 });
    const route = routeWith(async () => tapAnswer(), bedrockRoute(), { dayBudget });
    expect((await route.generate(channelRequest())).result.status).toBe("ok");
    expect(dayBudget.snapshot()).toMatchObject({ usedInputTokens: 900, usedCalls: 1 });
    expect((await route.generate(channelRequest({ callIndex: 1 }))).result.status).toBe("ok");
    const third = await route.generate(channelRequest({ callIndex: 2 }));
    expect(third.result).toMatchObject({ status: "error", code: "budget" });
    expect((third.result as { message: string }).message).toMatch(/^model-route-budget-exhausted/);
  });

  it("keeps a failed call's reservation against the day, since the provider may have billed it", async () => {
    const dayBudget = createInMemoryE2EDayBudget({ maxInputTokens: 2_000_000, maxCalls: 400 });
    const route = routeWith(async () => { throw new Error("boom"); }, bedrockRoute(), { dayBudget });
    await route.generate(channelRequest());
    expect(dayBudget.snapshot().usedCalls).toBe(1);
  });
});

describe("governed e2e model route: no fallback", () => {
  it("never uses the coding-task fallback or the default model, and is exported from the package", () => {
    for (const file of ["e2e-route.ts", "e2e-bedrock-invoke.ts"]) {
      const source = readFileSync(new URL(`../../packages/model-runtime/src/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/createModelRuntimeWithFallback|defaultBedrockModel|createConfiguredModelRuntime|from "\.\/index\.js"|from "\.\/config\.js"/);
    }
    expect(typeof modelRuntime.createGovernedE2EModelRoute).toBe("function");
    expect(typeof modelRuntime.createBedrockE2EInvoke).toBe("function");
  });
});

describe("bedrock converse invoke", () => {
  const converseOutput = (content: unknown[], stopReason = "tool_use", usage = { inputTokens: 700, outputTokens: 30 }) => ({ output: { message: { role: "assistant", content } }, stopReason, usage, metrics: { latencyMs: 10 }, $metadata: {} });

  function invokeWith(response: unknown, sent: Array<{ input: Record<string, unknown>; options: unknown }> = []) {
    const client = { send: async (command: { input: Record<string, unknown> }, options: unknown) => { sent.push({ input: command.input, options }); return response; } };
    return createBedrockE2EInvoke({ clientFor: () => client });
  }
  const input = (overrides: Partial<E2EInvokeInput> = {}): E2EInvokeInput => ({
    identifier: MODEL_ID, region: "us-east-1", temperature: 0, maxOutputTokens: 1024, signal: new AbortController().signal, call: call(), ...overrides,
  });

  it("maps the call to one Converse request: pinned model, temperature 0, output cap, system, tools and forced choice", async () => {
    const sent: Array<{ input: Record<string, unknown>; options: { abortSignal?: AbortSignal } }> = [];
    const invoke = invokeWith(converseOutput([{ toolUse: { toolUseId: "tooluse_1", name: "tap", input: { target: "n1" } } }]), sent);
    const signal = new AbortController().signal;
    const answer = await invoke(input({ signal }));
    expect(sent).toHaveLength(1);
    const request = sent[0]!.input as { modelId: string; system: unknown; messages: unknown; inferenceConfig: unknown; toolConfig: { tools: Array<{ toolSpec: { name: string; inputSchema: { json: unknown } } }>; toolChoice: unknown }; additionalModelRequestFields?: unknown };
    expect(request.modelId).toBe(MODEL_ID);
    expect(request.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0 });
    expect(request.system).toEqual([{ text: "You drive a web application one tool call at a time." }]);
    expect(request.toolConfig.toolChoice).toEqual({ any: {} });
    expect(request.toolConfig.tools.map((tool) => tool.toolSpec.name)).toEqual(["tap", "type", "complete_step"]);
    expect(request.toolConfig.tools[0]!.toolSpec.inputSchema.json).toMatchObject({ type: "object" });
    expect(request.additionalModelRequestFields).toBeUndefined();
    expect(sent[0]!.options.abortSignal).toBe(signal);
    expect(answer).toEqual({
      servedModelId: MODEL_ID,
      content: [{ type: "tool-call", toolCallId: "tooluse_1", toolName: "tap", input: JSON.stringify({ target: "n1" }) }],
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: { inputTokens: 700, outputTokens: 30 },
    });
  });

  it("maps auto and a named tool to Bedrock tool choices", async () => {
    const sent: Array<{ input: Record<string, unknown>; options: unknown }> = [];
    const invoke = invokeWith(converseOutput([{ text: "ok" }], "end_turn"), sent);
    await invoke(input({ call: { ...call(), toolChoice: { type: "auto" } } }));
    await invoke(input({ call: { ...call(), toolChoice: { type: "tool", toolName: "complete_step" } } }));
    const choices = sent.map((item) => (item.input.toolConfig as { toolChoice: unknown }).toolChoice);
    expect(choices).toEqual([{ auto: {} }, { tool: { name: "complete_step" } }]);
  });

  it("carries a tool round trip: assistant tool calls, merged tool results, error results, no empty text", async () => {
    const sent: Array<{ input: Record<string, unknown>; options: unknown }> = [];
    const invoke = invokeWith(converseOutput([{ text: "done" }], "end_turn"), sent);
    const withHistory = call("#n1 button \"Export\"", { typed: "orders.csv", toolResult: "Typed." });
    withHistory.prompt.push({ role: "assistant", content: [{ type: "text", text: "" }, { type: "tool-call", toolCallId: "call_2", toolName: "tap", input: { target: "n1" } }] });
    withHistory.prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: "call_2", toolName: "tap", output: { type: "error-text", value: "not found" } }] });
    withHistory.prompt.push({ role: "user", content: [{ type: "text", text: "[SYSTEM] continue" }] });
    await invoke(input({ call: withHistory }));
    const messages = sent[0]!.input.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[1]!.content).toEqual([{ toolUse: { toolUseId: "call_1", name: "type", input: { target: "n2", value: "orders.csv" } } }]);
    expect(messages[2]!.content).toEqual([{ toolResult: { toolUseId: "call_1", content: [{ text: "Typed." }], status: "success" } }]);
    expect(messages[3]!.content).toEqual([{ toolUse: { toolUseId: "call_2", name: "tap", input: { target: "n1" } } }]);
    expect(messages[4]!.content).toEqual([
      { toolResult: { toolUseId: "call_2", content: [{ text: "not found" }], status: "error" } },
      { text: "[SYSTEM] continue" },
    ]);
  });

  it("maps stop reasons: end_turn and tool_use finish, the rest are not a success", async () => {
    const reasons = async (stopReason: string) => (await invokeWith(converseOutput([{ text: "x" }], stopReason))(input())).finishReason.unified;
    expect(await reasons("end_turn")).toBe("stop");
    expect(await reasons("tool_use")).toBe("tool-calls");
    expect(await reasons("max_tokens")).toBe("length");
    expect(await reasons("content_filtered")).toBe("content-filter");
    expect(await reasons("guardrail_intervened")).toBe("content-filter");
    expect(await reasons("something_new")).toBe("other");
  });

  it("returns a content block it does not know as unsupported, so the route refuses it", async () => {
    const answer = await invokeWith(converseOutput([{ reasoningContent: { reasoningText: { text: "hmm" } } }], "end_turn"))(input());
    expect(answer.content).toEqual([{ type: "unsupported-block" }]);
  });

  it("counts cache tokens in the input total, and builds a client that makes one attempt and has the pinned region", async () => {
    const answer = await invokeWith(converseOutput([{ text: "x" }], "end_turn", { inputTokens: 700, outputTokens: 30, cacheReadInputTokens: 50, cacheWriteInputTokens: 25 } as never))(input());
    expect(answer.usage).toEqual({ inputTokens: 775, outputTokens: 30 });
    const client = createBedrockRuntimeClient("eu-west-1");
    expect(await client.config.maxAttempts()).toBe(1);
    expect(await client.config.region()).toBe("eu-west-1");
    client.destroy();
  });

  it("refuses to run without a region", async () => {
    await expect(invokeWith(converseOutput([]))(input({ region: null }))).rejects.toThrow(/region/);
  });
});
