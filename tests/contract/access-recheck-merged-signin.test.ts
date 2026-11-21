// Access tokens keep their issued person only while the session's stored identity still walks to that person.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const TIME = "2026-11-01T00:00:00.000Z";
const FIRST = "a".repeat(64), MIDDLE = "b".repeat(64), PERSON = "c".repeat(64), OTHER = "d".repeat(64);
const layouts = ["code-company", "install-company", "legacy"] as const;
type Layout = typeof layouts[number];

function world(layout: Layout, method: "oidc" | "slack" = "oidc") {
  const db = new FakeDynamoDb({ seed: 21 });
  const reads: Array<{ pk: string; consistent: boolean }> = [];
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: PERSON, sid: "session", amr: method };
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
      return db.send(command as Parameters<FakeDynamoDb["send"]>[0]);
    } },
    tableName: "State", now: () => NOW,
    ...(layout === "code-company" ? { companies: companyMembershipFromDynamo(db, "SignIn") } : {}),
    developer: { issuer: "https://signin.example.test", env: "test", methods: { oidc: true, slack: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async () => ({ ok: true, memberOf: [] }) },
  };
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // Reuse the exact same access token across checks; only the server-side records change.
  const token = `${part({ alg: "none" })}.${part(claims)}.sig`;
  const access = async () => {
    const request = { method: "POST", path: "/v1/dev/access", headers: { authorization: `Bearer ${token}` }, requestId: "r", body: "{}" };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(request.path, "https://broker.example.test")) }; }
    catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } };
    }
  };
  const changeSession = (extra: Record<string, unknown>) => db.set({ ...db.get("SESSION#session", "META")!, ...extra });
  const refusal = async () => {
    changeSession({ revokedAt: TIME });
    const answer = await access();
    changeSession({ revokedAt: undefined });
    expect(answer.status).toBe(401);
    return answer;
  };
  return { db, reads, claims, person, access, changeSession, refusal };
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
    expect(await w.access()).toEqual(refused);
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
  expect(await w.access()).toEqual(refused);
  w.person(FIRST, { mergedInto: ids[0] }); w.changeSession({ signedInId: FIRST });
  expect(await w.access()).toEqual(refused);
});
