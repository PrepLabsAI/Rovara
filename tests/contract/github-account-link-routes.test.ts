// L4-GH: "Connect your GitHub" (a member links their own GitHub account to themselves), through the real developer dispatcher, the real link store (memory document store), the sign-in table's
// memberships and the real App client's user authorization over a fake GitHub (its fetch seam). Two companies throughout. The person is the caller's live membership; the account is what GitHub
// says for the code; every refusal before the GitHub check is one answer.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { LINK_HAS_ANOTHER, LINK_NOT_SET_UP, LINK_STEP_UP, LINK_TAKEN, START_AGAIN, githubAccountKey, githubAuditPk, githubPersonKey } from "../../packages/broker/src/aws/github-account-link-routes.js";
import { githubLinkOf, linkedGithubPerson } from "../../packages/broker/src/core/people/github-links.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW0 = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const ADA = "a".repeat(64), BEA = "b".repeat(64), CAL = "c".repeat(64), DEE = "d".repeat(64);
const SESSIONS: Record<string, string> = { [ADA]: "s-ada", [BEA]: "s-bea", [CAL]: "s-cal", [DEE]: "s-dee" };
// Built at run time (public push protection refuses key-shaped literals).
const CLIENT_SECRET = ["client", "secret", "canary"].join("-");
const tokenFor = (name: string) => ["ghu", `${name.replace(/[^A-Za-z0-9]/g, "")}0123456789abcdefghij`].join("_");
const uniform = { code: "FORBIDDEN", message: START_AGAIN };

interface GitHubUser { id: number; login: string }

function fakeGithub(users: Record<string, GitHubUser>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const used = new Set<string>();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; requests.push({ url, ...(init === undefined ? {} : { init }) });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const code = form.get("code") ?? "";
      if (form.get("client_secret") !== CLIENT_SECRET || form.get("client_id") !== "Iv1.client" || used.has(code) || users[code] === undefined) return json({ error: "bad_verification_code" });
      used.add(code);
      return json({ access_token: tokenFor(code), token_type: "bearer", scope: "" });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const code = Object.keys(users).find((key) => auth === `Bearer ${tokenFor(key)}`);
    if (code === undefined) return json({ message: "Bad credentials" }, 401);
    if (url === "https://api.github.com/user") return json(users[code]);
    return json({ message: "Not Found" }, 404);
  });
  return { fetch, requests };
}

type Answer = Record<string, unknown> & { error: { code: string; message: string } };

