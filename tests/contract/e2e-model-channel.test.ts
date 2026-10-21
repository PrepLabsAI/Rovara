import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import * as barrel from "../../packages/contracts/src/index.js";
import {
  E2E_AGENT_TOOL_NAMES,
  E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES,
  E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES,
  E2E_MODEL_ROUTE_DEFAULT_BUDGETS,
  E2EAgentActionLedgerSchema,
  E2EModelChannelRequestSchema,
  E2EModelChannelResponseSchema,
  E2EModelReceiptSchema,
  E2EModelRouteDefinitionSchema,
  e2eModelRouteRevision,
  verifyE2EAgentActionLedgerGoals,
} from "../../packages/contracts/src/e2e-model-channel.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const RUN_ID = "7f1c2a4e-5b6d-4c8e-9f01-23456789abcd";

function route(overrides: Record<string, unknown> = {}) {
  return {
    routeId: "e2e-act-haiku",
    revision: 1,
    provider: "amazon-bedrock",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    inferenceProfileArn: null,
    budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS },
    promptProtocol: "e2e-0.20.0-act/v1",
    temperature: 0,
    vision: false,
    ...overrides,
  };
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

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: "rcpt-0001", runId: RUN_ID, caseId: "case-orders-export", stepIndex: 1, callIndex: 0,
    routeId: "e2e-act-haiku", routeRevision: "r1-0123456789ab", provider: "amazon-bedrock",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", inputTokens: 1200, outputTokens: 80, latencyMs: 900,
    promptSha256: sha("prompt"), responseSha256: sha("response"), outcome: "ok", ...overrides,
  };
}

const GOAL = "Open the orders page and export the orders as a CSV file named orders.csv";

function ledgerAction(overrides: Record<string, unknown> = {}) {
  return {
    tool: "tap", node: { role: "button", name: "Download orders", testId: null },
    valueDigest: null, valueLiteral: null, url: null, snapshotSha256: sha("snapshot-0"), outcome: "ok", ...overrides,
  };
}

function ledgerStep(overrides: Record<string, unknown> = {}) {
  return { stepIndex: 1, goalDigest: sha(GOAL), actions: [ledgerAction()], stopCode: null, receiptIds: ["rcpt-0001"], ...overrides };
}

