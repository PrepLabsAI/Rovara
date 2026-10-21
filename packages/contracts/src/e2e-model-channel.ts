import { createHash, createHmac, randomBytes } from "node:crypto";
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
 * executor, decides how the provider is called. See docs/specs/rovara-e2e-runtimes/m1-4-e2e-agent-seam.md for the
 * file and line references.
 *
 * Every bound here is a ceiling taken from the owner's D2 caps. A pinned route may lower any of them, so readers (the
 * worker, Tasks 4.1 and 4.4) must also check against the route definition they hold.
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
/** Calls the worker may receive for one step: the actions plus the headroom for re-sends. A refused request still gets a receipt, so receipt indexes can run a little past it. */
const MAX_STEP_CALLS = caps.maxActionsPerStep + caps.extraModelCallsPerStep;
const MAX_RECEIPT_CALL_INDEX = 99;

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

/** `amazon-bedrock` is the real provider. `rovara-scripted` is the scripted model double of qualification and CI, and exists only on qualification-scoped routes. */
export const E2E_MODEL_PROVIDERS = ["amazon-bedrock", "rovara-scripted"] as const;
export const E2E_MODEL_SCRIPTED_ROUTE_PREFIX = "rovara-scripted/";
const modelProvider = z.enum(E2E_MODEL_PROVIDERS);

const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const routeIdText = (trim: boolean) => (trim ? z.string().trim() : z.string()).min(1).max(64).regex(ROUTE_ID_PATTERN);
const bedrockModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;
const PROFILE_ARN_PATTERN = /^arn:aws[a-z-]*:bedrock:([a-z0-9-]+):[0-9]{12}:(application-)?inference-profile\/([A-Za-z0-9._:/-]{1,200})$/;

export const E2EModelRouteDefinitionSchema = z.object({
  routeId: routeIdText(true),
  revision: z.number().int().positive().max(999_999),
  /** `qualification` routes may use the scripted provider. A `standard` route is a real model for real rounds. */
  scope: z.enum(["standard", "qualification"]),
  provider: modelProvider,
  /** The Bedrock region the invocation goes to. Pinned, so a change of worker region cannot silently change the endpoint or data residency. Null for the scripted provider. */
  region: z.string().regex(AWS_REGION_PATTERN).nullable(),
  modelId: bedrockModelId,
  /**
   * When set, this ARN is the identifier that is invoked, and it must be in `region`. A system profile's id must equal
   * `modelId`. When null, `modelId` is invoked. See `e2eModelRouteInvokedIdentifier`.
   */
  inferenceProfileArn: z.string().regex(PROFILE_ARN_PATTERN).nullable(),
  budgets: E2EModelRouteBudgetsSchema,
  promptProtocol: z.literal(E2E_MODEL_ROUTE_PROMPT_PROTOCOL),
  temperature: z.literal(0),
  vision: z.literal(false),
}).strict().superRefine((route, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  const scriptedId = route.routeId.startsWith(E2E_MODEL_SCRIPTED_ROUTE_PREFIX);
  if (route.provider === "rovara-scripted") {
    if (route.scope !== "qualification") issue("scope", "the scripted provider is valid only on a qualification-scoped route");
    if (!scriptedId) issue("routeId", `a scripted route id starts with ${E2E_MODEL_SCRIPTED_ROUTE_PREFIX}`);
    if (route.region !== null) issue("region", "the scripted provider has no region");
    if (route.inferenceProfileArn !== null) issue("inferenceProfileArn", "the scripted provider has no inference profile");
    return;
  }
  if (scriptedId) issue("routeId", "the scripted route id prefix is reserved for the scripted provider");
  if (route.region === null) issue("region", "a Bedrock route pins its region");
  if (route.inferenceProfileArn !== null) {
    const match = PROFILE_ARN_PATTERN.exec(route.inferenceProfileArn);
    if (match?.[1] !== route.region) issue("inferenceProfileArn", "the inference profile must be in the route's region");
    if (match?.[2] === undefined && match?.[3] !== route.modelId) issue("inferenceProfileArn", "a system inference profile must be the profile of modelId");
  }
});
export type E2EModelRouteDefinition = z.infer<typeof E2EModelRouteDefinitionSchema>;

/** The one identifier the worker invokes: the inference profile ARN when the route has one, else the model id. */
export function e2eModelRouteInvokedIdentifier(definition: E2EModelRouteDefinition): string {
  return definition.inferenceProfileArn ?? definition.modelId;
}

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

