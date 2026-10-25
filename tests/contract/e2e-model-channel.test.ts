import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import * as barrel from "../../packages/contracts/src/index.js";
import { E2E_DEFAULT_LIMITS } from "../../packages/contracts/src/e2e.js";
import {
  E2E_AGENT_TOOL_NAMES,
  E2E_MODEL_CHANNEL_SOCKET_PATH,
  E2E_MODEL_CHANNEL_STEP_PATH,
  E2E_MODEL_FREE_LIMITS,
  E2E_MODEL_FREE_LIMITS_BEFORE_RUN_1,
  E2EModelChannelStepMarkerSchema,
  E2EModelDayBudgetRequestSchema,
  E2EModelDayBudgetResponseSchema,
  e2eEffectiveRoundLimits,
  e2eEffectiveRoundLimitsBeforeRun1,
  e2eModelRouteRevisionNumber,
  e2eScannableEmailLocalPart,
  E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES,
  E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES,
  E2E_MODEL_ROUTE_DEFAULT_BUDGETS,
  E2EAgentActionLedgerSchema,
  E2E_MODEL_PROVIDERS,
  E2EAgentTraceBindingSchema,
  E2EModelChannelRequestSchema,
  E2EModelChannelResponseSchema,
  E2EModelReceiptSchema,
  E2EModelRouteDefinitionSchema,
  checkE2EGroupModelBudget,
  crossCheckE2EAgentLedgerReceipts,
  checkE2EStepModelAccounting,
  e2eAgentValueDigest,
  e2eAgentValueKeyId,
  e2eModelReceiptAdmissibleForRound,
  e2eServedModelMatchesPin,
  e2eModelRouteInvokedIdentifier,
  e2eModelRouteRevision,
  generateE2EAgentValueKey,
  isVerifiedE2EAgentActionLedger,
  parseVerifiedE2EAgentActionLedger,
  reviewCapturedE2EAgentTrace,
  type VerifiedE2EAgentActionLedger,
} from "../../packages/contracts/src/e2e-model-channel.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const RUN_ID = "7f1c2a4e-5b6d-4c8e-9f01-23456789abcd";
const KEY = "ab".repeat(32);
const CASE_ID = "case-orders-export";
const hmac = (value: string) => e2eAgentValueDigest(KEY, value);
const D = E2E_MODEL_ROUTE_DEFAULT_BUDGETS;
const PROFILE_ARN = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5";

function route(overrides: Record<string, unknown> = {}) {
  return {
    routeId: "e2e-act-haiku", revision: 1, scope: "standard", provider: "amazon-bedrock", region: "us-east-1",
    modelId: "us.anthropic.claude-haiku-5-5", inferenceProfileArn: null,
    secretArn: null, openRouter: null,
    budgets: { ...D }, promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: "low", vision: false, ...overrides,
  };
}
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf";
const OPENROUTER_POLICY = { allowFallbacks: false, requireParameters: true, dataCollection: "deny", only: [] };
function keyedRoute(provider: "anthropic" | "openai" | "openrouter", overrides: Record<string, unknown> = {}) {
  const modelId = { anthropic: "claude-haiku-5-5", openai: "gpt-5.4-mini", openrouter: "anthropic/claude-haiku-5.5" }[provider];
  return route({ provider, region: null, modelId, secretArn: SECRET_ARN, openRouter: provider === "openrouter" ? OPENROUTER_POLICY : null, ...overrides });
}
function scriptedRoute(overrides: Record<string, unknown> = {}) {
  return route({ routeId: "rovara-scripted/v1", scope: "qualification", provider: "rovara-scripted", region: null, modelId: "scripted-v1", effort: null, ...overrides });
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    prompt: [
      { role: "system", content: "You are an autonomous end-to-end testing agent." },
      { role: "user", content: [{ type: "text", text: "Execute this test step: export the orders as CSV" }] },
    ],
    tools: [
      { type: "function", name: "tap", description: "Tap one node", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false } },
      { type: "function", name: "complete_step", description: "Conclude the step", inputSchema: { type: "object", properties: { status: { type: "string" } } } },
    ],
    toolChoice: { type: "required" },
    ...overrides,
  };
}
function request(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1, callIndex: 0, call: call(), ...overrides };
}

const T0 = Date.parse("2026-10-21T10:00:00.000Z");
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: "rcpt-0001", runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1, callIndex: 0,
    routeId: "e2e-act-haiku", routeRevision: "r1-0123456789ab", provider: "amazon-bedrock",
    modelId: "us.anthropic.claude-haiku-5-5", startedAt: at(0), inputTokens: 1200, outputTokens: 80, latencyMs: 900,
    promptSha256: sha("prompt"), responseSha256: sha("response"), outcome: "ok", ...overrides,
  };
}
function receiptAt(index: number, overrides: Record<string, unknown> = {}) {
  return receipt({ receiptId: `rcpt-${String(index).padStart(4, "0")}`, callIndex: index, startedAt: at(index * 5), ...overrides });
}
const failedCall = { outcome: "provider-error", responseSha256: null, outputTokens: 0 };

const GOAL = "Open the orders page and export the orders as a CSV file named orders.csv";
function ledgerAction(overrides: Record<string, unknown> = {}) {
  return {
    tool: "tap", node: { role: "button", name: "Download orders", testId: null },
    valueDigest: null, valueLiteral: null, url: null, snapshotSha256: sha("snapshot-0"), outcome: "ok", ...overrides,
  };
}
function ledgerStep(overrides: Record<string, unknown> = {}) {
  return { stepIndex: 1, goalDigest: sha(GOAL), verdict: "concluded", actions: [ledgerAction()], stopCode: null, receiptIds: ["rcpt-0001"], ...overrides };
}
function ledger(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "rovara-agent-actions/v1", runId: RUN_ID, caseId: CASE_ID, valueKeyId: e2eAgentValueKeyId(KEY), steps: [ledgerStep()], ...overrides };
}
const goals = (map: Record<number, string> = { 1: GOAL }) => new Map(Object.entries(map).map(([key, value]) => [Number(key), value]));
const verify = (raw: unknown, map: Record<number, string> = { 1: GOAL }, valueKey = KEY, expected: { runId: string; caseId: string } = { runId: RUN_ID, caseId: CASE_ID }) =>
  parseVerifiedE2EAgentActionLedger(raw, { goals: goals(map), valueKey, ...expected });
function verified(raw: unknown = ledger(), map: Record<number, string> = { 1: GOAL }): VerifiedE2EAgentActionLedger {
  const result = verify(raw, map);
  if (!result.ok) throw new Error(result.reason);
  return result.ledger;
}

