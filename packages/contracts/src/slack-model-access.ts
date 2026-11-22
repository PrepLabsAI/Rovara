// Rovara's Slack chat and message router run on the COMPANY's AI, through the model gateway (DEC 254zzz79 (3)), never on Rovara-paid Bedrock.
//
//   POST /v1/service/model-access   {}   (the Slack service's IAM-signed route family, acting for one Slack thread and one member)
//
// The Slack service cannot mint a gateway token (the task key is the broker's), so it asks the broker, per call, how this thread's model calls are to be made:
//  - `install`   this is the customer's OWN single-tenant install (no company workspaces): the model runtime it has always had, on the customer's own AWS account;
//  - `gateway`   a company's workspace: the gateway's address for an Anthropic client (the answers route, which counts the call in the company's answers month and the combined company cap, on the
//                company's own connected AI source), the one model, and a fresh short-lived token for THIS company (never named by the caller);
//  - `unavailable`  anything else (no gateway or signing key here, a workspace that names no company, a thread with no Slack identity): the Slack service says the fixed words below and makes NO model call.
// There is no Rovara-paid fallback: a company workspace is never answered on `install`.
import { z } from "zod";
import { ROVARA_AI_PAUSED_MESSAGE } from "./model-sources.js";

/** The route as the Slack service calls it (the control plane client adds its own `/v1/service` rewrite). */
export const SLACK_MODEL_ACCESS_SERVICE_PATH = "/v1/model-access";

/** The gateway's own pause header on the answers route (cloud docs/model-gateway-spend-limits.md), as the Slack service reads a refusal. */
export const GATEWAY_PAUSE_HEADER = "x-rovara-answers-pause";
/** The reasons the gateway gives for pausing a company's calls. Anything else reads as `paused`. */
export const GATEWAY_PAUSE_REASONS = ["no_provider", "monthly_limit", "no_budget", "cost_too_high"] as const;

const ModelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const SlackModelAccessResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("install") }).strict(),
  z.object({
    status: z.literal("gateway"),
    /** The base URL an Anthropic client is given: `<gateway origin>/v1/answers` (it adds `/v1/messages`). */
    baseUrl: z.string().url().max(600).refine((value) => value.startsWith("https://") && value.endsWith("/v1/answers"), "an https gateway base"),
    model: ModelName,
    token: z.string().min(20).max(4_096),
  }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
export type SlackModelAccessResult = z.infer<typeof SlackModelAccessResultSchema>;

/** What the Slack service says in the thread, in fixed words, when the company's AI cannot serve the call. Nothing the gateway or a model sent is echoed. */
export const SLACK_MODEL_WORDS = {
  installPaused: ROVARA_AI_PAUSED_MESSAGE,
  /** No gateway here, or a workspace that is not a company's. */
  notSetUp: "Rovara's AI isn't set up for this workspace yet. Ask a company admin to check the setup in Rovara.",
  /** The company has no connected AI source (or the one it has was refused). */
  noProvider: "Your company has no AI connected yet, so I can't answer here. A company admin can connect one in Rovara.",
  /** The company's monthly room for this is used up. */
  paused: "Your company's AI limit for this month is used up, so I can't answer here until it is raised or next month starts.",
  /** Anything else (a gateway fault, a timeout). */
  unavailable: "I couldn't reach your company's AI just now. Please try again in a minute.",
} as const;
/** The fixed refusal kinds (generic: the conversation core reads a gateway refusal as one of these and names nothing of Slack). */
export type ModelRefusal = keyof typeof SLACK_MODEL_WORDS;
export type SlackModelRefusal = ModelRefusal;

/** The words for a gateway pause reason (`no_provider`, or any limit reason) as the Slack service says them. */
export function modelRefusalFor(reason: string | undefined): ModelRefusal {
  if (reason === "no_provider") return "noProvider";
  return reason !== undefined && (GATEWAY_PAUSE_REASONS as readonly string[]).includes(reason) ? "paused" : "unavailable";
}
