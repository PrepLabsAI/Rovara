// The `email` plug-in point (a new interface; the owner decides it alone, decision 63).
//
// One sender of plain notices: a "needs you" summary, an invitation, a note that a new way to sign in was added. The core writes every word (fixed sentences, the
// links it made, a title it already cleaned); the adapter only sends. The sender's own address, its sign-in and its sending limits are the adapter's settings, set by
// the owner: a call never names a sender, so a task, a project or a person's text can never pick who an email is from.
//
//   - `send` sends ONE message to ONE address. It resolves when the transport took the message. It throws `EmailError`: `refused` for a message this adapter will not
//     send (an address that is not one plain address, a subject with a line break, a body over the limit, a link that is not https), never retried; `unavailable` for
//     a transport that is down or slow past the message's `deadline`, which the caller may retry later (it marks what was sent itself, so a retry sends once more at most).
//   - `capabilities.available` says whether the adapter can send at all; the core decides before it offers email, and falls back to another channel when it cannot.
//   - `html` is an optional second form of the same words; an adapter without `capabilities.html` sends the text alone. `unsubscribeUrl` becomes the mail client's own
//     unsubscribe offer where the adapter can set it (`capabilities.unsubscribeHeader`); the text always carries the same link in words, so nothing depends on it.
//
// Errors carry a fixed sentence: never the address, the subject, the transport's own message or a request id.
//
// Code's default is `none` (every send is `unavailable`, so an email choice reads as "not set up on this install" and the channel adapters carry notices instead);
// Cloud's adapter is its cloud email service, with the same sender address and grant as today.

/** The longest subject, in characters. One line. */
export const EMAIL_SUBJECT_MAX = 200;
/** The most bytes of the text body (and, separately, of the HTML body). */
export const EMAIL_BODY_MAX_BYTES = 64 * 1_024;

/** One plain address: no display name, no list, no angle brackets, no spaces, quotes, commas or semicolons, at most 254 characters. */
const PLAIN_ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u;
/** What kind of email this is, in the core's words (`attention`, `invite`, `sign-in-notice`): lower-case words with hyphens. For the adapter's own metrics and limits, never shown. */
const PURPOSE = /^[a-z][a-z0-9-]{0,40}$/u;

export interface EmailMessage {
  /** The company the email is sent for (an adapter may keep per-company limits). */
  companyId: string;
  /** What kind of email it is (`attention`, `invite`). */
  purpose: string;
  /** One plain address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** An https link that stops this kind of email (the mail client's own unsubscribe offer). */
  unsubscribeUrl?: string;
  /** An absolute time (Date.now milliseconds) by which the send gives up with `unavailable`. Absent: the adapter's own limit. */
  deadline?: number;
}

export interface EmailCapabilities {
  /** Whether this adapter can send at all. The core asks before it offers email or picks it for a notice (a person's choice falls back to another channel when false). */
  available: boolean;
  /** The HTML form is sent beside the text. */
  html: boolean;
  /** The mail client's unsubscribe offer is set from `unsubscribeUrl`. */
  unsubscribeHeader: boolean;
}

export type EmailErrorCode =
  /** A message this adapter will not send. Never retried. */
  | "refused"
  /** The transport could not take it now. Retry later. */
  | "unavailable";

export class EmailError extends Error {
  constructor(readonly code: EmailErrorCode, message: string) {
    super(message);
    this.name = "EmailError";
  }
  get retryable(): boolean {
    return this.code === "unavailable";
  }
}

export interface EmailSender {
  readonly capabilities: EmailCapabilities;
  /** Throws `EmailError`. */
  send(message: EmailMessage): Promise<void>;
  close?(): Promise<void> | void;
}

/** The unsubscribe link as an adapter sends it: the parsed link's normal form (`URL.href`), never the raw text. `undefined` when it is not a link. */
export function emailUnsubscribeHref(value: string): string | undefined {
  try { return new URL(value).href; } catch { return undefined; }
}

/** Whether a string is one plain address this port sends to. */
export const isPlainEmailAddress = (value: string): boolean => value.length <= 254 && PLAIN_ADDRESS.test(value);

const bytes = (value: string): number => new TextEncoder().encode(value).length;
/** A control character (a line break among them) or a Unicode line or paragraph separator: none may be in a header. */
const hasLineOrControl = (value: string): boolean => [...value].some((char) => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
});

/**
 * Why a message must be refused, in a fixed sentence, or `undefined` when it may be sent. Every adapter checks with this before it reaches its transport, so all refuse
 * the same messages the same way. It never quotes the message.
 */
export function emailRefusal(message: EmailMessage): string | undefined {
  if (!PURPOSE.test(message.purpose)) return "the email's purpose is not one word";
  if (hasLineOrControl(message.to) || !isPlainEmailAddress(message.to)) return "the recipient is not one plain address";
  if (message.subject.length === 0 || message.subject.length > EMAIL_SUBJECT_MAX || hasLineOrControl(message.subject)) return "the subject is not one short line";
  if (message.text.length === 0 || bytes(message.text) > EMAIL_BODY_MAX_BYTES || message.text.includes("\u0000")) return "the text is empty or too long";
  if (message.html !== undefined && (bytes(message.html) > EMAIL_BODY_MAX_BYTES || message.html.includes("\u0000"))) return "the HTML is too long";
  if (message.unsubscribeUrl !== undefined) {
    let url: URL | undefined;
    try { url = new URL(message.unsubscribeUrl); } catch { url = undefined; }
    if (hasLineOrControl(message.unsubscribeUrl) || url === undefined || url.protocol !== "https:" || url.username !== "" || url.password !== "" || message.unsubscribeUrl.length > 2_000 || /[\s<>]/u.test(message.unsubscribeUrl)) return "the unsubscribe link is not a plain https link";
  }
  return undefined;
}
