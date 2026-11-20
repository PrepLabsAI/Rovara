// L4-SIGNIN: the Slack workspace hint on Sign in with Slack (https://docs.slack.dev/authentication/sign-in-with-slack/, the `team` parameter of
// slack.com/openid/connect/authorize). The hint is only a convenience: it decides which workspace Slack's own page opens on, never who is signed in.
// Who is signed in is read from Slack's verified ID token exactly as before; the hint never reaches `complete`.
import { describe, expect, it } from "vitest";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { SLACK_OIDC_ISSUER, newCompanyInviteCode } from "@agentx/contracts";
import { slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { API, authorizeQuery, fakeSlack, httpEvent, routeFetch, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, T0 } from "../support/developer-fakes.js";
import { B, person, SECRET, sharedSignInWorld, WEB, X } from "../support/company-shared-signin-world.js";
import { githubSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, fakeGithub } from "../support/fake-github.js";

const OTHER = "T0OTHER9";
const HINT = "T0HINT0001";
const redirectUri = "https://signin.example.test/v1/auth/callback/slack";
const slackUsers = [{ userId: "U0NEW0001", teamId: OTHER, name: "New Person", email: "new@other.test" }, { userId: "U0INSTALL", name: "Install Person", email: "install@example.test" }];
const BAD_HINTS = [
  ["lowercase", "t0hint0001"], ["no T", "X0HINT0001"], ["too short", "T0HIN"], ["too long", "T0HINT00010000000"], ["an enterprise id", "E0HINT0001"],
  ["a query injection", "T0HINT0001&redirect_uri=https://evil.example"], ["a space", "T0HINT 0001"], ["a url", "https://evil.example/T0HINT0001"], ["empty", ""], ["lowercase letters inside", "T0hint0001"],
  ["a newline", "T0HINT0001\n"], ["a path", "T0HINT/../01"],
] as const;

function provider(anyWorkspace: boolean) {
  const slack = fakeSlack({ users: slackUsers, now: () => T0 });
  const make = slackSignInProvider({ ...(anyWorkspace ? { anyWorkspace: true } : {}), teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(slack.handler), jwks: slack.jwks, now: () => T0 });
  return { slack, make };
}
const teamOf = (url: string) => new URL(url).searchParams.get("team");

describe("Sign in with Slack's authorize link", () => {

  it.each(BAD_HINTS)("any-workspace sign-in: a bad hint (%s) is dropped, never sent", async (_case, bad) => {
    const { make } = provider(true);
    const url = await make.authorizeUrl({ state: "s", nonce: "n", redirectUri, workspaceHint: bad });
    expect(teamOf(url)).toBeNull();
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ response_type: "code", scope: "openid email profile", client_id: SLACK_CLIENT_ID, state: "s", nonce: "n", redirect_uri: redirectUri });
  });

  it("a one-workspace install still refuses another workspace, hint or not", async () => {
    const { slack, make } = provider(false);
    const url = await make.authorizeUrl({ state: "s", nonce: "n", redirectUri, workspaceHint: OTHER });
    const code = new URL(slack.approve(url, "U0NEW0001", { teamId: OTHER })).searchParams.get("code")!;
    expect(await make.complete({ code, nonce: "n", redirectUri })).toMatchObject({ ok: false, wrongAccount: true });
  });
});

