// Lane ID part 2b: passkeys owned by Code as the step-up factor. A passkey is registered only after the emailed code was proved on the same page (never on the strength of a Slack
// round trip alone); afterwards one passkey tap is a step-up. The server checks the challenge, origin, RP id, user verification, signature and counter, counting each try.
import { createHash, generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { DEVELOPER_STEP_UP_ATTEMPTS_MAX } from "@agentx/contracts";
import { ownerKeyForSubject, type HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { PASSKEY_TEXT, STEP_UP_COOKIE, STEP_UP_TEXT, type StepUpEmailSender } from "../../packages/broker/src/developer/step-up.js";
import { API, CLI_REDIRECT, ISSUER, authorizeQuery, httpEvent, identityHarness, type FakeSlackUser } from "../support/developer-fakes.js";
import { fakePasskey, type FakePasskey } from "../support/fake-passkey.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const ORIGIN = new URL(API).origin;
const RP_ID = new URL(API).hostname;
type Harness = ReturnType<typeof identityHarness>;

function sender(): StepUpEmailSender & { sent: string[] } {
  const sent: string[] = [];
  return { sent, async send(message) { sent.push(message.text); } };
}
const codeIn = (text: string) => /\b([0-9]{6})\b/u.exec(text)?.[1] ?? "";

function browser(method: "GET" | "POST", path: string, cookie: string | undefined, body?: Record<string, string> | string, origin = ORIGIN): HttpApiV2Event {
  const event = typeof body === "string" ? { ...httpEvent(method, path), body, isBase64Encoded: false } : httpEvent(method, path, body);
  return {
    ...event, headers: { ...event.headers, ...(typeof body === "string" ? { "content-type": "application/json" } : {}), ...(origin === "" || method === "GET" ? {} : { origin }) },
    ...(cookie === undefined ? {} : { cookies: [`${STEP_UP_COOKIE}=${cookie}`] }),
  };
}
const cookieOf = (response: HttpResult) => response.cookies?.map((cookie) => new RegExp(`^${STEP_UP_COOKIE}=([^;]*);`).exec(cookie)?.[1]).find((value) => value !== undefined && value !== "");
const body = (response: HttpResult) => JSON.parse(response.body) as Record<string, unknown>;

function harness(users: FakeSlackUser[] = [maya], withEmail = true) {
  const mail = sender();
  const h = identityHarness({ slackUsers: users, stepUp: { ...(withEmail ? { email: mail } : {}), passkeys: { rpId: RP_ID, rpName: "AgentX" } } });
  return { h, mail };
}

async function plainSignIn(h: Harness, who: string) {
  const start = await h.http(httpEvent("GET", authorizeQuery()));
  await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, who)));
}
async function stepUpPage(h: Harness, who = "U0MAYA001"): Promise<string> {
  const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up" })));
  const back = await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, who)));
  expect(back.headers.location).toBe(`${ISSUER}/step-up`);
  return cookieOf(back)!;
}
async function proveEmail(h: Harness, mail: ReturnType<typeof sender>, cookie: string): Promise<HttpResult> {
  await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
  return h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: codeIn(mail.sent.at(-1)!) }));
}
async function options(h: Harness, cookie: string): Promise<{ challenge: string; [key: string]: unknown }> {
  const answer = await h.http(browser("POST", "/v1/auth/step-up/passkey/options", cookie, "{}"));
  expect(answer.statusCode).toBe(200);
  return body(answer).options as { challenge: string };
}
const tokenClaims = async (h: Harness, location: string) => decodeJwt(String((await h.exchange(new URL(location).searchParams.get("code")!)).body.access_token));

async function registered(h: Harness, mail: ReturnType<typeof sender>): Promise<FakePasskey> {
  await plainSignIn(h, "U0MAYA001");
  const cookie = await stepUpPage(h);
  await proveEmail(h, mail, cookie);
  const key = fakePasskey();
  const made = await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(key.register(await options(h, cookie), ORIGIN, RP_ID))));
  expect(made.statusCode).toBe(200);
  return key;
}

