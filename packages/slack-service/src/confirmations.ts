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
  /** Uses a live, unexpired confirmation once: leaves its tombstone with this event. False when it is retired or expired. */
  claim(subject: string, confirmationId: string, eventId: string): Promise<boolean>;
  /** Opens a confirmation saved closed (usedBy "unposted") once it is posted. Throws, leaving it closed, otherwise. */
  open(subject: string, confirmationId: string): Promise<void>;
  /** Leaves a tombstone (retiredAt, usedBy) if the thread's confirmation is still this one. */
  retire(subject: string, confirmationId: string, eventId: string): Promise<void>;
  yesToAll(subject: string, userId: string): Promise<boolean>;
  /** Grants or renews "yes to all" for 24 hours. */
  grantYesToAll(subject: string, userId: string): Promise<void>;
}

/** "yes" and plain synonyms, "yes to all in this thread", or "cancel"; anything else is an ordinary request. */
export function parseConfirmationReply(text: string): ConfirmationReply | undefined {
  // The whole message must be the answer; a leading mention, with or without its label, is dropped.
  const normalized = text.replace(/^\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*/iu, "").trim().toLowerCase().replace(/[.!\s]+$/u, "");
  if (/^yes,?\s+to\s+all(\s+in\s+this\s+thread)?$/u.test(normalized)) return "yes_to_all";
  if (/^(yes|y|yep|yes,? please|ok|okay|sure|do it|confirm|confirmed|go ahead|approve)$/u.test(normalized)) return "yes";
  if (/^(cancel|no|nope|no,? thanks|don't|do not)$/u.test(normalized)) return "cancel";
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
export const EXPIRED_TEXT = "That confirmation request expired after 24 hours, so nothing was run. Ask me again if you still want it.";

/** `usedBy` of a confirmation retired because it expired: it answers "expired" for EXPIRED_ANSWER_MS after its expiry. */
export const EXPIRED_MARK = "expired";
/** How long after its expiry an expired confirmation still answers "expired". */
export const EXPIRED_ANSWER_MS = CONFIRMATION_TTL_MS;
/** `usedBy` of a confirmation saved closed and not yet posted (or never posted): nobody can answer it. */
export const UNPOSTED_MARK = "unposted";

/**
 * The id of the confirmation a turn for this Slack event posts. It derives from the event, so a
 * redelivered event names the same confirmation: settling sees it and never reopens or re-posts it.
 */
export function confirmationIdFor(eventId: string): string {
  return deterministicUuid(`${eventId}:confirmation`);
}

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
  const stored = await store.load(subject);
  const expired = (confirmation: PendingConfirmation) => input.now >= Date.parse(confirmation.expiresAt);
  // An unposted confirmation was never seen, so it is never answerable. A used, cancelled or
  // superseded one's tombstone lasts the rest of its 24 hours; a never-answered or expired one
  // answers "expired" for 24 hours after its expiry. After that the thread has nothing pending,
  // so a later "yes" to another question is never swallowed.
  const forgotten = (confirmation: PendingConfirmation) =>
    confirmation.usedBy === UNPOSTED_MARK
    || input.now >= Date.parse(confirmation.expiresAt) + (confirmation.retiredAt === undefined || confirmation.usedBy === EXPIRED_MARK ? EXPIRED_ANSWER_MS : 0);
  let pending = stored !== undefined && forgotten(stored) ? undefined : stored;
  if (pending !== undefined && pending.retiredAt === undefined && expired(pending)) {
    // Expiry first: a live confirmation past its 24 hours is retired as expired before anything else.
    await store.retire(subject, pending.confirmationId, EXPIRED_MARK);
    pending = { ...pending, retiredAt: new Date(input.now).toISOString(), usedBy: EXPIRED_MARK };
  }
  const live = pending !== undefined && pending.retiredAt === undefined;
  const refuse = async (reason: string, text: string): Promise<ConfirmationCheck> => {
    log("gate.confirmation_refused", { eventId: message.eventId, reason });
    await post(text);
    return { run: false };
  };
  if (reply === undefined) {
    // The requester moved on: their pending confirmation no longer applies after this turn. A
    // redelivery of the event that posted it has not moved on, so it leaves it pending.
    const superseded = live && pending?.requesterId === message.userId && pending.confirmationId !== confirmationIdFor(message.eventId)
      ? pending.confirmationId
      : undefined;
    return { run: true, session: session(), ...(superseded === undefined ? {} : { superseded }) };
  }
  if (click !== undefined && pending?.confirmationId !== click.confirmationId) return refuse("not_pending", NO_LONGER_PENDING_TEXT);
  if (reply === "yes_to_all" && !live) {
    // "Yes to all" stands on its own (R7): without a live confirmation it only grants.
    await store.grantYesToAll(subject, message.userId);
    log("gate.yes_to_all", { eventId: message.eventId });
    await post(YES_TO_ALL_TEXT);
    return { run: false };
  }
  if (!pending) return { run: true, session: session() };
  if (!live) {
    if (pending.usedBy === EXPIRED_MARK) return refuse("expired", EXPIRED_TEXT);
    // Only a click on it, or a redelivery of the event that left the tombstone (or one received
    // before it), hears "no longer pending"; any later message is an ordinary request.
    const redelivery = pending.usedBy === message.eventId || (pending.retiredAt !== undefined && Date.parse(message.receivedAt) <= Date.parse(pending.retiredAt));
    return click !== undefined || redelivery ? refuse("not_pending", NO_LONGER_PENDING_TEXT) : { run: true, session: session() };
  }
  if (pending.requesterId !== message.userId) {
    return pending.replacedRequesterId === message.userId
      ? refuse("replaced", `The pending confirmation is <@${pending.requesterId}>'s; yours was replaced. Nothing was run.`)
      : refuse("other_member", `Only <@${pending.requesterId}> can confirm what they asked for. Nothing was run.`);
  }
  if (Date.parse(message.receivedAt) <= Date.parse(pending.postedAt)) {
    return refuse("before_request", "Your reply arrived before I asked for confirmation, so I didn't treat it as one. Press Approve or reply `@AgentX yes` again to confirm.");
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
 * What settling did: nothing to ask; posted a confirmation; or, for a redelivered event whose
 * earlier attempt already posted its confirmation, left that one as it is: still pending, or
 * already answered (used, cancelled or expired), which is never reopened or re-posted.
 */
export type SettleOutcome = "none" | "posted" | "already_pending" | "already_answered";

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
}): Promise<SettleOutcome> {
  const { check, message, subject, store } = input;
  const retired = check.claim?.confirmationId ?? check.superseded;
  // A claimed confirmation is already a tombstone; retiring it again changes nothing.
  if (retired !== undefined) await store.retire(subject, retired, message.eventId);
  const calls = [...new Map(check.session.asks.map((ask) => [ask.argumentsHash, { tool: ask.tool, argumentsHash: ask.argumentsHash, summary: ask.summary, kind: ask.kind }])).values()]
    .slice(0, MAX_CONFIRMATION_CALLS);
  if (calls.length === 0) return "none";
  const previous = await store.load(subject);
  const confirmationId = confirmationIdFor(message.eventId);
  if (previous?.confirmationId === confirmationId && previous.usedBy !== UNPOSTED_MARK) {
    // A redelivery of the event that already posted this confirmation (spec 014): overwriting it
    // would reopen an answered one, so a confirmed call could run twice. It stays as it is.
    const outcome = previous.retiredAt === undefined ? "already_pending" : "already_answered";
    input.log("gate.confirmation_kept", { eventId: message.eventId, outcome });
    return outcome;
  }
  const replaced = previous !== undefined && previous.retiredAt === undefined && input.now < Date.parse(previous.expiresAt) && previous.requesterId !== check.session.requesterId
    ? previous.requesterId
    : undefined;
  const confirmation: PendingConfirmation = {
    confirmationId,
    requesterId: check.session.requesterId,
    calls,
    postedAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + CONFIRMATION_TTL_MS).toISOString(),
    ...(replaced === undefined ? {} : { replacedRequesterId: replaced }),
  };
  // Saved closed, and opened only once Slack has shown it: any failure leaves it closed, never
  // answerable, and the caller tells the member.
  await store.save(subject, { ...confirmation, retiredAt: confirmation.postedAt, usedBy: UNPOSTED_MARK });
  try {
    await input.postConfirmation(confirmation, confirmationMessage(confirmation));
  } catch (error) {
    input.log("gate.confirmation_post_failed", { eventId: message.eventId });
    throw error;
  }
  try {
    await store.open(subject, confirmation.confirmationId);
  } catch (error) {
    input.log("gate.confirmation_open_failed", { eventId: message.eventId });
    throw error;
  }
  input.log("gate.confirmation_requested", { eventId: message.eventId, calls: calls.length, kinds: [...new Set(calls.map((call) => call.kind))].join(",") });
  return "posted";
}
