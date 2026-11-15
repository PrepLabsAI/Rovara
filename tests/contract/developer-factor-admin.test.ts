// ID-STEPUP-FOLLOWUPS (a) and (b): the factor email (where step-up codes go) and passkey management. The factor email is captured at the first sign-in and never moved by the provider's
// email afterwards; only a company admin, with their own fresh step-up, changes it, and the old address is told first. A person lists and removes their own passkeys (removing needs a fresh
// step-up); a company admin removes all of a person's passkeys (fresh step-up, person told). Ending sessions keeps passkeys.
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { DEVELOPER_STEP_UP_WINDOW_SECONDS } from "@agentx/contracts";
import { ownerKeyForSubject, type HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import { FACTOR_ADMIN_TEXT, createFactorAdmin } from "../../packages/broker/src/developer/factor-admin.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { STEP_UP_COOKIE, STEP_UP_TEXT, type StepUpEmailSender } from "../../packages/broker/src/developer/step-up.js";
import { API, ISSUER, authorizeQuery, httpEvent, identityHarness, type FakeSlackUser } from "../support/developer-fakes.js";
import { fakePasskey } from "../support/fake-passkey.js";

const ORIGIN = new URL(API).origin;
const RP_ID = new URL(API).hostname;
const idOf = (userId: string) => ownerKeyForSubject("https://slack.com", userId);
const MAYA = "U0MAYA001";
const ADMIN = "U0ADMIN01";
const OTHER = "U0OTHER01";

type Mail = { to: string; subject: string; text: string };
function mailbox(fail = false): StepUpEmailSender & { sent: Mail[]; failing: boolean } {
  const box = {
    sent: [] as Mail[], failing: fail,
    async send(message: Mail) {
      if (box.failing) throw Object.assign(new Error(`refused ${message.to}`), { name: "SendFailed" });
      box.sent.push(message);
    },
  };
  return box;
}
const codeIn = (text: string) => /\b([0-9]{6})\b/u.exec(text)?.[1] ?? "";
const cookieOf = (response: HttpResult) => response.cookies?.map((cookie) => new RegExp(`^${STEP_UP_COOKIE}=([^;]*);`).exec(cookie)?.[1]).find((value) => value !== undefined && value !== "");
function browser(method: "GET" | "POST", path: string, cookie: string | undefined, body?: Record<string, string> | string): HttpApiV2Event {
  const event = typeof body === "string" ? { ...httpEvent(method, path), body, isBase64Encoded: false } : httpEvent(method, path, body);
  return { ...event, headers: { ...event.headers, ...(typeof body === "string" ? { "content-type": "application/json" } : {}), ...(method === "GET" ? {} : { origin: ORIGIN }) }, ...(cookie === undefined ? {} : { cookies: [`${STEP_UP_COOKIE}=${cookie}`] }) };
}

function people(): Record<string, FakeSlackUser> {
  return {
    [MAYA]: { userId: MAYA, name: "Maya Chen", email: "maya@example.com" },
    [ADMIN]: { userId: ADMIN, name: "Ana Admin", email: "ana@example.com" },
    [OTHER]: { userId: OTHER, name: "Otto Other", email: "otto@example.com" },
  };
}

function harness(input: { admins?: string[]; passkeys?: boolean; mail?: ReturnType<typeof mailbox>; rule?: "none" | "throws"; users?: Record<string, FakeSlackUser> } = {}) {
  const mail = input.mail ?? mailbox();
  const users = input.users ?? people();
  const admins = new Set((input.admins ?? [ADMIN]).map(idOf));
  const asked: Array<[string, string]> = [];
  const companyAdmin = input.rule === "none" ? undefined : async (admin: string, person: string) => {
    asked.push([admin, person]);
    if (input.rule === "throws") throw new Error("rules service said maya@example.com");
    return admins.has(admin);
  };
  const h = identityHarness({
    slackUsers: Object.values(users),
    stepUp: { email: mail, ...(input.passkeys === true ? { passkeys: { rpId: RP_ID, rpName: "AgentX" } } : {}), ...(companyAdmin === undefined ? {} : { companyAdmin }) },
  });
  return { h, mail, users, asked };
}
type Harness = ReturnType<typeof harness>["h"];

async function plainSignIn(h: Harness, who: string): Promise<URL> {
  const start = await h.http(httpEvent("GET", authorizeQuery()));
  return new URL((await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, who)))).headers.location!);
}
const sidOf = async (h: Harness, location: URL) => String(decodeJwt(String((await h.exchange(location.searchParams.get("code")!)).body.access_token)).sid);
/** A session with no step-up. */
async function plainSession(h: Harness, who: string): Promise<string> {
  return sidOf(h, await plainSignIn(h, who));
}
/** Starts a step-up page for `who` (whose record already exists) and answers its cookie, or the refusal's location. */
async function stepUpPage(h: Harness, who: string): Promise<{ cookie?: string; location: string }> {
  const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up" })));
  const back = await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, who)));
  return { ...(cookieOf(back) === undefined ? {} : { cookie: cookieOf(back)! }), location: back.headers.location! };
}
/** A session whose step-up (by emailed code) is now. Signs `who` in the ordinary way first when `first`. */
async function freshSession(h: Harness, mail: ReturnType<typeof mailbox>, who: string, first = true): Promise<string> {
  if (first) await plainSignIn(h, who);
  const { cookie } = await stepUpPage(h, who);
  expect(cookie).toBeDefined();
  await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
  let answer = await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: codeIn(mail.sent.at(-1)!.text) }));
  if (answer.statusCode === 200) answer = await h.http(browser("POST", "/v1/auth/step-up/continue", cookie));
  expect(answer.statusCode).toBe(303);
  return sidOf(h, new URL(answer.headers.location!));
}
const invoke = async (h: Harness, event: Record<string, unknown>): Promise<unknown> => h.handler(event);
const factorEmailOf = async (h: Harness, who: string) => (await h.deps.store.getDeveloper(idOf(who)))?.factorEmail;
const setFactor = (h: Harness, sessionId: string, person: string, email: string, admin = ADMIN) =>
  invoke(h, { kind: "set-factor-email", developerId: idOf(admin), sessionId, personDeveloperId: idOf(person), email });