function world(users: Record<string, GitHubUser> = {
  "ada-code": { id: 7, login: "ada-lovelace" }, "bea-code": { id: 8, login: "bea" }, "cal-code": { id: 9, login: "cal" }, "ada-2": { id: 70, login: "ada-two" }, "ada-2b": { id: 70, login: "ada-two" }, "same-as-ada": { id: 7, login: "ada-lovelace" },
}) {
  const db = new FakeDynamoDb({ seed: 17 });
  let now = NOW0;
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADA, sid: SESSIONS[ADA], amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
  for (const [id, name] of [[ADA, "Ada"], [BEA, "Bea"], [CAL, "Cal"], [DEE, "Dee"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false });
    db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW0 - 60_000).toISOString(), endsAt: NOW0 / 1000 + 86_400 });
  }
  db.set({ pk: "SESSION#s-ada-2", sk: "META", sessionId: "s-ada-2", developerId: ADA, amr: "slack", clientId: "web-app", startedAt: new Date(NOW0 - 60_000).toISOString(), endsAt: NOW0 / 1000 + 86_400 });
  join(ADA, A, "member"); join(BEA, A, "member"); join(CAL, A, "admin"); join(DEE, B, "member");
  const store = new MemoryDocumentStore();
  const github = fakeGithub(users);
  const client = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "4242", getPrivateKey: async () => "unused",
    getAppSecret: async () => JSON.stringify({ slug: "rovara-test", clientId: "Iv1.client", clientSecret: CLIENT_SECRET }), fetchImplementation: github.fetch, now: () => now });
  const logs: Array<Record<string, unknown>> = [];
  let seed = 0;
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => now, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      githubLink: { store, github: client, log: (entry) => logs.push(entry), random: () => Buffer.alloc(32, ++seed) },
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try {
      const value = await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown>;
      return { status: 200, body: value as Answer, raw: JSON.stringify(value) };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      const body = { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as unknown as Answer;
      return { status: error.statusCode, body, raw: JSON.stringify(body) };
    }
  };
  const as = (id: string, sid = SESSIONS[id]!) => { claims.sub = id; claims.sid = sid; };
  const stepUp = (age = 30, method = "passkey") => { claims.step_up_at = Math.floor((now - age * 1000) / 1000); claims.step_up_amr = method; };
  const noStepUp = () => { delete claims.step_up_at; delete claims.step_up_amr; };
  stepUp();
  const start = () => call("POST", "/v1/dev/me/github/link", {});
  const claim = (body: Record<string, unknown>) => call("POST", "/v1/dev/me/github/link/claim", body);
  const read = () => call("GET", "/v1/dev/me/github");
  const unlink = (body?: unknown) => call("DELETE", "/v1/dev/me/github", body);
  const startState = async () => (await start()).body.state as string;
  /** One whole link as the signed-in person: start, then claim with the GitHub code. */
  const link = async (code: string) => claim({ state: await startState(), code });
  return { db, store, github, logs, deps, claims, as, stepUp, noStepUp, call, start, claim, read, unlink, startState, link, tick: (ms: number) => { now += ms; } };
}
type World = ReturnType<typeof world>;

const linkedPerson = (w: World, company: string, githubUserId: string) => linkedGithubPerson(w.store, company, githubUserId);

describe("start", () => {
  it("a member with a fresh step-up gets a single-use state stored only as its hash, and GitHub's authorize address", async () => {
    const w = world();
    const answer = await w.start();
    expect(answer.status).toBe(200);
    const state = answer.body.state as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.body.authorizeUrl).toBe(`https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${state}`);
    expect(answer.body.expiresAt).toBe(new Date(NOW0 + 600_000).toISOString());
    const stored = await w.store.get({ pk: `GITHUB_LINK_STATE#${createHash("sha256").update(state).digest("hex")}`, sk: "META" });
    expect(stored).toMatchObject({ companyId: A, personId: ADA, sessionId: "s-ada", provider: "github-link", status: "live" });
    // The state is never kept in the clear, and it is not in the install flow's key family.
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(await w.store.get({ pk: `GITHUB_CONNECT#${createHash("sha256").update(state).digest("hex")}`, sk: "META" })).toBeUndefined();
    expect(JSON.stringify(answer.body)).not.toContain(CLIENT_SECRET);
  });
  it("any member may start (no admin role needed): their own account is every member's to link", async () => {
    const w = world();
    for (const [id, expected] of [[ADA, 200], [BEA, 200], [CAL, 200], [DEE, 200]] as const) { w.as(id); expect((await w.start()).status).toBe(expected); }
  });
  it("needs a fresh step-up from a factor Code owns: none, an old one and a Slack one are refused, minting nothing", async () => {
    for (const set of [(w: World) => w.noStepUp(), (w: World) => w.stepUp(601), (w: World) => w.stepUp(30, "slack")]) {
      const w = world(); set(w);
      const put = vi.spyOn(w.store, "put");
      const answer = await w.start();
      expect(answer.status).toBe(403); expect(answer.body.error).toEqual({ code: "REAUTH_REQUIRED", message: LINK_STEP_UP });
      expect(put).not.toHaveBeenCalled();
    }
  });
  it("is unknown without the company layer or the wiring, before anyone is authenticated", async () => {
    for (const off of ["companies", "wiring"]) {
      const w = world();
      if (off === "companies") delete w.deps.companies; else delete w.deps.developer.githubLink;
      const verify = vi.spyOn(w.deps.developer, "verifyAccessToken");
      for (const answer of [await w.start(), await w.read(), await w.claim({}), await w.unlink()]) expect(answer.status).toBe(404);
      expect(verify).not.toHaveBeenCalled();
    }
  });
  it("refuses a body (no company, no person, no account from the browser) and an App with no OAuth client", async () => {
    const w = world();
    const body = await w.call("POST", "/v1/dev/me/github/link", { companyId: B, personId: BEA });
    expect(body.status).toBe(400); expect(body.raw).not.toContain(B);
    const wiring = w.deps.developer.githubLink!;
    wiring.github = { ...wiring.github, oauthClient: async () => undefined };
    const off = await w.start();
    expect(off.status).toBe(503); expect(off.body.error.message).toBe(LINK_NOT_SET_UP);
  });
  it("a person with no membership, and a token with no sign-in session, are refused", async () => {
    const w = world(); w.db.delete(membershipKey(ADA).pk, membershipKey(ADA).sk);
    expect((await w.start()).status).toBe(401);
    expect((await w.read()).status).toBe(401);
  });
});