/**
 * `callIndex` counts calls within one step, from 0. It is advisory: the worker assigns the receipt's `callIndex`
 * from its own per-step counter and treats a request whose value differs as a protocol refusal. `runId`, `caseId` and
 * `stepIndex` are likewise checked against the run's own position, and the receipt carries the worker's values.
 */
export const E2EModelChannelRequestSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  runId: z.string().uuid(),
  caseId: id(160),
  stepIndex: nonNegativeInt.max(255),
  callIndex: nonNegativeInt.max(MAX_RECEIPT_CALL_INDEX),
  call: E2EModelChannelCallSchema,
}).strict().superRefine((request, context) => {
  if (bytes(request) > E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES) context.addIssue({ code: "custom", message: `request exceeds ${E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES} bytes` });
});
export type E2EModelChannelRequest = z.infer<typeof E2EModelChannelRequestSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Channel response
// ---------------------------------------------------------------------------------------------------------------------

/** `refused-*` outcomes are calls the worker received but never sent to the provider. Every received request gets a receipt, whatever its outcome. */
export const E2E_MODEL_CHANNEL_ERROR_CODES = ["provider-error", "timeout", "budget", "refused-credential-match", "refused-protocol", "refused-busy", "invalid-output"] as const;
export const E2E_MODEL_RECEIPT_OUTCOMES = ["ok", ...E2E_MODEL_CHANNEL_ERROR_CODES] as const;
const receiptOutcome = z.enum(E2E_MODEL_RECEIPT_OUTCOMES);
const REFUSAL_OUTCOMES: ReadonlySet<string> = new Set(["refused-credential-match", "refused-protocol", "refused-busy"]);

const responseToolCall = z.object({ type: z.literal("tool-call"), toolCallId, toolName: agentToolName, input: z.string().max(8_192) }).strict();
const responseText = z.object({ type: z.literal("text"), text: z.string().max(16_384) }).strict();

/**
 * An `ok` answer finished with `stop` or `tool-calls`. A `length`, `error`, `content-filter` or `other` finish is
 * truncated, filtered or failed, so the worker returns it as an `invalid-output` or `provider-error` error instead.
 */
export const E2EModelChannelResponseSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  receiptId: id(120),
  result: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      content: z.array(z.discriminatedUnion("type", [responseText, responseToolCall])).min(1).max(16),
      finishReason: z.object({ unified: z.enum(["stop", "tool-calls"]), raw: z.string().max(64).nullable() }).strict(),
      usage: z.object({ inputTokens: nonNegativeInt.max(caps.maxInputTokens), outputTokens: nonNegativeInt.max(caps.maxOutputTokens) }).strict(),
    }).strict(),
    z.object({
      status: z.literal("error"),
      code: z.enum(E2E_MODEL_CHANNEL_ERROR_CODES),
      message: z.string().max(240),
    }).strict(),
  ]),
}).strict().superRefine((response, context) => {
  if (bytes(response) > E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES) context.addIssue({ code: "custom", message: `response exceeds ${E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES} bytes` });
});
export type E2EModelChannelResponse = z.infer<typeof E2EModelChannelResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One receipt per request the worker receives, written by the worker from its own state. Prompt and response are
 * digests; bodies live in operator-only evidence. `callIndex` is the worker's per-step counter.
 */
export const E2EModelReceiptSchema = z.object({
  receiptId: id(120),
  runId: z.string().uuid(),
  caseId: id(160),
  stepIndex: nonNegativeInt.max(255),
  callIndex: nonNegativeInt.max(MAX_RECEIPT_CALL_INDEX),
  routeId: routeIdText(false),
  routeRevision: z.string().regex(/^r[1-9][0-9]{0,5}-[a-f0-9]{12}$/),
  provider: modelProvider,
  modelId: bedrockModelId,
  startedAt: z.string().datetime(),
  inputTokens: nonNegativeInt.max(64_000),
  outputTokens: nonNegativeInt.max(caps.maxOutputTokens),
  latencyMs: nonNegativeInt.max(120_000),
  promptSha256: digest,
  responseSha256: digest.nullable(),
  outcome: receiptOutcome,
}).strict().superRefine((receipt, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if ((receipt.provider === "rovara-scripted") !== receipt.routeId.startsWith(E2E_MODEL_SCRIPTED_ROUTE_PREFIX)) issue("provider", "the scripted provider and the scripted route id go together");
  if (receipt.outcome === "ok") {
    if (receipt.inputTokens > caps.maxInputTokens) issue("inputTokens", "a successful call stays within the per-call input bound");
    if (receipt.latencyMs > caps.callTimeoutMs) issue("latencyMs", "a successful call finished within the call timeout");
  }
  const needsResponse = receipt.outcome === "ok" || receipt.outcome === "invalid-output";
  const noResponse = receipt.outcome === "provider-error" || receipt.outcome === "timeout" || REFUSAL_OUTCOMES.has(receipt.outcome);
  if (needsResponse && receipt.responseSha256 === null) issue("responseSha256", "this outcome has a response");
  if (noResponse && receipt.responseSha256 !== null) issue("responseSha256", "this outcome has no response");
  if (REFUSAL_OUTCOMES.has(receipt.outcome) && (receipt.inputTokens !== 0 || receipt.outputTokens !== 0)) issue("inputTokens", "a refused call never reached the provider");
});
export type E2EModelReceipt = z.infer<typeof E2EModelReceiptSchema>;
export type E2ERoundScope = "standard" | "qualification";

