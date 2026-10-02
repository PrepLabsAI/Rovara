import { z } from "zod";
import { SlackUserIdSchema } from "./slack.js";

/** Block Kit action IDs on a confirmation message (feature 014). */
export const CONFIRM_APPROVE_ACTION = "agentx_confirm_approve";
export const CONFIRM_CANCEL_ACTION = "agentx_confirm_cancel";

/** A pending confirmation answers for 24 hours; after that a "yes" hears that it expired. */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;

/** A member's typed answer to a confirmation (feature 014). */
export type ConfirmationReply = "yes" | "yes_to_all" | "cancel";

/**
 * "yes" and plain synonyms, "yes to all in this thread", or "cancel"; anything else is an ordinary
 * request. The Slack ingress and the Slack service both use it, so they agree on what an answer is.
 */
export function parseConfirmationReply(text: string): ConfirmationReply | undefined {
  // The whole message must be the answer; a leading mention, with or without its label, is dropped.
  const normalized = text.replace(/^\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*/iu, "").trim().toLowerCase().replace(/[.!\s]+$/u, "");
  if (/^yes,?\s+to\s+all(\s+in\s+this\s+thread)?$/u.test(normalized)) return "yes_to_all";
  if (/^(yes|y|yep|yes,? please|ok|okay|sure|do it|confirm|confirmed|go ahead|approve)$/u.test(normalized)) return "yes";
  if (/^(cancel|no|nope|no,? thanks|don't|do not)$/u.test(normalized)) return "cancel";
  return undefined;
}

export const ConfirmationCallSchema = z.object({
  tool: z.string().min(1).max(128),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(400),
  /**
   * `unchecked` (#215): asked because the classifier could not check the call, not because it
   * doubted it. `deny` (owner decision 2026-10-02): the classifier judged the member did not ask
   * for this at all, stronger than an ordinary `classifier` doubt.
   */
  kind: z.enum(["classifier", "unchecked", "destructive", "admin", "bulk", "hint", "deny"]),
}).strict();

/**
 * The calls one turn blocked, waiting for the requester (one per thread; a newer one replaces it).
 * `retiredAt` and `usedBy` mark a tombstone: the confirmation was used, cancelled, superseded or
 * expired, and any later "yes" for it hears that it is no longer pending.
 */
export const PendingConfirmationSchema = z.object({
  confirmationId: z.uuid(),
  requesterId: SlackUserIdSchema,
  calls: z.array(ConfirmationCallSchema).min(1).max(20),
  postedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  retiredAt: z.string().datetime().optional(),
  usedBy: z.string().min(1).max(80).optional(),
  /** The member whose live confirmation this one replaced, so their "yes" hears that it was replaced. */
  replacedRequesterId: SlackUserIdSchema.optional(),
}).strict();

export type ConfirmationCall = z.infer<typeof ConfirmationCallSchema>;
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
export type ConfirmationClick = "approve" | "cancel";

/** The Slack threads table item that holds a thread's confirmation. */
export function confirmationKey(subject: string): { pk: string; sk: string } {
  return { pk: `THREAD#${subject}`, sk: "CONFIRMATION" };
}

/** Reads a stored confirmation item; the tombstone fields live beside it. Undefined when absent or unreadable. */
export function pendingConfirmationFromItem(item: Record<string, unknown> | undefined): PendingConfirmation | undefined {
  if (!item || !item.confirmation || typeof item.confirmation !== "object") return undefined;
  const parsed = PendingConfirmationSchema.safeParse({
    ...(item.confirmation as Record<string, unknown>),
    ...(typeof item.retiredAt === "string" ? { retiredAt: item.retiredAt } : {}),
    ...(typeof item.usedBy === "string" ? { usedBy: item.usedBy } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The Slack event ID of a button click, derived from the confirmation, so the queue message keeps
 * today's strict SlackRequestMessageSchema, a repeated click is dropped as a duplicate event, and
 * the Slack service knows which confirmation the click was for. `postedAt` (the stored
 * confirmation's) is appended as hex epoch milliseconds: a redelivered request re-posts the same
 * confirmation ID with a later postedAt, and its click must not reuse the earlier click's event ID,
 * which the ingress's EVENT# claim, the queue's deduplication and the turn's idempotency keys would
 * all treat as already handled.
 */
export function confirmationClickEventId(confirmationId: string, click: ConfirmationClick, postedAt?: string): string {
  const postedMs = postedAt === undefined ? undefined : Date.parse(postedAt);
  if (postedMs !== undefined && !(Number.isSafeInteger(postedMs) && postedMs >= 0)) throw new Error("confirmation postedAt is not a valid time");
  const posted = postedMs === undefined ? "" : postedMs.toString(16);
  return `EvAgx${click === "approve" ? "Approve" : "Cancel"}${confirmationId.replace(/-/gu, "")}${posted}`;
}

export function parseConfirmationClickEventId(eventId: string): { click: ConfirmationClick; confirmationId: string } | undefined {
  const match = /^EvAgx(Approve|Cancel)([0-9a-f]{32})(?:[0-9a-f]{1,12})?$/u.exec(eventId);
  if (!match) return undefined;
  const hex = match[2]!;
  return {
    click: match[1] === "Approve" ? "approve" : "cancel",
    confirmationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

/** Slack refuses a section whose text is longer than this. */
export const SLACK_SECTION_TEXT_LIMIT = 3_000;

/** The text as consecutive sections of whole lines, each within Slack's limit; an overlong line is cut. */
function sectionBlocks(text: string): Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }> {
  const chunks: string[] = [];
  let current: string | undefined;
  for (const line of text.split("\n")) {
    const pieces: string[] = [];
    for (let start = 0; start === 0 || start < line.length; start += SLACK_SECTION_TEXT_LIMIT) pieces.push(line.slice(start, start + SLACK_SECTION_TEXT_LIMIT));
    for (const piece of pieces) {
      if (current !== undefined && current.length + 1 + piece.length <= SLACK_SECTION_TEXT_LIMIT) {
        current = `${current}\n${piece}`;
      } else {
        if (current !== undefined) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current !== undefined) chunks.push(current);
  return chunks.map((chunk) => ({ type: "section", text: { type: "mrkdwn", text: chunk } }));
}

/** The confirmation message: its text, then Approve and Cancel buttons whose value is the confirmation ID. */
export function confirmationBlocks(text: string, confirmationId: string): unknown[] {
  return [
    ...sectionBlocks(text),
    { type: "actions", block_id: "agentx_confirmation", elements: [
      { type: "button", action_id: CONFIRM_APPROVE_ACTION, style: "primary", text: { type: "plain_text", text: "Approve" }, value: confirmationId },
      { type: "button", action_id: CONFIRM_CANCEL_ACTION, text: { type: "plain_text", text: "Cancel" }, value: confirmationId },
    ] },
  ];
}

/** The same message once answered: the text, and a line saying who answered, with no buttons. */
export function answeredConfirmationBlocks(text: string, note: string): unknown[] {
  return [
    ...sectionBlocks(text),
    { type: "context", elements: [{ type: "mrkdwn", text: note }] },
  ];
}
