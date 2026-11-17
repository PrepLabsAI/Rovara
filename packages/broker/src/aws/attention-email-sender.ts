// Web task channel C8, option b (DEC 254zm(3)): the attention email's own small sender function. The broker (whose role and environment are at their limits) decides who is told and what the email says;
// this function only sends it, through Amazon SES (API v2), as the ONE identity the install names for attention email (`CoreAttentionEmailSender`, never the step-up sender). Its role may do exactly
// that (ses:SendEmail on that identity, From pinned), and the function, its role and the broker's right to invoke it exist only while `CoreAttentionEmail` is `on` (infra/lib/attention-email.ts).
//
// What it accepts is checked again here, whatever the broker sent: one plain recipient, one of the core's own subjects, one of the core's own first lines, a body within the port's limit that carries the
// "stop these emails" link, and no web link anywhere that is not on the install's own web app origin. Anything else is refused before SES is called. Answers are fixed words; nothing of the request
// (the address, the subject, the text) is ever logged or returned.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EMAIL_BODY_MAX_BYTES, EMAIL_SUBJECT_MAX, isPlainEmailAddress } from "@agentx/contracts";

/** The sender function's variables (its own environment, not the broker's). */
export const ATTENTION_SENDER_FROM_VARIABLE = "ATTENTION_EMAIL_FROM";
export const ATTENTION_SENDER_ORIGIN_VARIABLE = "ATTENTION_EMAIL_LINK_ORIGIN";

/**
 * The origin the broker writes the email's links on. The broker does not know the web app's host (its environment has no room, and it needs none): the sender, which does, replaces this reserved
 * origin (RFC 2606 `.invalid`, never reachable) with `https://<host>` before the email goes. A link on any other origin is refused.
 */
export const ATTENTION_EMAIL_LINK_PLACEHOLDER = "https://web-app.rovara.invalid";

/** What the broker sends: exactly these fields. */
export interface AttentionEmailRequest { v: 1; to: string; subject: string; text: string }
/**
 * What the function answers. `refused`: the request is not one it sends (never tried again); `unavailable`: SES answered and did not take it (tried again later); `unknown`: no answer from SES
 * (timed out or the connection failed), so it may have gone: never tried again (at most once).
 */
export type AttentionEmailAnswer = { ok: true } | { refused: true } | { unavailable: true } | { unknown: true };
/** The most the sender waits for SES: well under the broker's own wait for the invoke (ATTENTION_SEND_TIMEOUT_MS, 2.5 s), so the broker hears a definite answer whenever it can. */
export const ATTENTION_SES_TIMEOUT_MS = 1_500;

const SUBJECT = /^Rovara(?: digest: [1-9][0-9]{0,4} tasks?|: [1-9][0-9]{0,4} tasks? (?:finished|needs your attention|need your attention))$/u;
const HEADINGS: ReadonlySet<string> = new Set(["Your Rovara digest:", "A task finished in Rovara:", "These tasks finished in Rovara:", "A task needs your attention in Rovara:", "These tasks need your attention in Rovara:"]);
/** Control and line-separator characters, other than the newline and tab a plain-text body is made of. */
const hasControl = (text: string): boolean => /[\p{Cc}\u2028\u2029]/u.test(text.replace(/[\n\t]/gu, ""));
const LINE_OR_CONTROL = /[\p{Cc}\u2028\u2029]/u;
const SENDER = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,252}\.[A-Za-z]{2,63}$/u;
/** Anything a mail client may turn into a link: a scheme's `//` anywhere (even inside a word) or a `www.` name. */
const WEB_LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]*/giu;

/** The sender's own address, or undefined for anything that is not one plain address. */
export function attentionSenderAddress(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 254 && SENDER.test(value) ? value : undefined;
}

/** The web app's own https origin (`https://<host>`), or undefined. */
export function attentionSenderOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    // `https://<host>` as the parameter gives it (any case, an explicit :443 allowed); nothing after the host.
    if (!/^https:\/\/[^/?#\s]+$/iu.test(value)) return undefined;
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.origin : undefined;
  } catch { return undefined; }
}

