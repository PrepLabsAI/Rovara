import { expect, it, vi } from "vitest";
import { companyScoped } from "@agentx/contracts";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { createCompanySignInAuditWriter } from "../../packages/broker/src/developer/company-signin-audit.js";
import { GITHUB_ISSUER, githubSignInProvider, oidcSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { authorizeQuery, httpEvent, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER } from "../support/developer-fakes.js";
import { person, sharedSignInWorld, WEB, X } from "../support/company-shared-signin-world.js";
import { fakeGithub, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } from "../support/fake-github.js";

const paths = ["web", "cli", "slack", "github", "invite", "browser"] as const;
type Path = typeof paths[number];
const canary = "synthetic-provider-payload-cookie-token-secret";

async function world(path: Path = "web") {
  const w = sharedSignInWorld({ slackUsers: [{ userId: "U0AUDIT", name: "Slack person", email: "slack@example.test", emailVerified: true }] });
  await w.setup();
  let subject = "owner";
  let developerId = person(subject);
  const query: Record<string, string> = path === "cli" || path === "browser" ? {} : { client_id: "web-app", redirect_uri: WEB };
  const method = path === "slack" || path === "github" ? path : "oidc";
  const gh = fakeGithub([{ id: 1001, login: "audit-user", emails: [{ email: "github@example.test", primary: true, verified: true }] }]);
  if (path === "github") {
    w.deps.config.github = {};
    w.deps.providers.github = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: w.now });
    developerId = ownerKeyForSubject(GITHUB_ISSUER, "1001");
  }
  if (path === "slack" || path === "github") {
    await w.operator({ kind: "company-preapprove", companyId: X, email: `${path}@example.test`, role: "member", expiresInHours: 24 });
    query.company = X;
    if (path === "slack") developerId = ownerKeyForSubject("https://slack.com", "U0AUDIT");
  }
  if (path === "invite") {
    const owner = await w.signIn("owner");
    const minted = await w.call("POST", "/v1/dev/company/preapprovals", owner.access, { email: "carol@example.test", role: "member", expiresInHours: 24 });
    query.invite = (minted.body as { invite: { secret: string } }).invite.secret;
    query.company = X;
    subject = "carol"; developerId = person(subject);
  }
  const rows = () => w.db.find((row) => row.entityType === "AUDIT");
  w.deps.signInAudit = createCompanySignInAuditWriter({ tableName: "state", documentClient: w.db, now: w.now });
  const start = async () => {
    const first = await w.http(httpEvent("GET", path === "browser"
      ? "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111" : authorizeQuery(query)));
    const link = new RegExp(`href="([^"]*method=${method})"`).exec(first.body)?.[1];
    const selected = link === undefined ? first : await w.http(httpEvent("GET", link.replaceAll("&amp;", "&")));
    const callback = method === "github" ? gh.approve(selected.headers.location!, "audit-user")
      : method === "slack" ? w.slack.approve(selected.headers.location!, "U0AUDIT") : w.oidc.approve(selected.headers.location!, subject);
    return () => w.http({ ...httpEvent("GET", callback), ...(path === "browser" ? { headers: { cookie: first.cookies![0]!.split(";")[0]! } } : {}) });
  };
  return { w, rows, start, developerId };
}

function noCredentials(response: HttpResult) {
  expect(new URL(response.headers.location!, "https://example.test").searchParams.has("code")).toBe(false);
  expect(response.cookies?.some((cookie) => cookie.startsWith("__Host-agentx_review_session=")) ?? false).toBe(false);
}

function scan(rows: Array<Record<string, unknown>>) {
  const text = JSON.stringify(rows).toLowerCase();
  expect(text).not.toContain(canary);
  for (const field of ["token", "code", "cookie", "secret", "email", "ip", "authorization", "provider", "error"]) expect(text).not.toContain(`"${field}"`);
}

it.each(paths)("%s records success only after the credential is persisted", async (path) => {
  const { w, rows, start, developerId } = await world(path);
  const finish = await start();
  const writer = w.deps.signInAudit!;
  const before = w.db.find((row) => row.entityType === (path === "browser" ? "SESSION" : "AUTH_CODE") && row.developerId === developerId).length;
  w.deps.signInAudit = async (input) => {
    const persisted = w.db.find((row) => row.entityType === (path === "browser" ? "SESSION" : "AUTH_CODE") && row.developerId === developerId);
    expect(persisted).toHaveLength(before + 1);
    await writer(input);
  };
  const response = await finish();
  expect(path === "browser" ? response.cookies?.some((cookie) => cookie.startsWith("__Host-agentx_review_session=")) : new URL(response.headers.location!).searchParams.has("code")).toBe(true);
  expect(rows()).toEqual([expect.objectContaining({ companyId: X, actor: { type: "person", id: developerId }, action: "signin.succeeded", details: { method: path === "browser" ? "web" : path } })]);
  scan(rows());
});

it.each(paths)("%s profile persistence failure records exactly one fixed-cause refusal", async (path) => {
  const { w, rows, start, developerId } = await world(path);
  const finish = await start();
  vi.spyOn(w.deps.store, "upsertDeveloper").mockRejectedValueOnce(new Error(canary));
  noCredentials(await finish());
  expect(rows()).toEqual([expect.objectContaining({ companyId: X, actor: { type: "person", id: developerId }, action: "signin.refused", details: { method: path === "browser" ? "web" : path, cause: "sign_in_failed" } })]);
  scan(rows());
});

