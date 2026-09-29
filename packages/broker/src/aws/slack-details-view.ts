import { DetailsGateSchema, type TurnDetails, type TurnDetailsCall } from "@agentx/contracts";

export interface PlainText { type: "plain_text"; text: string }
/** verbatim: Slack does not turn bare URLs, channel names or mentions in record text into links. */
export interface MrkdwnText { type: "mrkdwn"; text: string; verbatim: true }
export type DetailsBlock =
  | { type: "section"; text: MrkdwnText }
  | { type: "context"; elements: MrkdwnText[] }
  | { type: "divider" };
export interface SlackModalView { type: "modal"; title: PlainText; close: PlainText; blocks: DetailsBlock[] }

export const DETAILS_TITLE = "Turn details";
/** Slack's limits for a modal: 100 blocks, 3,000 characters in a section's text. */
export const MODAL_BLOCK_LIMIT = 100;
export const SECTION_TEXT_LIMIT = 3_000;
/** Escaped argument characters shared by all calls, so 50 long calls still make a modest view. */
export const DETAILS_ARGUMENT_BUDGET = 30_000;
export const DETAILS_ARGUMENT_MIN = 200;
export const DETAILS_ARGUMENT_MAX = 2_000;
/** This view's own ceiling on all its text, well under anything Slack refuses. */
export const DETAILS_TEXT_CEILING = 100_000;
export const CUT_MARKER = "… [cut to fit]";
const NOTES_LIMIT = 2_000;
const OMITTED_ARGUMENTS = "[omitted]";

const DISPOSITIONS: Record<TurnDetails["disposition"], string> = {
  answered: "answered",
  failed: "failed",
  abandoned: "abandoned after retries",
  workspace_close: "workspace close",
  workspace_limit: "workspace limit reached",
  workspace_closed: "workspace already closed",
  workspace_unavailable: "workspace unavailable",
  confirmation_refused: "confirmation refused, nothing ran",
  confirmation_cancelled: "confirmation cancelled",
  yes_to_all_granted: "yes to all granted",
  model_list: "model list",
  model_switch: "model selection",
};

/** Slack's three control characters; after this, record text cannot form a link, mention or alert. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface FitOptions {
  /** Quote every line with `>`, the quote marks counted in the limit. */
  quoteLines?: boolean;
  /** The text was already cut upstream, so it ends with CUT_MARKER even when it fits. */
  cut?: boolean;
}

/** Escapes, then fits `limit` characters, never cutting inside an escape or a surrogate pair; marks a cut. */
export function fitEscaped(raw: string, limit: number, { quoteLines = false, cut = false }: FitOptions = {}): string {
  const piece = (character: string) => (quoteLines && character === "\n" ? "\n>" : escapeSlack(character));
  const prefix = quoteLines ? ">" : "";
  const escaped = prefix + (quoteLines ? [...raw].map(piece).join("") : escapeSlack(raw));
  if (!cut && escaped.length <= limit) return escaped;
  const room = limit - CUT_MARKER.length;
  let fitted = prefix;
  for (const character of raw) {
    const next = piece(character);
    if (fitted.length + next.length > room) break;
    fitted += next;
  }
  return `${fitted}${CUT_MARKER}`;
}

/** The turn's details as a modal (spec 014 FR-024). Pure: every string from the record is escaped here. */
export function turnDetailsView(details: TurnDetails): SlackModalView {
  const head: DetailsBlock[] = [section(summary(details)), section(stats(details))];
  const notes = noteLines(details);
  if (notes.length > 0) head.push(context(fitEscaped(notes.join("\n"), NOTES_LIMIT)));
  head.push({ type: "divider" });
  const room = MODAL_BLOCK_LIMIT - head.length - 1;
  const shown = details.calls.slice(0, room);
  const budget = Math.min(DETAILS_ARGUMENT_MAX, Math.max(DETAILS_ARGUMENT_MIN, Math.floor(DETAILS_ARGUMENT_BUDGET / Math.max(1, shown.length))));
  const blocks: DetailsBlock[] = [...head, ...shown.map((call, index) => section(callText(call, index + 1, budget)))];
  if (details.calls.length === 0) blocks.push(context("This turn made no tool calls."));
  else if (shown.length < details.calls.length) blocks.push(context(`${details.calls.length - shown.length} more calls are not shown.`));
  return modal(blocks);
}

