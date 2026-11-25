// Guided onboarding PR 1: the GitHub connect routes, through the real developer dispatcher, the real binding store and the real App client's user
// authorization over a fake GitHub (its fetch seam). Two companies throughout; every refusal before the GitHub check is one answer.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { CONNECT_ADMIN_ONLY, CONNECT_NOT_SET_UP, GITHUB_TAKEN, routeGithubConnect, START_AGAIN } from "../../packages/broker/src/aws/github-connect-routes.js";
import { USER_AUTHORIZATION_LIMITS } from "../../packages/broker/src/plugins/code-host/github/user-authorization.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";
import { sessionBindingOf } from "../../packages/broker/src/developer/session-binding.js";

const PERSON_B = "e".repeat(64);
const APP_ID = "4242";
// Built at run time (public push protection refuses key-shaped literals).
const CLIENT_SECRET = ["client", "secret", "canary"].join("-");
const tokenFor = (name: string) => ["ghu", `${name.replace(/[^A-Za-z0-9]/g, "")}0123456789abcdefghij`].join("_");

type Answer = Record<string, unknown> & { error: { code: string; message: string } };
interface GitHubUser { id: number; login: string; installations: Array<{ id: number; app_id?: number; account: { login: string; id: number; type: string }; suspended_at?: string | null }>; admins?: string[]; membership?: Record<string, unknown>; pad?: number; totalCount?: number }

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
    const user = users[code]!;
    const path = url.replace("https://api.github.com", "");
    if (path === "/user") return json({ id: user.id, login: user.login });
    if (path.startsWith("/user/installations?")) return json({ total_count: user.totalCount ?? user.installations.length, installations: user.installations.map((row) => ({ app_id: Number(APP_ID), suspended_at: null, ...row })), ...(user.pad === undefined ? {} : { pad: "x".repeat(user.pad) }) });
    const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path)?.[1];
    if (org !== undefined) {
      const organization = { login: org, id: user.installations.find((row) => row.account.login === org && row.account.type === "Organization")?.account.id };
      return json({ state: "active", role: (user.admins ?? []).includes(org) ? "admin" : "member", organization, ...(user.membership ?? {}) });
    }
    return json({ message: "Not Found" }, 404);
  });
  return { fetch, requests };
}

const ACME = { id: 101, account: { login: "acme", id: 9001, type: "Organization" } };
const BETA = { id: 202, account: { login: "beta", id: 9002, type: "Organization" } };
const MINE = { id: 303, account: { login: "alice", id: 7, type: "User" } };

function world(users: Record<string, GitHubUser> = {
  "alice-code": { id: 7, login: "alice", installations: [ACME, BETA, MINE], admins: ["acme", "beta"] },
  "bob-code": { id: 8, login: "bob", installations: [BETA], admins: ["beta"] },
  "carol-code": { id: 9, login: "carol", installations: [ACME, BETA] },
}) {
  const h = companyRouteHarness();
  let now = Date.parse(TIME);
  h.deps.now = () => now;
  const github = fakeGithub(users);
  const client = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: APP_ID, getPrivateKey: async () => "unused",
    getAppSecret: async () => JSON.stringify({ slug: "rovara-test", clientId: "Iv1.client", clientSecret: CLIENT_SECRET }), fetchImplementation: github.fetch, now: () => now });
  const bindings = new GithubInstallationBindings(h.db, "State", () => now);
  h.db.set({ pk: "GITHUB_INSTALLATION_BINDING", sk: "BACKFILL" });
  const logs: unknown[] = [];
  let seed = 0;
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  h.deps.developer.githubConnect = { bindings, github: client, log: (entry) => logs.push(entry), random: () => Buffer.alloc(32, ++seed) };
  const as = (personId: string, companyId: string, role: "owner" | "admin" | "member" = "admin", sid = "session") => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME });
    h.db.set({ pk: `SESSION#${sid}`, sk: "META", developerId: personId, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: personId === PERSON ? "Ada Admin" : "Bea Admin" });
    h.claims.sub = personId; h.claims.sid = sid;
  };
  as(PERSON, A);
  // A request may carry its own person and session (for concurrent calls); otherwise the current `as`.
  const perRequest = new Map<string, Record<string, unknown>>();
  h.deps.developer.verifyAccessToken = async (authorization) => perRequest.get(authorization ?? "") ?? h.claims;
  const call = async (method: string, path: string, body?: unknown, who?: { sub: string; sid: string }) => {
    const authorization = who === undefined ? undefined : `Bearer ${who.sub}.${who.sid}`;
    if (who !== undefined) perRequest.set(authorization!, { ...h.claims, ...who });
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: authorization === undefined ? {} : { authorization } });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const connect = () => call("POST", "/v1/dev/company/github/connect", {});
  const claim = (body: Record<string, unknown>) => call("POST", "/v1/dev/company/github/claim", body);
  const choose = (body: Record<string, unknown>) => call("POST", "/v1/dev/company/github/choose", body);
  const read = () => call("GET", "/v1/dev/company/github");
  const startState = async () => (await connect()).body.state as string;
  return { ...h, github, bindings, logs, as, call, connect, claim, choose, read, startState, tick: (ms: number) => { now += ms; } };
}

