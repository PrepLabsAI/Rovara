// The model call a diagnosis makes on this computer (`DiagnosisAnswerer`, core/diagnosis/service.ts). One request with no tools to the model the install chose for its steps, made THROUGH the local model proxy with the
// owner's own key: the proxy checks the request (the same guard a worker's call passes), holds the call to a spending cap of its own, reads the key from the `model-keys` port, signs the call, meters what it used, and
// cuts the key from the answer. This module never sees a key. A failure is a fixed word, never the provider's words (they can quote the key or the request).
//
// The cap is DIAGNOSIS_LIGHT_BUDGET_USD, priced from the model's own rates (the catalog's, or a `model-provider` plug-in's price table). A model whose price is not known cannot be held to the cap, so no diagnosis runs on it
// (a model with no price is refused, never guessed; a price of zero counts as no price unless the plug-in says the model is free).
import { DIAGNOSIS_LIGHT_BUDGET_USD, providerFormat, type ModelProviderAdapter } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { createModelPrices, usdPerMillion } from "../core/cost/price-table.js";
import { DiagnosisModelProblem, type DiagnosisAnswerer, type DiagnosisModelFailure } from "../core/diagnosis/service.js";
import { requestBody, textOf } from "./ask-model.js";
import type { LocalModelChoice } from "./model-choice.js";
import { callThroughProxy, type LoopbackProxy, type OneShotOperations } from "./model-proxy/one-shot.js";
import { worstCaseUsage } from "./model-proxy/proxy.js";
import { localRoute } from "./model-proxy/providers.js";
import type { ModelProviderBook, ProxyApi, ProxyRouteCap } from "./model-proxy/types.js";
import { usageOf } from "./model-proxy/usage.js";

export interface LocalDiagnosisModelOptions {
  /** The model the install's steps use (the owner's `model` setting, else the first provider with a key); undefined: none is set up. */
  choice: () => Promise<LocalModelChoice | undefined>;
  providers: ModelProviderBook;
  /** The proxy, read late (it is made after the app). Undefined: not running yet. */
  proxy: () => LoopbackProxy | undefined;
  operations: OneShotOperations;
  /** For tests: the most one diagnosis may spend. Default `DIAGNOSIS_LIGHT_BUDGET_USD`. */
  capUsd?: number | undefined;
  /** For tests: a model's rates in dollars per million tokens (default: the installed catalog, then the provider plug-in's price table). */
  rates?: ((provider: string, model: string, row: ModelProviderAdapter | undefined) => ProxyRouteCap["usdPerMTok"] | undefined) | undefined;
}

/**
 * A model's rates in dollars per million tokens, from the install's one price lookup (`core/cost/price-table.ts`): the provider plug-in's own table first, then the catalog's list price. Undefined when neither knows a
 * real price, or the price is not in dollars (the cap is in dollars: a currency worth more than the dollar would under-cap the call, so such a model counts as unpriced). A model the plug-in marks `free` is priced, at zero.
 */
export function modelRatesOf(provider: string, model: string, row: ModelProviderAdapter | undefined, catalog: typeof listPricesPerMillion = listPricesPerMillion): ProxyRouteCap["usdPerMTok"] | undefined {
  return usdPerMillion(createModelPrices({ providers: () => (row === undefined ? [] : [row]), catalog }).findCap({ provider, modelId: model }));
}

/**
 * The proxy's refusals that PROVE it refused before forwarding the call to the provider (nothing was sent, so nothing can have been charged): each is thrown ahead of the send. Any other answer may follow a send, and
 * `model_proxy_unavailable` is one of those: the proxy also answers it when its own copy of an answer fails after the provider answered (an answer too large, a connection cut), by which time the call is charged.
 */
const BEFORE_SEND = new Set([
  "not_found", "invalid_token", "token_expired", "other_workspace", "operation_ended", "too_many_requests", "request_too_large", "invalid_json", "request_not_allowed", "model_not_allowed", "budget_exceeded",
  "budget_held", "provider_sign_in_failed", "method_not_allowed", "model_not_priced",
]);

/** What the proxy's refusal or the provider's error means for the person, as a fixed word. The proxy's own words are never passed on. */
function problemOf(status: number, text: string): DiagnosisModelProblem {
  const problem = reasonOfAnswer(status, text);
  return new DiagnosisModelProblem(problem.reason, !problem.beforeSend);
}

