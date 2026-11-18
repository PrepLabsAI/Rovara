// L4-MF4: GET /v1/dev/me/sign-in-factors. The signed-in person's OWN confirmation email (masked) and passkeys, for the Cloud account page. Real sign-in server,
// real broker route, two companies over one wire-level table. The caller is named ONLY by the verified token; nobody (an admin included) can read another person's factors.
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { AgentXError, DEVELOPER_PASSKEYS_MAX, ListSignInFactorsRequestSchema, SIGN_IN_LINK_TEXT } from "@agentx/contracts";
import { DEV_ROUTES, devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { routeDeveloperRequest } from "../../packages/broker/src/aws/developer-routes.js";
import { routeSignInFactors, signInLinksThroughLambda, type SignInLinkForward, type SignInLinkRequest } from "../../packages/broker/src/aws/sign-in-link-routes.js";
import { FACTOR_ADMIN_TEXT } from "../../packages/broker/src/developer/factor-admin.js";
import { B, X, person, sharedSignInWorld } from "../support/company-shared-signin-world.js";

const PATH = "/v1/dev/me/sign-in-factors";
const KEY = (id: string) => ({ credentialId: id, publicKey: `PUBLIC-KEY-BYTES-${id}`, counter: 41, createdAt: "2026-10-01T00:00:00.000Z", transports: ["internal"] });
type Api = { status: number; body: Record<string, unknown> };

async function world() {
  const w = sharedSignInWorld();
  const calls: unknown[] = [];
  const lambda = async (payload: Uint8Array) => {
    const event = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    calls.push(event);
    return { Payload: new TextEncoder().encode(JSON.stringify(await w.handler(event as never))) };
  };
  w.routes.developer.signInLinks = signInLinksThroughLambda(lambda);
  await w.setup();
  // carol: a plain member of X (pre-approved by email); bob: B's first admin (his own issuer).
  await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "member", expiresInHours: 24 });
  const carol = (await w.signIn("carol", { company: X })).access!;
  const bob = (await w.signIn("bob", { company: B })).access!;
  const owner = (await w.signIn("owner", { company: X })).access!;
  const sidOf = (token: string) => String(decodeJwt(token).sid);
  const api = async (token: string | undefined, path = PATH, method = "GET", extra: { body?: unknown; routes?: typeof w.routes } = {}): Promise<Api> => {
    const request = { method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, requestId: "r", ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(extra.routes ?? w.routes, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } };
    }
  };
  const withForward = (forward: SignInLinkForward | undefined) => ({ ...w.routes, developer: { ...w.routes.developer, ...(forward === undefined ? { signInLinks: undefined } : { signInLinks: forward }) } }) as typeof w.routes;
  const passkey = (token: string, id: string, extra: Record<string, unknown> = {}) => w.deps.store.addPasskey(String(decodeJwt(token).sub), { ...KEY(id), ...extra });
  const setEmail = (who: string, email: string | undefined) => {
    const { factorEmail: _old, ...rest } = w.db.get(`DEVELOPER#${who}`, "META")!;
    void _old;
    w.db.set(email === undefined ? rest : { ...rest, factorEmail: email });
  };
  return { ...w, calls, owner, carol, bob, sidOf, api, passkey, setEmail, withForward, ownerId: person("owner"), carolId: person("carol"), bobId: person("bob") };
}