const refusedBody = (raw: string) => { const parsed = JSON.parse(raw) as { error: unknown }; return JSON.stringify(parsed.error); };
const uniform = { code: "FORBIDDEN", message: START_AGAIN };

describe("start", () => {
  it("an admin gets a single-use state stored only as its hash, with the install and authorize addresses", async () => {
    const w = world();
    const answer = await w.connect();
    expect(answer.status).toBe(200);
    const state = answer.body.state as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.body.installUrl).toBe(`https://github.com/apps/rovara-test/installations/new?state=${state}`);
    expect(answer.body.authorizeUrl).toBe(`https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${state}`);
    expect(answer.body.expiresAt).toBe(new Date(Date.parse(TIME) + 600_000).toISOString());
    const stored = w.db.get(`GITHUB_CONNECT#${createHash("sha256").update(state).digest("hex")}`, "META");
    expect(stored).toMatchObject({ companyId: A, personId: PERSON, sessionBinding: sessionBindingOf("session"), provider: "github-install", status: "live" });
    expect(JSON.stringify([...w.db.items.values()])).not.toContain(state);
    expect(JSON.stringify(answer.body)).not.toContain(CLIENT_SECRET);
  });
  it("an owner may start; a plain member is refused", async () => {
    const w = world(); w.as(PERSON, A, "owner"); expect((await w.connect()).status).toBe(200);
    w.as(PERSON, A, "member"); const refused = await w.connect();
    expect(refused.status).toBe(403); expect(refused.body.error).toEqual({ code: "FORBIDDEN", message: CONNECT_ADMIN_ONLY });
  });
  it("is unknown without the company layer or the wiring, before anyone is authenticated", async () => {
    for (const off of ["companies", "wiring"]) {
      const w = world();
      if (off === "companies") delete w.deps.companies; else delete w.deps.developer.githubConnect;
      const verify = vi.spyOn(w.deps.developer, "verifyAccessToken");
      for (const answer of [await w.connect(), await w.read(), await w.claim({})]) expect(answer.status).toBe(404);
      expect(verify).not.toHaveBeenCalled();
    }
  });
  it("refuses a body and an App with no OAuth client, minting nothing", async () => {
    const w = world();
    const body = await w.call("POST", "/v1/dev/company/github/connect", { companyId: B });
    expect(body.status).toBe(400); expect(body.raw).not.toContain(B);
    const wiring = w.deps.developer.githubConnect;
    if (wiring === undefined) throw new Error("wiring");
    wiring.github = { ...wiring.github, appSlug: async () => "rovara-test", oauthClient: async () => undefined };
    const off = await w.connect();
    expect(off.status).toBe(503); expect(off.body.error.message).toBe(CONNECT_NOT_SET_UP);
    expect([...w.db.items.keys()].some((key) => key.includes("GITHUB_CONNECT#"))).toBe(false);
  });
});