describe("registering a passkey", () => {
  it("is offered only after the emailed code was right; Not now goes back with the email step-up at the time the code was proved", async () => {
    const { h, mail } = harness();
    await plainSignIn(h, "U0MAYA001");
    const cookie = await stepUpPage(h);
    const offer = await proveEmail(h, mail, cookie);
    const proved = Math.floor(h.now() / 1000);
    expect(offer.statusCode).toBe(200);
    expect(offer.body).toContain(PASSKEY_TEXT.add);
    expect(offer.body).toContain('data-mode="create"');
    // The one inline script is pinned by its hash.
    const script = /<script>([\s\S]*)<\/script>/u.exec(offer.body)![1]!;
    expect(offer.headers["content-security-policy"]).toContain(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'; connect-src ${ORIGIN}`);
    h.tick(90_000);
    const back = await h.http(browser("POST", "/v1/auth/step-up/continue", cookie));
    expect(back.statusCode).toBe(303);
    const claims = await tokenClaims(h, back.headers.location!);
    expect(claims.step_up_amr).toBe("email_code");
    expect(claims.step_up_at).toBe(proved);
  });

  it("registers a passkey and goes back with the email step-up", async () => {
    const { h, mail } = harness();
    await plainSignIn(h, "U0MAYA001");
    const cookie = await stepUpPage(h);
    await proveEmail(h, mail, cookie);
    const proved = Math.floor(h.now() / 1000);
    h.tick(45_000);
    const key = fakePasskey();
    const made = await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(key.register(await options(h, cookie), ORIGIN, RP_ID))));
    expect(made.statusCode).toBe(200);
    const location = String(body(made).location);
    expect(location.startsWith(CLI_REDIRECT)).toBe(true);
    const claims = await tokenClaims(h, location);
    expect(claims.step_up_amr).toBe("email_code");
    expect(claims.step_up_at).toBe(proved);
    const stored = await h.deps.store.listPasskeys(ownerKeyForSubject("https://slack.com", "U0MAYA001"));
    expect(stored.map((passkey) => passkey.credentialId)).toEqual([key.id]);
    expect(stored[0]!.counter).toBe(0);
  });

  it("can never be registered on a Slack round trip alone, nor with a tampered or unverified response", async () => {
    const { h, mail } = harness();
    await plainSignIn(h, "U0MAYA001");
    const cookie = await stepUpPage(h);
    // Before the code: the options are for signing in (and there is no passkey yet), and register is refused.
    expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/options", cookie, "{}"))).statusCode).toBe(409);
    const early = fakePasskey().register({ challenge: "AAAA" }, ORIGIN, RP_ID);
    expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(early)))).statusCode).toBe(400);
    await proveEmail(h, mail, cookie);
    const created = await options(h, cookie);
    for (const tamper of [{ userVerified: false as const }, { origin: "https://evil.example.test" }, { rpId: "evil.example.test" }, { challenge: "Zm9yZ2Vk" }]) {
      const answer = await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(fakePasskey().register(created, ORIGIN, RP_ID, tamper))));
      expect(answer.statusCode, JSON.stringify(tamper)).toBe(400);
      expect(body(answer).message).toBe(PASSKEY_TEXT.failed);
    }
    expect([...h.db.items.values()].filter((item) => String(item.pk).startsWith("PASSKEYS#"))).toEqual([]);
    expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, "x".repeat(20_000)))).statusCode).toBe(400);
  });
});

describe("registering on a page that only signed in", () => {
  it("refuses to register a second passkey with a sign-in challenge (the passkey alone never adds another)", async () => {
    const { h, mail } = harness();
    await registered(h, mail);
    const cookie = await stepUpPage(h);
    const asked = await options(h, cookie);
    const second = await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(fakePasskey().register(asked, ORIGIN, RP_ID))));
    expect(second.statusCode).toBe(400);
    expect(await h.deps.store.listPasskeys(ownerKeyForSubject("https://slack.com", "U0MAYA001"))).toHaveLength(1);
    // Nor after the emailed code, while the page still holds the earlier sign-in challenge: a registration needs its own.
    await proveEmail(h, mail, cookie);
    const reused = await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(fakePasskey().register(asked, ORIGIN, RP_ID))));
    expect(reused.statusCode).toBe(400);
    expect(await h.deps.store.listPasskeys(ownerKeyForSubject("https://slack.com", "U0MAYA001"))).toHaveLength(1);
  });
});

