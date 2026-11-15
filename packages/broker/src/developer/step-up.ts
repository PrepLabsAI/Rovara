// Lane ID part 2 (plan v3.2 section 7.2 change 2, DEC 214 decision 7): the fresh sign-in ("step-up") with a factor Code owns.
//
// A client that needs a fresh sign-in for a sensitive press sends the person to `/v1/auth/authorize` with `acr_values=step-up`. The sign-in at Slack (or the company's sign-in) then
// only says WHO the person is: Slack, Google and GitHub can send a person straight back without asking anything, so that round trip never counts. Before any code is issued the
// person proves it again on Code's own page with a factor Code owns: here, a one-time code sent to the email on their sign-in record. Only then is the code issued, and the session it
// starts carries the step-up's time and method into every access token (`step_up_at`, `step_up_amr`). A refresh carries them over unchanged; the route checks the age.
//
// The page is bound to the browser that came back from the provider by a cookie (a random secret; only its hash is stored). Every POST must come from Code's own origin. Codes: six
// digits, bound to the page's secret, at most DEVELOPER_STEP_UP_EMAILS_MAX sent and DEVELOPER_STEP_UP_ATTEMPTS_MAX tried per page; a try is counted before it is compared. Nothing here
// logs or shows a code, a secret, an email address in full, or a caught error's message.
import { randomInt, timingSafeEqual } from "node:crypto";
import { DEVELOPER_STEP_UP_ATTEMPTS_MAX, DEVELOPER_STEP_UP_EMAILS_MAX, DEVELOPER_STEP_UP_SECONDS } from "@agentx/contracts";
import type { CodeGrant, DeveloperSignInStore, StepUpRecord } from "./store.js";
import { sha256Hex } from "./tokens.js";

/** Sends the one-time code. Injected: a fake in tests; the deployed sender is wired by the install. It must not log the message. A throw means it was not sent. */
export interface StepUpEmailSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface StepUpDependencies {
  email?: StepUpEmailSender;
}

export interface StepUpHttpResult { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }

export const STEP_UP_COOKIE = "__Host-agentx_step_up";
const CODE = /^[0-9]{6}$/u;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export const STEP_UP_TEXT = {
  title: "Confirm it's you",
  why: "Signing in with Slack, Google or GitHub is not enough for this. Confirm with a code sent to your email.",
  send: "Email me a code",
  sendAgain: "Send a new code",
  sent: "We sent a six-digit code to",
  enter: "Code",
  confirm: "Confirm",
  wrong: "That code is not right. Check the latest email and try again.",
  notSent: "The code could not be sent just now. Try again in a moment.",
  noMoreEmails: "No more codes can be sent from this page. Start again from where you were.",
  tooManyTries: "Too many wrong codes. Start again from where you were.",
  expired: "This confirmation has expired. Start again from where you were.",
  wrongPlace: "This confirmation did not come from this page. Start again from where you were.",
  noFactor: "there is no way to confirm it's you set up for your account here (it needs an email on your sign-in record); ask an admin",
  subject: "Your AgentX confirmation code",
} as const;

/** "m***@example.com": the person's own address, enough to know which inbox to look in. */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "your email";
  return `${email[0]}***${email.slice(at)}`;
}

/** The code is bound to the page's secret, which only the browser holds: a reader of the table cannot try the million codes against the stored hash. */
const codeHash = (secret: string, code: string) => sha256Hex(`${secret}:${code}`);

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return undefined;
}