describe("claim with an installation id", () => {
  it("binds an installation the person controls, as the person, with audit and a company log line; never stores or logs the user token", async () => {
    const w = world(); const state = await w.startState();
    const answer = await w.claim({ state, code: "alice-code", installationId: 101, setupAction: "install" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "connected", alreadyConnected: false, installation: { installationId: 101, accountLogin: "acme", accountType: "Organization" }, githubUser: { id: 7, login: "alice" } });
    expect(await w.bindings.ownerOf(101)).toBe(A);
    expect(w.db.get("GITHUB_INSTALLATION#101", "BINDING")).toMatchObject({ companyId: A, boundBy: PERSON });
    expect([...w.db.items.values()].find((row) => row.entityType === "GITHUB_INSTALLATION_CLAIM_AUDIT")).toMatchObject({ companyId: A, actor: PERSON, installationId: 101 });
    expect(w.logs).toEqual([{ companyId: A, event: "github.binding_claimed", installationId: 101, actor: PERSON }]);
    const everything = JSON.stringify([...w.db.items.values()]) + JSON.stringify(w.logs) + answer.raw;
    expect(everything).not.toContain(tokenFor("alice-code"));
    expect(everything).not.toContain("alice-code");
    expect(everything).not.toContain(CLIENT_SECRET);
    // The token went only to GitHub's API, the secret only to GitHub's token endpoint.
    for (const request of w.github.requests) {
      if (JSON.stringify(request).includes(tokenFor("alice-code"))) expect(request.url.startsWith("https://api.github.com/")).toBe(true);
      if (JSON.stringify(request).includes(CLIENT_SECRET)) expect(request.url).toBe("https://github.com/login/oauth/access_token");
    }
    expect((await w.read()).body).toEqual({ installations: [{ installationId: 101, accountLogin: "acme", status: "active", accountType: "Organization", connectedAt: TIME, connectedBy: { kind: "person", personId: PERSON, name: "Ada Admin" } }], requestId: "company-test" });
  });
  it("guided onboarding PR 3: after GitHub's uninstall mark, a claim with a new installation id binds, and the same id comes back only through a claim", async () => {
    const w = world({ "a1": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] }, "a2": { id: 7, login: "alice", installations: [{ ...ACME, id: 104 }], admins: ["acme"] },
      "a3": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] } });
    expect((await w.claim({ state: await w.startState(), code: "a1", installationId: 101 })).status).toBe(200);
    expect((await w.bindings.markLifecycle(101, "deleted", "550e8400-e29b-41d4-a716-446655440021")).outcome).toBe("marked");
    expect(((await w.read()).body.installations as Array<Record<string, unknown>>)[0]).toMatchObject({ installationId: 101, status: "uninstalled" });
    // A webhook never brings it back.
    expect((await w.bindings.markLifecycle(101, "unsuspend", "550e8400-e29b-41d4-a716-446655440022")).outcome).toBe("unchanged");
    const fresh = await w.claim({ state: await w.startState(), code: "a2", installationId: 104 });
    expect(fresh.status).toBe(200); expect(fresh.body.alreadyConnected).toBe(false);
    const again = await w.claim({ state: await w.startState(), code: "a3", installationId: 101 });
    expect(again.status).toBe(200); expect(again.body).toMatchObject({ status: "connected", alreadyConnected: false });
    expect(((await w.read()).body.installations as Array<Record<string, unknown>>).map((row) => [row.installationId, row.status]).sort()).toEqual([[101, "active"], [104, "active"]]);
    expect(w.logs).toContainEqual({ companyId: A, event: "github.binding_reconnected", installationId: 101, actor: PERSON });
  });
  it("the same installation again for the same company is an idempotent OK that writes nothing new", async () => {
    const w = world({ "a1": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] }, "a2": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] } });
    expect((await w.claim({ state: await w.startState(), code: "a1", installationId: 101 })).body.alreadyConnected).toBe(false);
    const rows = () => JSON.stringify([...w.db.items.entries()].filter(([key]) => !key.includes("GITHUB_CONNECT#")));
    const before = rows();
    const again = await w.claim({ state: await w.startState(), code: "a2", installationId: 101 });
    expect(again.status).toBe(200); expect(again.body.alreadyConnected).toBe(true);
    expect(rows()).toBe(before); expect(w.logs).toHaveLength(1);
  });
  it("an id the person cannot reach, or only reads through a plain org membership, is the uniform refusal and binds nothing", async () => {
    const w = world();
    const typed = await w.claim({ state: await w.startState(), code: "bob-code", installationId: 101 }); // bob: no access to acme at all
    const reader = await w.claim({ state: await w.startState(), code: "carol-code", installationId: 101 }); // carol: acme member, not admin
    const missing = await w.claim({ state: await w.startState(), code: "alice-code", installationId: 999 });
    for (const answer of [typed, reader, missing]) { expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform); }
    expect(refusedBody(typed.raw)).toBe(refusedBody(reader.raw));
    expect(await w.bindings.ownerOf(101)).toBeUndefined();
  });
  it("another App's installation and an Enterprise account never bind", async () => {
    const w = world({ "x-code": { id: 7, login: "alice", installations: [{ ...ACME, app_id: 1 }, { id: 404, account: { login: "ent", id: 5, type: "Enterprise" } }], admins: ["acme"] } });
    for (const id of [101, 404]) expect((await w.claim({ state: await w.startState(), code: "x-code", installationId: id })).body.error).toEqual(uniform);
  });
  it("a User account's installation binds only for that very user", async () => {
    const w = world({ "alice-code": { id: 7, login: "alice", installations: [MINE] }, "mallory-code": { id: 66, login: "mallory", installations: [MINE] } });
    expect((await w.claim({ state: await w.startState(), code: "mallory-code", installationId: 303 })).body.error).toEqual(uniform);
    expect((await w.claim({ state: await w.startState(), code: "alice-code", installationId: 303 })).status).toBe(200);
  });
  it("an installation bound to company B refuses A with 409, only after the GitHub check passed", async () => {
    const w = world();
    w.as(PERSON_B, B); expect((await w.claim({ state: await w.startState(), code: "bob-code", installationId: 202 })).status).toBe(200);
    w.as(PERSON, A);
    const taken = await w.claim({ state: await w.startState(), code: "alice-code", installationId: 202 });
    expect(taken.status).toBe(409); expect(taken.body.error).toEqual({ code: "GITHUB_INSTALLATION_TAKEN", message: GITHUB_TAKEN });
    // Without control of it, the same bound id is the uniform refusal: no oracle.
    const blind = await w.claim({ state: await w.startState(), code: "carol-code", installationId: 202 });
    expect(blind.status).toBe(403); expect(blind.body.error).toEqual(uniform);
    expect(await w.bindings.ownerOf(202)).toBe(B);
    expect(blind.raw).not.toMatch(/org_|beta|bob/);
  });
  it("two companies racing for one installation: exactly one wins, the other gets 409", async () => {
    const w = world({ "a1": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] }, "b1": { id: 8, login: "bob", installations: [ACME], admins: ["acme"] } });
    const stateA = await w.startState();
    w.as(PERSON_B, B, "admin", "session-b"); const stateB = await w.startState();
    w.as(PERSON, A);
    const claimAs = (sub: string, sid: string, state: string, code: string) => w.call("POST", "/v1/dev/company/github/claim", { state, code, installationId: 101 }, { sub, sid });
    const [first, second] = await Promise.all([claimAs(PERSON, "session", stateA, "a1"), claimAs(PERSON_B, "session-b", stateB, "b1")]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const owner = await w.bindings.ownerOf(101);
    expect([A, B]).toContain(owner);
    expect([...w.db.items.values()].filter((row) => row.entityType === "GITHUB_INSTALLATION_CLAIM_AUDIT")).toHaveLength(1);
  });
  it("store-level race: concurrent person claims from two companies, exactly one binding", async () => {
    const w = world();
    const results = await Promise.all([w.bindings.claimPerson(A, { installationId: 7, accountLogin: "x" }, PERSON), w.bindings.claimPerson(B, { installationId: 7, accountLogin: "x" }, PERSON_B)]);
    expect([...results].sort()).toEqual(["bound", "taken"]);
  });
  it("before the backfill marker every unbound installation stays the implicit company's: the person path binds nothing", async () => {
    const w = world(); w.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
    const answer = await w.claim({ state: await w.startState(), code: "alice-code", installationId: 101 });
    expect(answer.status).toBe(409); expect(w.db.get("GITHUB_INSTALLATION#101", "BINDING")).toBeUndefined();
  });
});

