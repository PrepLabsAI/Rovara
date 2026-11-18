// DEC 254w: account linking. A signed-in person connects a second sign-in method (Slack or GitHub) to their OWN person record inside their live
// session; the second method then signs in as the same person (one person, one member record, one role). Real sign-in server, real broker routes,
// fake Slack and GitHub, two companies over one wire-level table.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { AgentXError, SIGN_IN_LINK_TEXT, SLACK_OIDC_ISSUER, type WorkspaceInstance } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
import { routeDeveloperRequest } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { signInLinksThroughLambda } from "../../packages/broker/src/aws/sign-in-link-routes.js";
import { GITHUB_ISSUER, githubSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { API, authorizeQuery, httpEvent, TEAM } from "../support/developer-fakes.js";
import { B, SECRET, WEB, X, person, sharedSignInWorld } from "../support/company-shared-signin-world.js";
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, fakeGithub, type FakeGithubUser } from "../support/fake-github.js";
import { signInRolePolicy, underSignInRole, type TableCall } from "../support/signin-role-policy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

const OTHER = "T0OTHER9";
const githubUsers: FakeGithubUser[] = [
  { id: 2001, login: "octo-link", name: "Octo Link", emails: [{ email: "octo@example.test", primary: true, verified: true }] },
  { id: 2002, login: "octo-two", name: "Octo Two", emails: [{ email: "two@example.test", primary: true, verified: true }] },
];
const slackUsers = [
  { userId: "U0LINKME1", name: "Link Me", email: "octo@example.test" },
  { userId: "U0SOLO001", name: "Solo", email: "solo@example.test" },
  { userId: "U0AWAY001", teamId: OTHER, name: "Away", email: "octo@example.test" },
];
const gid = (id: number) => ownerKeyForSubject(GITHUB_ISSUER, String(id));
const sid = (subject: string) => ownerKeyForSubject(SLACK_OIDC_ISSUER, subject);
const VERIFIER = "l".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const STATE = "cloud-state-0123456789";
const P = gid(2001);

type Api = { status: number; body: Record<string, unknown> };