describe("e2e model route definition", () => {
  it("accepts the owner-approved default budgets", () => {
    const parsed = E2EModelRouteDefinitionSchema.parse(route());
    expect(parsed.budgets).toMatchObject({
      maxActionsPerStep: 8, extraModelCallsPerStep: 4, callTimeoutMs: 30_000, maxOutputTokens: 1024, maxInputTokens: 32_000,
      maxPromptBytes: 262_144, stepDeadlineMs: 90_000, maxAgentStepsPerGroup: 3, maxModelCallsPerGroup: 40,
      maxInputTokensPerGroup: 400_000, maxInputTokensPerProjectDay: 2_000_000, maxCallsPerProjectDay: 400,
    });
  });

  it("refuses budgets above the owner caps, so a route can lower them but never raise them", () => {
    for (const [key, value] of [
      ["maxActionsPerStep", 9], ["extraModelCallsPerStep", 5], ["callTimeoutMs", 30_001], ["maxOutputTokens", 1025],
      ["maxInputTokens", 32_001], ["maxPromptBytes", 262_145], ["stepDeadlineMs", 90_001], ["maxAgentStepsPerGroup", 4],
      ["maxModelCallsPerGroup", 41], ["maxInputTokensPerGroup", 400_001], ["maxInputTokensPerProjectDay", 2_000_001], ["maxCallsPerProjectDay", 401],
    ] as const) {
      expect(E2EModelRouteDefinitionSchema.safeParse(route({ budgets: { ...D, [key]: value } })).success, key).toBe(false);
    }
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ budgets: { ...D, maxActionsPerStep: 4 } })).success).toBe(true);
  });

  it("pins provider, protocol, temperature and vision, and refuses unknown keys", () => {
    for (const overrides of [
      { provider: "mystery" }, { promptProtocol: "e2e-0.21.0-act/v1" }, { temperature: 0.2 }, { temperature: 0 }, { sampling: "greedy" }, { thinking: "on" }, { vision: true },
      { fallbackModelId: "x" }, { revision: 0 }, { inferenceProfileArn: "not-an-arn" }, { scope: "production" },
    ]) expect(E2EModelRouteDefinitionSchema.safeParse(route(overrides)).success, JSON.stringify(overrides)).toBe(false);
  });

  it("represents each installation provider with its own required fields (amendment A1)", () => {
    for (const provider of ["anthropic", "openai", "openrouter"] as const) {
      const parsed = E2EModelRouteDefinitionSchema.safeParse(keyedRoute(provider));
      expect(parsed.success, provider).toBe(true);
      expect(e2eModelRouteInvokedIdentifier(E2EModelRouteDefinitionSchema.parse(keyedRoute(provider)))).toBe(keyedRoute(provider).modelId);
      // A keyed provider needs its secret, has no region or profile, and is not a Bedrock route.
      expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute(provider, { secretArn: null })).success, `${provider} without secret`).toBe(false);
      expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute(provider, { secretArn: "not-an-arn" })).success, `${provider} bad arn`).toBe(false);
      expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute(provider, { region: "us-east-1" })).success, `${provider} region`).toBe(false);
      expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute(provider, { inferenceProfileArn: PROFILE_ARN })).success, `${provider} profile`).toBe(false);
    }
    // Bedrock has no secret and no OpenRouter policy.
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ secretArn: SECRET_ARN })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ openRouter: OPENROUTER_POLICY })).success).toBe(false);
    // The OpenRouter policy goes with OpenRouter and only with it, and its safe values are fixed.
    expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute("openrouter", { openRouter: null })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute("anthropic", { openRouter: OPENROUTER_POLICY })).success).toBe(false);
    for (const policy of [{ allowFallbacks: true }, { requireParameters: false }, { dataCollection: "allow" }, { only: ["Bad Slug"] }, { extra: 1 }]) {
      expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute("openrouter", { openRouter: { ...OPENROUTER_POLICY, ...policy } })).success, JSON.stringify(policy)).toBe(false);
    }
    expect(E2EModelRouteDefinitionSchema.safeParse(keyedRoute("openrouter", { openRouter: { ...OPENROUTER_POLICY, only: ["anthropic"] } })).success).toBe(true);
    // The scripted provider carries none of them.
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ secretArn: SECRET_ARN })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ openRouter: OPENROUTER_POLICY })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ effort: "low" })).success).toBe(false);
    // Haiku 5.5 rejects temperature 0, so the definition has no temperature at all, and the provider and secret change the revision.
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ temperature: 0 })).success).toBe(false);
    expect(e2eModelRouteRevision(keyedRoute("anthropic"))).not.toBe(e2eModelRouteRevision(keyedRoute("anthropic", { secretArn: SECRET_ARN.replace("AbCdEf", "ZzZzZz") })));
    expect(E2E_MODEL_PROVIDERS).toEqual(["amazon-bedrock", "openrouter", "anthropic", "openai", "rovara-scripted"]);
  });

  it("allows single slashes between route id segments and nothing else", () => {
    for (const routeId of ["a/b/c", "e2e-act-haiku"]) {
      expect(E2EModelReceiptSchema.safeParse(receipt({ routeId })).success, routeId).toBe(true);
      expect(E2EModelRouteDefinitionSchema.safeParse(route({ routeId })).success, routeId).toBe(true);
    }
    for (const routeId of ["/a", "a/", "a//b", "A/b", "a b", "a/./b", "a".repeat(65)]) {
      expect(E2EModelReceiptSchema.safeParse(receipt({ routeId })).success, routeId).toBe(false);
      expect(E2EModelRouteDefinitionSchema.safeParse(route({ routeId })).success, routeId).toBe(false);
    }
  });

  it("represents the scripted qualification route, and only as a qualification route", () => {
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute()).success).toBe(true);
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ scope: "standard" })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ region: "us-east-1" })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ inferenceProfileArn: PROFILE_ARN })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(scriptedRoute({ routeId: "e2e-act-haiku" })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ routeId: "rovara-scripted/v1" })).success).toBe(false);
    expect(e2eModelRouteRevision(scriptedRoute())).not.toBe(e2eModelRouteRevision(route()));
  });

  it("pins the Bedrock region and says which identifier is invoked", () => {
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ region: null })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ region: "US East" })).success).toBe(false);
    expect(e2eModelRouteInvokedIdentifier(E2EModelRouteDefinitionSchema.parse(route()))).toBe("us.anthropic.claude-haiku-5-5");
    const withArn = E2EModelRouteDefinitionSchema.parse(route({ inferenceProfileArn: PROFILE_ARN }));
    expect(e2eModelRouteInvokedIdentifier(withArn)).toBe(PROFILE_ARN);
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ inferenceProfileArn: PROFILE_ARN, region: "us-west-2" })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ inferenceProfileArn: PROFILE_ARN, modelId: "us.anthropic.claude-sonnet-4-6" })).success).toBe(false);
    const application = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123def456";
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ inferenceProfileArn: application })).success).toBe(true);
  });
});

describe("e2eModelRouteRevision", () => {
  it("is r<revision>-<first 12 hex of the digest of the canonical parsed definition>", () => {
    const definition = E2EModelRouteDefinitionSchema.parse(route({ revision: 3 }));
    const expected = createHash("sha256").update(canonicalJson(definition)).digest("hex").slice(0, 12);
    expect(e2eModelRouteRevision(definition)).toBe(`r3-${expected}`);
  });

  it("is stable when keys are written in another order, at every level", () => {
    const original = route();
    const reordered = Object.fromEntries(Object.entries({ ...original, budgets: Object.fromEntries(Object.entries(D).reverse()) }).reverse());
    expect(Object.keys(reordered)).not.toEqual(Object.keys(original));
    expect(e2eModelRouteRevision(reordered)).toBe(e2eModelRouteRevision(original));
  });

  it("is computed from the parsed form: surrounding whitespace in the routeId does not change it", () => {
    expect(e2eModelRouteRevision(route({ routeId: "  e2e-act-haiku " }))).toBe(e2eModelRouteRevision(route()));
  });

  it("changes when any pinned field or budget changes, and refuses an invalid definition", () => {
    const base = e2eModelRouteRevision(route());
    expect(e2eModelRouteRevision(route({ modelId: "us.anthropic.claude-sonnet-4-6" }))).not.toBe(base);
    expect(e2eModelRouteRevision(route({ region: "us-west-2" }))).not.toBe(base);
    expect(e2eModelRouteRevision(route({ budgets: { ...D, maxActionsPerStep: 6 } }))).not.toBe(base);
    expect(e2eModelRouteRevision(route({ revision: 2 }))).toMatch(/^r2-[0-9a-f]{12}$/);
    expect(() => e2eModelRouteRevision(route({ vision: true }))).toThrow();
  });
});

describe("e2e model channel request", () => {
  it("accepts the bounded doGenerate subset the act loop sends", () => {
    const parsed = E2EModelChannelRequestSchema.parse(request({
      call: call({
        prompt: [
          { role: "system", content: "rules" },
          { role: "user", content: [{ type: "text", text: "Execute this test step: export" }] },
          { role: "assistant", content: [{ type: "text", text: "tapping" }, { type: "tool-call", toolCallId: "call-1", toolName: "tap", input: { target: "n4" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "tap", output: { type: "text", value: "Tapped #n4." } }] },
        ],
        toolChoice: { type: "tool", toolName: "complete_step" },
        maxOutputTokens: 1024,
      }),
    }));
    expect(parsed.call.tools?.map((tool) => tool.name)).toEqual(["tap", "complete_step"]);
  });

  it("refuses a request whose serialized form is over 256 KiB, even when every part is within its own bound", () => {
    expect(E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES).toBe(262_144);
    const chunk = "x".repeat(60_000);
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
    const over = request({ call: call({ prompt: [{ role: "system", content: "rules" }, user(chunk), user(chunk), user(chunk), user(chunk), user(chunk)] }) });
    expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES);
    expect(E2EModelChannelRequestSchema.safeParse(over).success).toBe(false);
    const under = request({ call: call({ prompt: [{ role: "system", content: "rules" }, user(chunk), user(chunk)] }) });
    expect(E2EModelChannelRequestSchema.safeParse(under).success).toBe(true);
  });

  it("counts bytes, not characters, against the 256 KiB bound", () => {
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
    const wide = "é".repeat(40_000);
    const over = request({ call: call({ prompt: [user(wide), user(wide), user(wide), user(wide)] }) });
    expect(JSON.stringify(over).length).toBeLessThan(E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES);
    expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES);
    expect(E2EModelChannelRequestSchema.safeParse(over).success).toBe(false);
  });

  it("refuses an unknown call key, including the options e2e never sends and the channel must not carry", () => {
    for (const key of ["temperature", "providerOptions", "headers", "abortSignal", "responseFormat", "stopSequences", "reasoning", "mystery"]) {
      expect(E2EModelChannelRequestSchema.safeParse(request({ call: { ...call(), [key]: key === "temperature" ? 0 : {} } })).success, key).toBe(false);
    }
    expect(E2EModelChannelRequestSchema.safeParse(request({ extra: true })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ schemaVersion: "rovara-e2e-model-channel/v2" })).success).toBe(false);
  });

  it("refuses provider options on any message or part", () => {
    const withOptions = request({ call: call({ prompt: [{ role: "system", content: "rules", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }] }) });
    expect(E2EModelChannelRequestSchema.safeParse(withOptions).success).toBe(false);
  });

  it("keeps pixels out: no file parts in messages or tool results", () => {
    const withFile = (content: unknown[]) => request({ call: call({ prompt: [{ role: "user", content }] }) });
    expect(E2EModelChannelRequestSchema.safeParse(withFile([{ type: "file", mediaType: "image/png", data: "AAAA" }])).success).toBe(false);
    const toolFile = request({ call: call({ prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "tap", output: { type: "content", value: [{ type: "file", mediaType: "image/png", data: "AAAA" }] } }] }] }) });
    expect(E2EModelChannelRequestSchema.safeParse(toolFile).success).toBe(false);
  });

  it("pins the toolset and the tool choice", () => {
    expect(E2E_AGENT_TOOL_NAMES).toEqual(["tap", "type", "press", "select", "scroll", "navigate", "complete_step"]);
    const tool = (name: string) => ({ type: "function", name, description: "d", inputSchema: { type: "object" } });
    for (const name of ["screenshot", "tap_at", "upload", "type_secret", "observe", "back"]) {
      expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ tools: [tool(name)] }) })).success, name).toBe(false);
    }
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ tools: [{ type: "provider", id: "x.y", name: "z", args: {} }] }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ tools: [tool("tap"), tool("tap")] }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ toolChoice: { type: "none" } }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ toolChoice: { type: "tool", toolName: "screenshot" } }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ toolChoice: { type: "auto" } }) })).success).toBe(true);
  });

  it("bounds maxOutputTokens at 1024, and callIndex (advisory: the worker assigns the real per-step index)", () => {
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ maxOutputTokens: 1025 }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ maxOutputTokens: 0 }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ stepIndex: -1 })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ callIndex: 99 })).success).toBe(true);
    expect(E2EModelChannelRequestSchema.safeParse(request({ callIndex: 100 })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ runId: "not-a-uuid" })).success).toBe(false);
  });
});

