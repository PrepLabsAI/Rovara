import { companyRouteHarness, PERSON, TIME } from "./company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import * as routes from "../../packages/broker/src/aws/developer-routes.js";
// The real sign-in server, providers and store over wire-level DynamoDB / HTTP doubles.
import { generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, SignJWT } from "jose";
import { companyScoped } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyIssuerProvider } from "../../packages/broker/src/developer/company-issuer.js";
import { companyOperator, type CompanyOperatorResponse } from "../../packages/broker/src/developer/company-operator.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { identityHarness, authorizeQuery, httpEvent, ISSUER } from "./developer-fakes.js";

type CompanyWorld = ReturnType<typeof identityHarness> & {
  company: CompanySignInStore;
  operator(event: unknown, generatedCompanyId?: string): Promise<CompanyOperatorResponse>;
  create(companyId: string, email?: string): Promise<void>;
  signInCompany(companyId: string, subject?: string, email?: string, query?: Record<string, string>): Promise<HttpResult>;
  secretReads: string[];
  secretDown(companyId?: string): void;
  discoveryDown(companyId?: string): void;
};
export function signinCompanyWorld(): CompanyWorld {
  const h = identityHarness({ slack: true, oidc: {}, slackUsers: [{ userId: "U0SHARED", name: "Slack Person", email: "shared@example.test" }] });
  const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  const secretReads: string[] = [];
  const failedSecrets = new Set<string>();
  const failedDiscovery = new Set<string>();
  const providers = new Map([COMPANY_A, COMPANY_B].map((c) => {
    const issuer = `https://${c.label.toLowerCase()}.identity.example.test`;
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: c.label, alg: "RS256", use: "sig" };
    return [issuer, { companyId: c.orgId, issuer, key, kid: c.label, jwks: createLocalJWKSet({ keys: [jwk] }), codes: new Map<string, string>(), secret: ["test", c.label, "secret"].join("-") }] as const;
  }));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = providers.get(url.origin);
    if (p === undefined) throw new Error("unconfigured fake provider");
    if (url.pathname === "/.well-known/openid-configuration") {
      if (failedDiscovery.has(p.companyId)) throw new Error("discovery-read-canary");
      return Response.json({ issuer: p.issuer, authorization_endpoint: `${p.issuer}/authorize`, token_endpoint: `${p.issuer}/token`, jwks_uri: `${p.issuer}/jwks` });
    }
    if (url.pathname === "/token") {
      const basic = `Basic ${Buffer.from(`company-client:${p.secret}`).toString("base64")}`;
      if (new Headers(init?.headers).get("authorization") !== basic) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (typeof init?.body !== "string" && !(init?.body instanceof URLSearchParams)) throw new Error("unexpected fake request body");
      const form = new URLSearchParams(init.body);
      const code = form.get("code") ?? "";
      const token = p.codes.get(code); p.codes.delete(code);
      if (token === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "unused", token_type: "Bearer", id_token: token });
    }
    throw new Error("unconfigured fake endpoint");
  };
  h.deps.company = company;
  h.deps.companyIssuer = companyIssuerProvider({ store: company, env: h.deps.config.env, now: h.now, fetch,
    jwksFor: (uri) => providers.get(new URL(uri).origin)!.jwks,
    readSecret: async (name) => {
      secretReads.push(name);
      const p = [...providers.values()].find((p) => name === `agentx/${h.deps.config.env}/org-signin/${p.companyId}/oidc`);
      if (p === undefined) throw new Error("foreign secret");
      if (failedSecrets.has(p.companyId)) throw new Error("secret-read-canary");
      return p.secret;
    },
  });
  const operator = (event: unknown, generatedCompanyId = COMPANY_A.orgId) => companyOperator({ store: company, now: h.now, log: h.deps.log, newCompanyId: () => generatedCompanyId }, event);
  const create = async (companyId: string, email = "shared@example.test") => {
    await operator({ kind: "company-create", name: "Company", firstAdminEmail: email, expiresInHours: 24 }, companyId);
    const p = [...providers.values()].find((p) => p.companyId === companyId)!;
    h.db.set({ pk: companyScoped(companyId, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", issuer: p.issuer, clientId: "company-client", displayName: "Company sign-in", requiredValues: [], enabled: true, enabledSince: h.now() / 1000 });
  };
  const signIn = async (companyId: string, subject = "shared-person", email: string | undefined = "shared@example.test", query: Record<string, string> = {}) => {
    let answer = await h.http(httpEvent("GET", authorizeQuery({ company: companyId, ...query })));
    if (answer.statusCode === 200) {
      const link = /href="([^"]*method=oidc)"/.exec(answer.body)?.[1];
      if (link === undefined) throw new Error("expected company method");
      answer = await h.http(httpEvent("GET", link.replaceAll("&amp;", "&")));
    }
    if (answer.statusCode !== 302 || !answer.headers.location) return answer;
    const target = new URL(answer.headers.location);
    const p = providers.get(target.origin);
    if (p === undefined) return answer;
    const code = `provider-code-${p.codes.size}`;
    p.codes.set(code, await new SignJWT({ nonce: target.searchParams.get("nonce"), name: "Company Person", groups: ["admin"], ...(email === undefined ? {} : { email, email_verified: true }) })
      .setProtectedHeader({ alg: "RS256", kid: p.kid }).setIssuer(p.issuer).setAudience("company-client").setSubject(subject)
      .setIssuedAt(h.now() / 1000).setExpirationTime(h.now() / 1000 + 300).sign(p.key.privateKey));
    return h.http(httpEvent("GET", `${ISSUER}/callback/oidc?${new URLSearchParams({ state: target.searchParams.get("state")!, code }).toString()}`));
  };
  return { ...h, company, operator, create, signInCompany: signIn, secretReads,
    secretDown: (companyId = COMPANY_A.orgId) => { failedSecrets.add(companyId); },
    discoveryDown: (companyId = COMPANY_A.orgId) => { failedDiscovery.add(companyId); },
  };
}

