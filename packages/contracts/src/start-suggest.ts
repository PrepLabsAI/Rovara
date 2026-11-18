// The web start box's path suggestion (lead 4 J3; DEC 173, smart Just answer plan 1.3): the SAME first look the Slack intake takes at a plain request, for the "What do you need?" box.
//
//   POST /v1/app/projects/{project}/code/suggest     { requestId, text }  ->  { kind, classifier, pick, smallTalk? }
//
// The suggestion only suggests: it starts nothing, stores nothing and spends nothing on small talk. The person's own press of a button starts a task (`POST .../code`) or asks a question (`POST .../answers`).
// The text is untrusted: it reaches the classifier model inside the same fenced prompt Slack uses (requestRouterPrompt), and the model's own reason is never returned. Nothing the caller sent is echoed back.
import { z } from "zod";
import { REQUEST_ROUTE_KINDS } from "./slack-routing.js";
import type { RequestRouteKind } from "./slack-routing.js";

/** The route the web door calls (hosted core and `rovara up`): POST, body `StartSuggestRequest`, answer `StartSuggestResponse`. `{project}` is the project's name. */
export const START_SUGGEST_ROUTE_PATH = "/v1/app/projects/{project}/code/suggest";

/** The longest text the start box sends (the same limit as starting work). */
export const START_SUGGEST_TEXT_MAX = 4_000;
/** Suggestions one person may ask for in an hour, across the company's projects (each may cost one small classifier call). PLACEHOLDER: named so the owner can tune it. */
export const START_SUGGESTS_PER_PERSON_PER_HOUR = 60;
/** The classifier is waited for at most this long (the Slack router's own cap); then the suggestion says the classifier failed. */
export const START_SUGGEST_TIMEOUT_MS = 4_000;

const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;

export const StartSuggestRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
  text: z.string().trim().min(1).max(START_SUGGEST_TEXT_MAX).regex(NO_CONTROL_BUT_NEWLINES),
}).strict();
export type StartSuggestRequest = z.infer<typeof StartSuggestRequestSchema>;

/** What the first look found: small talk (no model), one of the classifier's four kinds, or `unknown` (no usable classification). */
export const START_SUGGEST_KINDS = ["small_talk", "unknown", ...REQUEST_ROUTE_KINDS] as const;
export type StartSuggestKind = (typeof START_SUGGEST_KINDS)[number];
/** How the classification went: `ok` (or small talk, which needs none), `unavailable` (no classifier is set up here: nothing was asked), `failed` (it was asked and timed out or answered something unusable). */
export const START_SUGGEST_CLASSIFIERS = ["ok", "unavailable", "failed"] as const;
export type StartSuggestClassifier = (typeof START_SUGGEST_CLASSIFIERS)[number];
/** The path the box preselects: answer the question, start Quick, or start Full. */
export const START_SUGGEST_PICKS = ["answer", "quick", "full"] as const;
export type StartSuggestPick = (typeof START_SUGGEST_PICKS)[number];
export const START_SMALL_TALK_KINDS = ["greeting", "thanks", "help", "ack"] as const;

export const StartSuggestResponseSchema = z.object({
  kind: z.enum(START_SUGGEST_KINDS),
  classifier: z.enum(START_SUGGEST_CLASSIFIERS),
  pick: z.enum(START_SUGGEST_PICKS),
  /** Only for small talk: which kind, so the page can say its own fixed words. No model was asked. */
  smallTalk: z.enum(START_SMALL_TALK_KINDS).optional(),
}).strict();
export type StartSuggestResponse = z.infer<typeof StartSuggestResponseSchema>;

/** The words the route says, fixed in code. */
export const START_SUGGEST_WORDS = {
  projectNotFound: "project not found",
  rate: "You've asked for a lot of suggestions lately. Try again a little later.",
  unavailable: "Couldn't suggest a path just now.",
  badRequest: "A suggestion needs a request ID and 1 to 4,000 characters of text.",
} as const;

/**
 * The path a classification suggests (the same sorting Slack's card uses): a question is answered; a small change suggests Quick; a large change suggests Full; unclear is answered first (the answer ends in one "Start a
 * Quick task" button). When the classifier is not usable the page asks the person, and Just answer is the safe preselection: it changes nothing.
 */
export function pickOfKind(kind: RequestRouteKind): StartSuggestPick {
  switch (kind) {
    case "small_change": return "quick";
    case "large_change": return "full";
    case "question":
    case "unclear": return "answer";
  }
}
