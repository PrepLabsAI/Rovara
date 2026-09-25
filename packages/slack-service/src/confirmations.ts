import {
  CONFIRMATION_TTL_MS,
  parseConfirmationClickEventId,
  type PendingConfirmation,
  type SlackRequestMessage,
} from "@agentx/contracts";
import { createGateSession, type GateApproval, type GateSession } from "@agentx/orchestrator/action-gate";
import { deterministicUuid } from "./ids.js";
import type { ServiceLog } from "./processor.js";
import { escapeText } from "./slack-format.js";

export type ConfirmationReply = "yes" | "yes_to_all" | "cancel";

export interface ConfirmationStore {
  /** The thread's confirmation, a tombstone included. */
  load(subject: string): Promise<PendingConfirmation | undefined>;
  save(subject: string, confirmation: PendingConfirmation): Promise<void>;
  /** Marks a live confirmation as used by this Slack event. False when it is retired or a different event used it. */
  claim(subject: string, confirmationId: string, eventId: string): Promise<boolean>;
  /** Leaves a tombstone (retiredAt, usedBy) if the thread's confirmation is still this one. */
  retire(subject: string, confirmationId: string, eventId: string): Promise<void>;
  yesToAll(subject: string, userId: string): Promise<boolean>;
  /** Grants or renews "yes to all" for 24 hours. */
  grantYesToAll(subject: string, userId: string): Promise<void>;
}

