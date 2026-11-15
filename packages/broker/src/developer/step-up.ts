// Lane ID part 2 (plan v3.2 section 7.2 change 2, DEC 214 decision 7): the fresh sign-in ("step-up") with a factor Code owns.
//
// A client that needs a fresh sign-in for a sensitive press sends the person to `/v1/auth/authorize` with `acr_values=step-up`. The sign-in at Slack (or the company's sign-in) then
// only says WHO the person is: Slack, Google and GitHub can send a person straight back without asking anything, so that round trip never counts. Before any code is issued the
// person proves it again on Code's own page with a factor Code owns: here, a one-time code sent to the email on their sign-in record. Only then is the code issued, and the session it
// starts carries the step-up's time and method into every access token (`step_up_at`, `step_up_amr`). A refresh carries them over unchanged; the route checks the age.
//
// The page is bound to the browser that came back from the provider by a cookie (a random secret; only its hash is stored). Every POST must come from Code's own origin. Codes: six
// digits, bound to the page's secret, at most DEVELOPER_STEP_UP_EMAILS_MAX sent and DEVELOPER_STEP_UP_ATTEMPTS_MAX tried per page, and at most DEVELOPER_STEP_UP_PAGES_PER_HOUR pages per
// person; a try is counted before it is compared. A failed send still counts and replaces the bound code (fail closed: a send that may have half-happened is never re-bound). Nothing here
// logs or shows a code, a secret, an email address in full, or a caught error's message.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { DEVELOPER_PASSKEYS_MAX, DEVELOPER_STEP_UP_ATTEMPTS_MAX, DEVELOPER_STEP_UP_EMAILS_MAX, DEVELOPER_STEP_UP_SECONDS } from "@agentx/contracts";
import type { CodeGrant, DeveloperSignInStore, StepUpRecord } from "./store.js";
import { sha256Hex } from "./tokens.js";

/** Sends the one-time code. Injected: a fake in tests; the deployed sender is wired by the install. It must not log the message. A throw means it was not sent. */
export interface StepUpEmailSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface StepUpDependencies {
  email?: StepUpEmailSender;
  /**
   * Lane ID part 2b: passkeys owned by Code (WebAuthn). `rpId` is the API's host (or a registrable suffix of it); the expected origin is always the issuer's own. Absent: no passkeys.
   */
  passkeys?: { rpId: string; rpName: string };
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
  limited: "too many confirmations were started for your account in the last hour; try again later",
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

/** How long one email send may take before it counts as not sent. */
const SEND_DEADLINE_MS = 10_000;

async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("send deadline passed"), { name: "SendDeadline" })), ms); });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StepUpPagesOptions {
  issuer: string;
  env: string;
  store: DeveloperSignInStore;
  deps: StepUpDependencies | undefined;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** Makes the code for the client and answers the 303 back to it. The grant carries the step-up's time and method. */
  issue: (grant: CodeGrant & { codeChallenge: string; redirectUri: string }, clientState: string) => Promise<StepUpHttpResult>;
}

/** The largest JSON body a passkey POST may carry (a WebAuthn response is a few kilobytes). */
const PASSKEY_BODY_MAX = 16_384;

/**
 * The page's one script, inline and pinned by its hash in the CSP: asks Code for the ceremony's options, lets the browser's passkey UI run, sends the answer back, and follows the
 * address Code answers. It reads nothing from the page but the button's mode, and uses the browser's own JSON helpers.
 */
const PASSKEY_SCRIPT = `(()=>{const b=document.getElementById("passkey");if(!b)return;const m=document.getElementById("passkey-message");`
  + `b.addEventListener("click",async()=>{b.disabled=true;m.textContent="";try{`
  + `const o=await fetch(b.dataset.options,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:"{}"});const j=await o.json();if(!o.ok)throw new Error();`
  + `const c=b.dataset.mode==="create"?await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(j.options)}):await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(j.options)});`
  + `const r=await fetch(b.dataset.verify,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(c.toJSON())});const a=await r.json();`
  + `if(r.ok&&typeof a.location==="string"){window.location.assign(a.location);return;}m.textContent=typeof a.message==="string"?a.message:"";}catch{m.textContent=${JSON.stringify("That did not work. Try again, or use the email code.")};}b.disabled=false;});})();`;
const PASSKEY_SCRIPT_HASH = `'sha256-${createHash("sha256").update(PASSKEY_SCRIPT).digest("base64")}'`;