describe("claim: the person links the account GitHub says is theirs, to themselves", () => {
  it("links the account GitHub names for the code, with the caller as the person, and nothing else is kept", async () => {
    const w = world();
    const answer = await w.link("ada-code");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "linked", alreadyLinked: false, githubUser: { id: 7, login: "ada-lovelace" } });
    expect(await linkedPerson(w, A, "7")).toBe(ADA);
    expect(await githubLinkOf(w.store, A, ADA)).toEqual({ accountId: "7", login: "ada-lovelace", linkedAt: new Date(NOW0).toISOString() });
    expect(await w.store.get(githubAccountKey(A, "7"))).toMatchObject({ companyId: A, personId: ADA, githubUserId: "7", login: "ada-lovelace" });
    expect(await w.store.get(githubPersonKey(A, ADA))).toMatchObject({ companyId: A, personId: ADA, githubUserId: "7" });
    // GitHub's user token and the code are never kept or logged or returned.
    const everything = JSON.stringify([await w.store.query({ pk: githubAccountKey(A, "7").pk }), await w.store.query({ pk: githubPersonKey(A, ADA).pk }), w.logs, answer.raw]);
    expect(everything).not.toContain(tokenFor("ada-code")); expect(everything).not.toContain("ada-code"); expect(everything).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(w.logs)).not.toContain("ada-lovelace");
    expect(w.logs).toEqual([expect.objectContaining({ event: "github.account_linked", actor: ADA })]);
  });
  it("only GitHub's `GET /user` is read: no installation or organization", async () => {
    const w = world(); await w.link("ada-code");
    expect(w.github.requests.map((entry) => entry.url)).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
  });
  it("the read shows the caller's own link, and another member's link is not theirs to read", async () => {
    const w = world();
    expect((await w.read()).body).toMatchObject({ linked: false });
    await w.link("ada-code");
    expect((await w.read()).body).toMatchObject({ linked: true, login: "ada-lovelace", linkedAt: new Date(NOW0).toISOString() });
    w.as(BEA);
    expect((await w.read()).body).toMatchObject({ linked: false });
    expect((await w.read()).raw).not.toContain("ada-lovelace");
  });
  it("a body that names a person, a company or an account is refused as one answer; GitHub is not asked", async () => {
    const w = world();
    const state = await w.startState();
    for (const extra of [{ personId: BEA }, { companyId: B }, { githubUserId: "8" }, { login: "bea" }]) {
      const answer = await w.claim({ state, code: "ada-code", ...extra });
      expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform);
    }
    expect(w.github.requests).toHaveLength(0);
    expect(await linkedPerson(w, A, "7")).toBeUndefined();
  });
  it("the account is GitHub's answer: a different person's code links that other account to the CALLER, never the caller's own number", async () => {
    // Bea's browser carries Ada's state? No: the state is the caller's. Here the caller (Ada) completes GitHub as GitHub account 8: account 8 is linked to Ada, nothing else.
    const w = world();
    const answer = await w.link("bea-code");
    expect(answer.body).toMatchObject({ githubUser: { id: 8 } });
    expect(await linkedPerson(w, A, "8")).toBe(ADA);
    expect(await linkedPerson(w, A, "7")).toBeUndefined();
  });
  it("another member cannot claim an account that is already linked: 409, nothing changed", async () => {
    const w = world(); await w.link("ada-code");
    w.as(BEA);
    const answer = await w.link("same-as-ada");
    expect(answer.status).toBe(409); expect(answer.body.error).toEqual({ code: "GITHUB_ACCOUNT_TAKEN", message: LINK_TAKEN });
    expect(await linkedPerson(w, A, "7")).toBe(ADA);
    expect(await githubLinkOf(w.store, A, BEA)).toBeUndefined();
  });
  it("the same person linking the same account again is idempotent; a second, different account is refused until they unlink", async () => {
    const w = world(); await w.link("ada-code");
    const again = await w.link("same-as-ada");
    expect(again.status).toBe(200); expect(again.body).toMatchObject({ status: "linked", alreadyLinked: true });
    const second = await w.link("ada-2");
    expect(second.status).toBe(409); expect(second.body.error).toEqual({ code: "GITHUB_ACCOUNT_LINK_EXISTS", message: LINK_HAS_ANOTHER });
    expect(await linkedPerson(w, A, "70")).toBeUndefined();
    expect((await w.unlink()).body).toMatchObject({ unlinked: true });
    expect((await w.link("ada-2b")).status).toBe(200);
    expect(await githubLinkOf(w.store, A, ADA)).toMatchObject({ accountId: "70", login: "ada-two" });
  });
  it("two companies: the same GitHub account links in each to that company's own person, and one company's row is nobody in the other", async () => {
    const w = world();
    await w.link("ada-code");
    w.as(DEE); const other = await w.link("same-as-ada");
    expect(other.status).toBe(200);
    expect(await linkedPerson(w, A, "7")).toBe(ADA);
    expect(await linkedPerson(w, B, "7")).toBe(DEE);
    // A copy of A's row under B's partition (a wrong company field) is nobody.
    await w.store.put({ item: { ...githubAccountKey(B, "99"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "99", login: "x", personId: ADA, linkedAt: TIME } });
    expect(await linkedPerson(w, B, "99")).toBeUndefined();
    // Unlinking in B leaves A's link alone.
    expect((await w.unlink()).body).toMatchObject({ unlinked: true });
    expect(await linkedPerson(w, B, "7")).toBeUndefined();
    expect(await linkedPerson(w, A, "7")).toBe(ADA);
  });
  it("needs a fresh step-up again at the claim: a stale one is refused and the state stays usable", async () => {
    const w = world();
    const state = await w.startState();
    w.stepUp(601);
    const stale = await w.claim({ state, code: "ada-code" });
    expect(stale.status).toBe(403); expect(stale.body.error.code).toBe("REAUTH_REQUIRED");
    expect(w.github.requests).toHaveLength(0);
    w.stepUp();
    expect((await w.claim({ state, code: "ada-code" })).status).toBe(200);
  });
  it("a claim for a state that is unknown, malformed, used, expired, another person's or another session's is one answer; GitHub is not asked", async () => {
    const w = world();
    const state = await w.startState();
    const unknown = "A".repeat(43);
    for (const given of [unknown, "short", ""]) expect((await w.claim({ state: given, code: "ada-code" })).body.error).toEqual(uniform);
    // Another person (same company) with Ada's state.
    w.as(BEA); expect((await w.claim({ state, code: "bea-code" })).body.error).toEqual(uniform);
    // The same person on another session.
    w.as(ADA, "s-ada-2"); expect((await w.claim({ state, code: "ada-code" })).body.error).toEqual(uniform);
    // Another company's person.
    w.as(DEE); expect((await w.claim({ state, code: "cal-code" })).body.error).toEqual(uniform);
    expect(w.github.requests).toHaveLength(0);
    w.as(ADA);
    expect((await w.claim({ state, code: "ada-code" })).status).toBe(200);
    expect((await w.claim({ state, code: "ada-code" })).body.error).toEqual(uniform);
    const late = await w.startState(); w.tick(601_000); w.stepUp();
    expect((await w.claim({ state: late, code: "bea-code" })).body.error).toEqual(uniform);
  });
  it("one state sent twice at once: exactly one claim proceeds", async () => {
    const w = world({ "c1": { id: 7, login: "ada-lovelace" }, "c2": { id: 7, login: "ada-lovelace" } });
    const state = await w.startState();
    const answers = await Promise.all([w.claim({ state, code: "c1" }), w.claim({ state, code: "c2" })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403]);
  });
  it.each([["status", "used"], ["provider", "github-install"], ["companyId", B], ["personId", BEA], ["sessionId", "other-session"], ["expiresAt", 1]] as const)(
    "a state whose %s changes between its read and its spend is refused", async (field, value) => {
      const w = world(); const state = await w.startState();
      const key = { pk: `GITHUB_LINK_STATE#${createHash("sha256").update(state).digest("hex")}`, sk: "META" };
      const update = w.store.update.bind(w.store);
      w.store.update = (async (request: Parameters<typeof update>[0]) => {
        const row = await w.store.get(key); await w.store.put({ item: { ...row!, [field]: value } });
        return update(request);
      });
      const answer = await w.claim({ state, code: "ada-code" });
      expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform);
      expect(w.github.requests).toHaveLength(0);
      expect(await githubLinkOf(w.store, A, ADA)).toBeUndefined();
    });
  it("a state of the install flow (its own key family and provider) is not a link state", async () => {
    const w = world(); const secret = "B".repeat(43);
    const hash = createHash("sha256").update(secret).digest("hex");
    await w.store.put({ item: { pk: `GITHUB_CONNECT#${hash}`, sk: "META", entityType: "GITHUB_CONNECT_STATE", provider: "github-install", status: "live", companyId: A, personId: ADA, sessionId: "s-ada", createdAt: TIME, expiresAt: Math.floor(NOW0 / 1000) + 600 } });
    expect((await w.claim({ state: secret, code: "ada-code" })).body.error).toEqual(uniform);
    // Even a row copied into the link family with the install provider is refused.
    await w.store.put({ item: { pk: `GITHUB_LINK_STATE#${hash}`, sk: "META", entityType: "GITHUB_LINK_STATE", provider: "github-install", status: "live", companyId: A, personId: ADA, sessionId: "s-ada", createdAt: TIME, expiresAt: Math.floor(NOW0 / 1000) + 600 } });
    expect((await w.claim({ state: secret, code: "ada-code" })).body.error).toEqual(uniform);
    expect(w.github.requests).toHaveLength(0);
  });
  it("a code GitHub refuses, or that names no usable account, links nothing and answers as one", async () => {
    const w = world({ "bad-id": { id: 0, login: "ghost" }, "bad-login": { id: 5, login: "has space" }, "float": { id: 1.5, login: "frac" } });
    for (const code of ["nope", "bad-id", "bad-login", "float"]) {
      const answer = await w.link(code);
      expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform);
    }
    expect(await githubLinkOf(w.store, A, ADA)).toBeUndefined();
    // GitHub's own answer is never echoed.
    expect((await w.link("nope")).raw).not.toMatch(/bad_verification_code|ghost/);
  });
  it("re-checks what the GitHub client answers: an id that is not a positive whole number, or a login that is not plain, links nothing", async () => {
    for (const answer of [{ id: 0, login: "ghost" }, { id: -5, login: "ghost" }, { id: 1.5, login: "ghost" }, { id: 2 ** 60, login: "ghost" }, { id: 5, login: "has space" }, { id: 5, login: "" }, { id: Number.NaN, login: "x" }]) {
      const w = world();
      w.deps.developer.githubLink!.github = { oauthClient: async () => ({ clientId: "Iv1.client", clientSecret: "x" }), githubUserOfCode: async () => answer };
      const result = await w.link("ada-code");
      expect(result.status, JSON.stringify(answer)).toBe(403); expect(result.body.error).toEqual(uniform);
      expect(await githubLinkOf(w.store, A, ADA)).toBeUndefined();
    }
  });
  it("a session that is not a sign-in session (a service's token) cannot link", async () => {
    const w = world(); w.claims.sid = "";
    const answer = await w.start();
    expect(answer.status).toBe(401);
  });
  it("the claim's company is the live membership: a member moved to another company links there, never in the company named by an old state", async () => {
    const w = world();
    const state = await w.startState();
    w.db.set({ ...membershipKey(ADA), entityType: "COMPANY_MEMBERSHIP", personId: ADA, companyId: B, role: "member", joinedAt: TIME });
    const answer = await w.claim({ state, code: "ada-code" });
    expect(answer.body.error).toEqual(uniform);
    expect(await githubLinkOf(w.store, A, ADA)).toBeUndefined(); expect(await githubLinkOf(w.store, B, ADA)).toBeUndefined();
  });
  it("a revoked membership is refused", async () => {
    const w = world(); const state = await w.startState();
    w.db.set({ ...w.db.get(membershipKey(ADA).pk, membershipKey(ADA).sk)!, revokedAt: TIME });
    expect((await w.claim({ state, code: "ada-code" })).status).toBe(401);
  });
  it("keeps an audit record naming the person and the act, never the GitHub account", async () => {
    const w = world(); await w.link("ada-code"); await w.unlink();
    const audit = (await w.store.query({ pk: githubAuditPk(A) })).items;
    expect(audit.map((row) => row["action"])).toEqual(["linked", "unlinked"]);
    expect(audit.every((row) => row["personId"] === ADA && row["actor"] === ADA)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/ada-lovelace|"7"|githubUserId/);
  });
});

