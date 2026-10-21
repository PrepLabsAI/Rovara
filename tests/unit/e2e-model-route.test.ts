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
  E2EPayloadRefusedError,
  type E2EInvoke,
  type E2EInvokeInput,
} from "../../packages/model-runtime/src/e2e-route.js";
import { MODEL_ID, RUN_ID, bedrockRoute, call, channelRequest, keyedRoute, loweredBudgets, tapAnswer } from "../support/e2e-model-fixtures.js";

afterEach(() => { vi.useRealTimers(); });

function routeWith(invoke: E2EInvoke, definition = bedrockRoute(), extra: Partial<Parameters<typeof createGovernedE2EModelRoute>[1]> = {}) {
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  return createGovernedE2EModelRoute(definition, { invoke, now: () => (clock += 5), dayBudget: createInMemoryE2EDayBudget(), ...extra });
}

describe("governed e2e model route: the call it makes", () => {
  it("invokes the pinned model with provider-default sampling, thinking off and the route's output cap, and writes a valid receipt", async () => {
    const seen: E2EInvokeInput[] = [];
    const route = routeWith(async (input) => { seen.push(input); return tapAnswer(); });
    const { result, receipt } = await route.generate(channelRequest());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ target: { provider: "amazon-bedrock", identifier: MODEL_ID, region: "us-east-1" }, sampling: "provider-default", thinking: "off", effort: "low", maxOutputTokens: 1024 });
    expect(seen[0]).not.toHaveProperty("temperature");
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
    expect(seen[0]!.target.identifier).toBe(e2eModelRouteInvokedIdentifier(definition));
    expect(seen[0]!.target.identifier).toBe(arn);
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
      now: () => Date.now(), dayBudget: createInMemoryE2EDayBudget(),
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
      now: () => Date.now(), dayBudget: createInMemoryE2EDayBudget(), invoke: () => new Promise(() => undefined),
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
    const definition = bedrockRoute();
    expect(definition.budgets.maxInputTokensPerProjectDay).toBe(2_000_000);
    const dayBudget = createInMemoryE2EDayBudget({ usedInputTokens: 1_999_000 });
    const route = routeWith(invoke, definition, { dayBudget });
    const { result, receipt } = await route.generate(channelRequest({ callOverride: call("x".repeat(6_000)) }));
    expect(result).toMatchObject({ status: "error", code: "budget" });
    expect((result as { message: string }).message).toMatch(/^model-route-budget-exhausted/);
    expect(receipt).toMatchObject({ outcome: "budget", inputTokens: 0, responseSha256: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("settles the day budget with the tokens a call used, and stops at the day's call cap", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => tapAnswer(), bedrockRoute({ budgets: loweredBudgets({ maxCallsPerProjectDay: 2 }) }), { dayBudget });
    expect((await route.generate(channelRequest())).result.status).toBe("ok");
    expect(dayBudget.snapshot()).toMatchObject({ usedInputTokens: 900, usedCalls: 1 });
    expect((await route.generate(channelRequest({ callIndex: 1 }))).result.status).toBe("ok");
    const third = await route.generate(channelRequest({ callIndex: 2 }));
    expect(third.result).toMatchObject({ status: "error", code: "budget" });
    expect((third.result as { message: string }).message).toMatch(/^model-route-budget-exhausted/);
  });

  it("keeps a failed call's reservation against the day, since the provider may have billed it", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => { throw new Error("boom"); }, bedrockRoute(), { dayBudget });
    await route.generate(channelRequest());
    expect(dayBudget.snapshot().usedCalls).toBe(1);
  });
});

