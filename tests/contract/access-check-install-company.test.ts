// DEC 254: with Code's company sign-in layer off (staging today), the access check (POST /v1/dev/access) reads the install's company-scoped records
// (DEVELOPER_ORG pointer, ORG#<company> member and META, ORG#<company>#MEMBER#<person> grants, ORG#<company>#PROJECT_CATALOG, ORG#<company>#PROJECT#<name> revisions)
// and follows a merged sign-in (`mergedInto`) to its survivor. Legacy-only installs read exactly as before. Another company's records are never visible.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccessCheckResponseSchema, AgentXError, type ChannelMembersRequest } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { MERGE_HOPS_MAX } from "../../packages/broker/src/aws/install-company.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const hex = (c: string) => c.repeat(64);
const SURVIVOR = hex("1"), SLACK_DUP = hex("2"), MEMBER = hex("3"), OTHER = hex("4"), LEGACY = hex("5"), LEGACY_DUP = hex("6"), NOPOINTER = hex("7");
const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
const REFUSED = { status: 401, body: { error: { code: "AUTH_REQUIRED", message: expect.any(String) as unknown } } };
const rev = (n: number, developerTasks?: unknown) => ({ sk: `REV#${String(n).padStart(12, "0")}`, entityType: "PROJECT", definition: { revision: n, ...(developerTasks === undefined ? {} : { developerTasks }) } });

