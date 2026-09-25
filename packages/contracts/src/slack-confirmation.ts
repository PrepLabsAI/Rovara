import { z } from "zod";
import { SlackUserIdSchema } from "./slack.js";

/** Block Kit action IDs on a confirmation message (feature 014). */
export const CONFIRM_APPROVE_ACTION = "agentx_confirm_approve";
export const CONFIRM_CANCEL_ACTION = "agentx_confirm_cancel";

/** A pending confirmation answers for 24 hours; after that a "yes" hears that it expired. */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;

export const ConfirmationCallSchema = z.object({
  tool: z.string().min(1).max(128),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(400),
  kind: z.enum(["classifier", "destructive", "admin", "bulk", "hint"]),
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
 * the Slack service knows which confirmation the click was for.
 */
export function confirmationClickEventId(confirmationId: string, click: ConfirmationClick): string {
  return `EvAgx${click === "approve" ? "Approve" : "Cancel"}${confirmationId.replace(/-/gu, "")}`;
}

export function parseConfirmationClickEventId(eventId: string): { click: ConfirmationClick; confirmationId: string } | undefined {
  const match = /^EvAgx(Approve|Cancel)([0-9a-f]{32})$/u.exec(eventId);
  if (!match) return undefined;
  const hex = match[2]!;
  return {
    click: match[1] === "Approve" ? "approve" : "cancel",
    confirmationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

/** The confirmation message: its text, then Approve and Cancel buttons whose value is the confirmation ID. */
export function confirmationBlocks(text: string, confirmationId: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", block_id: "agentx_confirmation", elements: [
      { type: "button", action_id: CONFIRM_APPROVE_ACTION, style: "primary", text: { type: "plain_text", text: "Approve" }, value: confirmationId },
      { type: "button", action_id: CONFIRM_CANCEL_ACTION, text: { type: "plain_text", text: "Cancel" }, value: confirmationId },
    ] },
  ];
}

/** The same message once answered: the text, and a line saying who answered, with no buttons. */
export function answeredConfirmationBlocks(text: string, note: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "context", elements: [{ type: "mrkdwn", text: note }] },
  ];
}
