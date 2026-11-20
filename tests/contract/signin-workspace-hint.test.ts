// L4-SIGNIN: the Slack workspace hint on Sign in with Slack (https://docs.slack.dev/authentication/sign-in-with-slack/, the `team` parameter of
// slack.com/openid/connect/authorize). The hint is only a convenience: it decides which workspace Slack's own page opens on, never who is signed in.
// Who is signed in is read from Slack's verified ID token exactly as before; the hint never reaches `complete`.
import { describe, expect, it } from "vitest";
import { slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { API, authorizeQuery, fakeSlack, httpEvent, routeFetch, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, T0 } from "../support/developer-fakes.js";
import { sharedSignInWorld, WEB } from "../support/company-shared-signin-world.js";
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

});

void API;