/** The shared world: the install's Slack takes any workspace (company layer on), OIDC and GitHub are on too. */
function world() {
  const w = sharedSignInWorld({ slackUsers });
  const gh = fakeGithub([{ id: 1001, login: "octo", name: "Octo", emails: [{ email: "octo@example.test", primary: true, verified: true }] }]);
  w.deps.config.github = {};
  w.deps.providers.github = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: w.now });
  w.routes.developer.methods.github = true;
  return w;
}
const webQuery = (extra: Record<string, string> = {}) => authorizeQuery({ client_id: "web-app", redirect_uri: WEB, ...extra });
const slackLink = (body: string) => /href="([^"]*method=slack[^"]*)"/.exec(body)?.[1]?.replaceAll("&amp;", "&");

describe("the sign-in server's authorize (slack_team)", () => {
  it("a valid slack_team rides on the method page's Slack link and reaches Slack as `team`", async () => {
    const w = world();
    const page = await w.http(httpEvent("GET", webQuery({ slack_team: HINT })));
    expect(page.statusCode).toBe(200);
    expect(slackLink(page.body)).toContain(`slack_team=${HINT}`);
    expect(page.body).not.toMatch(/method=oidc[^"]*slack_team/u);
    expect(page.body).not.toMatch(/method=github[^"]*slack_team/u);
    const next = await w.http(httpEvent("GET", slackLink(page.body)!));
    expect(next.statusCode).toBe(302);
    expect(next.headers.location).toMatch(/^https:\/\/slack\.com\/openid\/connect\/authorize\?/u);
    expect(teamOf(next.headers.location!)).toBe(HINT);
  });

  it.each(BAD_HINTS)("a bad slack_team (%s) is dropped from the page and from Slack's link", async (_case, bad) => {
    const w = world();
    const page = await w.http(httpEvent("GET", webQuery({ slack_team: bad })));
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("slack_team");
    const next = await w.http(httpEvent("GET", slackLink(page.body)!));
    expect(teamOf(next.headers.location!)).toBeNull();
    expect(next.headers.location).not.toContain("evil.example");
  });

  it("method=slack goes straight to Slack with the hint (no method page)", async () => {
    const w = world();
    const response = await w.http(httpEvent("GET", webQuery({ method: "slack", slack_team: HINT })));
    expect(response.statusCode).toBe(302);
    expect(teamOf(response.headers.location!)).toBe(HINT);
    const bare = await w.http(httpEvent("GET", webQuery({ method: "slack" })));
    expect(bare.statusCode).toBe(302);
    expect(teamOf(bare.headers.location!)).toBeNull();
  });

  it("method=github goes straight to GitHub, and the Slack hint is not sent there", async () => {
    const w = world();
    const response = await w.http(httpEvent("GET", webQuery({ method: "github", slack_team: HINT })));
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/u);
    expect(response.headers.location).not.toContain(HINT);
  });

  it.each([["an unknown method", "facebook"]])("%s is refused without sending anyone anywhere", async (_case, method) => {
    const w = world();
    const response = await w.http(httpEvent("GET", webQuery({ method })));
    expect(response.statusCode).not.toBe(302);
    expect(response.headers.location).toBeUndefined();
  });

});

describe("what the web app is told: the offer and the person's own workspace", () => {
  it("the sign-in server's configuration lists GitHub only when GitHub is on", async () => {
    const w = world();
    const on = JSON.parse((await w.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body) as { methods: Record<string, unknown> };
    expect(on.methods.github).toEqual({ displayName: "GitHub" });
    expect(on.methods.slack).toBe(true);
    delete w.deps.config.github;
    const off = JSON.parse((await w.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body) as { methods: Record<string, unknown> };
    expect(off.methods.github ?? null).toBeNull();
  });

  it("the access check names the Slack workspace of a Slack sign-in, and only that", async () => {
    const w = world();
    const slackSession = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect((await w.access(slackSession.access)).body).toMatchObject({ slackTeamId: OTHER });
    const installSession = await w.signIn("U0INSTALL", { slackTeam: TEAM });
    expect((await w.access(installSession.access)).body).toMatchObject({ slackTeamId: TEAM });
    const oidcSession = await w.signIn("owner");
    expect((await w.access(oidcSession.access)).body).not.toHaveProperty("slackTeamId");
  });

  it("a merged Slack sign-in stores its verified workspace only on its identity and returns it for the survivor", async () => {
    const w = world();
    await w.setup();
    const id = ownerKeyForSubject(SLACK_OIDC_ISSUER, `${OTHER}:U0NEW0001`);
    const identity = { pk: `DEVELOPER#${id}`, sk: "META", entityType: "DEVELOPER", developerId: id, provider: "slack", issuer: SLACK_OIDC_ISSUER,
      subject: `${OTHER}:U0NEW0001`, displayName: "Kept name", email: "kept@example.test", revoked: false, mergedInto: person("owner"),
      firstSignInAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
    w.db.set(identity);
    const survivor = w.db.get(`DEVELOPER#${person("owner")}`, "META");
    const signed = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect(signed.refused).toBeUndefined();
    expect((await w.access(signed.access)).body).toMatchObject({ developerId: person("owner"), companyId: X, companyRole: "owner", slackTeamId: OTHER });
    const stored = w.db.get(`DEVELOPER#${id}`, "META")!;
    expect(stored.slackTeamId).toBe(OTHER);
    const rest = { ...stored };
    delete rest.slackTeamId;
    delete rest.slackTeamName;
    expect(rest).toEqual(identity);
    expect(w.db.get(`DEVELOPER#${person("owner")}`, "META")).toEqual(survivor);
    const refreshed = await w.refresh(signed.refresh!);
    expect(refreshed.status).toBe(200);
    expect((await w.access(refreshed.body.access_token as string)).body).toMatchObject({ slackTeamId: OTHER });
    expect((await w.access((await w.signIn("owner")).access)).body).not.toHaveProperty("slackTeamId");
  });

  it("a merged Slack sign-in still succeeds when saving its workspace hint fails (a throttle or a racing unlink): the hint is never a gate", async () => {
    const w = world();
    await w.setup();
    const id = ownerKeyForSubject(SLACK_OIDC_ISSUER, `${OTHER}:U0NEW0001`);
    const identity = { pk: `DEVELOPER#${id}`, sk: "META", entityType: "DEVELOPER", developerId: id, provider: "slack", issuer: SLACK_OIDC_ISSUER,
      subject: `${OTHER}:U0NEW0001`, displayName: "Kept name", email: "kept@example.test", revoked: false, mergedInto: person("owner"),
      firstSignInAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
    w.db.set(identity);
    const send = w.db.send.bind(w.db);
    let refused = 0;
    w.db.send = async (command: { input?: { UpdateExpression?: string; Key?: { pk?: string } } }) => {
      if (command.input?.Key?.pk === `DEVELOPER#${id}` && command.input.UpdateExpression?.startsWith("SET slackTeamId")) {
        refused += 1;
        throw Object.assign(new Error("Rate exceeded"), { name: "ProvisionedThroughputExceededException" });
      }
      return send(command as never);
    };
    const signed = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect(refused).toBe(1);
    expect(signed.refused).toBeUndefined();
    expect((await w.access(signed.access)).body).toMatchObject({ developerId: person("owner"), companyId: X, companyRole: "owner" });
    expect(w.db.get(`DEVELOPER#${id}`, "META")).toEqual(identity);
  });

  it.each(["another person", "unlinked", "revoked"] as const)("a stored session never returns a workspace from an identity that is %s", async (change) => {
    const w = world();
    await w.setup();
    const id = ownerKeyForSubject(SLACK_OIDC_ISSUER, `${OTHER}:U0NEW0001`);
    await w.signIn("U0NEW0001", { slackTeam: OTHER });
    const identity = w.db.get(`DEVELOPER#${id}`, "META")!;
    w.db.set({ ...identity, mergedInto: person("owner") });
    const signed = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect(signed.refused).toBeUndefined();
    // A survivor can have its own, different Slack sign-in. It must not supply this session's hint either.
    w.db.set({ ...w.db.get(`DEVELOPER#${person("owner")}`, "META")!, slackTeamId: TEAM });
    if (change === "another person") {
      expect((await w.signIn("bob", { company: B })).refused).toBeUndefined();
      w.db.set({ ...identity, mergedInto: person("bob") });
    }
    if (change === "unlinked") w.db.set(identity);
    if (change === "revoked") w.db.set({ ...identity, mergedInto: person("owner"), revoked: true });
    const answer = await w.access(signed.access);
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty("slackTeamId");
  });

  it("a client's own check on a person's behalf (client secret + developer id) never names the workspace", async () => {
    const w = world();
    const first = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    const id = ownerKeyForSubject(SLACK_OIDC_ISSUER, `${OTHER}:U0NEW0001`);
    const made = newCompanyInviteCode();
    await w.operator({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24 });
    expect((await w.call("POST", "/v1/dev/company", first.access, { name: "Other Co", inviteCode: made.code })).status).toBe(200);
    const slackSession = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect((await w.access(slackSession.access)).body).toMatchObject({ slackTeamId: OTHER, companyRole: "owner" });
    const basic = `Basic ${Buffer.from(`web-app:${SECRET}`).toString("base64")}`;
    const answer = await w.callWith("POST", "/v1/dev/access", basic, { developerId: id });
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty("slackTeamId");
  });

  it("the access check leaves the workspace out when the stored one is not a Slack workspace id", async () => {
    const w = world();
    const slackSession = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    const id = ownerKeyForSubject(SLACK_OIDC_ISSUER, `${OTHER}:U0NEW0001`);
    w.db.set({ ...w.db.get(`DEVELOPER#${id}`, "META")!, slackTeamId: "not a team" });
    const body = (await w.access(slackSession.access)).body;
    expect(body).not.toHaveProperty("slackTeamId");
    expect(body).toMatchObject({ developerId: id });
  });
});

describe("an access rule cannot set or clear the workspace", () => {
  it("keeps Code's record whatever a rule answers", async () => {
    const w = world();
    const signed = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    w.routes.developer.accessRules = [async () => ({ administrator: false, projects: [], slackTeamId: "T0EVIL001" }) as never];
    expect((await w.access(signed.access)).body).toMatchObject({ slackTeamId: OTHER });
  });
});

void API;
