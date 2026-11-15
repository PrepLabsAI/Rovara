// TE-F2 part A: which model families the scripted-replies helper serves, and which operations each one has. `bedrock` is NOT here: its rows say `routesTo: "local_aws_front"` (9d owns the front's shapes), and a Bedrock
// request to this helper is answered "not run: Bedrock scripted replies are served by the local AWS front". `vertex` shares Gemini's shapes. PURE: constants only.
import { ANTHROPIC_OPERATIONS } from "./model-family-anthropic.js";
import { COHERE_OPERATIONS } from "./model-family-cohere.js";
import { GEMINI_OPERATIONS } from "./model-family-gemini.js";
import { OPENAI_OPERATIONS } from "./model-family-openai.js";

export const SERVED_MODEL_FAMILIES = ["openai_compatible", "anthropic_messages", "gemini", "vertex", "cohere"] as const;
export type ServedModelFamily = (typeof SERVED_MODEL_FAMILIES)[number];

export function isServedModelFamily(value: unknown): value is ServedModelFamily {
  return typeof value === "string" && (SERVED_MODEL_FAMILIES as readonly string[]).includes(value);
}

/** The operations a reply may name for a family. Gemini and Vertex also serve the OpenAI-compatible forms of their own endpoints. */
export const OPERATIONS_BY_FAMILY: Readonly<Record<ServedModelFamily, readonly string[]>> = {
  openai_compatible: OPENAI_OPERATIONS,
  anthropic_messages: ANTHROPIC_OPERATIONS,
  gemini: [...GEMINI_OPERATIONS, ...OPENAI_OPERATIONS],
  vertex: [...GEMINI_OPERATIONS, ...OPENAI_OPERATIONS],
  cohere: COHERE_OPERATIONS,
};

/** Every operation name any family has (a reply's `match.operation` is one of these, and also one of its own family's). */
export const ALL_REPLY_OPERATIONS: readonly string[] = [...new Set(Object.values(OPERATIONS_BY_FAMILY).flat())];

/** The sentence a Bedrock request gets: its scripted replies are the local AWS front's. */
export const BEDROCK_NOT_RUN_SENTENCE = "not run: Bedrock scripted replies are served by the local AWS front";
/** The sentence an unmatched call gets: the helper never invents a reply. */
export const UNMATCHED_SENTENCE = "not run: no scripted reply for this request";