describe("the factor email", () => {
  it("is captured from the first sign-in's verified email, and a later provider email change neither moves it nor the codes", async () => {
    const { h, mail, users } = harness();
    await plainSignIn(h, MAYA);
    expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
    users[MAYA]!.email = "attacker@example.net";
    await plainSignIn(h, MAYA);
    // The record's email follows the provider; the factor email does not.
    expect((await h.deps.store.getDeveloper(idOf(MAYA)))?.email).toBe("attacker@example.net");
    expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
    const { cookie } = await stepUpPage(h, MAYA);
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    expect(mail.sent.map((message) => message.to)).toEqual(["maya@example.com"]);
    // Also inside the step-up's own round trip, the provider's email does not choose the inbox.
    users[MAYA]!.email = "other-attacker@example.net";
    const again = await stepUpPage(h, MAYA);
    await h.http(browser("POST", "/v1/auth/step-up/email", again.cookie));
    expect(mail.sent.map((message) => message.to)).toEqual(["maya@example.com", "maya@example.com"]);
  });

  it("is never captured on a later sign-in: someone whose first sign-in had no email, or a record from before, cannot step up by email until an admin sets one", async () => {
    const { h, mail, users } = harness();
    users[MAYA] = { userId: MAYA, name: "Maya Chen" };
    const h2 = harness({ users, mail }).h;
    await plainSignIn(h2, MAYA);
    users[MAYA].email = "maya@example.com";
    await plainSignIn(h2, MAYA);
    expect(await factorEmailOf(h2, MAYA)).toBeUndefined();
    const refused = new URL((await stepUpPage(h2, MAYA)).location);
    expect(refused.searchParams.get("error")).toBe("access_denied");
    expect(refused.searchParams.get("error_description")).toBe(STEP_UP_TEXT.noFactor);
    expect(STEP_UP_TEXT.noFactor).toContain("ask a company admin");
    // A record from before the factor email existed: an email, but no factor email.
    await plainSignIn(h, MAYA);
    h.db.items.forEach((item) => { if (item.pk === `DEVELOPER#${idOf(MAYA)}`) delete item.factorEmail; });
    expect(new URL((await stepUpPage(h, MAYA)).location).searchParams.get("error_description")).toBe(STEP_UP_TEXT.noFactor);
    expect(mail.sent).toEqual([]);
  });

  it("is set by a company admin with a fresh step-up; the old address is told first, and codes then go only to the new one", async () => {
    const { h, mail, asked } = harness();
    await plainSignIn(h, MAYA);
    const admin = await freshSession(h, mail, ADMIN);
    mail.sent.length = 0;
    const answer = await setFactor(h, admin, MAYA, "maya.new@example.org");
    expect(answer).toEqual({ ok: true, changed: true });
    expect(asked).toEqual([[idOf(ADMIN), idOf(MAYA)]]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("maya@example.com");
    expect(mail.sent[0]!.subject).toBe(FACTOR_ADMIN_TEXT.changedSubject);
    // The new address only masked in the notice; never in full, and never in a log.
    expect(mail.sent[0]!.text).toContain("m***@example.org");
    expect(mail.sent[0]!.text).not.toContain("maya.new@example.org");
    expect(JSON.stringify(h.logs)).not.toMatch(/maya(\.new)?@example\.(com|org)/u);
    const stored = await h.deps.store.getDeveloper(idOf(MAYA));
    expect(stored?.factorEmail).toBe("maya.new@example.org");
    expect(stored?.factorEmailSetBy).toBe(idOf(ADMIN));
    const { cookie } = await stepUpPage(h, MAYA);
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    expect(mail.sent.at(-1)!.to).toBe("maya.new@example.org");
    // The same address again changes nothing and tells nobody.
    const sent = mail.sent.length;
    expect(await setFactor(h, admin, MAYA, "Maya.New@example.org")).toEqual({ ok: true, changed: false });
    expect(mail.sent).toHaveLength(sent);
  });

  it("can be set for someone who has none (no old address to tell), and they can then step up", async () => {
    const { h, mail, users } = harness();
    users[MAYA] = { userId: MAYA, name: "Maya Chen" };
    const h2 = harness({ users, mail }).h;
    await plainSignIn(h2, MAYA);
    const admin = await freshSession(h2, mail, ADMIN);
    mail.sent.length = 0;
    expect(await setFactor(h2, admin, MAYA, "maya@example.com")).toEqual({ ok: true, changed: true });
    expect(mail.sent).toEqual([]);
    expect((await stepUpPage(h2, MAYA)).location).toBe(`${ISSUER}/step-up`);
    void h;
  });

  it("cannot be changed by someone who is not a company admin over that person, even with a fresh step-up", async () => {
    const { h, mail } = harness({ admins: [ADMIN] });
    await plainSignIn(h, MAYA);
    const other = await freshSession(h, mail, OTHER);
    mail.sent.length = 0;
    const answer = await setFactor(h, other, MAYA, "otto@example.com", OTHER);
    expect(answer).toEqual({ ok: false, error: "forbidden", message: FACTOR_ADMIN_TEXT.forbidden });
    expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
    expect(mail.sent).toEqual([]);
  });

  it("refuses a stale step-up, a session with none, someone else's session, a revoked or admin-ended session, and asks the admin rule only once the step-up is fresh", async () => {
    const { h, mail, asked } = harness();
    await plainSignIn(h, MAYA);
    const admin = await freshSession(h, mail, ADMIN);
    h.tick((DEVELOPER_STEP_UP_WINDOW_SECONDS + 1) * 1000);
    expect(await setFactor(h, admin, MAYA, "x@example.org")).toEqual({ ok: false, error: "reauth", message: FACTOR_ADMIN_TEXT.reauth });
    const plain = await plainSession(h, ADMIN);
    expect(await setFactor(h, plain, MAYA, "x@example.org")).toMatchObject({ ok: false, error: "reauth" });
    expect(asked).toEqual([]);
    // At exactly the window it still counts.
    const edge = await freshSession(h, mail, ADMIN, false);
    h.tick(DEVELOPER_STEP_UP_WINDOW_SECONDS * 1000);
    mail.sent.length = 0;
    expect(await setFactor(h, edge, MAYA, "edge@example.org")).toMatchObject({ ok: true, changed: true });
    // A fresh session named with another person's developer id is not theirs.
    const fresh = await freshSession(h, mail, ADMIN, false);
    expect(await setFactor(h, fresh, MAYA, "y@example.org", MAYA)).toMatchObject({ ok: false, error: "signed_out" });
    await h.deps.store.revokeSession(fresh, "signed_out");
    expect(await setFactor(h, fresh, MAYA, "y@example.org")).toMatchObject({ ok: false, error: "signed_out" });
    const ended = await freshSession(h, mail, ADMIN, false);
    h.tick(1000);
    await h.deps.store.endSessions(idOf(ADMIN), new Date(h.now()).toISOString());
    expect(await setFactor(h, ended, MAYA, "y@example.org")).toMatchObject({ ok: false, error: "signed_out" });
    expect(await factorEmailOf(h, MAYA)).toBe("edge@example.org");
  });

  it("refuses a step-up time from the future past the skew, and a method that is not one of Code's factors", async () => {
    const { h, mail } = harness();
    await plainSignIn(h, MAYA);
    const admin = await freshSession(h, mail, ADMIN);
    const row = [...h.db.items.values()].find((item) => item.pk === `SESSION#${admin}`)!;
    row.stepUpAt = Math.floor(h.now() / 1000) + 61;
    expect(await setFactor(h, admin, MAYA, "x@example.org")).toMatchObject({ error: "reauth" });
    row.stepUpAt = Math.floor(h.now() / 1000) + 60;
    row.stepUpMethod = "slack";
    expect(await setFactor(h, admin, MAYA, "x@example.org")).toMatchObject({ error: "reauth" });
    row.stepUpMethod = "email_code";
    expect(await setFactor(h, admin, MAYA, "x@example.org")).toMatchObject({ ok: true });
  });

  it("is refused, and left as it was, when the old address cannot be told: a failed send, or no sender", async () => {
    const mail = mailbox();
    const { h } = harness({ mail });
    await plainSignIn(h, MAYA);
    const admin = await freshSession(h, mail, ADMIN);
    mail.failing = true;
    expect(await setFactor(h, admin, MAYA, "x@example.org")).toEqual({ ok: false, error: "notice_failed", message: FACTOR_ADMIN_TEXT.noticeFailed });
    expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
    expect(JSON.stringify(h.logs)).not.toContain("refused maya");
    // An install with no sender (its admin stepped up another way) cannot tell the old address either.
    const noSender = createFactorAdmin({ env: "staging", store: h.deps.store, email: undefined, companyAdmin: async () => true, now: h.now, log: () => undefined });
    expect(await noSender.setFactorEmail({ kind: "set-factor-email", developerId: idOf(ADMIN), sessionId: admin, personDeveloperId: idOf(MAYA), email: "x@example.org" }))
      .toEqual({ ok: false, error: "not_set_up", message: FACTOR_ADMIN_TEXT.noSender });
    expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
  });

  it("is refused without the install's admin rule, and unavailable when the rule fails (its words never echoed)", async () => {
    for (const rule of ["none", "throws"] as const) {
      const { h, mail } = harness({ rule });
      await plainSignIn(h, MAYA);
      const admin = await freshSession(h, mail, ADMIN);
      const answer = await setFactor(h, admin, MAYA, "x@example.org");
      expect(answer).toMatchObject(rule === "none" ? { ok: false, error: "not_set_up" } : { ok: false, error: "unavailable", message: FACTOR_ADMIN_TEXT.unavailable });
      expect(JSON.stringify(answer)).not.toContain("example.com");
      expect(JSON.stringify(h.logs)).not.toContain("rules service said");
      expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
    }
  });

  it("ends a step-up page started before the change: no code goes to the old address, and a code sent there before no longer works", async () => {
    const { h, mail } = harness();
    await plainSignIn(h, MAYA);
    const admin = await freshSession(h, mail, ADMIN);
    const before = await stepUpPage(h, MAYA);
    await h.http(browser("POST", "/v1/auth/step-up/email", before.cookie));
    const oldCode = codeIn(mail.sent.at(-1)!.text);
    const pending = await stepUpPage(h, MAYA);
    expect(await setFactor(h, admin, MAYA, "maya.new@example.org")).toMatchObject({ ok: true });
    const sent = mail.sent.length;
    expect((await h.http(browser("POST", "/v1/auth/step-up/email", pending.cookie))).statusCode).toBe(400);
    expect(mail.sent).toHaveLength(sent);
    const late = await h.http(browser("POST", "/v1/auth/step-up/verify", before.cookie, { code: oldCode }));
    expect(late.statusCode).toBe(400);
    expect(late.headers.location).toBeUndefined();
  });

  it("is changed only from the value the admin's change read: a change that crossed another is refused", async () => {
    const { h } = harness();
    await plainSignIn(h, MAYA);
    expect(await h.deps.store.setFactorEmail(idOf(MAYA), "x@example.org", "someone-else@example.com", idOf(ADMIN))).toBe(false);
    expect(await h.deps.store.setFactorEmail(idOf(MAYA), "x@example.org", undefined, idOf(ADMIN))).toBe(false);
    expect(await factorEmailOf(h, MAYA)).toBe("maya@example.com");
    expect(await h.deps.store.setFactorEmail(idOf(MAYA), "x@example.org", "maya@example.com", idOf(ADMIN))).toBe(true);
    expect(await h.deps.store.setFactorEmail(idOf(OTHER), "x@example.org", undefined, idOf(ADMIN))).toBe(false);
  });

  it("refuses malformed requests with fixed words", async () => {
    const { h, mail } = harness();
    await plainSignIn(h, MAYA);
    const admin = await freshSession(h, mail, ADMIN);
    for (const event of [
      { kind: "set-factor-email", developerId: idOf(ADMIN), sessionId: admin, personDeveloperId: idOf(MAYA), email: "not an email" },
      { kind: "set-factor-email", developerId: idOf(ADMIN), sessionId: admin, personDeveloperId: idOf(MAYA), email: "a@example.org", stepUpAt: 1 },
      { kind: "set-factor-email", developerId: idOf(ADMIN), sessionId: "nope", personDeveloperId: idOf(MAYA), email: "a@example.org" },
    ]) expect(await invoke(h, event)).toEqual({ ok: false, error: "invalid_request", message: FACTOR_ADMIN_TEXT.invalid });
    expect(await setFactor(h, admin, "U0NOBODY1", "a@example.org")).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("passkeys: the person's own list and removal, and an admin's removal", () => {
  async function withPasskey(h: Harness, mail: ReturnType<typeof mailbox>, who: string) {
    await plainSignIn(h, who);
    const { cookie } = await stepUpPage(h, who);
    await h.http(browser("POST", "/v1/auth/step-up/email", cookie));
    await h.http(browser("POST", "/v1/auth/step-up/verify", cookie, { code: codeIn(mail.sent.at(-1)!.text) }));
    const options = JSON.parse((await h.http(browser("POST", "/v1/auth/step-up/passkey/options", cookie, "{}"))).body) as { options: { challenge: string } };
    const key = fakePasskey();
    const made = await h.http(browser("POST", "/v1/auth/step-up/passkey/register", cookie, JSON.stringify(key.register(options.options, ORIGIN, RP_ID))));
    expect(made.statusCode).toBe(200);
    return { key, sessionId: await sidOf(h, new URL(String((JSON.parse(made.body) as { location: string }).location))) };
  }

  it("lists the person's own passkeys with a live session, and refuses a session that is not theirs or not live", async () => {
    const { h, mail } = harness({ passkeys: true });
    const { key, sessionId } = await withPasskey(h, mail, MAYA);
    h.tick((DEVELOPER_STEP_UP_WINDOW_SECONDS + 5) * 1000);
    const listed = await invoke(h, { kind: "list-passkeys", developerId: idOf(MAYA), sessionId });
    expect(listed).toEqual({ ok: true, passkeys: [{ credentialId: key.id, createdAt: new Date(h.now() - (DEVELOPER_STEP_UP_WINDOW_SECONDS + 5) * 1000).toISOString() }] });
    expect(JSON.stringify(listed)).not.toContain("publicKey");
    expect(await invoke(h, { kind: "list-passkeys", developerId: idOf(ADMIN), sessionId })).toMatchObject({ ok: false, error: "signed_out" });
    await h.deps.store.revokeSession(sessionId, "signed_out");
    expect(await invoke(h, { kind: "list-passkeys", developerId: idOf(MAYA), sessionId })).toMatchObject({ ok: false, error: "signed_out" });
  });

  it("removes one of the person's own passkeys only with a fresh step-up; the next step-up then offers no passkey", async () => {
    const { h, mail } = harness({ passkeys: true });
    const { key, sessionId } = await withPasskey(h, mail, MAYA);
    const remove = (sid: string) => invoke(h, { kind: "remove-passkey", developerId: idOf(MAYA), sessionId: sid, credentialId: key.id });
    h.tick((DEVELOPER_STEP_UP_WINDOW_SECONDS + 1) * 1000);
    expect(await remove(sessionId)).toEqual({ ok: false, error: "reauth", message: FACTOR_ADMIN_TEXT.reauth });
    expect(await remove(await plainSession(h, MAYA))).toMatchObject({ error: "reauth" });
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toHaveLength(1);
    const fresh = await freshSession(h, mail, MAYA, false);
    expect(await remove(fresh)).toEqual({ ok: true });
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toEqual([]);
    expect(await remove(fresh)).toMatchObject({ ok: false, error: "not_found" });
    const { cookie } = await stepUpPage(h, MAYA);
    expect((await h.http(browser("GET", "/v1/auth/step-up", cookie))).body).not.toContain('data-mode="get"');
  });

  it("never removes another person's passkey through the person's own removal", async () => {
    const { h, mail } = harness({ passkeys: true });
    const maya = await withPasskey(h, mail, MAYA);
    const fresh = await freshSession(h, mail, OTHER);
    expect(await invoke(h, { kind: "remove-passkey", developerId: idOf(OTHER), sessionId: fresh, credentialId: maya.key.id })).toMatchObject({ ok: false, error: "not_found" });
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toHaveLength(1);
  });

  it("lets a company admin with a fresh step-up remove all of a person's passkeys, and tells the person", async () => {
    const { h, mail, asked } = harness({ passkeys: true });
    await withPasskey(h, mail, MAYA);
    await h.deps.store.addPasskey(idOf(MAYA), { credentialId: "second-key", publicKey: "AA", counter: 0, createdAt: new Date(h.now()).toISOString() });
    const admin = await freshSession(h, mail, ADMIN);
    mail.sent.length = 0;
    const answer = await invoke(h, { kind: "remove-person-passkeys", developerId: idOf(ADMIN), sessionId: admin, personDeveloperId: idOf(MAYA) });
    expect(answer).toEqual({ ok: true, removed: 2, notified: true });
    expect(asked).toContainEqual([idOf(ADMIN), idOf(MAYA)]);
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toEqual([]);
    expect(mail.sent).toEqual([expect.objectContaining({ to: "maya@example.com", subject: FACTOR_ADMIN_TEXT.removedSubject })]);
    // A failed notice does not undo the removal, and the answer says so.
    await h.deps.store.addPasskey(idOf(MAYA), { credentialId: "third-key", publicKey: "AA", counter: 0, createdAt: new Date(h.now()).toISOString() });
    mail.failing = true;
    expect(await invoke(h, { kind: "remove-person-passkeys", developerId: idOf(ADMIN), sessionId: admin, personDeveloperId: idOf(MAYA) })).toEqual({ ok: true, removed: 1, notified: false });
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toEqual([]);
  });

  it("refuses a non-admin, a stale admin step-up and an admin with no step-up, removing nothing", async () => {
    const { h, mail } = harness({ passkeys: true });
    await withPasskey(h, mail, MAYA);
    const remove = (developer: string, sid: string) => invoke(h, { kind: "remove-person-passkeys", developerId: idOf(developer), sessionId: sid, personDeveloperId: idOf(MAYA) });
    expect(await remove(OTHER, await freshSession(h, mail, OTHER))).toMatchObject({ ok: false, error: "forbidden" });
    const admin = await freshSession(h, mail, ADMIN);
    h.tick((DEVELOPER_STEP_UP_WINDOW_SECONDS + 1) * 1000);
    expect(await remove(ADMIN, admin)).toMatchObject({ ok: false, error: "reauth" });
    expect(await remove(ADMIN, await plainSession(h, ADMIN))).toMatchObject({ ok: false, error: "reauth" });
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toHaveLength(1);
  });

  it("keeps a person's passkeys when an admin ends their sessions", async () => {
    const { h, mail } = harness({ passkeys: true });
    await withPasskey(h, mail, MAYA);
    h.tick(1000);
    expect(await invoke(h, { kind: "end-developer-sessions", developerId: idOf(MAYA), at: new Date(h.now()).toISOString() })).toEqual({ ok: true });
    expect(await h.deps.store.listPasskeys(idOf(MAYA))).toHaveLength(1);
  });

  it("removes every row of a person, and refuses rather than answer a partial removal past the cap", async () => {
    const { h } = harness({ passkeys: true });
    await plainSignIn(h, MAYA);
    for (let index = 0; index < 101; index += 1) await h.deps.store.addPasskey(idOf(MAYA), { credentialId: `k${String(index)}`, publicKey: "AA", counter: 0, createdAt: "2026-01-01T00:00:00.000Z" });
    await expect(h.deps.store.removeAllPasskeys(idOf(MAYA))).rejects.toThrow();
    for (let index = 0; index < 30; index += 1) await h.deps.store.addPasskey(idOf(OTHER), { credentialId: `o${String(index)}`, publicKey: "AA", counter: 0, createdAt: "2026-01-01T00:00:00.000Z" });
    expect(await h.deps.store.removeAllPasskeys(idOf(OTHER))).toBe(30);
  });
});