it.each(["web", "browser"] as const)("%s durable credential failure never records success", async (path) => {
  const { w, rows, start } = await world(path);
  const finish = await start();
  if (path === "browser") vi.spyOn(w.deps.store, "createBrowserSession").mockRejectedValueOnce(new Error(canary));
  else vi.spyOn(w.deps.store, "issueCode").mockRejectedValueOnce(new Error(canary));
  noCredentials(await finish());
  expect(rows()).toEqual([expect.objectContaining({ action: "signin.refused", details: { method: "web", cause: "sign_in_failed" } })]);
  scan(rows());
});

it.each(["directory", "client", "join", "developer", "issuer"] as const)("%s internal failure is attributable and recorded once", async (fault) => {
  const { w, rows, start } = await world();
  const finish = await start();
  if (fault === "directory") w.deps.companyDirectory = () => ({ ...w.deps.directory, lookupByEmail: async () => { throw new Error(canary); } });
  if (fault === "client") vi.spyOn(w.deps.store, "getClient").mockRejectedValueOnce(new Error(canary));
  if (fault === "join") vi.spyOn(w.company, "join").mockRejectedValueOnce(new Error(canary));
  if (fault === "developer") vi.spyOn(w.deps.store, "getDeveloper").mockRejectedValueOnce(new Error(canary));
  if (fault === "issuer") vi.spyOn(w.company, "hasOwnIssuer").mockRejectedValueOnce(new Error(canary));
  noCredentials(await finish());
  expect(rows()).toEqual([expect.objectContaining({ companyId: X, action: "signin.refused", details: { method: "web", cause: fault === "issuer" ? "not_invited" : "sign_in_failed" } })]);
  scan(rows());
});

it.each(["web", "browser"] as const)("%s audit-write failure withholds credentials and logs a fixed event once", async (path) => {
  const { w, rows, start } = await world(path);
  const finish = await start();
  let attempts = 0;
  w.deps.signInAudit = async () => { attempts++; throw new Error(canary); };
  noCredentials(await finish());
  expect(attempts).toBe(1);
  expect(rows()).toEqual([]);
  expect(w.logs.filter((entry) => entry.event === "signin.audit_failed")).toEqual([{ event: "signin.audit_failed", method: "oidc", error: "sign_in_failed" }]);
  expect(JSON.stringify(w.logs)).not.toContain(canary);
});

it("a refused member's audit failure is logged once and still withholds access", async () => {
  const { w, rows, start } = await world();
  const member = w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP" && row.personId === person("owner"))[0]!;
  w.db.set({ ...member, revokedAt: new Date(w.now()).toISOString() });
  const finish = await start();
  let attempts = 0;
  w.deps.signInAudit = async () => { attempts++; throw new Error(canary); };
  noCredentials(await finish());
  expect(attempts).toBe(1);
  expect(rows()).toEqual([]);
  expect(w.logs.filter((entry) => entry.event === "signin.audit_failed")).toHaveLength(1);
});

it("records a verified OIDC policy refusal against the verified member", async () => {
  const { w, rows, start, developerId } = await world();
  w.deps.providers.oidc = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID,
    clientSecret: async () => OIDC_CLIENT_SECRET, requiredClaim: "groups", requiredValues: ["engineering"],
    fetch: w.fetch, jwksFor: () => w.oidc.jwks, now: w.now });
  const finish = await start();
  noCredentials(await finish());
  expect(rows()).toEqual([expect.objectContaining({ companyId: X, actor: { type: "person", id: developerId }, action: "signin.refused", details: { method: "web", cause: "sign_in_failed" } })]);
  scan(rows());
});

it.each(["unknown", "unreadable"] as const)("%s membership produces no company row", async (fault) => {
  const { w, rows, start } = await world();
  if (fault === "unknown") {
    expect((await w.signIn("noemail", { company: X })).refused).toBe("not invited");
  } else {
    const finish = await start();
    vi.spyOn(w.company, "membership").mockRejectedValue(new Error(canary));
    noCredentials(await finish());
  }
  expect(rows()).toEqual([]);
});

it("a browser mint refusal after a successful join records exactly one failure", async () => {
  const { w, rows, start } = await world("browser");
  const finish = await start();
  const upsert = w.deps.store.upsertDeveloper.bind(w.deps.store);
  vi.spyOn(w.deps.store, "upsertDeveloper").mockImplementationOnce(async (...args) => {
    const profile = await upsert(...args);
    const member = w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP" && row.personId === person("owner"))[0]!;
    w.db.set({ ...member, revokedAt: new Date(w.now()).toISOString() });
    return profile;
  });
  noCredentials(await finish());
  expect(rows()).toEqual([expect.objectContaining({ companyId: X, action: "signin.refused", details: { method: "web", cause: "sign_in_failed" } })]);
});

it.each([
  ["person", "person_revoked"], ["membership", "member_revoked"],
  ["issuer", "company_signin_mismatch"], ["merge", "sign_in_failed"],
] as const)("%s business refusal records its fixed cause once", async (fault, cause) => {
  const { w, rows, start } = await world();
  const finish = await start();
  const profile = w.db.get(`DEVELOPER#${person("owner")}`, "META")!;
  if (fault === "person") w.db.set({ ...profile, revoked: true });
  if (fault === "merge") w.db.set({ ...profile, mergedInto: "a".repeat(64) });
  if (fault === "issuer") w.db.set({ ...w.issuerRow, pk: companyScoped(X, "SIGNIN_ISSUER") });
  if (fault === "membership") {
    const member = w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP" && row.personId === person("owner"))[0]!;
    w.db.set({ ...member, revokedAt: new Date(w.now()).toISOString() });
  }
  noCredentials(await finish());
  expect(rows()).toEqual([expect.objectContaining({ companyId: X, action: "signin.refused", details: { method: "web", cause } })]);
  scan(rows());
});