function world() {
  const db = new FakeDynamoDb({ seed: 5 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: SURVIVOR, sid: "s", amr: "slack" };
  const channelCalls: ChannelMembersRequest[] = [];
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, fullAccess: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const person = (id: string, name: string, extra: Record<string, unknown> = {}) => {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false, ...extra });
    db.set({ pk: `SESSION#s-${id}`, sk: "META", sessionId: `s-${id}`, developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  };
  const company = (org: string, name: string, extra: Record<string, unknown> = {}) => db.set({ pk: `ORG#${org}`, sk: "META", entityType: "ORG", orgId: org, name, createdAt: TIME, ...extra });
  const member = (org: string, id: string, role: string) => {
    db.set({ pk: `DEVELOPER_ORG#${id}`, sk: "ORG", entityType: "DEVELOPER_ORG", developerId: id, orgId: org });
    db.set({ pk: `ORG#${org}`, sk: `MEMBER#${id}`, entityType: "ORG_MEMBER", developerId: id, role, joinedAt: TIME });
  };
  const project = (org: string, name: string, revision = 1, developerTasks?: unknown) => {
    db.set({ pk: `ORG#${org}#PROJECT_CATALOG`, sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", name, latestRevision: revision, companyId: org });
    db.set({ pk: `ORG#${org}#PROJECT#${name}`, ...rev(revision, developerTasks) });
  };
  const grant = (org: string, id: string, name: string, role = "developer") => db.set({ pk: `ORG#${org}#MEMBER#${id}`, sk: `PROJECT#${name}`, projectName: name, role, ownerKey: id });

  person(SURVIVOR, "Founder", { slackUserId: undefined });
  person(SLACK_DUP, "Founder (Slack)", { slackUserId: "U0FOUNDER", mergedInto: SURVIVOR, mergedAt: TIME });
  person(MEMBER, "Mia", { slackUserId: "U0MIA" });
  person(OTHER, "Otto");
  person(LEGACY, "Lee");
  person(LEGACY_DUP, "Lee (old)", { mergedInto: LEGACY });
  person(NOPOINTER, "Nina");
  company(A, "Founders Co"); company(B, "Other Co");
  member(A, SURVIVOR, "owner"); member(A, MEMBER, "member"); member(B, OTHER, "owner");
  project(A, "web", 3); project(A, "api", 2); project(A, "chat", 1, { channelMembersMayUse: true });
  project(B, "web", 7); project(B, "secret-b", 1);
  grant(A, MEMBER, "api");
  // Planted traps: MEMBER's grant in the OTHER company, and legacy-shaped rows a company person must never read.
  grant(B, MEMBER, "secret-b");
  db.set({ pk: `MEMBER#${MEMBER}`, sk: "PROJECT#legacy-trap", projectName: "legacy-trap", role: "developer" });
  db.set({ pk: "PROJECT#legacy-trap", ...rev(1) });
  // A legacy-only install's person.
  db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#legacy", projectName: "legacy", role: "developer" });
  db.set({ pk: "PROJECT#legacy", ...rev(4) });
  db.set({ pk: `ORG#${A}#SLACK_BINDING#T0TEAM`, sk: "CHANNEL#C0CHAT", teamId: "T0TEAM", channelId: "C0CHAT", projectName: "chat", updatedAt: TIME });

  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW,
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", slackTeamId: "T0TEAM",
      verifyAccessToken: async () => claims,
      channelMembers: async (request) => { channelCalls.push(request); return { ok: true, memberOf: request.slackUserId === "U0MIA" ? request.channelIds : [] }; },
    },
  };
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const send = async (authorization: string, body: unknown) => {
    const request = { method: "POST", path: "/v1/dev/access", headers: { authorization }, requestId: "r", body: JSON.stringify(body) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL("/v1/dev/access", "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const asPerson = (id: string) => { claims.sub = id; claims.sid = `s-${id}`; return send(`Bearer ${part({ alg: "none" })}.${part(claims)}.sig`, {}); };
  const asService = (id: string) => send(`Basic ${Buffer.from(`web-app:${SECRET}`).toString("base64")}`, { developerId: id });
  return { db, deps, claims, channelCalls, person, company, member, project, grant, asPerson, asService };
}
const names = (body: Record<string, unknown>) => (body.projects as Array<{ name: string; access: string }>).map((p) => `${p.name}:${p.access}`);
const companyOf = (body: Record<string, unknown>) => ({ companyId: body.companyId, companyRole: body.companyRole, companyName: body.companyName });

describe("DEC 254: the install's company-scoped records", () => {
  it("the owner sees every project of their company's catalog, with the company", async () => {
    const w = world();
    for (const ask of [w.asPerson, w.asService]) {
      const answer = await ask(SURVIVOR);
      expect(answer.status).toBe(200);
      expect(names(answer.body)).toEqual(["api:granted", "chat:granted", "web:granted"]);
      expect(companyOf(answer.body)).toEqual({ companyId: A, companyRole: "owner", companyName: "Founders Co" });
      expect(AccessCheckResponseSchema.parse(answer.body)).toEqual(answer.body);
    }
  });

  it("a merged sign-in sees the survivor's projects and company, and keeps its own id", async () => {
    const w = world();
    for (const ask of [w.asPerson, w.asService]) {
      const answer = await ask(SLACK_DUP);
      expect(answer.status).toBe(200);
      expect(answer.body.developerId).toBe(SLACK_DUP);
      expect(answer.body.displayName).toBe("Founder");
      expect(names(answer.body)).toEqual(["api:granted", "chat:granted", "web:granted"]);
      expect(companyOf(answer.body)).toEqual({ companyId: A, companyRole: "owner", companyName: "Founders Co" });
    }
  });

  it("a member sees only their grants and channel projects in their own company, never another company's or legacy rows", async () => {
    const w = world();
    const answer = await w.asPerson(MEMBER);
    expect(names(answer.body)).toEqual(["api:granted", "chat:channel"]);
    expect(companyOf(answer.body)).toEqual({ companyId: A, companyRole: "member", companyName: "Founders Co" });
    expect(JSON.stringify(answer.body)).not.toMatch(/secret-b|legacy-trap|Other Co|org_b/);
    // The channel check ran for the company's own binding (positive control for the channel path).
    expect(w.channelCalls.map((call) => call.channelIds)).toEqual([["C0CHAT"]]);
  });

  it("two companies with a same-named project: each reads only its own", async () => {
    const w = world();
    const other = await w.asPerson(OTHER);
    expect(names(other.body)).toEqual(["secret-b:granted", "web:granted"]);
    expect(companyOf(other.body)).toEqual({ companyId: B, companyRole: "owner", companyName: "Other Co" });
    expect(JSON.stringify(other.body)).not.toMatch(/Founders|org_a|"api|"chat/);
    const founder = await w.asPerson(SURVIVOR);
    expect(JSON.stringify(founder.body)).not.toMatch(/secret-b|Other Co/);
  });

  it("a project with no revision in the company is not listed", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#ghost", name: "ghost" });
    expect(names((await w.asPerson(SURVIVOR)).body)).not.toContain("ghost:granted");
  });

  it("legacy-only data still works, exactly as before, with no company fields", async () => {
    const w = world();
    const answer = await w.asPerson(LEGACY);
    expect(answer.status).toBe(200);
    expect(names(answer.body)).toEqual(["legacy:granted"]);
    expect(Object.keys(answer.body).sort()).toEqual(["administrator", "developerId", "displayName", "nameChosen", "notices", "projects"]);
    const none = await w.asPerson(NOPOINTER);
    expect(none.status).toBe(200);
    expect(names(none.body)).toEqual([]);
  });

  it("a merged sign-in on a legacy install reads the survivor's legacy grants", async () => {
    const w = world();
    const answer = await w.asService(LEGACY_DUP);
    expect(answer.body.developerId).toBe(LEGACY_DUP);
    expect(names(answer.body)).toEqual(["legacy:granted"]);
  });

  it(`follows up to ${MERGE_HOPS_MAX} merges; one more, or a loop, refuses`, async () => {
    const w = world();
    const chain = (length: number, prefix: string) => {
      const ids = Array.from({ length }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`.padEnd(64, "0"));
      ids.forEach((id, i) => w.person(id, `P${i}`, i + 1 < ids.length ? { mergedInto: ids[i + 1] } : {}));
      w.member(A, ids[ids.length - 1]!, "member"); w.grant(A, ids[ids.length - 1]!, "api");
      return ids[0]!;
    };
    expect(names((await w.asPerson(chain(MERGE_HOPS_MAX + 1, "a"))).body)).toEqual(["api:granted"]);
    expect(await w.asPerson(chain(MERGE_HOPS_MAX + 2, "b"))).toEqual(REFUSED);
    const x = hex("8"), y = hex("9");
    w.person(x, "X", { mergedInto: y }); w.person(y, "Y", { mergedInto: x });
    expect(await w.asPerson(x)).toEqual(REFUSED);
    w.person(x, "X", { mergedInto: x });
    expect(await w.asPerson(x)).toEqual(REFUSED);
    // A mergedInto that is not a person id is never followed, even to a readable record.
    w.person(x, "X", { mergedInto: "not-an-id" });
    w.db.set({ pk: "DEVELOPER#not-an-id", sk: "META", displayName: "Planted", revoked: false });
    w.db.set({ pk: "DEVELOPER_ORG#not-an-id", sk: "ORG", orgId: A });
    w.db.set({ pk: `ORG#${A}`, sk: "MEMBER#not-an-id", role: "owner" });
    expect(await w.asPerson(x)).toEqual(REFUSED);
  });

  it.each([
    ["the survivor is revoked", (w: ReturnType<typeof world>) => w.person(SURVIVOR, "Founder", { revoked: true })],
    ["the merged sign-in itself is revoked", (w: ReturnType<typeof world>) => w.person(SLACK_DUP, "Dup", { revoked: true, mergedInto: SURVIVOR })],
    ["the survivor's record is missing", (w: ReturnType<typeof world>) => w.db.delete(`DEVELOPER#${SURVIVOR}`, "META")],
    ["the member record is gone (removed)", (w: ReturnType<typeof world>) => w.db.delete(`ORG#${A}`, `MEMBER#${SURVIVOR}`)],
    ["the person is banned", (w: ReturnType<typeof world>) => w.db.set({ pk: `ORG#${A}#BAN`, sk: SURVIVOR, at: TIME })],
    ["the company is closed", (w: ReturnType<typeof world>) => w.company(A, "Founders Co", { closedAt: TIME })],
    ["the company record is gone", (w: ReturnType<typeof world>) => w.db.delete(`ORG#${A}`, "META")],
    ["the role is the install's Auditor", (w: ReturnType<typeof world>) => w.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${SURVIVOR}`, role: "auditor" })],
    ["the role is unreadable", (w: ReturnType<typeof world>) => w.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${SURVIVOR}` })],
    ["the pointer names no company", (w: ReturnType<typeof world>) => w.db.set({ pk: `DEVELOPER_ORG#${SURVIVOR}`, sk: "ORG", orgId: "org_A" })],
  ])("refuses, never falls back, when %s", async (_name, breakIt) => {
    const w = world();
    breakIt(w);
    for (const answer of [await w.asPerson(SLACK_DUP), await w.asService(SLACK_DUP)]) {
      expect(answer).toEqual(REFUSED);
      expect(JSON.stringify(answer.body)).not.toMatch(/org_|Founders|api|web/);
    }
  });

  it("a pointer to another company gives that company's records only (the pointer, member record and grants agree by key)", async () => {
    const w = world();
    // MEMBER's pointer moves to B, but MEMBER has no member record in B: refused, and A's grant is not used.
    w.db.set({ pk: `DEVELOPER_ORG#${MEMBER}`, sk: "ORG", orgId: B });
    expect(await w.asPerson(MEMBER)).toEqual(REFUSED);
    w.db.set({ pk: `ORG#${B}`, sk: `MEMBER#${MEMBER}`, role: "member" });
    const answer = await w.asPerson(MEMBER);
    expect(names(answer.body)).toEqual(["secret-b:granted"]);
    expect(companyOf(answer.body)).toEqual({ companyId: B, companyRole: "member", companyName: "Other Co" });
  });

  it("a merged Slack sign-in keeps its Slack link for channel projects when the survivor has none", async () => {
    const w = world();
    const slackOnly = hex("a"), web = hex("b");
    w.person(web, "Web Mia"); w.person(slackOnly, "Slack Mia", { slackUserId: "U0MIA", mergedInto: web });
    w.member(A, web, "member");
    expect(names((await w.asPerson(slackOnly)).body)).toEqual(["chat:channel"]);
  });

  it("a viewer grant gives no task use", async () => {
    const w = world();
    w.grant(A, MEMBER, "web", "viewer");
    expect(names((await w.asPerson(MEMBER)).body)).not.toContain("web:granted");
  });
});