export const PASSKEY_TEXT = {
  use: "Use your passkey",
  why: "Confirm with your passkey, or with a code sent to your email.",
  onlyPasskey: "Signing in with Slack, Google or GitHub is not enough for this. Confirm with your passkey.",
  offer: "Confirmed. Add a passkey so next time is one tap? It stays on your device; AgentX keeps only its public key.",
  add: "Add a passkey",
  notNow: "Not now",
  failed: "That passkey could not be checked. Try again, or use the email code.",
  notOffered: "No passkey can be used on this page.",
} as const;

export function createStepUpPages(options: StepUpPagesOptions) {
  const issuerOrigin = new URL(options.issuer).origin;
  const endpoint = (path: string) => `${options.issuer}${path}`;
  const setCookie = (secret: string) => `${STEP_UP_COOKIE}=${secret}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVELOPER_STEP_UP_SECONDS}`;
  const clearCookie = `${STEP_UP_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  const passkeys = options.deps?.passkeys;
  const securityHeaders = {
    "cache-control": "no-store",
    // Not no-referrer: a POST from a no-referrer page carries `Origin: null` (Fetch, "append a request Origin header"), and every POST here is checked for Code's own origin.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };

  /** The page's own HTML: forms and the script post only to Code itself, and the one redirect after a confirmed step-up goes to the client's own origin. */
  function html(statusCode: number, record: Pick<StepUpRecord, "grant"> | undefined, paragraphs: string[], forms: string[] = [], script = false): StepUpHttpResult {
    let clientOrigin = "";
    try {
      if (record !== undefined) clientOrigin = ` ${new URL(record.grant.redirectUri).origin}`;
    } catch {
      clientOrigin = "";
    }
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(STEP_UP_TEXT.title)}</title>`
      + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}form{margin:1rem 0}input{font-size:1.25rem;letter-spacing:.2em;padding:.4rem;width:8rem}button{padding:.6rem 1rem;font-size:1rem}</style></head>`
      + `<body><main><h1>${escape(STEP_UP_TEXT.title)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}${forms.join("")}</main>${script ? `<script>${PASSKEY_SCRIPT}</script>` : ""}</body></html>`;
    const scripts = script ? `; script-src ${PASSKEY_SCRIPT_HASH}; connect-src ${issuerOrigin}` : "";
    return {
      statusCode,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...securityHeaders,
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${issuerOrigin}${clientOrigin}; frame-ancestors 'none'; base-uri 'none'${scripts}`,
        "x-frame-options": "DENY",
      },
      body,
    };
  }
  const json = (statusCode: number, body: unknown, cookies?: string[]): StepUpHttpResult => ({ statusCode, headers: { "content-type": "application/json", ...securityHeaders }, body: JSON.stringify(body), ...(cookies === undefined ? {} : { cookies }) });
  const jsonRefusal = (statusCode: number, message: string, end = false) => json(statusCode, { error: "step_up_refused", message }, end ? [clearCookie] : undefined);
  const sendForm = (label: string) => `<form method="post" action="${escape(endpoint("/step-up/email"))}"><button type="submit">${escape(label)}</button></form>`;
  const codeForm = () => `<form method="post" action="${escape(endpoint("/step-up/verify"))}"><label>${escape(STEP_UP_TEXT.enter)} <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label> <button type="submit">${escape(STEP_UP_TEXT.confirm)}</button></form>`;
  const passkeyButton = (mode: "get" | "create", label: string) => `<p><button type="button" id="passkey" data-mode="${mode}" data-options="${escape(endpoint("/step-up/passkey/options"))}" data-verify="${escape(endpoint(mode === "get" ? "/step-up/passkey/verify" : "/step-up/passkey/register"))}">${escape(label)}</button></p><p id="passkey-message" role="status"></p>`;
  const continueForm = () => `<form method="post" action="${escape(endpoint("/step-up/continue"))}"><button type="submit">${escape(PASSKEY_TEXT.notNow)}</button></form>`;
  /** The whole minutes the page (and so its codes) still has, at least one. */
  const minutesLeft = (record: Pick<StepUpRecord, "expiresAt">) => Math.max(1, Math.floor((record.expiresAt - Math.floor(options.now() / 1000)) / 60));
  const ended = (text: string) => ({ ...html(400, undefined, [text]), cookies: [clearCookie] });
  const emailFactor = (record: Pick<StepUpRecord, "email">) => options.deps?.email !== undefined && record.email !== undefined;
  const passkeysOf = async (developerId: string) => (passkeys === undefined ? [] : options.store.listPasskeys(developerId));

  async function view(record: StepUpRecord, notes: string[] = [], statusCode = 200): Promise<StepUpHttpResult> {
    // The emailed code was right: offer a passkey before going back (or go back now).
    if (record.verifiedAt !== undefined) return html(statusCode, record, [PASSKEY_TEXT.offer, ...notes], [passkeyButton("create", PASSKEY_TEXT.add), continueForm()], true);
    const keys = await passkeysOf(record.grant.developerId);
    const byEmail = emailFactor(record);
    if (!byEmail && keys.length === 0) return ended(STEP_UP_TEXT.expired);
    const passkeyPart = keys.length === 0 ? [] : [passkeyButton("get", PASSKEY_TEXT.use)];
    if (!byEmail) return html(statusCode, record, [PASSKEY_TEXT.onlyPasskey, ...notes], passkeyPart, true);
    if (record.emailsSent === 0) return html(statusCode, record, [keys.length === 0 ? STEP_UP_TEXT.why : PASSKEY_TEXT.why, ...notes], [...passkeyPart, sendForm(STEP_UP_TEXT.send)], keys.length > 0);
    const forms = [...passkeyPart, codeForm(), ...(record.emailsSent < DEVELOPER_STEP_UP_EMAILS_MAX ? [sendForm(STEP_UP_TEXT.sendAgain)] : [])];
    return html(statusCode, record, [`${STEP_UP_TEXT.sent} ${maskedEmail(record.email!)}.`, ...notes], forms, keys.length > 0);
  }

  /** The browser's page, if it holds one, and the POST came from Code's own origin (a cross-site form never reaches a page). */
  async function pageOf(headers: Record<string, string | undefined>, post: boolean): Promise<{ secret: string; record: StepUpRecord } | StepUpHttpResult> {
    if (post && headers.origin !== issuerOrigin) return html(403, undefined, [STEP_UP_TEXT.wrongPlace]);
    const secret = cookieValue(headers.cookie, STEP_UP_COOKIE) ?? "";
    const record = await options.store.getStepUp(secret);
    if (record === undefined) return ended(STEP_UP_TEXT.expired);
    return { secret, record };
  }

  /** Uses the page up and issues the code with this step-up. Undefined: the page was already used. */
  async function finish(secret: string, at: number, method: "email_code" | "passkey"): Promise<StepUpHttpResult | undefined> {
    const used = await options.store.consumeStepUp(secret);
    if (used === undefined) return undefined;
    options.log({ event: "signin.step_up_succeeded", method: used.grant.amr, stepUpMethod: method, developerId: used.grant.developerId });
    const result = await options.issue({ ...used.grant, stepUpAt: at, stepUpMethod: method }, used.clientState);
    return { ...result, cookies: [...(result.cookies ?? []), clearCookie] };
  }

  /** A passkey POST's JSON object; undefined for anything else (too large, not JSON, not an object). */
  function jsonBody(body: string | undefined): Record<string, unknown> | undefined {
    if (body === undefined || body.length > PASSKEY_BODY_MAX) return undefined;
    try {
      const value: unknown = JSON.parse(body);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }

  /** The 303 a finished step-up answered, as the JSON the script follows. */
  const followable = (result: StepUpHttpResult): StepUpHttpResult => json(200, { location: result.headers.location ?? "" }, result.cookies);

  return {
    /**
     * After the provider said who the person is, for a step-up: start Code's own page. `factorEmail` is the address the code goes to, chosen by the caller from the record as it stood
     * BEFORE this sign-in (the round trip that does not count must not choose the inbox either). A passkey the person registered with Code is a factor too. "no_factor" when there is
     * neither; "limited" when this person started too many pages in the last hour. Either way the caller tells the client so, and no code is issued.
     */
    async start(grant: StepUpRecord["grant"], clientState: string, factorEmail: string | undefined): Promise<StepUpHttpResult | "no_factor" | "limited"> {
      const email = options.deps?.email === undefined ? undefined : factorEmail;
      if (email === undefined && (await passkeysOf(grant.developerId)).length === 0) return "no_factor";
      const secret = await options.store.createStepUp({ grant, clientState, ...(email === undefined ? {} : { email }) });
      if (secret === undefined) return "limited";
      options.log({ event: "signin.step_up_started", method: grant.amr, developerId: grant.developerId });
      return { statusCode: 302, headers: { location: endpoint("/step-up"), "cache-control": "no-store", "referrer-policy": "same-origin" }, body: "", cookies: [setCookie(secret)] };
    },

    async show(headers: Record<string, string | undefined>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, false);
      return "statusCode" in page ? page : view(page.record);
    },

    async sendEmail(headers: Record<string, string | undefined>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return page;
      const sender = options.deps?.email;
      const email = page.record.email;
      if (sender === undefined || email === undefined || page.record.verifiedAt !== undefined) return ended(STEP_UP_TEXT.expired);
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      // Bound before it is sent: a code that reached the inbox always works on this page, and a page out of sends never sends.
      if (!await options.store.recordStepUpEmail(page.secret, codeHash(page.secret, code))) return view(page.record, [STEP_UP_TEXT.noMoreEmails], 429);
      try {
        // One deadline for the send: a sender that hangs is a send that failed (the code it may still deliver is the latest bound one, so it would still work on this page).
        await withDeadline(sender.send({
          to: email, subject: STEP_UP_TEXT.subject,
          text: `Your AgentX confirmation code is ${code}. It works for ${minutesLeft(page.record)} more ${minutesLeft(page.record) === 1 ? "minute" : "minutes"}, on the page that asked for it (environment ${options.env}).\n\n`
            + "If you did not ask for it, do not share it with anyone: someone may be using your sign-in. Tell an AgentX admin.",
        }), SEND_DEADLINE_MS);
      } catch (error) {
        options.log({ event: "signin.step_up_email_failed", developerId: page.record.grant.developerId, error: errorName(error) });
        const after = await options.store.getStepUp(page.secret);
        return after === undefined ? ended(STEP_UP_TEXT.expired) : view(after, [STEP_UP_TEXT.notSent], 503);
      }
      options.log({ event: "signin.step_up_email_sent", developerId: page.record.grant.developerId });
      const after = await options.store.getStepUp(page.secret);
      return after === undefined ? ended(STEP_UP_TEXT.expired) : view(after);
    },

    /**
     * Checks the emailed code. On a match, with passkeys on and room for another, the page is marked proved (the step-up's time is now) and offers a passkey; otherwise it is used up at
     * once and the code is issued, carrying the step-up's time and method.
     */
    async verify(headers: Record<string, string | undefined>, form: URLSearchParams): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return page;
      if (page.record.verifiedAt !== undefined) return view(page.record);
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
      const at = Math.floor(options.now() / 1000);
      if (passkeys !== undefined && (await passkeysOf(counted.grant.developerId)).length < DEVELOPER_PASSKEYS_MAX) {
        if (!await options.store.markStepUpVerified(page.secret, at)) return ended(STEP_UP_TEXT.expired);
        const marked = await options.store.getStepUp(page.secret);
        return marked === undefined ? ended(STEP_UP_TEXT.expired) : view(marked);
      }
      return (await finish(page.secret, at, "email_code")) ?? ended(STEP_UP_TEXT.expired);
    },

    /** "Not now" on the passkey offer: goes back with the email step-up, at the time the code was proved. */
    async continueWithoutPasskey(headers: Record<string, string | undefined>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return page;
      if (page.record.verifiedAt === undefined) return view(page.record, [], 400);
      return (await finish(page.secret, page.record.verifiedAt, "email_code")) ?? ended(STEP_UP_TEXT.expired);
    },

    /** The WebAuthn options for this page: signing in with a registered passkey, or, once the emailed code was proved, registering a new one. */
    async passkeyOptions(headers: Record<string, string | undefined>): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return jsonRefusal(page.statusCode, STEP_UP_TEXT.expired, true);
      if (passkeys === undefined) return jsonRefusal(404, PASSKEY_TEXT.notOffered);
      const keys = await passkeysOf(page.record.grant.developerId);
      if (page.record.verifiedAt !== undefined) {
        if (keys.length >= DEVELOPER_PASSKEYS_MAX) return jsonRefusal(409, PASSKEY_TEXT.notOffered);
        const developer = await options.store.getDeveloper(page.record.grant.developerId);
        const created = await generateRegistrationOptions({
          rpName: passkeys.rpName, rpID: passkeys.rpId, userName: developer?.displayName ?? "AgentX user", userID: Buffer.from(page.record.grant.developerId, "utf8"),
          attestationType: "none", excludeCredentials: keys.map((key) => ({ id: key.credentialId })),
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, timeout: 120_000,
        });
        if (!await options.store.setStepUpChallenge(page.secret, created.challenge, "create")) return jsonRefusal(400, STEP_UP_TEXT.expired, true);
        return json(200, { options: created });
      }
      if (keys.length === 0) return jsonRefusal(409, PASSKEY_TEXT.notOffered);
      const requested = await generateAuthenticationOptions({ rpID: passkeys.rpId, allowCredentials: keys.map((key) => ({ id: key.credentialId })), userVerification: "required", timeout: 120_000 });
      if (!await options.store.setStepUpChallenge(page.secret, requested.challenge, "get")) return jsonRefusal(400, STEP_UP_TEXT.expired, true);
      return json(200, { options: requested });
    },

    /** Signs in with a registered passkey. The try is counted first (the same limit as codes); the challenge, origin, RP id, user verification, signature and counter are checked. */
    async passkeyVerify(headers: Record<string, string | undefined>, body: string | undefined): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return jsonRefusal(page.statusCode, STEP_UP_TEXT.expired, true);
      if (passkeys === undefined) return jsonRefusal(404, PASSKEY_TEXT.notOffered);
      const counted = await options.store.countStepUpAttempt(page.secret);
      if (counted === undefined) return jsonRefusal(400, STEP_UP_TEXT.tooManyTries, true);
      const refuse = (reason: string) => {
        options.log({ event: "signin.step_up_refused", developerId: counted.grant.developerId, reason, attempts: counted.attempts });
        return counted.attempts >= DEVELOPER_STEP_UP_ATTEMPTS_MAX ? jsonRefusal(400, STEP_UP_TEXT.tooManyTries, true) : jsonRefusal(400, PASSKEY_TEXT.failed);
      };
      const response = jsonBody(body);
      if (response === undefined || typeof response.id !== "string" || counted.challenge === undefined || counted.challengeKind !== "get" || counted.verifiedAt !== undefined) return refuse("passkey_unreadable");
      const key = (await passkeysOf(counted.grant.developerId)).find((candidate) => candidate.credentialId === response.id);
      if (key === undefined) return refuse("passkey_unknown");
      let checked: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        checked = await verifyAuthenticationResponse({
          response: response as unknown as AuthenticationResponseJSON, expectedChallenge: counted.challenge, expectedOrigin: issuerOrigin, expectedRPID: passkeys.rpId,
          credential: { id: key.credentialId, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, ...(key.transports === undefined ? {} : { transports: key.transports }) },
          requireUserVerification: true,
        });
      } catch {
        return refuse("passkey_invalid");
      }
      if (!checked.verified || !checked.authenticationInfo.userVerified) return refuse("passkey_invalid");
      // The counter moves only from the value just read: one assertion cannot be used twice, even in parallel.
      if (!await options.store.setPasskeyCounter(counted.grant.developerId, key.credentialId, key.counter, checked.authenticationInfo.newCounter)) return refuse("passkey_replayed");
      const finished = await finish(page.secret, Math.floor(options.now() / 1000), "passkey");
      return finished === undefined ? jsonRefusal(400, STEP_UP_TEXT.expired, true) : followable(finished);
    },

    /** Registers a passkey after the emailed code was proved on this page, then goes back with the email step-up (at the time the code was proved). */
    async passkeyRegister(headers: Record<string, string | undefined>, body: string | undefined): Promise<StepUpHttpResult> {
      const page = await pageOf(headers, true);
      if ("statusCode" in page) return jsonRefusal(page.statusCode, STEP_UP_TEXT.expired, true);
      if (passkeys === undefined) return jsonRefusal(404, PASSKEY_TEXT.notOffered);
      const record = page.record;
      const response = jsonBody(body);
      if (record.verifiedAt === undefined || record.challenge === undefined || record.challengeKind !== "create" || response === undefined) return jsonRefusal(400, PASSKEY_TEXT.failed);
      if ((await passkeysOf(record.grant.developerId)).length >= DEVELOPER_PASSKEYS_MAX) return jsonRefusal(409, PASSKEY_TEXT.notOffered);
      let checked: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        checked = await verifyRegistrationResponse({
          response: response as unknown as RegistrationResponseJSON, expectedChallenge: record.challenge, expectedOrigin: issuerOrigin, expectedRPID: passkeys.rpId, requireUserVerification: true,
        });
      } catch {
        checked = { verified: false };
      }
      if (!checked.verified) {
        options.log({ event: "signin.passkey_refused", developerId: record.grant.developerId });
        return jsonRefusal(400, PASSKEY_TEXT.failed);
      }
      const credential = checked.registrationInfo.credential;
      const added = await options.store.addPasskey(record.grant.developerId, {
        credentialId: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, createdAt: new Date(options.now()).toISOString(),
        ...(credential.transports === undefined ? {} : { transports: credential.transports.slice(0, 8) }),
      });
      if (!added) return jsonRefusal(409, PASSKEY_TEXT.failed);
      options.log({ event: "signin.passkey_registered", developerId: record.grant.developerId });
      const finished = await finish(page.secret, record.verifiedAt, "email_code");
      return finished === undefined ? jsonRefusal(400, STEP_UP_TEXT.expired, true) : followable(finished);
    },
  };
}