function world() {
  const w = sharedSignInWorld({ slackUsers });
  const gh = fakeGithub(githubUsers);
  w.deps.config.github = {};
  w.deps.providers.github = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: w.now });
  w.routes.developer.methods.github = true;
  w.routes.developer.signInLinks = signInLinksThroughLambda(async (payload) => ({ Payload: new TextEncoder().encode(JSON.stringify(await w.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) }));
  w.routes.tasks = { workspace: async () => ({ status: "READY" }) as WorkspaceInstance, operations: async () => [], pullRequests: async () => [] } as unknown as DeveloperTaskActions;
  /** A broker call, keeping the refusal's words. */
  const api = async (method: string, path: string, token: string, body?: unknown): Promise<Api> => {
    const request = { method, path, headers: { authorization: `Bearer ${token}` }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(w.routes, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } };
    }
  };
  /** A real GitHub sign-in through the web app. */
  const githubSignIn = async (login: string, opts: { company?: string } = {}): Promise<{ access?: string; refused?: string }> => {
    let response = await w.http(httpEvent("GET", authorizeQuery({ client_id: "web-app", redirect_uri: WEB, ...(opts.company === undefined ? {} : { company: opts.company }) })));
    if (response.statusCode === 200) response = await w.http(httpEvent("GET", /href="([^"]*method=github)"/.exec(response.body)![1]!.replaceAll("&amp;", "&")));
    const providerUrl = response.headers.location!;
    if (!providerUrl.startsWith("https://github.com/")) return { refused: new URL(providerUrl).searchParams.get("error_description") ?? providerUrl };
    const location = new URL((await w.http(httpEvent("GET", gh.approve(providerUrl, login)))).headers.location!);
    const code = location.searchParams.get("code");
    if (code === null) return { refused: location.searchParams.get("error_description") ?? "refused" };
    const tokens = await w.exchange(code, { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
    return { access: tokens.body.access_token as string };
  };
  /** The session's own step-up, as a completed step-up page leaves it (`at` seconds ago). */
  const stepUp = (token: string, ago = 30) => {
    const row = w.db.get(`SESSION#${decodeJwt(token).sid as string}`, "META")!;
    w.db.set({ ...row, stepUpAt: Math.floor(w.now() / 1000) - ago, stepUpMethod: "passkey" });
  };
  const start = (token: string, method: "slack" | "github", overrides: Record<string, unknown> = {}) =>
    api("POST", "/v1/dev/me/sign-ins/link", token, { method, challenge: CHALLENGE, returnTo: WEB, state: STATE, ...overrides });
  /** The browser at the provider and back at Code's callback: Code's redirect to the web app. */
  const atProvider = async (authorizeUrl: string, who: { slack?: string; team?: string; github?: string }) => {
    const callback = who.github !== undefined ? gh.approve(authorizeUrl, who.github) : w.slack.approve(authorizeUrl, who.slack!, who.team === undefined ? {} : { teamId: who.team });
    const answer = await w.http(httpEvent("GET", callback));
    return { callback, answer, location: answer.headers.location === undefined ? undefined : new URL(answer.headers.location) };
  };
  const finish = (token: string, back: URL, verifier = VERIFIER) =>
    api("POST", "/v1/dev/me/sign-ins/link/finish", token, { linkId: back.searchParams.get("link_id"), linkCode: back.searchParams.get("link_code"), verifier });
  /** The whole link, start to finish, in one session. */
  const link = async (token: string, method: "slack" | "github", who: { slack?: string; team?: string; github?: string }) => {
    const started = await start(token, method);
    if (started.status !== 200) return started;
    const { location } = await atProvider(started.body.authorizeUrl as string, who);
    if (location === undefined || location.searchParams.get("link_code") === null) return { status: 0, body: { location: location?.toString() } };
    return finish(token, location);
  };
  /** P: a GitHub person, a member of X (invited by email). */
  const githubMember = async () => {
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "octo@example.test", role: "member", expiresInHours: 24 });
    const signed = await githubSignIn("octo-link", { company: X });
    stepUp(signed.access!);
    return signed.access!;
  };
  /** A Slack sign-in through the web app up to its code (not redeemed yet). */
  const slackCode = async (user: string): Promise<string> => {
    let response = await w.http(httpEvent("GET", authorizeQuery({ client_id: "web-app", redirect_uri: WEB })));
    if (response.statusCode === 200) response = await w.http(httpEvent("GET", /href="([^"]*method=slack)"/.exec(response.body)![1]!.replaceAll("&amp;", "&")));
    const back = await w.http(httpEvent("GET", w.slack.approve(response.headers.location!, user, { teamId: TEAM })));
    return new URL(back.headers.location!).searchParams.get("code")!;
  };
  const redeem = (code: string) => w.exchange(code, { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
  const linkRows = () => w.db.find((row) => row.entityType === "SIGNIN_LINK_ROW");
  const companyLog = (event: string) => w.db.find((row) => row.entityType === "COMPANY_LOG" && row.event === event);
  return Object.assign(w, { slackCode, redeem, gh, api, githubSignIn, stepUp, start, atProvider, finish, link, githubMember, linkRows, companyLog });
}
skipLambdaBundling();

/** The named (staging) control plane, synthesized here (a deployment test may import the CDK). */
function namedControlPlane(): unknown {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!;
  return Template.fromStack(stack).toJSON();
}
const REFUSED = { status: 403, body: { error: { code: "FORBIDDEN", message: SIGN_IN_LINK_TEXT.refused } } };

describe("connecting a second sign-in (DEC 254w)", () => {
  it("happy path: a GitHub person connects their Slack; Slack then signs in as the SAME person, one member record, one role, logged", async () => {
    const w = world();
    const github = await w.githubMember();
    const started = await w.start(github, "slack");
    expect(started.status).toBe(200);
    const authorize = new URL(started.body.authorizeUrl as string);
    expect(authorize.searchParams.get("state")).toBe(started.body.linkId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${API}/v1/auth/callback/slack`);
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    // Back to the web app's own registered URL, with its state and a one-time code (the identity is not attached yet).
    expect(location!.origin + location!.pathname).toBe(WEB);
    expect(location!.searchParams.get("state")).toBe(STATE);
    expect(location!.searchParams.get("link_code")).toMatch(/^lnc_/);
    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).toBeUndefined();
    expect(await w.finish(github, location!)).toEqual({ status: 200, body: { method: "slack" } });

    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).toMatchObject({ provider: "slack", mergedInto: P, revoked: false, linkedBy: P });
    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).not.toHaveProperty("email");
    expect(w.db.get(`DEVELOPER#${P}`, "META")).toMatchObject({ provider: "github", slackUserId: "U0LINKME1", linkedSlackUserId: "U0LINKME1" });
    expect(w.companyLog("company-signin-link")).toEqual([expect.objectContaining({ companyId: X, personId: P, createdBy: P, method: "slack" })]);
    expect((await w.api("GET", "/v1/dev/me/sign-ins", github)).body).toEqual({ signIns: [{ method: "github", primary: true }, { method: "slack", primary: false, linkedAt: expect.any(String) as unknown }] });

    // Slack now signs in as P: the same person, company and role; no second person, membership or session owner.
    const slack = await w.signIn("U0LINKME1", { slackTeam: TEAM });
    expect(slack.refused).toBeUndefined();
    expect(decodeJwt(slack.access!).sub).toBe(P);
    expect((await w.access(slack.access)).body).toMatchObject({ developerId: P, companyId: X, companyRole: "member" });
    expect(w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP").map((row) => row.personId)).not.toContain(sid("U0LINKME1"));
    expect(w.db.get(membershipKey(sid("U0LINKME1")).pk, "COMPANY")).toBeUndefined();
    // A later GitHub sign-in keeps the connected Slack as P's Slack link.
    await w.githubSignIn("octo-link");
    expect(w.db.get(`DEVELOPER#${P}`, "META")).toMatchObject({ slackUserId: "U0LINKME1" });
  });

  it("after linking, a task started from the Slack sign-in shows in the GitHub session's task list (and nobody else's)", async () => {
    const w = world();
    const github = await w.githubMember();
    expect((await w.link(github, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    const slack = await w.signIn("U0LINKME1", { slackTeam: TEAM });
    // The task the Slack session starts is owned by its token's person (developer-tasks.ts: taskIndexKey(caller.developerId, ...)).
    const owner = decodeJwt(slack.access!).sub as string;
    const at = new Date(w.now()).toISOString(), taskId = "22222222-2222-4222-8222-222222222222";
    w.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: owner, provider: "slack", developerName: "Link Me", client: "slack", project: "p", title: "from Slack",
      workspaceId: "w", ownerKey: owner, conversationId: "c", startingRevision: 1, shared: false, createdAt: at, updatedAt: at, companyId: X });
    w.db.set({ pk: `DEVELOPER#${owner}`, sk: `TASK#${at}#${taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId, title: "from Slack", project: "p", status: "CLOSED", shared: false, createdAt: at, updatedAt: at });
    const listed = await w.api("GET", "/v1/dev/tasks", github);
    expect(listed.status).toBe(200);
    expect((listed.body.tasks as Array<{ taskId: string }>).map((task) => task.taskId)).toEqual([taskId]);
    // The owner of X (another person) does not see it.
    const other = await w.signIn("owner");
    expect(((await w.api("GET", "/v1/dev/tasks", other.access!)).body.tasks as unknown[])).toEqual([]);
  });

  it("a GitHub identity can be connected to a Slack person the same way (the design is method-neutral)", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "solo@example.test", role: "member", expiresInHours: 24 });
    const slack = await w.signIn("U0SOLO001", { slackTeam: TEAM, company: X });
    w.stepUp(slack.access!);
    expect(await w.link(slack.access!, "github", { github: "octo-two" })).toEqual({ status: 200, body: { method: "github" } });
    const github = await w.githubSignIn("octo-two");
    expect(decodeJwt(github.access!).sub).toBe(sid("U0SOLO001"));
    expect((await w.access(github.access)).body).toMatchObject({ developerId: sid("U0SOLO001"), companyId: X });
  });
});

describe("what a link refuses, all with the same words (DEC 254w)", () => {
  it("a link started in another session is refused (same person, new session), and spends nothing", async () => {
    const w = world();
    const first = await w.githubMember();
    const started = await w.start(first, "slack");
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    const second = (await w.githubSignIn("octo-link")).access!;
    expect(await w.finish(second, location!)).toEqual(REFUSED);
    expect(w.linkRows()).toEqual([]);
    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).toBeUndefined();
  });

  it("a person of another company cannot finish someone's link, nor read or remove their sign-ins", async () => {
    const w = world();
    const p = await w.githubMember();
    const started = await w.start(p, "slack");
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    const bob = await w.signIn("bob", { company: B });
    expect(bob.refused).toBeUndefined();
    w.stepUp(bob.access!);
    expect(await w.finish(bob.access!, location!)).toEqual(REFUSED);
    expect(w.linkRows()).toEqual([]);
    // Bob is B's admin, not X's: P's sign-ins are not his to see or change.
    expect((await w.api("GET", `/v1/dev/company/members/${P}/sign-ins`, bob.access!)).body).toEqual({ error: { code: "FORBIDDEN", message: SIGN_IN_LINK_TEXT.forbidden } });
    expect((await w.api("DELETE", `/v1/dev/company/members/${P}/sign-ins/slack`, bob.access!)).status).toBe(403);
    // X's owner may read them.
    const owner = await w.signIn("owner");
    expect((await w.api("GET", `/v1/dev/company/members/${P}/sign-ins`, owner.access!)).body).toEqual({ signIns: [{ method: "github", primary: true }] });
  });

  it("a replayed state is refused: the callback twice, and a finish twice", async () => {
    const w = world();
    const p = await w.githubMember();
    const started = await w.start(p, "slack");
    const first = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    // The provider's callback again with the same state: the link was consumed.
    const again = await w.http(httpEvent("GET", w.slack.approve(started.body.authorizeUrl as string, "U0SOLO001", { teamId: TEAM })));
    expect(again.statusCode).toBe(400);
    expect(again.headers.location).toBeUndefined();
    expect(await w.finish(p, first.location!)).toMatchObject({ status: 200 });
    expect(await w.finish(p, first.location!)).toEqual(REFUSED);
    expect(w.linkRows()).toHaveLength(1);
  });

  it("a wrong one-time code or verifier spends the link (one attempt)", async () => {
    const w = world();
    const p = await w.githubMember();
    const started = await w.start(p, "slack");
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    expect(await w.finish(p, location!, "x".repeat(64))).toEqual(REFUSED);
    expect(await w.finish(p, location!)).toEqual(REFUSED);
    const forged = new URL(location!); forged.searchParams.set("link_code", `lnc_${"A".repeat(43)}`);
    const other = await w.start(p, "slack");
    const second = await w.atProvider(other.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    forged.searchParams.set("link_id", second.location!.searchParams.get("link_id")!);
    expect(await w.finish(p, forged)).toEqual(REFUSED);
    expect(w.linkRows()).toEqual([]);
  });

  it("an expired link is refused", async () => {
    const w = world();
    const p = await w.githubMember();
    const started = await w.start(p, "slack");
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    w.tick(301_000);
    w.stepUp(p);
    expect(await w.finish(p, location!)).toEqual(REFUSED);
  });

  it("an identity already linked to another person, or already a person of its own, is refused", async () => {
    const w = world();
    const p = await w.githubMember();
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    const owner = (await w.signIn("owner")).access!;
    w.stepUp(owner);
    expect(await w.link(owner, "slack", { slack: "U0LINKME1", team: TEAM })).toEqual(REFUSED);
    // A Slack person who signed in on their own (and holds a membership elsewhere) is not merged into anyone either.
    await w.operator({ kind: "company-preapprove", companyId: B, email: "solo@example.test", role: "member", expiresInHours: 24 });
    await w.signIn("U0SOLO001", { slackTeam: TEAM });
    expect(await w.link(owner, "slack", { slack: "U0SOLO001", team: TEAM })).toEqual(REFUSED);
    expect(w.db.get(`DEVELOPER#${sid("U0SOLO001")}`, "META")).not.toHaveProperty("mergedInto");
    expect(w.linkRows()).toHaveLength(1);
  });

  it("a Slack identity from a workspace that proves nothing for the company is refused (its email matches, which never links)", async () => {
    const w = world();
    const p = await w.githubMember();
    expect(await w.link(p, "slack", { slack: "U0AWAY001", team: OTHER })).toEqual(REFUSED);
    expect(w.db.get(`DEVELOPER#${sid(`${OTHER}:U0AWAY001`)}`, "META")).toBeUndefined();
    // The same workspace bound to the person's own company proves it.
    w.stepUp(p);
    w.deps.slackTeamCompany = (team) => (team === OTHER ? X : undefined);
    expect(await w.link(p, "slack", { slack: "U0AWAY001", team: OTHER })).toEqual({ status: 200, body: { method: "slack" } });
  });

  it("a company with its own sign-in refuses the install's GitHub", async () => {
    const w = world();
    await w.setup();
    const bob = await w.signIn("bob", { company: B });
    w.stepUp(bob.access!);
    expect(await w.start(bob.access!, "github")).toEqual(REFUSED);
  });

  it("a revoked member, or a revoked person, is refused", async () => {
    const w = world();
    const p = await w.githubMember();
    const started = await w.start(p, "slack");
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    const key = membershipKey(P);
    w.db.set({ ...w.db.get(key.pk, key.sk)!, revokedAt: new Date(w.now()).toISOString() });
    // The broker already refuses the removed member's session; DeveloperIdentity refuses the link itself too.
    expect((await w.finish(p, location!)).status).toBe(401);
    const claims = decodeJwt(p);
    const direct = { kind: "sign-in-link-finish", developerId: claims.sub, sessionId: claims.sid, linkId: location!.searchParams.get("link_id"), linkCode: location!.searchParams.get("link_code"), verifier: VERIFIER };
    expect(await w.handler(direct as never)).toEqual({ ok: false, error: "refused", message: SIGN_IN_LINK_TEXT.refused });
    expect(w.linkRows()).toEqual([]);
    // A revoked person: their own session is no longer live.
    const other = await w.start(p, "slack");
    expect(other.status).toBe(401);
    w.db.set({ ...w.db.get(key.pk, key.sk)!, revokedAt: undefined });
    w.db.set({ ...w.db.get(`DEVELOPER#${P}`, "META")!, revoked: true });
    expect(await w.handler({ ...direct, linkId: `lnk_${"B".repeat(43)}` } as never)).toMatchObject({ ok: false, error: "signed_out" });
  });

  it("starting needs a fresh step-up and the web app's own client and registered return URL; a method the person already has is refused", async () => {
    const w = world();
    const p = await w.githubMember();
    w.stepUp(p, 3_600);
    expect((await w.start(p, "slack")).body).toEqual({ error: { code: "REAUTH_REQUIRED", message: SIGN_IN_LINK_TEXT.reauth } });
    w.stepUp(p);
    expect(await w.start(p, "slack", { returnTo: "https://evil.example.test/callback" })).toEqual(REFUSED);
    expect(await w.start(p, "github")).toEqual(REFUSED);
    expect(w.db.find((row) => row.entityType === "SIGNIN_LINK")).toEqual([]);
  });

  it("a second identity for a method the person already connected is refused, at start and at finish", async () => {
    const w = world();
    const p = await w.githubMember();
    const pending = await w.start(p, "slack");
    const { location } = await w.atProvider(pending.body.authorizeUrl as string, { slack: "U0SOLO001", team: TEAM });
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    expect(await w.start(p, "slack")).toEqual(REFUSED);
    // A link started before the first one finished cannot add a second Slack.
    expect(await w.finish(p, location!)).toEqual(REFUSED);
    expect(w.linkRows()).toHaveLength(1);
    expect(w.db.get(`DEVELOPER#${sid("U0SOLO001")}`, "META")).toBeUndefined();
  });

  it("a Slack identity when the person already holds another Slack user is refused; a callback on another method's path is refused", async () => {
    const w = world();
    const p = await w.githubMember();
    w.db.set({ ...w.db.get(`DEVELOPER#${P}`, "META")!, slackUserId: "U0SOLO001" });
    expect(await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).toEqual(REFUSED);
    const started = await w.start(p, "slack");
    const callback = new URL(w.slack.approve(started.body.authorizeUrl as string, "U0LINKME1", { teamId: TEAM }));
    callback.pathname = callback.pathname.replace("/callback/slack", "/callback/github");
    const answer = await w.http(httpEvent("GET", callback.toString()));
    expect(answer.statusCode).toBe(400);
    expect(answer.headers.location).toBeUndefined();
  });

  it("an install-workspace Slack identity is refused when that workspace is bound to another company", async () => {
    const w = world();
    const p = await w.githubMember();
    w.deps.slackTeamCompany = (team) => (team === TEAM ? B : undefined);
    expect(await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).toEqual(REFUSED);
  });

  it("only the web app's own sign-in client starts a link (never the CLI's session)", async () => {
    const w = world();
    await w.githubMember();
    const cli = await w.signIn("owner", { cli: true });
    expect(cli.refused).toBeUndefined();
    w.stepUp(cli.access!);
    expect(await w.start(cli.access!, "slack")).toEqual(REFUSED);
  });

  it("a session that is not live is told to sign in again", async () => {
    const w = world();
    const p = await w.githubMember();
    const row = w.db.get(`SESSION#${decodeJwt(p).sid as string}`, "META")!;
    w.db.set({ ...row, revokedAt: new Date(w.now()).toISOString() });
    expect((await w.start(p, "slack")).status).toBe(401);
  });
});

describe("DeveloperIdentity checks every link request itself (not only the broker)", () => {
  const ids = (token: string) => { const claims = decodeJwt(token); return { developerId: claims.sub as string, sessionId: claims.sid as string }; };

  it("a session that is someone else's, revoked, expired or ended by an admin is signed out", async () => {
    const w = world();
    const p = await w.githubMember();
    const owner = (await w.signIn("owner")).access!;
    const list = (developerId: string, sessionId: string) => w.handler({ kind: "sign-in-links-list", developerId, sessionId, personDeveloperId: developerId } as never);
    expect(await list(ids(p).developerId, ids(p).sessionId)).toMatchObject({ ok: true });
    expect(await list(ids(p).developerId, ids(owner).sessionId)).toMatchObject({ ok: false, error: "signed_out" });
    const key = `SESSION#${ids(p).sessionId}`;
    const row = w.db.get(key, "META")!;
    w.db.set({ ...row, endsAt: Math.floor(w.now() / 1000) - 1 });
    expect(await list(ids(p).developerId, ids(p).sessionId)).toMatchObject({ ok: false, error: "signed_out" });
    w.db.set({ ...row, revokedAt: new Date(w.now()).toISOString() });
    expect(await list(ids(p).developerId, ids(p).sessionId)).toMatchObject({ ok: false, error: "signed_out" });
    w.db.set(row);
    w.db.set({ ...w.db.get(`DEVELOPER#${P}`, "META")!, sessionsEndedAt: new Date(w.now() + 1_000).toISOString() });
    expect(await list(ids(p).developerId, ids(p).sessionId)).toMatchObject({ ok: false, error: "signed_out" });
  });

  it("a full-access client that is not the web app cannot start a link", async () => {
    const w = world();
    const p = await w.githubMember();
    const row = w.db.get(`SESSION#${ids(p).sessionId}`, "META")!;
    const client = w.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!;
    w.db.set({ ...client, sk: "CLIENT#tool-app", clientId: "tool-app", audience: "tool-app", name: "Tool", webApp: undefined });
    w.db.set({ ...row, clientId: "tool-app" });
    const answer = await w.handler({ kind: "sign-in-link-start", ...ids(p), method: "slack", challenge: CHALLENGE, returnTo: WEB, state: STATE } as never);
    expect(answer).toEqual({ ok: false, error: "refused", message: SIGN_IN_LINK_TEXT.refused });
  });

  it("a link whose person moved company before finishing is refused", async () => {
    const w = world();
    const p = await w.githubMember();
    const started = await w.start(p, "slack");
    const { location } = await w.atProvider(started.body.authorizeUrl as string, { slack: "U0LINKME1", team: TEAM });
    // A third company with no sign-in of its own (so only the company binding refuses).
    const C = "org_cccccccccccccccccccc";
    await w.operator({ kind: "company-create", name: "Charlie", firstAdminEmail: "dana@example.test", expiresInHours: 24 }, C);
    const key = membershipKey(P);
    w.db.set({ ...w.db.get(key.pk, key.sk)!, companyId: C });
    const answer = await w.handler({ kind: "sign-in-link-finish", ...ids(p), linkId: location!.searchParams.get("link_id"), linkCode: location!.searchParams.get("link_code"), verifier: VERIFIER } as never);
    expect(answer).toEqual({ ok: false, error: "refused", message: SIGN_IN_LINK_TEXT.refused });
    expect(w.linkRows()).toEqual([]);
  });

  it("a company with its own sign-in: GitHub is refused even when its Slack workspace is bound to it; that Slack may be linked", async () => {
    const w = world();
    await w.setup();
    w.deps.slackTeamCompany = (team) => (team === TEAM ? B : undefined);
    const bob = (await w.signIn("bob", { company: B })).access!;
    w.stepUp(bob);
    expect(await w.start(bob, "github")).toEqual(REFUSED);
    expect(await w.link(bob, "slack", { slack: "U0LINKME1", team: TEAM })).toEqual({ status: 200, body: { method: "slack" } });
  });
});

describe("unlinking (DEC 254w)", () => {
  it("the first (here the only) method can never be removed", async () => {
    const w = world();
    const p = await w.githubMember();
    expect((await w.api("DELETE", "/v1/dev/me/sign-ins/github", p)).body).toEqual({ error: { code: "FORBIDDEN", message: SIGN_IN_LINK_TEXT.lastMethod } });
    expect((await w.api("DELETE", "/v1/dev/me/sign-ins/slack", p)).body).toEqual({ error: { code: "NOT_FOUND", message: SIGN_IN_LINK_TEXT.notFound } });
  });

  it("the person removes a connected method with a fresh step-up: every session ends, the identity is no longer theirs, and it is logged", async () => {
    const w = world();
    const p = await w.githubMember();
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    w.stepUp(p, 3_600);
    expect((await w.api("DELETE", "/v1/dev/me/sign-ins/slack", p)).status).toBe(403);
    w.stepUp(p);
    w.tick(1_000);
    expect(await w.api("DELETE", "/v1/dev/me/sign-ins/slack", p)).toEqual({ status: 200, body: { removed: true } });
    expect(w.linkRows()).toEqual([]);
    // DEC 254zzz33 (4): the linked identity's record is kept (never deleted), no longer pointing at P, with when and from whom it was unlinked.
    const unlinked = w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")!;
    expect(unlinked).toMatchObject({ revoked: false, unlinkedFrom: P, unlinkedAt: expect.any(String) as unknown, companyless: true });
    expect(unlinked).not.toHaveProperty("mergedInto");
    expect(w.db.find((row) => row.pk === `DEVELOPER#${sid("U0LINKME1")}`)).toHaveLength(1);
    const record = w.db.get(`DEVELOPER#${P}`, "META")!;
    expect(record).not.toHaveProperty("slackUserId");
    expect(record).not.toHaveProperty("linkedSlackUserId");
    expect(record.sessionsEndedAt).toEqual(expect.any(String));
    expect(w.companyLog("company-signin-unlink")).toEqual([expect.objectContaining({ companyId: X, personId: P, createdBy: P, method: "slack" })]);
    expect((await w.api("GET", "/v1/dev/me/sign-ins", p)).status).toBe(401);
    // Slack is a stranger again: it signs in as nobody's person (no company), never as P.
    const slack = await w.signIn("U0LINKME1", { slackTeam: TEAM });
    expect(decodeJwt(slack.access!).sub).toBe(sid("U0LINKME1"));
    // DEC 254zzz33 (review H1): the kept record joins NO company: no membership row (never a "legacy" seat in the built-in company), and its session names no company.
    expect(w.db.get(membershipKey(sid("U0LINKME1")).pk, "COMPANY")).toBeUndefined();
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === sid("U0LINKME1") && row.revokedAt === undefined)).toEqual([expect.not.objectContaining({ companyId: expect.anything() as unknown })]);
  });

  it("a code (or a session) made by the removed method before the unlink never becomes or stays a session", async () => {
    const w = world();
    const p = await w.githubMember();
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    const pending = await w.slackCode("U0LINKME1");
    const slackSession = await w.signIn("U0LINKME1", { slackTeam: TEAM });
    expect(w.db.find((row) => row.entityType === "SESSION" && row.signedInId === sid("U0LINKME1"))).not.toEqual([]);
    w.stepUp(p);
    expect((await w.api("DELETE", "/v1/dev/me/sign-ins/slack", p)).status).toBe(200);
    expect((await w.redeem(pending)).status).toBe(400);
    expect((await w.refresh(slackSession.refresh!)).status).toBe(400);
    // The same walk refuses even without the session end (a merge undone by other means).
    const w2 = world();
    const p2 = await w2.githubMember();
    expect((await w2.link(p2, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    const code2 = await w2.slackCode("U0LINKME1");
    const second = await w2.signIn("U0LINKME1", { slackTeam: TEAM });
    w2.db.set({ ...w2.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")!, mergedInto: person("owner") });
    expect((await w2.redeem(code2)).status).toBe(400);
    expect((await w2.refresh(second.refresh!)).status).toBe(400);
  });

  it("unlinking an identity an admin turned off keeps it turned off", async () => {
    const w = world();
    const p = await w.githubMember();
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    w.db.set({ ...w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")!, revoked: true });
    w.stepUp(p);
    expect((await w.api("DELETE", "/v1/dev/me/sign-ins/slack", p)).status).toBe(200);
    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).toMatchObject({ revoked: true, unlinkedFrom: P });
    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).not.toHaveProperty("mergedInto");
    expect((await w.signIn("U0LINKME1", { slackTeam: TEAM })).refused).toBeDefined();
  });

  it("an admin cannot remove an owner's connected method; only an owner can", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "admin", expiresInHours: 24 });
    const carol = (await w.signIn("carol", { company: X })).access!;
    const owner = (await w.signIn("owner")).access!;
    w.stepUp(owner);
    expect((await w.link(owner, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    w.stepUp(carol);
    expect((await w.api("DELETE", `/v1/dev/company/members/${person("owner")}/sign-ins/slack`, carol)).body).toEqual({ error: { code: "FORBIDDEN", message: SIGN_IN_LINK_TEXT.forbidden } });
    expect(w.linkRows()).toHaveLength(1);
  });

  it("a company owner removes a member's connected method; a plain member cannot", async () => {
    const w = world();
    const p = await w.githubMember();
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "member", expiresInHours: 24 });
    const carol = (await w.signIn("carol", { company: X })).access!;
    w.stepUp(carol);
    expect((await w.api("DELETE", `/v1/dev/company/members/${P}/sign-ins/slack`, carol)).status).toBe(403);
    const owner = (await w.signIn("owner")).access!;
    w.stepUp(owner);
    expect((await w.api("DELETE", `/v1/dev/company/members/${P}/sign-ins/slack`, owner)).status).toBe(200);
    expect(w.companyLog("company-signin-unlink")).toEqual([expect.objectContaining({ personId: P, createdBy: person("owner") })]);
  });
});

// DEC 254zzz33: on staging the sign-in role refused a link's finish (ConditionCheckItem), the connected list (Query SIGNIN_LINKS#) and an unlink (DeleteItem). Here the whole flow runs
// over a client that answers as DynamoDB would for the sign-in role of the synthesized named control plane (the broker's own sign-in table reads here are GetItem only, a subset).
describe("a link, the list and an unlink under the synthesized sign-in role (DEC 254zzz33)", () => {
  it("every sign-in table call is allowed, and the unlink deletes only the link row (the linked identity's record is kept)", async () => {
    const policy = signInRolePolicy({ template: namedControlPlane() });
    const w = world();
    const seen: Array<TableCall & { allowed: boolean }> = [];
    const wrapped = underSignInRole({ send: w.db.send.bind(w.db) }, policy, "signin", seen);
    (w.db as unknown as { send: unknown }).send = wrapped.send;
    const p = await w.githubMember();
    expect((await w.link(p, "slack", { slack: "U0LINKME1", team: TEAM })).status).toBe(200);
    expect((await w.api("GET", "/v1/dev/me/sign-ins", p)).status).toBe(200);
    w.stepUp(p);
    expect(await w.api("DELETE", "/v1/dev/me/sign-ins/slack", p)).toEqual({ status: 200, body: { removed: true } });
    const shape = (call: TableCall) => `${call.action} ${call.pk.replace(/org_[0-9a-z]{20}/gu, "<org>").replace(/[a-f0-9]{64}|[0-9a-f-]{36}/gu, "<id>")}`;
    expect(seen.filter((call) => !call.allowed).map(shape)).toEqual([]);
    const shapes = new Set(seen.map(shape));
    for (const needed of ["dynamodb:ConditionCheckItem COMPANY_MEMBER#<id>", "dynamodb:ConditionCheckItem SESSION#<id>",
      "dynamodb:Query SIGNIN_LINKS#<id>", "dynamodb:DeleteItem SIGNIN_LINKS#<id>"]) expect(shapes, needed).toContain(needed);
    // The only delete is the link row; the linked identity's DEVELOPER# record is updated, never deleted.
    expect([...shapes].filter((one) => one.startsWith("dynamodb:DeleteItem"))).toEqual(["dynamodb:DeleteItem SIGNIN_LINKS#<id>"]);
    // Before this change (the template without SignInCompanyGrants) each of these was AccessDenied: the staging failures.
    const template = structuredClone(policy.template);
    for (const id of Object.keys(template.Resources).filter((one) => /^DeveloperSignInSignInCompanyGrants[0-9A-F]{8}$/u.test(one))) delete template.Resources[id];
    const before = signInRolePolicy({ template });
    const added = ["dynamodb:ConditionCheckItem", "dynamodb:Query", "dynamodb:DeleteItem"];
    const newCalls = seen.filter((call) => added.includes(call.action) && !(call.action === "dynamodb:Query" && call.pk.startsWith("SIGNIN_CLIENTS")));
    expect(newCalls.length).toBeGreaterThan(0);
    for (const call of newCalls) expect(before.allows(call), shape(call)).toBe(false);
    expect(w.db.get(`DEVELOPER#${sid("U0LINKME1")}`, "META")).toMatchObject({ unlinkedFrom: P });
  }, 120_000);
});