describe("state", () => {
  it("a state is single use", async () => {
    const w = world({ "c1": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] }, "c2": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] } });
    const state = await w.startState();
    expect((await w.claim({ state, code: "c1", installationId: 101 })).status).toBe(200);
    expect((await w.claim({ state, code: "c2", installationId: 101 })).body.error).toEqual(uniform);
  });
  it("expired, other session, other person, other company and unknown states are the same refusal and never reach GitHub", async () => {
    const w = world();
    const answers: Array<{ raw: string; status: number }> = [];
    const expired = await w.startState(); w.tick(600_000); answers.push(await w.claim({ state: expired, code: "alice-code", installationId: 101 }));
    const session = await w.startState(); w.as(PERSON, A, "admin", "other-session"); answers.push(await w.claim({ state: session, code: "alice-code", installationId: 101 }));
    w.as(PERSON, A); const person = await w.startState(); w.as(PERSON_B, A, "admin"); answers.push(await w.claim({ state: person, code: "alice-code", installationId: 101 }));
    w.as(PERSON, A); const company = await w.startState(); w.as(PERSON, B, "admin"); answers.push(await w.claim({ state: company, code: "alice-code", installationId: 101 }));
    answers.push(await w.claim({ state: "Z".repeat(43), code: "alice-code", installationId: 101 }));
    for (const answer of answers) { expect(answer.status).toBe(403); expect(refusedBody(answer.raw)).toBe(refusedBody(answers[0]!.raw)); }
    expect(w.github.requests).toHaveLength(0);
    expect(await w.bindings.ownerOf(101)).toBeUndefined();
  });
  it("A's state cannot claim for B even when B's admin also controls the installation", async () => {
    const w = world(); const stateA = await w.startState();
    w.as(PERSON_B, B); const answer = await w.claim({ state: stateA, code: "bob-code", installationId: 202 });
    expect(answer.body.error).toEqual(uniform); expect(await w.bindings.ownerOf(202)).toBeUndefined();
  });
  it("a plain member's claim is the uniform refusal and does not spend the admin's state or reach GitHub", async () => {
    const w = world(); const state = await w.startState();
    w.as(PERSON, A, "member"); expect((await w.claim({ state, code: "alice-code", installationId: 101 })).body.error).toEqual(uniform);
    expect(w.github.requests).toHaveLength(0);
    w.as(PERSON, A, "admin"); expect((await w.claim({ state, code: "alice-code", installationId: 101 })).status).toBe(200);
  });
  it.each([{}, { state: "short" }, { state: "x".repeat(43), code: "a b" }, { state: "x".repeat(43), code: "c", installationId: "101" }, { state: "x".repeat(43), code: "c", installationId: 0 },
    { state: "x".repeat(43), code: "c", companyId: B }, { state: "x".repeat(43), code: "c", setupAction: "other" }, { state: "x".repeat(43) }, { state: "x".repeat(43), setupAction: "request", installationId: 1 }])(
    "malformed claim body %j is the uniform refusal without echo", async (body) => {
    const w = world(); const answer = await w.claim(body);
    expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform); expect(answer.raw).not.toMatch(/org_b|short|a b/);
  });
  it("a bad or reused GitHub code is the uniform refusal", async () => {
    const w = world();
    expect((await w.claim({ state: await w.startState(), code: "nobody", installationId: 101 })).body.error).toEqual(uniform);
  });
});