/**
 * The request, checked, with its links moved from the placeholder to the web app's own `origin`; or undefined (refused). Every link in the text must be on the placeholder origin.
 */
export function checkedAttentionEmailRequest(value: unknown, origin: string): AttentionEmailRequest | undefined {
  const placeholder = ATTENTION_EMAIL_LINK_PLACEHOLDER;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.join(",") !== "subject,text,to,v" || fields["v"] !== 1) return undefined;
  const { to, subject, text } = fields;
  if (typeof to !== "string" || typeof subject !== "string" || typeof text !== "string") return undefined;
  if (to.length > 254 || LINE_OR_CONTROL.test(to) || !isPlainEmailAddress(to)) return undefined;
  if (subject.length > EMAIL_SUBJECT_MAX || !SUBJECT.test(subject)) return undefined;
  if (text === "" || Buffer.byteLength(text, "utf8") > EMAIL_BODY_MAX_BYTES || hasControl(text)) return undefined;
  const lines = text.split("\n");
  if (!HEADINGS.has(lines[0]!)) return undefined;
  // Never without the way out: the signed link that stops these emails, on the web app's own origin.
  if (!lines.some((line) => line.startsWith(`Stop these emails: ${placeholder}/`))) return undefined;
  // Every web link is the web app's own: a task title that holds a link of anywhere else is not sent at all.
  for (const link of text.match(WEB_LINK) ?? []) if (!link.startsWith(`${placeholder}/`)) return undefined;
  const moved = text.split(`${placeholder}/`).join(`${origin}/`);
  if (Buffer.byteLength(moved, "utf8") > EMAIL_BODY_MAX_BYTES) return undefined;
  return { v: 1, to, subject, text: moved };
}

/** The handler, over a given SES client and environment (the test's entry). */
export function attentionEmailSenderHandler(options: { ses: Pick<SESv2Client, "send">; env: NodeJS.ProcessEnv; log?: (entry: Record<string, unknown>) => void; timeoutMs?: number }): (event: unknown) => Promise<AttentionEmailAnswer> {
  // No log by default: the answer goes back to the broker, which counts outcomes in its own fixed words (core/notify/attention.ts). A test passes a log to see the fixed events.
  const log = options.log ?? (() => undefined);
  const from = attentionSenderAddress(options.env[ATTENTION_SENDER_FROM_VARIABLE]);
  const origin = attentionSenderOrigin(options.env[ATTENTION_SENDER_ORIGIN_VARIABLE]);
  return async (event) => {
    if (from === undefined || origin === undefined) { log({ event: "attention_email.not_configured" }); return { refused: true }; }
    const request = checkedAttentionEmailRequest(event, origin);
    if (request === undefined) { log({ event: "attention_email.refused" }); return { refused: true }; }
    try {
      await options.ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [request.to] },
        Content: { Simple: { Subject: { Data: request.subject, Charset: "UTF-8" }, Body: { Text: { Data: request.text, Charset: "UTF-8" } } } },
      }), { abortSignal: AbortSignal.timeout(options.timeoutMs ?? ATTENTION_SES_TIMEOUT_MS) });
    } catch (error) {
      // The SDK's error can quote the request (the address, the text): only whether SES answered is kept. SES answered with a status: it did not take the message. No status (a timeout, a lost
      // connection): it may have taken it, so it is never sent again.
      const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
      if (typeof status === "number" && status >= 400) { log({ event: "attention_email.unavailable" }); return { unavailable: true }; }
      log({ event: "attention_email.unknown" });
      return { unknown: true };
    }
    log({ event: "attention_email.sent" });
    return { ok: true };
  };
}

// One attempt per call: a send whose answer was lost is never sent a second time by the SDK (the queue's rule is at most once).
let built: ((event: unknown) => Promise<AttentionEmailAnswer>) | undefined;
export const handler = async (event: unknown): Promise<AttentionEmailAnswer> => {
  built ??= attentionEmailSenderHandler({ ses: new SESv2Client({ maxAttempts: 1 }), env: process.env });
  return await built(event);
};
