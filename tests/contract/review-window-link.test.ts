// A1-12 (3): the 30-day review window on the channel link page, /review/link/{code}. The page signs a browser in with authenticateDeveloperSessionId (developer-routes.ts:827-836, called from the
// `/review/link/` branch at developer-routes.ts:2575-2587), which is the review window plus authenticateSession. D1-3 deletes Code's own task page (DEC 254zzz511) and with it the page-level proof of that
// window (journey 15, tests/journeys/page.test.ts of lane A1-11); this link page and the PR-feedback page are the other users, and the PR-feedback page is deleted by D1 too (feedback-review-web.ts,
// D1-PLAN 2.1 item 6). So this is the proof that stays. Every case asserts what the page does TODAY; file:line in the comments. A contract test, not a journey: the link page needs no task and the
// journey world has no channel adapters (the link routes answer "channel adapters are not enabled").
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { issueLinkCode, linkedDeveloper } from "../../packages/broker/src/aws/channel-links.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../packages/broker/src/aws/web-session.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const ORIGIN = new URL(ISSUER).origin;
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const DAY_MS = 86_400_000;
const CSRF = "c".repeat(43);
/** A WhatsApp user each code is for: a link is once per actor, so each case uses its own. */
const actorOf = (last: number) => ({ channel: "whatsapp", tenant: "+14155550100", userId: `+91987654482${String(last)}` });
const ACTOR = actorOf(1);
const signer = localSigner();

let db: FakeDynamoDb;
let handler: AdminHandler;

