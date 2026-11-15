import { CLIENT_SCOPES } from "@agentx/contracts";
import { expect, it, vi } from "vitest";
import { PERSON, TIME } from "../support/company-route-harness.js";
import { inviteCompanyWorld as inviteWorld } from "../support/signin-company-world.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import * as routes from "../../packages/broker/src/aws/developer-routes.js";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const path = "/v1/dev/company/preapprovals";
const email = "invited@example.test";
const hash = emailIndexKey(email).pk.slice(6);


it("member admin adds and withdraws a hashed approval through the real identity handler", async () => {
  const h = await inviteWorld(); h.claims.companyId = B;
  expect((await h.post()).statusCode).toBe(200);
  expect(h.forwarded).toEqual([{ kind: "company-preapprove", companyId: A, email, role: "member", expiresInHours: 24, createdBy: PERSON }]);
  expect((await h.identity.company.list(A)).preapprovals.find((row) => row.emailHash === hash)).toMatchObject({ role: "member", createdBy: PERSON });
  expect((await h.withdraw()).statusCode).toBe(200);
  expect(h.forwarded[1]).toEqual({ kind: "company-preapproval-withdraw", companyId: A, emailHash: hash, createdBy: PERSON });
  const sign = await h.identity.signInCompany(A, "invited", email);
  expect(new URL(sign.headers.location!).searchParams.get("error_description")).toBe("not invited");
});

it("owner may invite and an expired invitation cannot join", async () => {
  const h = await inviteWorld(); h.member(A, "owner");
  expect((await h.post({ email, role: "member", expiresInHours: 1 })).statusCode).toBe(200);
  h.identity.tick(3_600_001);
  const sign = await h.identity.signInCompany(A, "expired", email);
  expect(new URL(sign.headers.location!).searchParams.get("error_description")).toBe("not invited");
});

it("plain member cannot gain admin from claims or a body", async () => {
  const h = await inviteWorld(); h.member(A, "member"); Object.assign(h.claims, { role: "admin", administrator: true, companyId: B });
  const refused = await h.post(); expect(refused.statusCode).toBe(404);
  expect(await h.withdraw()).toEqual(refused);
  expect(h.forwarded).toEqual([]);
});

it("another company's admin cannot withdraw a foreign approval; unknown has identical bytes", async () => {
  const h = await inviteWorld(); expect((await h.post()).statusCode).toBe(200);
  h.member(B); const foreign = await h.withdraw(); expect(foreign.statusCode).toBe(404);
  expect(await h.withdraw("f".repeat(64))).toEqual(foreign);
  expect((await h.identity.company.list(A)).preapprovals.find((row) => row.emailHash === hash)?.status).toBe("live");
});

it.each([{ role: "admin" }, { role: "owner" }, { role: null }, { expiresInHours: 0 }, { expiresInHours: 721 }, { companyId: B }, { createdBy: "b".repeat(64) }, { email: "private-canary" }, { extra: true }])("rejects unapproved invite input %j without echo", async (change) => {
  const h = await inviteWorld(); const answer = await h.post({ email, role: "member", expiresInHours: 24, ...change });
  expect(answer.statusCode).toBe(400); expect(answer.body).not.toMatch(/private-canary|org_|invited@example/); expect(h.forwarded).toEqual([]);
});

it.each(["missing", "malformed", "revoked", "throws", "wrong-company"])("%s membership refuses without forwarding or leaking", async (damage) => {
  const h = await inviteWorld(); const key = membershipKey(PERSON);
  if (damage === "missing") h.db.delete(key.pk, key.sk);
  if (damage === "malformed") h.db.set({ ...h.db.get(key.pk, key.sk)!, role: "private-canary" });
  if (damage === "revoked") h.db.set({ ...h.db.get(key.pk, key.sk)!, revokedAt: TIME });
  if (damage === "throws") h.deps.companies = { companyOf: async () => { throw new Error("private-canary"); } };
  if (damage === "wrong-company") h.deps.companies = { companyOf: async () => B };
  const answer = await h.post(); expect(answer.statusCode).toBe(401); expect(answer.body).not.toMatch(/private-canary|org_/); expect(h.forwarded).toEqual([]);
});

