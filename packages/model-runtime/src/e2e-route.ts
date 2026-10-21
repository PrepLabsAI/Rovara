import { createHash, randomUUID } from "node:crypto";
import {
  E2EModelChannelRequestSchema,
  E2EModelChannelResponseSchema,
  E2EModelReceiptSchema,
  E2EModelRouteDefinitionSchema,
  canonicalJson,
  e2eModelRouteInvokedIdentifier,
  e2eModelRouteRevision,
  e2eServedModelMatchesPin,
  type E2EModelChannelRequest,
  type E2EModelChannelResponse,
  type E2EModelReceipt,
  type E2EModelRouteDefinition,
} from "@agentx/contracts";

/**
 * The governed model route for e2e `agent` steps (M1.4 Task 4.1).
 *
 * This is the only code that holds access to the AI model provider for the AI browser-test agent. It is deliberately
 * separate from the coding-task runtime in `index.ts`: it never resolves a model through `createModelRuntimeWithFallback`,
 * it never reads a catalog default, and a route that cannot serve its own pinned model fails the call instead of using
 * another one. `invoke` is the provider call, injected so tests run against a fake and the scripted double.
 *
 * What it enforces on every call, from the route definition it holds (which may have lowered any owner cap, so the
 * schema ceilings are not the only check): the pinned identifier, `temperature: 0`, the output cap, the prompt bound,
 * the per-call timeout, the project's day budget, and the shape of the answer. A provider call is made at most once:
 * there is no retry here or below (the Bedrock client is built with one attempt).
 *
 * Every call, whatever its outcome, yields a receipt (`E2EModelReceipt`). The caller (the worker proxy) owns the
 * receipt list; nothing the executor sends can write one.
 */

export type E2EModelChannelCall = E2EModelChannelRequest["call"];
export type E2EModelChannelResult = E2EModelChannelResponse["result"];
export type E2EModelErrorCode = Extract<E2EModelChannelResult, { status: "error" }>["code"];
type Budgets = E2EModelRouteDefinition["budgets"];

/** Thrown by an invoke when the final provider payload failed the proxy's credential check. Nothing was sent. */
export class E2EPayloadRefusedError extends Error {
  constructor() { super("the provider payload carried a credential"); this.name = "E2EPayloadRefusedError"; }
}

/** What the route hands the provider call. The provider sees nothing else of the request. */
export interface E2EInvokeInput {
  /** What to call: the provider, the one identifier to invoke (the inference profile ARN when a Bedrock route has one, else the model id) and the Bedrock region. */
  target: { provider: E2EModelRouteDefinition["provider"]; identifier: string; region: string | null };
  call: E2EModelChannelCall;
  /** The smaller of the route's output cap and the call's. */
  maxOutputTokens: number;
  /** Sampling is the provider's default: no temperature, top-p or top-k is ever sent (Haiku 5.5 rejects temperature 0). */
  sampling: "provider-default";
  /** Claude thinking is sent disabled. */
  thinking: "off";
  effort: E2EModelRouteDefinition["effort"];
  /** Aborted at the per-call timeout and when the run ends. The provider call must stop on it. */
  signal: AbortSignal;
  /** Called with the final provider payload, after all shaping and before it is sent. Throws `E2EPayloadRefusedError` to stop the call. */
  inspectPayload?: (payload: unknown) => void;
}