function ledger(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "rovara-agent-actions/v1", steps: [ledgerStep()], ...overrides };
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
      expect(E2EModelRouteDefinitionSchema.safeParse(route({ budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS, [key]: value } })).success, key).toBe(false);
    }
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS, maxActionsPerStep: 4 } })).success).toBe(true);
  });

  it("pins provider, protocol, temperature and vision, and refuses unknown keys", () => {
    for (const overrides of [
      { provider: "openai" }, { promptProtocol: "e2e-0.21.0-act/v1" }, { temperature: 0.2 }, { vision: true },
      { fallbackModelId: "x" }, { revision: 0 }, { inferenceProfileArn: "not-an-arn" },
    ]) expect(E2EModelRouteDefinitionSchema.safeParse(route(overrides)).success, JSON.stringify(overrides)).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(route({ inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0" })).success).toBe(true);
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
    const reordered = {
      vision: false, temperature: 0, promptProtocol: "e2e-0.20.0-act/v1",
      budgets: Object.fromEntries(Object.entries(E2E_MODEL_ROUTE_DEFAULT_BUDGETS).reverse()),
      inferenceProfileArn: null, modelId: original.modelId, provider: "amazon-bedrock", revision: 1, routeId: "e2e-act-haiku",
    };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(original));
    expect(e2eModelRouteRevision(reordered)).toBe(e2eModelRouteRevision(original));
  });

  it("is computed from the parsed form: surrounding whitespace in the routeId does not change it", () => {
    expect(e2eModelRouteRevision(route({ routeId: "  e2e-act-haiku " }))).toBe(e2eModelRouteRevision(route()));
  });

  it("changes when any pinned field or budget changes, and refuses an invalid definition", () => {
    const base = e2eModelRouteRevision(route());
    expect(e2eModelRouteRevision(route({ modelId: "us.anthropic.claude-sonnet-4-6" }))).not.toBe(base);
    expect(e2eModelRouteRevision(route({ budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS, maxActionsPerStep: 6 } }))).not.toBe(base);
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

  it("bounds maxOutputTokens at 1024 and the call position", () => {
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ maxOutputTokens: 1025 }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ call: call({ maxOutputTokens: 0 }) })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ stepIndex: -1 })).success).toBe(false);
    expect(E2EModelChannelRequestSchema.safeParse(request({ callIndex: 40 })).success).toBe(false);
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

  it("refuses output tokens over 1024 and a response over 32 KiB", () => {
    expect(E2EModelChannelResponseSchema.safeParse(ok([{ type: "text", text: "x" }], { usage: { inputTokens: 10, outputTokens: 1025 } })).success).toBe(false);
    expect(E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES).toBe(32_768);
    const part = { type: "text", text: "y".repeat(4000) };
    expect(E2EModelChannelResponseSchema.safeParse(ok(Array.from({ length: 9 }, () => part))).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse(ok(Array.from({ length: 4 }, () => part))).success).toBe(true);
  });

  it("carries a refusal or failure as a typed error with the receipt id, never as content", () => {
    const refused = { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "rcpt-0002", result: { status: "error", code: "refused-credential-match", message: "prompt matched a run credential" } };
    expect(E2EModelChannelResponseSchema.parse(refused).result.status).toBe("error");
    const noReceipt = { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: null, result: { status: "error", code: "channel-protocol", message: "request is not valid" } };
    expect(E2EModelChannelResponseSchema.safeParse(noReceipt).success).toBe(true);
    expect(E2EModelChannelResponseSchema.safeParse({ ...refused, result: { ...refused.result, code: "ok" } }).success).toBe(false);
    expect(E2EModelChannelResponseSchema.safeParse({ ...refused, receiptId: null }).success).toBe(false);
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

  it("requires a response digest exactly when a response existed", () => {
    expect(E2EModelReceiptSchema.safeParse(receipt({ responseSha256: null })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ outcome: "invalid-output" })).success).toBe(true);
    for (const outcome of ["provider-error", "timeout"]) {
      expect(E2EModelReceiptSchema.safeParse(receipt({ outcome, responseSha256: null, outputTokens: 0 })).success, outcome).toBe(true);
      expect(E2EModelReceiptSchema.safeParse(receipt({ outcome, responseSha256: sha("late") })).success, outcome).toBe(false);
    }
  });

  it("makes a credential refusal a call that never reached the provider", () => {
    const refused = receipt({ outcome: "refused-credential-match", responseSha256: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 });
    expect(E2EModelReceiptSchema.safeParse(refused).success).toBe(true);
    expect(E2EModelReceiptSchema.safeParse({ ...refused, inputTokens: 10 }).success).toBe(false);
  });

  it("refuses unknown keys, another provider and a malformed digest", () => {
    expect(E2EModelReceiptSchema.safeParse({ ...receipt(), prompt: "text" }).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ provider: "openai" })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ promptSha256: "ABC" })).success).toBe(false);
    expect(E2EModelReceiptSchema.safeParse(receipt({ outcome: "passed" })).success).toBe(false);
  });
});

