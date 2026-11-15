// Lane ID part 2 (plan v3.2 section 7.2 change 2): the fresh sign-in ("step-up") with a factor Code owns. A Slack (or Google, GitHub) round trip never counts; an emailed one-time
// code on Code's own page does; a company sign-in counts only with an auth_time inside the window. The step-up's time and method go into the token and a refresh never renews them.
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { DEVELOPER_STEP_UP_ATTEMPTS_MAX, DEVELOPER_STEP_UP_EMAILS_MAX, DEVELOPER_STEP_UP_PAGES_PER_HOUR } from "@agentx/contracts";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { STEP_UP_COOKIE, STEP_UP_TEXT, maskedEmail, type StepUpEmailSender } from "../../packages/broker/src/developer/step-up.js";
import { stepUpOf } from "../../packages/broker/src/developer/verify-token.js";
import { API, CLI_REDIRECT, ISSUER, authorizeQuery, httpEvent, identityHarness, type FakeOidcUser, type FakeSlackUser } from "../support/developer-fakes.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const noEmail: FakeSlackUser = { userId: "U0NOMAIL1", name: "No Mail" };
const ORIGIN = new URL(API).origin;

function fakeSender(fail = false): StepUpEmailSender & { sent: Array<{ to: string; subject: string; text: string }> } {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    sent,
    async send(message) {
      if (fail) throw Object.assign(new Error(`smtp refused ${message.to} with code inside`), { name: "SendFailed" });
      sent.push(message);
    },
  };
}

const codeIn = (text: string) => /\b([0-9]{6})\b/u.exec(text)?.[1] ?? "";

/** A request from the browser that holds the step-up cookie. */
/** `origin` "" sends none. */
function browser(method: "GET" | "POST", path: string, cookie: string | undefined, body?: Record<string, string>, origin = ORIGIN): HttpApiV2Event {
  const event = httpEvent(method, path, body);
  return { ...event, headers: { ...event.headers, ...(origin === "" || method === "GET" ? {} : { origin }) }, ...(cookie === undefined ? {} : { cookies: [`${STEP_UP_COOKIE}=${cookie}`] }) };
}

const cookieOf = (response: HttpResult): string | undefined =>
  response.cookies?.map((cookie) => new RegExp(`^${STEP_UP_COOKIE}=([^;]*);`).exec(cookie)?.[1]).find((value) => value !== undefined && value !== "");

type Harness = ReturnType<typeof identityHarness>;

/**
 * Authorize (with a step-up asked for unless `plain`), go through Slack as `who`, and answer what the callback answered. A step-up first signs `who` in once the ordinary way (unless
 * `firstEver`), because the code goes only to the email their record held before the step-up's own sign-in.
 */
async function throughSlack(h: Harness, who: string, plain = false, firstEver = false): Promise<HttpResult> {
  if (!plain && !firstEver) await plainSignIn(h, who);
  const start = await h.http(httpEvent("GET", authorizeQuery(plain ? {} : { acr_values: "step-up" })));
  expect(start.statusCode).toBe(302);
  return h.http(httpEvent("GET", h.slack.approve(start.headers.location!, who)));
}

async function plainSignIn(h: Harness, who: string): Promise<void> {
  const start = await h.http(httpEvent("GET", authorizeQuery()));
  const back = await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, who)));
  expect(new URL(back.headers.location!).searchParams.get("code")).toMatch(/^agxc_/);
}

async function stepUpWithEmail(h: Harness, sender: ReturnType<typeof fakeSender>, who = "U0MAYA001"): Promise<{ location: URL; response: HttpResult }> {
  const back = await throughSlack(h, who);
  const cookie = cookieOf(back);
  expect(back.headers.location).toBe(`${ISSUER}/step-up`);
  expect(cookie).toBeDefined();
  expect((await h.http(browser("POST", "/v1/auth/step-up/email", cookie))).statusCode).toBe(200);
  const response = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: codeIn(sender.sent.at(-1)!.text) }));
  return { location: new URL(response.headers.location ?? `${API}/none-${response.statusCode}`), response };
}

const claimsOf = (token: unknown) => decodeJwt(String(token));

