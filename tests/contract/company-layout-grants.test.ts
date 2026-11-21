// DEC 254zzz80 (owner, option A), R2-F1 lane 2 (grants): for a NAMED company, its own partition is the ONE place its project grants live
// (`ORG#<company>#MEMBER#<person>` / `PROJECT#<name>`, reverse rows `ORG#<company>#PROJECT_MEMBERS#<name>` / `DEVELOPER#<person>`), for every reader and writer.
// The built-in company and a Code with no company layer keep the legacy keys byte-for-byte. The world below reproduces staging's sign-in exactly (an OIDC session
// through the install's shared method, Code's company membership, client routes always on, DEC 254zzz81) and staging's grant rows (role developer, projectRole maintainer, grantId, ...).
//
// Revisions are lane 1's (revision readers). So that these grant tests do not depend on which revision layout the readers of this commit use, `project()` seeds the
// company's own-layout revision rows exactly as staging holds them AND a legacy revision row stamped with the same company. Grants are only ever seeded in ONE layout.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { checkProjectAccess, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { grantProjectAccess, listProjectMembers, projectGrant, projectMemberKey, revokeProjectAccess } from "../../packages/broker/src/aws/admin-actions.js";
import type { AdminActionDependencies } from "../../packages/broker/src/aws/admin-actions.js";
import { liveCompanyGrantRole, membershipWithRoleFromDynamo, projectGrantRoleFromDynamo } from "../../packages/broker/src/aws/core-engine-root.js";
import { companyKey } from "../../packages/broker/src/developer/company-membership.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-18T19:56:52.000Z");
const TIME = "2026-10-26T21:34:55.126Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "e".repeat(64), MEMBER = "d".repeat(64), BOB = "b".repeat(64), LEGACY = "c".repeat(64);
const PEOPLE = [[OWNER, "Owner"], [MEMBER, "Member"], [BOB, "Bob"], [LEGACY, "Legacy"]] as const;
const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
const sid = (id: string) => `00000000-0000-4000-8000-${id.slice(0, 12)}`;
const rev = (revision: number) => `REV#${String(revision).padStart(12, "0")}`;
const definition = (name: string, revision: number) => {
  const command = (args: string[], timeoutSeconds: number) => [{ executable: "npm", args, cwd: `repo/rovara-${name}`, timeoutSeconds }];
  return {
    name, revision, orchestratorInstructions: "Delegate.", setup: command(["ci"], 900), readiness: command(["test"], 1800),
    repositories: [{ name: `rovara-${name}`, url: `https://github.com/acme/rovara-${name}.git`, defaultBranch: `branch-r${revision}`, credentialRef: "github-agentx-sdlc", installationId: 173228775, githubRepositoryId: 1434821527, path: `repo/rovara-${name}` }],
  };
};