/** A receipt of the scripted provider is never accepted for a round that is not a qualification round. */
export function e2eModelReceiptAdmissibleForRound(receipt: E2EModelReceipt, roundScope: E2ERoundScope): { ok: true } | { ok: false; reason: string } {
  if (receipt.provider === "rovara-scripted" && roundScope !== "qualification") return { ok: false, reason: "a scripted-model receipt is not accepted outside a qualification round" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Receipts against the e2e report
// ---------------------------------------------------------------------------------------------------------------------

export type E2EStepModelAccounting =
  | { ok: true; okCalls: number; totalCalls: number }
  | { ok: false; code: "receipt-malformed" | "receipt-not-admissible" | "receipt-identity-mismatch" | "receipt-index-gap" | "receipt-order" | "over-step-budget" | "report-calls-mismatch" };

/**
 * The relation between one agent step's e2e report and the worker's receipts for it:
 *
 * - every call the report counts (`metrics.modelCalls`, which e2e records when a model turn ends) has exactly one
 *   `ok` receipt, so `okReceipts === reportModelCalls`;
 * - every other receipt (provider error, timeout, budget, refusal, invalid output: a request that was refused,
 *   failed or re-sent, which e2e does not count) must have a non-`ok` outcome;
 * - all receipts count toward the step's call budget, whatever their outcome;
 * - the worker's per-step indexes are `0..n-1` with no gap or duplicate and start times that do not go backwards, so a
 *   dropped or added receipt shows;
 * - every receipt belongs to this run, case, step and route revision, and a scripted receipt only counts in a
 *   qualification round.
 */
export function checkE2EStepModelAccounting(input: {
  roundScope: E2ERoundScope;
  identity: { runId: string; caseId: string; stepIndex: number; routeId: string; routeRevision: string };
  reportModelCalls: number;
  receipts: readonly unknown[];
  maxModelCallsPerStep: number;
}): E2EStepModelAccounting {
  const receipts: E2EModelReceipt[] = [];
  for (const raw of input.receipts) {
    const parsed = E2EModelReceiptSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "receipt-malformed" };
    receipts.push(parsed.data);
  }
  for (const item of receipts) {
    if (!e2eModelReceiptAdmissibleForRound(item, input.roundScope).ok) return { ok: false, code: "receipt-not-admissible" };
    const { identity } = input;
    if (item.runId !== identity.runId || item.caseId !== identity.caseId || item.stepIndex !== identity.stepIndex || item.routeId !== identity.routeId || item.routeRevision !== identity.routeRevision) return { ok: false, code: "receipt-identity-mismatch" };
  }
  if (receipts.length > input.maxModelCallsPerStep) return { ok: false, code: "over-step-budget" };
  const ordered = [...receipts].sort((left, right) => left.callIndex - right.callIndex);
  if (ordered.some((item, index) => item.callIndex !== index)) return { ok: false, code: "receipt-index-gap" };
  if (ordered.some((item, index) => index > 0 && Date.parse(item.startedAt) < Date.parse(ordered[index - 1]!.startedAt))) return { ok: false, code: "receipt-order" };
  const okCalls = ordered.filter((item) => item.outcome === "ok").length;
  if (okCalls !== input.reportModelCalls) return { ok: false, code: "report-calls-mismatch" };
  return { ok: true, okCalls, totalCalls: ordered.length };
}

export type E2EGroupModelBudget =
  | { ok: true; totalCalls: number; inputTokens: number; agentSteps: number }
  | { ok: false; code: "receipt-malformed" | "over-group-budget" };

/** Every receipt of a group, whatever its outcome, counts against the group's call, token and agent-step caps. */
export function checkE2EGroupModelBudget(input: { receipts: readonly unknown[]; budgets: Pick<E2EModelRouteBudgets, "maxModelCallsPerGroup" | "maxInputTokensPerGroup" | "maxAgentStepsPerGroup"> }): E2EGroupModelBudget {
  const receipts: E2EModelReceipt[] = [];
  for (const raw of input.receipts) {
    const parsed = E2EModelReceiptSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "receipt-malformed" };
    receipts.push(parsed.data);
  }
  const inputTokens = receipts.reduce((total, item) => total + item.inputTokens, 0);
  const agentSteps = new Set(receipts.map((item) => `${item.caseId}\0${item.stepIndex}`)).size;
  const { budgets } = input;
  if (receipts.length > budgets.maxModelCallsPerGroup || inputTokens > budgets.maxInputTokensPerGroup || agentSteps > budgets.maxAgentStepsPerGroup) return { ok: false, code: "over-group-budget" };
  return { ok: true, totalCalls: receipts.length, inputTokens, agentSteps };
}

