// DEC 254b: the shared world for the sign-in-by-membership tests. Two companies over one wire-level table and the real sign-in server and broker
// checks: X made by self-serve (no issuer), B with its own issuer (the same IdP URL as the install's).
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { expect } from "vitest";
import { AgentXError, companyScoped, newCompanyInviteCode } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { authenticateDeveloper, companyPreapprovalsThroughLambda, companySelfCreateThroughLambda, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { CompanyInviteStore } from "../../packages/broker/src/developer/company-invites.js";
import { companyIssuerProvider } from "../../packages/broker/src/developer/company-issuer.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import type { DeveloperIdentityDependencies } from "../../packages/broker/src/developer/server.js";
import { slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { httpEvent, identityHarness, ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, type FakeOidcUser, type FakeSlackUser } from "./developer-fakes.js";

export const WEB = "https://cloud.example.test/callback";
export const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
export const X = COMPANY_A.orgId, B = COMPANY_B.orgId;
export const person = (subject: string) => ownerKeyForSubject(OIDC_ISSUER, subject);
export const OWN_SIGNIN = "your company signs in with its own sign-in method";
type Answer = { status: number; body: Record<string, unknown> };

function buildWorld(options: { administrator?: boolean; slackUsers?: FakeSlackUser[]; stepUp?: DeveloperIdentityDependencies["stepUp"] } = {}) {
  const users: FakeOidcUser[] = ["owner", "carol", "bob", "dana", "legacy", "erin", "frank"].map((sub) => ({ sub, email: `${sub}@example.test`, email_verified: true, name: `${sub} person`, groups: ["admins"] }));
  // DEC 254h: a person whose identity carries no email at all.
  users.push({ sub: "noemail", name: "No Email", groups: ["admins"] });
  const h = identityHarness({ oidc: options.administrator === true ? { administrator: { claim: "groups", values: ["admins"] } } : {}, oidcUsers: users, slackUsers: options.slackUsers ?? [], ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }) });
  // As production wires it with the company layer on (DEC 254e): the install's Slack app takes any workspace.
  h.deps.providers.slack = slackSignInProvider({ anyWorkspace: true, teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: h.fetch, jwks: h.slack.jwks, now: h.now });
  const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  const invites = new CompanyInviteStore({ documentClient: h.db, tableName: "signin", now: h.now, company, selfServeAllowed: true, newCompanyId: () => X });
  h.deps.company = company; h.deps.companyInvites = invites;
  // B's own issuer: the same IdP URL and client as the install's (the hardest no-downgrade case); its secret is read by B's own name.
  h.deps.companyIssuer = companyIssuerProvider({ store: company, env: h.deps.config.env, readSecret: async () => OIDC_CLIENT_SECRET, fetch: h.fetch, jwksFor: () => h.oidc.jwks, now: h.now });
  const before = new Date(h.now() - 86_400_000).toISOString();
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Rovara", audience: "web-app", redirectUris: [WEB], loopback: false,
    installLevel: true, fullAccess: true, webApp: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: before, updatedAt: before, updatedBy: "operator" });
  const operator = (event: unknown, newCompanyId = B) => companyOperator({ store: company, invites, now: h.now, log: h.deps.log, newCompanyId: () => newCompanyId }, event);
  const issuerRow = { pk: companyScoped(B, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, displayName: "B sign-in", requiredValues: [], enabled: true, enabledSince: h.now() / 1000 - 60 };
  /** A real sign-in: through the web app (default) or the CLI, naming a company or not; the install's OIDC, or Slack from a workspace. */
  const signIn = async (subject: string, opts: { cli?: boolean; company?: string; slackTeam?: string; invite?: string } = {}) => {
    const query = { ...(opts.cli === true ? {} : { client_id: "web-app", redirect_uri: WEB }), ...(opts.company === undefined ? {} : { company: opts.company }), ...(opts.invite === undefined ? {} : { invite: opts.invite }) };
    const back = opts.slackTeam === undefined ? await h.signIn("oidc", subject, { query }) : await h.signIn("slack", subject, { query, teamId: opts.slackTeam });
    const grant = back.searchParams.get("code");
    if (grant === null) return { refused: back.searchParams.get("error_description") ?? back.toString() };
    const tokens = await h.exchange(grant, opts.cli === true ? {} : { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
    if (tokens.status !== 200) return { refused: `exchange ${tokens.status}` };
    return { access: tokens.body.access_token as string, refresh: tokens.body.refresh_token as string, refused: undefined };
  };
  const refresh = async (token: string, cli = false) => {
    if (cli) return h.refresh(token);
    const response = await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "refresh_token", client_id: "web-app", client_secret: SECRET, refresh_token: token }));
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const routes: DeveloperRouteDependencies = {
    documentClient: h.db, tableName: "State", now: h.now, companies: companyMembershipFromDynamo(h.db, "signin"),
    developer: {
      issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true }, signInTableName: "signin",
      verifyAccessToken: async (authorization) => decodeJwt(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? ""),
      channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      companyPreapprovals: companyPreapprovalsThroughLambda(async (payload) => ({ Payload: new TextEncoder().encode(JSON.stringify(await h.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) })),
      companySelfCreate: companySelfCreateThroughLambda(async (payload) => ({ Payload: new TextEncoder().encode(JSON.stringify(await h.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) })),
    },
  };
  /** A broker call with any Authorization header, over the given route dependencies. */
  const callOnWith = async (on: DeveloperRouteDependencies, method: string, path: string, authorization: string | undefined, body?: unknown): Promise<Answer> => {
    const request = { method, path, headers: authorization === undefined ? {} : { authorization }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(on, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; }
    catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code } } };
    }
  };
  const call = (method: string, path: string, token: string | undefined, body?: unknown) => callOnWith(routes, method, path, token === undefined ? undefined : `Bearer ${token}`, body);
  const callWith = (method: string, path: string, authorization: string, body?: unknown) => callOnWith(routes, method, path, authorization, body);
  const callOn = (on: DeveloperRouteDependencies, method: string, path: string, token: string | undefined, body?: unknown) => callOnWith(on, method, path, token === undefined ? undefined : `Bearer ${token}`, body);
  const access = (token: string | undefined) => call("POST", "/v1/dev/access", token, {});
  /** The CLI's broker check (authenticateDeveloper): 200 when it passes, else the refusal's status. */
  const cliCheck = async (token: string) => {
    try { await authenticateDeveloper(routes, decodeJwt(token)); return 200; } catch (error) { if (error instanceof AgentXError) return error.statusCode; throw error; }
  };
  /** A person's live sessions bound to a company or the built-in one (the owner's first, company-less session is left out). */
  const sessionOf = (id: string) => h.db.find((row) => row.entityType === "SESSION" && row.developerId === id && row.revokedAt === undefined && !(id === person("owner") && row.companyId === undefined));
  /** A sign-in on the browser review page (no client, no company named): its session id. */
  const browserSession = async (subject: string) => {
    const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111"));
    const link = /href="([^"]*method=oidc)"/.exec(start.body)![1]!.replaceAll("&amp;", "&");
    const selected = await h.http(httpEvent("GET", link));
    const back = await h.http({ ...httpEvent("GET", h.oidc.approve(selected.headers.location!, subject)), headers: { cookie: start.cookies![0]!.split(";")[0]! } });
    const cookie = back.cookies?.find((value) => value.startsWith("__Host-agentx_review_session="));
    if (cookie === undefined) throw new Error("test setup: no review session");
    return cookie.split(";")[0]!.split("=")[1]!;
  };
  /** X: owner makes it by self-serve (no issuer). B: an operator's company with its own issuer, whose first admin is bob. */
  const setup = async () => {
    const first = await signIn("owner");
    const made = newCompanyInviteCode();
    await operator({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24 });
    expect((await call("POST", "/v1/dev/company", first.access, { name: "Acme", inviteCode: made.code })).status).toBe(200);
    await operator({ kind: "company-create", name: "Bravo", firstAdminEmail: "bob@example.test", expiresInHours: 24 }, B);
    h.db.set(issuerRow);
    return first;
  };
  const oidcSignIn = (subject: string, query: Record<string, string>) => h.signIn("oidc", subject, { query });
  return { ...h, company, invites, operator, signIn, oidcSignIn, browserSession, refresh, routes, call, callWith, callOn, access, cliCheck, sessionOf, setup, issuerRow };
}


/** Named, so the world's type does not lean on a path the strict check cannot name. */
export type SharedSignInWorld = ReturnType<typeof buildWorld> & { deps: DeveloperIdentityDependencies };
export const sharedSignInWorld = (options: { administrator?: boolean; slackUsers?: FakeSlackUser[]; stepUp?: DeveloperIdentityDependencies["stepUp"] } = {}): SharedSignInWorld => buildWorld(options);