function world() {
  const db = new FakeDynamoDb({ seed: 7 });
  const claims: Record<string, unknown> = { azp: "demo-web", env: "test", sub: OWNER, sid: sid(OWNER), amr: "oidc" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#demo-web", entityType: "SIGN_IN_CLIENT", clientId: "demo-web", name: "Demo Web", audience: "demo-web", redirectUris: ["https://web.example.com/callback"], loopback: false,
    installLevel: true, fullAccess: true, webApp: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name] of PEOPLE) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", displayName: name, email: `${name.toLowerCase()}@example.test`, revoked: false });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
    db.set({ pk: `SESSION#${sid(id)}`, sk: "META", sessionId: sid(id), developerId: id, amr: "oidc", clientId: "demo-web", companyId, ...(companyId === IMPLICIT_COMPANY_ID ? {} : { installMethod: true }), startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  };
  db.set({ ...companyKey(A), entityType: "COMPANY", companyId: A, name: "Rovara Demo", status: "active", createdAt: TIME, createdBy: "operator" });
  db.set({ ...companyKey(B), entityType: "COMPANY", companyId: B, name: "Beta Labs", status: "active", createdAt: TIME, createdBy: "operator" });
  join(OWNER, A, "owner"); join(MEMBER, A, "member"); join(BOB, B, "member"); join(LEGACY, IMPLICIT_COMPANY_ID, "member");
  /** A project as staging holds demo-tasklog (own-layout META, catalog, revisions), plus the stamped legacy revision (see the top of the file). */
  const project = (companyId: string, name: string, revisions = 1) => {
    db.set({ pk: `ORG#${companyId}#PROJECT#${name}`, sk: "META", entityType: "PROJECT_META", name, status: "active", createdAt: TIME, createdBy: OWNER, description: "demo" });
    db.set({ pk: `ORG#${companyId}#PROJECT_CATALOG`, sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", latestRevision: revisions });
    for (let revision = 1; revision <= revisions; revision += 1) {
      db.set({ pk: `ORG#${companyId}#PROJECT#${name}`, sk: rev(revision), entityType: "PROJECT", registeredAt: TIME, registeredBy: OWNER, definition: definition(name, revision) });
    }
    db.set({ pk: `PROJECT#${name}`, sk: rev(revisions), entityType: "PROJECT", companyId, registeredAt: TIME, registeredBy: OWNER, definition: definition(name, revisions) });
  };
  /** A grant exactly as staging's `ORG#<company>#MEMBER#<person>` rows. */
  const grant = (companyId: string, id: string, name: string, role = "developer") =>
    db.set({ pk: `ORG#${companyId}#MEMBER#${id}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: id, projectName: name, role, projectRole: "maintainer", grantId: `g-${name}`, grantedAt: TIME, grantedBy: { developerId: OWNER } });
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
    },
  };
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const call = async (id: string, method: string, path: string, body?: unknown) => {
    claims.sub = id; claims.sid = sid(id);
    const request = { method, path, headers: { authorization: `Bearer ${part({ alg: "none" })}.${part(claims)}.sig` }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code } } as Record<string, unknown> };
    }
  };
  const access = async (id: string) => (await call(id, "POST", "/v1/dev/access", {})).body;
  const names = async (id: string) => ((await access(id)).projects as Array<{ name: string }>).map((entry) => entry.name);
  const members = (id: string, name: string) => call(id, "GET", `/v1/dev/client/projects/${name}/members`);
  const put = (id: string, name: string, target: string) => call(id, "PUT", `/v1/dev/client/projects/${name}/members/${target}`);
  const remove = (id: string, name: string, target: string) => call(id, "DELETE", `/v1/dev/client/projects/${name}/members/${target}`);
  /** The task start's access gate (FR-018), as the start route calls it. */
  const start = async (id: string, name: string) => {
    try { return await checkProjectAccess(deps, { developerId: id }, name); } catch (error) { if (error instanceof AgentXError) return error.code; throw error; }
  };
  /** Every grant-shaped row (either layout) that names this person and project. */
  const grantRows = (id: string, name: string) => db.find((item) => (String(item.pk).endsWith(`MEMBER#${id}`) && item.sk === `PROJECT#${name}`)
    || (String(item.pk).endsWith(`PROJECT_MEMBERS#${name}`) && item.sk === `DEVELOPER#${id}`));
  return { db, deps, project, grant, join, access, names, members, put, remove, start, grantRows };
}

describe("DEC 254zzz80 grants: a named company's grants live only in its own partition", () => {
  it("writes the same person and project independently in two companies and both legacy scopes", async () => {
    const db = new FakeDynamoDb();
    const transactions: TransactWriteCommand[] = [];
    const actions: AdminActionDependencies = {
      documentClient: db, tableName: "State", limitDefaults: { member: 0, organization: 0 }, now: () => NOW,
    };
    const send = actions.documentClient.send.bind(actions.documentClient);
    actions.documentClient = { send: async (command) => {
      if (command instanceof TransactWriteCommand) transactions.push(command);
      return send(command);
    } };
    const by = { issuer: "https://signin.example.test", subject: OWNER };
    for (const [companyId, forward, reverse] of [
      [A, `ORG#${A}#MEMBER#${MEMBER}`, `ORG#${A}#PROJECT_MEMBERS#same`],
      [B, `ORG#${B}#MEMBER#${MEMBER}`, `ORG#${B}#PROJECT_MEMBERS#same`],
      [undefined, `MEMBER#${MEMBER}`, "PROJECT_MEMBERS#same"],
      [IMPLICIT_COMPANY_ID, `MEMBER#${MEMBER}`, "PROJECT_MEMBERS#same"],
    ] as const) {
      // Isolate the two equivalent legacy layouts so each must actually write.
      if (companyId === IMPLICIT_COMPANY_ID) {
        expect(await revokeProjectAccess(actions, "same", MEMBER)).toEqual({ revoked: true });
        transactions.length = 0;
      }
      const before = transactions.length;
      expect(await grantProjectAccess(actions, by, "same", MEMBER, companyId)).toEqual({ granted: true, already: false });
      expect(transactions).toHaveLength(before + 1);
      const writes = transactions.at(-1)?.input.TransactItems;
      expect(writes).toHaveLength(2);
      expect(writes).toEqual([
        { Put: { TableName: "State", Item: {
          pk: forward, sk: "PROJECT#same", entityType: "MEMBERSHIP", ownerKey: MEMBER,
          projectName: "same", role: "developer", grantId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown,
          grantedBy: by, grantedAt: "2026-11-18T19:56:52.000Z",
        }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: "State", Item: {
          pk: reverse, sk: `DEVELOPER#${MEMBER}`, entityType: "PROJECT_MEMBER", role: "developer", grantedAt: "2026-11-18T19:56:52.000Z",
        } } },
      ]);
      expect(db.get(forward, "PROJECT#same")).toMatchObject({ role: "developer" });
      expect(db.get(reverse, `DEVELOPER#${MEMBER}`)).toMatchObject({ role: "developer" });
    }
    expect(db.find((row) => row.entityType === "MEMBERSHIP" || row.entityType === "PROJECT_MEMBER")).toHaveLength(6);
  });

  it("the exact staging shape: the owner with 15 own-layout grants (and no legacy grant row) sees all 15", async () => {
    const w = world();
    const projects = Array.from({ length: 15 }, (_, index) => `demo-${String(index).padStart(2, "0")}`);
    for (const name of projects) { w.project(A, name, name === "demo-00" ? 4 : 1); w.grant(A, OWNER, name); }
    expect(w.db.find((item) => String(item.pk).startsWith("MEMBER#") || String(item.pk).startsWith("PROJECT_MEMBERS#"))).toEqual([]);
    const answer = await w.access(OWNER);
    expect(answer).toMatchObject({ developerId: OWNER, companyId: A, companyRole: "owner" });
    expect(answer.projects).toEqual(projects.map((name) => ({ name, access: "granted" })));
    expect(await w.start(OWNER, "demo-03")).toMatchObject({ access: "granted" });
  });

  it("an own-layout administrator grant answers `administrator`", async () => {
    const w = world();
    w.project(A, "demo-tasklog"); w.grant(A, OWNER, "demo-tasklog", "administrator");
    expect((await w.access(OWNER)).projects).toEqual([{ name: "demo-tasklog", access: "administrator" }]);
  });

  it("the REVOKE HOLE: grant then revoke through Code's own members route; afterwards the access check, task start and member list all say no, and nothing remains in either layout", async () => {
    const w = world();
    w.project(A, "demo-shop");
    expect(await w.names(MEMBER)).toEqual([]);
    expect(await w.start(MEMBER, "demo-shop")).toBe("PROJECT_ACCESS_DENIED");
    // The company owner (company-wide, DEC 254n(3): no grant of their own on the project) grants the member.
    expect((await w.put(OWNER, "demo-shop", MEMBER)).body).toMatchObject({ outcome: "granted" });
    // Written only in the company's own partition.
    expect(w.db.get(`ORG#${A}#MEMBER#${MEMBER}`, "PROJECT#demo-shop")).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: MEMBER, projectName: "demo-shop", role: "developer" });
    expect(w.db.get(`ORG#${A}#PROJECT_MEMBERS#demo-shop`, `DEVELOPER#${MEMBER}`)).toMatchObject({ entityType: "PROJECT_MEMBER", role: "developer" });
    expect(w.db.get(`MEMBER#${MEMBER}`, "PROJECT#demo-shop")).toBeUndefined();
    expect(w.db.get("PROJECT_MEMBERS#demo-shop", `DEVELOPER#${MEMBER}`)).toBeUndefined();
    expect(await w.names(MEMBER)).toEqual(["demo-shop"]);
    expect(await w.start(MEMBER, "demo-shop")).toMatchObject({ access: "granted" });
    expect(((await w.members(OWNER, "demo-shop")).body.members as Array<{ developerId: string }>).map((member) => member.developerId)).toEqual([MEMBER]);
    expect((await w.put(OWNER, "demo-shop", MEMBER)).body).toMatchObject({ outcome: "already_member" });
    // Revoke.
    expect((await w.remove(OWNER, "demo-shop", MEMBER)).body).toMatchObject({ outcome: "revoked" });
    expect(await w.names(MEMBER)).toEqual([]);
    expect(await w.start(MEMBER, "demo-shop")).toBe("PROJECT_ACCESS_DENIED");
    expect((await w.members(OWNER, "demo-shop")).body.members).toEqual([]);
    expect(w.grantRows(MEMBER, "demo-shop")).toEqual([]);
    expect((await w.remove(OWNER, "demo-shop", MEMBER)).body).toMatchObject({ outcome: "not_member" });
  });

  it("revoking a staging grant (written by the install, not by Code) removes it from the company's partition: no access is left behind", async () => {
    const w = world();
    w.project(A, "demo-tasklog"); w.grant(A, MEMBER, "demo-tasklog");
    expect(await w.names(MEMBER)).toEqual(["demo-tasklog"]);
    expect((await w.remove(OWNER, "demo-tasklog", MEMBER)).body).toMatchObject({ outcome: "revoked" });
    expect(await w.names(MEMBER)).toEqual([]);
    expect(await w.start(MEMBER, "demo-tasklog")).toBe("PROJECT_ACCESS_DENIED");
    expect(w.grantRows(MEMBER, "demo-tasklog")).toEqual([]);
  });

  it("a member with and without a grant; a member is never company-wide", async () => {
    const w = world();
    w.project(A, "demo-shop"); w.project(A, "demo-tasklog");
    w.grant(A, OWNER, "demo-shop"); w.grant(A, OWNER, "demo-tasklog");
    expect(await w.names(MEMBER)).toEqual([]);
    expect((await w.members(MEMBER, "demo-shop")).status).toBe(403);
    w.grant(A, MEMBER, "demo-shop");
    expect(await w.names(MEMBER)).toEqual(["demo-shop"]);
    expect(await w.start(MEMBER, "demo-tasklog")).toBe("PROJECT_ACCESS_DENIED");
    // A developer grant does not manage members; an own-layout administrator grant does.
    expect((await w.put(MEMBER, "demo-shop", OWNER)).status).toBe(403);
    w.grant(A, MEMBER, "demo-shop", "administrator");
    expect((await w.members(MEMBER, "demo-shop")).status).toBe(200);
  });

  it("a legacy grant row never gives a named company's member anything (no dual read)", async () => {
    const w = world();
    w.project(A, "demo-shop");
    w.db.set({ pk: `MEMBER#${MEMBER}`, sk: "PROJECT#demo-shop", entityType: "MEMBERSHIP", ownerKey: MEMBER, projectName: "demo-shop", role: "administrator", grantId: "legacy" });
    expect(await w.names(MEMBER)).toEqual([]);
    expect(await w.start(MEMBER, "demo-shop")).toBe("PROJECT_ACCESS_DENIED");
    expect((await w.members(MEMBER, "demo-shop")).status).toBe(403);
  });

  it("two companies: grants are read in the caller's LIVE company only; another company's partition, and rows naming another company, are never theirs", async () => {
    const w = world();
    w.project(A, "demo-tasklog"); w.grant(A, OWNER, "demo-tasklog");
    w.project(B, "beta-app"); w.grant(B, BOB, "beta-app");
    // Strays: a grant for Bob in A's partition, one for the owner in B's.
    w.grant(A, BOB, "demo-tasklog"); w.grant(B, OWNER, "beta-app");
    expect(await w.names(OWNER)).toEqual(["demo-tasklog"]);
    expect(await w.names(BOB)).toEqual(["beta-app"]);
    expect(await w.start(BOB, "demo-tasklog")).not.toMatchObject({ access: "granted" });
    expect(await w.start(OWNER, "beta-app")).not.toMatchObject({ access: "granted" });
    // A row in B's own partition that names company A is drift: never Bob's grant.
    w.project(B, "beta-two");
    w.db.set({ pk: `ORG#${B}#MEMBER#${BOB}`, sk: "PROJECT#beta-two", entityType: "MEMBERSHIP", ownerKey: BOB, projectName: "beta-two", role: "developer", companyId: A });
    w.db.set({ pk: `ORG#${B}#MEMBER#${BOB}`, sk: "PROJECT#beta-other", entityType: "MEMBERSHIP", ownerKey: BOB, projectName: "beta-two", role: "developer" });
    expect(await w.names(BOB)).toEqual(["beta-app"]);
    // A's owner never manages B's members, nor writes into B's partition.
    expect((await w.put(OWNER, "beta-app", BOB)).status).toBeGreaterThanOrEqual(400);
    // Moving Bob to company A (live membership) changes which partition is read at once.
    w.join(BOB, A, "member");
    expect(await w.names(BOB)).toEqual(["demo-tasklog"]);
  });

  it("the same project name in two companies: each company's grant, member list, grant and revoke touch only its own partition", async () => {
    const w = world();
    const actions = { documentClient: w.db, tableName: "State", limitDefaults: { member: 0, organization: 0 }, now: () => NOW };
    const by = { issuer: "sign-in-client:demo-web", subject: OWNER };
    await grantProjectAccess(actions, by, "same", MEMBER, A);
    await grantProjectAccess(actions, by, "same", BOB, B);
    expect(await projectGrant(actions, "same", MEMBER, A)).toMatchObject({ role: "developer" });
    expect(await projectGrant(actions, "same", MEMBER, B)).toBeUndefined();
    expect(await projectGrant(actions, "same", BOB, A)).toBeUndefined();
    expect((await listProjectMembers(actions, "same", A)).map((member) => member.developerId)).toEqual([MEMBER]);
    expect((await listProjectMembers(actions, "same", B)).map((member) => member.developerId)).toEqual([BOB]);
    // A reverse row in A's partition naming company B is not listed.
    w.db.set({ pk: `ORG#${A}#PROJECT_MEMBERS#same`, sk: `DEVELOPER#${OWNER}`, entityType: "PROJECT_MEMBER", role: "developer", companyId: B });
    expect((await listProjectMembers(actions, "same", A)).map((member) => member.developerId)).toEqual([MEMBER]);
    // A grant row in A's partition naming company B, or another project, is none.
    w.db.set({ pk: `ORG#${A}#MEMBER#${OWNER}`, sk: "PROJECT#same", entityType: "MEMBERSHIP", ownerKey: OWNER, projectName: "same", role: "developer", orgId: B });
    expect(await projectGrant(actions, "same", OWNER, A)).toBeUndefined();
    w.db.set({ pk: `ORG#${A}#MEMBER#${OWNER}`, sk: "PROJECT#same", entityType: "MEMBERSHIP", ownerKey: OWNER, projectName: "other", role: "developer" });
    expect(await projectGrant(actions, "same", OWNER, A)).toBeUndefined();
    // Revoking in B leaves A's grant.
    expect(await revokeProjectAccess(actions, "same", BOB, B)).toEqual({ revoked: true });
    expect(await revokeProjectAccess(actions, "same", MEMBER, B)).toEqual({ revoked: false });
    expect(await projectGrant(actions, "same", MEMBER, A)).toMatchObject({ role: "developer" });
    expect(w.grantRows(BOB, "same")).toEqual([]);
  });

  it("the core's grant reader: the person's LIVE company decides the partition; drift is none", async () => {
    const w = world();
    const role = projectGrantRoleFromDynamo(w.db, "State");
    const live = liveCompanyGrantRole(membershipWithRoleFromDynamo(w.db, "SignIn"), role);
    w.grant(A, OWNER, "demo-tasklog", "administrator");
    w.db.set({ pk: `MEMBER#${MEMBER}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: MEMBER, projectName: "demo-tasklog", role: "developer" });
    expect(await live(OWNER, "demo-tasklog")).toBe("administrator");
    expect(await role(OWNER, "demo-tasklog", A)).toBe("administrator");
    expect(await role(OWNER, "demo-tasklog", B)).toBeUndefined();
    expect(await role(OWNER, "demo-tasklog")).toBeUndefined();
    // MEMBER is in company A: their legacy row is not read.
    expect(await live(MEMBER, "demo-tasklog")).toBeUndefined();
    // A row in A's partition that names another company is none.
    w.db.set({ pk: `ORG#${A}#MEMBER#${BOB}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: BOB, projectName: "demo-tasklog", role: "developer", companyId: B });
    expect(await role(BOB, "demo-tasklog", A)).toBeUndefined();
  });

  it("golden: the implicit company and no company read and write exactly the legacy rows, byte for byte", async () => {
    const w = world();
    const actions = { documentClient: w.db, tableName: "State", limitDefaults: { member: 0, organization: 0 }, now: () => NOW };
    const by = { issuer: "sign-in-client:demo-web", subject: OWNER };
    for (const company of [undefined, IMPLICIT_COMPANY_ID]) {
      expect(await grantProjectAccess(actions, by, "old-app", LEGACY, company)).toEqual({ granted: true, already: false });
      const row = w.db.get(`MEMBER#${LEGACY}`, "PROJECT#old-app")!;
      expect(row).toEqual({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#old-app", entityType: "MEMBERSHIP", ownerKey: LEGACY, projectName: "old-app", role: "developer", grantId: row.grantId, grantedBy: by, grantedAt: new Date(NOW).toISOString() });
      expect(w.db.get("PROJECT_MEMBERS#old-app", `DEVELOPER#${LEGACY}`)).toEqual({ pk: "PROJECT_MEMBERS#old-app", sk: `DEVELOPER#${LEGACY}`, entityType: "PROJECT_MEMBER", role: "developer", grantedAt: new Date(NOW).toISOString() });
      expect(projectMemberKey("old-app", LEGACY, company)).toEqual({ pk: "PROJECT_MEMBERS#old-app", sk: `DEVELOPER#${LEGACY}` });
      expect(await listProjectMembers(actions, "old-app", company)).toEqual([{ developerId: LEGACY, role: "developer", grantedAt: new Date(NOW).toISOString() }]);
      expect(await projectGrantRoleFromDynamo(w.db, "State")(LEGACY, "old-app", company)).toBe("developer");
      expect(await revokeProjectAccess(actions, "old-app", LEGACY, company)).toEqual({ revoked: true });
      expect(w.grantRows(LEGACY, "old-app")).toEqual([]);
    }
    // The legacy stored-company rule is kept as it was: a legacy row stamped for a named company is not the built-in company's grant (no company: no check).
    w.db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#stamped", projectName: "stamped", role: "developer", companyId: B });
    expect(await projectGrant(actions, "stamped", LEGACY, IMPLICIT_COMPANY_ID)).toBeUndefined();
    expect(await projectGrant(actions, "stamped", LEGACY)).toMatchObject({ role: "developer" });
    // The implicit company's member through the routes: the legacy grant is the one read.
    w.db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#old-app", projectName: "old-app", role: "developer" });
    w.db.set({ pk: "PROJECT#old-app", sk: "REV#0001", definition: { name: "old-app", revision: 3, repositories: [] } });
    expect(await w.names(LEGACY)).toEqual(["old-app"]);
    expect(await w.start(LEGACY, "old-app")).toMatchObject({ access: "granted", revision: 3 });
    // An own-layout row under the implicit company's id is never read.
    w.db.set({ pk: `ORG#${IMPLICIT_COMPANY_ID}#MEMBER#${LEGACY}`, sk: "PROJECT#other-app", projectName: "other-app", role: "developer" });
    w.db.set({ pk: "PROJECT#other-app", sk: "REV#0001", definition: { name: "other-app", revision: 1, repositories: [] } });
    expect(await w.names(LEGACY)).toEqual(["old-app"]);
  });
});
