// Task 21: sorts a plain top-level Slack request into a question, a small change, a large change or unclear, with the
// action gate's own classifier model, runtime and deadline. It only suggests: nothing that changes code starts from it.
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntimeWithFallback } from "@agentx/model-runtime";
import { REQUEST_ROUTER_SYSTEM_PROMPT, parseRequestRoute, requestRouterPrompt, type RequestRouteKind, type RequestRouteOutcome } from "@agentx/contracts";
import { ClassifierError, ClassifierTimeoutError, completeBeforeDeadline, usableClassifierTimeout } from "./action-classifier.js";

/** The router's sorting and how it went. Anything but a usable answer is `unclear`; never the model's reason. */
export interface RequestRoute {
  kind: RequestRouteKind;
  outcome: RequestRouteOutcome;
}

export type RequestRouter = (message: string, signal?: AbortSignal) => Promise<RequestRoute>;

/** Routing waits for the model at most this long, however long the classifier's own timeout is. */
export const REQUEST_ROUTER_TIMEOUT_MAX_MS = 4_000;

/**
 * A router on the classifier model. An unknown model throws here when `failOnUnknownModel` is set; once made, it never
 * throws: a timeout says `timeout`, and an error or an answer that is not exactly one route says `invalid`, both
 * `unclear`.
 */
export async function createModelRequestRouter(options: {
  model: { provider: string; modelId: string };
  timeoutMs?: number;
  modelRuntime?: ModelRuntime;
  failOnUnknownModel?: boolean;
}): Promise<RequestRouter> {
  const resolved = options.modelRuntime ? { runtime: options.modelRuntime, model: options.model }
    : await createModelRuntimeWithFallback(options.model, "classifier");
  const runtime = resolved.runtime;
  const model = runtime.getModel(resolved.model.provider, resolved.model.modelId);
  if (!model && options.failOnUnknownModel === true) throw new ClassifierError("the classifier model is unavailable");
  const timeoutMs = Math.min(usableClassifierTimeout(options.timeoutMs), REQUEST_ROUTER_TIMEOUT_MAX_MS);
  return async (message, signal) => {
    if (!model) return { kind: "unclear", outcome: "unavailable" };
    try {
      const answer = await completeBeforeDeadline(runtime, model, {
        systemPrompt: REQUEST_ROUTER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: requestRouterPrompt(message), timestamp: 0 }],
      }, { timeoutMs, signal, maxTokens: 120 });
      if (answer.stopReason === "error" || answer.stopReason === "aborted") return { kind: "unclear", outcome: "invalid" };
      const route = parseRequestRoute(answer.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"));
      return route === undefined ? { kind: "unclear", outcome: "invalid" } : { kind: route.kind, outcome: "ok" };
    } catch (error) {
      return { kind: "unclear", outcome: error instanceof ClassifierTimeoutError ? "timeout" : "invalid" };
    }
  };
}