describe("unlink", () => {
  it("removes the caller's own link (both rows) with a log line, and the account can then be linked by another member", async () => {
    const w = world(); await w.link("ada-code");
    const answer = await w.unlink();
    expect(answer.body).toMatchObject({ unlinked: true });
    expect(await w.store.get(githubAccountKey(A, "7"))).toBeUndefined();
    expect(await w.store.get(githubPersonKey(A, ADA))).toBeUndefined();
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "github.account_unlinked", actor: ADA }));
    expect((await w.read()).body).toMatchObject({ linked: false });
    w.as(BEA); expect((await w.link("same-as-ada")).status).toBe(200);
    expect(await linkedPerson(w, A, "7")).toBe(BEA);
  });
  it("with nothing linked it answers unlinked:false; it takes no body and cannot name another person", async () => {
    const w = world();
    expect((await w.unlink()).body).toMatchObject({ unlinked: false });
    await w.link("ada-code");
    w.as(BEA);
    const named = await w.unlink({ personId: ADA });
    expect(named.status).toBe(400);
    expect((await w.unlink()).body).toMatchObject({ unlinked: false });
    expect(await linkedPerson(w, A, "7")).toBe(ADA);
  });
  it("needs no step-up (it only takes away what the person had)", async () => {
    const w = world(); await w.link("ada-code"); w.noStepUp();
    expect((await w.unlink()).status).toBe(200);
  });
  it("only an account row that still names the caller is removed with theirs", async () => {
    const w = world(); await w.link("ada-code");
    // The account row now names someone else (a later link by another member after a repair): Ada's unlink leaves it.
    await w.store.put({ item: { ...githubAccountKey(A, "7"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "ada-lovelace", personId: BEA, linkedAt: TIME } });
    expect((await w.unlink()).body).toMatchObject({ unlinked: true });
    expect(await linkedPerson(w, A, "7")).toBe(BEA);
  });
});