describe("no installation id: list, then choose", () => {
  it("lists only what the person controls, with bound status, binds nothing, and a ticket binds the chosen one", async () => {
    const w = world();
    w.as(PERSON_B, B); await w.claim({ state: await w.startState(), code: "bob-code", installationId: 202 });
    w.as(PERSON, A);
    const before = await w.bindings.ownerOf(101);
    const listed = await w.claim({ state: await w.startState(), code: "alice-code" });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ status: "choose", githubUser: { id: 7, login: "alice" } });
    expect(listed.body.installations).toEqual([
      { installationId: 101, accountLogin: "acme", accountType: "Organization", suspended: false, connection: "unbound" },
      { installationId: 202, accountLogin: "beta", accountType: "Organization", suspended: false, connection: "another_company" },
      { installationId: 303, accountLogin: "alice", accountType: "User", suspended: false, connection: "unbound" },
    ]);
    expect(await w.bindings.ownerOf(101)).toBe(before);
    const ticket = listed.body.ticket as string;
    expect(JSON.stringify([...w.db.items.values()])).not.toContain(ticket);
    // An id outside the checked list is refused; the ticket is then spent.
    expect((await w.choose({ ticket, installationId: 999 })).body.error).toEqual(uniform);
    expect((await w.choose({ ticket, installationId: 101 })).body.error).toEqual(uniform);
  });
  it("choose binds a checked installation once; reuse, other session, other company and a taken one are handled", async () => {
    const users = { "l1": { id: 7, login: "alice", installations: [ACME, BETA], admins: ["acme", "beta"] }, "l2": { id: 7, login: "alice", installations: [ACME, BETA], admins: ["acme", "beta"] }, "bob-code": { id: 8, login: "bob", installations: [BETA], admins: ["beta"] } };
    const w = world(users);
    w.as(PERSON_B, B); await w.claim({ state: await w.startState(), code: "bob-code", installationId: 202 });
    w.as(PERSON, A);
    const ticket = (await w.claim({ state: await w.startState(), code: "l1" })).body.ticket as string;
    w.as(PERSON, A, "admin", "other-session"); expect((await w.choose({ ticket, installationId: 101 })).body.error).toEqual(uniform);
    w.as(PERSON, A); const ok = await w.choose({ ticket, installationId: 101 });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ status: "connected", installation: { installationId: 101 }, githubUser: { id: 7, login: "alice" } });
    expect(await w.bindings.ownerOf(101)).toBe(A);
    expect((await w.choose({ ticket, installationId: 101 })).body.error).toEqual(uniform);
    const second = (await w.claim({ state: await w.startState(), code: "l2" })).body.ticket as string;
    const taken = await w.choose({ ticket: second, installationId: 202 });
    expect(taken.status).toBe(409); expect(taken.body.error.message).toBe(GITHUB_TAKEN);
  });
  it("a ticket expires and belongs to its company", async () => {
    const users = { "l1": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] }, "l2": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] } };
    const w = world(users);
    const t1 = (await w.claim({ state: await w.startState(), code: "l1" })).body.ticket as string;
    w.tick(600_000); expect((await w.choose({ ticket: t1, installationId: 101 })).body.error).toEqual(uniform);
    const t2 = (await w.claim({ state: await w.startState(), code: "l2" })).body.ticket as string;
    w.as(PERSON_B, B); expect((await w.choose({ ticket: t2, installationId: 101 })).body.error).toEqual(uniform);
    // A state is not a ticket.
    w.as(PERSON, A); expect((await w.choose({ ticket: await w.startState(), installationId: 101 })).body.error).toEqual(uniform);
    expect(await w.bindings.ownerOf(101)).toBeUndefined();
  });
  it("setup_action=request answers the waiting state, spends the state, and binds nothing", async () => {
    const w = world(); const state = await w.startState();
    const answer = await w.claim({ state, setupAction: "request" });
    expect(answer.body).toEqual({ status: "requested", requestId: "company-test" });
    expect(w.github.requests).toHaveLength(0);
    expect((await w.claim({ state, setupAction: "request" })).body.error).toEqual(uniform);
  });
  it("a person who can reach more installations than one page holds is refused whole", async () => {
    const many = Array.from({ length: USER_AUTHORIZATION_LIMITS.installations + 1 }, (_, i) => ({ id: 1000 + i, account: { login: `org${i}`, id: 5000 + i, type: "Organization" } }));
    const w = world({ "big": { id: 7, login: "alice", installations: many, admins: [] } });
    expect((await w.claim({ state: await w.startState(), code: "big" })).body.error).toEqual(uniform);
  });
});

