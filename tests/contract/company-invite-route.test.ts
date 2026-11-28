import { CLIENT_SCOPES } from "@agentx/contracts";
import { expect, it, vi } from "vitest";
import { stubCallbackSigningKeySecret } from "../support/callback-key.js";
import { PERSON, TIME } from "../support/company-route-harness.js";
import { inviteCompanyWorld as inviteWorld } from "../support/signin-company-world.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { inviteLinkKey, preapprovalHashKey } from "../../packages/broker/src/developer/company-membership.js";
import * as routes from "../../packages/broker/src/aws/developer-routes.js";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const path = "/v1/dev/company/preapprovals";
const email = "invited@example.test";
const hash = emailIndexKey(email).pk.slice(6);


it("another company's admin cannot withdraw a foreign approval; unknown has identical bytes", async () => {
  const h = await inviteWorld(); expect((await h.post()).statusCode).toBe(200);
  h.member(B); const foreign = await h.withdraw(); expect(foreign.statusCode).toBe(404);
  expect(await h.withdraw("f".repeat(64))).toEqual(foreign);
  expect((await h.identity.company.list(A)).preapprovals.find((row) => row.emailHash === hash)?.status).toBe("live");
});

it("resends only a live pending invite for the live admin's company and replaces its link with a full new expiry", async () => {
  const h = await registeredInviteWorld(true, true);
  expect((await h.send("POST", path, { email, role: "member", expiresInHours: 1 })).statusCode).toBe(200);
  const original = (await h.identity.company.list(A)).preapprovals.find((row) => row.emailHash === hash)!;
  const resent = await h.send("POST", `${path}/${hash}/resend`, { expiresInHours: 48 });
  expect(resent.statusCode).toBe(200);
  const newInvite = (JSON.parse(resent.body) as { invite: { secret: string; expiresAt: string } }).invite;
  const after = (await h.identity.company.list(A)).preapprovals.find((row) => row.emailHash === hash)!;
  expect(after).toMatchObject({ status: "live", role: original.role, createdBy: original.createdBy, emailHash: hash });
  expect(after.expiresAt).toBe(Math.floor(h.identity.now() / 1000) + 48 * 3600);
  expect(newInvite.expiresAt).toBe(new Date(after.expiresAt * 1000).toISOString());
  expect(h.forwarded[1]).toMatchObject({ kind: "company-preapproval-resend", companyId: A, emailHash: hash, expiresInHours: 48, createdBy: PERSON, inviteHash: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown });
  const oldHash = (h.forwarded[0] as { inviteHash: string }).inviteHash;
  expect(h.identity.db.find((row) => row.entityType === "COMPANY_INVITE_LINK" && row.pk === `ORG#${A}#INVITE_LINK` && row.sk === `SECRET#${oldHash}`)[0]).toMatchObject({ status: "withdrawn", emailHash: hash });
  expect(h.identity.db.find((row) => row.entityType === "COMPANY_LOG" && row.event === "company-preapproval-resend")).toHaveLength(1);
});

it.each(["both", "preapproval", "link"] as const)("refuses resend after the clock passes expiry (%s expired), without writes or a resend audit", async (expired) => {
  const h = await registeredInviteWorld(true, true);
  expect((await h.send("POST", path, { email, role: "member", expiresInHours: 1 })).statusCode).toBe(200);
  const approvalKey = preapprovalHashKey(A, hash);
  const approval = h.identity.db.get(approvalKey.pk, approvalKey.sk)!;
  const linkKey = inviteLinkKey(A, approval.inviteHash as string);
  // Keep the other row live to exercise each expiry guard independently.
  const later = Math.floor(h.identity.now() / 1000) + 2 * 3600;
  if (expired === "preapproval") h.identity.db.set({ ...h.identity.db.get(linkKey.pk, linkKey.sk)!, expiresAt: later });
  if (expired === "link") h.identity.db.set({ ...approval, expiresAt: later });
  h.identity.tick(3_600_001);
  const before = structuredClone([...h.identity.db.items.values()]);
  const answer = await h.send("POST", `${path}/${hash}/resend`, { expiresInHours: 24 });
  expect(answer.statusCode).toBe(404);
  expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(h.forwarded[1]).toMatchObject({ kind: "company-preapproval-resend", companyId: A, emailHash: hash });
  expect([...h.identity.db.items.values()]).toEqual(before);
  expect(h.identity.db.find((row) => row.entityType === "COMPANY_LOG" && row.event === "company-preapproval-resend")).toHaveLength(0);
});