async function request(method: string, path: string, options: { sessionId?: string; csrf?: boolean; body?: string } = {}) {
  const cookies = [options.sessionId === undefined ? undefined : `${SESSION_COOKIE}=${options.sessionId}`, options.csrf === true ? `${CSRF_COOKIE}=${CSRF}` : undefined].filter((cookie) => cookie !== undefined).join("; ");
  const response = await handler({ rawPath: path, routeKey: "ANY /review/{proxy+}", headers: { ...(cookies === "" ? {} : { cookie: cookies }), ...(method === "POST" ? { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" } : {}) },
    ...(options.body === undefined ? {} : { body: options.body }), requestContext: { requestId: "r", http: { method } } }) as { statusCode: number; headers?: Record<string, string>; body: string };
  return { status: response.statusCode, location: response.headers?.location, text: response.body };
}

/** A browser review sign-in as the sign-in service writes it (developer/server.ts:860-863): starts now, ends at `reviewExpiresAt` = `endsAt`, 30 days later. */
function reviewSession(fields: Record<string, unknown> = {}): string {
  const sessionId = randomUUID();
  const ends = Math.floor(Date.now() / 1000) + 30 * 86_400;
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId, amr: "oidc", startedAt: new Date().toISOString(), endsAt: ends, reviewExpiresAt: ends, ...fields });
  return sessionId;
}
const newCode = async (actor = ACTOR) => (await issueLinkCode({ documentClient: db, stateTableName: "state", now: Date.now }, actor)).code;
const linkedTo = (actor: typeof ACTOR) => linkedDeveloper({ documentClient: db, stateTableName: "state", now: Date.now }, actor);
const redirectOf = (reply: { status: number; location: string | undefined }) => [reply.status, reply.location];
const signInTo = (code: string) => `/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/link/${code}`)}`;
/** What the page shows a signed-in person: the confirmation naming the channel and the masked user (channel-link-web.ts:66-75). */
const CONFIRMATION = "Link your account";

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const linking: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker({ linking, channelAdapters: true }));
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://cognito.example.test", subject: "ada", displayName: "Ada", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
});
afterEach(() => { vi.useRealTimers(); });

describe("the channel link page's 30-day review window (developer-routes.ts:827-836)", () => {
  it("a review sign-in opens the page and links the account; 29 days and 23 hours on it still does; at 30 days the page sends the person to sign in and a confirmation is refused, nothing linked", async () => {
    // Signed out: the page redirects to sign in with the page kept (channel-link-web.ts:44-48); the confirmation answers 401 and links nothing.
    const first = await newCode();
    const signedOut = await request("GET", `/review/link/${first}`);
    expect([signedOut.status, signedOut.location]).toEqual([302, signInTo(first)]);
    expect(signedOut.text).not.toContain("+91");
    expect((await request("POST", `/review/link/${first}/confirm`, { csrf: true, body: `csrf=${CSRF}` })).status).toBe(401);
    // Signed in: the confirmation names the channel and the masked user (maskChannelUserId); confirming links this account, once.
    const session = reviewSession();
    const page = await request("GET", `/review/link/${first}`, { sessionId: session });
    expect(page.status).toBe(200);
    expect(page.text).toContain(CONFIRMATION);
    expect(page.text).toContain("whatsapp");
    expect(page.text).toContain("+91 ••• 4821");
    const linked = await request("POST", `/review/link/${first}/confirm`, { sessionId: session, csrf: true, body: `csrf=${CSRF}` });
    expect([linked.status, linked.text.includes("is linked to Ada")]).toEqual([200, true]);
    expect(await linkedTo(ACTOR)).toBe(developerId);
    // A new link code and the same session, 29 days and 23 hours later: the session is still inside its window, so the page opens (the code is a fresh one: a code itself lasts ten minutes).
    vi.setSystemTime(T0 + 29 * DAY_MS + 23 * 3_600_000);
    const second = await newCode(actorOf(2));
    expect((await request("GET", `/review/link/${second}`, { sessionId: session })).text, "29 days and 23 hours on").toContain(CONFIRMATION);
    // At 30 days the window has ended (developer-routes.ts:832 `reviewExpiresAt <= now`): the page is a signed-out page, and the confirmation is refused with the code still unused.
    vi.setSystemTime(T0 + 30 * DAY_MS);
    const third = await newCode(actorOf(3));
    const ended = await request("GET", `/review/link/${third}`, { sessionId: session });
    expect([ended.status, ended.location], "at 30 days").toEqual([302, signInTo(third)]);
    expect(ended.text).not.toContain("+91");
    const refused = await request("POST", `/review/link/${third}/confirm`, { sessionId: session, csrf: true, body: `csrf=${CSRF}` });
    expect(refused.status).toBe(401);
    expect(await linkedTo(actorOf(3)), "nothing was linked").toBeUndefined();
    // The same code, with a fresh sign-in, still works: the refusal spent nothing.
    expect((await request("GET", `/review/link/${third}`, { sessionId: reviewSession() })).text).toContain(CONFIRMATION);
    // The review window is its own field: a session whose record outlives it (endsAt 60 days, review window 30) is a signed-out page at 30 days, not at 29 (developer-routes.ts:832). Today's sign-in writes
    // the two as the same instant (developer/server.ts:860-863), so this is the check standing on its own.
    vi.setSystemTime(T0);
    const longRecord = reviewSession({ endsAt: Math.floor(Date.now() / 1000) + 60 * 86_400 });
    const fourth = await newCode(actorOf(4));
    expect((await request("GET", `/review/link/${fourth}`, { sessionId: longRecord })).text, "inside the window").toContain(CONFIRMATION);
    vi.setSystemTime(T0 + 30 * DAY_MS);
    const fifth = await newCode(actorOf(5));
    expect(redirectOf(await request("GET", `/review/link/${fifth}`, { sessionId: longRecord })), "the window ended, the record has not").toEqual([302, signInTo(fifth)]);
  });

  it("a revoked sign-in, a revoked person, a session with no review window and a cookie that is no session are signed out at once (authenticateDeveloperSessionId, authenticateSession); the person's other sign-in is not affected", async () => {
    const code = await newCode();
    const good = reviewSession();
    expect((await request("GET", `/review/link/${code}`, { sessionId: good })).text).toContain(CONFIRMATION);
    // A revoked session (the token endpoint's revoke, an admin ending it; developer-routes.ts:795 `revokedAt`).
    const revoked = reviewSession({ revokedAt: new Date().toISOString(), revokedReason: "admin" });
    expect(redirectOf(await request("GET", `/review/link/${code}`, { sessionId: revoked }))).toEqual([302, signInTo(code)]);
    expect((await request("GET", `/review/link/${code}`, { sessionId: good })).text, "the other sign-in").toContain(CONFIRMATION);
    // A session with no review window (a CLI or tool sign-in) never signs a browser in (developer-routes.ts:831-832); nor does a GitHub one (only a Slack or company sign-in has the page).
    const cli = randomUUID();
    db.set({ pk: `SESSION#${cli}`, sk: "META", sessionId: cli, developerId, amr: "oidc", startedAt: new Date().toISOString(), endsAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
    expect(redirectOf(await request("GET", `/review/link/${code}`, { sessionId: cli }))).toEqual([302, signInTo(code)]);
    expect(redirectOf(await request("GET", `/review/link/${code}`, { sessionId: reviewSession({ amr: "github" }) }))).toEqual([302, signInTo(code)]);
    // A cookie that is no session ID, and a session ID with no row.
    expect(redirectOf(await request("GET", `/review/link/${code}`, { sessionId: "not-a-session" }))).toEqual([302, signInTo(code)]);
    expect(redirectOf(await request("GET", `/review/link/${code}`, { sessionId: randomUUID() }))).toEqual([302, signInTo(code)]);
    // A revoked person is signed out whatever their session says (developer-routes.ts:813), and is let back when restored.
    const registration = db.get(`DEVELOPER#${developerId}`, "META")!;
    db.set({ ...registration, revoked: true });
    expect(redirectOf(await request("GET", `/review/link/${code}`, { sessionId: good }))).toEqual([302, signInTo(code)]);
    db.set(registration);
    expect((await request("GET", `/review/link/${code}`, { sessionId: good })).text, "restored").toContain(CONFIRMATION);
  });
});