describe("asking for a step-up", () => {
  it("leaves a sign-in that does not ask for one exactly as before: the code goes straight back and the token has no step-up claims", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const back = await throughSlack(h, "U0MAYA001", true);
    const location = new URL(back.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    expect([...location.searchParams.keys()]).toEqual(["code", "state"]);
    expect(back.cookies).toBeUndefined();
    const tokens = await h.exchange(location.searchParams.get("code")!);
    expect(claimsOf(tokens.body.access_token)).not.toHaveProperty("step_up_at");
    expect(claimsOf(tokens.body.access_token)).not.toHaveProperty("step_up_amr");
    expect(sender.sent).toEqual([]);
  });

  it("never issues a code for the Slack round trip alone: the browser goes to Code's own page, bound by a cookie", async () => {
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: fakeSender() } });
    await plainSignIn(h, "U0MAYA001");
    const codes = () => [...h.db.items.values()].filter((item) => String(item.pk).startsWith("CODE#")).length;
    const before = codes();
    const back = await throughSlack(h, "U0MAYA001", false, true);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`${ISSUER}/step-up`);
    expect(back.cookies?.[0]).toMatch(new RegExp(`^${STEP_UP_COOKIE}=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600$`));
    expect(codes()).toBe(before);
    // Only the cookie's hash is kept.
    expect(JSON.stringify([...h.db.items.values()])).not.toContain(cookieOf(back)!);
    const page = await h.http(browser("GET", "/v1/auth/step-up", cookieOf(back)));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(STEP_UP_TEXT.send);
    expect(page.headers["content-security-policy"]).toContain(`form-action ${ORIGIN} http://127.0.0.1:49152;`);
  });

  it("puts the step-up's time and method into the token once the emailed code is confirmed, and goes back to the client with a 303", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const { location, response } = await stepUpWithEmail(h, sender);
    expect(response.statusCode).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    expect(location.searchParams.get("state")).toBe("cli-state");
    expect(response.cookies).toContain(`${STEP_UP_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("maya@example.com");
    expect(sender.sent[0]!.subject).toBe(STEP_UP_TEXT.subject);
    const tokens = await h.exchange(location.searchParams.get("code")!);
    expect(tokens.status).toBe(200);
    const claims = claimsOf(tokens.body.access_token);
    expect(claims.step_up_at).toBe(Math.floor(h.now() / 1000));
    expect(claims.step_up_amr).toBe("email_code");
    expect(claims.amr).toBe("slack");
  });

  it("asks for the factor again on a second step-up inside a live Slack session (Slack sends the person straight back)", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    await stepUpWithEmail(h, sender);
    h.tick(60_000);
    const again = await throughSlack(h, "U0MAYA001");
    expect(again.headers.location).toBe(`${ISSUER}/step-up`);
    expect(new URL(again.headers.location!).searchParams.get("code")).toBeNull();
    // The earlier page's cookie is spent: it cannot finish the new one.
    expect(cookieOf(again)).toBeDefined();
  });

  it("never renews the step-up on a refresh: the refreshed token carries the original time", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const { location } = await stepUpWithEmail(h, sender);
    const stepped = Math.floor(h.now() / 1000);
    const tokens = await h.exchange(location.searchParams.get("code")!);
    h.tick(30 * 60_000);
    const refreshed = await h.refresh(String(tokens.body.refresh_token));
    expect(refreshed.status).toBe(200);
    expect(claimsOf(refreshed.body.access_token).step_up_at).toBe(stepped);
    expect(claimsOf(refreshed.body.access_token).iat).toBe(stepped + 30 * 60);
  });

  it("ignores acr values that are not Code's", async () => {
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: fakeSender() } });
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "urn:other step-upish" })));
    const back = await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, "U0MAYA001")));
    expect(new URL(back.headers.location!).searchParams.get("code")).toMatch(/^agxc_/);
  });
});

describe("refusals on the step-up page", () => {
  it("tells the client there is no factor, and issues no new code, when the person has no email", async () => {
    {
      const h = identityHarness({ slackUsers: [noEmail], stepUp: { email: fakeSender() } });
      await plainSignIn(h, "U0NOMAIL1");
      const before = [...h.db.items.values()].filter((item) => String(item.pk).startsWith("CODE#")).length;
      const back = await throughSlack(h, "U0NOMAIL1", false, true);
      const location = new URL(back.headers.location!);
      expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("error_description")).toBe(STEP_UP_TEXT.noFactor);
      expect(location.searchParams.get("code")).toBeNull();
      expect([...h.db.items.values()].filter((item) => String(item.pk).startsWith("CODE#"))).toHaveLength(before);
    }
  });

  it("refuses at once, with no trip to the provider, when the install has no factor at all", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up" })));
    const location = new URL(start.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    expect(location.searchParams.get("error_description")).toBe(STEP_UP_TEXT.noFactor);
    expect(h.fetch.calls).toEqual([]);
  });

  it("never lets the step-up's own sign-in choose the inbox: no factor on a first-ever sign-in, or when the provider now says another email", async () => {
    const sender = fakeSender();
    const first = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    expect(new URL((await throughSlack(first, "U0MAYA001", false, true)).headers.location!).searchParams.get("error_description")).toBe(STEP_UP_TEXT.noFactor);
    const moved: FakeSlackUser = { ...maya };
    const h = identityHarness({ slackUsers: [moved], stepUp: { email: sender } });
    await plainSignIn(h, "U0MAYA001");
    moved.email = "attacker@example.net";
    const back = await throughSlack(h, "U0MAYA001", false, true);
    expect(new URL(back.headers.location!).searchParams.get("error_description")).toBe(STEP_UP_TEXT.noFactor);
    expect(sender.sent).toEqual([]);
    // The same address in another case is the same inbox.
    moved.email = "Maya@Example.com";
    const h2 = identityHarness({ slackUsers: [moved], stepUp: { email: sender } });
    moved.email = "maya@example.com";
    await plainSignIn(h2, "U0MAYA001");
    moved.email = "Maya@Example.com";
    expect((await throughSlack(h2, "U0MAYA001", false, true)).headers.location).toBe(`${ISSUER}/step-up`);
  });

  it("starts at most five pages per person per hour, then refuses with no code, and allows more the next hour", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    await plainSignIn(h, "U0MAYA001");
    for (let page = 0; page < DEVELOPER_STEP_UP_PAGES_PER_HOUR; page += 1) expect((await throughSlack(h, "U0MAYA001", false, true)).headers.location).toBe(`${ISSUER}/step-up`);
    const limited = new URL((await throughSlack(h, "U0MAYA001", false, true)).headers.location!);
    expect(limited.searchParams.get("error_description")).toBe(STEP_UP_TEXT.limited);
    expect(limited.searchParams.get("code")).toBeNull();
    h.tick(3_600_000);
    expect((await throughSlack(h, "U0MAYA001", false, true)).headers.location).toBe(`${ISSUER}/step-up`);
  });

  it("serves its pages with a referrer policy that keeps the real Origin on the page's own POSTs", async () => {
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: fakeSender() } });
    const back = await throughSlack(h, "U0MAYA001");
    expect(back.headers["referrer-policy"]).toBe("same-origin");
    expect((await h.http(browser("GET", "/v1/auth/step-up", cookieOf(back)))).headers["referrer-policy"]).toBe("same-origin");
  });

  it("refuses a POST that is not from Code's own origin, and a page with no cookie or someone else's", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const cookie = cookieOf(await throughSlack(h, "U0MAYA001"));
    for (const origin of ["", "https://evil.example.test", "null", `${ORIGIN}.evil.example.test`]) {
      expect((await h.http(browser("POST", "/v1/auth/step-up/email", cookie, undefined, origin))).statusCode).toBe(403);
    }
    expect(sender.sent).toEqual([]);
    expect((await h.http(browser("GET", "/v1/auth/step-up", undefined))).statusCode).toBe(400);
    expect((await h.http(browser("POST", "/v1/auth/step-up/email", "x".repeat(43)))).body).toContain(STEP_UP_TEXT.expired);
    expect(sender.sent).toEqual([]);
  });

  it("counts every try, refuses the right code after too many wrong ones, and never sends again then", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const cookie = cookieOf(await throughSlack(h, "U0MAYA001"));
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    const right = codeIn(sender.sent[0]!.text);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt < DEVELOPER_STEP_UP_ATTEMPTS_MAX; attempt += 1) {
      const answer = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: attempt % 2 === 0 ? "not-a-code" : wrong }));
      expect(answer.statusCode).toBe(400);
      expect(answer.body).toContain(STEP_UP_TEXT.wrong);
    }
    const last = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: wrong }));
    expect(last.body).toContain(STEP_UP_TEXT.tooManyTries);
    const late = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: right }));
    expect(late.headers.location).toBeUndefined();
    expect(late.body).toContain(STEP_UP_TEXT.tooManyTries);
    expect((await h.http(browser("POST", "/v1/auth/step-up/email", cookie))).statusCode).toBe(429);
    expect(sender.sent).toHaveLength(1);
  });

  it("sends at most the set number of codes per page, and only the latest works", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const cookie = cookieOf(await throughSlack(h, "U0MAYA001"));
    for (let sent = 0; sent < DEVELOPER_STEP_UP_EMAILS_MAX; sent += 1) expect((await h.http(browser("POST", "/v1/auth/step-up/email", cookie))).statusCode).toBe(200);
    const extra = await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    expect(extra.statusCode).toBe(429);
    expect(extra.body).toContain(STEP_UP_TEXT.noMoreEmails);
    expect(sender.sent).toHaveLength(DEVELOPER_STEP_UP_EMAILS_MAX);
    const first = codeIn(sender.sent[0]!.text);
    const latest = codeIn(sender.sent.at(-1)!.text);
    if (first !== latest) expect((await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: first }))).statusCode).toBe(400);
    expect((await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: latest }))).statusCode).toBe(303);
  });

  it("uses a page once: the same cookie and code cannot issue a second code", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const back = await throughSlack(h, "U0MAYA001");
    const cookie = cookieOf(back);
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    const code = codeIn(sender.sent[0]!.text);
    expect((await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code }))).statusCode).toBe(303);
    const again = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code }));
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain(STEP_UP_TEXT.expired);
  });

  it("issues one code for two parallel right answers on one page", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const cookie = cookieOf(await throughSlack(h, "U0MAYA001"));
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    const code = codeIn(sender.sent[0]!.text);
    const answers = await Promise.all([1, 2].map(() => h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code }))));
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([303, 400]);
  });

  it("expires the page after ten minutes", async () => {
    const sender = fakeSender();
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const cookie = cookieOf(await throughSlack(h, "U0MAYA001"));
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    h.tick(600_000);
    const late = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: codeIn(sender.sent[0]!.text) }));
    expect(late.body).toContain(STEP_UP_TEXT.expired);
    expect(late.headers.location).toBeUndefined();
  });

  it("never shows or logs the code, the cookie or the full email, and a failed send says only that it failed", async () => {
    const sender = fakeSender(true);
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: sender } });
    const back = await throughSlack(h, "U0MAYA001");
    const cookie = cookieOf(back)!;
    const failed = await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toContain(STEP_UP_TEXT.notSent);
    expect(failed.body).not.toContain("smtp");
    const good = fakeSender();
    const h2 = identityHarness({ slackUsers: [maya], stepUp: { email: good } });
    const cookie2 = cookieOf(await throughSlack(h2, "U0MAYA001"))!;
    const page = await h2.http(browser("POST", "/v1/auth/step-up/email", cookie2));
    expect(page.body).toContain(maskedEmail("maya@example.com"));
    const code = codeIn(good.sent[0]!.text);
    const wrongPage = await h2.http(browser("POST", "/v1/auth/step-up/verify", cookie2, { code: code === "123456" ? "654321" : "123456" }));
    for (const body of [page.body, wrongPage.body, failed.body]) {
      expect(body).not.toContain("maya@example.com");
      expect(body).not.toContain(code);
      expect(body).not.toContain(cookie2);
    }
    const logs = JSON.stringify([...h.logs, ...h2.logs]);
    for (const secret of ["maya@example.com", code, cookie, cookie2, "smtp"]) expect(logs).not.toContain(secret);
  });
});

describe("a company sign-in's own re-authentication", () => {
  const ana = { sub: "ana", name: "Ana", email: "ana@example.com", email_verified: true } satisfies FakeOidcUser;
  async function throughOidc(h: Harness, sub: string): Promise<{ authorize: URL; back: HttpResult }> {
    const first = await h.http(httpEvent("GET", authorizeQuery()));
    await h.http(httpEvent("GET", h.oidc.approve(first.headers.location!, sub)));
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up" })));
    const authorize = new URL(start.headers.location!);
    return { authorize, back: await h.http(httpEvent("GET", h.oidc.approve(authorize.toString(), sub))) };
  }

  it("asks the company's sign-in to authenticate again, and counts it when its auth_time is inside the window", async () => {
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [{ ...ana, auth_time: Math.floor(Date.parse("2026-09-27T12:00:00.000Z") / 1000) } as FakeOidcUser], stepUp: { email: fakeSender() } });
    const { authorize, back } = await throughOidc(h, "ana");
    expect(authorize.searchParams.get("prompt")).toBe("login");
    expect(authorize.searchParams.get("max_age")).toBe("600");
    const location = new URL(back.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    const claims = claimsOf((await h.exchange(location.searchParams.get("code")!)).body.access_token);
    expect(claims.step_up_amr).toBe("company_reauth");
    expect(claims.step_up_at).toBe(Math.floor(Date.parse("2026-09-27T12:00:00.000Z") / 1000));
  });

  it("falls back to Code's own factor when the auth_time is missing, too old, older than this sign-in request (a reused company session), in the future or not a number", async () => {
    const t0 = Math.floor(Date.parse("2026-09-27T12:00:00.000Z") / 1000);
    for (const authTime of [undefined, t0 - 601, t0 - 300, t0 + 600, "1790000000"]) {
      const user = { ...ana, ...(authTime === undefined ? {} : { auth_time: authTime }) } as FakeOidcUser;
      const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [user], stepUp: { email: fakeSender() } });
      const { back } = await throughOidc(h, "ana");
      expect(back.headers.location).toBe(`${ISSUER}/step-up`);
    }
  });

  it("never asks Slack to re-authenticate (it cannot be made to, so its round trip never counts)", async () => {
    const h = identityHarness({ slackUsers: [maya], stepUp: { email: fakeSender() } });
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up" })));
    const authorize = new URL(start.headers.location!);
    expect(authorize.searchParams.get("prompt")).toBeNull();
    expect(authorize.searchParams.get("max_age")).toBeNull();
  });
});

describe("stepUpOf (the broker reads the step-up from a verified token)", () => {
  it("reads a whole-second time and one of Code's methods, and nothing else", () => {
    expect(stepUpOf({ step_up_at: 1_790_000_000, step_up_amr: "email_code" })).toEqual({ at: new Date(1_790_000_000_000).toISOString(), method: "email_code" });
    expect(stepUpOf({ step_up_at: 1_790_000_000, step_up_amr: "passkey" })?.method).toBe("passkey");
    for (const payload of [
      {}, { step_up_at: 1_790_000_000 }, { step_up_amr: "email_code" }, { step_up_at: "1790000000", step_up_amr: "email_code" }, { step_up_at: 1.5, step_up_amr: "email_code" },
      { step_up_at: 0, step_up_amr: "email_code" }, { step_up_at: -5, step_up_amr: "email_code" }, { step_up_at: Number.MAX_SAFE_INTEGER, step_up_amr: "email_code" },
      { step_up_at: 1_790_000_000, step_up_amr: "slack" }, { step_up_at: 1_790_000_000, step_up_amr: "EMAIL_CODE" }, { step_up_at: 1_790_000_000, step_up_amr: ["email_code"] },
    ]) expect(stepUpOf(payload as never)).toBeUndefined();
  });
});

describe("discovery", () => {
  it("names the step-up acr value only when a factor is set up", async () => {
    const off = identityHarness();
    expect(JSON.parse((await off.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"))).body)).not.toHaveProperty("acr_values_supported");
    const on = identityHarness({ stepUp: { email: fakeSender() } });
    expect((JSON.parse((await on.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"))).body) as Record<string, unknown>).acr_values_supported).toEqual(["step-up"]);
  });
});