// The production broker route and identity transport share the real in-process sign-in world.
type CompanyInviteWorld = ReturnType<typeof companyRouteHarness> & {
  identity: CompanyWorld;
  member(companyId?: string, role?: "owner" | "admin" | "member", personId?: string): void;
  forwarded: unknown[];
  post(body?: unknown): ReturnType<ReturnType<typeof companyRouteHarness>["read"]>;
  withdraw(emailHash?: string): ReturnType<ReturnType<typeof companyRouteHarness>["read"]>;
  resend(emailHash?: string, body?: unknown): ReturnType<ReturnType<typeof companyRouteHarness>["read"]>;
};
export async function inviteCompanyWorld(): Promise<CompanyInviteWorld> {
  const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
  const path = "/v1/dev/company/preapprovals", email = "invited@example.test", hash = emailIndexKey(email).pk.slice(6);
  const h = companyRouteHarness(); const identity = signinCompanyWorld();
  await identity.create(A, "first@example.test"); await identity.create(B, "first@example.test");
  const member = (companyId = A, role: "owner" | "admin" | "member" = "admin", personId = PERSON) => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME });
    h.claims.sub = personId;
    h.db.set({ ...h.db.get("SESSION#session", "META")!, developerId: personId });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: "Company Admin" });
  };
  member();
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  const forwarded: unknown[] = [];
  h.deps.developer.companyPreapprovals = routes.companyPreapprovalsThroughLambda(async (payload) => {
    const event = JSON.parse(Buffer.from(payload).toString()) as Parameters<typeof identity.handler>[0]; forwarded.push(event);
    return { Payload: Buffer.from(JSON.stringify(await identity.handler(event))) };
  });
  const post = (body: unknown = { email, role: "member", expiresInHours: 24 }) => h.read(path, { method: "POST", body: JSON.stringify(body) });
  const withdraw = (emailHash = hash) => h.read(`${path}/${emailHash}`, { method: "DELETE" });
  const resend = (emailHash = hash, body: unknown = { expiresInHours: 24 }) => h.read(`${path}/${emailHash}/resend`, { method: "POST", body: JSON.stringify(body) });
  return { ...h, identity, member, forwarded, post, withdraw, resend };
}
