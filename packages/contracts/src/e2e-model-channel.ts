import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

/**
 * The governed model channel for e2e `agent` steps (M1.4).
 *
 * Four records, all strict and all bounded:
 * - the route definition the broker pins at setup approval (its digest is the route revision);
 * - the channel request and response the executor exchanges with the worker over the Unix socket;
 * - the receipt the worker writes for every call (the executor never writes one);
 * - the action ledger kept for every agent step, so a round can be audited and replayed without the model.
 *
 * The request carries the subset of the AI SDK v4 `doGenerate` options that e2e 0.20.0's act loop sends. Everything
 * else (provider options, headers, abort signal, response format, sampling settings) is refused: the worker, not the
 * executor, decides how the provider is called. See the M1.4 agent-seam Ruling for the file and line references.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 120) => z.string().trim().min(1).max(max);
const nonNegativeInt = z.number().int().min(0);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export const E2E_MODEL_CHANNEL_SCHEMA_VERSION = "rovara-e2e-model-channel/v1" as const;
export const E2E_AGENT_ACTIONS_SCHEMA_VERSION = "rovara-agent-actions/v1" as const;
export const E2E_MODEL_ROUTE_PROMPT_PROTOCOL = "e2e-0.20.0-act/v1" as const;
export const E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES = 262_144;
export const E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES = 32_768;
export const E2E_AGENT_LEDGER_MAX_BYTES = 65_536;

/** The closed toolset of an agent step: the six navigation verbs plus the loop's own verdict tool. No pixel, project, upload or secret tools. */
export const E2E_AGENT_TOOL_NAMES = ["tap", "type", "press", "select", "scroll", "navigate", "complete_step"] as const;
export type E2EAgentToolName = (typeof E2E_AGENT_TOOL_NAMES)[number];
const agentToolName = z.enum(E2E_AGENT_TOOL_NAMES);
const ledgerToolName = z.enum(["tap", "type", "press", "select", "scroll", "navigate"]);

/** The closed e2e 0.20.0 `AgentErrorCode` vocabulary, which is what a step's stop code can be. */
export const E2E_AGENT_STOP_CODES = [
  "AUTH_CREDENTIAL_UNAVAILABLE", "AUTH_CREDENTIAL_INVALID", "SECRET_UNAVAILABLE", "AUTHENTICATION_FAILED", "ENVIRONMENT_UNAVAILABLE",
  "SEED_DATA_MISSING", "TEST_SETUP_FAILED", "MODEL_UNAVAILABLE", "MODEL_PROVIDER_FAILED", "CONTEXT_OVERFLOW", "MODEL_OUTPUT_INVALID",
  "APP_UNREACHABLE", "APP_ALREADY_RUNNING", "APP_NOT_OPEN", "LOCATOR_NOT_FOUND", "LOCATOR_AMBIGUOUS", "ACTION_FAILED",
  "AUTOMATION_UNSUPPORTED", "POLICY_DENIED", "STEP_BUDGET_EXHAUSTED", "STEP_TIMEOUT", "STEP_NO_CONCLUSION", "ASSERTION_FAILED",
  "ASSERTION_INCONCLUSIVE", "REPLAY_STALE", "CANCELLED",
] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------------------------------------------------

/** The owner-approved budgets (D2). A route may lower any of them and may never raise one. */
export const E2E_MODEL_ROUTE_DEFAULT_BUDGETS = Object.freeze({
  maxActionsPerStep: 8,
  extraModelCallsPerStep: 4,
  callTimeoutMs: 30_000,
  maxOutputTokens: 1024,
  maxInputTokens: 32_000,
  maxPromptBytes: 262_144,
  stepDeadlineMs: 90_000,
  maxAgentStepsPerGroup: 3,
  maxModelCallsPerGroup: 40,
  maxInputTokensPerGroup: 400_000,
  maxInputTokensPerProjectDay: 2_000_000,
  maxCallsPerProjectDay: 400,
});

