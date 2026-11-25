// DEC 254h: GitHub sign-in. An OAuth 2 provider adapter (no ID token), the `github` method value, the subject GitHub's stable numeric user id,
// only the primary AND verified email, and the same membership rules as every method. All GitHub calls go to a fake through the provider seam.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { developerIdentityConfigFromEnvironment, parseGithubClientSecret } from "../../packages/broker/src/aws/developer-identity.js";
import { githubSignInFromEnvironment } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { GITHUB_ISSUER, GITHUB_SCOPES, ProviderUnavailableError, githubSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { enabledMethods } from "../../packages/broker/src/developer/server.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { API, authorizeQuery, httpEvent } from "../support/developer-fakes.js";
import { B, OWN_SIGNIN, SECRET, WEB, X, sharedSignInWorld, type SharedSignInWorld } from "../support/company-shared-signin-world.js";
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, fakeGithub, type FakeGithubUser } from "../support/fake-github.js";

const users: FakeGithubUser[] = [
  { id: 1001, login: "octo-verified", name: "Octo Verified", emails: [{ email: "other@example.test", primary: false, verified: true }, { email: "octo@example.test", primary: true, verified: true }] },
  { id: 1002, login: "octo-unverified", emails: [{ email: "unverified@example.test", primary: true, verified: false }, { email: "side@example.test", primary: false, verified: true }] },
  { id: 1003, login: "octo-noemail", emails: "forbidden" },
  { id: 1004, login: "octo-second", emails: [] },
];
const gid = (id: number) => ownerKeyForSubject(GITHUB_ISSUER, String(id));
const REDIRECT = `${API}/v1/auth/callback/github`;

function provider(gh = fakeGithub(users)) {
  return { gh, p: githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: () => 0 }) };
}
async function complete(login: string, nonce = "n".repeat(43), gh = fakeGithub(users)) {
  const { p } = provider(gh);
  const url = await p.authorizeUrl({ state: "s1", nonce, redirectUri: REDIRECT });
  const code = new URL(gh.approve(url, login)).searchParams.get("code")!;
  return p.complete({ code, nonce, redirectUri: REDIRECT });
}