export interface StepUpPagesOptions {
  issuer: string;
  env: string;
  store: DeveloperSignInStore;
  deps: StepUpDependencies | undefined;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

export function createStepUpPages(options: StepUpPagesOptions) {
  const issuerOrigin = new URL(options.issuer).origin;
  const endpoint = (path: string) => `${options.issuer}${path}`;
  const setCookie = (secret: string) => `${STEP_UP_COOKIE}=${secret}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVELOPER_STEP_UP_SECONDS}`;
  const clearCookie = `${STEP_UP_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

  /** The page's own HTML: forms post only to Code itself, and the one redirect after a confirmed code goes to the client's own origin. */
  function html(statusCode: number, record: Pick<StepUpRecord, "grant"> | undefined, paragraphs: string[], forms: string[] = []): StepUpHttpResult {
    let clientOrigin = "";
    try {
      if (record !== undefined) clientOrigin = ` ${new URL(record.grant.redirectUri).origin}`;
    } catch {
      clientOrigin = "";
    }
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(STEP_UP_TEXT.title)}</title>`
      + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}form{margin:1rem 0}input{font-size:1.25rem;letter-spacing:.2em;padding:.4rem;width:8rem}button{padding:.6rem 1rem;font-size:1rem}</style></head>`
      + `<body><main><h1>${escape(STEP_UP_TEXT.title)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}${forms.join("")}</main></body></html>`;
    return {
      statusCode,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${issuerOrigin}${clientOrigin}; frame-ancestors 'none'; base-uri 'none'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
      body,
    };
  }
  const sendForm = (label: string) => `<form method="post" action="${escape(endpoint("/step-up/email"))}"><button type="submit">${escape(label)}</button></form>`;
  const codeForm = () => `<form method="post" action="${escape(endpoint("/step-up/verify"))}"><label>${escape(STEP_UP_TEXT.enter)} <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label> <button type="submit">${escape(STEP_UP_TEXT.confirm)}</button></form>`;
  const ended = (text: string) => ({ ...html(400, undefined, [text]), cookies: [clearCookie] });

  async function emailOf(developerId: string): Promise<string | undefined> {
    return (await options.store.getDeveloper(developerId))?.email;
  }

  async function view(record: StepUpRecord, notes: string[] = [], statusCode = 200): Promise<StepUpHttpResult> {
    const email = await emailOf(record.grant.developerId);
    if (email === undefined || options.deps?.email === undefined) return ended(STEP_UP_TEXT.expired);
    if (record.emailsSent === 0) return html(statusCode, record, [STEP_UP_TEXT.why, ...notes], [sendForm(STEP_UP_TEXT.send)]);
    const forms = [codeForm(), ...(record.emailsSent < DEVELOPER_STEP_UP_EMAILS_MAX ? [sendForm(STEP_UP_TEXT.sendAgain)] : [])];
    return html(statusCode, record, [`${STEP_UP_TEXT.sent} ${maskedEmail(email)}.`, ...notes], forms);
  }

  /** The browser's page, if it holds one, and the POST came from Code's own origin (a cross-site form never reaches a page). */
  async function pageOf(headers: Record<string, string | undefined>, post: boolean): Promise<{ secret: string; record: StepUpRecord } | StepUpHttpResult> {
    if (post && headers.origin !== issuerOrigin) return html(403, undefined, [STEP_UP_TEXT.wrongPlace]);
    const secret = cookieValue(headers.cookie, STEP_UP_COOKIE) ?? "";
    const record = await options.store.getStepUp(secret);
    if (record === undefined) return ended(STEP_UP_TEXT.expired);
    return { secret, record };
  }

  return {
    /**
     * After the provider said who the person is, for a step-up: start Code's own page. Undefined when the person has no factor Code can use here (no sender, or no email on their
     * record); the caller then tells the client so, and no code is issued.
     */
    async start(grant: StepUpRecord["grant"], clientState: string): Promise<StepUpHttpResult | undefined> {
      if (options.deps?.email === undefined || (await emailOf(grant.developerId)) === undefined) return undefined;
      const secret = await options.store.createStepUp({ grant, clientState });
      options.log({ event: "signin.step_up_started", method: grant.amr, developerId: grant.developerId });
      return { statusCode: 302, headers: { location: endpoint("/step-up"), "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "", cookies: [setCookie(secret)] };
    },

    async show(headers: Record<string, string | undefined>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, false);
      return "statusCode" in page ? page : view(page.record);
    },

    async sendEmail(headers: Record<string, string | undefined>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return page;
      const sender = options.deps?.email;
      const email = await emailOf(page.record.grant.developerId);
      if (sender === undefined || email === undefined) return ended(STEP_UP_TEXT.expired);
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      // Bound before it is sent: a code that reached the inbox always works on this page, and a page out of sends never sends.
      if (!await options.store.recordStepUpEmail(page.secret, codeHash(page.secret, code))) return view(page.record, [STEP_UP_TEXT.noMoreEmails], 429);
      try {
        await sender.send({
          to: email, subject: STEP_UP_TEXT.subject,
          text: `Your AgentX confirmation code is ${code}. It works for ${Math.round(DEVELOPER_STEP_UP_SECONDS / 60)} minutes, on the page that asked for it (environment ${options.env}).\n\n`
            + "If you did not ask for it, do not share it with anyone: someone may be using your sign-in. Tell an AgentX admin.",
        });
      } catch (error) {
        options.log({ event: "signin.step_up_email_failed", developerId: page.record.grant.developerId, error: errorName(error) });
        const after = await options.store.getStepUp(page.secret);
        return after === undefined ? ended(STEP_UP_TEXT.expired) : view(after, [STEP_UP_TEXT.notSent], 503);
      }
      options.log({ event: "signin.step_up_email_sent", developerId: page.record.grant.developerId });
      const after = await options.store.getStepUp(page.secret);
      return after === undefined ? ended(STEP_UP_TEXT.expired) : view(after);
    },

    /** Checks the code. On a match the page is used up and `issue` makes the code for the client, carrying the step-up's time and method. */
    async verify(headers: Record<string, string | undefined>, form: URLSearchParams, issue: (grant: CodeGrant & { codeChallenge: string; redirectUri: string }, clientState: string) => Promise<StepUpHttpResult>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return page;
      const typed = (form.get("code") ?? "").replace(/\s+/gu, "");
      // Counted before it is compared, whatever was typed: the count is the only limit on guessing.
      const counted = await options.store.countStepUpAttempt(page.secret);
      if (counted === undefined) return ended(STEP_UP_TEXT.tooManyTries);
      const expected = counted.emailCodeHash;
      const given = CODE.test(typed) ? codeHash(page.secret, typed) : "";
      const matches = expected !== undefined && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!matches) {
        options.log({ event: "signin.step_up_refused", developerId: counted.grant.developerId, reason: "wrong_code", attempts: counted.attempts });
        if (counted.attempts >= DEVELOPER_STEP_UP_ATTEMPTS_MAX) return ended(STEP_UP_TEXT.tooManyTries);
        return view(counted, [STEP_UP_TEXT.wrong], 400);
      }
      const used = await options.store.consumeStepUp(page.secret);
      if (used === undefined) return ended(STEP_UP_TEXT.expired);
      const at = Math.floor(options.now() / 1000);
      options.log({ event: "signin.step_up_succeeded", method: used.grant.amr, stepUpMethod: "email_code", developerId: used.grant.developerId });
      const result = await issue({ ...used.grant, stepUpAt: at, stepUpMethod: "email_code" }, used.clientState);
      return { ...result, cookies: [...(result.cookies ?? []), clearCookie] };
    },
  };
}