it("off routes are unknown and do not authenticate or invoke", async () => {
  const h = await inviteWorld(); delete h.deps.companies;
  const verify = vi.spyOn(h.deps.developer, "verifyAccessToken");
  expect((await h.post()).statusCode).toBe(404); expect((await h.withdraw()).statusCode).toBe(404);
  expect(verify).not.toHaveBeenCalled(); expect(h.forwarded).toEqual([]);
});

it("an unregistered client token cannot invite", async () => {
  const h = await inviteWorld(); Object.assign(h.claims, { azp: "web-app" });
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app" });
  expect((await h.post()).statusCode).toBe(401); expect(h.forwarded).toEqual([]);
});

it("malformed hash and unavailable forwarding refuse without leaked causes", async () => {
  const h = await inviteWorld(); expect((await h.withdraw("private-canary")).statusCode).toBe(404);
  h.deps.developer.companyPreapprovals = routes.companyPreapprovalsThroughLambda(async () => { throw new Error("private-canary"); });
  const answer = await h.post(); expect(answer.statusCode).toBe(404); expect(answer.body).not.toContain("private-canary");
});

it("the production broker dispatcher supplies the membership reader and invite transport", async () => {
  const { createDeveloperTaskBroker, MAYA } = await import("../support/developer-task-broker.js");
  const forwarded: unknown[] = [];
  const h = await createDeveloperTaskBroker({ developerExtra: { companies: { companyOf: async () => A }, companyPreapprovals: async (event) => { forwarded.push(event); return true; } } });
  h.db.set({ ...membershipKey(MAYA.developerId), entityType: "COMPANY_MEMBERSHIP", personId: MAYA.developerId, companyId: A, role: "admin", joinedAt: TIME });
  const answer = await h.dev(MAYA, "POST", path, { email, role: "member", expiresInHours: 24 });
  expect(answer.status).toBe(200); expect(forwarded).toEqual([{ kind: "company-preapprove", companyId: A, email, role: "member", expiresInHours: 24, createdBy: MAYA.developerId }]);
});