/** "yes" and plain synonyms, "yes to all in this thread", or "cancel"; anything else is an ordinary request. */
export function parseConfirmationReply(text: string): ConfirmationReply | undefined {
  const normalized = text.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim().toLowerCase().replace(/[.!\s]+$/u, "");
  if (/^yes,?\s+to\s+all(\s+in\s+this\s+thread)?$/u.test(normalized)) return "yes_to_all";
  if (/^(yes|y|yep|confirm|confirmed|go ahead|approve)$/u.test(normalized)) return "yes";
  if (/^(cancel|no|don't|do not)$/u.test(normalized)) return "cancel";
  return undefined;
}

const KIND_NOTES: Readonly<Record<PendingConfirmation["calls"][number]["kind"], string>> = {
  destructive: "destructive",
  admin: "an administrator asks for confirmation",
  bulk: "touches many items",
  hint: "the vendor marks it destructive",
  classifier: "I'm not sure you asked for this",
};

/** The message text: every blocked action and its target, and how to answer with or without the buttons. */
export function confirmationMessage(confirmation: PendingConfirmation): string {
  return [
    `<@${confirmation.requesterId}>, before I go ahead, please confirm:`,
    // The gate's summary is already Slack-safe; escaping again (idempotently) keeps a stored or
    // hand-written summary from mentioning or linking anyone. The classifier's reason is never shown.
    ...confirmation.calls.map((call) => `• ${escapeText(call.summary)} (${KIND_NOTES[call.kind]})`),
    "Press Approve, or reply `@AgentX yes`, to run exactly these. Press Cancel, or reply `@AgentX cancel`, to drop them. This expires in 24 hours.",
  ].join("\n");
}

export const YES_TO_ALL_TEXT = "OK. For the next 24 hours in this thread I'll stop asking you when I'm unsure you asked for something. I'll still ask before destructive actions, large changes and anything an administrator requires.";
export const NO_LONGER_PENDING_TEXT = "That confirmation is no longer pending, so nothing was run.";
export const CANCELLED_TEXT = "Cancelled. Nothing was run.";

export type ConfirmationCheck =
  | { run: false }
  | { run: true; session: GateSession; claim?: { confirmationId: string }; superseded?: string };

/**
 * Before a turn, and before the workspace is resolved: decides whether the message answers the
 * thread's confirmation and builds the turn's gate session. It claims nothing; the processor
 * claims just before the turn runs, so an early return (limit, closed thread, failed setup) leaves
 * the confirmation pending (spec 014 C5). A "yes" or a button click counts only from the member who
 * was asked, only after the question was posted, only within 24 hours, and only while the
 * confirmation is live: a used, cancelled, superseded or expired one is a tombstone.
 */
export async function checkConfirmation(input: {
  message: SlackRequestMessage;
  subject: string;
  store: ConfirmationStore;
  post: (text: string) => Promise<void>;
  log: ServiceLog;
  now: number;
}): Promise<ConfirmationCheck> {
  const { message, subject, store, post, log } = input;
  const click = parseConfirmationClickEventId(message.eventId);
  const reply: ConfirmationReply | undefined = click ? (click.click === "approve" ? "yes" : "cancel") : parseConfirmationReply(message.text);
  const yesToAll = await store.yesToAll(subject, message.userId);
  const session = (approvals: readonly GateApproval[] = [], all = yesToAll) => createGateSession(message.userId, { approvals, yesToAll: all });
  const pending = await store.load(subject);
  const live = pending !== undefined && pending.retiredAt === undefined;
  const refuse = async (reason: string, text: string): Promise<ConfirmationCheck> => {
    log("gate.confirmation_refused", { eventId: message.eventId, reason });
    await post(text);
    return { run: false };
  };
  if (reply === undefined) {
    // The requester moved on: their pending confirmation no longer applies after this turn.
    return { run: true, session: session(), ...(live && pending.requesterId === message.userId ? { superseded: pending.confirmationId } : {}) };
  }
  if (click !== undefined && pending?.confirmationId !== click.confirmationId) return refuse("not_pending", NO_LONGER_PENDING_TEXT);
  if (!pending) {
    if (reply !== "yes_to_all") return { run: true, session: session() };
    await store.grantYesToAll(subject, message.userId);
    log("gate.yes_to_all", { eventId: message.eventId });
    await post(YES_TO_ALL_TEXT);
    return { run: false };
  }
  if (!live) return refuse("not_pending", NO_LONGER_PENDING_TEXT);
  if (pending.requesterId !== message.userId) {
    return refuse("other_member", `Only <@${pending.requesterId}> can confirm what they asked for. Nothing was run.`);
  }
  if (Date.parse(message.receivedAt) <= Date.parse(pending.postedAt)) {
    return refuse("before_request", "Your reply arrived before I asked for confirmation, so I didn't treat it as one. Press Approve or reply `@AgentX yes` again to confirm.");
  }
  if (input.now >= Date.parse(pending.expiresAt)) {
    await store.retire(subject, pending.confirmationId, message.eventId);
    return refuse("expired", "That confirmation request expired after 24 hours, so nothing was run. Ask me again if you still want it.");
  }
  if (reply === "cancel") {
    await store.retire(subject, pending.confirmationId, message.eventId);
    log("gate.confirmation_cancelled", { eventId: message.eventId, calls: pending.calls.length });
    await post(CANCELLED_TEXT);
    return { run: false };
  }
  if (reply === "yes_to_all") await store.grantYesToAll(subject, message.userId);
  log("gate.confirmation_approved", { eventId: message.eventId, calls: pending.calls.length, click: click !== undefined });
  const approvals = pending.calls.map(({ tool, argumentsHash, summary }) => ({ tool, argumentsHash, summary }));
  return { run: true, session: session(approvals, yesToAll || reply === "yes_to_all"), claim: { confirmationId: pending.confirmationId } };
}

/** Most calls one confirmation lists; a turn that blocks more lists the first 20, and the rest ask again when retried. */
export const MAX_CONFIRMATION_CALLS = 20;

/**
 * After a turn: leaves a tombstone on the confirmation it used or superseded, then stores and
 * posts one confirmation listing every call the turn blocked.
 */
export async function settleConfirmations(input: {
  check: Extract<ConfirmationCheck, { run: true }>;
  message: SlackRequestMessage;
  subject: string;
  store: ConfirmationStore;
  postConfirmation: (confirmation: PendingConfirmation, text: string) => Promise<void>;
  log: ServiceLog;
  now: number;
}): Promise<void> {
  const { check, message, subject, store } = input;
  const retired = check.claim?.confirmationId ?? check.superseded;
  if (retired !== undefined) await store.retire(subject, retired, message.eventId);
  const calls = [...new Map(check.session.asks.map((ask) => [ask.argumentsHash, { tool: ask.tool, argumentsHash: ask.argumentsHash, summary: ask.summary, kind: ask.kind }])).values()]
    .slice(0, MAX_CONFIRMATION_CALLS);
  if (calls.length === 0) return;
  const confirmation: PendingConfirmation = {
    confirmationId: deterministicUuid(`${message.eventId}:confirmation`),
    requesterId: check.session.requesterId,
    calls,
    postedAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + CONFIRMATION_TTL_MS).toISOString(),
  };
  await store.save(subject, confirmation);
  await input.postConfirmation(confirmation, confirmationMessage(confirmation));
  input.log("gate.confirmation_requested", { eventId: message.eventId, calls: calls.length, kinds: [...new Set(calls.map((call) => call.kind))].join(",") });
}