// ---------------------------------------------------------------------------------------------------------------------
// Keyed value digests
// ---------------------------------------------------------------------------------------------------------------------

const valueKey = z.string().regex(/^[a-f0-9]{64}$/);

/** A fresh 32-byte per-run key, hex. It goes to the executor for the run and is kept by the broker; it is never stored with the ledger. */
export function generateE2EAgentValueKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * HMAC-SHA256 of a typed value, key press, option label or scroll direction under the run's key. A bare hash of a
 * low-entropy value can be recovered by dictionary; a keyed one cannot be without the run key.
 */
export function e2eAgentValueDigest(key: string, value: string): string {
  return createHmac("sha256", Buffer.from(valueKey.parse(key), "hex")).update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------------
// Action ledger
// ---------------------------------------------------------------------------------------------------------------------

const ledgerNode = z.object({
  role: z.string().regex(/^[a-z]{1,32}$/),
  /** The first 120 characters (UTF-16 code units) of the node's name. */
  name: z.string().max(120),
  testId: z.string().min(1).max(120).nullable(),
}).strict();
/** An app-relative path. No scheme or host (so no absolute URL), no query and no fragment (which may carry tokens). */
const appRelativePath = z.string().max(512).regex(/^\/(?!\/)[^\s\\?#]*$/);

const ledgerAction = z.object({
  tool: ledgerToolName,
  node: ledgerNode.nullable(),
  /** `e2eAgentValueDigest` of the typed value, key, option label or scroll direction. */
  valueDigest: digest.nullable(),
  /** The typed value itself, recorded only when it is text of the approved goal; checked by `parseVerifiedE2EAgentActionLedger`. */
  valueLiteral: z.string().min(1).max(256).nullable(),
  url: appRelativePath.nullable(),
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
  if (action.valueLiteral !== null && action.valueDigest === null) issue("valueLiteral", "a recorded literal needs the digest that covers it");
});

/**
 * How a step ended, as the executor saw it:
 * - `concluded`: `agent.act` resolved (the agent's own verdict was `passed`); no stop code.
 * - `failed`: `agent.act` threw an `AgentError`; the stop code says which.
 * - `cut-short`: the ledger was written but the step never reported an end (crash, kill, deadline): no stop code.
 * Task 4.4 treats anything but `concluded` as UNKNOWN.
 */
export const E2E_AGENT_STEP_VERDICTS = ["concluded", "cut-short", "failed"] as const;

const ledgerStep = z.object({
  stepIndex: nonNegativeInt.max(255),
  goalDigest: digest,
  verdict: z.enum(E2E_AGENT_STEP_VERDICTS),
  actions: z.array(ledgerAction).max(caps.maxActionsPerStep),
  stopCode: z.enum(E2E_AGENT_STOP_CODES).nullable(),
  receiptIds: z.array(id(120)).max(MAX_STEP_CALLS),
}).strict().superRefine((step, context) => {
  if (new Set(step.receiptIds).size !== step.receiptIds.length) context.addIssue({ code: "custom", path: ["receiptIds"], message: "receipt ids must be unique" });
  if ((step.verdict === "failed") !== (step.stopCode !== null)) context.addIssue({ code: "custom", path: ["stopCode"], message: "a stop code goes with a failed step and only with one" });
});

/**
 * The plain structural schema. Its output is NOT a `VerifiedE2EAgentActionLedger`: the ledger comes from the
 * executor, which the broker does not trust, so readers must go through `parseVerifiedE2EAgentActionLedger`.
 * The structural caps (3 steps, 8 actions each, bounded fields) keep a ledger well under the plan's 64 KiB.
 */
export const E2EAgentActionLedgerSchema = z.object({
  schemaVersion: z.literal(E2E_AGENT_ACTIONS_SCHEMA_VERSION),
  steps: z.array(ledgerStep).max(caps.maxAgentStepsPerGroup),
}).strict().superRefine((ledger, context) => {
  if (new Set(ledger.steps.map((step) => step.stepIndex)).size !== ledger.steps.length) context.addIssue({ code: "custom", path: ["steps"], message: "step indexes must be unique" });
});
export type E2EAgentActionLedger = z.infer<typeof E2EAgentActionLedgerSchema>;

declare const verifiedLedgerBrand: unique symbol;
/** A ledger that went through `parseVerifiedE2EAgentActionLedger`. A plain `E2EAgentActionLedger` is not assignable to it. */
export type VerifiedE2EAgentActionLedger = Readonly<E2EAgentActionLedger> & { readonly [verifiedLedgerBrand]: true };
const verifiedLedgers = new WeakSet<object>();

/** Whether a value is a ledger returned by `parseVerifiedE2EAgentActionLedger` (and not a copy of one). */
export function isVerifiedE2EAgentActionLedger(value: unknown): value is VerifiedE2EAgentActionLedger {
  return typeof value === "object" && value !== null && verifiedLedgers.has(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * The one way to read a ledger from the executor. It checks the structure, then against the approved goals (keyed by
 * step index) and the run's value key:
 * - the ledger's step indexes equal the goal map's keys exactly (a missing or extra step fails);
 * - each `goalDigest` is the SHA-256 of the approved goal text;
 * - each `valueDigest` that has a literal is the keyed digest of that literal, and the literal is text of the goal.
 * The failure reason names positions only, never a recorded value.
 */
export function parseVerifiedE2EAgentActionLedger(raw: unknown, context: { goals: ReadonlyMap<number, string>; valueKey: string }): { ok: true; ledger: VerifiedE2EAgentActionLedger } | { ok: false; reason: string } {
  if (!valueKey.safeParse(context.valueKey).success) return { ok: false, reason: "the run value key is not a 32-byte hex key" };
  const parsed = E2EAgentActionLedgerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `ledger is malformed at ${parsed.error.issues.map((item) => item.path.join(".") || "(root)").slice(0, 8).join(", ")}` };
  const ledger = parsed.data;
  const have = ledger.steps.map((step) => step.stepIndex).sort((left, right) => left - right);
  const want = [...context.goals.keys()].sort((left, right) => left - right);
  if (have.length !== want.length || have.some((index, position) => index !== want[position])) return { ok: false, reason: "ledger steps are not exactly the approved agent steps" };
  for (const step of ledger.steps) {
    const goal = context.goals.get(step.stepIndex) as string;
    if (sha256(goal) !== step.goalDigest) return { ok: false, reason: `step ${step.stepIndex} goal digest is not the digest of the approved goal` };
    for (const [index, action] of step.actions.entries()) {
      if (action.valueLiteral === null) continue;
      if (!goal.includes(action.valueLiteral)) return { ok: false, reason: `step ${step.stepIndex} action ${index} records a literal that is not text of the approved goal` };
      if (e2eAgentValueDigest(context.valueKey, action.valueLiteral) !== action.valueDigest) return { ok: false, reason: `step ${step.stepIndex} action ${index} literal does not match its keyed digest` };
    }
  }
  const frozen = deepFreeze(ledger) as VerifiedE2EAgentActionLedger;
  verifiedLedgers.add(frozen);
  return { ok: true, ledger: frozen };
}

// ---------------------------------------------------------------------------------------------------------------------
// Captured ActionTrace (the replay input) bound to the ledger
// ---------------------------------------------------------------------------------------------------------------------

/** The digest binding that goes into the PASS evidence manifest. Replay may only use a trace whose digest is in a PASS round's manifest. */
export const E2EAgentTraceBindingSchema = z.object({
  schemaVersion: z.literal("rovara-agent-trace/v1"),
  runId: z.string().uuid(),
  caseId: id(160),
  stepIndex: nonNegativeInt.max(255),
  traceSha256: digest,
  ledgerSha256: digest,
  actionCount: nonNegativeInt.max(caps.maxActionsPerStep),
}).strict();
export type E2EAgentTraceBinding = z.infer<typeof E2EAgentTraceBindingSchema>;

export const E2E_AGENT_TRACE_MAX_BYTES = 1_048_576;

export type CapturedTraceReview =
  | { keep: true; binding: E2EAgentTraceBinding }
  | { keep: false; reason: "credential-scan-hit" | "trace-malformed" | "trace-too-large" | "trace-ledger-mismatch" };

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function targetMatches(trace: unknown, node: { role: string; name: string; testId: string | null } | null): boolean {
  if (node === null) return trace === undefined || trace === null;
  if (!isRec(trace)) return false;
  return text(trace["role"]) === node.role && (text(trace["name"]) ?? "").slice(0, 120) === node.name && (text(trace["testId"])?.slice(0, 120) ?? null) === node.testId;
}

function pathOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try { return new URL(url, "http://rovara.invalid").pathname; } catch { return undefined; }
}

function actionMatches(traced: Rec, action: VerifiedE2EAgentActionLedger["steps"][number]["actions"][number], key: string): boolean {
  const keyed = (value: unknown, expected: string | null) => typeof value === "string" && expected !== null && e2eAgentValueDigest(key, value) === expected;
  if (traced["name"] !== action.tool) return false;
  switch (action.tool) {
    case "tap": return targetMatches(traced["target"], action.node);
    case "type": return targetMatches(traced["target"], action.node) && keyed(traced["value"], action.valueDigest);
    case "select": return targetMatches(traced["target"], action.node) && keyed(traced["value"], action.valueDigest);
    case "press": return targetMatches(traced["target"], action.node) && keyed(traced["key"], action.valueDigest);
    case "scroll": return targetMatches(traced["target"], action.node) && (action.valueDigest === null || keyed(traced["direction"], action.valueDigest));
    case "navigate": return pathOf(traced["url"]) === action.url;
  }
}

/**
 * Decides what to do with the `ActionTrace` that e2e's capture-only store received for one agent step. It only ever
 * keeps or discards: a discard (credential-scan hit, malformed, too large, or not matching the ledger) loses the
 * replay input and nothing else. It never throws and never fails the round.
 *
 * A kept trace must match the verified ledger one action at a time: e2e records only committed actions, so the trace
 * actions are the ledger's `ok` actions in order, with the same kind, the same target (role, name, test id) and the same
 * keyed value digest. The returned binding (trace digest, ledger digest, action count) goes into the PASS evidence.
 * `credentialScanHit` is the worker's scan of the trace bytes, which carry typed values verbatim.
 */
export function reviewCapturedE2EAgentTrace(input: { stepIndex: number; trace: unknown; ledger: VerifiedE2EAgentActionLedger; valueKey: string; credentialScanHit: boolean; runId: string; caseId: string }): CapturedTraceReview {
  try {
    if (input.credentialScanHit) return { keep: false, reason: "credential-scan-hit" };
    const serialized = JSON.stringify(input.trace);
    if (serialized === undefined) return { keep: false, reason: "trace-malformed" };
    if (Buffer.byteLength(serialized, "utf8") > E2E_AGENT_TRACE_MAX_BYTES) return { keep: false, reason: "trace-too-large" };
    if (!isRec(input.trace) || !Array.isArray(input.trace["actions"]) || !input.trace["actions"].every((item) => isRec(item) && typeof item["name"] === "string")) return { keep: false, reason: "trace-malformed" };
    const traced = input.trace["actions"] as Rec[];
    const step = input.ledger.steps.find((item) => item.stepIndex === input.stepIndex);
    if (step === undefined) return { keep: false, reason: "trace-ledger-mismatch" };
    const committed = step.actions.filter((action) => action.outcome === "ok");
    if (committed.length !== traced.length) return { keep: false, reason: "trace-ledger-mismatch" };
    if (committed.some((action, index) => !actionMatches(traced[index]!, action, input.valueKey))) return { keep: false, reason: "trace-ledger-mismatch" };
    const binding = E2EAgentTraceBindingSchema.parse({
      schemaVersion: "rovara-agent-trace/v1", runId: input.runId, caseId: input.caseId, stepIndex: input.stepIndex,
      traceSha256: sha256(canonicalJson(input.trace)), ledgerSha256: sha256(canonicalJson(input.ledger)), actionCount: committed.length,
    });
    return { keep: true, binding };
  } catch {
    return { keep: false, reason: "trace-malformed" };
  }
}