describe("read", () => {
  it("any member of the company reads its connections; another company reads only its own", async () => {
    const w = world();
    await w.claim({ state: await w.startState(), code: "alice-code", installationId: 101 });
    w.as(PERSON, A, "member"); expect((await w.read()).body.installations).toHaveLength(1);
    w.as(PERSON_B, B, "member"); expect((await w.read()).body).toEqual({ installations: [], requestId: "company-test" });
    // A foreign company's list row is never shown.
    w.db.set({ pk: `ORG#${B}#GITHUB_INSTALLATIONS`, sk: "INSTALLATION#101", entityType: "GITHUB_COMPANY_INSTALLATION", companyId: B, installationId: 101, accountLogin: "acme", boundAt: TIME, boundBy: PERSON_B });
    expect((await w.read()).body.installations).toEqual([]);
  });
  it("a person with no membership is refused", async () => {
    const w = world(); w.db.delete(membershipKey(PERSON).pk, membershipKey(PERSON).sk);
    expect((await w.read()).status).toBe(401);
  });
});

describe("review round 1: every spend condition, GitHub control edges and limits", () => {
  it("one state sent twice at once: exactly one claim proceeds", async () => {
    const w = world({ "c1": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] }, "c2": { id: 7, login: "alice", installations: [ACME], admins: ["acme"] } });
    const state = await w.startState();
    const answers = await Promise.all([w.claim({ state, code: "c1", installationId: 101 }), w.claim({ state, code: "c2", installationId: 101 })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403]);
  });
  it.each([["status", "used"], ["provider", "github-install-ticket"], ["companyId", B], ["personId", PERSON_B], ["sessionBinding", sessionBindingOf("other-session")], ["expiresAt", 1]] as const)(
    "a state whose %s changes between its read and its spend is refused", async (field, value) => {
      const w = world(); const state = await w.startState();
      const send = w.db.send.bind(w.db);
      w.db.send = (async (command: { constructor: { name: string }; input: { Key?: { pk?: string } } }) => {
        if (command.constructor.name === "UpdateCommand" && command.input.Key?.pk?.startsWith("GITHUB_CONNECT#") === true) {
          const row = w.db.get(command.input.Key.pk, "META")!; w.db.set({ ...row, [field]: value });
        }
        return send(command);
      });
      const answer = await w.claim({ state, code: "alice-code", installationId: 101 });
      expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform);
      expect(w.github.requests).toHaveLength(0);
    });
  it("a pending admin invitation, or a membership of another organization with the same login, does not control it", async () => {
    for (const membership of [{ state: "pending" }, { organization: { login: "acme", id: 1 } }, { organization: undefined }]) {
      const w = world({ "p": { id: 7, login: "alice", installations: [ACME], admins: ["acme"], membership } });
      expect((await w.claim({ state: await w.startState(), code: "p", installationId: 101 })).body.error).toEqual(uniform);
    }
  });
  it("an Enterprise account never binds, even named like an organization the person administers", async () => {
    const w = world({ "e": { id: 7, login: "alice", installations: [ACME, { id: 505, account: { login: "acme", id: 9001, type: "Enterprise" } }], admins: ["acme"] } });
    expect((await w.claim({ state: await w.startState(), code: "e", installationId: 505 })).body.error).toEqual(uniform);
  });
  it.each([
    ["more than one page", 2000, { installations: Array.from({ length: 101 }, (_, i) => ({ id: 2000 + i, account: { login: i === 0 ? "alice" : `u${i}`, id: i === 0 ? 7 : 3000 + i, type: "User" } })) }],
    ["an answer over the byte cap", 101, { installations: [ACME], admins: ["acme"], pad: 1_000_001 }],
    ["more organizations than the cap", 101, { installations: Array.from({ length: 26 }, (_, i) => ({ id: 101 + i, account: { login: `org${i}`, id: 4000 + i, type: "Organization" } })), admins: Array.from({ length: 26 }, (_, i) => `org${i}`) }],
    ["a repeated installation id", 101, { installations: [ACME, ACME], admins: ["acme"] }],
    ["a total that disagrees with the page", 101, { installations: [ACME], admins: ["acme"], totalCount: 2 }],
    ["one login with two organization ids", 101, { installations: [ACME, { id: 102, account: { login: "acme", id: 1, type: "Organization" } }], admins: ["acme"] }],
  ] as const)("%s refuses the whole answer", async (_name, target, shape) => {
    const w = world({ "x": { id: 7, login: "alice", ...shape } as unknown as GitHubUser });
    expect((await w.claim({ state: await w.startState(), code: "x", installationId: target })).body.error).toEqual(uniform);
    expect(await w.bindings.ownerOf(target)).toBeUndefined();
  });
  it("store: the backfill marker removed between the check and the write binds nothing", async () => {
    const w = world();
    const send = w.db.send.bind(w.db);
    w.db.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") w.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
      return send(command as never);
    });
    expect(await w.bindings.claimPerson(A, { installationId: 9, accountLogin: "x" }, PERSON)).toBe("taken");
    expect(w.db.get("GITHUB_INSTALLATION#9", "BINDING")).toBeUndefined();
  });
  it("the read names the person who connected only while they are still in the company", async () => {
    const w = world();
    await w.claim({ state: await w.startState(), code: "alice-code", installationId: 101 });
    w.as(PERSON_B, A, "member");
    expect((await w.read()).body.installations).toEqual([expect.objectContaining({ connectedBy: { kind: "person", personId: PERSON, name: "Ada Admin" } })]);
    w.db.set({ ...w.db.get(membershipKey(PERSON).pk, membershipKey(PERSON).sk)!, revokedAt: TIME });
    expect((await w.read()).body.installations).toEqual([expect.objectContaining({ connectedBy: { kind: "person", personId: PERSON } })]);
    // Moved to another company (live there): still not named on this company's page.
    w.db.set({ ...w.db.get(membershipKey(PERSON).pk, membershipKey(PERSON).sk)!, revokedAt: undefined, companyId: B });
    expect((await w.read()).body.installations).toEqual([expect.objectContaining({ connectedBy: { kind: "person", personId: PERSON } })]);
  });
});