describe("governed e2e model route: fix round 1", () => {
  it("F1: refuses before invoke a prompt whose upper bound could pass the per-call input limit, and records no clamped count", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const route = routeWith(invoke);
    const big = await route.generate(channelRequest({ callOverride: call("x".repeat(40_000)) }));
    expect(invoke).not.toHaveBeenCalled();
    expect(big.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect((big.result as { message: string }).message).toMatch(/input/);
    expect(big.receipt).toMatchObject({ outcome: "refused-protocol", inputTokens: 0 });
    const fits = await route.generate(channelRequest({ callIndex: 1, callOverride: call("x".repeat(29_000)) }));
    expect(fits.result.status).toBe("ok");
    const lowered = routeWith(invoke, bedrockRoute({ budgets: loweredBudgets({ maxInputTokens: 5_000 }) }));
    expect((await lowered.generate(channelRequest({ callOverride: call("x".repeat(6_000)) }))).result).toMatchObject({ code: "refused-protocol" });
  });

  it("F1: refuses a prompt whose bound is more than the day has left, before invoke", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const route = routeWith(invoke, bedrockRoute(), { dayBudget: createInMemoryE2EDayBudget({ usedInputTokens: 1_990_000 }) });
    const { result } = await route.generate(channelRequest({ callOverride: call("x".repeat(15_000)) }));
    expect(result).toMatchObject({ status: "error", code: "budget" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("F1: a provider count above the bound is charged in full, even where the receipt can hold no more than 64000", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => tapAnswer({ usage: { inputTokens: 70_000, outputTokens: 10 } }), bedrockRoute(), { dayBudget });
    const outcome = await route.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "invalid-output" });
    expect(outcome.receipt.inputTokens).toBe(64_000);
    expect(outcome.chargedInputTokens).toBe(70_000);
    expect(dayBudget.snapshot().usedInputTokens).toBe(70_000);
  });

  it("F2: needs a day budget, whose limits are the definition's", async () => {
    expect(() => createGovernedE2EModelRoute(bedrockRoute(), { invoke: async () => tapAnswer(), now: Date.now } as never)).toThrow(/day budget/);
    const limits: unknown[] = [];
    const dayBudget = { reserve: (_tokens: number, given: unknown) => { limits.push(given); return { settle: () => undefined }; } };
    const route = routeWith(async () => tapAnswer(), bedrockRoute({ budgets: loweredBudgets({ maxInputTokensPerProjectDay: 50_000, maxCallsPerProjectDay: 7 }) }), { dayBudget });
    await route.generate(channelRequest());
    expect(limits).toEqual([{ maxInputTokens: 50_000, maxCalls: 7 }]);
  });

  it("F3: honours per-call limits the group lowered below the route's", async () => {
    const seen: E2EInvokeInput[] = [];
    const route = routeWith(async (input) => { seen.push(input); return tapAnswer({ usage: { inputTokens: 2_001, outputTokens: 10 } }); });
    const group = loweredBudgets({ maxPromptBytes: 4_096, maxOutputTokens: 100, maxInputTokens: 2_000, callTimeoutMs: 1_000 });
    expect((await route.generate(channelRequest({ callOverride: call("x".repeat(6_000)) }), { budgets: group })).result).toMatchObject({ code: "refused-protocol" });
    expect((await route.generate(channelRequest({ callIndex: 1, callOverride: { ...call(), maxOutputTokens: 500 } }), { budgets: group })).result).toMatchObject({ code: "refused-protocol" });
    const heavy = await route.generate(channelRequest({ callIndex: 2 }), { budgets: group });
    expect(seen.map((item) => item.maxOutputTokens)).toEqual([100]);
    expect(heavy.result).toMatchObject({ code: "invalid-output" });
    const wider = await route.generate(channelRequest({ callIndex: 3 }), { budgets: { ...group, maxOutputTokens: 1024, maxInputTokens: 32_000 } });
    expect(seen.at(-1)!.maxOutputTokens).toBe(1024);
    expect(wider.result.status).toBe("ok");
  });

  it("F3: a group value can lower the call timeout, and never raise the route's", async () => {
    vi.useFakeTimers();
    const route = createGovernedE2EModelRoute(bedrockRoute({ budgets: loweredBudgets({ callTimeoutMs: 5_000 }) }), { now: () => Date.now(), dayBudget: createInMemoryE2EDayBudget(), invoke: () => new Promise(() => undefined) });
    const lowered = route.generate(channelRequest(), { budgets: loweredBudgets({ callTimeoutMs: 1_000 }) });
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await lowered).result).toMatchObject({ code: "timeout" });
    const raised = route.generate(channelRequest({ callIndex: 1 }), { budgets: loweredBudgets({ callTimeoutMs: 30_000 }) });
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await raised).result).toMatchObject({ code: "timeout" });
  });

  it("F6: a missing usage fails closed: the reserved bound is counted and the receipt says invalid-output", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => tapAnswer({ usage: undefined }), bedrockRoute(), { dayBudget });
    const outcome = await route.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "invalid-output" });
    expect((outcome.result as { message: string }).message).toMatch(/usage/);
    expect(outcome.receipt.inputTokens).toBeGreaterThan(500);
    expect(outcome.usageMissing).toBe(true);
    expect(outcome.chargedInputTokens).toBe(outcome.receipt.inputTokens);
    expect(dayBudget.snapshot().usedInputTokens).toBe(outcome.receipt.inputTokens);
  });

  it("F7: a day budget that throws gives a budget receipt, and one that fails to settle gives a provider-error receipt", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const reserveFails = routeWith(invoke, bedrockRoute(), { dayBudget: { reserve: () => { throw new Error("table unreachable"); } } });
    const refused = await reserveFails.generate(channelRequest());
    expect(refused.result).toMatchObject({ status: "error", code: "budget" });
    expect(refused.receipt.outcome).toBe("budget");
    expect(invoke).not.toHaveBeenCalled();
    const settleFails = routeWith(invoke, bedrockRoute(), { dayBudget: { reserve: () => ({ settle: () => { throw new Error("table unreachable"); } }) } });
    const failed = await settleFails.generate(channelRequest());
    expect(failed.result).toMatchObject({ status: "error", code: "provider-error" });
    expect(failed.receipt).toMatchObject({ outcome: "provider-error", responseSha256: null, inputTokens: 900 });
  });
});