describe("e2e model channel response", () => {
  const ok = (content: unknown[], extra: Record<string, unknown> = {}) => ({
    schemaVersion: "rovara-e2e-model-channel/v1",
    receiptId: "rcpt-0001",
    result: { status: "ok", content, finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: { inputTokens: 1200, outputTokens: 80 }, ...extra },
  });

  it("accepts text and tool-call content only", () => {
    const parsed = E2EModelChannelResponseSchema.parse(ok([{ type: "text", text: "tapping" }, { type: "tool-call", toolCallId: "call-1", toolName: "tap", input: "{\"target\":\"n4\"}" }]));
    expect(parsed.result.status).toBe("ok");
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "reasoning", text: "thinking" }])).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "file", mediaType: "image/png", data: "AAAA" }])).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "tool-result", toolCallId: "c", toolName: "tap", result: {} }])).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "tool-call", toolCallId: "c", toolName: "screenshot", input: "{}" }])).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "tool-call", toolCallId: "c", toolName: "tap", input: "{}", providerExecuted: true }])).success).toBe(false);
  });

  it("uses the same token bounds as an ok receipt: 32000 in, 1024 out", () => {
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "text", text: "x" }], { usage: { inputTokens: 32_000, outputTokens: 1024 } })).success).toBe(true);
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "text", text: "x" }], { usage: { inputTokens: 32_001, outputTokens: 80 } })).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "text", text: "x" }], { usage: { inputTokens: 10, outputTokens: 1025 } })).success).toBe(false);
  });

  it("never lets a truncated or filtered answer look like success", () => {
    for (const unified of ["length", "error", "content-filter", "other"]) {
      expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "text", text: "x" }], { finishReason: { unified, raw: null } })).success, unified).toBe(false);
    }
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "text", text: "x" }], { finishReason: { unified: "stop", raw: null } })).success).toBe(true);
  });

  it("limits a response to 32 KiB", () => {
    expect(E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES).toBe(32_768);
    const part = { type: "text", text: "y".repeat(4000) };
    expect(E2EModelChannelResponseSchema.safeParse(ok(Array.from({ length: 9 }, () => part))).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok(Array.from({ length: 4 }, () => part))).success).toBe(true);
  });

  it("carries a refusal or failure as a typed error, and every received request has a receipt", () => {
    const error = (code: string, receiptId: string | null = "rcpt-0002") => ({ schemaVersion: "rovara-e2e-model-channel/v1", receiptId, result: { status: "error", code, message: "refused" } });
    for (const code of ["provider-error", "timeout", "budget", "refused-credential-match", "refused-protocol", "refused-busy", "invalid-output"]) {
      expect(E2EModelChannelResponseSchema.safeParse(error(code)).success, code).toBe(true);
      expect(E2EModelChannelResponseSchema.safeParse(error(code, null)).success, `${code} without receipt`).toBe(false);
    }
    expect(E2EModelChannelResponseSchema.safeParse(error("ok")).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(error("channel-protocol")).success).toBe(false);
  });
});

describe("e2e model receipt", () => {
  it("accepts a successful call", () => {
    expect(E2EModelReceiptSchema.parse(receipt()).outcome).toBe("ok");
  });

  it("refuses outputTokens over 1024 and an ok receipt over the 32000 input bound", () => {
    expect(E2EModelReceiptSchema.safeParse(receipt({ outputTokens: 1025 })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ inputTokens: 32_001 })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ inputTokens: 33_500, outcome: "budget" })).success).toBe(true);
    expect(E2EModelReceiptSchema.safeParse(receipt({ inputTokens: 64_001, outcome: "budget" })).success).toBe(false);
  });

  it("holds an ok call to the call timeout, and records when each call started", () => {
    expect(E2EModelReceiptSchema.safeParse(receipt({ latencyMs: 30_000 })).success).toBe(true);
    expect(E2EModelReceiptSchema.safeParse(receipt({ latencyMs: 30_001 })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ outcome: "timeout", responseSha256: null, outputTokens: 0, latencyMs: 31_000 })).success).toBe(true);
    const withoutStart: Record<string, unknown> = receipt();
    delete withoutStart["startedAt"];
    expect(E2EModelReceiptSchema.safeParse(withoutStart).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ startedAt: "yesterday" })).success).toBe(false);
  });

  it("requires a response digest exactly when a response existed", () => {
    expect(E2EModelReceiptSchema.safeParse(receipt({ responseSha256: null })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ outcome: "invalid-output" })).success).toBe(true);
    for (const outcome of ["provider-error", "timeout"]) {
      expect(E2EModelReceiptSchema.safeParse(receipt({ outcome, responseSha256: null, outputTokens: 0 })).success, outcome).toBe(true);
      expect(E2EModelReceiptSchema.safeParse(receipt({ outcome, responseSha256: sha("late") })).success, outcome).toBe(false);
    }
  });

  it("makes every refusal a call that never reached the provider", () => {
    for (const outcome of ["refused-credential-match", "refused-protocol", "refused-busy"]) {
      const refused = receipt({ outcome, responseSha256: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 });
      expect(E2EModelReceiptSchema.safeParse(refused).success, outcome).toBe(true);
      expect(E2EModelReceiptSchema.safeParse({ ...refused, inputTokens: 10 }).success, outcome).toBe(false);
      expect(E2EModelReceiptSchema.safeParse({ ...refused, responseSha256: sha("x") }).success, outcome).toBe(false);
    }
  });

  it("refuses unknown keys, a provider outside the installation set and a malformed digest", () => {
    expect(E2EModelReceiptSchema.safeParse({ ...receipt(), prompt: "text" }).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ provider: "mystery" })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ promptSha256: "ABC" })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ outcome: "passed" })).success).toBe(false);
  });

  it("accepts a scripted receipt, but never for a non-qualification round", () => {
    const scripted = E2EModelReceiptSchema.parse(receipt({ provider: "rovara-scripted", routeId: "rovara-scripted/v1", modelId: "scripted-v1" }));
    expect(e2eModelReceiptAdmissibleForRound(scripted, "qualification")).toEqual({ ok: true });
    expect(e2eModelReceiptAdmissibleForRound(scripted, "standard").ok).toBe(false);
    const real = E2EModelReceiptSchema.parse(receipt());
    expect(e2eModelReceiptAdmissibleForRound(real, "standard")).toEqual({ ok: true });
    expect(e2eModelReceiptAdmissibleForRound(real, "qualification")).toEqual({ ok: true });
    expect(E2EModelReceiptSchema.safeParse(receipt({ provider: "rovara-scripted" })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ routeId: "rovara-scripted/v1" })).success).toBe(false);
  });
});