const caps = E2E_MODEL_ROUTE_DEFAULT_BUDGETS;
export const E2EModelRouteBudgetsSchema = z.object({
  maxActionsPerStep: z.number().int().min(1).max(caps.maxActionsPerStep),
  extraModelCallsPerStep: z.number().int().min(0).max(caps.extraModelCallsPerStep),
  callTimeoutMs: z.number().int().min(1_000).max(caps.callTimeoutMs),
  maxOutputTokens: z.number().int().min(1).max(caps.maxOutputTokens),
  maxInputTokens: z.number().int().min(1_000).max(caps.maxInputTokens),
  maxPromptBytes: z.number().int().min(4_096).max(caps.maxPromptBytes),
  stepDeadlineMs: z.number().int().min(5_000).max(caps.stepDeadlineMs),
  maxAgentStepsPerGroup: z.number().int().min(1).max(caps.maxAgentStepsPerGroup),
  maxModelCallsPerGroup: z.number().int().min(1).max(caps.maxModelCallsPerGroup),
  maxInputTokensPerGroup: z.number().int().min(1_000).max(caps.maxInputTokensPerGroup),
  maxInputTokensPerProjectDay: z.number().int().min(1_000).max(caps.maxInputTokensPerProjectDay),
  maxCallsPerProjectDay: z.number().int().min(1).max(caps.maxCallsPerProjectDay),
}).strict();
export type E2EModelRouteBudgets = z.infer<typeof E2EModelRouteBudgetsSchema>;

const bedrockModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const bedrockInferenceProfileArn = z.string().regex(/^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:[0-9]{12}:(?:application-)?inference-profile\/[A-Za-z0-9._:/-]{1,200}$/);

export const E2EModelRouteDefinitionSchema = z.object({
  routeId: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  revision: z.number().int().positive().max(999_999),
  provider: z.literal("amazon-bedrock"),
  modelId: bedrockModelId,
  inferenceProfileArn: bedrockInferenceProfileArn.nullable(),
  budgets: E2EModelRouteBudgetsSchema,
  promptProtocol: z.literal(E2E_MODEL_ROUTE_PROMPT_PROTOCOL),
  temperature: z.literal(0),
  vision: z.literal(false),
}).strict();
export type E2EModelRouteDefinition = z.infer<typeof E2EModelRouteDefinitionSchema>;

