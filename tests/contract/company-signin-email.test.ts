import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { resolveDeveloper, type AdminActionDependencies } from "../../packages/broker/src/aws/admin-actions.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { identityHarness, OIDC_ISSUER } from "../support/developer-fakes.js";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";

const companyId = "org_" + "b".repeat(20);
const personId = "b".repeat(64);
const email = "same@example.test";


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