describe("served model on the receipt (amendment A1)", () => {
  it("matches an exact pin or the pin plus a date suffix, and nothing else", () => {
    expect(e2eServedModelMatchesPin("claude-haiku-5-5", "claude-haiku-5-5")).toBe(true);
    expect(e2eServedModelMatchesPin("claude-haiku-5-5", "claude-haiku-5-5-20261001")).toBe(true);
    expect(e2eServedModelMatchesPin("anthropic/claude-haiku-5.5", "anthropic/claude-haiku-5.5-2026-10-01")).toBe(true);
    for (const served of ["claude-sonnet-5-5", "claude-haiku-5-5-latest", "claude-haiku-5-55", "claude-haiku-5-5-2026", "xclaude-haiku-5-5", ""]) {
      expect(e2eServedModelMatchesPin("claude-haiku-5-5", served), served).toBe(false);
    }
  });

  it("takes the served model and upstream as nullable fields that default to null, bounded in length", () => {
    expect(E2EModelReceiptSchema.parse(receipt())).toMatchObject({ servedModelId: null, servedUpstream: null });
    expect(E2EModelReceiptSchema.parse(receipt({ provider: "anthropic", modelId: "claude-haiku-5-5", servedModelId: "claude-haiku-5-5-20261001" }))).toMatchObject({ provider: "anthropic", servedModelId: "claude-haiku-5-5-20261001" });
    expect(E2EModelReceiptSchema.parse(receipt({ provider: "openrouter", modelId: "anthropic/claude-haiku-5.5", servedModelId: "anthropic/claude-haiku-5.5", servedUpstream: "Anthropic" })).servedUpstream).toBe("Anthropic");
    expect(E2EModelReceiptSchema.safeParse(receipt({ servedModelId: "x".repeat(201) })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ servedUpstream: "" })).success).toBe(false);
    for (const provider of ["openai", "openrouter", "anthropic"]) expect(E2EModelReceiptSchema.safeParse(receipt({ provider })).success, provider).toBe(true);
  });

  it("fails a step whose receipt names a served model other than the pin", () => {
    const identity = { runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1, routeId: "e2e-act-haiku", routeRevision: "r1-0123456789ab", provider: "anthropic" as const, modelId: "claude-haiku-5-5" };
    const check = (receipts: unknown[]) => checkE2EStepModelAccounting({ roundScope: "standard", identity, reportModelCalls: 1, receipts, maxModelCallsPerStep: 12 });
    const mine = (overrides: Record<string, unknown>) => receiptAt(0, { provider: "anthropic", modelId: "claude-haiku-5-5", ...overrides });
    expect(check([mine({ servedModelId: "claude-haiku-5-5" })])).toMatchObject({ ok: true });
    expect(check([mine({ servedModelId: "claude-haiku-5-5-20261001" })])).toMatchObject({ ok: true });
    expect(check([mine({ servedModelId: "claude-sonnet-5-5" })])).toMatchObject({ ok: false, code: "receipt-served-model-mismatch" });
  });

  it("allows an ok receipt with no served model only for Bedrock and the scripted provider (R7)", () => {
    const identityFor = (provider: "anthropic" | "openai" | "openrouter" | "amazon-bedrock", modelId: string) => ({ runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1, routeId: "e2e-act-haiku", routeRevision: "r1-0123456789ab", provider, modelId });
    const run = (provider: "anthropic" | "openai" | "openrouter" | "amazon-bedrock", modelId: string, overrides: Record<string, unknown>) =>
      checkE2EStepModelAccounting({ roundScope: "standard", identity: identityFor(provider, modelId), reportModelCalls: 0, receipts: [receiptAt(0, { provider, modelId, ...overrides })], maxModelCallsPerStep: 12 });
    for (const [provider, modelId] of [["anthropic", "claude-haiku-5-5"], ["openai", "gpt-5.4-mini"], ["openrouter", "anthropic/claude-haiku-5.5"]] as const) {
      expect(checkE2EStepModelAccounting({ roundScope: "standard", identity: identityFor(provider, modelId), reportModelCalls: 1, receipts: [receiptAt(0, { provider, modelId, servedModelId: null })], maxModelCallsPerStep: 12 }), provider)
        .toMatchObject({ ok: false, code: "receipt-served-model-mismatch" });
      // A call that never produced an answer has nothing to name.
      expect(run(provider, modelId, { ...failedCall, servedModelId: null }), `${provider} failed call`).toMatchObject({ ok: true });
    }
    expect(checkE2EStepModelAccounting({ roundScope: "standard", identity: identityFor("amazon-bedrock", "us.anthropic.claude-haiku-5-5"), reportModelCalls: 1, receipts: [receiptAt(0, { servedModelId: null })], maxModelCallsPerStep: 12 })).toMatchObject({ ok: true });
    const scriptedIdentity = { ...identityFor("amazon-bedrock", "scripted-v1"), routeId: "rovara-scripted/v1", provider: "rovara-scripted" as never };
    expect(checkE2EStepModelAccounting({ roundScope: "qualification", identity: scriptedIdentity, reportModelCalls: 1, receipts: [receiptAt(0, { provider: "rovara-scripted", routeId: "rovara-scripted/v1", modelId: "scripted-v1", servedModelId: null })], maxModelCallsPerStep: 12 })).toMatchObject({ ok: true });
  });
});