// Session-id-at-rest: the sign-in session id is the browser's login cookie, so a state or ticket row keeps a digest of it (never the id), and the spend compares digests.
describe("the session at rest", () => {
  const COOKIE = "cookie-0123456789abcdef-secret";
  const rowOf = (w: ReturnType<typeof world>, state: string) => w.db.get(`GITHUB_CONNECT#${createHash("sha256").update(state).digest("hex")}`, "META")!;
  const connectRows = (w: ReturnType<typeof world>) => JSON.stringify([...w.db.items.values()].filter((item) => String((item as { pk?: string }).pk).startsWith("GITHUB_CONNECT#")));
  it("mints a digest of the session and never the id; the same session spends it, another session does not", async () => {
    const w = world(); w.as(PERSON, A, "admin", COOKIE);
    const state = await w.startState();
    const row = rowOf(w, state);
    expect(row).toMatchObject({ sessionBinding: sessionBindingOf(COOKIE) });
    expect(row).not.toHaveProperty("sessionId");
    expect(connectRows(w)).not.toContain(COOKIE);
    w.as(PERSON, A, "admin", "another-session");
    expect((await w.claim({ state, code: "alice-code", installationId: 101 })).body.error).toEqual(uniform);
    expect(rowOf(w, state)).toMatchObject({ status: "live" });
    w.as(PERSON, A, "admin", COOKIE);
    expect((await w.claim({ state, code: "alice-code", installationId: 101 })).status).toBe(200);
    expect(connectRows(w)).not.toContain(COOKIE);
  });
  it("a row an older build wrote (the raw id, no digest) is refused with the start-again words and is not spent", async () => {
    const w = world(); w.as(PERSON, A, "admin", COOKIE);
    const state = await w.startState();
    const { sessionBinding: _digest, ...rest } = rowOf(w, state); void _digest;
    w.db.set({ ...rest, sessionId: COOKIE });
    const answer = await w.claim({ state, code: "alice-code", installationId: 101 });
    expect(answer.status).toBe(403); expect(answer.body.error).toEqual(uniform);
    expect(w.github.requests).toHaveLength(0);
    expect(rowOf(w, state)).toMatchObject({ status: "live", sessionId: COOKIE });
  });
});