describe("the person's own sign-in factors (GET /v1/dev/me/sign-in-factors)", () => {
  it("answers the caller's own masked confirmation email and passkeys, nothing else, and never a full address or key material", async () => {
    const w = await world();
    w.setEmail(w.ownerId, "owner.private@example.test");
    await w.passkey(w.owner, "key-one", { lastUsedAt: "2026-11-01T00:00:00.000Z" });
    await w.passkey(w.owner, "key-two");
    const answer = await w.api(w.owner);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      factorEmail: "o***@example.test",
      passkeys: expect.arrayContaining([
        { credentialId: "key-one", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: "2026-11-01T00:00:00.000Z" },
        { credentialId: "key-two", createdAt: "2026-10-01T00:00:00.000Z" },
      ]) as unknown,
    });
    expect((answer.body.passkeys as unknown[]).length).toBe(2);
    const text = JSON.stringify(answer.body);
    for (const leak of ["owner.private", "PUBLIC-KEY-BYTES", "publicKey", "counter", "transports", "41"]) expect(text, leak).not.toContain(leak);
  });

  it("omits the email when none is set (or it cannot be masked), and answers an empty list of passkeys", async () => {
    const w = await world();
    w.setEmail(w.ownerId, undefined);
    expect(await w.api(w.owner)).toEqual({ status: 200, body: { passkeys: [] } });
    w.setEmail(w.ownerId, "no-at-sign");
    expect(await w.api(w.owner)).toEqual({ status: 200, body: { passkeys: [] } });
    w.setEmail(w.ownerId, "@example.test");
    expect(await w.api(w.owner)).toEqual({ status: 200, body: { passkeys: [] } });
  });

  it("is the caller's only: each person (two companies) sees only their own factors, whatever the request names", async () => {
    const w = await world();
    for (const [who, mail] of [[w.ownerId, "owner@x.test"], [w.carolId, "carol@x.test"], [w.bobId, "bob@b.test"]] as const) w.setEmail(who, mail);
    await w.passkey(w.owner, "key-owner");
    await w.passkey(w.carol, "key-carol");
    await w.passkey(w.bob, "key-bob");
    const ids = (answer: Api) => (answer.body.passkeys as Array<{ credentialId: string }>).map((key) => key.credentialId);
    const mine = { owner: await w.api(w.owner), carol: await w.api(w.carol), bob: await w.api(w.bob) };
    expect([ids(mine.owner), ids(mine.carol), ids(mine.bob)]).toEqual([["key-owner"], ["key-carol"], ["key-bob"]]);
    expect([mine.owner.body.factorEmail, mine.carol.body.factorEmail, mine.bob.body.factorEmail]).toEqual(["o***@x.test", "c***@x.test", "b***@b.test"]);
    // The owner of X (an admin of the company) naming carol, bob, or their sessions, in the query, a header or a body, still reads only their own.
    w.calls.length = 0;
    for (const target of [w.carolId, w.bobId]) {
      const sneaky = await w.api(w.owner, `${PATH}?person=${target}&personDeveloperId=${target}&developerId=${target}&sessionId=${w.sidOf(w.carol)}`, "GET", { body: { developerId: target, sessionId: w.sidOf(w.bob), personDeveloperId: target } });
      expect(sneaky).toEqual(mine.owner);
    }
    expect(w.calls).toEqual([
      { kind: "list-sign-in-factors", developerId: w.ownerId, sessionId: w.sidOf(w.owner) },
      { kind: "list-sign-in-factors", developerId: w.ownerId, sessionId: w.sidOf(w.owner) },
    ]);
  });

  it("has no path to another person's factors: no member path, no id in the path, no other method (an admin included)", async () => {
    const w = await world();
    await w.passkey(w.carol, "key-carol");
    for (const [method, path] of [
      ["GET", `/v1/dev/company/members/${w.carolId}/sign-in-factors`],
      ["GET", `${PATH}/${w.carolId}`],
      ["GET", `/v1/dev/me/${w.carolId}/sign-in-factors`],
      ["POST", PATH], ["PUT", PATH], ["DELETE", PATH], ["PATCH", PATH],
    ] as const) {
      const answer = await w.api(w.owner, path, method, method === "GET" ? {} : { body: {} });
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(answer.body)).not.toContain("key-carol");
    }
    expect(w.calls).toEqual([]);
  });

  it("the sign-in Lambda event names only the caller: a session of another person, or a naming of another person, is refused", async () => {
    const w = await world();
    await w.passkey(w.carol, "key-carol");
    const event = (developerId: string, sessionId: string, extra: Record<string, unknown> = {}) => w.handler({ kind: "list-sign-in-factors", developerId, sessionId, ...extra } as never);
    // bob's session with carol's id (and X's person with B's session): signed out, nothing listed.
    expect(await event(w.carolId, w.sidOf(w.bob))).toEqual({ ok: false, error: "signed_out", message: FACTOR_ADMIN_TEXT.signedOut });
    expect(await event(w.bobId, w.sidOf(w.carol))).toEqual({ ok: false, error: "signed_out", message: FACTOR_ADMIN_TEXT.signedOut });
    // The request cannot name a second person at all (strict), and nothing is read for it.
    expect(await event(w.carolId, w.sidOf(w.owner), { personDeveloperId: w.carolId })).toEqual({ ok: false, error: "invalid_request", message: FACTOR_ADMIN_TEXT.invalid });
    expect(await event(w.carolId, w.sidOf(w.carol), { stepUpAt: 1 })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(ListSignInFactorsRequestSchema.safeParse({ kind: "list-sign-in-factors", developerId: w.carolId, sessionId: w.sidOf(w.carol), personDeveloperId: w.ownerId }).success).toBe(false);
    expect(await event(w.carolId, w.sidOf(w.carol))).toMatchObject({ ok: true, passkeys: [{ credentialId: "key-carol" }] });
  });

  it("masks in the sign-in Lambda: the reply it gives the broker never holds the full address", async () => {
    const w = await world();
    w.setEmail(w.ownerId, "Owner.Private@example.test");
    const reply = await w.handler({ kind: "list-sign-in-factors", developerId: w.ownerId, sessionId: w.sidOf(w.owner) } as never);
    expect(reply).toEqual({ ok: true, factorEmail: "O***@example.test", passkeys: [] });
    expect(JSON.stringify(reply)).not.toMatch(/wner\.Private/u);
  });

  it("a signed-out, revoked, ended or turned-off person is refused with fixed words and nothing is listed", async () => {
    const w = await world();
    await w.passkey(w.carol, "key-carol");
    expect((await w.api(w.carol)).status).toBe(200);
    // An admin's end of the person's sign-ins.
    const row = w.db.get(`DEVELOPER#${w.carolId}`, "META")!;
    w.db.set({ ...row, sessionsEndedAt: new Date(w.now() + 1_000).toISOString() });
    w.tick(2_000);
    const ended = await w.api(w.carol);
    expect(ended).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
    // The sign-in Lambda itself refuses the same session, in its fixed words.
    expect(await w.handler({ kind: "list-sign-in-factors", developerId: w.carolId, sessionId: w.sidOf(w.carol) } as never)).toEqual({ ok: false, error: "signed_out", message: FACTOR_ADMIN_TEXT.signedOut });
    expect(JSON.stringify(ended.body)).not.toContain("key-carol");
    // A revoked session.
    await w.deps.store.revokeSession(w.sidOf(w.bob), "signed_out");
    expect(await w.api(w.bob)).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
    expect(await w.handler({ kind: "list-sign-in-factors", developerId: w.bobId, sessionId: w.sidOf(w.bob) } as never)).toMatchObject({ ok: false, error: "signed_out" });
  });

  it("a token with no sign-in session (a registered service's own) never reaches the sign-in Lambda", async () => {
    const w = await world();
    const forwarded: unknown[] = [];
    const routes = w.withForward(async (request) => { forwarded.push(request); return { ok: true, passkeys: [] } as never; });
    routes.developer.verifyAccessToken = async () => ({ sub: w.ownerId, iss: w.routes.developer.issuer, aud: "svc", scope: "x" });
    const answer = await w.api("service-token", PATH, "GET", { routes });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(answer.body)).not.toContain("passkeys");
    expect(forwarded).toEqual([]);
  });

  it("the route itself refuses a caller with no sign-in session, before any forward", async () => {
    const forwarded: unknown[] = [];
    const forward: SignInLinkForward = async (request) => { forwarded.push(request); return { ok: true, passkeys: [] } as never; };
    const request = { method: "GET", path: PATH, headers: {}, requestId: "r" };
    await expect(routeSignInFactors(forward, { developerId: "a".repeat(64), sessionId: "" }, request, new URL(PATH, "https://broker.example.test"))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(forwarded).toEqual([]);
    // Any other method, or another path, is not this route (the route table already says so; this is the second wall).
    for (const [method, path] of [["POST", PATH], ["DELETE", PATH], ["GET", `${PATH}/x`]] as const) {
      await expect(routeSignInFactors(forward, { developerId: "a".repeat(64), sessionId: "b".repeat(32) }, { ...request, method }, new URL(path, "https://broker.example.test"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(forwarded).toEqual([]);
  });

  it("a turned-off person (revoked record) is refused by the sign-in Lambda and nothing is listed", async () => {
    const w = await world();
    await w.passkey(w.carol, "key-carol");
    w.db.set({ ...w.db.get(`DEVELOPER#${w.carolId}`, "META")!, revoked: true });
    expect(await w.handler({ kind: "list-sign-in-factors", developerId: w.carolId, sessionId: w.sidOf(w.carol) } as never)).toEqual({ ok: false, error: "signed_out", message: FACTOR_ADMIN_TEXT.signedOut });
  });

  it("the route needs full access: its row is full, and a token without it is refused before the sign-in Lambda", async () => {
    const w = await world();
    expect(DEV_ROUTES.filter((route) => route.path === PATH)).toEqual([{ method: "GET", path: PATH, requires: "full" }]);
    expect(devRouteOf("GET", PATH)?.requires).toBe("full");
    expect(devRouteOf("POST", PATH)).toBeUndefined();
    expect(devRouteOf("GET", `${PATH}/x`)).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  it("not set up here: a deployment with no sign-in Lambda forward answers a fixed 404", async () => {
    const w = await world();
    const answer = await w.api(w.owner, PATH, "GET", { routes: w.withForward(undefined) });
    expect(answer.status).toBe(404);
  });
});

describe("the broker reads the Lambda's reply strictly", () => {
  const reply = (body: Record<string, unknown>): SignInLinkForward => async () => body as never;
  const GOOD = { credentialId: "key-one", createdAt: "2026-10-01T00:00:00.000Z" };

  it("forwards exactly { kind, developerId, sessionId } from the token, nothing from the request", async () => {
    const w = await world();
    const seen: SignInLinkRequest[] = [];
    const routes = w.withForward(async (request) => { seen.push(request); return { ok: true, passkeys: [] } as never; });
    expect((await w.api(w.owner, `${PATH}?developerId=${w.carolId}`, "GET", { routes })).status).toBe(200);
    expect(seen).toEqual([{ kind: "list-sign-in-factors", developerId: w.ownerId, sessionId: w.sidOf(w.owner) }]);
  });

  it("strips anything the reply carries beyond the shape (key material, counters, other fields)", async () => {
    const w = await world();
    const routes = w.withForward(reply({ ok: true, factorEmail: "m***@example.test", secret: "S", passkeys: [{ ...GOOD, publicKey: "PUB", counter: 9, transports: ["usb"], lastUsedAt: "2026-11-01T00:00:00.000Z" }] }));
    expect(await w.api(w.owner, PATH, "GET", { routes })).toEqual({ status: 200, body: { factorEmail: "m***@example.test", passkeys: [{ ...GOOD, lastUsedAt: "2026-11-01T00:00:00.000Z" }] } });
  });

  it("a reply that does not read is a fixed 503 that echoes nothing: a full address, a half-masked one, too many passkeys, a bad id or time", async () => {
    const w = await world();
    const bad: Array<Record<string, unknown>> = [
      { ok: true, factorEmail: "maya@example.test", passkeys: [] },
      { ok: true, factorEmail: "m***ya@example.test", passkeys: [] },
      { ok: true, factorEmail: "m***@example.test, other@example.test", passkeys: [] },
      { ok: true, factorEmail: "m*** @example.test", passkeys: [] },
      { ok: true, factorEmail: 5, passkeys: [] },
      { ok: true, passkeys: Array.from({ length: DEVELOPER_PASSKEYS_MAX + 1 }, (_, index) => ({ ...GOOD, credentialId: `k${String(index)}` })) },
      { ok: true, passkeys: [{ ...GOOD, credentialId: "has space" }] },
      { ok: true, passkeys: [{ ...GOOD, credentialId: "a".repeat(513) }] },
      { ok: true, passkeys: [{ ...GOOD, createdAt: "yesterday" }] },
      { ok: true, passkeys: [{ ...GOOD, lastUsedAt: 7 }] },
      { ok: true, passkeys: "none" },
      { ok: true },
    ];
    for (const body of bad) {
      const answer = await w.api(w.owner, PATH, "GET", { routes: w.withForward(reply(body)) });
      expect(answer, JSON.stringify(body)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SIGN_IN_LINK_TEXT.unavailable } } });
    }
  });

  it("maps the Lambda's refusals to fixed words", async () => {
    const w = await world();
    const refusal = (error: string) => w.api(w.owner, PATH, "GET", { routes: w.withForward(reply({ ok: false, error, message: "SECRET WORDS maya@example.test" })) });
    expect(await refusal("signed_out")).toEqual({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: SIGN_IN_LINK_TEXT.signedOut } } });
    expect(await refusal("unavailable")).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SIGN_IN_LINK_TEXT.unavailable } } });
    expect(await refusal("invalid_request")).toMatchObject({ status: 400 });
    expect(await refusal("something_new")).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SIGN_IN_LINK_TEXT.unavailable } } });
    for (const error of ["signed_out", "unavailable", "invalid_request", "something_new"]) expect(JSON.stringify(await refusal(error))).not.toContain("SECRET");
  });

  it("an unreachable or faulting Lambda is a fixed 503", async () => {
    const w = await world();
    for (const invoke of [async () => { throw new Error("boom maya@example.test"); }, async () => ({ FunctionError: "Unhandled" }), async () => ({ Payload: new TextEncoder().encode("not json") })]) {
      const answer = await w.api(w.owner, PATH, "GET", { routes: w.withForward(signInLinksThroughLambda(invoke)) });
      expect(answer).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SIGN_IN_LINK_TEXT.unavailable } } });
    }
  });

  it("an older sign-in Lambda that answers passkeys without an email still reads (the field is simply absent)", async () => {
    const w = await world();
    expect(await w.api(w.owner, PATH, "GET", { routes: w.withForward(reply({ ok: true, passkeys: [GOOD] })) })).toEqual({ status: 200, body: { passkeys: [GOOD] } });
  });
});