describe("step model-call accounting (report calls against worker receipts)", () => {
  const identity = { runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1, routeId: "e2e-act-haiku", routeRevision: "r1-0123456789ab", provider: "amazon-bedrock" as const, modelId: "us.anthropic.claude-haiku-5-5" };
  const check = (receipts: unknown[], reportModelCalls: number, roundScope: "standard" | "qualification" = "standard", maxModelCallsPerStep = 12) =>
    checkE2EStepModelAccounting({ roundScope, identity, reportModelCalls, receipts, maxModelCallsPerStep });

  it("matches every report call to exactly one ok receipt", () => {
    expect(check([receiptAt(0), receiptAt(1), receiptAt(2)], 3)).toEqual({ ok: true, okCalls: 3, totalCalls: 3 });
  });

  it("allows extra receipts only with a non-ok outcome, and counts them all", () => {
    const receipts = [receiptAt(0, failedCall), receiptAt(1), receiptAt(2, { outcome: "invalid-output" }), receiptAt(3), receiptAt(4, { outcome: "refused-protocol", responseSha256: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 })];
    expect(check(receipts, 2)).toEqual({ ok: true, okCalls: 2, totalCalls: 5 });
  });

  it("fails when the report has more or fewer calls than ok receipts", () => {
    expect(check([receiptAt(0), receiptAt(1)], 3)).toMatchObject({ ok: false, code: "report-calls-mismatch" });
    expect(check([receiptAt(0), receiptAt(1)], 1)).toMatchObject({ ok: false, code: "report-calls-mismatch" });
    expect(check([], 1)).toMatchObject({ ok: false, code: "report-calls-mismatch" });
  });

  it("fails when all receipts, ok or not, exceed the step's call budget", () => {
    const thirteen = Array.from({ length: 13 }, (_, index) => receiptAt(index, failedCall));
    expect(check(thirteen, 0)).toMatchObject({ ok: false, code: "over-step-budget" });
    expect(check(thirteen.slice(0, 12), 0)).toEqual({ ok: true, okCalls: 0, totalCalls: 12 });
    expect(check(thirteen.slice(0, 12), 0, "standard", 8)).toMatchObject({ ok: false, code: "over-step-budget" });
  });

  it("fails on a dropped, duplicated or reordered receipt", () => {
    expect(check([receiptAt(0), receiptAt(2)], 2)).toMatchObject({ ok: false, code: "receipt-index-gap" });
    expect(check([receiptAt(0), receiptAt(0, { receiptId: "rcpt-dup" })], 2)).toMatchObject({ ok: false, code: "receipt-index-gap" });
    expect(check([receiptAt(0, { startedAt: at(50) }), receiptAt(1, { startedAt: at(5) })], 2)).toMatchObject({ ok: false, code: "receipt-order" });
  });

  it("fails on a receipt of another run, case, step or route", () => {
    for (const overrides of [{ runId: "11111111-2222-4333-8444-555555555555" }, { caseId: "other" }, { stepIndex: 2 }, { routeId: "other-route" }, { routeRevision: "r2-0123456789ab" }]) {
      expect(check([receiptAt(0, overrides)], 1), JSON.stringify(overrides)).toMatchObject({ ok: false, code: "receipt-identity-mismatch" });
    }
    expect(check([{ ...receiptAt(0), extra: 1 }], 1)).toMatchObject({ ok: false, code: "receipt-malformed" });
  });

  it("refuses a scripted receipt outside a qualification round", () => {
    const scripted = [receiptAt(0, { provider: "rovara-scripted", routeId: "rovara-scripted/v1", modelId: "scripted-v1" })];
    const scriptedIdentity = { ...identity, routeId: "rovara-scripted/v1", provider: "rovara-scripted" as const, modelId: "scripted-v1" };
    const run = (roundScope: "standard" | "qualification") => checkE2EStepModelAccounting({ roundScope, identity: scriptedIdentity, reportModelCalls: 1, receipts: scripted, maxModelCallsPerStep: 12 });
    expect(run("standard")).toMatchObject({ ok: false, code: "receipt-not-admissible" });
    expect(run("qualification")).toEqual({ ok: true, okCalls: 1, totalCalls: 1 });
  });

  it("clamps the step limit to the D2 cap of 8+4, whatever the caller passes", () => {
    const thirteen = Array.from({ length: 13 }, (_, index) => receiptAt(index, failedCall));
    expect(check(thirteen, 0, "standard", 99)).toMatchObject({ ok: false, code: "over-step-budget" });
    expect(check(thirteen.slice(0, 12), 0, "standard", 99)).toEqual({ ok: true, okCalls: 0, totalCalls: 12 });
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(check([receiptAt(0)], 1, "standard", bad), String(bad)).toMatchObject({ ok: false, code: "over-step-budget" });
    }
  });

  it("classifies a refused-budget receipt as the budget outcome, not as an over-budget step", () => {
    const refusal = { outcome: "budget", responseSha256: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    const twelveThenRefused = [...Array.from({ length: 12 }, (_, index) => receiptAt(index, failedCall)), receiptAt(12, refusal)];
    expect(check(twelveThenRefused, 0)).toMatchObject({ ok: false, code: "budget-refused" });
    expect(check([receiptAt(0), receiptAt(1, refusal)], 1)).toMatchObject({ ok: false, code: "budget-refused" });
    const thirteenWorkerSent = Array.from({ length: 13 }, (_, index) => receiptAt(index, failedCall));
    expect(check(thirteenWorkerSent, 0)).toMatchObject({ ok: false, code: "over-step-budget" });
  });

  it("compares the receipt's provider and model to the route, and refuses a repeated receipt id", () => {
    expect(check([receiptAt(0, { modelId: "us.anthropic.claude-sonnet-4-6" })], 1)).toMatchObject({ ok: false, code: "receipt-identity-mismatch" });
    expect(check([receiptAt(0, { provider: "rovara-scripted", routeId: "rovara-scripted/v1" })], 1, "qualification")).toMatchObject({ ok: false });
    expect(check([receiptAt(0), receiptAt(1, { receiptId: "rcpt-0000" })], 2)).toMatchObject({ ok: false, code: "receipt-duplicate-id" });
  });

  it("checks the group budget over every receipt of the group, ok or not", () => {
    const budgets = { ...D };
    const withStep = (stepIndex: number, count: number, overrides: Record<string, unknown> = {}) =>
      Array.from({ length: count }, (_, index) => receiptAt(index, { stepIndex, receiptId: `rcpt-${stepIndex}-${index}`, inputTokens: 1000, ...overrides }));
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 12), ...withStep(2, 12), ...withStep(3, 12)], budgets })).toEqual({ ok: true, totalCalls: 36, inputTokens: 36_000, agentSteps: 3 });
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 2), ...withStep(2, 2), ...withStep(3, 2), ...withStep(4, 1)], budgets })).toMatchObject({ ok: false, code: "over-group-budget" });
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 8, { inputTokens: 32_000 }), ...withStep(2, 5, { inputTokens: 32_000 })], budgets })).toMatchObject({ ok: false, code: "over-group-budget" });
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 8, { inputTokens: 32_000 }), ...withStep(2, 4, { inputTokens: 32_000 })], budgets })).toMatchObject({ ok: true });
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 3)], budgets: { ...budgets, maxModelCallsPerGroup: 2 } })).toMatchObject({ ok: false, code: "over-group-budget" });
    expect(checkE2EGroupModelBudget({ receipts: [{ nope: 1 }], budgets })).toMatchObject({ ok: false, code: "receipt-malformed" });
    const loose = { maxModelCallsPerGroup: 99, maxInputTokensPerGroup: 99_999_999, maxAgentStepsPerGroup: 99 };
    const atCaps = [...withStep(1, 12), ...withStep(2, 12), ...withStep(3, 12)];
    expect(checkE2EGroupModelBudget({ receipts: atCaps, budgets: loose })).toMatchObject({ ok: true });
    expect(checkE2EGroupModelBudget({ receipts: [...atCaps, ...withStep(4, 1)], budgets: loose })).toMatchObject({ ok: false, code: "over-group-budget" });
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 5, { inputTokens: 32_000 }), ...withStep(2, 8, { inputTokens: 32_000 })], budgets: loose })).toMatchObject({ ok: false, code: "over-group-budget" });
    expect(checkE2EGroupModelBudget({ receipts: withStep(1, 1), budgets: { ...budgets, maxModelCallsPerGroup: Number.NaN } })).toMatchObject({ ok: false, code: "over-group-budget" });
    const refusal = { outcome: "budget", responseSha256: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    expect(checkE2EGroupModelBudget({ receipts: [...withStep(1, 2), ...withStep(2, 1, refusal)], budgets })).toMatchObject({ ok: false, code: "budget-refused" });
  });
});

describe("keyed value digests", () => {
  it("are HMACs under a per-run key, not bare hashes", () => {
    expect(hmac("orders.csv")).toMatch(/^[a-f0-9]{64}$/);
    expect(hmac("orders.csv")).not.toBe(sha("orders.csv"));
    expect(e2eAgentValueDigest("cd".repeat(32), "orders.csv")).not.toBe(hmac("orders.csv"));
    expect(hmac("a")).not.toBe(hmac("b"));
    expect(() => e2eAgentValueDigest("short", "x")).toThrow();
    const generated = generateE2EAgentValueKey();
    expect(generated).toMatch(/^[a-f0-9]{64}$/);
    expect(generateE2EAgentValueKey()).not.toBe(generated);
  });
});