/** A modal holding one message, for every case where there are no details to show. */
export function detailsMessageView(text: string): SlackModalView {
  return modal([section(text)]);
}

function modal(blocks: DetailsBlock[]): SlackModalView {
  return { type: "modal", title: { type: "plain_text", text: DETAILS_TITLE }, close: { type: "plain_text", text: "Close" }, blocks };
}

function section(text: string): DetailsBlock {
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

function context(text: string): DetailsBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text, verbatim: true }] };
}

function summary(details: TurnDetails): string {
  // userId and receivedAt passed their schemas (Slack ID, ISO time), so they cannot carry markup.
  const seconds = Math.floor(Date.parse(details.receivedAt) / 1_000);
  const lines = [
    `*Requested by* <@${details.requestedBy.userId}>`,
    `*Received* <!date^${seconds}^{date_short_pretty} at {time}|${details.receivedAt}>`,
    `*Result* ${DISPOSITIONS[details.disposition]}, in ${formatSeconds(details.durationMs)}`,
  ];
  if (details.model !== undefined) lines.push(`*Model* ${fitEscaped(`${details.model.provider} / ${details.model.modelId}`, 400)}`);
  return lines.join("\n");
}

function stats(details: TurnDetails): string {
  const calls = details.callsTruncated
    ? `${details.calls.length} (the turn made more; only the first ${details.calls.length} were kept)`
    : String(details.calls.length);
  return [`*Tools offered* ${details.offeredTools.length}`, `*Tool calls* ${calls}`, `*Usage* ${usage(details)}`].join("\n");
}

function usage(details: TurnDetails): string {
  if (details.usage !== undefined) {
    const tokens = details.usage.tokens;
    return `${count(tokens.input)} input, ${count(tokens.output)} output, ${count(tokens.cacheRead)} cache-read tokens; ${details.usage.costUsd === null ? "cost unavailable" : `$${details.usage.costUsd.toFixed(4)}${details.usage.costSource === "estimated" ? " (estimated)" : ""}`}`;
  }
  return details.usageError === undefined ? "not recorded" : "could not be read";
}

/** Raw lines; the caller escapes and fits them together. */
function noteLines(details: TurnDetails): string[] {
  const lines: string[] = [];
  if (details.error !== undefined) lines.push(`The turn failed: ${details.error.name}${details.error.code === undefined ? "" : ` (${details.error.code})`}.`);
  if (details.emptyResponse) lines.push("The model returned no text.");
  if (details.argumentsOmitted) lines.push("Every call's arguments were left out to fit the record's storage limit.");
  if (details.recordingErrors !== undefined && details.recordingErrors.length > 0) {
    lines.push(`Part of this turn could not be recorded: ${details.recordingErrors.join(", ")}.`);
  }
  return lines;
}

function callText(call: TurnDetailsCall, number: number, budget: number): string {
  const name = fitEscaped(call.name.replace(/`/g, "'"), 200);
  const lines = [`*${number}.* \`${name}\`${call.connector === undefined ? "" : ` · ${fitEscaped(call.connector, 60)}`}`];
  const facts = [`${call.outcome.toLowerCase().replace("_", " ")} in ${formatSeconds(call.durationMs)}`];
  if (call.validation !== "ok") facts.push(`validation ${call.validation}`);
  if (call.reason !== undefined) facts.push(`reason ${fitEscaped(call.reason, 100)}`);
  lines.push(facts.join(" · "));
  const gate = gateLine(call.gate);
  if (gate !== undefined) lines.push(gate);
  lines.push(call.arguments === OMITTED_ARGUMENTS
    ? "_Arguments left out to fit storage._"
    : `\`\`\`${fitEscaped(call.arguments.replace(/`/g, "`​"), budget)}\`\`\``);
  return lines.join("\n");
}

function gateLine(gate: unknown): string | undefined {
  if (gate === undefined) return undefined;
  const parsed = DetailsGateSchema.safeParse(gate);
  if (!parsed.success) return "Gate: a decision was recorded in a form this view cannot show.";
  const { outcome, source, kind, rule, reason } = parsed.data;
  const by = [source, kind, rule === undefined ? undefined : `rule ${rule}`].filter((part): part is string => part !== undefined).join(", ");
  return `Gate: ${fitEscaped(`${outcome} (${by}): ${reason}`, 300)}`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
