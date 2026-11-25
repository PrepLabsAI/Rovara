// Access tokens keep their issued person only while the session's stored identity still walks to that person.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_CLI_CLIENT_ID, AgentXError, DEVELOPER_TOKEN_AUDIENCE, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { authenticateDeveloperSessionId, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const TIME = "2026-11-01T00:00:00.000Z";
const FIRST = "a".repeat(64), MIDDLE = "b".repeat(64), PERSON = "c".repeat(64), OTHER = "d".repeat(64);
const layouts = ["code-company", "install-company", "legacy"] as const;
type Layout = typeof layouts[number];

function world(layout: Layout, method: "oidc" | "slack" = "oidc", tokenClient = "web-app") {
  const db = new FakeDynamoDb({ seed: 21 });
  const reads: Array<{ pk: string; consistent: boolean }> = [];
  const writes: string[] = [];
  const claims: Record<string, unknown> = { azp: tokenClient, iss: "https://signin.example.test", aud: DEVELOPER_TOKEN_AUDIENCE, env: "test", sub: PERSON, sid: "session", amr: method };
  const person = (id: string, extra: Record<string, unknown> = {}) => db.set({
    pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: method, displayName: id === PERSON ? "Casey" : "Other",
    revoked: false, ...extra,
  });
  person(PERSON); person(OTHER); person(FIRST, { mergedInto: PERSON, slackTeamId: "T0FIRST" });
  db.set({ pk: "SESSION#session", sk: "META", sessionId: "session", developerId: PERSON, amr: method, signedInId: FIRST,
    clientId: "web-app", startedAt: TIME, endsAt: NOW / 1000 + 3600 });
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app",
    redirectUris: ["https://web.example.test/callback"], loopback: false, installLevel: true, fullAccess: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  if (layout === "code-company") {
    db.set({ ...membershipKey(PERSON), entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId: IMPLICIT_COMPANY_ID, role: "member", joinedAt: TIME });
  } else if (layout === "install-company") {
    db.set({ pk: `DEVELOPER_ORG#${PERSON}`, sk: "ORG", orgId: IMPLICIT_COMPANY_ID });
    db.set({ pk: `ORG#${IMPLICIT_COMPANY_ID}`, sk: `MEMBER#${PERSON}`, role: "member" });
    db.set({ pk: `ORG#${IMPLICIT_COMPANY_ID}`, sk: "META", name: "Example" });
  }
  const deps: DeveloperRouteDependencies = {
    documentClient: { send: async (command) => {
      if (command instanceof GetCommand) reads.push({ pk: String(command.input.Key?.pk), consistent: command.input.ConsistentRead === true });
      const sent = command as Parameters<FakeDynamoDb["send"]>[0];
      if (["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"].includes(sent.constructor.name)) writes.push(sent.constructor.name);
      return db.send(sent);
    } },
    tableName: "State", now: () => NOW,
    ...(layout === "code-company" ? { companies: companyMembershipFromDynamo(db, "SignIn") } : {}),
    developer: { issuer: "https://signin.example.test", env: "test", methods: { oidc: true, slack: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async () => ({ ok: true, memberOf: [] }) },
  };
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // Reuse the exact same access token across checks; only the server-side records change.
  const token = `${part({ alg: "none" })}.${part(claims)}.sig`;
  const request = async (method: string, path: string, body: unknown = {}) => {
    const request = { method, path, headers: { authorization: `Bearer ${token}` }, requestId: "r", body: JSON.stringify(body) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(request.path, "https://broker.example.test")) }; }
    catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } };
    }
  };
  const access = () => request("POST", "/v1/dev/access");
  const changeSession = (extra: Record<string, unknown>) => db.set({ ...db.get("SESSION#session", "META")!, ...extra });
  const refusal = async () => {
    changeSession({ revokedAt: TIME });
    const answer = await access();
    changeSession({ revokedAt: undefined });
    expect(answer.status).toBe(401);
    return answer;
  };
  return { db, reads, writes, claims, person, access, request, deps, changeSession, refusal };
}