describe("e2e agent action ledger", () => {
  it("parses the plain shape (a plain parse is not a verified ledger)", () => {
    const parsed = E2EAgentActionLedgerSchema.parse(ledger());
    expect(parsed.steps[0]?.actions[0]?.tool).toBe("tap");
    expect(isVerifiedE2EAgentActionLedger(parsed)).toBe(false);
  });

  it("has one entry point that returns the branded, frozen, verified ledger", () => {
    const result = verify(ledger());
    expect(result.ok).toBe(true);
    const value = verified();
    expect(isVerifiedE2EAgentActionLedger(value)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.steps[0])).toBe(true);
    expect(isVerifiedE2EAgentActionLedger(structuredClone(value))).toBe(false);
    // The plain schema type is not assignable to the verified type.
    const plain = E2EAgentActionLedgerSchema.parse(ledger());
    // @ts-expect-error a plain parse must not satisfy a reader that requires a verified ledger
    const rejected: VerifiedE2EAgentActionLedger = plain;
    expect(rejected).toBe(plain);
  });

  it("binds the ledger to its run and case: a ledger from another run or case fails", () => {
    expect(verify(ledger(), { 1: GOAL }, KEY, { runId: "11111111-2222-4333-8444-555555555555", caseId: CASE_ID }).ok).toBe(false);
    expect(verify(ledger(), { 1: GOAL }, KEY, { runId: RUN_ID, caseId: "other-case" }).ok).toBe(false);
    expect(verify(ledger({ runId: "11111111-2222-4333-8444-555555555555" })).ok).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse({ ...ledger(), runId: undefined }).success).toBe(false);
  });

  it("refuses a typed digest written under another run's key, even with no literal (the replayed-ledger probe)", () => {
    const foreignKey = "cd".repeat(32);
    const typedForeign = ledgerAction({ tool: "type", node: { role: "textbox", name: "File name", testId: null }, valueDigest: e2eAgentValueDigest(foreignKey, "whatever") });
    const foreignLedger = ledger({ valueKeyId: e2eAgentValueKeyId(foreignKey), steps: [ledgerStep({ actions: [typedForeign], receiptIds: [] })] });
    expect(verify(foreignLedger).ok).toBe(false);
    expect(verify(foreignLedger, { 1: GOAL }, foreignKey).ok).toBe(true);
    expect(e2eAgentValueKeyId(KEY)).toMatch(/^[a-f0-9]{64}$/);
    expect(e2eAgentValueKeyId(KEY)).not.toBe(KEY);
    expect(e2eAgentValueKeyId(KEY)).not.toBe(e2eAgentValueKeyId(foreignKey));
    expect(verify(ledger({ valueKeyId: sha(KEY) })).ok).toBe(false);
  });

  it("refuses a scroll that records no direction digest", () => {
    const withAction = (action: unknown) => ledger({ steps: [ledgerStep({ actions: [action], receiptIds: [] })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "scroll", node: null, valueDigest: null }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "scroll", node: null, valueDigest: hmac("down") }))).success).toBe(true);
  });

  it("accepts a typed value as a keyed digest, with the literal only when it is the goal's own text", () => {
    const typed = ledgerAction({ tool: "type", node: { role: "textbox", name: "File name", testId: "file-name" }, valueDigest: hmac("orders.csv"), valueLiteral: "orders.csv" });
    expect(verify(ledger({ steps: [ledgerStep({ actions: [typed], receiptIds: [] })] })).ok).toBe(true);
  });

  it("refuses a raw value that does not appear in the goal, without echoing it", () => {
    const typed = ledgerAction({ tool: "type", node: { role: "textbox", name: "File name", testId: null }, valueDigest: hmac("hunter2-secret"), valueLiteral: "hunter2-secret" });
    const result = verify(ledger({ steps: [ledgerStep({ actions: [typed], receiptIds: [] })] }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2-secret");
  });

  it("refuses a literal whose keyed digest is not the recorded one, and a literal with no digest", () => {
    const base = { tool: "type", node: { role: "textbox", name: "File name", testId: null } };
    const withAction = (action: unknown) => ledger({ steps: [ledgerStep({ actions: [action], receiptIds: [] })] });
    expect(verify(withAction(ledgerAction({ ...base, valueDigest: hmac("other"), valueLiteral: "orders.csv" }))).ok).toBe(false);
    expect(verify(withAction(ledgerAction({ ...base, valueDigest: sha("orders.csv"), valueLiteral: "orders.csv" }))).ok).toBe(false);
    expect(verify(withAction(ledgerAction({ ...base, valueDigest: hmac("orders.csv"), valueLiteral: "orders.csv" })), { 1: GOAL }, "cd".repeat(32)).ok).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ ...base, valueDigest: null, valueLiteral: "orders.csv" }))).success).toBe(false);
  });

  it("requires the ledger's step indexes to equal the goal map's keys exactly", () => {
    const twoGoals = { 1: GOAL, 2: "Another goal" };
    const second = ledgerStep({ stepIndex: 2, goalDigest: sha("Another goal"), receiptIds: [] });
    expect(verify(ledger({ steps: [ledgerStep(), second] }), twoGoals).ok).toBe(true);
    expect(verify(ledger({ steps: [] }), { 1: GOAL }).ok).toBe(false);
    expect(verify(ledger({ steps: [ledgerStep()] }), twoGoals).ok).toBe(false);
    expect(verify(ledger({ steps: [ledgerStep(), second] }), { 1: GOAL }).ok).toBe(false);
    expect(verify(ledger({ steps: [] }), {}).ok).toBe(true);
  });

  it("refuses a goal digest that is not the digest of the approved goal", () => {
    expect(verify(ledger()).ok).toBe(true);
    expect(verify(ledger(), { 1: "a different goal" }).ok).toBe(false);
  });

  it("refuses a malformed ledger without echoing it", () => {
    const result = verify({ schemaVersion: "rovara-agent-actions/v1", steps: [{ secret: "hunter2-secret" }] });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2-secret");
    expect(verify("nonsense").ok).toBe(false);
  });

  it("says whether each step concluded, was cut short, or failed", () => {
    const withStep = (overrides: Record<string, unknown>) => ledger({ steps: [ledgerStep({ actions: [], receiptIds: [], ...overrides })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "concluded", stopCode: null })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "cut-short", stopCode: null })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "failed", stopCode: "ACTION_FAILED" })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "failed", stopCode: null })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "concluded", stopCode: "STEP_TIMEOUT" })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "cut-short", stopCode: "STEP_TIMEOUT" })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ verdict: "passed" })).success).toBe(false);
    const noVerdict: Record<string, unknown> = ledgerStep();
    delete noVerdict["verdict"];
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [noVerdict] })).success).toBe(false);
  });

  it("keeps the action shape closed per tool", () => {
    const withAction = (action: unknown) => ledger({ steps: [ledgerStep({ actions: [action], receiptIds: [] })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "type" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "tap", valueDigest: hmac("x") }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "navigate", node: null, url: "/orders/all" }))).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "tap", url: "/orders" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "screenshot" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "tap", node: null }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "scroll", node: null, valueDigest: hmac("down") }))).success).toBe(true);
  });

  it("records a navigation as an app-relative path with no query, no fragment and no absolute form", () => {
    const withUrl = (url: string) => ledger({ steps: [ledgerStep({ actions: [ledgerAction({ tool: "navigate", node: null, url })], receiptIds: [] })] });
    for (const url of ["https://evil.example/", "http://app.test/orders", "//evil.example/x", "javascript:alert(1)", "orders", "/orders?token=abc", "/orders#frag", "/a b", `/${"a".repeat(600)}`]) {
      expect(E2EAgentActionLedgerSchema.safeParse(withUrl(url)).success, url).toBe(false);
    }
    expect(E2EAgentActionLedgerSchema.safeParse(withUrl("/orders/2026")).success).toBe(true);
  });

  it("bounds node names at 120 characters, actions at 8 per step and steps at 3; the structural caps keep it under 64 KiB", () => {
    const withActions = (actions: unknown[], index = 1) => ledgerStep({ stepIndex: index, actions, receiptIds: [] });
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions([ledgerAction({ node: { role: "button", name: "n".repeat(121), testId: null } })])] })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions(Array.from({ length: 9 }, () => ledgerAction()))] })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions(Array.from({ length: 8 }, () => ledgerAction()))] })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [1, 2, 3, 4].map((index) => withActions([], index)) })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions([], 1), withActions([], 1)] })).success).toBe(false);
    const heavy = ledgerAction({ tool: "type", valueDigest: hmac("v"), valueLiteral: "v".repeat(256), node: { role: "textbox", name: "n".repeat(120), testId: "t".repeat(120) } });
    const fat = ledger({ steps: [1, 2, 3].map((index) => withActions(Array.from({ length: 8 }, () => heavy), index)) });
    expect(E2EAgentActionLedgerSchema.safeParse(fat).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fat))).toBeLessThan(65_536);
  });

  it("limits stop codes to the closed e2e vocabulary and receipts to the step's call budget", () => {
    const withStep = (overrides: Record<string, unknown>) => ledger({ steps: [ledgerStep({ actions: [], receiptIds: [], verdict: "failed", stopCode: "ACTION_FAILED", ...overrides })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ stopCode: "STEP_BUDGET_EXHAUSTED" })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ stopCode: "MODEL_PROVIDER_FAILED" })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ stopCode: "PASSED" })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ receiptIds: Array.from({ length: 13 }, (_, index) => `rcpt-${index}`) })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ receiptIds: ["a", "a"] })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse({ ...ledger(), extra: 1 }).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ schemaVersion: "rovara-agent-actions/v2" })).success).toBe(false);
  });
});

describe("ledger receipts against the worker's receipts", () => {
  const twoStepGoals = { 1: GOAL, 2: "Another goal" };
  const stepTwo = ledgerStep({ stepIndex: 2, goalDigest: sha("Another goal"), receiptIds: ["rcpt-2-0"] });
  const twoStepLedger = () => verified(ledger({ steps: [ledgerStep({ receiptIds: ["rcpt-0001", "rcpt-0002"] }), stepTwo] }), twoStepGoals);
  const workerReceipts = () => [
    receiptAt(0, { receiptId: "rcpt-0001" }), receiptAt(1, { receiptId: "rcpt-0002" }), receiptAt(0, { receiptId: "rcpt-2-0", stepIndex: 2 }),
    receiptAt(2, { receiptId: "rcpt-extra", outcome: "provider-error", responseSha256: null, outputTokens: 0 }),
  ];

  it("accepts a ledger whose receipt ids are all worker receipts of its run, case and step", () => {
    expect(crossCheckE2EAgentLedgerReceipts(twoStepLedger(), workerReceipts())).toEqual({ ok: true });
  });

  it("refuses a receipt id the worker never wrote, or one from another step, run or case", () => {
    const unknown = verified(ledger({ steps: [ledgerStep({ receiptIds: ["rcpt-0001", "rcpt-made-up"] })] }));
    expect(crossCheckE2EAgentLedgerReceipts(unknown, workerReceipts())).toMatchObject({ ok: false, code: "ledger-receipt-unknown" });
    const wrongStep = verified(ledger({ steps: [ledgerStep({ receiptIds: ["rcpt-2-0"] })] }));
    expect(crossCheckE2EAgentLedgerReceipts(wrongStep, workerReceipts())).toMatchObject({ ok: false, code: "ledger-receipt-unknown" });
    for (const overrides of [{ runId: "11111111-2222-4333-8444-555555555555" }, { caseId: "other-case" }]) {
      const foreign = workerReceipts().map((item) => ({ ...item, ...overrides }));
      expect(crossCheckE2EAgentLedgerReceipts(twoStepLedger(), foreign), JSON.stringify(overrides)).toMatchObject({ ok: false, code: "ledger-receipt-unknown" });
    }
    expect(crossCheckE2EAgentLedgerReceipts(twoStepLedger(), [{ nope: 1 }])).toMatchObject({ ok: false, code: "receipt-malformed" });
  });

  it("refuses a receipt id used twice in the ledger, or twice among the worker's receipts", () => {
    const twice = verified(ledger({ steps: [ledgerStep({ receiptIds: ["rcpt-0001"] }), ledgerStep({ stepIndex: 2, goalDigest: sha("Another goal"), receiptIds: ["rcpt-0001"] })] }), twoStepGoals);
    expect(crossCheckE2EAgentLedgerReceipts(twice, workerReceipts())).toMatchObject({ ok: false, code: "ledger-receipt-duplicate" });
    expect(crossCheckE2EAgentLedgerReceipts(twoStepLedger(), [...workerReceipts(), receiptAt(3, { receiptId: "rcpt-0001" })])).toMatchObject({ ok: false, code: "ledger-receipt-duplicate" });
  });

  it("requires a verified ledger at run time", () => {
    const plain = E2EAgentActionLedgerSchema.parse(ledger()) as unknown as VerifiedE2EAgentActionLedger;
    expect(crossCheckE2EAgentLedgerReceipts(plain, workerReceipts())).toMatchObject({ ok: false, code: "ledger-not-verified" });
  });
});