/** `"r" + revision + "-" + sha256(canonicalJson(parsed))[0:12]`. Computed from the parsed form, so key order and padding never matter. */
export function e2eModelRouteRevision(definition: unknown): string {
  const parsed = E2EModelRouteDefinitionSchema.parse(definition);
  return `r${parsed.revision}-${sha256(canonicalJson(parsed)).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Channel request
// ---------------------------------------------------------------------------------------------------------------------

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_024 && value.every((item) => isBoundedJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value);
  return entries.length <= 256 && entries.every(([, item]) => isBoundedJson(item, depth + 1));
}
const jsonValue = z.custom<unknown>((value) => isBoundedJson(value), "value must be bounded plain JSON");
const jsonObject = z.custom<Record<string, unknown>>((value) => typeof value === "object" && value !== null && !Array.isArray(value) && isBoundedJson(value), "value must be a bounded plain JSON object");

const textLimit = E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES;
const textPart = z.object({ type: z.literal("text"), text: z.string().max(textLimit) }).strict();
const toolCallId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const promptToolCallPart = z.object({ type: z.literal("tool-call"), toolCallId, toolName: agentToolName, input: jsonValue }).strict();
const toolResultOutput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string().max(textLimit) }).strict(),
  z.object({ type: z.literal("error-text"), value: z.string().max(textLimit) }).strict(),
  z.object({ type: z.literal("content"), value: z.array(textPart).min(1).max(64) }).strict(),
]);
const toolResultPart = z.object({ type: z.literal("tool-result"), toolCallId, toolName: agentToolName, output: toolResultOutput }).strict();

/** A prompt message. File parts, reasoning parts, provider options and approval parts are not representable: pixels never leave the run. */
const promptMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string().max(textLimit) }).strict(),
  z.object({ role: z.literal("user"), content: z.array(textPart).min(1).max(64) }).strict(),
  z.object({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [textPart, promptToolCallPart])).min(1).max(64) }).strict(),
  z.object({ role: z.literal("tool"), content: z.array(toolResultPart).min(1).max(64) }).strict(),
]);

const functionTool = z.object({
  type: z.literal("function"),
  name: agentToolName,
  description: z.string().max(4_096).optional(),
  inputSchema: jsonObject,
}).strict();

const toolChoice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }).strict(),
  z.object({ type: z.literal("required") }).strict(),
  z.object({ type: z.literal("tool"), toolName: agentToolName }).strict(),
]);

/** The bounded subset of the AI SDK v4 `LanguageModelV4CallOptions` that the act loop sends. */
export const E2EModelChannelCallSchema = z.object({
  prompt: z.array(promptMessage).min(1).max(256),
  tools: z.array(functionTool).min(1).max(E2E_AGENT_TOOL_NAMES.length).optional(),
  toolChoice: toolChoice.optional(),
  maxOutputTokens: z.number().int().min(1).max(caps.maxOutputTokens).optional(),
}).strict().superRefine((call, context) => {
  const names = call.tools?.map((tool) => tool.name) ?? [];
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["tools"], message: "tool names must be unique" });
});

export const E2EModelChannelRequestSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  runId: z.string().uuid(),
  caseId: id(160),
  stepIndex: nonNegativeInt.max(255),
  callIndex: nonNegativeInt.max(caps.maxModelCallsPerGroup - 1),
  call: E2EModelChannelCallSchema,
}).strict().superRefine((request, context) => {
  if (bytes(request) > E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES) context.addIssue({ code: "custom", message: `request exceeds ${E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES} bytes` });
});
export type E2EModelChannelRequest = z.infer<typeof E2EModelChannelRequestSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Channel response
// ---------------------------------------------------------------------------------------------------------------------

export const E2E_MODEL_RECEIPT_OUTCOMES = ["ok", "provider-error", "timeout", "budget", "refused-credential-match", "invalid-output"] as const;
const receiptOutcome = z.enum(E2E_MODEL_RECEIPT_OUTCOMES);

const responseToolCall = z.object({ type: z.literal("tool-call"), toolCallId, toolName: agentToolName, input: z.string().max(8_192) }).strict();
const responseText = z.object({ type: z.literal("text"), text: z.string().max(16_384) }).strict();

export const E2E_MODEL_CHANNEL_ERROR_CODES = [...E2E_MODEL_RECEIPT_OUTCOMES.filter((outcome) => outcome !== "ok"), "channel-protocol", "channel-busy"] as const;

export const E2EModelChannelResponseSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  receiptId: id(120).nullable(),
  result: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      content: z.array(z.discriminatedUnion("type", [responseText, responseToolCall])).min(1).max(16),
      finishReason: z.object({ unified: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]), raw: z.string().max(64).nullable() }).strict(),
      usage: z.object({ inputTokens: nonNegativeInt.max(64_000), outputTokens: nonNegativeInt.max(caps.maxOutputTokens) }).strict(),
    }).strict(),
    z.object({
      status: z.literal("error"),
      code: z.enum(E2E_MODEL_CHANNEL_ERROR_CODES),
      message: z.string().max(240),
    }).strict(),
  ]),
}).strict().superRefine((response, context) => {
  const protocolError = response.result.status === "error" && (response.result.code === "channel-protocol" || response.result.code === "channel-busy");
  if (protocolError && response.receiptId !== null) context.addIssue({ code: "custom", path: ["receiptId"], message: "a call the worker refused before accepting it has no receipt" });
  if (!protocolError && response.receiptId === null) context.addIssue({ code: "custom", path: ["receiptId"], message: "every accepted call has a worker receipt" });
  if (bytes(response) > E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES) context.addIssue({ code: "custom", message: `response exceeds ${E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES} bytes` });
});
export type E2EModelChannelResponse = z.infer<typeof E2EModelChannelResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------------------------------------------------

/** One receipt per model call, written by the worker. Prompt and response are digests; bodies live in operator-only evidence. */
export const E2EModelReceiptSchema = z.object({
  receiptId: id(120),
  runId: z.string().uuid(),
  caseId: id(160),
  stepIndex: nonNegativeInt.max(255),
  callIndex: nonNegativeInt.max(caps.maxModelCallsPerGroup - 1),
  routeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  routeRevision: z.string().regex(/^r[1-9][0-9]{0,5}-[a-f0-9]{12}$/),
  provider: z.literal("amazon-bedrock"),
  modelId: bedrockModelId,
  inputTokens: nonNegativeInt.max(64_000),
  outputTokens: nonNegativeInt.max(caps.maxOutputTokens),
  latencyMs: nonNegativeInt.max(120_000),
  promptSha256: digest,
  responseSha256: digest.nullable(),
  outcome: receiptOutcome,
}).strict().superRefine((receipt, context) => {
  if (receipt.outcome === "ok" && receipt.inputTokens > caps.maxInputTokens) context.addIssue({ code: "custom", path: ["inputTokens"], message: "a successful call stays within the per-call input bound" });
  const needsResponse = receipt.outcome === "ok" || receipt.outcome === "invalid-output";
  const noResponse = receipt.outcome === "provider-error" || receipt.outcome === "timeout" || receipt.outcome === "refused-credential-match";
  if (needsResponse && receipt.responseSha256 === null) context.addIssue({ code: "custom", path: ["responseSha256"], message: "this outcome has a response" });
  if (noResponse && receipt.responseSha256 !== null) context.addIssue({ code: "custom", path: ["responseSha256"], message: "this outcome has no response" });
  if (receipt.outcome === "refused-credential-match" && (receipt.inputTokens !== 0 || receipt.outputTokens !== 0)) context.addIssue({ code: "custom", path: ["inputTokens"], message: "a refused call never reached the provider" });
});
export type E2EModelReceipt = z.infer<typeof E2EModelReceiptSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Action ledger
// ---------------------------------------------------------------------------------------------------------------------

const ledgerNode = z.object({
  role: z.string().regex(/^[a-z]{1,32}$/),
  name: z.string().max(120),
  testId: z.string().min(1).max(120).nullable(),
}).strict();
const appRelativeUrl = z.string().max(512).regex(/^\/(?!\/)[^\s\\]*$/);

const ledgerAction = z.object({
  tool: ledgerToolName,
  node: ledgerNode.nullable(),
  valueDigest: digest.nullable(),
  /** The typed value itself, recorded only when it is text of the approved goal; see `verifyE2EAgentActionLedgerGoals`. */
  valueLiteral: z.string().min(1).max(256).nullable(),
  url: appRelativeUrl.nullable(),
  snapshotSha256: digest,
  outcome: z.enum(["ok", "action-failed", "policy-denied"]),
}).strict().superRefine((action, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  const nodeRequired = action.tool === "tap" || action.tool === "type" || action.tool === "press" || action.tool === "select";
  if (nodeRequired && action.node === null) issue("node", `${action.tool} acts on a node`);
  if (action.tool === "navigate" && action.node !== null) issue("node", "navigate acts on no node");
  const valueRequired = action.tool === "type" || action.tool === "press" || action.tool === "select";
  if (valueRequired && action.valueDigest === null) issue("valueDigest", `${action.tool} records a value digest`);
  if ((action.tool === "tap" || action.tool === "navigate") && action.valueDigest !== null) issue("valueDigest", `${action.tool} carries no value`);
  if (action.tool === "navigate" && action.url === null) issue("url", "navigate records its app-relative target");
  if (action.tool !== "navigate" && action.url !== null) issue("url", "only navigate carries a url");
  if (action.valueLiteral !== null && (action.valueDigest === null || sha256(action.valueLiteral) !== action.valueDigest)) issue("valueLiteral", "a recorded literal must be the value that the digest covers");
});

const ledgerStep = z.object({
  stepIndex: nonNegativeInt.max(255),
  goalDigest: digest,
  actions: z.array(ledgerAction).max(caps.maxActionsPerStep),
  stopCode: z.enum(E2E_AGENT_STOP_CODES).nullable(),
  receiptIds: z.array(id(120)).max(caps.maxActionsPerStep + caps.extraModelCallsPerStep),
}).strict().superRefine((step, context) => {
  if (new Set(step.receiptIds).size !== step.receiptIds.length) context.addIssue({ code: "custom", path: ["receiptIds"], message: "receipt ids must be unique" });
});

export const E2EAgentActionLedgerSchema = z.object({
  schemaVersion: z.literal(E2E_AGENT_ACTIONS_SCHEMA_VERSION),
  steps: z.array(ledgerStep).max(caps.maxAgentStepsPerGroup),
}).strict().superRefine((ledger, context) => {
  if (new Set(ledger.steps.map((step) => step.stepIndex)).size !== ledger.steps.length) context.addIssue({ code: "custom", path: ["steps"], message: "step indexes must be unique" });
  if (bytes(ledger) > E2E_AGENT_LEDGER_MAX_BYTES) context.addIssue({ code: "custom", message: `ledger exceeds ${E2E_AGENT_LEDGER_MAX_BYTES} bytes` });
});
export type E2EAgentActionLedger = z.infer<typeof E2EAgentActionLedgerSchema>;

/**
 * Checks a parsed ledger against the approved goal text of each step: the goal digest must be the digest of the goal,
 * and a recorded literal must be text of that goal. The reason never repeats a recorded value.
 */
export function verifyE2EAgentActionLedgerGoals(ledger: E2EAgentActionLedger, goals: ReadonlyMap<number, string>): { ok: true } | { ok: false; reason: string } {
  for (const step of ledger.steps) {
    const goal = goals.get(step.stepIndex);
    if (goal === undefined) return { ok: false, reason: `step ${step.stepIndex} has no approved goal to check against` };
    if (sha256(goal) !== step.goalDigest) return { ok: false, reason: `step ${step.stepIndex} goal digest is not the digest of the approved goal` };
    for (const [index, action] of step.actions.entries()) {
      if (action.valueLiteral !== null && !goal.includes(action.valueLiteral)) return { ok: false, reason: `step ${step.stepIndex} action ${index} records a literal that is not text of the approved goal` };
    }
  }
  return { ok: true };
}
