import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2EModelReceiptSchema, e2eModelRouteInvokedIdentifier } from "../../packages/contracts/src/e2e-model-channel.js";
import * as modelRuntime from "../../packages/model-runtime/src/index.js";
import {
  createGovernedE2EModelRoute,
  createInMemoryE2EDayBudget,
  E2EPayloadRefusedError,
  type E2EInvoke,
  type E2EInvokeInput,
} from "../../packages/model-runtime/src/e2e-route.js";
import { MODEL_ID, bedrockRoute, call, channelRequest, keyedRoute, loweredBudgets, tapAnswer } from "../support/e2e-model-fixtures.js";

afterEach(() => { vi.useRealTimers(); });

function routeWith(invoke: E2EInvoke, definition = bedrockRoute(), extra: Partial<Parameters<typeof createGovernedE2EModelRoute>[1]> = {}) {
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  return createGovernedE2EModelRoute(definition, { invoke, now: () => (clock += 5), dayBudget: createInMemoryE2EDayBudget(), ...extra });
}

describe("the in-memory day budget settles a call that was never sent like the broker's does", () => {
  it("releases both the tokens and the call count at release(), and only the tokens' difference at settle", async () => {
    const budget = createInMemoryE2EDayBudget();
    const sent = (await budget.reserve(2_000, { maxInputTokens: 10_000, maxCalls: 5 }))!;
    const unsent = (await budget.reserve(3_000, { maxInputTokens: 10_000, maxCalls: 5 }))!;
    await unsent.release();
    expect(budget.snapshot()).toEqual({ usedInputTokens: 2_000, usedCalls: 1 });
    await sent.settle(900);
    expect(budget.snapshot()).toEqual({ usedInputTokens: 900, usedCalls: 1 });
  });

  it("charges the reserved bound and keeps the call when a sent call reports zero input tokens (never a release)", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => tapAnswer({ usage: { inputTokens: 0, outputTokens: 5 } }), bedrockRoute(), { dayBudget });
    const { receipt, chargedInputTokens } = await route.generate(channelRequest());
    expect(receipt.outcome).toBe("invalid-output");
    expect(chargedInputTokens).toBeGreaterThanOrEqual(1_024);
    expect(dayBudget.snapshot()).toEqual({ usedInputTokens: chargedInputTokens, usedCalls: 1 });
  });

  it("leaves nothing spent after a credential refusal through the route", async () => {
    const dayBudget = createInMemoryE2EDayBudget();
    const route = routeWith(async () => { throw new E2EPayloadRefusedError(); }, bedrockRoute(), { dayBudget });
    const { receipt } = await route.generate(channelRequest());
    expect(receipt.outcome).toBe("refused-credential-match");
    expect(dayBudget.snapshot()).toEqual({ usedInputTokens: 0, usedCalls: 0 });
  });
});

describe("governed e2e model route: the call it makes", () => {

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

  it("F2: needs a day budget, whose limits are the definition's", async () => {
    expect(() => createGovernedE2EModelRoute(bedrockRoute(), { invoke: async () => tapAnswer(), now: Date.now } as never)).toThrow(/day budget/);
    const limits: unknown[] = [];
    const dayBudget = { reserve: (_tokens: number, given: unknown) => { limits.push(given); return { settle: () => undefined, release: () => undefined }; } };
    const route = routeWith(async () => tapAnswer(), bedrockRoute({ budgets: loweredBudgets({ maxInputTokensPerProjectDay: 50_000, maxCallsPerProjectDay: 7 }) }), { dayBudget });
    await route.generate(channelRequest());
    expect(limits).toEqual([{ maxInputTokens: 50_000, maxCalls: 7 }]);
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

  it("F7: a day budget that throws gives a budget receipt, and one that fails to settle gives a provider-error receipt", async () => {
    const invoke = vi.fn(async () => tapAnswer());
    const reserveFails = routeWith(invoke, bedrockRoute(), { dayBudget: { reserve: () => { throw new Error("table unreachable"); } } });
    const refused = await reserveFails.generate(channelRequest());
    expect(refused.result).toMatchObject({ status: "error", code: "budget" });
    expect(refused.receipt.outcome).toBe("budget");
    expect(invoke).not.toHaveBeenCalled();
    const settleFails = routeWith(invoke, bedrockRoute(), { dayBudget: { reserve: () => ({ settle: () => { throw new Error("table unreachable"); }, release: () => { throw new Error("table unreachable"); } }) } });
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

  it("offers the secrets its invoke holds, so the proxy can add them to the credential scan", () => {
    const invoke = Object.assign(async () => tapAnswer(), { secrets: ["sk-ant-api03-held-in-memory-1234"] });
    expect(routeWith(invoke).secretValues).toEqual(["sk-ant-api03-held-in-memory-1234"]);
    expect(routeWith(async () => tapAnswer()).secretValues).toEqual([]);
  });
});