describe("captured ActionTrace review (M4-A trace bound to the verified ledger)", () => {
  const typed = ledgerAction({ tool: "type", node: { role: "textbox", name: "File name", testId: "file-name" }, valueDigest: hmac("orders.csv"), valueLiteral: "orders.csv" });
  const pressed = ledgerAction({ tool: "press", node: { role: "textbox", name: "File name", testId: "file-name" }, valueDigest: hmac("Enter") });
  const failedTap = ledgerAction({ outcome: "action-failed", node: { role: "button", name: "Missing", testId: null } });
  const navigated = ledgerAction({ tool: "navigate", node: null, url: "/orders" });
  const scrolled = ledgerAction({ tool: "scroll", node: null, valueDigest: hmac("down") });
  const selected = ledgerAction({ tool: "select", node: { role: "combobox", name: "Format", testId: null }, valueDigest: hmac("CSV") });
  const actions = [navigated, typed, pressed, failedTap, scrolled, selected, ledgerAction()];
  const value = () => verified(ledger({ steps: [ledgerStep({ actions, receiptIds: [] })] }));
  const traceActions = () => [
    { name: "navigate", url: "https://app.test:8080/orders?x=1#top", summary: "navigate" },
    { name: "type", target: { role: "textbox", name: "File name", testId: "file-name", selector: "#f" }, value: "orders.csv", summary: "type" },
    { name: "press", target: { role: "textbox", name: "File name", testId: "file-name" }, key: "Enter", summary: "press" },
    { name: "scroll", direction: "down", summary: "scroll" },
    { name: "select", target: { role: "combobox", name: "Format" }, value: `hmac-sha256:${hmac("CSV")}`, summary: "select" },
    { name: "tap", target: { role: "button", name: "Download orders" }, summary: "tap" },
  ];
  const trace = (overrides: Record<string, unknown> = {}) => ({ actions: traceActions(), executor: { name: "rovara" }, summary: "s", ...overrides });
  const review = (input: Partial<Parameters<typeof reviewCapturedE2EAgentTrace>[0]> = {}) =>
    reviewCapturedE2EAgentTrace({ stepIndex: 1, trace: trace(), ledger: value(), valueKey: KEY, credentialScanHit: false, ...input });

  it("keeps a trace that matches the ledger action by action, and returns the digest binding for the PASS evidence", () => {
    const result = review();
    expect(result.keep).toBe(true);
    if (!result.keep) return;
    expect(result.binding).toEqual({
      schemaVersion: "rovara-agent-trace/v1", runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1,
      traceSha256: sha(canonicalJson(trace())), ledgerSha256: sha(canonicalJson(value())), actionCount: 6,
    });
    expect(E2EAgentTraceBindingSchema.safeParse(result.binding).success).toBe(true);
    expect(E2EAgentTraceBindingSchema.safeParse({ ...result.binding, extra: 1 }).success).toBe(false);
  });

  it("discards, and never throws, when the trace has a different count, kind, target or typed value", () => {
    const mutate = (change: (list: Record<string, unknown>[]) => void) => {
      const list = traceActions() as Record<string, unknown>[];
      change(list);
      return trace({ actions: list });
    };
    const cases: Record<string, unknown> = {
      "an extra action": mutate((list) => list.push({ name: "tap", target: { role: "button", name: "More" } })),
      "a missing action": mutate((list) => list.pop()),
      "a different kind": mutate((list) => { list[5] = { name: "hover", target: { role: "button", name: "Download orders" } }; }),
      "a different target name": mutate((list) => { list[5] = { name: "tap", target: { role: "button", name: "Delete everything" } }; }),
      "a different role": mutate((list) => { list[5] = { name: "tap", target: { role: "link", name: "Download orders" } }; }),
      "a different testId": mutate((list) => { list[1] = { ...list[1], target: { role: "textbox", name: "File name", testId: "other" } }; }),
      "a different typed value": mutate((list) => { list[1] = { ...list[1], value: "hunter2-secret" }; }),
      "a different key": mutate((list) => { list[2] = { ...list[2], key: "Escape" }; }),
      "a different direction": mutate((list) => { list[3] = { ...list[3], direction: "up" }; }),
      "a different navigation": mutate((list) => { list[0] = { name: "navigate", url: "/admin" }; }),
      "reordered actions": mutate((list) => { [list[1], list[2]] = [list[2] as Record<string, unknown>, list[1] as Record<string, unknown>]; }),
    };
    for (const [label, changed] of Object.entries(cases)) {
      const result = review({ trace: changed });
      expect(result, label).toMatchObject({ keep: false, reason: "trace-ledger-mismatch" });
      expect(JSON.stringify(result), label).not.toContain("hunter2-secret");
    }
  });

  it("Q4: refuses a plain value the model chose even when it matches the ledger's keyed digest; only the step's goal text, the marker or a named key or direction is accepted", () => {
    const mutate = (index: number, change: Record<string, unknown>) => { const list = traceActions() as Record<string, unknown>[]; list[index] = { ...list[index], ...change }; return trace({ actions: list }); };
    // The select value "CSV" is not text of the goal and not a literal in the ledger: its plain spelling has the ledger's digest, and is refused all the same.
    expect(review({ trace: mutate(4, { value: "CSV" }) })).toMatchObject({ keep: false, reason: "trace-ledger-mismatch" });
    expect(review({ trace: mutate(4, { value: `hmac-sha256:${hmac("CSV")}` }) }).keep).toBe(true);
    // The typed value that IS the ledger's literal (goal text) is accepted as it is, or as its marker.
    expect(review({ trace: mutate(1, { value: "orders.csv" }) }).keep).toBe(true);
    expect(review({ trace: mutate(1, { value: `hmac-sha256:${hmac("orders.csv")}` }) }).keep).toBe(true);
    // A key outside the named set, plain, is refused even with the right digest; a named key is accepted as it is, and any key as a marker.
    const keyLedger = verified(ledger({ steps: [ledgerStep({ actions: [ledgerAction({ tool: "press", node: { role: "textbox", name: "File name", testId: "file-name" }, valueDigest: hmac("q") })], receiptIds: [] })] }));
    const pressTrace = (key: string) => trace({ actions: [{ name: "press", target: { role: "textbox", name: "File name", testId: "file-name" }, key, summary: "press" }] });
    expect(review({ ledger: keyLedger, trace: pressTrace("q") })).toMatchObject({ keep: false, reason: "trace-ledger-mismatch" });
    expect(review({ ledger: keyLedger, trace: pressTrace(`hmac-sha256:${hmac("q")}`) }).keep).toBe(true);
    // A direction outside the vocabulary is refused too.
    const dirLedger = verified(ledger({ steps: [ledgerStep({ actions: [ledgerAction({ tool: "scroll", node: null, valueDigest: hmac("sideways") })], receiptIds: [] })] }));
    expect(review({ ledger: dirLedger, trace: trace({ actions: [{ name: "scroll", direction: "sideways", summary: "scroll" }] }) })).toMatchObject({ keep: false });
  });

  it("skips ledger actions that did not commit, because e2e records only committed actions", () => {
    expect(review().keep).toBe(true);
    const onlyFailed = verified(ledger({ steps: [ledgerStep({ actions: [failedTap], receiptIds: [] })] }));
    expect(review({ ledger: onlyFailed, trace: trace({ actions: [] }) }).keep).toBe(true);
    expect(review({ ledger: onlyFailed }).keep).toBe(false);
  });

  it("takes the run and case of the binding from the ledger, and requires the verified ledger at run time", () => {
    const otherIds = { runId: "11111111-2222-4333-8444-555555555555", caseId: "case-b" };
    const parsedOther = verify(ledger({ ...otherIds, steps: [ledgerStep({ actions, receiptIds: [] })] }), { 1: GOAL }, KEY, otherIds);
    if (!parsedOther.ok) throw new Error(parsedOther.reason);
    const result = review({ ledger: parsedOther.ledger });
    expect(result.keep && result.binding).toMatchObject({ runId: "11111111-2222-4333-8444-555555555555", caseId: "case-b" });
    const plain = E2EAgentActionLedgerSchema.parse(ledger({ steps: [ledgerStep({ actions, receiptIds: [] })] })) as unknown as VerifiedE2EAgentActionLedger;
    expect(review({ ledger: plain })).toEqual({ keep: false, reason: "ledger-not-verified" });
    expect(review({ ledger: structuredClone(value()) })).toEqual({ keep: false, reason: "ledger-not-verified" });
  });

  it("discards the trace on a credential-scan hit, however well it matches, and never fails the round", () => {
    const result = review({ credentialScanHit: true });
    expect(result).toEqual({ keep: false, reason: "credential-scan-hit" });
  });

  it("discards a malformed or oversized trace, or a step the ledger does not have", () => {
    expect(review({ trace: "nonsense" })).toMatchObject({ keep: false, reason: "trace-malformed" });
    expect(review({ trace: { actions: "no" } })).toMatchObject({ keep: false, reason: "trace-malformed" });
    expect(review({ trace: trace({ summary: "s".repeat(1_048_577) }) })).toMatchObject({ keep: false, reason: "trace-too-large" });
    expect(review({ stepIndex: 7 })).toMatchObject({ keep: false, reason: "trace-ledger-mismatch" });
  });

  it("only ever returns a verdict-neutral discard: no throw for any input", () => {
    for (const input of [undefined, null, 5, [], {}, { actions: [null] }, { actions: [{}] }]) {
      expect(() => review({ trace: input })).not.toThrow();
      expect(review({ trace: input }).keep).toBe(false);
    }
  });
});

