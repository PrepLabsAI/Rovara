import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { resolveDeveloper, type AdminActionDependencies } from "../../packages/broker/src/aws/admin-actions.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { identityHarness, OIDC_ISSUER } from "../support/developer-fakes.js";
import { planChange, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA } from "../support/developer-task-broker.js";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";

const companyId = "org_" + "b".repeat(20);
const personId = "b".repeat(64);
const email = "same@example.test";
it("nonimplicit email index never overwrites the shared index", async () => {
  const h = identityHarness();
  const profile = { developerId: "a".repeat(64), provider: "oidc" as const, issuer: OIDC_ISSUER, subject: "a", displayName: "A", email };
  await h.deps.store.upsertDeveloper(profile);
  await h.deps.store.upsertDeveloper({ ...profile, developerId: personId, subject: "b", displayName: "B" }, companyId);
  expect(h.db.get(emailIndexKey(email).pk, "META")?.developerId).toBe(profile.developerId);
  expect(h.db.get(companyScoped(companyId, emailIndexKey(email).pk), "META")?.developerId).toBe(personId);
  expect(emailIndexKey(email, IMPLICIT_COMPANY_ID)).toEqual(emailIndexKey(email));
  expect(emailIndexKey(" SAME@EXAMPLE.TEST ", companyId)).toEqual(emailIndexKey(email, companyId));
});

it.each(["grant_project_access", "revoke_project_access", "revoke_signin"] as const)("%s passes the caller's membership company to target resolution", async (kind) => {
  const h = await createAdminReadBroker();
  const module = await import("../../packages/broker/src/aws/broker.js") as unknown as { createPlanDependencies(input: never): PlanDependencies };
  const deps = module.createPlanDependencies(h.brokerInput as never);
  const member = h.db.find((row) => row.entityType === "MEMBERSHIP" && row.role === "administrator")[0]!;
  const identity = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: String(member.ownerKey), isAdministrator: true, claims: {} };
  if (kind === "revoke_project_access") h.db.set({ pk: `MEMBER#${MAYA.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role: "developer" });
  const change = kind === "revoke_signin" ? { kind, developer: MAYA.developerId } : { kind, project: "payments", developer: MAYA.developerId };
  deps.actions.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  expect(await planChange(deps, identity, change)).toHaveProperty("effect");
  deps.actions.companies = { companyOf: async (person) => person === identity.ownerKey ? IMPLICIT_COMPANY_ID : companyId };
  await expect(planChange(deps, identity, change)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("nobody has signed in") as unknown });
});

it("the client's member-change route also fences the target using the caller's membership", async () => {
  const h = companyRouteHarness(); h.project();
  h.db.set({ pk: `MEMBER#${PERSON}`, sk: "PROJECT#shared-project", projectName: "shared-project", role: "administrator" });
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web", audience: "web-app", redirectUris: [], loopback: true, scopes: ["projects:members"], createdAt: TIME, updatedAt: TIME, updatedBy: "operator" });
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app" });
  h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: "Foreign Person", provider: "oidc" });
  Object.assign(h.claims, { azp: "web-app", aud: "web-app", scope: "projects:members" });
  const token = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(h.claims)).toString("base64url")}.c2ln`;
  h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  const call = { method: "PUT", headers: { authorization: `Bearer ${token}` } };
  const path = `/v1/dev/client/projects/shared-project/members/${personId}`;
  expect((await h.read(path, call)).statusCode).toBe(200);
  h.db.delete(`MEMBER#${personId}`, "PROJECT#shared-project");
  h.deps.companies = { companyOf: async (person) => person === PERSON ? IMPLICIT_COMPANY_ID : companyId };
  const answer = await h.read(path, call);
  expect(answer.statusCode).toBe(404);
  expect(answer.body).toContain("nobody has signed in");
  expect(answer.body).not.toContain("Foreign Person");
  expect(h.db.get(`MEMBER#${personId}`, "PROJECT#shared-project")).toBeUndefined();
});

it("resolveDeveloper fences email and id reads with membership; failures have the same not-found bytes", async () => {
  const h = identityHarness();
  await h.deps.store.upsertDeveloper({ developerId: personId, provider: "oidc", issuer: OIDC_ISSUER, subject: "b", displayName: "B", email }, companyId);
  h.db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: new Date(h.now()).toISOString() });
  const deps: AdminActionDependencies = { documentClient: h.db, tableName: "state", signInTableName: "signin", now: h.now, limitDefaults: { member: 1, organization: 10 }, companies: companyMembershipFromDynamo(h.db, "signin") };
  expect(await resolveDeveloper(deps, email, companyId)).toMatchObject({ developerId: personId });
  expect(await resolveDeveloper(deps, personId, companyId)).toMatchObject({ developerId: personId });
  const error = async (reference: string, company: string) => {
    try { await resolveDeveloper(deps, reference, company); return "unexpected success"; } catch (cause) { return cause instanceof Error ? cause.message : "unknown"; }
  };
  const unknown = await error("nobody@example.test", IMPLICIT_COMPANY_ID);
  expect(await error(email, IMPLICIT_COMPANY_ID)).toBe(unknown);
  expect(await error(personId, IMPLICIT_COMPANY_ID)).toBe(unknown);
  for (const companyOf of [async () => undefined, async () => "malformed", async (): Promise<string> => { throw new Error("secret-canary"); }]) {
    deps.companies = { companyOf };
    expect(await error(personId, companyId)).toBe(unknown);
  }
});

it.each([{ entityType: "OTHER" }, { updatedAt: 1 }, { updatedAt: "secret-canary" }])("scoped email resolution refuses a malformed index row: %s", async (damage) => {
  const h = identityHarness();
  await h.deps.store.upsertDeveloper({ developerId: personId, provider: "oidc", issuer: OIDC_ISSUER, subject: "b", displayName: "B", email }, companyId);
  const key = emailIndexKey(email, companyId);
  const deps: AdminActionDependencies = { documentClient: h.db, tableName: "state", signInTableName: "signin", now: h.now, limitDefaults: { member: 1, organization: 10 }, companies: { companyOf: async () => companyId } };
  expect(await resolveDeveloper(deps, email, companyId)).toMatchObject({ developerId: personId });
  h.db.set({ ...h.db.get(key.pk, key.sk)!, ...damage });
  await expect(resolveDeveloper(deps, email, companyId)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("nobody has signed in") as unknown });
});