it("refuses resend for members, another company's admins, and non-pending invites", async () => {
  const h = await registeredInviteWorld(true, true);
  h.member(A, "admin");
  expect((await h.send("POST", path, { email, role: "member", expiresInHours: 24 })).statusCode).toBe(200);
  const expectNotFound = (answer: { statusCode: number; body: string }) => {
    expect(answer.statusCode).toBe(404);
    const parsed = JSON.parse(answer.body) as { error: { code: string } };
    expect(parsed.error.code).toBe("NOT_FOUND");
  };
  h.member(A, "member");
  expectNotFound(await h.send("POST", `${path}/${hash}/resend`, { expiresInHours: 24 }));
  h.member(B, "admin", "e".repeat(64));
  h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#invite-client")!, companyId: B });
  const pendingA = (await h.identity.company.list(A)).preapprovals.find((row) => row.emailHash === hash)!;
  const oldHash = (h.forwarded[0] as { inviteHash: string }).inviteHash;
  const linkA = h.identity.db.find((row) => row.entityType === "COMPANY_INVITE_LINK" && row.pk === inviteLinkKey(A, oldHash).pk && row.sk === inviteLinkKey(A, oldHash).sk)[0]!;
  h.identity.db.set({ ...pendingA, ...preapprovalHashKey(B, hash), companyId: B });
  h.identity.db.set({ ...linkA, ...inviteLinkKey(B, oldHash), companyId: A });
  await expect(h.identity.company.resend(B, hash, 24, "e".repeat(64), "c".repeat(64))).rejects.toThrow();
  expectNotFound(await h.send("POST", `${path}/${hash}/resend`, { expiresInHours: 24 }));
  h.member(A, "admin");
  h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#invite-client")!, companyId: A });
  expect((await h.send("DELETE", `${path}/${hash}`)).statusCode).toBe(200);
  expectNotFound(await h.send("POST", `${path}/${hash}/resend`, { expiresInHours: 24 }));
  expect(h.forwarded).toHaveLength(4);
  expect(h.forwarded[1]).toMatchObject({ kind: "company-preapproval-resend", companyId: B });

  const stale = await registeredInviteWorld(true, true);
  stale.member(A, "admin");
  expect((await stale.send("POST", path, { email, role: "member", expiresInHours: 24 })).statusCode).toBe(200);
  const pending = stale.identity.db.get(preapprovalHashKey(A, hash).pk, preapprovalHashKey(A, hash).sk)!;
  stale.identity.db.set({ ...pending, status: "withdrawn" });
  await expect(stale.identity.company.resend(A, hash, 24, PERSON, "d".repeat(64))).rejects.toThrow();
  expectNotFound(await stale.send("POST", `${path}/${hash}/resend`, { expiresInHours: 24 }));
  expect(stale.forwarded).toHaveLength(2);
  expect(stale.identity.db.find((row) => row.entityType === "COMPANY_LOG" && row.event === "company-preapproval-resend")).toHaveLength(0);
});