describe("the GitHub provider adapter", () => {
  it("asks for read:user user:email with PKCE S256 bound to the sign-in's nonce, and never sends the secret to the browser", async () => {
    const { p } = provider();
    const url = new URL(await p.authorizeUrl({ state: "s1", nonce: "abc", redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: GITHUB_CLIENT_ID, redirect_uri: REDIRECT, scope: GITHUB_SCOPES, state: "s1",
      code_challenge: createHash("sha256").update("abc").digest("base64url"), code_challenge_method: "S256", allow_signup: "true" });
    expect(GITHUB_SCOPES).toBe("read:user user:email");
    expect(url.toString()).not.toContain(GITHUB_CLIENT_SECRET);
  });

  it("the subject is the numeric id (never the login), with only the primary verified email", async () => {
    const result = await complete("octo-verified");
    expect(result).toEqual({ ok: true, identity: { method: "github", issuer: "https://github.com", subject: "1001", displayName: "Octo Verified", email: "octo@example.test" } });
  });

  it.each([
    ["a primary email that is not verified (a verified one that is not primary is not used either)", "octo-unverified"],
    ["an email list GitHub refuses", "octo-noemail"],
    ["no emails", "octo-second"],
  ])("%s: no email", async (_case, login) => {
    const result = await complete(login);
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity).not.toHaveProperty("email");
    expect(result.ok && result.identity.displayName).toBe(login);
  });

  it("two primary verified rows (never a real answer) are no email, not a guess", async () => {
    const gh = fakeGithub([{ id: 7, login: "twice", emails: [{ email: "a@example.test", primary: true, verified: true }, { email: "b@example.test", primary: true, verified: true }] }]);
    const result = await complete("twice", undefined, gh);
    expect(result.ok && result.identity).not.toHaveProperty("email");
  });

  it("a code is redeemable only with this sign-in's own verifier (PKCE)", async () => {
    const gh = fakeGithub(users);
    const { p } = provider(gh);
    const url = await p.authorizeUrl({ state: "s1", nonce: "right-nonce", redirectUri: REDIRECT });
    const code = new URL(gh.approve(url, "octo-verified")).searchParams.get("code")!;
    const result = await p.complete({ code, nonce: "wrong-nonce", redirectUri: REDIRECT });
    expect(result).toEqual({ ok: false, reason: "GitHub refused the sign-in (bad_verification_code); run agentx login again" });
    expect(gh.state.tokenRequests[0]).toMatchObject({ code_verifier: "wrong-nonce", client_secret: GITHUB_CLIENT_SECRET, redirect_uri: REDIRECT });
  });

  it.each([
    ["an id that is not a positive whole number", { id: "1001", login: "x" }],
    ["a negative id", { id: -1, login: "x" }],
    ["no login", { id: 5 }],
    ["a login GitHub would never issue", { id: 5, login: "a b<script>" }],
  ])("refuses %s, echoing nothing", async (_case, body) => {
    const gh = fakeGithub(users);
    const fetchUser: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/user") return new Response(JSON.stringify(body), { status: 200 });
      return gh.fetch(input, init);
    };
    const p = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: fetchUser, now: () => 0 });
    const url = await p.authorizeUrl({ state: "s", nonce: "n", redirectUri: REDIRECT });
    const result = await p.complete({ code: new URL(gh.approve(url, "octo-verified")).searchParams.get("code")!, nonce: "n", redirectUri: REDIRECT });
    expect(result).toEqual({ ok: false, reason: "GitHub's answer names no GitHub user; run agentx login again" });
  });

  it("an error from GitHub is told by its short code only; a 5xx is try-again", async () => {
    const odd: typeof fetch = async () => new Response(JSON.stringify({ error: "incorrect_client_credentials<b>secret-canary", error_description: "secret-canary" }), { status: 200 });
    const p = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: odd, now: () => 0 });
    const result = await p.complete({ code: "c", nonce: "n", redirectUri: REDIRECT });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("<");
    expect(JSON.stringify(result)).not.toContain("canary-");
    const gh = fakeGithub(users); gh.state.down = true;
    await expect(githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: () => 0 }).complete({ code: "c", nonce: "n", redirectUri: REDIRECT })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it.each([["a token that is not a bearer token", { access_token: "t", token_type: "mac" }], ["no token type", { access_token: "t" }], ["an empty token", { access_token: "", token_type: "bearer" }]])("refuses %s", async (_case, grant) => {
    const odd: typeof fetch = async () => new Response(JSON.stringify(grant), { status: 200 });
    const p = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: odd, now: () => 0 });
    expect(await p.complete({ code: "c", nonce: "n", redirectUri: REDIRECT })).toEqual({ ok: false, reason: "GitHub refused the sign-in (no reason given); run agentx login again" });
  });

  it("GitHub's access token never leaves the adapter", async () => {
    const gh = fakeGithub(users);
    const result = await complete("octo-verified", undefined, gh);
    for (const token of gh.state.issued) expect(JSON.stringify(result)).not.toContain(token);
  });
});