/** What a provider call returns. The route validates all of it before anything reaches the executor. */
export interface E2EInvokeOutput {
  /** The model the provider says answered; null when it does not say (Bedrock). Checked against the pin. */
  servedModelId: string | null;
  /** OpenRouter's upstream provider for the call, when it says. */
  servedUpstream?: string | null;
  /** SHA-256 of the final provider payload as sent, for the stored transcript. */
  providerPayloadSha256?: string;
  content: ReadonlyArray<Record<string, unknown>>;
  finishReason: { unified: string; raw: string | null };
  /** Absent when the provider reported none. The route then fails closed and counts the reserved bound. */
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export type E2EInvoke = (input: E2EInvokeInput) => Promise<E2EInvokeOutput>;

/** The day caps the route holds the budget to: the route definition's, never the budget's own. */
export interface E2EDayLimits {
  maxInputTokens: number;
  maxCalls: number;
}

/** The project's day budget, kept outside the worker (the broker's table); the route only reserves and settles. */
export interface E2EDayBudget {
  /** Reserves one call and `inputTokens`, or returns null when either day cap in `limits` would be passed. */
  reserve(inputTokens: number, limits: E2EDayLimits): E2EDayReservation | null | Promise<E2EDayReservation | null>;
}
export interface E2EDayReservation {
  /**
   * Settles the reservation with the tokens the provider reported. Not called when the spend is unknown, which keeps the reservation.
   * `settle(0)` says the call was never sent (a refusal or a failure before any request went out): it releases both the reserved tokens and the call count.
   * A positive amount keeps the call and trues the tokens up to that amount, an overrun in full.
   */
  settle(actualInputTokens: number): void | Promise<void>;
}

export interface InMemoryE2EDayBudget extends E2EDayBudget {
  snapshot(): { usedInputTokens: number; usedCalls: number };
}

/** A day budget held in memory: the test double. The broker-backed one is `createBrokerE2EDayBudget` (Task 4.2), which a worker route uses. */
export function createInMemoryE2EDayBudget(input: { usedInputTokens?: number; usedCalls?: number } = {}): InMemoryE2EDayBudget {
  let usedInputTokens = input.usedInputTokens ?? 0;
  let usedCalls = input.usedCalls ?? 0;
  return {
    reserve(inputTokens, limits) {
      if (usedCalls + 1 > limits.maxCalls || usedInputTokens + inputTokens > limits.maxInputTokens) return null;
      usedCalls += 1;
      usedInputTokens += inputTokens;
      let settled = false;
      return { settle(actual) {
        if (settled) return;
        settled = true;
        // A call that was never sent releases its call count as well as its tokens (settle(0)).
        if (actual === 0) usedCalls -= 1;
        usedInputTokens += actual - inputTokens;
      } };
    },
    snapshot: () => ({ usedInputTokens, usedCalls }),
  };
}

export interface GovernedE2EModelRouteDependencies {
  invoke: E2EInvoke;
  /** Milliseconds since the epoch. Injected so tests control time. */
  now: () => number;
  /** Required: a route with no day budget has no day cap. Its limits are the definition's `maxInputTokensPerProjectDay` and `maxCallsPerProjectDay`. */
  dayBudget: E2EDayBudget;
  newReceiptId?: () => string;
}

export interface E2EModelGenerateOptions {
  signal?: AbortSignal;
  /** Epoch ms. The call never outlives it (the run's and the step's deadline). */
  deadlineAt?: number;
  /** Epoch ms the request arrived, for the receipt. Defaults to the route's clock. */
  startedAt?: number;
  /** The proxy's check of the final provider payload (credential scan). It throws `E2EPayloadRefusedError` to stop the call. */
  inspectPayload?: (payload: unknown) => void;
  /** Per-call limits a group lowered below the route's. They can only lower the route's own, never raise them. */
  budgets?: Partial<Pick<Budgets, "callTimeoutMs" | "maxOutputTokens" | "maxPromptBytes" | "maxInputTokens">>;
}

export interface E2EModelGenerateOutcome {
  result: E2EModelChannelResult;
  receipt: E2EModelReceipt;
  /** Input tokens to charge against the group and the day. Unlike the receipt's count (the schema holds at most 64000), it is never clamped. */
  chargedInputTokens: number;
  /** The provider reported no usage, so the reserved upper bound is charged. */
  usageMissing?: true;
  /** SHA-256 of the provider payload as sent, when the call got that far. */
  providerPayloadSha256?: string;
}

export interface E2EModelCallIdentity {
  runId: string;
  caseId: string;
  stepIndex: number;
  callIndex: number;
}

export interface GovernedE2EModelRoute {
  readonly definition: E2EModelRouteDefinition;
  /** `e2eModelRouteRevision(definition)`. */
  readonly routeRevision: string;
  /** Secret values the route's invoke holds (the provider key). The proxy adds them to its credential scan. */
  readonly secretValues: readonly string[];
  generate(request: E2EModelChannelRequest, options?: E2EModelGenerateOptions): Promise<E2EModelGenerateOutcome>;
  /** A call the worker received and did not send to the provider (budget, busy, protocol, credential). It still gets a receipt. */
  decline(identity: E2EModelCallIdentity, code: E2EModelErrorCode, message: string, options?: { promptSha256?: string; startedAt?: number }): E2EModelGenerateOutcome;
}

export const E2E_BUDGET_EXHAUSTED_PREFIX = "model-route-budget-exhausted";
const FALLBACK_IDENTITY: E2EModelCallIdentity = { runId: "00000000-0000-4000-8000-000000000000", caseId: "unknown", stepIndex: 0, callIndex: 0 };

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : 0));