it("requires the website client for resend and rejects malformed expiry input", async () => {
  const h = await registeredInviteWorld(true, false);
  h.member(A, "admin");
  expect((await h.send("POST", `${path}/${hash}/resend`, { expiresInHours: 24 })).statusCode).toBe(403);
  expect(h.forwarded).toEqual([]);
  const normal = await registeredInviteWorld(true, true);
  expect((await normal.send("POST", path, { email, role: "member", expiresInHours: 24 })).statusCode).toBe(200);
  for (const body of [{}, { expiresInHours: 0 }, { expiresInHours: 721 }, { expiresInHours: 24, email }, { expiresInHours: 24, role: "admin" }]) {
    expect((await normal.send("POST", `${path}/${hash}/resend`, body)).statusCode).toBe(400);
  }
  expect(normal.forwarded).toHaveLength(1);
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
  // A membership read that throws is the retryable 503 (nothing forwarded, nothing leaked); no membership row at all is the 403 not-in-a-company refusal (#1612); one that is malformed,
  // revoked or another company's is the 401 refusal.
  const answer = await h.post(); expect(answer.statusCode).toBe(damage === "throws" ? 503 : damage === "missing" ? 403 : 401); expect(answer.body).not.toMatch(/private-canary|org_/); expect(h.forwarded).toEqual([]);
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

it("the broker forwarding seam runtime-refuses every operator kind and malformed invite", async () => {
  const invoke = vi.fn(async () => ({ Payload: Buffer.from('{"ok":true,"expiresAt":1800000000}') }));
  const forward = routes.companyPreapprovalsThroughLambda(invoke);
  const good = { kind: "company-preapprove" as const, companyId: A, email, role: "member" as const, expiresInHours: 1, createdBy: PERSON, inviteHash: "a".repeat(64) };
  expect(await forward(good)).toEqual({ expiresAt: 1_800_000_000 }); invoke.mockClear();
  for (const event of [ { ...good, kind: "company-create" }, { ...good, role: "admin" }, { ...good, companyId: "private-canary" }, { ...good, createdBy: undefined }, { ...good, expiresInHours: 0 }, { ...good, inviteHash: undefined }, { ...good, inviteHash: "rvlink_private-canary" } ]) expect(await forward(event as Parameters<typeof forward>[0])).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  // A stored invitation whose expiry did not come back: 404, and the secret is never shown.
  const h = await inviteWorld();
  h.deps.developer.companyPreapprovals = async () => ({});
  const blind = await h.post();
  expect(blind.statusCode).toBe(404); expect(blind.body).not.toContain("rvlink_");
  // A reply whose expiry is not a positive whole number is no answer.
  for (const reply of ['{"ok":true,"expiresAt":"soon"}', '{"ok":true,"expiresAt":-1}', '{"ok":false,"error":"unavailable"}']) {
    expect(await routes.companyPreapprovalsThroughLambda(async () => ({ Payload: Buffer.from(reply) }))(good)).toBe(false);
  }
});

it.each([{ revokedAt: TIME }, { personId: "b".repeat(64) }])("a membership change after company resolution still refuses: %j", async (damage) => {
  const h = await inviteWorld(); h.deps.companies = { companyOf: async () => A };
  const key = membershipKey(PERSON); h.db.set({ ...h.db.get(key.pk, key.sk)!, ...damage });
  expect((await h.post()).statusCode).toBe(401); expect(h.forwarded).toEqual([]);
});

// #1614: company mode is the only mode: production's broker reads the admin's company whatever the retired COMPANY_SIGNIN variable says.
it("production bootstrap always reads the admin's company", async () => {
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
  // The broker reads its callback signing key from Secrets Manager on its first request.
  const secret = stubCallbackSigningKeySecret();
  const from = vi.spyOn(DynamoDBDocumentClient, "from").mockReturnValue(db as unknown as ReturnType<typeof DynamoDBDocumentClient.from>);
  const invoke = vi.spyOn(LambdaClient.prototype, "send").mockResolvedValue({ Payload: Buffer.from('{"ok":true,"clients":[]}') } as never);
  try {
    for (const [key, value] of Object.entries({ DEVELOPER_TOKEN_ISSUER: issuer, DEVELOPER_IDENTITY_FUNCTION_ARN: "identity", DEVELOPER_SIGNIN_TABLE_NAME: "signin", AGENTX_ENV: "test", ADMIN_CLAIM: "groups", ADMIN_VALUES: '["admins"]' })) vi.stubEnv(key, value);
    for (const flag of [undefined, "disabled", "true", "enabled"]) {
      vi.stubEnv("COMPANY_SIGNIN", flag); vi.resetModules(); reads.mockClear(); invoke.mockClear();
      const { handler } = await import("../../packages/broker/src/aws/broker.js");
      expect((await call((event) => handler(event as Parameters<typeof handler>[0]), { method: "GET", path: "/v1/admin/sign-in-clients", user: { subject: "admin-subject", admin: true } })).status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(1);
      const command = invoke.mock.calls[0]?.[0] as { input: { Payload: Uint8Array } };
      expect(JSON.parse(Buffer.from(command.input.Payload).toString()) as unknown).toEqual({ kind: "list-sign-in-clients", companyId: A });
    }
  } finally { from.mockRestore(); invoke.mockRestore(); reads.mockRestore(); secret.restore(); vi.unstubAllEnvs(); vi.resetModules(); }
});

async function registeredInviteWorld(fullAccess = false, webApp = false) {
  const h = await inviteWorld();
  const clientId = "invite-client";
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: `CLIENT#${clientId}`, entityType: "SIGN_IN_CLIENT", clientId,
    name: "Invite client", audience: clientId, redirectUris: [], loopback: true, companyId: A,
    scopes: [...CLIENT_SCOPES], ...(fullAccess ? { fullAccess: true, secretHash: "f".repeat(64), ...(webApp ? { webApp: true } : {}) } : {}), createdAt: TIME, updatedAt: TIME, updatedBy: "operator" });
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId });
  Object.assign(h.claims, { azp: clientId, aud: clientId, scope: CLIENT_SCOPES.join(" ") });
  const headers = () => ({ authorization: `Bearer ${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(h.claims)).toString("base64url")}.c2ln` });
  const call = (method: "POST" | "DELETE") => h.read(method === "POST" ? path : `${path}/${hash}`, { method, headers: headers(),
    body: JSON.stringify({ email, role: "member", expiresInHours: 24 }) });
  const send = (method: "POST" | "DELETE", requestPath: string, body: unknown = {}) => h.read(requestPath, { method, headers: headers(), body: JSON.stringify(body) });
  return { ...h, call, send };
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