// Task 4.3a, test case 1: the contracts of the worker <-> executor channel and of the budget callback.
describe("the step marker, the budget callback and the effective round limits (Task 4.3a)", () => {
  const marker = { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "begin", caseId: CASE_ID, stepIndex: 1 };

  it("fixes the socket and step paths", () => {
    expect(E2E_MODEL_CHANNEL_SOCKET_PATH).toBe("/run/rovara/model.sock");
    expect(E2E_MODEL_CHANNEL_STEP_PATH).toBe("/v1/step");
  });

  it("the marker schema refuses unknown keys, cookie values on an end marker, more than 32 values, and a bad run id or position", () => {
    expect(E2EModelChannelStepMarkerSchema.safeParse(marker).success).toBe(true);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, cookieValues: ["sid=abcdef123456"] }).success).toBe(true);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, marker: "end" }).success).toBe(true);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, extra: 1 }).success).toBe(false);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, marker: "end", cookieValues: ["sid=abcdef123456"] }).success).toBe(false);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, cookieValues: Array.from({ length: 32 }, (_, i) => `c${i}=value-${i}-xxxx`) }).success).toBe(true);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, cookieValues: Array.from({ length: 33 }, (_, i) => `c${i}=value-${i}-xxxx`) }).success).toBe(false);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, runId: "nope" }).success).toBe(false);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, stepIndex: 256 }).success).toBe(false);
    expect(E2EModelChannelStepMarkerSchema.safeParse({ ...marker, marker: "pause" }).success).toBe(false);
  });

  it("the budget schema refuses 0 tokens, more than 64000, a missing group run, and keys it does not know", () => {
    const base = { schemaVersion: "rovara-e2e-model-budget/v1", reservationId: RUN_ID };
    const reserve = { ...base, stage: "reserve", groupRunId: RUN_ID, inputTokens: 1_000 };
    expect(E2EModelDayBudgetRequestSchema.safeParse(reserve).success).toBe(true);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...reserve, inputTokens: 0 }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...reserve, inputTokens: 64_000 }).success).toBe(true);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...reserve, inputTokens: 64_001 }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...reserve, groupRunId: undefined }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...reserve, project: "other" }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...base, stage: "settle", actualInputTokens: 0 }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...base, stage: "settle", actualInputTokens: 64_001 }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...base, stage: "settle", actualInputTokens: 64_000 }).success).toBe(true);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...base, stage: "release" }).success).toBe(true);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...base, stage: "release", inputTokens: 5 }).success).toBe(false);
    expect(E2EModelDayBudgetRequestSchema.safeParse({ ...base, stage: "reserve", groupRunId: RUN_ID, inputTokens: 1_000, reservationId: "not-a-uuid" }).success).toBe(false);
    expect(E2EModelDayBudgetResponseSchema.safeParse({ ...base, status: "exhausted" }).success).toBe(true);
    expect(E2EModelDayBudgetResponseSchema.safeParse({ ...base, status: "free" }).success).toBe(false);
  });

  it("e2eEffectiveRoundLimits: model-free is the model-free limits, a model group keeps the policy", () => {
    const routeLimits = { runTimeoutMs: 1_200_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 300_000, maxActionsPerCase: 54,
      maxModelRequests: 40, maxInputTokens: 400_000, maxOutputTokens: 40_960, maxSpendUsd: null };
    // RUN-1: a route-pinned policy's round with no agent step runs under the normal time (run 600 s, case 90 s), not 60 s and 10 s. Startup and preparation stay what the policy said
    // (10 s; nothing reads them), because a round never gets more than its policy allows.
    expect(e2eEffectiveRoundLimits(routeLimits, false)).toEqual({ ...E2E_MODEL_FREE_LIMITS, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000 });
    expect(e2eEffectiveRoundLimits(routeLimits, false)).toMatchObject({ runTimeoutMs: 600_000, caseTimeoutMs: 90_000, maxActionsPerCase: 30, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1 });
    expect(e2eEffectiveRoundLimits(routeLimits, true)).toEqual(routeLimits);
    // It never raises a limit a policy already lowered.
    expect(e2eEffectiveRoundLimits({ ...routeLimits, caseTimeoutMs: 5_000, maxSpendUsd: 2 }, false)).toMatchObject({ caseTimeoutMs: 5_000, runTimeoutMs: 600_000, maxSpendUsd: 2 });
  });

  it("the model-free limits are the normal limits with model budgets of the least a limit may be (RUN-1)", () => {
    expect(E2E_MODEL_FREE_LIMITS).toEqual({ ...E2E_DEFAULT_LIMITS, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1 });
    expect(E2E_MODEL_FREE_LIMITS).toMatchObject({ runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 180_000, caseTimeoutMs: 90_000 });
    expect(Object.isFrozen(E2E_MODEL_FREE_LIMITS)).toBe(true);
    // The normal run time still leaves the host's teardown inside the stale-run sweep (one hour).
    expect(E2E_MODEL_FREE_LIMITS.runTimeoutMs).toBeLessThan(3_600_000 / 2);
  });

  it("the limits before RUN-1 stay available, pinned, for admissions an earlier control plane wrote", () => {
    expect(E2E_MODEL_FREE_LIMITS_BEFORE_RUN_1).toEqual({ runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10,
      maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null });
    const routeLimits = { runTimeoutMs: 1_200_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 300_000, maxActionsPerCase: 54,
      maxModelRequests: 40, maxInputTokens: 400_000, maxOutputTokens: 40_960, maxSpendUsd: null };
    expect(e2eEffectiveRoundLimitsBeforeRun1(routeLimits, false)).toEqual(E2E_MODEL_FREE_LIMITS_BEFORE_RUN_1);
    expect(e2eEffectiveRoundLimitsBeforeRun1(routeLimits, true)).toEqual(routeLimits);
  });

  it("e2eScannableEmailLocalPart: short and word-like local parts are not scanned, the host-generated form is", () => {
    expect(e2eScannableEmailLocalPart("test@x.io")).toBeNull();
    expect(e2eScannableEmailLocalPart("a.b@x.io")).toBeNull();
    expect(e2eScannableEmailLocalPart("administrator@x.io")).toBeNull();
    expect(e2eScannableEmailLocalPart("rovara-owner-a1b2c3@example.test")).toBe("rovara-owner-a1b2c3");
    expect(e2eScannableEmailLocalPart("jane.doe+42@x.io")).toBe("jane.doe+42");
    expect(e2eScannableEmailLocalPart("abcdefg1@x.io")).toBe("abcdefg1");
  });

  it("e2eModelRouteRevisionNumber reads r<n>-<12 hex> and nothing else", () => {
    expect(e2eModelRouteRevisionNumber("r1-0123456789ab")).toBe(1);
    expect(e2eModelRouteRevisionNumber("r42-0123456789ab")).toBe(42);
    for (const bad of ["r0-0123456789ab", "r1-0123456789a", "1-0123456789ab", "r1-0123456789AB", "r1-0123456789abc", "", "r1234567-0123456789ab"]) expect(e2eModelRouteRevisionNumber(bad), bad).toBeNull();
  });
});

describe("contracts barrel", () => {
  it("re-exports the channel contract so later tasks never touch the barrel", () => {
    for (const name of [
      "E2EModelRouteDefinitionSchema", "E2EModelChannelRequestSchema", "E2EModelChannelResponseSchema", "E2EModelReceiptSchema",
      "E2EAgentActionLedgerSchema", "e2eModelRouteRevision", "parseVerifiedE2EAgentActionLedger", "checkE2EStepModelAccounting",
      "reviewCapturedE2EAgentTrace", "E2E_AGENT_TOOL_NAMES",
    ]) expect(Object.keys(barrel), name).toContain(name);
    expect(Object.keys(barrel)).not.toContain("verifyE2EAgentActionLedgerGoals");
  });
});