function digestOf(value: unknown): string {
  try { return sha256(canonicalJson(value)); } catch { return sha256("unserializable"); }
}

/** The digest a receipt carries for a prompt: SHA-256 of the call's canonical JSON. */
export function e2ePromptSha256(call: unknown): string {
  return digestOf(call ?? null);
}

/** Room for what the provider adds around the prompt: the role markers and the tool-use preamble Claude models carry when tools are present. */
const PROVIDER_PROMPT_OVERHEAD_TOKENS = 1_024;

/**
 * A true upper bound on the input tokens of a call, from the prompt's size alone: a token covers at least one byte of
 * text, plus the provider's own overhead. It is deliberately not capped at the route's per-call bound: a prompt whose
 * bound passes that limit (or the group's or the day's room) is refused before the call, so the bound is what the
 * group and the day reserve and no call in flight can pass a cap. It is conservative: the effective prompt size is
 * about `maxInputTokens - 1024` bytes until a token counter is wired in.
 */
export function e2eReservedInputTokens(promptBytes: number): number {
  return promptBytes + PROVIDER_PROMPT_OVERHEAD_TOKENS;
}

/** The provider's failure in words that cannot carry the prompt: the error's name and HTTP status, nothing else. */
function describeProviderFailure(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as { name?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } } : {};
  const name = typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(record.name) && record.name !== "Error" ? record.name : undefined;
  const status = [record.$metadata?.httpStatusCode, record.status, record.statusCode].find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const detail = [name, status === undefined ? undefined : `HTTP ${status}`].filter((part) => part !== undefined).join(", ");
  return detail === "" ? "provider call failed" : `provider call failed (${detail})`;
}

type Limits = Pick<Budgets, "callTimeoutMs" | "maxOutputTokens" | "maxPromptBytes" | "maxInputTokens">;
type Failed = { ok: false; code: "invalid-output" | "provider-error"; message: string; inputTokens: number; outputTokens: number; raw: unknown; usageMissing?: true };
type Checked = { ok: true; result: Extract<E2EModelChannelResult, { status: "ok" }>; inputTokens: number; outputTokens: number } | Failed;

const RECEIPT_MAX_OUTPUT_TOKENS = 1_024;