describe.each(layouts)("merged session authority on every access check (%s)", (layout) => {
  it.each([
    ["moved", { mergedInto: OTHER }],
    ["unlinked", { mergedInto: undefined }],
    ["revoked", { mergedInto: PERSON, revoked: true }],
    ["malformed", { mergedInto: "not-a-person" }],
    ["looped", { mergedInto: FIRST }],
  ])("refuses the next access check when the signed-in identity is %s", async (_name, extra) => {
    const w = world(layout);
    const refused = await w.refusal();
    expect(await w.access()).toMatchObject({ status: 200, body: { developerId: PERSON, displayName: "Casey" } });
    w.person(FIRST, extra);
    expect(await w.access()).toEqual(refused);
  });

  it("refuses a missing signed-in identity on the next check", async () => {
    const w = world(layout);
    const refused = await w.refusal();
    expect((await w.access()).status).toBe(200);
    w.db.delete(`DEVELOPER#${FIRST}`, "META");
    expect(await w.access()).toEqual(refused);
  });

  it("fails closed when the identity read fails after a successful check", async () => {
    const w = world(layout);
    const refused = await w.refusal();
    expect((await w.access()).status).toBe(200);
    w.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: string }).pk === `DEVELOPER#${FIRST}`, error: { name: "ServiceUnavailable" } });
    // A hop whose READ fails is not a revoked hop (membership-read.ts): nothing is served and the answer is the retryable 503; the next check, with the read back, is the 200 again.
    const blip = await w.access();
    expect(blip.status).toBe(503);
    expect(blip).not.toEqual(refused);
  });

  it.each([
    ["revoked", { mergedInto: PERSON, revoked: true }],
    ["moved", { mergedInto: OTHER }],
    ["unlinked", { mergedInto: undefined }],
  ])("refuses a %s middle hop on the next check of A -> B -> C", async (_name, extra) => {
    const w = world(layout);
    const refused = await w.refusal();
    w.person(FIRST, { mergedInto: MIDDLE }); w.person(MIDDLE, { mergedInto: PERSON });
    expect(await w.access()).toMatchObject({ status: 200, body: { developerId: PERSON, displayName: "Casey" } });
    w.person(MIDDLE, extra);
    expect(await w.access()).toEqual(refused);
  });

  it.each(["oidc", "slack"] as const)("allows unchanged %s identity with exactly one extra consistent read, reused only within this request", async (method) => {
    const w = world(layout, method);
    w.changeSession({ signedInId: undefined });
    expect((await w.access()).status).toBe(200);
    const baseline = w.reads.length;
    w.reads.length = 0;
    w.changeSession({ signedInId: FIRST });
    expect(await w.access()).toMatchObject({ status: 200, body: { developerId: PERSON, displayName: "Casey", ...(method === "slack" ? { slackTeamId: "T0FIRST" } : {}) } });
    expect(w.reads).toHaveLength(baseline + 1);
    expect(w.reads.filter((read) => read.pk === `DEVELOPER#${FIRST}`)).toEqual([{ pk: `DEVELOPER#${FIRST}`, consistent: true }]);
    expect(w.reads.filter((read) => read.pk === `DEVELOPER#${PERSON}`)).toEqual([{ pk: `DEVELOPER#${PERSON}`, consistent: true }]);
    w.reads.length = 0;
    expect((await w.access()).status).toBe(200);
    expect(w.reads).toHaveLength(baseline + 1);
    expect(w.reads.filter((read) => read.pk === `DEVELOPER#${FIRST}`)).toHaveLength(1);
  });
});

it("takes the identity from the stored session, ignoring a token's claimed signedInId", async () => {
  const w = world("legacy");
  const refused = await w.refusal();
  w.claims.signedInId = PERSON;
  w.person(FIRST, { mergedInto: OTHER });
  expect(await w.access()).toEqual(refused);
});

it("allows eight live merge hops, but refuses a ninth and a read fault in a middle hop", async () => {
  const w = world("code-company");
  const refused = await w.refusal();
  const ids = Array.from({ length: 8 }, (_, i) => String(i).padStart(64, "0"));
  ids.forEach((id, i) => w.person(id, { mergedInto: ids[i + 1] ?? PERSON }));
  w.changeSession({ signedInId: ids[0] });
  expect((await w.access()).status).toBe(200);
  w.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: string }).pk === `DEVELOPER#${ids[3]!}`, error: { name: "ServiceUnavailable" } });
  // A read fault in a middle hop serves nothing and is the retryable 503 (it is not a revoked hop); the ninth hop is still the refusal.
  expect((await w.access()).status).toBe(503);
  w.person(FIRST, { mergedInto: ids[0] }); w.changeSession({ signedInId: FIRST });
  expect(await w.access()).toEqual(refused);
});


const paths = ["client read", "client write", "direct code-settings write", "CLI", "review cookie"] as const;
type AccessPath = typeof paths[number];