it("the broker forwarding seam runtime-refuses every operator kind and malformed invite", async () => {
  const invoke = vi.fn(async () => ({ Payload: Buffer.from('{"ok":true}') }));
  const forward = routes.companyPreapprovalsThroughLambda(invoke);
  const good = { kind: "company-preapprove" as const, companyId: A, email, role: "member" as const, expiresInHours: 1, createdBy: PERSON };
  expect(await forward(good)).toBe(true); invoke.mockClear();
  for (const event of [ { ...good, kind: "company-create" }, { ...good, role: "admin" }, { ...good, companyId: "private-canary" }, { ...good, createdBy: undefined }, { ...good, expiresInHours: 0 } ]) expect(await forward(event as Parameters<typeof forward>[0])).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

it.each([{ revokedAt: TIME }, { personId: "b".repeat(64) }])("a membership change after company resolution still refuses: %j", async (damage) => {
  const h = await inviteWorld(); h.deps.companies = { companyOf: async () => A };
  const key = membershipKey(PERSON); h.db.set({ ...h.db.get(key.pk, key.sk)!, ...damage });
  expect((await h.post()).statusCode).toBe(401); expect(h.forwarded).toEqual([]);
});

it("production bootstrap enables company reads only for the exact enabled switch", async () => {
  const { loadSlackBroker, call, issuer } = await import("../support/slack-broker.js");
  await loadSlackBroker();
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const { LambdaClient } = await import("@aws-sdk/client-lambda");
  const { FakeDynamoDb } = await import("../support/fake-dynamodb.js");
  const { ownerKeyForSubject } = await import("../../packages/broker/src/aws/lambda.js");
  const db = new FakeDynamoDb();
  const personId = ownerKeyForSubject(issuer, "admin-subject");
  db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId: A, role: "admin", joinedAt: TIME });
  const reads = vi.spyOn(db, "send");
  const from = vi.spyOn(DynamoDBDocumentClient, "from").mockReturnValue(db as unknown as ReturnType<typeof DynamoDBDocumentClient.from>);
  const invoke = vi.spyOn(LambdaClient.prototype, "send").mockResolvedValue({ Payload: Buffer.from('{"ok":true,"clients":[]}') } as never);
  try {
    for (const [key, value] of Object.entries({ DEVELOPER_TOKEN_ISSUER: issuer, DEVELOPER_IDENTITY_FUNCTION_ARN: "identity", DEVELOPER_SIGNIN_TABLE_NAME: "signin", AGENTX_ENV: "test", ADMIN_CLAIM: "groups", ADMIN_VALUES: '["admins"]' })) vi.stubEnv(key, value);
    for (const flag of [undefined, "disabled", "true", "enabled"]) {
      vi.stubEnv("COMPANY_SIGNIN", flag); vi.resetModules(); reads.mockClear(); invoke.mockClear();
      const { handler } = await import("../../packages/broker/src/aws/broker.js");
      expect((await call((event) => handler(event as Parameters<typeof handler>[0]), { method: "GET", path: "/v1/admin/sign-in-clients", user: { subject: "admin-subject", admin: true } })).status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(flag === "enabled" ? 1 : 0);
      const command = invoke.mock.calls[0]?.[0] as { input: { Payload: Uint8Array } };
      expect(JSON.parse(Buffer.from(command.input.Payload).toString()) as unknown).toEqual({ kind: "list-sign-in-clients", ...(flag === "enabled" ? { companyId: A } : {}) });
    }
  } finally { from.mockRestore(); invoke.mockRestore(); reads.mockRestore(); vi.unstubAllEnvs(); vi.resetModules(); }
});

async function registeredInviteWorld(fullAccess = false) {
  const h = await inviteWorld();
  const clientId = "invite-client";
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: `CLIENT#${clientId}`, entityType: "SIGN_IN_CLIENT", clientId,
    name: "Invite client", audience: clientId, redirectUris: [], loopback: true, companyId: A,
    scopes: [...CLIENT_SCOPES], ...(fullAccess ? { fullAccess: true, secretHash: "f".repeat(64) } : {}), createdAt: TIME, updatedAt: TIME, updatedBy: "operator" });
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId });
  Object.assign(h.claims, { azp: clientId, aud: clientId, scope: CLIENT_SCOPES.join(" ") });
  const headers = { authorization: `Bearer ${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(h.claims)).toString("base64url")}.c2ln` };
  const call = (method: "POST" | "DELETE") => h.read(method === "POST" ? path : `${path}/${hash}`, { method, headers,
    body: JSON.stringify({ email, role: "member", expiresInHours: 24 }) });
  return { ...h, call };
}

it.each(["POST", "DELETE"] as const)("%s refuses every named scope before checking the invite membership role", async (method) => {
  const h = await registeredInviteWorld(); h.member(A, "member");
  const answer = await h.call(method);
  expect(answer.statusCode).toBe(403);
  expect(JSON.parse(answer.body)).toEqual({ error: { code: "FORBIDDEN", message: `Invite client needs full access for ${method} ${path}${method === "DELETE" ? "/{emailHash}" : ""}, which is off for it; an administrator can turn it on` }, requestId: "company-test" });
  expect(answer.body).not.toMatch(/invited@example|org_|private-canary/);
  expect(h.forwarded).toEqual([]);
});

it.each(["admin", "owner", "member"] as const)("full-access client still needs live admin/owner membership: %s", async (role) => {
  const h = await registeredInviteWorld(true); h.member(A, role);
  Object.assign(h.claims, { role: "admin", administrator: true, companyId: B });
  for (const method of ["POST", "DELETE"] as const) expect((await h.call(method)).statusCode).toBe(role === "member" ? 404 : 200);
  expect(h.forwarded).toHaveLength(role === "member" ? 0 : 2);
  for (const event of h.forwarded) expect(event).toMatchObject({ companyId: A, createdBy: PERSON });
});
