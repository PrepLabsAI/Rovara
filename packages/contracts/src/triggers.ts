// Triggers (Plan 4 Task 18): what a trigger starts (a chain or an agent) and the normalised event every vendor's webhook becomes before it is matched against triggers.
// The specs themselves (event and schedule), their tables and limits are in trigger-specs.ts, which the recipe schema also imports. The keys a trigger lives under are in
// org-scoped-keys.ts.
import { z } from "zod";
import { AgentIdSchema } from "./agent.js";
import { ChainIdSchema } from "./chains.js";
import { RUN_EVENT_KEY_MAX, RUN_START_TITLE_MAX } from "./chains.js";
import { EVENT_TYPES, EventSourceSchema, type EventSource } from "./trigger-specs.js";

/** What a trigger starts: a chain's current version, or an agent's. */
export const TriggerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chain"), chainId: ChainIdSchema }).strict(),
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
]);
export type TriggerTarget = z.infer<typeof TriggerTargetSchema>;

export const TRIGGER_OUTCOMES = ["started", "skipped", "missed", "failed", "duplicate", "disabled"] as const;
export type TriggerOutcome = (typeof TRIGGER_OUTCOMES)[number];

const NoControls = (text: string) => !/[\p{Cc}\p{Cf}]/u.test(text);
const HttpsUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "must be an https link without a user name or password");

/** The most characters of an issue description an event may carry. */
export const TRIGGER_SUBJECT_BODY_MAX = 20_000;

export const TRIGGER_SUBJECT_KINDS = ["pull_request", "issue", "incident", "alert", "deployment", "workflow_run"] as const;

/**
 * An event as every source's normaliser hands it on (Tasks 19 to 25). `project` and `hookId` are set by ingress from the hook record and never from the body, so `project`
 * is always the hook's; a GitHub event has no `hookId`. `fields` holds what the trigger's filter looks at, one list of values per key.
 */
export const TriggerEventSchema = z
  .object({
    source: EventSourceSchema,
    type: z.string().min(1).max(60),
    eventKey: z.string().min(1).refine((text) => [...text].length <= RUN_EVENT_KEY_MAX, `must be at most ${String(RUN_EVENT_KEY_MAX)} characters`),
    occurredAt: z.string().datetime(),
    project: z.string().min(1).max(200),
    hookId: z.string().regex(/^hk_[0-9a-z]{26}$/).optional(),
    subject: z
      .object({
        kind: z.enum(TRIGGER_SUBJECT_KINDS),
        id: z.string().min(1).max(200),
        title: z.string().refine((text) => [...text].length <= RUN_START_TITLE_MAX && NoControls(text), `must be at most ${String(RUN_START_TITLE_MAX)} characters, with no control characters`),
        url: HttpsUrl.optional(),
        /** An issue's description, for the events that ask for work on it (intake). Untrusted text: it is cut here, redacted and made inert before a session sees it, and never stored with the event. */
        body: z.string().max(TRIGGER_SUBJECT_BODY_MAX).optional(),
      })
      .strict(),
    fields: z.record(z.string(), z.array(z.string().max(200)).max(50)),
    // `accountId` is the vendor's stable id for the account (GitHub's numeric user id, Jira's account id), which intake looks up among the org's linked members; `id` is the name shown (a login).
    // `bot` is set when the vendor says the account is an automation that is not Rovara's own.
    actor: z.object({ kind: z.enum(["rovara", "external", "unknown"]), id: z.string().min(1).max(200).optional(), accountId: z.string().min(1).max(200).optional(), bot: z.literal(true).optional() }).strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (!(EVENT_TYPES[event.source] as readonly string[]).includes(event.type)) context.addIssue({ code: "custom", path: ["type"], message: `${event.source} has no ${event.type} event` });
  });
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;

const VENDOR_NAMES: Record<EventSource, string> = {
  github: "GitHub", linear: "Linear", jira: "Jira", pagerduty: "PagerDuty", sentry: "Sentry", datadog: "Datadog", grafana: "Grafana", vercel: "Vercel", cloudwatch: "CloudWatch",
};

/** The vendor's name as people write it, for words that name a source. */
export const vendorName = (source: EventSource): string => VENDOR_NAMES[source];

/** The words of an event type: `pull_request.opened` reads "pull request opened". */
export const eventTypeWords = (type: string): string => type.replaceAll(".", " ").replaceAll("_", " ");

/** `<Vendor> <type words>: <title> (<url>)`, the line a hand-off starts with; the link is left out when the event has none. */
export function triggerSummary(event: TriggerEvent): string {
  return `${VENDOR_NAMES[event.source]} ${eventTypeWords(event.type)}: ${event.subject.title}${event.subject.url === undefined ? "" : ` (${event.subject.url})`}`;
}