export function reasonOfAnswer(status: number, text: string): { reason: DiagnosisModelFailure; beforeSend: boolean } {
  let code = "";
  let message = "";
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
    code = typeof error?.code === "string" ? error.code : "";
    message = typeof error?.message === "string" ? error.message : "";
  } catch { /* not JSON */ }
  const beforeSend = BEFORE_SEND.has(code);
  const word = (reason: DiagnosisModelFailure): { reason: DiagnosisModelFailure; beforeSend: boolean } => ({ reason, beforeSend });
  if (code === "budget_exceeded" || code === "budget_held") return word("limit_reached");
  if (code === "provider_refused_key" || code === "provider_sign_in_failed" || code === "provider_clock_skew") return word("key_invalid");
  if (code === "model_not_priced") return word("not_priced");
  if (code === "model_not_allowed") return word(/\bno (?:\S+ )?(?:key|sign-in)\b/u.test(message) ? "key_invalid" : /no price/u.test(message) ? "not_priced" : "model_rejected");
  if (code === "request_not_allowed") return word("model_rejected");
  if (code === "provider_error" && (status === 400 || status === 404 || status === 422)) return word("model_rejected");
  if (code === "provider_unreachable" || code === "provider_error" || code === "model_proxy_unavailable" || status === 429 || status >= 500) return word("provider_unavailable");
  return word("other");
}

/** The most one call could cost, in millionths of a dollar, by the proxy's own rule (`worstCaseUsage`) and the route's rates (the dearer of the plain and the cache-write input rate). */
export function worstCaseMicros(api: ProxyApi, alias: string, cap: ProxyRouteCap, request: { context: string; question: string; maxOutputTokens: number }): number {
  const body = requestBody(api, alias, request.context, request.question, request.maxOutputTokens);
  const worst = worstCaseUsage(body, Buffer.byteLength(JSON.stringify(body), "utf8"));
  const rates = cap.usdPerMTok;
  return Math.ceil(worst.input * Math.max(rates.input, rates.cacheWrite) + worst.output * rates.output);
}

export function createLocalDiagnosisModel(options: LocalDiagnosisModelOptions): DiagnosisAnswerer {
  const capUsd = options.capUsd ?? DIAGNOSIS_LIGHT_BUDGET_USD;
  const rates = options.rates ?? modelRatesOf;

  /** The model, its route (with the cap) and the format it speaks, or the reason none can be used. */
  async function plan(): Promise<{ ok: true; choice: LocalModelChoice; api: ProxyApi; cap: ProxyRouteCap } | { ok: false; reason: "no_model" | "not_priced" }> {
    const choice = await options.choice();
    if (choice === undefined) return { ok: false, reason: "no_model" };
    const row = options.providers.get(choice.provider);
    const format = row === undefined ? undefined : providerFormat(row, choice.api);
    if (row === undefined || format === undefined) return { ok: false, reason: "no_model" };
    const priced = rates(choice.provider, choice.model, row);
    if (priced === undefined) return { ok: false, reason: "not_priced" };
    return { ok: true, choice, api: format.format, cap: { capUsd, usdPerMTok: priced } };
  }

  return {
    async prepare(request) {
      const planned = await plan();
      if (!planned.ok) return { ok: false, reason: planned.reason };
      if (options.proxy() === undefined) return { ok: false, reason: "no_model" };
      // The most the call could cost, worked out as the proxy works it out (an input of one token to each byte of the request, the output limit), against the cap: a call the proxy could only refuse is not offered.
      if (request !== undefined) {
        const routed = localRoute(planned.choice.provider, planned.choice.model, planned.api).route;
        if (worstCaseMicros(planned.api, routed.alias, planned.cap, request) > Math.round(planned.cap.capUsd * 1_000_000)) return { ok: false, reason: "too_dear" };
      }
      return { ok: true };
    },
    async answer({ context, question, maxOutputTokens, signal, diagnosisId, taskId, project }) {
      const planned = await plan();
      const proxy = options.proxy();
      // Nothing is sent before these: the allowance is given back.
      if (!planned.ok) throw new DiagnosisModelProblem(planned.reason, false);
      if (proxy === undefined) throw new DiagnosisModelProblem("no_model", false);
      const { choice, api, cap } = planned;
      const routed = localRoute(choice.provider, choice.model, api);
      const route = { ...routed.route, cap };
      let answer;
      try {
        answer = await callThroughProxy(proxy, options.operations, {
          operationId: `diagnosis:${diagnosisId}`, workspaceId: `diagnosis-${diagnosisId}`, taskId, projectName: project, route, api, signal,
          body: requestBody(api, route.alias, context, question, maxOutputTokens),
        });
      } catch {
        throw new DiagnosisModelProblem("provider_unavailable");
      }
      if (answer.status < 200 || answer.status >= 300) throw problemOf(answer.status, answer.text);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(answer.text) as Record<string, unknown>; } catch { throw new DiagnosisModelProblem("other"); }
      const text = textOf(api, parsed);
      if (text === "") throw new DiagnosisModelProblem("other");
      const used = usageOf(api, parsed["usage"]);
      return {
        text, model: `${choice.provider}/${choice.model}`,
        ...(used === undefined ? {} : { usage: { input: used.input ?? 0, output: used.output ?? 0, cacheRead: used.cacheRead ?? 0, cacheWrite: used.cacheWrite ?? 0 } }),
      };
    },
  };
}