describe("governed e2e model route: no fallback", () => {
  it("never uses the coding-task fallback or the default model, and is exported from the package", () => {
    for (const file of ["e2e-route.ts", "e2e-provider-invoke.ts", "e2e-environment-guard.ts"]) {
      const source = readFileSync(new URL(`../../packages/model-runtime/src/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/createModelRuntimeWithFallback|defaultBedrockModel|createConfiguredModelRuntime|from "\.\/index\.js"/);
    }
    expect(typeof modelRuntime.createGovernedE2EModelRoute).toBe("function");
    expect(typeof modelRuntime.createE2EProviderInvoke).toBe("function");
    expect(typeof modelRuntime.assertE2EEnvironmentCannotRedirect).toBe("function");
    expect(Object.keys(modelRuntime)).not.toContain("createBedrockE2EInvoke");
  });
});

describe("governed e2e model route: served model and payload (amendment A1)", () => {
  const keyed = (invoke: E2EInvoke, extra: Parameters<typeof routeWith>[2] = {}) => routeWith(invoke, keyedRoute("anthropic"), extra);

  it("needs a serving model from a keyed provider, and accepts the pin or the pin with a date suffix", async () => {
    const pinned = await keyed(async () => tapAnswer({ servedModelId: "claude-haiku-5-5" })).generate(channelRequest());
    expect(pinned.result.status).toBe("ok");
    expect(pinned.receipt).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-5-5", servedModelId: "claude-haiku-5-5", outcome: "ok" });
    const dated = await keyed(async () => tapAnswer({ servedModelId: "claude-haiku-5-5-20261001" })).generate(channelRequest());
    expect(dated.result.status).toBe("ok");
    expect(dated.receipt.servedModelId).toBe("claude-haiku-5-5-20261001");
    const other = await keyed(async () => tapAnswer({ servedModelId: "claude-sonnet-5-5" })).generate(channelRequest());
    expect(other.result).toMatchObject({ status: "error", code: "invalid-output" });
    expect(other.receipt).toMatchObject({ outcome: "invalid-output", servedModelId: "claude-sonnet-5-5" });
    const unknown = await keyed(async () => tapAnswer({ servedModelId: null })).generate(channelRequest());
    expect(unknown.result).toMatchObject({ status: "error", code: "invalid-output" });
    expect((unknown.result as { message: string }).message).toMatch(/serv/);
  });

  it("lets Bedrock, which reports no serving model, answer with none, and records OpenRouter's upstream", async () => {
    const bedrock = await routeWith(async () => tapAnswer({ servedModelId: null })).generate(channelRequest());
    expect(bedrock.result.status).toBe("ok");
    expect(bedrock.receipt.servedModelId).toBeNull();
    const openrouter = await routeWith(async () => tapAnswer({ servedModelId: "anthropic/claude-haiku-5.5", servedUpstream: "Anthropic" }), keyedRoute("openrouter")).generate(channelRequest());
    expect(openrouter.receipt).toMatchObject({ provider: "openrouter", servedModelId: "anthropic/claude-haiku-5.5", servedUpstream: "Anthropic", outcome: "ok" });
  });

  it("hands the provider payload digest on, from a call that completed or answered badly", async () => {
    const digest = "a".repeat(64);
    const ok = await routeWith(async () => tapAnswer({ providerPayloadSha256: digest })).generate(channelRequest());
    expect(ok.providerPayloadSha256).toBe(digest);
    const bad = await routeWith(async () => tapAnswer({ providerPayloadSha256: digest, servedModelId: "other-model" })).generate(channelRequest());
    expect(bad.providerPayloadSha256).toBe(digest);
  });

  it("passes the proxy's final-payload check to the provider call, and answers refused-credential-match when it refuses", async () => {
    const seen: Array<(payload: unknown) => void> = [];
    const route = routeWith(async (input) => {
      seen.push(input.inspectPayload!);
      input.inspectPayload!({ messages: ["clean"] });
      input.inspectPayload!({ messages: ["has the-secret"] });
      return tapAnswer();
    });
    const inspectPayload = (payload: unknown) => { if (JSON.stringify(payload).includes("the-secret")) throw new E2EPayloadRefusedError(); };
    const refused = await route.generate(channelRequest(), { inspectPayload });
    expect(refused.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(refused.receipt).toMatchObject({ outcome: "refused-credential-match", inputTokens: 0, outputTokens: 0, responseSha256: null });
    expect(seen).toHaveLength(1);
  });

  it("charges the reserved bound when the provider failed after it had started to answer", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => { throw Object.assign(new Error("stream broke"), { mayHaveBeenBilled: true }); }, bedrockRoute(), { dayBudget });
    const outcome = await route.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "provider-error" });
    expect(outcome.receipt.inputTokens).toBeGreaterThan(500);
    expect(outcome.chargedInputTokens).toBe(outcome.receipt.inputTokens);
    const unbilled = await routeWith(async () => { throw new Error("refused at the door"); }).generate(channelRequest());
    expect(unbilled.receipt.inputTokens).toBe(0);
  });

  it("offers the secrets its invoke holds, so the proxy can add them to the credential scan", () => {
    const invoke = Object.assign(async () => tapAnswer(), { secrets: ["sk-ant-api03-held-in-memory-1234"] });
    expect(routeWith(invoke).secretValues).toEqual(["sk-ant-api03-held-in-memory-1234"]);
    expect(routeWith(async () => tapAnswer()).secretValues).toEqual([]);
  });
});
