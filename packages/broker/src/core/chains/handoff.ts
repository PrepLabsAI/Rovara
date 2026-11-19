// What one step hands the next. A step's report goes to the following step as the run input's `context`, as information only: never as instructions, and never with a secret in it. Every body is redacted
// first and then cut, so a token can't survive by straddling the cut; every title is cut to the run input's limit, so a long ticket or alarm title can't make a start refuse; and the whole hand-off stays inside
// the run input's item limits and the chain's own byte total, dropping the oldest report first and never the item that says what the run is about.
import { z } from "zod";
import {
  CONTEXT_TITLE_MAX, HANDOFF_ITEM_MAX_BYTES, HANDOFF_MAX_BYTES, HANDOFF_MAX_ITEMS, RUN_EVENT_KEY_MAX, RUN_START_TITLE_MAX, shortenToBytes,
  type RunContextItem, type StepResult,
} from "@agentx/contracts";

// ---- secrets

/**
 * Patterns for the credentials of every vendor Rovara reads or writes through: a hand-off leaves one agent's run for another's, so anything that looks
 * like a token is replaced before it leaves. Longer, more specific patterns come first, so a bearer token that holds a JWT is replaced as one.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Rovara script tokens (UX5b), bare as well as after "Bearer".
  /rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43}/g,
  /Bearer [A-Za-z0-9._~+/-]{20,}=*/g,
  /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /xoxe-[A-Za-z0-9-]{10,}/g,
  /xapp-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sntry[su]_[A-Za-z0-9+/=_-]{20,}/g,
  /glsa_[A-Za-z0-9_]{20,}/g,
  /glc_[A-Za-z0-9+/=_-]{20,}/g,
  /lin_api_[A-Za-z0-9]{20,}/g,
  /ATATT[A-Za-z0-9_=-]{20,}/g,
];

/** The text with every credential-shaped token replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
  return redacted;
}

// ---- the event that started a run

export const TRIGGER_SUBJECT_KINDS = ["pull_request", "issue", "incident", "alert", "deployment", "workflow_run"] as const;
export type TriggerSubjectKind = (typeof TRIGGER_SUBJECT_KINDS)[number];

/**
 * What a hand-off needs of the event that started a run: its key, where it came from, what it is about and what the vendor said. the `TriggerEvent`
 * has these fields (and more, which a run does not keep); the run's record holds this part.
 */
export const HandoffTriggerSchema = z.object({
  eventKey: z.string().min(1).refine((text) => [...text].length <= RUN_EVENT_KEY_MAX, "must be at most 200 characters"),
  source: z.string().min(1).max(64),
  type: z.string().min(1).max(160),
  subject: z.object({
    kind: z.enum(TRIGGER_SUBJECT_KINDS),
    title: z.string().refine((text) => [...text].length <= RUN_START_TITLE_MAX, "must be at most 300 characters"),
    url: z.string().max(2048).optional(),
  }),
  summary: z.string().max(HANDOFF_ITEM_MAX_BYTES).optional(),
});
export type HandoffTrigger = z.infer<typeof HandoffTriggerSchema>;

const CONTEXT_KINDS: Record<TriggerSubjectKind, RunContextItem["kind"]> = {
  pull_request: "pull_request", issue: "ticket", incident: "alert", alert: "alert", deployment: "deploy", workflow_run: "deploy",
};

/** The kind of context item an event's subject is shown as. */
export const contextKindOf = (subject: TriggerSubjectKind): RunContextItem["kind"] => CONTEXT_KINDS[subject];

/** What a person reads of an event: where it came from and its type, what it is about, its link and the vendor's own summary. */
export function triggerSummary(event: HandoffTrigger): string {
  const lines = [`Event: ${event.source} ${event.type}`, `${event.subject.kind}: ${event.subject.title}`];
  if (event.subject.url !== undefined && event.subject.url !== "") lines.push(`Link: ${event.subject.url}`);
  const head = lines.join("\n");
  return event.summary === undefined || event.summary === "" ? head : `${head}\n\n${event.summary}`;
}

// ---- cutting

/** At most 200 UTF-16 units (what the run input counts), ending in an ellipsis when cut, and never between the two halves of a character. */
function cutTitle(text: string): string {
  if (text.length <= CONTEXT_TITLE_MAX) return text;
  let end = CONTEXT_TITLE_MAX - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A body with its secrets replaced, then cut to the item limit. Nothing (not an empty string) when there is no text: the run input's item does not accept an empty body. */
function body(text: string): string | undefined {
  const redacted = redactSecrets(text);
  return redacted === "" ? undefined : shortenToBytes(redacted, HANDOFF_ITEM_MAX_BYTES);
}

const utf8Length = (text: string | undefined): number => (text === undefined ? 0 : new TextEncoder().encode(text).length);
const weight = (item: RunContextItem): number => utf8Length(item.ref) + utf8Length(item.title) + utf8Length(item.body);

function item(kind: RunContextItem["kind"], ref: string, title: string | undefined, text: string): RunContextItem {
  const shownBody = body(text);
  const shownTitle = title === undefined || title === "" ? undefined : cutTitle(title);
  return { kind, ref, ...(shownTitle === undefined ? {} : { title: shownTitle }), ...(shownBody === undefined ? {} : { body: shownBody }) };
}

/** A step's report with its links, as the body of the report item. */
function reportText(result: StepResult): string {
  const parts: string[] = [];
  if (result.report !== "") parts.push(result.report);
  if (result.links !== undefined && result.links.length > 0) parts.push(`Links:\n${result.links.map((link) => `- ${link.label}: ${link.url}`).join("\n")}`);
  return parts.join("\n\n");
}

/** One earlier step's result, with what the next step is told about where it came from. */
export interface EarlierReport { seq: number; stepName: string; agentName: string; version: number; result: StepResult }

/**
 * The context a step starts with, as the run input's `context`. First the start item: from an event, its subject, key, title and summary; from a person, their
 * words as a `text` item named `start` (when they gave any). Then, newest first, one `report` item per earlier step: the last one for `previous`, every one for
 * `all`. At most `HANDOFF_MAX_ITEMS` items and `HANDOFF_MAX_BYTES` together; the oldest reports go first, and the start item never does.
 */
export function buildHandoff(input: { runId: string; trigger?: HandoffTrigger | undefined; startInput?: string | undefined; earlier: readonly EarlierReport[]; mode: "previous" | "all" }): RunContextItem[] {
  const start: RunContextItem | undefined = input.trigger !== undefined
    ? item(contextKindOf(input.trigger.subject.kind), input.trigger.eventKey, input.trigger.subject.title, triggerSummary(input.trigger))
    : input.startInput !== undefined && input.startInput !== "" ? item("text", "start", undefined, input.startInput) : undefined;
  const newestFirst = [...input.earlier].sort((left, right) => right.seq - left.seq);
  const chosen = input.mode === "previous" ? newestFirst.slice(0, 1) : newestFirst;
  const reports = chosen.map((entry) => item("report", `chain:${input.runId}:${String(entry.seq)}`, `Step "${entry.stepName}" (${entry.agentName} version ${String(entry.version)})`, reportText(entry.result)));
  const items = start === undefined ? [] : [start];
  let total = start === undefined ? 0 : weight(start);
  for (const report of reports) {
    if (items.length >= HANDOFF_MAX_ITEMS || total + weight(report) > HANDOFF_MAX_BYTES) break;
    items.push(report);
    total += weight(report);
  }
  return items;
}
