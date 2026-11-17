// The hosted start box classifier (lead 4 L4-HC; DEC 173): Slack's own router prompt and parser (contracts/slack-routing.ts), asked as ONE small call through the SAME model seam the hosted answers use
// (`AnswerModel`: on hosted, the answers gateway adapter with its answers token, company binding and the company's own key). No second copy of the sorting, no second gateway path, no key in Code.
//
//  - The person's words arrive only inside the fenced `<message>` the prompt builds; the whole reply must be exactly one route object; the model's reason is dropped here.
//  - One call, a fixed 120-token cap, a fixed small ceiling. Every call is opened and closed once (the adapter's own bookkeeping), whatever happened.
//  - ANY refusal (no connected key, the month's limit, over budget, a gateway fault, a missing gateway) is the outcome `unavailable`: the suggestion says the classifier is unavailable and the page falls back to its
//    one-press Quick. A reply that is not a route is `invalid`; a deadline that passed is `timeout`. Nothing the gateway, the model or the caller sent is echoed or logged. It never throws.
//  - The company is bound ONCE, where the router is made (`createModelStartRouter` for one company, from a model made for that company): the call cannot name another.
import { randomBytes } from "node:crypto";
import { AGENTX_NAME_PATTERN, REQUEST_ROUTER_SYSTEM_PROMPT, parseRequestRoute, requestRouterPrompt, type OrgId } from "@agentx/contracts";
import { AnswerModelRefused, type AnswerModel } from "./ports.js";
import type { StartRouter } from "./start-suggest.js";

/** The most the router may write (a route object is about 40 tokens). */
export const START_ROUTER_MAX_OUTPUT_TOKENS = 120;
/** What one classification may cost at most, in cents (a few hundred tokens of input and the 120 of output are far below it). */
export const START_ROUTER_CEILING_CENTS = 2;
const PERSON_MAX = 100;

/** An id of the shape the gateway adapter's reservation takes (`answer:` + this). Fresh for every call, so a classification never shares a reservation or a meter key with an answer. */
const callId = (): string => `a${randomBytes(16).toString("hex").slice(0, 31)}`;

export function createModelStartRouter(input: { model: AnswerModel; companyId: OrgId; project: string; personId: string }): StartRouter {
  return async (text, signal) => {
    const unavailable = { kind: "unclear", outcome: "unavailable" } as const;
    if (!AGENTX_NAME_PATTERN.test(input.project) || typeof input.personId !== "string" || input.personId === "" || input.personId.length > PERSON_MAX) return unavailable;
    try {
      if (!(await input.model.available())) return unavailable;
      const session = await input.model.open({ companyId: input.companyId, project: input.project, personId: input.personId, answerId: callId(), ceilingCents: START_ROUTER_CEILING_CENTS });
      let spent: { costCents?: number | undefined; tokens: number } = { tokens: 0 };
      try {
        const reply = await session.complete({ system: REQUEST_ROUTER_SYSTEM_PROMPT, transcript: requestRouterPrompt(text), maxOutputTokens: START_ROUTER_MAX_OUTPUT_TOKENS, signal, remainingCents: START_ROUTER_CEILING_CENTS });
        spent = { ...(reply.costCents === undefined ? {} : { costCents: reply.costCents }), tokens: (reply.tokens?.input ?? 0) + (reply.tokens?.output ?? 0) };
        const route = parseRequestRoute(reply.text);
        return route === undefined ? { kind: "unclear", outcome: "invalid" } : { kind: route.kind, outcome: "ok" };
      } catch (error) {
        // A refusal the company or the gateway made (no key, no room, over budget) is "unavailable" even when the deadline has also passed; a plain fault after the deadline is a timeout.
        if (error instanceof AnswerModelRefused && error.reason !== "unavailable") return unavailable;
        return signal.aborted ? { kind: "unclear", outcome: "timeout" } : unavailable;
      } finally {
        await session.finish(spent).catch(() => undefined);
      }
    } catch {
      return unavailable;
    }
  };
}

/**
 * The hosted wiring's classifier for each company, project and person: a router over the company's answers model, or undefined when the deployment has none (no gateway, a Bedrock-only agent model, no
 * task-token key): the suggestion then says `unavailable` and asks nothing. `models` is read on every request (a deployment whose signer arrives late is picked up then).
 */
export function hostedStartRoute(models: () => ((companyId: OrgId) => AnswerModel | undefined) | undefined): (companyId: OrgId, scope: { project: string; personId: string }) => StartRouter | undefined {
  return (companyId, scope) => {
    const model = models()?.(companyId);
    return model === undefined ? undefined : createModelStartRouter({ model, companyId, project: scope.project, personId: scope.personId });
  };
}