describe("a caller with no sign-in session (a registered service's own token)", () => {
  const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
  const direct = (w: ReturnType<typeof world>, path: string, body: unknown, sessionId: string | undefined) => {
    const ctx = { documentClient: w.db, tableName: "State", signInTableName: "SignIn", now: w.deps.now, wiring: w.deps.developer.githubConnect! };
    const caller = { developerId: PERSON, sessionId, amr: "slack", name: "Ada" } as unknown as Parameters<typeof routeGithubConnect>[1];
    return routeGithubConnect(ctx, caller, A, { method: "POST", path, headers: {}, requestId: "r", body: JSON.stringify(body) }, new URL(path, "https://broker.example.test"));
  };
  const states = (w: ReturnType<typeof world>) => [...w.db.items.values()].filter((row) => (row as { entityType?: string }).entityType === "GITHUB_CONNECT_STATE");
  it.each([["empty", ""], ["missing", undefined]] as const)("an %s session id is refused before any state is minted, and cannot spend one", async (_name, sessionId) => {
    const w = world(); w.as(PERSON, A);
    await expect(direct(w, "/v1/dev/company/github/connect", {}, sessionId)).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining(SIGN_IN_AGAIN) as string });
    expect(states(w)).toEqual([]);
    const state = await w.startState();
    await expect(direct(w, "/v1/dev/company/github/claim", { state, code: "alice-code", installationId: 101 }, sessionId)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(states(w)).toHaveLength(1); expect(states(w)[0]).toMatchObject({ status: "live" });
    expect(w.github.requests).toHaveLength(0);
  });
});
