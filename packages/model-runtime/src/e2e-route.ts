import { createHash, randomUUID } from "node:crypto";
import {
  E2EModelChannelRequestSchema,
  E2EModelChannelResponseSchema,
  E2EModelReceiptSchema,
  E2EModelRouteDefinitionSchema,
  canonicalJson,
  e2eModelRouteInvokedIdentifier,
  e2eModelRouteRevision,
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

/** What the route hands the provider call. The provider sees nothing else of the request. */
export interface E2EInvokeInput {
  /** The one identifier to invoke: the inference profile ARN when the route has one, else the model id. */
  identifier: string;
  region: string | null;
  call: E2EModelChannelCall;
  /** The smaller of the route's output cap and the call's. */
  maxOutputTokens: number;
  temperature: 0;
  /** Aborted at the per-call timeout and when the run ends. The provider call must stop on it. */
  signal: AbortSignal;
}

/** What a provider call returns. The route validates all of it before anything reaches the executor. */
export interface E2EInvokeOutput {
  /** The model that answered. It must be the pinned one. */
  servedModelId: string;
  content: ReadonlyArray<Record<string, unknown>>;
  finishReason: { unified: string; raw: string | null };
  usage: { inputTokens: number; outputTokens: number };
}

export type E2EInvoke = (input: E2EInvokeInput) => Promise<E2EInvokeOutput>;

/** The project's day budget, kept outside the worker (the broker's table); the route only reserves and settles. */
export interface E2EDayBudget {
  /** Reserves one call and `inputTokens`, or returns null when either day cap would be passed. */
  reserve(inputTokens: number): E2EDayReservation | null | Promise<E2EDayReservation | null>;
}
export interface E2EDayReservation {
  /** Settles the reservation with the tokens the provider reported. Not called when the spend is unknown, which keeps the reservation. */
  settle(actualInputTokens: number): void | Promise<void>;
}

export interface InMemoryE2EDayBudget extends E2EDayBudget {
  snapshot(): { usedInputTokens: number; usedCalls: number };
}

/** A day budget held in memory: the test double, and a single-process fallback. The broker-backed one is Task 4.2's. */
export function createInMemoryE2EDayBudget(input: { maxInputTokens: number; maxCalls: number; usedInputTokens?: number; usedCalls?: number }): InMemoryE2EDayBudget {
  let usedInputTokens = input.usedInputTokens ?? 0;
  let usedCalls = input.usedCalls ?? 0;
  return {
    reserve(inputTokens) {
      if (usedCalls + 1 > input.maxCalls || usedInputTokens + inputTokens > input.maxInputTokens) return null;
      usedCalls += 1;
      usedInputTokens += inputTokens;
      let settled = false;
      return { settle(actual) { if (settled) return; settled = true; usedInputTokens += actual - inputTokens; } };
    },
    snapshot: () => ({ usedInputTokens, usedCalls }),
  };
}

export interface GovernedE2EModelRouteDependencies {
  invoke: E2EInvoke;
  /** Milliseconds since the epoch. Injected so tests control time. */
  now: () => number;
  dayBudget?: E2EDayBudget;
  newReceiptId?: () => string;
}

export interface E2EModelGenerateOptions {
  signal?: AbortSignal;
  /** Epoch ms. The call never outlives it (the run's and the step's deadline). */
  deadlineAt?: number;
  /** Epoch ms the request arrived, for the receipt. Defaults to the route's clock. */
  startedAt?: number;
}

export interface E2EModelGenerateOutcome {
  result: E2EModelChannelResult;
  receipt: E2EModelReceipt;
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
  generate(request: E2EModelChannelRequest, options?: E2EModelGenerateOptions): Promise<E2EModelGenerateOutcome>;
  /** A call the worker received and did not send to the provider (budget, busy, protocol, credential). It still gets a receipt. */
  decline(identity: E2EModelCallIdentity, code: Exclude<E2EModelErrorCode, "provider-error" | "invalid-output">, message: string, options?: { promptSha256?: string; startedAt?: number }): E2EModelGenerateOutcome;
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

/**
 * Tokens to reserve for a call before it is made: an upper bound from the prompt's size (a token is at least a byte of
 * text in practice, and the tool and role overhead is small), capped at the route's per-call input bound. The group and
 * the day reserve this, then settle with what the provider reports, so neither can be passed by a call in flight.
 */
export function e2eReservedInputTokens(promptBytes: number, budgets: Pick<Budgets, "maxInputTokens">): number {
  return Math.min(budgets.maxInputTokens, promptBytes + 256);
}

/** The provider's failure in words that cannot carry the prompt: the error's name and HTTP status, nothing else. */
function describeProviderFailure(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as { name?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } } : {};
  const name = typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(record.name) && record.name !== "Error" ? record.name : undefined;
  const status = [record.$metadata?.httpStatusCode, record.status, record.statusCode].find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const detail = [name, status === undefined ? undefined : `HTTP ${status}`].filter((part) => part !== undefined).join(", ");
  return detail === "" ? "provider call failed" : `provider call failed (${detail})`;
}

type Checked = { ok: true; result: Extract<E2EModelChannelResult, { status: "ok" }>; inputTokens: number; outputTokens: number }
  | { ok: false; code: "invalid-output" | "provider-error"; message: string; inputTokens: number; outputTokens: number; raw: unknown };

export function createGovernedE2EModelRoute(rawDefinition: E2EModelRouteDefinition, dependencies: GovernedE2EModelRouteDependencies): GovernedE2EModelRoute {
  const definition = E2EModelRouteDefinitionSchema.parse(rawDefinition);
  const routeRevision = e2eModelRouteRevision(definition);
  const identifier = e2eModelRouteInvokedIdentifier(definition);
  const budgets = definition.budgets;
  const { invoke, now } = dependencies;
  const newReceiptId = dependencies.newReceiptId ?? (() => `rcpt-${randomUUID()}`);

  function receiptFor(identity: E2EModelCallIdentity, receiptId: string, fields: { startedAtMs: number; outcome: E2EModelReceipt["outcome"]; inputTokens: number; outputTokens: number; latencyMs: number; promptSha256: string; responseSha256: string | null }): E2EModelReceipt {
    return E2EModelReceiptSchema.parse({
      receiptId, runId: identity.runId, caseId: identity.caseId, stepIndex: identity.stepIndex, callIndex: identity.callIndex,
      routeId: definition.routeId, routeRevision, provider: definition.provider, modelId: definition.modelId,
      startedAt: new Date(fields.startedAtMs).toISOString(),
      inputTokens: clamp(fields.inputTokens, 64_000), outputTokens: clamp(fields.outputTokens, budgets.maxOutputTokens),
      latencyMs: clamp(fields.latencyMs, 120_000), promptSha256: fields.promptSha256, responseSha256: fields.responseSha256, outcome: fields.outcome,
    });
  }

  function decline(identity: E2EModelCallIdentity, code: Exclude<E2EModelErrorCode, "provider-error" | "invalid-output">, message: string, options: { promptSha256?: string; startedAt?: number } = {}): E2EModelGenerateOutcome {
    const startedAtMs = options.startedAt ?? now();
    const receipt = receiptFor(identity, newReceiptId(), {
      startedAtMs, outcome: code, inputTokens: 0, outputTokens: 0, latencyMs: Math.max(0, now() - startedAtMs),
      promptSha256: options.promptSha256 ?? sha256("no-prompt"), responseSha256: null,
    });
    return { result: { status: "error", code, message: message.slice(0, 240) }, receipt };
  }

  function check(request: E2EModelChannelRequest, receiptId: string, output: E2EInvokeOutput): Checked {
    const bad = (message: string, tokens = { inputTokens: 0, outputTokens: 0 }): Checked => ({ ok: false, code: "invalid-output", message, ...tokens, raw: output });
    if (typeof output !== "object" || output === null) return bad("the provider returned no answer");
    const usage = output.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (usage === undefined || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return bad("the provider reported no usable token counts");
    const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    if (output.servedModelId !== identifier && output.servedModelId !== definition.modelId) return bad("the answer came from a different model than the route pins", tokens);
    const unified = output.finishReason?.unified;
    if (unified === "error") return { ok: false, code: "provider-error", message: "the provider ended the answer with an error", ...tokens, raw: output };
    if (unified !== "stop" && unified !== "tool-calls") return bad(`the answer did not finish cleanly (${typeof unified === "string" ? unified.slice(0, 32) : "unknown"})`, tokens);
    if (tokens.inputTokens > budgets.maxInputTokens) return bad("the provider reported more input tokens than the route allows", tokens);
    if (tokens.outputTokens > budgets.maxOutputTokens) return bad("the provider reported more output tokens than the route allows", tokens);
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
    const promptBytes = Buffer.byteLength(canonicalJson(request.call), "utf8");
    if (promptBytes > budgets.maxPromptBytes) return decline(identity, "refused-protocol", "the prompt is above the route's prompt bound", { promptSha256, startedAt: startedAtMs });
    if (request.call.maxOutputTokens !== undefined && request.call.maxOutputTokens > budgets.maxOutputTokens) {
      return decline(identity, "refused-protocol", "the call asks for more output than the route allows", { promptSha256, startedAt: startedAtMs });
    }
    const deadline = options.deadlineAt ?? Number.POSITIVE_INFINITY;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return decline(identity, "timeout", "the run or step deadline passed before the call", { promptSha256, startedAt: startedAtMs });
    }
    const reserved = e2eReservedInputTokens(promptBytes, budgets);
    const reservation = dependencies.dayBudget === undefined ? undefined : await dependencies.dayBudget.reserve(reserved);
    if (reservation === null) return decline(identity, "budget", `${E2E_BUDGET_EXHAUSTED_PREFIX}: the project's daily model budget is spent`, { promptSha256, startedAt: startedAtMs });

    const receiptId = newReceiptId();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = Math.max(1, Math.min(budgets.callTimeoutMs, remainingMs));
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
        identifier, region: definition.region, call: request.call, temperature: 0, signal: controller.signal,
        maxOutputTokens: Math.min(budgets.maxOutputTokens, request.call.maxOutputTokens ?? budgets.maxOutputTokens),
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

    const finish = async (outcome: E2EModelReceipt["outcome"], result: E2EModelChannelResult, tokens: { inputTokens: number; outputTokens: number }, responseSha256: string | null, spendKnown: boolean): Promise<E2EModelGenerateOutcome> => {
      const receipt = receiptFor(identity, receiptId, { startedAtMs, outcome, ...tokens, latencyMs, promptSha256, responseSha256 });
      if (spendKnown) await reservation?.settle(tokens.inputTokens);
      return { result, receipt };
    };

    if (failed || output === undefined) {
      if (timedOut) return finish("timeout", { status: "error", code: "timeout", message: "the model call exceeded its time limit" }, { inputTokens: reserved, outputTokens: 0 }, null, false);
      const cancelled = controller.signal.aborted;
      return finish("provider-error", { status: "error", code: "provider-error", message: cancelled ? "the model call was cancelled by the run" : describeProviderFailure(failure) }, { inputTokens: 0, outputTokens: 0 }, null, false);
    }
    if (latencyMs > budgets.callTimeoutMs) {
      return finish("timeout", { status: "error", code: "timeout", message: "the model call exceeded its time limit" }, { inputTokens: reserved, outputTokens: 0 }, null, false);
    }
    const checked = check(request, receiptId, output);
    if (checked.ok) {
      return finish("ok", checked.result, { inputTokens: checked.inputTokens, outputTokens: checked.outputTokens }, digestOf(checked.result), true);
    }
    const responseSha256 = checked.code === "invalid-output" ? digestOf(checked.raw) : null;
    return finish(checked.code, { status: "error", code: checked.code, message: checked.message.slice(0, 240) }, { inputTokens: checked.inputTokens, outputTokens: checked.outputTokens }, responseSha256, checked.code === "invalid-output");
  }

  return { definition, routeRevision, generate, decline };
}
