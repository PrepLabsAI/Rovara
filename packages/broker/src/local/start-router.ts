// The start box's classifier on this computer (lead 4 J3; DEC 173): Slack's own router prompt and parser (contracts/slack-routing.ts: REQUEST_ROUTER_SYSTEM_PROMPT, requestRouterPrompt, parseRequestRoute), asked
// through the existing Ask model path (`AskAnswerer`: one request, no tools, the install's own key, made by the broker). No second copy of the sorting: the person's words arrive only inside the fenced
// `<message>` the prompt builds, the whole reply must be exactly one route object, and the model's reason is dropped here. It never throws.
import { REQUEST_ROUTER_SYSTEM_PROMPT, parseRequestRoute, requestRouterPrompt } from "@agentx/contracts";
import type { AskAnswerer } from "../core/sessions/ask.js";
import type { StartRouter } from "../core/answers/start-suggest.js";

/** The most the router may write (a route object is about 40 tokens). */
const ROUTER_MAX_OUTPUT_TOKENS = 120;

export function createAskStartRouter(answerer: AskAnswerer): StartRouter {
  return async (text, signal) => {
    try {
      if (answerer.available !== undefined && !(await answerer.available())) return { kind: "unclear", outcome: "unavailable" };
      const reply = await answerer.answer({ context: REQUEST_ROUTER_SYSTEM_PROMPT, question: requestRouterPrompt(text), maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS, signal, taskId: "start-suggest" });
      const route = parseRequestRoute(reply.text);
      return route === undefined ? { kind: "unclear", outcome: "invalid" } : { kind: route.kind, outcome: "ok" };
    } catch {
      return { kind: "unclear", outcome: signal.aborted ? "timeout" : "invalid" };
    }
  };
}