function pathWorld(path: AccessPath) {
  const w = world("legacy", "oidc", path === "CLI" ? AGENTX_CLI_CLIENT_ID : "web-app");
  w.changeSession({ administrator: true });
  w.db.set({ pk: "PROJECT#sample", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "sample", revision: 1 } });
  w.db.set({ pk: `MEMBER#${PERSON}`, sk: "PROJECT#sample", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "sample", role: "administrator" });
  const cookieId = "00000000-0000-4000-8000-000000000021";
  if (path === "CLI" || path === "review cookie") w.changeSession({ clientId: undefined });
  if (path === "CLI") Object.assign(w.claims, { iss: w.deps.developer.issuer, aud: DEVELOPER_TOKEN_AUDIENCE });
  const check = async () => {
    if (path === "client read") return w.request("GET", "/v1/dev/client/projects/sample");
    if (path === "client write") return w.request("PUT", `/v1/dev/client/projects/sample/members/${OTHER}`);
    if (path === "direct code-settings write") {
      const row = w.db.get(`CODE_SETTINGS#${IMPLICIT_COMPANY_ID}#sample`, "CODE_SETTINGS");
      return w.request("PUT", "/v1/dev/client/projects/sample/code-settings", {
        requestId: "00000000-0000-4000-8000-000000000022", expectedRevision: (row?.settings as { revision: number } | undefined)?.revision ?? 0, codeReviewers: ["reviewer"],
      });
    }
    if (path === "CLI") return w.request("GET", "/v1/dev/projects");
    // The browser's opaque cookie identifies the server-side session, never token claims.
    w.db.set({ ...w.db.get("SESSION#session", "META")!, pk: `SESSION#${cookieId}`, sessionId: cookieId, reviewExpiresAt: NOW / 1000 + 86400 });
    try { return { status: 200, body: await authenticateDeveloperSessionId(w.deps, cookieId) }; }
    catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } };
    }
  };
  const refusal = async () => {
    w.changeSession({ revokedAt: TIME });
    const answer = await check();
    w.changeSession({ revokedAt: undefined });
    expect(answer.status).toBe(401);
    expect(answer.body).toHaveProperty("error.code", "AUTH_REQUIRED");
    return answer;
  };
  return { ...w, check, refusal };
}

describe.each(paths)("shared merged sign-in guard: %s", (path) => {
  it.each([
    ["moved", { mergedInto: OTHER }],
    ["revoked", { mergedInto: PERSON, revoked: true }],
  ])("refuses a %s identity on the next request with the existing sign-in-ended 401", async (_state, extra) => {
    const w = pathWorld(path);
    const refused = await w.refusal();
    expect((await w.check()).status).toBe(200);
    const writes = w.writes.length;
    w.claims.signedInId = PERSON;
    w.person(FIRST, extra);
    expect(await w.check()).toEqual(refused);
    expect(w.writes).toHaveLength(writes);
    expect(refused.body).not.toHaveProperty("developerId");
  });

  it("fails closed on an unreadable identity after a successful request", async () => {
    const w = pathWorld(path);
    const refused = await w.refusal();
    expect((await w.check()).status).toBe(200);
    const writes = w.writes.length;
    w.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: string }).pk === `DEVELOPER#${FIRST}`, error: { name: "ServiceUnavailable" } });
    // A hop whose READ fails is not a revoked hop (membership-read.ts): nothing is served or written, and the answer is the retryable 503.
    expect((await w.check()).status).toBe(503);
    expect(w.writes).toHaveLength(writes);
  });

  it("refuses a revoked middle hop on the next request", async () => {
    const w = pathWorld(path);
    const refused = await w.refusal();
    w.person(FIRST, { mergedInto: MIDDLE }); w.person(MIDDLE, { mergedInto: PERSON });
    expect((await w.check()).status).toBe(200);
    const writes = w.writes.length;
    w.person(MIDDLE, { mergedInto: PERSON, revoked: true });
    expect(await w.check()).toEqual(refused);
    expect(w.writes).toHaveLength(writes);
  });

  it("adds exactly one consistent read for a direct identity and rereads it on the next request", async () => {
    const w = pathWorld(path);
    w.changeSession({ signedInId: undefined });
    expect((await w.check()).status).toBe(200);
    const baseline = w.reads.length;
    w.changeSession({ signedInId: FIRST });
    for (let request = 0; request < 2; request += 1) {
      w.reads.length = 0;
      expect((await w.check()).status).toBe(200);
      expect(w.reads).toHaveLength(baseline + 1);
      expect(w.reads.filter((read) => read.pk === `DEVELOPER#${FIRST}`)).toEqual([{ pk: `DEVELOPER#${FIRST}`, consistent: true }]);
    }
  });
});