describe("e2e agent action ledger", () => {
  it("accepts the always-kept ledger shape", () => {
    const parsed = E2EAgentActionLedgerSchema.parse(ledger());
    expect(parsed.steps[0]?.actions[0]?.tool).toBe("tap");
  });

  it("accepts a typed value as a digest, with the literal only when it is the goal's own text", () => {
    const typed = ledgerAction({ tool: "type", node: { role: "textbox", name: "File name", testId: "file-name" }, valueDigest: sha("orders.csv"), valueLiteral: "orders.csv" });
    const parsed = E2EAgentActionLedgerSchema.parse(ledger({ steps: [ledgerStep({ actions: [typed], receiptIds: [] })] }));
    expect(verifyE2EAgentActionLedgerGoals(parsed, new Map([[1, GOAL]]))).toEqual({ ok: true });
  });

  it("refuses a raw value that does not appear in the goal", () => {
    const typed = ledgerAction({ tool: "type", node: { role: "textbox", name: "File name", testId: null }, valueDigest: sha("hunter2-secret"), valueLiteral: "hunter2-secret" });
    const parsed = E2EAgentActionLedgerSchema.parse(ledger({ steps: [ledgerStep({ actions: [typed], receiptIds: [] })] }));
    const verdict = verifyE2EAgentActionLedgerGoals(parsed, new Map([[1, GOAL]]));
    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain("hunter2-secret");
  });

  it("refuses a literal whose digest is not the recorded value digest, and a literal with no digest", () => {
    const base = { tool: "type", node: { role: "textbox", name: "File name", testId: null } };
    const withAction = (action: unknown) => ledger({ steps: [ledgerStep({ actions: [action], receiptIds: [] })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ ...base, valueDigest: sha("other"), valueLiteral: "orders.csv" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ ...base, valueDigest: null, valueLiteral: "orders.csv" }))).success).toBe(false);
  });

  it("refuses a goal digest that is not the digest of the approved goal", () => {
    const parsed = E2EAgentActionLedgerSchema.parse(ledger());
    expect(verifyE2EAgentActionLedgerGoals(parsed, new Map([[1, GOAL]]))).toEqual({ ok: true });
    expect(verifyE2EAgentActionLedgerGoals(parsed, new Map([[1, "a different goal"]])).ok).toBe(false);
    expect(verifyE2EAgentActionLedgerGoals(parsed, new Map()).ok).toBe(false);
  });

  it("keeps the action shape closed per tool", () => {
    const withAction = (action: unknown) => ledger({ steps: [ledgerStep({ actions: [action], receiptIds: [] })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "type" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "tap", valueDigest: sha("x") }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "navigate", node: null, url: "/orders?tab=all" }))).success).toBe(true);
    for (const url of ["https://evil.example/", "//evil.example/x", "javascript:alert(1)", "orders", `/${"a".repeat(600)}`]) {
      expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "navigate", node: null, url }))).success, url).toBe(false);
    }
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "tap", url: "/orders" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "screenshot" }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "tap", node: null }))).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withAction(ledgerAction({ tool: "scroll", node: null, valueDigest: sha("down") }))).success).toBe(true);
  });

  it("bounds node names at 120 characters, actions at 8 per step, steps at 3, and the whole ledger at 64 KiB", () => {
    const withActions = (actions: unknown[], index = 1) => ledgerStep({ stepIndex: index, actions, receiptIds: [] });
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions([ledgerAction({ node: { role: "button", name: "n".repeat(121), testId: null } })])] })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions(Array.from({ length: 9 }, () => ledgerAction()))] })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions(Array.from({ length: 8 }, () => ledgerAction()))] })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [1, 2, 3, 4].map((index) => withActions([], index)) })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ steps: [withActions([], 1), withActions([], 1)] })).success).toBe(false);
    const heavy = ledgerAction({ tool: "type", valueDigest: sha("v"), node: { role: "textbox", name: "n".repeat(120), testId: "t".repeat(120) } });
    const fat = ledger({ steps: [1, 2, 3].map((index) => withActions(Array.from({ length: 8 }, () => heavy), index)) });
    expect(Buffer.byteLength(JSON.stringify(fat))).toBeLessThan(65_536);
    expect(E2EAgentActionLedgerSchema.safeParse(fat).success).toBe(true);
  });

  it("limits stop codes to the closed e2e vocabulary and receipts to the step's call budget", () => {
    const withStep = (overrides: Record<string, unknown>) => ledger({ steps: [ledgerStep({ actions: [], receiptIds: [], ...overrides })] });
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ stopCode: "STEP_BUDGET_EXHAUSTED" })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ stopCode: "MODEL_PROVIDER_FAILED" })).success).toBe(true);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ stopCode: "PASSED" })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ receiptIds: Array.from({ length: 13 }, (_, index) => `rcpt-${index}`) })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(withStep({ receiptIds: ["a", "a"] })).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse({ ...ledger(), extra: 1 }).success).toBe(false);
    expect(E2EAgentActionLedgerSchema.safeParse(ledger({ schemaVersion: "rovara-agent-actions/v2" })).success).toBe(false);
  });
});

describe("contracts barrel", () => {
  it("re-exports the channel contract so later tasks never touch the barrel", () => {
    for (const name of [
      "E2EModelRouteDefinitionSchema", "E2EModelChannelRequestSchema", "E2EModelChannelResponseSchema", "E2EModelReceiptSchema",
      "E2EAgentActionLedgerSchema", "e2eModelRouteRevision", "verifyE2EAgentActionLedgerGoals",
      "E2E_AGENT_TOOL_NAMES",
    ]) expect(Object.keys(barrel), name).toContain(name);
  });
});
