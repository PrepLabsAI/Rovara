// The answers call class (lead 4 L4-E, DEC 254z-amend2 option A): answers to people's questions (hosted "Ask about this task" and smart Just answer)
// on the company's OWN connected provider account, never Rovara's install key. It is the learning route's machinery (learning-route.ts,
// createLearningRoutes) with its own flavor: no code of the money core, the key sources, the providers, the guards or the secret scanner is copied.
//
//   Token    the TC-1 task token with `stp` = ANSWERS_STEP. That step is accepted on this route only, and this route accepts no other step
//            (server.ts checks both directions with the fixed 401, before anything is read, held or sent). A learning token is refused here too.
//   Key      LearningKeySource only (the company's own connected account). This route is never handed the gateway's ProviderKeys. One exception (DEC 254zzz3(1)):
//            a company the operator named exempt, with no connected account and Rovara's AI as its effective source, is served by Rovara's AI (`rovaraDefault`).
//   Paths    /v1/answers/messages (Anthropic Messages; also /v1/answers/v1/messages, where an Anthropic client's base URL is /v1/answers: Slack chat and routing, DEC 254zzz79 (3)), /v1/answers/gemini/..., /v1/answers/vertex/..., /v1/answers/openai/chat/completions: the same
//            provider paths as the learning route under their own prefix. The company must have THAT provider connected.
//   Money    its OWN meter (separate tables), combined with the agent meter's company row exactly as learning's is (DEC 228c): one hold takes the answers
//            month row (the meter's company row: min(the company's answers limit, its monthly cap)) AND the combined company row. Task and project rows
//            are accounting only; no person pays. A meter that does not combine holds nothing (503).
//   Limit    the company's `answers_month` spend limit (Cloud SPEND_LIMIT_KINDS, scope company; read with readSpendLimit, strongly consistent), else
//            ANSWERS_DEFAULT_MONTH_MICROS. $0 pauses answers. An item that does not read refuses the call.
//   Pause    every refusal Code should turn into "answers are paused" is `answers_paused` with a fixed message and the reason in ANSWERS_PAUSE_HEADER.
//            Faults (an unreadable limit or budget) are errors, never a pause.
//   Cost     a complete non-streaming success carries ANSWERS_COST_HEADER: the amount the same settle wrote to the meter (see GatewayRoute.costHeader).
import type { Caps } from "./caps.js";
import { createLearningRoutes, type CompanyKeyFlavor, type LearningPauseReason, type LearningRouteFactory, type LearningRouteOptions } from "./learning-route.js";
import type { RouteRefusal } from "./server.js";

/** The `stp` claim of an answers token. Code mints answers tokens with this step; no other step is an answers token. It has a hyphen, which no program step id has. */
export const ANSWERS_STEP = "rovara-answers-call";
export const ANSWERS_PATH_PREFIX = "/v1/answers/";
export const ANSWERS_PATH = "/v1/answers/messages";
/** DEC 254zzz79 (3): the same route under the path an Anthropic client builds from the base URL `<gateway>/v1/answers` (Rovara's Slack chat and message router). Same token purpose, key, meter and caps. */
export const ANSWERS_CLIENT_PATH = "/v1/answers/v1/messages";
/** $20 a month per company, in micro-dollars: the answers month when the company has no answers limit of its own. A placeholder until the first dry run (the owner confirms). Cloud's company-store.ts holds the same number. */
export const ANSWERS_DEFAULT_MONTH_MICROS = 20_000_000;
export const ANSWERS_PAUSE_HEADER = "x-rovara-answers-pause";
/** The settled cost of THIS call in US dollars (a plain decimal, six places), on a complete non-streaming success with an exact price; absent when unknown (L4-E2). Code's AnswersGateway reads it for the per-answer ceiling. */
export const ANSWERS_COST_HEADER = "x-rovara-cost-usd";
export const ANSWERS_PAUSE_REASONS = ["no_provider", "monthly_limit", "no_budget", "cost_too_high"] as const;
export type AnswersPauseReason = typeof ANSWERS_PAUSE_REASONS[number];
export const ANSWERS_PAUSE_MESSAGES: Readonly<Record<AnswersPauseReason, string>> = Object.freeze({
  no_provider: "Answers are paused because the company's selected AI source cannot serve answers yet.",
  monthly_limit: "The company's monthly answers limit is used up, so answers are paused until next month.",
  no_budget: "The company's monthly budget has no room for answers, so answers are paused.",
  cost_too_high: "One answer of this size cannot fit the company's monthly answers limit.",
});
const STATUS: Readonly<Record<AnswersPauseReason, number>> = { no_provider: 403, monthly_limit: 422, no_budget: 422, cost_too_high: 422 };
export const answersPaused = (reason: AnswersPauseReason): RouteRefusal => ({ ok: false, status: STATUS[reason], code: "answers_paused", message: ANSWERS_PAUSE_MESSAGES[reason], headers: { [ANSWERS_PAUSE_HEADER]: reason } });
// The shared route knows the learning reasons; the answers flavor has no lessons switch, so "lessons_off" is never asked for.
const learningReason = (reason: LearningPauseReason): AnswersPauseReason => {
  if (reason === "lessons_off") throw new Error("the answers route has no lessons switch");
  return reason;
};
export const ANSWERS_FLAVOR: CompanyKeyFlavor = Object.freeze({ purpose: "answers", pathPrefix: ANSWERS_PATH_PREFIX, paused: (reason: LearningPauseReason) => answersPaused(learningReason(reason)), costHeader: ANSWERS_COST_HEADER, clientBasePath: true });

/** The company's own answers limit, micro-dollars: undefined when it has none (the default applies), null when the stored item does not read (the call is refused). A failed read throws. */
export interface AnswersLimits { limitFor(cid: string, signal?: AbortSignal): Promise<number | null | undefined> }
export interface AnswersRouteOptions extends Omit<LearningRouteOptions, "lessons" | "flavor" | "monthFor" | "monthCeilingMicros"> {
  limits: AnswersLimits;
  /** The month for a company with no limit of its own. Default ANSWERS_DEFAULT_MONTH_MICROS. */
  monthDefaultMicros?: number;
}
export function createAnswersRoutes(options: AnswersRouteOptions): LearningRouteFactory & { caps: ReturnType<typeof createLearningRoutes>["caps"] } {
  const fallback = options.monthDefaultMicros ?? ANSWERS_DEFAULT_MONTH_MICROS;
  if (!Number.isSafeInteger(fallback) || fallback < 0) throw new Error("invalid answers default");
  const { limits, monthDefaultMicros: _unused, ...rest } = options; void _unused;
  return createLearningRoutes({
    ...rest, flavor: ANSWERS_FLAVOR,
    monthFor: async (company: Caps, scope, signal) => {
      const own = await limits.limitFor(scope.cid, signal);
      // An item that does not read is a fault (the call stops with an error), never an "answers are paused" the admin could mistake for a choice.
      if (own === null) throw new Error("answers limit unreadable");
      return own ?? fallback;
    },
  });
}
