import { z } from "zod";
import { SLACK_SECTION_TEXT_LIMIT } from "./slack-confirmation.js";
import { TURN_CALL_LIMIT, TURN_RETENTION_DAYS, TurnCallSchema, TurnRecordSchema, turnRecordKeys } from "./turns.js";

/** The Details button's action ID (spec 014 FR-024), routed by the signed interactivity endpoint. */
export const DETAILS_ACTION = "agentx_details";
export const DETAILS_BLOCK_ID = "agentx_details";

const DETAILS_VALUE_LIMIT = 128;
const DETAILS_VALUE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(Ev[A-Za-z0-9]{4,64})$/;

/** Which turn a Details button names. The thread is never part of it: it comes from the clicked message. */
export interface DetailsReference {
  receivedAt: string;
  eventId: string;
}

/** The button's value: the record's sort key without `TURN#`, or undefined when the reference cannot be carried. */
export function detailsButtonValue(reference: DetailsReference): string | undefined {
  const value = `${reference.receivedAt}#${reference.eventId}`;
  return parseDetailsButtonValue(value) === undefined ? undefined : value;
}

/**
 * Reads a button value back, refusing anything but exactly one turn reference. `receivedAt` must be
 * the form toISOString writes, which is how the ingress stamps it; an impossible date such as
 * February 31 does not survive that round trip.
 */
export function parseDetailsButtonValue(value: string): DetailsReference | undefined {
  if (value.length > DETAILS_VALUE_LIMIT) return undefined;
  const match = DETAILS_VALUE.exec(value);
  if (!match) return undefined;
  const receivedAt = match[1] ?? "";
  const eventId = match[2] ?? "";
  const time = Date.parse(receivedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== receivedAt) return undefined;
  return { receivedAt, eventId };
}

/** The record's primary key: the clicked message's thread plus the button's reference. */
export function turnDetailsKey(subject: string, reference: DetailsReference): { pk: string; sk: string } {
  const keys = turnRecordKeys({ subject, ...reference });
  return { pk: keys.pk, sk: keys.sk };
}

/** When the record's TTL falls due, in epoch milliseconds: receivedAt plus TURN_RETENTION_DAYS. */
export function detailsExpireAt(reference: DetailsReference): number {
  return (Math.floor(Date.parse(reference.receivedAt) / 1_000) + TURN_RETENTION_DAYS * 86_400) * 1_000;
}

/** Splits text into section-sized parts, at a line break or space when one is near, never inside a surrogate pair. */
export function splitSectionText(text: string, limit = SLACK_SECTION_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let remaining = text.length > 0 ? text : " ";
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const space = remaining.lastIndexOf(" ", limit);
    let end = newline > limit / 2 ? newline : space > limit / 2 ? space : limit;
    const code = remaining.charCodeAt(end - 1);
    if (end === limit && code >= 0xd800 && code <= 0xdbff) end -= 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end).replace(/^[\n ]/, "");
  }
  parts.push(remaining);
  return parts;
}

/**
 * A reply chunk with a Details button under it. Slack shows blocks instead of `text` (which stays
 * the notification fallback), so the chunk is carried in sections.
 */
export function detailsReplyBlocks(text: string, value: string): unknown[] {
  return [
    ...splitSectionText(text).map((part) => ({ type: "section", text: { type: "mrkdwn", text: part } })),
    { type: "actions", block_id: DETAILS_BLOCK_ID, elements: [
      { type: "button", action_id: DETAILS_ACTION, text: { type: "plain_text", text: "Details" }, value },
    ] },
  ];
}

/**
 * The turn record attributes the Details view may read: what it shows or checks, never the request
 * or response text, the workspace or the worker operations. The ingress Lambda's IAM grant allows
 * exactly these plus the table and index keys (TURN_DETAILS_READ_ATTRIBUTES in
 * infra/lib/control-plane.ts; a contract test compares the two).
 */
export const TURN_DETAILS_ATTRIBUTES = [
  "eventId", "subject", "receivedAt", "requestedBy", "disposition", "durationMs", "model", "offeredTools", "calls",
  "callsTruncated", "emptyResponse", "usage", "usageError", "recordingErrors", "argumentsOmitted", "error", "expiresAt",
] as const;

/** A gate decision as the Details view shows it (spec 014 FR-021; TurnGateSchema in turns.ts). Lenient on purpose. */
export const DetailsGateSchema = z.object({
  outcome: z.string().min(1).max(16),
  source: z.string().min(1).max(32),
  kind: z.string().max(32).optional(),
  rule: z.string().max(128).optional(),
  reason: z.string().max(200),
});

/** A recorded call; `gate` is read as data so a record with any gate shape still opens. */
export const TurnDetailsCallSchema = z.object({ ...TurnCallSchema.shape, gate: z.unknown().optional() });

const record = TurnRecordSchema.shape;

/** The part of a turn record the Details view reads, validated with the record's own field schemas. */
export const TurnDetailsSchema = z.object({
  eventId: record.eventId,
  subject: record.subject,
  receivedAt: record.receivedAt,
  requestedBy: record.requestedBy,
  disposition: record.disposition,
  durationMs: record.durationMs,
  model: record.model,
  offeredTools: record.offeredTools,
  calls: z.array(TurnDetailsCallSchema).max(TURN_CALL_LIMIT),
  callsTruncated: record.callsTruncated,
  emptyResponse: record.emptyResponse,
  usage: record.usage,
  usageError: record.usageError,
  recordingErrors: record.recordingErrors,
  argumentsOmitted: record.argumentsOmitted,
  error: record.error,
});

export type DetailsGate = z.infer<typeof DetailsGateSchema>;
export type TurnDetailsCall = z.infer<typeof TurnDetailsCallSchema>;
export type TurnDetails = z.infer<typeof TurnDetailsSchema>;

const STORAGE_KEYS = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt"]);
const LOGGED_FIELD_LIMIT = 10;

/**
 * Parses a stored item for the Details view. When it cannot, it names top-level field names only:
 * issue messages and nested paths can quote stored values.
 */
export function turnDetailsFromItem(item: Record<string, unknown>): { ok: true; details: TurnDetails } | { ok: false; fields: string[] } {
  const parsed = TurnDetailsSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
  if (parsed.success) return { ok: true, details: parsed.data };
  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (fields.size >= LOGGED_FIELD_LIMIT) break;
    const field = issue.path[0];
    fields.add(typeof field === "string" && field in TurnDetailsSchema.shape ? field : "(root)");
  }
  return { ok: false, fields: [...fields] };
}