describe("a passkey as the step-up", () => {
  it("lets one assertion counter win when two pages race with it", async () => {
    const { h, mail } = harness();
    const key = await registered(h, mail);
    const pages = [await stepUpPage(h), await stepUpPage(h)];
    const asked = await Promise.all(pages.map((cookie) => options(h, cookie)));
    const answers = await Promise.all(pages.map((cookie, index) => h.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(asked[index]!, ORIGIN, RP_ID, { counter: 1 }))))));
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 400]);
  });

  it("asks for the passkey on the next step-up (a live Slack session is still not enough) and puts passkey in the token", async () => {
    const { h, mail } = harness();
    const key = await registered(h, mail);
    h.tick(60_000);
    const cookie = await stepUpPage(h);
    const page = await h.http(browser("GET", "/v1/auth/step-up", cookie));
    expect(page.body).toContain(PASSKEY_TEXT.use);
    expect(page.body).toContain('data-mode="get"');
    const asked = await options(h, cookie);
    expect(asked.userVerification).toBe("required");
    const answer = await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(asked, ORIGIN, RP_ID))));
    expect(answer.statusCode).toBe(200);
    const claims = await tokenClaims(h, String(body(answer).location));
    expect(claims.step_up_amr).toBe("passkey");
    expect(claims.step_up_at).toBe(Math.floor(h.now() / 1000));
    expect(answer.cookies).toContain(`${STEP_UP_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  it("refuses a wrong origin, RP id, challenge, signature, an unverified user and a replayed counter, counting every try", async () => {
    const { h, mail } = harness();
    const key = await registered(h, mail);
    const cookie = await stepUpPage(h);
    const asked = await options(h, cookie);
    const tampers = [{ origin: "https://evil.example.test" }, { rpId: "evil.example.test" }, { challenge: "Zm9yZ2Vk" }, { otherKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey }];
    for (const tamper of tampers) {
      const answer = await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(asked, ORIGIN, RP_ID, tamper))));
      expect(answer.statusCode, Object.keys(tamper)[0]).toBe(400);
      expect(body(answer).message).toBe(PASSKEY_TEXT.failed);
      expect(body(answer)).not.toHaveProperty("location");
    }
    // The fifth try ends the page, even with a good answer.
    const last = await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(asked, ORIGIN, RP_ID, { userVerified: false }))));
    expect(body(last).message).toBe(STEP_UP_TEXT.tooManyTries);
    const late = await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(asked, ORIGIN, RP_ID))));
    expect(body(late)).not.toHaveProperty("location");
    expect(DEVELOPER_STEP_UP_ATTEMPTS_MAX).toBe(tampers.length + 1);
  });

  it("refuses an assertion whose counter did not move (a cloned or replayed passkey), and one unknown passkey", async () => {
    const { h, mail } = harness();
    const key = await registered(h, mail);
    const first = await stepUpPage(h);
    expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", first, JSON.stringify(key.assert(await options(h, first), ORIGIN, RP_ID))))).statusCode).toBe(200);
    const second = await stepUpPage(h);
    const stale = await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", second, JSON.stringify(key.assert(await options(h, second), ORIGIN, RP_ID, { counter: key.counter }))));
    expect(stale.statusCode).toBe(400);
    const stranger = fakePasskey();
    const unknown = await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", second, JSON.stringify(stranger.assert(await options(h, second), ORIGIN, RP_ID))));
    expect(unknown.statusCode).toBe(400);
  });

  it("refuses the passkey POSTs from another origin or with no page", async () => {
    const { h, mail } = harness();
    const key = await registered(h, mail);
    const cookie = await stepUpPage(h);
    const asked = await options(h, cookie);
    for (const origin of ["", "https://evil.example.test", "null"]) {
      expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/options", cookie, "{}", origin))).statusCode).toBe(403);
      expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(asked, ORIGIN, RP_ID)), origin))).statusCode).toBe(403);
    }
    expect((await h.http(browser("POST", "/v1/auth/step-up/passkey/options", undefined, "{}"))).statusCode).toBe(400);
  });

  it("is the only factor for a person with a passkey and no email sender, and the page then offers only the passkey", async () => {
    const { h, mail } = harness();
    const key = await registered(h, mail);
    const passkeyOnly = identityHarness({ slackUsers: [maya], stepUp: { passkeys: { rpId: RP_ID, rpName: "AgentX" } } });
    // Same records: copy the table across.
    for (const [k, v] of h.db.items) passkeyOnly.db.items.set(k, v);
    const cookie = await stepUpPage(passkeyOnly);
    const page = await passkeyOnly.http(browser("GET", "/v1/auth/step-up", cookie));
    expect(page.body).toContain(PASSKEY_TEXT.onlyPasskey);
    expect(page.body).not.toContain(STEP_UP_TEXT.send);
    const answer = await passkeyOnly.http(browser("POST", "/v1/auth/step-up/passkey/verify", cookie, JSON.stringify(key.assert(await options(passkeyOnly, cookie), ORIGIN, RP_ID))));
    expect(answer.statusCode).toBe(200);
  });
});