export function createGovernedE2EModelRoute(rawDefinition: E2EModelRouteDefinition, dependencies: GovernedE2EModelRouteDependencies): GovernedE2EModelRoute {
  const definition = E2EModelRouteDefinitionSchema.parse(rawDefinition);
  const routeRevision = e2eModelRouteRevision(definition);
  const identifier = e2eModelRouteInvokedIdentifier(definition);
  const budgets = definition.budgets;
  const { invoke, now } = dependencies;
  const newReceiptId = dependencies.newReceiptId ?? (() => `rcpt-${randomUUID()}`);
  const givenDayBudget = dependencies.dayBudget as E2EDayBudget | undefined;
  if (givenDayBudget === undefined || typeof givenDayBudget.reserve !== "function") throw new Error("a governed e2e model route needs a day budget");
  const dayBudget: E2EDayBudget = givenDayBudget;
  const dayLimits: E2EDayLimits = { maxInputTokens: budgets.maxInputTokensPerProjectDay, maxCalls: budgets.maxCallsPerProjectDay };

  function receiptFor(identity: E2EModelCallIdentity, receiptId: string, fields: { startedAtMs: number; outcome: E2EModelReceipt["outcome"]; inputTokens: number; outputTokens: number; latencyMs: number; promptSha256: string; responseSha256: string | null; served?: { model: string | null; upstream: string | null } }): E2EModelReceipt {
    return E2EModelReceiptSchema.parse({
      receiptId, runId: identity.runId, caseId: identity.caseId, stepIndex: identity.stepIndex, callIndex: identity.callIndex,
      routeId: definition.routeId, routeRevision, provider: definition.provider, modelId: definition.modelId,
      startedAt: new Date(fields.startedAtMs).toISOString(),
      inputTokens: clamp(fields.inputTokens, 64_000), outputTokens: clamp(fields.outputTokens, RECEIPT_MAX_OUTPUT_TOKENS),
      latencyMs: clamp(fields.latencyMs, 120_000),
      servedModelId: fields.served?.model?.slice(0, 200) || null, servedUpstream: fields.served?.upstream?.slice(0, 200) || null,
      promptSha256: fields.promptSha256, responseSha256: fields.responseSha256, outcome: fields.outcome,
    });
  }

  function decline(identity: E2EModelCallIdentity, code: E2EModelErrorCode, message: string, options: { promptSha256?: string; startedAt?: number } = {}): E2EModelGenerateOutcome {
    const startedAtMs = options.startedAt ?? now();
    const receipt = receiptFor(identity, newReceiptId(), {
      startedAtMs, outcome: code, inputTokens: 0, outputTokens: 0, latencyMs: Math.max(0, now() - startedAtMs),
      promptSha256: options.promptSha256 ?? sha256("no-prompt"), responseSha256: null,
    });
    return { result: { status: "error", code, message: message.slice(0, 240) }, receipt, chargedInputTokens: 0 };
  }

  function check(request: E2EModelChannelRequest, receiptId: string, output: E2EInvokeOutput, limits: Limits, reserved: number): Checked {
    const bad = (message: string, tokens = { inputTokens: 0, outputTokens: 0 }): Failed => ({ ok: false, code: "invalid-output", message, ...tokens, raw: output });
    if (typeof output !== "object" || output === null) return { ...bad("the provider returned no answer", { inputTokens: reserved, outputTokens: 0 }), usageMissing: true };
    const usage = output.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (usage === undefined || usage === null || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) {
      return { ...bad("the provider reported no usable usage; the reserved bound is counted", { inputTokens: reserved, outputTokens: 0 }), usageMissing: true };
    }
    const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    const served = typeof output.servedModelId === "string" && output.servedModelId !== "" ? output.servedModelId : null;
    if (served === null) {
      // Bedrock does not say which model answered, and neither does the scripted double: the pin is held by what is invoked. A keyed provider does say.
      if (definition.provider !== "amazon-bedrock" && definition.provider !== "rovara-scripted") return bad("the provider did not say which model served the call", tokens);
    } else if (served !== identifier && !e2eServedModelMatchesPin(definition.modelId, served)) {
      return bad("the answer came from a different model than the route pins", tokens);
    }
    const unified = output.finishReason?.unified;
    if (unified === "error") return { ok: false, code: "provider-error", message: "the provider ended the answer with an error", ...tokens, raw: output };
    if (unified !== "stop" && unified !== "tool-calls") return bad(`the answer did not finish cleanly (${typeof unified === "string" ? unified.slice(0, 32) : "unknown"})`, tokens);
    if (tokens.inputTokens > limits.maxInputTokens) return bad("the provider reported more input tokens than the route allows", tokens);
    if (tokens.outputTokens > limits.maxOutputTokens) return bad("the provider reported more output tokens than the route allows", tokens);
    const offered = new Set<string>(request.call.tools?.map((tool) => tool.name) ?? []);
    const content: ReadonlyArray<Record<string, unknown>> = Array.isArray(output.content) ? (output.content as ReadonlyArray<Record<string, unknown>>) : [];
    const seenIds = new Set<string>();
    for (const part of content) {
      if (part["type"] !== "tool-call") continue;
      if (typeof part["toolName"] !== "string" || !offered.has(part["toolName"])) return bad("the model called a tool the request did not offer", tokens);
      const id = String(part["toolCallId"]);
      if (seenIds.has(id)) return bad("the answer repeats a tool call id", tokens);
      seenIds.add(id);
      let parsed: unknown;
      try { parsed = JSON.parse(String(part["input"])); } catch { return bad("a tool call input is not JSON", tokens); }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad("a tool call input is not an object", tokens);
    }
    const candidate = { schemaVersion: "rovara-e2e-model-channel/v1", receiptId, result: { status: "ok", content, finishReason: { unified, raw: output.finishReason.raw ?? null }, usage: tokens } };
    const parsed = E2EModelChannelResponseSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.result.status !== "ok") return bad("the answer is not a valid channel answer", tokens);
    return { ok: true, result: parsed.data.result, ...tokens };
  }

  async function generate(raw: E2EModelChannelRequest, options: E2EModelGenerateOptions = {}): Promise<E2EModelGenerateOutcome> {
    const startedAtMs = options.startedAt ?? now();
    const parsedRequest = E2EModelChannelRequestSchema.safeParse(raw);
    const rawRecord = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<E2EModelChannelRequest>;
    const identity: E2EModelCallIdentity = parsedRequest.success
      ? { runId: parsedRequest.data.runId, caseId: parsedRequest.data.caseId, stepIndex: parsedRequest.data.stepIndex, callIndex: parsedRequest.data.callIndex }
      : { ...FALLBACK_IDENTITY, ...(typeof rawRecord.runId === "string" && /^[0-9a-f-]{36}$/.test(rawRecord.runId) ? { runId: rawRecord.runId } : {}) };
    const promptSha256 = digestOf(rawRecord.call ?? null);
    if (!parsedRequest.success) return decline(identity, "refused-protocol", "the request is not a valid model channel request", { promptSha256, startedAt: startedAtMs });
    const request = parsedRequest.data;
    const limits: Limits = {
      callTimeoutMs: Math.min(budgets.callTimeoutMs, options.budgets?.callTimeoutMs ?? budgets.callTimeoutMs),
      maxOutputTokens: Math.min(budgets.maxOutputTokens, options.budgets?.maxOutputTokens ?? budgets.maxOutputTokens),
      maxPromptBytes: Math.min(budgets.maxPromptBytes, options.budgets?.maxPromptBytes ?? budgets.maxPromptBytes),
      maxInputTokens: Math.min(budgets.maxInputTokens, options.budgets?.maxInputTokens ?? budgets.maxInputTokens),
    };
    const promptBytes = Buffer.byteLength(canonicalJson(request.call), "utf8");
    if (promptBytes > limits.maxPromptBytes) return decline(identity, "refused-protocol", "the prompt is above the route's prompt bound", { promptSha256, startedAt: startedAtMs });
    if (request.call.maxOutputTokens !== undefined && request.call.maxOutputTokens > limits.maxOutputTokens) {
      return decline(identity, "refused-protocol", "the call asks for more output than the route allows", { promptSha256, startedAt: startedAtMs });
    }
    const reserved = e2eReservedInputTokens(promptBytes);
    if (reserved > limits.maxInputTokens) {
      return decline(identity, "refused-protocol", `the prompt could pass the per-call input token limit of ${limits.maxInputTokens} (upper bound ${reserved})`, { promptSha256, startedAt: startedAtMs });
    }
    const deadline = options.deadlineAt ?? Number.POSITIVE_INFINITY;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return decline(identity, "timeout", "the run or step deadline passed before the call", { promptSha256, startedAt: startedAtMs });
    }
    let reservation: E2EDayReservation | null;
    try { reservation = await dayBudget.reserve(reserved, dayLimits); }
    catch { return decline(identity, "budget", `${E2E_BUDGET_EXHAUSTED_PREFIX}: the project's daily model budget could not be reserved`, { promptSha256, startedAt: startedAtMs }); }
    if (reservation === null) return decline(identity, "budget", `${E2E_BUDGET_EXHAUSTED_PREFIX}: the project's daily model budget is spent`, { promptSha256, startedAt: startedAtMs });

    const receiptId = newReceiptId();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = Math.max(1, Math.min(limits.callTimeoutMs, remainingMs));
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("model call timed out")); }, timeoutMs);
    const onCallerAbort = () => controller.abort(new Error("model call cancelled"));
    if (options.signal?.aborted === true) onCallerAbort();
    else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const stopped = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("model call stopped"));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    stopped.catch(() => undefined);

    let output: E2EInvokeOutput | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const pending = (async () => invoke({
        target: { provider: definition.provider, identifier, region: definition.region }, call: request.call, signal: controller.signal,
        sampling: "provider-default", thinking: "off", effort: definition.effort,
        maxOutputTokens: Math.min(limits.maxOutputTokens, request.call.maxOutputTokens ?? limits.maxOutputTokens),
        ...(options.inspectPayload === undefined ? {} : { inspectPayload: options.inspectPayload }),
      }))();
      pending.catch(() => undefined);
      output = await Promise.race([pending, stopped]);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
    const latencyMs = Math.max(0, now() - startedAtMs);

    type Extra = { usageMissing?: true; served?: { model: string | null; upstream: string | null }; providerPayloadSha256?: string };
    const finish = async (outcome: E2EModelReceipt["outcome"], result: E2EModelChannelResult, tokens: { inputTokens: number; outputTokens: number }, responseSha256: string | null, spendKnown: boolean, extra: Extra = {}): Promise<E2EModelGenerateOutcome> => {
      const carried = { ...(extra.usageMissing === true ? { usageMissing: true as const } : {}), ...(extra.providerPayloadSha256 === undefined ? {} : { providerPayloadSha256: extra.providerPayloadSha256 }) };
      if (spendKnown) {
        try { await reservation?.settle(tokens.inputTokens); }
        catch {
          const receipt = receiptFor(identity, receiptId, { startedAtMs, outcome: "provider-error", ...tokens, latencyMs, promptSha256, responseSha256: null, ...(extra.served === undefined ? {} : { served: extra.served }) });
          return { result: { status: "error", code: "provider-error", message: "the project's daily model budget could not be settled" }, receipt, chargedInputTokens: tokens.inputTokens, ...carried };
        }
      }
      const receipt = receiptFor(identity, receiptId, { startedAtMs, outcome, ...tokens, latencyMs, promptSha256, responseSha256, ...(extra.served === undefined ? {} : { served: extra.served }) });
      return { result, receipt, chargedInputTokens: tokens.inputTokens, ...carried };
    };

    if (failed || output === undefined) {
      if (failure instanceof E2EPayloadRefusedError || (failure as { name?: unknown } | undefined)?.name === "E2EPayloadRefusedError") {
        // Nothing was sent, so nothing was spent: the reservation is released.
        return finish("refused-credential-match", { status: "error", code: "refused-credential-match", message: "model-prompt-credential-match: the provider payload carried a seeded credential or credential-shaped text" }, { inputTokens: 0, outputTokens: 0 }, null, true);
      }
      // A failure before any request went out (a setup, guard, mismatch or shaping refusal) spent nothing: charge 0 and release the reservation.
      if ((failure as { requestNotSent?: unknown } | undefined)?.requestNotSent === true && !timedOut) {
        return finish("provider-error", { status: "error", code: "provider-error", message: describeProviderFailure(failure) }, { inputTokens: 0, outputTokens: 0 }, null, true);
      }
      if (timedOut) return finish("timeout", { status: "error", code: "timeout", message: "the model call exceeded its time limit" }, { inputTokens: reserved, outputTokens: 0 }, null, false);
      const cancelled = controller.signal.aborted;
      // A call that failed after the provider began to answer may have been billed: charge the reserved bound, as for a timeout.
      const billed = (failure as { mayHaveBeenBilled?: unknown } | undefined)?.mayHaveBeenBilled === true;
      return finish("provider-error", { status: "error", code: "provider-error", message: cancelled ? "the model call was cancelled by the run" : describeProviderFailure(failure) }, { inputTokens: billed ? reserved : 0, outputTokens: 0 }, null, false);
    }
    if (latencyMs > limits.callTimeoutMs) {
      return finish("timeout", { status: "error", code: "timeout", message: "the model call exceeded its time limit" }, { inputTokens: reserved, outputTokens: 0 }, null, false);
    }
    const checked = check(request, receiptId, output, limits, reserved);
    const extra: Extra = {
      served: { model: typeof output.servedModelId === "string" ? output.servedModelId : null, upstream: typeof output.servedUpstream === "string" ? output.servedUpstream : null },
      ...(typeof output.providerPayloadSha256 === "string" && /^[a-f0-9]{64}$/.test(output.providerPayloadSha256) ? { providerPayloadSha256: output.providerPayloadSha256 } : {}),
    };
    if (checked.ok) {
      return finish("ok", checked.result, { inputTokens: checked.inputTokens, outputTokens: checked.outputTokens }, digestOf(checked.result), true, extra);
    }
    const responseSha256 = checked.code === "invalid-output" ? digestOf(checked.raw) : null;
    return finish(checked.code, { status: "error", code: checked.code, message: checked.message.slice(0, 240) }, { inputTokens: checked.inputTokens, outputTokens: checked.outputTokens }, responseSha256, checked.code === "invalid-output", { ...extra, ...(checked.usageMissing === true ? { usageMissing: true as const } : {}) });
  }

  const secretValues = (dependencies.invoke as { secrets?: readonly string[] }).secrets ?? [];
  return { definition, routeRevision, secretValues, generate, decline };
}