/** The shared world with GitHub turned on (as the sign-in Lambda wires it with the company layer on). */
function world(): SharedSignInWorld & { gh: ReturnType<typeof fakeGithub> } {
  const w = sharedSignInWorld();
  const gh = fakeGithub(users);
  w.deps.config.github = {};
  w.deps.providers.github = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: w.now });
  w.routes.developer.methods.github = true;
  return Object.assign(w, { gh });
}
type Signed = { access?: string; refresh?: string; refused?: string };
/** A real GitHub sign-in through the web app (default) or the CLI, naming a company and an invite or not. */
async function githubSignIn(w: ReturnType<typeof world>, login: string, opts: { cli?: boolean; company?: string; invite?: string } = {}): Promise<Signed> {
  const query = { ...(opts.cli === true ? {} : { client_id: "web-app", redirect_uri: WEB }), ...(opts.company === undefined ? {} : { company: opts.company }), ...(opts.invite === undefined ? {} : { invite: opts.invite }) };
  let response = await w.http(httpEvent("GET", authorizeQuery(query)));
  if (response.statusCode === 200) {
    const link = /href="([^"]*method=github)"/.exec(response.body)?.[1];
    if (link === undefined) return { refused: "no GitHub on the method page" };
    response = await w.http(httpEvent("GET", link.replaceAll("&amp;", "&")));
  }
  if (response.statusCode !== 302) return { refused: `status ${response.statusCode}` };
  const providerUrl = response.headers.location!;
  if (!providerUrl.startsWith("https://github.com/")) return { refused: new URL(providerUrl).searchParams.get("error_description") ?? providerUrl };
  const back = await w.http(httpEvent("GET", w.gh.approve(providerUrl, login)));
  const location = new URL(back.headers.location ?? `${API}/no-redirect-${back.statusCode}`);
  const code = location.searchParams.get("code");
  if (code === null) return { refused: location.searchParams.get("error_description") ?? location.toString() };
  const tokens = await w.exchange(code, opts.cli === true ? {} : { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
  if (tokens.status !== 200) return { refused: `exchange ${tokens.status}` };
  return { access: tokens.body.access_token as string, refresh: tokens.body.refresh_token as string };
}

describe("GitHub sign-in (DEC 254h)", () => {
  it("is never offered without Code's company layer, nor before it is configured", () => {
    const w = world();
    expect(enabledMethods(w.deps)).toContain("github");
    const noCompany = { ...w.deps }; delete noCompany.company;
    expect(enabledMethods(noCompany)).not.toContain("github");
    const noConfig = { ...w.deps.config }; delete noConfig.github;
    expect(enabledMethods({ ...w.deps, config: noConfig })).not.toContain("github");
    const noProvider = { ...w.deps.providers }; delete noProvider.github;
    expect(enabledMethods({ ...w.deps, providers: noProvider })).not.toContain("github");
  });

  it("a GitHub person with no company gets the company-less session (web app only); the subject is the numeric id", async () => {
    const w = world();
    const signed = await githubSignIn(w, "octo-verified");
    expect(signed.refused).toBeUndefined();
    expect((await w.access(signed.access)).body).toEqual({ developerId: gid(1001), displayName: "Octo Verified", nameChosen: false, administrator: false, projects: [], notices: [] });
    expect(w.db.get(`DEVELOPER#${gid(1001)}`, "META")).toMatchObject({ provider: "github", issuer: "https://github.com", subject: "1001", companyless: true });
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === gid(1001))).toEqual([expect.objectContaining({ amr: "github" })]);
    // The CLI never gets a company-less session.
    expect((await githubSignIn(w, "octo-verified", { cli: true })).refused).toBe("not invited");
  });

  it("the primary verified email spends an email invite; the session is the shared method's, and refresh and the broker accept it", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "octo@example.test", role: "member", expiresInHours: 24 });
    const signed = await githubSignIn(w, "octo-verified", { company: X });
    expect(signed.refused).toBeUndefined();
    expect((await w.access(signed.access)).body).toMatchObject({ developerId: gid(1001), companyId: X, companyRole: "member", joinedByInvite: true });
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === gid(1001))).toEqual([expect.objectContaining({ amr: "github", companyId: X, installMethod: true })]);
    expect((await w.refresh(signed.refresh!)).status).toBe(200);
    // Later sign-ins (no company named) land in their membership's company.
    expect((await w.access((await githubSignIn(w, "octo-verified")).access)).body).toMatchObject({ companyId: X });
  });

  it("an unverified or non-primary email spends nothing; a GitHub identity without verified email cannot redeem an invite", async () => {
    const w = world();
    const owner = await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "unverified@example.test", role: "member", expiresInHours: 24 });
    await w.operator({ kind: "company-preapprove", companyId: X, email: "side@example.test", role: "member", expiresInHours: 24 });
    expect((await githubSignIn(w, "octo-unverified", { company: X })).refused).toBe("not invited");
    expect(w.db.get(membershipKey(gid(1002)).pk, membershipKey(gid(1002)).sk)).toBeUndefined();
    expect(w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("side@example.test").pk)).toMatchObject({ status: "live" });
    // The owner (signed in again into X) mints a link secret; the email-less GitHub person is refused.
    void owner;
    const ownerIn = await w.signIn("owner");
    const minted = await w.call("POST", "/v1/dev/company/preapprovals", ownerIn.access, { email: "link@example.test", role: "member", expiresInHours: 24 });
    const secret = (minted.body as { invite: { secret: string } }).invite.secret;
    const joined = await githubSignIn(w, "octo-noemail", { company: X, invite: secret });
    expect(joined.refused).toBe("This sign-in has no verified email. Sign in with the invited email.");
    expect(w.db.get(membershipKey(gid(1003)).pk, membershipKey(gid(1003)).sk)).toBeUndefined();
    expect(w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("link@example.test").pk)).toMatchObject({ status: "live" });
  });

  it("a company with its own issuer never takes GitHub: not offered, and refused before any invite is spent", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: B, email: "octo@example.test", role: "member", expiresInHours: 24 });
    // B's method page offers no GitHub; a direct choice of it is refused.
    const page = await w.http(httpEvent("GET", authorizeQuery({ client_id: "web-app", redirect_uri: WEB, company: B })));
    expect(page.body).not.toContain("method=github");
    const request = /request=([^&"]+)/.exec(page.body)![1]!;
    expect((await w.http(httpEvent("GET", `/v1/auth/authorize?request=${request}&method=github`))).statusCode).toBe(400);
    // A member of B (an operator's import) who signs in with GitHub naming no company is refused with B's own-sign-in answer.
    w.db.set({ ...membershipKey(gid(1004)), entityType: "COMPANY_MEMBERSHIP", personId: gid(1004), companyId: B, role: "member", joinedAt: new Date(w.now()).toISOString() });
    expect((await githubSignIn(w, "octo-second")).refused).toBe(OWN_SIGNIN);
    expect(w.db.get(companyScoped(B, "PREAPPROVAL"), emailIndexKey("octo@example.test").pk)).toMatchObject({ status: "live" });
  });

  it("a GitHub session of a company that later gets its own issuer ends at the broker and at refresh", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "octo@example.test", role: "member", expiresInHours: 24 });
    const signed = await githubSignIn(w, "octo-verified", { company: X });
    expect((await w.access(signed.access)).status).toBe(200);
    w.db.set({ ...w.issuerRow, pk: companyScoped(X, "SIGNIN_ISSUER") });
    expect((await w.access(signed.access)).status).toBe(401);
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
  });

  it("turned off: the broker refuses GitHub tokens, and turned on again later, sessions from before stay ended", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "octo@example.test", role: "member", expiresInHours: 24 });
    const signed = await githubSignIn(w, "octo-verified", { company: X });
    // The CLI too (its token is checked by the broker's own claim check).
    const cli = await githubSignIn(w, "octo-verified", { cli: true });
    expect(await w.cliCheck(cli.access!)).toBe(200);
    w.routes.developer.methods.github = false;
    expect((await w.access(signed.access)).status).toBe(401);
    expect(await w.cliCheck(cli.access!)).toBe(401);
    w.routes.developer.methods.github = true;
    w.tick(120_000);
    w.deps.config.github = { since: Math.floor(w.now() / 1000) - 60 };
    w.routes.developer.since = { ...w.routes.developer.since, github: Math.floor(w.now() / 1000) - 60 };
    expect((await w.access(signed.access)).status).toBe(401);
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
    // Disabled at the sign-in server: no GitHub on the page, and the callback for it answers "expired".
    delete w.deps.config.github;
    const page = await w.http(httpEvent("GET", authorizeQuery({ client_id: "web-app", redirect_uri: WEB })));
    expect(page.body).not.toContain("GitHub");
    expect((await w.http(httpEvent("GET", "/v1/auth/callback/github?code=c&state=s"))).statusCode).toBe(400);
  });

  it("a GitHub CLI session in the built-in company (no shared-method mark) is still refused by the broker once GitHub is off", async () => {
    const w = world();
    await w.operator({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email: "octo@example.test", role: "member", expiresInHours: 24 });
    const cli = await githubSignIn(w, "octo-verified", { cli: true });
    expect(cli.refused).toBeUndefined();
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === gid(1001))).toEqual([expect.not.objectContaining({ installMethod: expect.anything() as unknown })]);
    expect(await w.cliCheck(cli.access!)).toBe(200);
    w.routes.developer.methods.github = false;
    expect(await w.cliCheck(cli.access!)).toBe(401);
    // And with GitHub on but the company layer's switch unset at the broker, the same.
    delete w.routes.developer.methods.github;
    expect(await w.cliCheck(cli.access!)).toBe(401);
  });

  it("a returning GitHub person with no membership is never a legacy member of the built-in company", async () => {
    const w = world();
    // A GitHub sign-in record that is not company-less (as an import or an older write might leave it).
    w.db.set({ pk: `DEVELOPER#${gid(1004)}`, sk: "META", entityType: "DEVELOPER", developerId: gid(1004), provider: "github", issuer: GITHUB_ISSUER, subject: "1004", displayName: "x",
      revoked: false, firstSignInAt: new Date(w.now() - 86_400_000).toISOString(), lastSignInAt: new Date(w.now() - 86_400_000).toISOString() });
    expect((await githubSignIn(w, "octo-second", { cli: true })).refused).toBe("not invited");
    expect(w.db.get(membershipKey(gid(1004)).pk, membershipKey(gid(1004)).sk)).toBeUndefined();
  });

  it("is not offered on the browser review page, and a GitHub email never links a Slack user", async () => {
    const w = world();
    const start = await w.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111"));
    expect(start.body).not.toContain("method=github");
    await w.operator({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email: "octo@example.test", role: "member", expiresInHours: 24 });
    await githubSignIn(w, "octo-verified", { cli: true });
    expect(w.fetch.calls.filter((call) => call.includes("lookupByEmail"))).toEqual([]);
    expect(w.db.get(`DEVELOPER#${gid(1001)}`, "META")).not.toHaveProperty("slackUserId");
  });

  it("a hand-built authorize link naming GitHub for a review-link sign-in is refused before any provider redirect", async () => {
    const w = world();
    const start = await w.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111"));
    const offered = /href="([^"]*request=[^"]*method=(?:slack|oidc))"/.exec(start.body)?.[1];
    expect(offered).toBeDefined();
    const crafted = offered!.replaceAll("&amp;", "&").replace(/method=(slack|oidc)/, "method=github");
    const refused = await w.http(httpEvent("GET", crafted));
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("Sign-in method not available");
    expect(refused.headers.location).toBeUndefined();
    // The request is still unspent: the offered method works from the same page.
    expect((await w.http(httpEvent("GET", offered!.replaceAll("&amp;", "&")))).statusCode).toBe(302);
  });

  it("a GitHub session outside the built-in company without the shared-method mark is refused at refresh", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "octo@example.test", role: "member", expiresInHours: 24 });
    const signed = await githubSignIn(w, "octo-verified", { company: X });
    const [session] = w.db.find((row) => row.entityType === "SESSION" && row.developerId === gid(1001));
    const unmarked = { ...session! }; delete unmarked.installMethod;
    w.db.set(unmarked);
    // Even where the company now has its own issuer (so the unmarked branch would otherwise just check membership).
    w.db.set({ ...w.issuerRow, pk: companyScoped(X, "SIGNIN_ISSUER") });
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
  });

  it("the same GitHub user is the same person after a rename of their login; another user is another person", async () => {
    const w = world();
    await githubSignIn(w, "octo-verified");
    users[0]!.login = "octo-renamed";
    try {
      await githubSignIn(w, "octo-renamed");
      await githubSignIn(w, "octo-second");
    } finally { users[0]!.login = "octo-verified"; }
    expect(w.db.find((row) => row.entityType === "DEVELOPER").map((row) => row.subject).sort()).toEqual(["1001", "1004"]);
  });

  it("neither GitHub's access token nor the client secret is stored or logged", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "octo@example.test", role: "member", expiresInHours: 24 });
    await githubSignIn(w, "octo-verified", { company: X });
    const everything = JSON.stringify([w.db.find(() => true), w.logs]);
    expect(w.gh.state.issued.length).toBeGreaterThan(0);
    for (const token of w.gh.state.issued) expect(everything).not.toContain(token);
    expect(everything).not.toContain(GITHUB_CLIENT_SECRET);
  });
});

describe("GitHub sign-in settings (DEC 254h)", () => {
  const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: "https://x.test/v1/auth" };
  it("is on only for exactly 'enabled', with a usable client id and the secret's name; anything else is a fixed problem", () => {
    expect(developerIdentityConfigFromEnvironment(base)).not.toHaveProperty("github");
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_GITHUB: "Enabled", DEVELOPER_GITHUB_CLIENT_ID: GITHUB_CLIENT_ID, DEVELOPER_GITHUB_SECRET_ID: "s" })).not.toHaveProperty("github");
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_GITHUB: "enabled", DEVELOPER_GITHUB_CLIENT_ID: GITHUB_CLIENT_ID, DEVELOPER_GITHUB_SECRET_ID: "agentx/staging/developer-github", DEVELOPER_GITHUB_SINCE: "1700000000" }))
      .toMatchObject({ github: { since: 1_700_000_000 }, githubSettings: { clientId: GITHUB_CLIENT_ID, secretId: "agentx/staging/developer-github" } });
    for (const env of [{ DEVELOPER_GITHUB_CLIENT_ID: "", DEVELOPER_GITHUB_SECRET_ID: "s" }, { DEVELOPER_GITHUB_CLIENT_ID: "bad id<", DEVELOPER_GITHUB_SECRET_ID: "s" }, { DEVELOPER_GITHUB_CLIENT_ID: GITHUB_CLIENT_ID, DEVELOPER_GITHUB_SECRET_ID: "" }]) {
      const config = developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_GITHUB: "enabled", ...env });
      expect(config).toHaveProperty("github");
      expect(config).not.toHaveProperty("githubSettings");
      expect(config.githubProblem).toMatch(/^DEVELOPER_GITHUB_(CLIENT|SECRET)_ID is not set; ask an admin to run agentx signin enable github$/);
    }
  });
  it("the broker counts GitHub on only with the company layer on too", () => {
    expect(githubSignInFromEnvironment({ DEVELOPER_SIGNIN_GITHUB: "enabled", COMPANY_SIGNIN: "enabled" })).toBe(true);
    expect(githubSignInFromEnvironment({ DEVELOPER_SIGNIN_GITHUB: "enabled" })).toBe(false);
    expect(githubSignInFromEnvironment({ DEVELOPER_SIGNIN_GITHUB: "disabled", COMPANY_SIGNIN: "enabled" })).toBe(false);
  });
  it("reads the client secret from a JSON object and never echoes it", () => {
    expect(parseGithubClientSecret(JSON.stringify({ clientSecret: GITHUB_CLIENT_SECRET }))).toBe(GITHUB_CLIENT_SECRET);
    for (const bad of ["not json", "[]", JSON.stringify({ clientSecret: "" }), JSON.stringify({ secret: "x" })]) {
      expect(() => parseGithubClientSecret(bad)).toThrow();
      try { parseGithubClientSecret(bad); } catch (error) { expect((error as Error).message).not.toContain(GITHUB_CLIENT_SECRET); }
    }
  });
});
