// R2-F1 acceptance (owner DEC 254zzz80, 2026-11-18): the whole customer journey on the EXACT staging shape, end to end.
// Staging: company org_jckf8av6ri11rszcdjsa ("Rovara Demo"), its owner e46d… signed in through the install's shared OIDC method (session with companyId +
// installMethod), 15 `ORG#<c>#MEMBER#<owner>` / `PROJECT#<p>` grants (role developer, projectRole maintainer) and 15 projects in the company layout
// (`ORG#<c>#PROJECT#<p>` META + REV rows, `ORG#<c>#PROJECT_CATALOG` rows), the Slack binding at `ORG#<c>#SLACK_BINDING#<team>` / `CHANNEL#<ch>`, and NO legacy
// `MEMBER#` / `PROJECT#` / `PROJECT_MEMBERS#` / `SLACK_BINDING#` rows at all. Company sign-in (Code's company layer) is on.
// Besides the owner: an admin and a member of the same company with 0 grants, and a second company with a same-named project. The built-in (implicit)
// company keeps the legacy keys byte for byte.
// Entry points: POST /v1/dev/access, GET /v1/dev/client/projects/{p}, GET .../setup-status, PUT/DELETE/GET .../members, the core's task start check
// (hostedTaskAccess with the root's own membership and grant readers), the Slack channel -> project resolution (linkedProjectOf), and the live role rules
// the core uses for an owner or admin (setupRunStandingFrom, wikiProjectRoleFrom).
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID, ProjectSetupChecklistSchema, type Principal } from "@agentx/contracts";
import { COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import {
  hostedTaskAccess, liveCompanyGrantRole, membershipWithRoleFromDynamo, NO_PROJECT_GRANT, NOT_A_MEMBER_HERE, projectGrantRoleFromDynamo, setupRunStandingFrom, wikiProjectRoleFrom,
} from "../../packages/broker/src/aws/core-engine-root.js";
import { grantKeyFor, projectMemberRowKeyFor, revisionKeyFor, revisionPkFor } from "../../packages/broker/src/aws/company-layout.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { linkedProjectOf, type SlackChannelContext } from "../../packages/broker/src/aws/slack-channel-link.js";
import { namedCompanySlackBinding } from "../../packages/broker/src/aws/company-layout.js";
import { slackBindingCompany, slackBindingInCompany } from "../../packages/broker/src/aws/slack-person.js";
import { companyInstallKey } from "../../packages/broker/src/aws/slack-company-install.js";
import { parseBinding, teamKey } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { companyKey } from "../../packages/broker/src/developer/company-membership.js";
import { mayUseProject } from "../../packages/broker/src/developer/task-project-access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-18T19:56:52.000Z");
const TIME = "2026-10-26T21:34:55.126Z";
/** Staging's company, and a second company holding a project of the same name. */
const DEMO = "org_jckf8av6ri11rszcdjsa";
const BETA = COMPANY_B.orgId;
const OWNER = "e46d0c0a".padEnd(64, "e"), ADMIN = "a".repeat(64), MEMBER = "d".repeat(64), BOB = "b".repeat(64), LEGACY = "c".repeat(64);
const PEOPLE = [[OWNER, "Owner"], [ADMIN, "Admin"], [MEMBER, "Member"], [BOB, "Bob"], [LEGACY, "Legacy"]] as const;
const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
const TEAM = "T0BSHLLUGBD", CHANNEL = "C0CCBS6BBU3";
const LEGACY_TEAM = "T0LEGACY01", LEGACY_CHANNEL = "C0LEGACY01";
/** The 15 projects of staging's company (demo-tasklog has 4 revisions there). */
const DEMO_PROJECTS = [
  "demo-tasklog", "demo-shop", "demo-inventory", "demo-billing", "demo-auth", "demo-search", "demo-notify", "demo-reports",
  "demo-gateway", "demo-mobile", "demo-admin", "demo-docs", "demo-etl", "demo-ml", "demo-web",
] as const;
const BETA_CANARY = "beta-canary-r2f1";

const sid = (id: string) => `00000000-0000-4000-8000-${id.slice(0, 12)}`;
const rev = (revision: number) => `REV#${String(revision).padStart(12, "0")}`;
/** A stored project definition as staging holds demo-tasklog's (setup and readiness commands, one GitHub repository). */
const definition = (name: string, revision: number, owner = "acme") => {
  const command = (args: string[], timeoutSeconds: number) => [{ executable: "npm", args, cwd: `repo/rovara-${name}`, timeoutSeconds }];
  return {
    name, revision, orchestratorInstructions: "Delegate.", setup: command(["ci"], 900), readiness: command(["test"], 1800),
    repositories: [{ name: `rovara-${name}`, url: `https://github.com/${owner}/rovara-${name}.git`, defaultBranch: `branch-r${revision}`, credentialRef: "github-agentx-sdlc", installationId: 173228775, githubRepositoryId: 1434821527, path: `repo/rovara-${name}` }],
  };
};

function world() {
  const db = new FakeDynamoDb({ seed: 11 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: OWNER, sid: sid(OWNER), amr: "oidc" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, fullAccess: true, webApp: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name] of PEOPLE) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", displayName: name, email: `${name.toLowerCase()}@example.test`, revoked: false });
  /** Live membership (`COMPANY_MEMBER#<person>` / `COMPANY` in the sign-in table) and an OIDC session through the install's shared method naming that company. */
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
    db.set({ pk: `SESSION#${sid(id)}`, sk: "META", sessionId: sid(id), developerId: id, amr: "oidc", clientId: "web-app", companyId, ...(companyId === IMPLICIT_COMPANY_ID ? {} : { installMethod: true }), startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  };
  /** A project in the company layout, as staging holds them: META (active), the catalog pointer, the revisions (the partition names the company; no companyId field). */
  const project = (companyId: string, name: string, revisions: number, owner = "acme") => {
    db.set({ pk: `ORG#${companyId}#PROJECT#${name}`, sk: "META", entityType: "PROJECT_META", name, status: "active", createdAt: TIME, createdBy: OWNER, description: "demo" });
    db.set({ pk: `ORG#${companyId}#PROJECT_CATALOG`, sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", latestRevision: revisions });
    for (let revision = 1; revision <= revisions; revision += 1) {
      db.set({ pk: `ORG#${companyId}#PROJECT#${name}`, sk: rev(revision), entityType: "PROJECT", registeredAt: TIME, registeredBy: OWNER, definition: definition(name, revision, owner) });
    }
  };
  /** A grant in the company layout, as staging's 15 rows (role developer, projectRole maintainer, entityType MEMBERSHIP). */
  const grant = (companyId: string, id: string, name: string) =>
    db.set({ pk: `ORG#${companyId}#MEMBER#${id}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: id, projectName: name, role: "developer", projectRole: "maintainer", grantId: `g-${name}`, grantedAt: TIME, grantedBy: { developerId: OWNER } });

  // Company records and memberships.
  db.set({ ...companyKey(DEMO), entityType: "COMPANY", companyId: DEMO, name: "Rovara Demo", status: "active", createdAt: TIME, createdBy: "operator" });
  db.set({ ...companyKey(BETA), entityType: "COMPANY", companyId: BETA, name: BETA_CANARY, status: "active", createdAt: TIME, createdBy: "operator" });
  join(OWNER, DEMO, "owner"); join(ADMIN, DEMO, "admin"); join(MEMBER, DEMO, "member"); join(BOB, BETA, "member"); join(LEGACY, IMPLICIT_COMPANY_ID, "member");

  // Staging's company: 15 projects and the owner's 15 grants; the admin and the member hold none.
  for (const name of DEMO_PROJECTS) { project(DEMO, name, name === "demo-tasklog" ? 4 : 1); grant(DEMO, OWNER, name); }
  // Its Slack workspace: the team -> company binding (DEC 254zzz79), the company's own Add to Slack record, and demo-tasklog's channel in the company's layout.
  db.set({ ...teamKey(TEAM), entityType: "SLACK_WORKSPACE_BINDING", teamId: TEAM, companyId: DEMO, boundAt: TIME, boundBy: OWNER });
  db.set({ ...companyInstallKey(DEMO), entityType: "SLACK_COMPANY_WORKSPACE", companyId: DEMO, teamId: TEAM, status: "connected" });
  db.set({ pk: `ORG#${DEMO}#SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}`, teamId: TEAM, channelId: CHANNEL, projectName: "demo-tasklog", updatedAt: TIME, updatedBy: OWNER });

  // The second company: its own demo-tasklog (another repository owner: a canary), and Bob's grant on it.
  project(BETA, "demo-tasklog", 1, BETA_CANARY); grant(BETA, BOB, "demo-tasklog");

  // The built-in company: legacy keys only (a project, a grant, a Slack binding), exactly as before R2-F1.
  db.set({ pk: "PROJECT#old-app", sk: rev(1), entityType: "PROJECT", registeredAt: TIME, registeredBy: LEGACY, definition: definition("old-app", 1) });
  db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#old-app", entityType: "MEMBERSHIP", ownerKey: LEGACY, projectName: "old-app", role: "developer", grantedAt: TIME });
  db.set({ pk: `PROJECT_MEMBERS#old-app`, sk: `DEVELOPER#${LEGACY}`, developerId: LEGACY, projectName: "old-app", role: "developer", grantedAt: TIME });
  db.set({ pk: `SLACK_BINDING#${LEGACY_TEAM}`, sk: `CHANNEL#${LEGACY_CHANNEL}`, teamId: LEGACY_TEAM, channelId: LEGACY_CHANNEL, projectName: "old-app", updatedAt: TIME, updatedBy: LEGACY });

  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW,
    companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", clientRoutes: true,
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
  const access = (id: string) => call(id, "POST", "/v1/dev/access", {});
  const read = (id: string, name: string) => call(id, "GET", `/v1/dev/client/projects/${name}`);
  const setupStatus = (id: string, name: string) => call(id, "GET", `/v1/dev/client/projects/${name}/setup-status`);
  const members = (id: string, name: string) => call(id, "GET", `/v1/dev/client/projects/${name}/members`);
  const addMember = (id: string, name: string, target: string) => call(id, "PUT", `/v1/dev/client/projects/${name}/members/${target}`, {});
  const removeMember = (id: string, name: string, target: string) => call(id, "DELETE", `/v1/dev/client/projects/${name}/members/${target}`);

  // The core's task start, wired as the deployed root wires it (core-engine-root.ts): live membership from the sign-in table, the broker's project grant from State.
  const membershipOf = membershipWithRoleFromDynamo(db, "SignIn");
  const projectGrantRole = liveCompanyGrantRole(membershipOf, projectGrantRoleFromDynamo(db, "State"));
  const projectGrant = async (personId: string, name: string) => mayUseProject(await projectGrantRole(personId, name));
  const principal = (companyId: string, personId: string): Principal => ({ companyId, personId, displayName: "p", roles: [], provider: "cloud" });
  const start = (companyId: string, personId: string, name: string) =>
    hostedTaskAccess({ companyId: companyId as never, membershipOf, projectGrant }).checkStart(principal(companyId, personId), name, undefined as never, undefined as never);
  const setupStanding = setupRunStandingFrom({ membershipOf, projectGrantRole });
  const wikiRole = wikiProjectRoleFrom({ membershipOf, projectGrantRole });

  // The Slack channel -> project resolution (an @mention in a bound channel, and /rovara), on the company's own records.
  const never = async () => { throw new Error("no Slack call in these tests"); };
  const slack: SlackChannelContext = { documentClient: db, tableName: "State", signInTableName: "SignIn", now: () => NOW, wiring: { slack: { channel: never, join: never } as never, log: () => undefined } };
  const channelProject = (companyId: string, teamId: string, channelId: string) => linkedProjectOf(slack, companyId, teamId, channelId);
  // The @mention path (slack-ingress.ts getBinding + companyRoute), as the install team's legacy view is wired with Slack company mode on: the team's company from its
  // operator binding (SLACK_TEAM#<team> / BINDING), the binding from that company's own partition, then the binding-in-company check the router makes.
  const installTeamCompany = async (teamId: string) => parseBinding(db.get(teamKey(teamId).pk, teamKey(teamId).sk)).companyId;
  const mentionProject = async (teamId: string, channelId: string) => {
    const view = { slackInstallTeamOnly: teamId, installTeamCompany };
    const company = await slackBindingCompany(view, teamId);
    if (company === undefined) return undefined;
    const binding = await namedCompanySlackBinding(db, "State", company, teamId, channelId);
    return binding !== undefined && await slackBindingInCompany(view, teamId, binding) ? binding.projectName : undefined;
  };

  return { db, access, read, setupStatus, members, addMember, removeMember, start, setupStanding, wikiRole, channelProject, mentionProject };
}

type World = ReturnType<typeof world>;
const names = (body: Record<string, unknown>) => (body.projects as Array<{ name: string }>).map((entry) => entry.name);
/** Every row, in either layout, that grants `person` a project or lists them as a project's member. */
const grantRowsOf = (w: World, person: string) => w.db.find((item) => {
  const pk = String(item.pk), sk = String(item.sk);
  return pk === `MEMBER#${person}` || pk.endsWith(`#MEMBER#${person}`) || ((pk.startsWith("PROJECT_MEMBERS#") || pk.includes("#PROJECT_MEMBERS#")) && sk === `DEVELOPER#${person}`);
});
/** No row in either layout is legacy-keyed for staging's company (the shape stays staging's while the journey runs). */
const legacyRowsForDemo = (w: World) => w.db.find((item) => {
  const pk = String(item.pk);
  return (pk.startsWith("PROJECT#demo-") || pk.startsWith("PROJECT_MEMBERS#demo-") || pk.startsWith(`SLACK_BINDING#${TEAM}`)
    || [OWNER, ADMIN, MEMBER].some((id) => pk === `MEMBER#${id}`));
});

describe("R2-F1 e2e: the staging shape, company sign-in on, the whole journey", () => {
  it("the owner: 15 projects in the access list, the project read, the setup status, a task start, the Slack channel", async () => {
    const w = world();
    expect(legacyRowsForDemo(w)).toEqual([]);
    // The Slack @mention in the bound channel resolves the project (the binding lives only in the company's layout).
    expect(await w.mentionProject(TEAM, CHANNEL)).toBe("demo-tasklog");
    expect(await w.channelProject(DEMO, TEAM, CHANNEL)).toBe("demo-tasklog");
    // Another channel of the same team is not bound.
    expect(await w.mentionProject(TEAM, "C0NOTBOUND1")).toBeUndefined();
    const answer = await w.access(OWNER);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ developerId: OWNER, companyId: DEMO, companyRole: "owner", companyName: "Rovara Demo" });
    expect(answer.body.projects).toHaveLength(15);
    expect(names(answer.body)).toEqual([...DEMO_PROJECTS].sort());
    expect((answer.body.projects as Array<{ access: string }>).every((entry) => entry.access === "granted")).toBe(true);

    // The project read: the latest revision (4 of 4, the catalog's pointer), its repository.
    const project = await w.read(OWNER, "demo-tasklog");
    expect(project.status).toBe(200);
    expect(project.body).toEqual({ name: "demo-tasklog", latestRevision: 4, access: "granted", repositories: [
      { name: "rovara-demo-tasklog", url: "https://github.com/acme/rovara-demo-tasklog.git", defaultBranch: "branch-r4", fullName: "acme/rovara-demo-tasklog" },
    ] });

    // The setup status of every one of the 15.
    for (const name of DEMO_PROJECTS) {
      const status = await w.setupStatus(OWNER, name);
      expect(status.status, name).toBe(200);
      ProjectSetupChecklistSchema.parse(status.body);
    }

    // A core task start passes the grant check, on staging's company's runtime.
    expect(await w.start(DEMO, OWNER, "demo-tasklog")).toEqual({ allowed: true });

    expect(legacyRowsForDemo(w)).toEqual([]);
  });

  it("a member with 0 grants sees nothing: no project listed, no read, no task start (the setup status is any company member's, as its route says)", async () => {
    const w = world();
    const answer = await w.access(MEMBER);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ companyId: DEMO, companyRole: "member" });
    expect(answer.body.projects).toEqual([]);
    for (const name of DEMO_PROJECTS) {
      expect((await w.read(MEMBER, name)).status, name).toBe(404);
      expect(await w.start(DEMO, MEMBER, name)).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
    }
    // Not a project admin, not a company admin: the member list is refused.
    expect((await w.members(MEMBER, "demo-tasklog")).status).toBe(403);
    expect(await w.wikiRole(MEMBER, DEMO as never, "demo-tasklog")).toBeUndefined();
    expect((await w.setupStanding(MEMBER, DEMO as never, "demo-tasklog")).access).toBe("none");
  });

  it("the admin with 0 grants reaches every project of the company where the route already gives a company admin that (DEC 254n(3)), and nothing more", async () => {
    const w = world();
    const answer = await w.access(ADMIN);
    expect(answer.body).toMatchObject({ companyId: DEMO, companyRole: "admin" });
    for (const name of DEMO_PROJECTS) {
      // The setup status, the member list, the setup run (manage) and the wiki (maintainer): company-wide for a live owner or admin.
      const status = await w.setupStatus(ADMIN, name);
      expect(status.status, name).toBe(200);
      ProjectSetupChecklistSchema.parse(status.body);
      expect((await w.members(ADMIN, name)).status, name).toBe(200);
      expect(await w.setupStanding(ADMIN, DEMO as never, name)).toEqual({ access: "manage", basis: "company-admin" });
      expect(await w.wikiRole(ADMIN, DEMO as never, name)).toBe("maintainer");
    }
    // Not widened: the access list and the core's task start still follow the project grant (the routes never gave an admin more).
    expect(answer.body.projects).toEqual([]);
    expect((await w.start(DEMO, ADMIN, "demo-tasklog")).allowed).toBe(false);
    // The owner, likewise, manages every project.
    expect((await w.members(OWNER, "demo-shop")).status).toBe(200);
    expect(await w.setupStanding(OWNER, DEMO as never, "demo-shop")).toEqual({ access: "manage", basis: "company-owner" });
  });

  it("grant then revoke through Code's own route: access is given, then removed, with nothing left in either layout", async () => {
    const w = world();
    expect(grantRowsOf(w, MEMBER)).toEqual([]);
    const granted = await w.addMember(OWNER, "demo-tasklog", MEMBER);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ project: "demo-tasklog", developerId: MEMBER, outcome: "granted" });
    // The grant is written in the company's layout only.
    expect(w.db.get(grantKeyFor(DEMO, MEMBER, "demo-tasklog").pk, grantKeyFor(DEMO, MEMBER, "demo-tasklog").sk)).toBeDefined();
    expect(w.db.get(`MEMBER#${MEMBER}`, "PROJECT#demo-tasklog")).toBeUndefined();
    expect(w.db.get(`PROJECT_MEMBERS#demo-tasklog`, `DEVELOPER#${MEMBER}`)).toBeUndefined();
    expect(legacyRowsForDemo(w)).toEqual([]);

    expect((await w.access(MEMBER)).body.projects).toEqual([{ name: "demo-tasklog", access: "granted" }]);
    expect((await w.read(MEMBER, "demo-tasklog")).status).toBe(200);
    expect(await w.start(DEMO, MEMBER, "demo-tasklog")).toEqual({ allowed: true });
    expect(((await w.members(OWNER, "demo-tasklog")).body.members as Array<{ developerId: string }>).map((m) => m.developerId)).toContain(MEMBER);
    // The grant is one project's, not the others'.
    expect((await w.read(MEMBER, "demo-shop")).status).toBe(404);

    const revoked = await w.removeMember(OWNER, "demo-tasklog", MEMBER);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ project: "demo-tasklog", developerId: MEMBER, outcome: "revoked" });
    expect((await w.access(MEMBER)).body.projects).toEqual([]);
    expect((await w.read(MEMBER, "demo-tasklog")).status).toBe(404);
    expect(await w.start(DEMO, MEMBER, "demo-tasklog")).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
    expect(((await w.members(OWNER, "demo-tasklog")).body.members as Array<{ developerId: string }>).map((m) => m.developerId)).not.toContain(MEMBER);
    expect(grantRowsOf(w, MEMBER)).toEqual([]);
    // Revoking again answers "not a member" and changes nothing; the owner's 15 grants are untouched.
    expect((await w.removeMember(OWNER, "demo-tasklog", MEMBER)).body).toMatchObject({ outcome: "not_member" });
    expect((await w.access(OWNER)).body.projects).toHaveLength(15);
  });

  it("revoking the owner's own grant removes it from both layouts, and their list drops to 14", async () => {
    const w = world();
    expect((await w.removeMember(OWNER, "demo-shop", OWNER)).body).toMatchObject({ outcome: "revoked" });
    expect(names((await w.access(OWNER)).body)).not.toContain("demo-shop");
    expect((await w.access(OWNER)).body.projects).toHaveLength(14);
    expect(w.db.get(`ORG#${DEMO}#MEMBER#${OWNER}`, "PROJECT#demo-shop")).toBeUndefined();
    expect(w.db.get(`MEMBER#${OWNER}`, "PROJECT#demo-shop")).toBeUndefined();
    expect(w.db.get(projectMemberRowKeyFor(DEMO, "demo-shop", OWNER).pk, projectMemberRowKeyFor(DEMO, "demo-shop", OWNER).sk)).toBeUndefined();
    expect((await w.read(OWNER, "demo-shop")).status).toBe(404);
    expect(await w.start(DEMO, OWNER, "demo-shop")).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
  });

  it("the other company never leaks: a same-named project, its own grant, its own revision; never staging's company's", async () => {
    const w = world();
    const bob = await w.access(BOB);
    expect(bob.body).toMatchObject({ companyId: BETA });
    expect(bob.body.projects).toEqual([{ name: "demo-tasklog", access: "granted" }]);
    expect(JSON.stringify(bob.body)).not.toMatch(/Rovara Demo|org_jckf|demo-shop/);
    // Bob reads BETA's demo-tasklog (revision 1, the canary's repository), never DEMO's revision 4.
    const read = await w.read(BOB, "demo-tasklog");
    expect(read.body).toMatchObject({ latestRevision: 1, repositories: [expect.objectContaining({ fullName: `${BETA_CANARY}/rovara-demo-tasklog`, defaultBranch: "branch-r1" })] });
    // And DEMO's people never read BETA's: the owner's read is DEMO's revision 4, and no answer names the canary.
    const owner = await w.read(OWNER, "demo-tasklog");
    expect(owner.body).toMatchObject({ latestRevision: 4 });
    for (const answer of [owner, await w.access(OWNER), await w.setupStatus(OWNER, "demo-tasklog"), await w.members(OWNER, "demo-tasklog")]) {
      expect(JSON.stringify(answer.body)).not.toContain(BETA_CANARY);
    }
    // Bob reaches none of DEMO's other projects, by any route.
    for (const name of DEMO_PROJECTS.filter((n) => n !== "demo-tasklog")) {
      expect((await w.read(BOB, name)).status, name).toBe(404);
      expect((await w.setupStatus(BOB, name)).status, name).toBe(404);
    }
    expect((await w.members(BOB, "demo-tasklog")).status).toBe(403);
    // The core's start: DEMO's runtime refuses Bob outright, whatever he claims; BETA's runtime allows his own grant.
    expect(await w.start(DEMO, BOB, "demo-tasklog")).toEqual({ allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE });
    expect(await w.start(BETA, BOB, "demo-tasklog")).toEqual({ allowed: true });
    // DEMO's owner, at BETA's runtime: not a member there.
    expect((await w.start(BETA, OWNER, "demo-tasklog")).allowed).toBe(false);
    // A grant row for Bob planted under DEMO's partition is never his (his live membership is BETA's).
    w.db.set({ pk: `ORG#${DEMO}#MEMBER#${BOB}`, sk: "PROJECT#demo-shop", entityType: "MEMBERSHIP", ownerKey: BOB, projectName: "demo-shop", role: "developer", grantedAt: TIME });
    expect(names((await w.access(BOB)).body)).toEqual(["demo-tasklog"]);
    expect((await w.read(BOB, "demo-shop")).status).toBe(404);
    // Slack: DEMO's channel is never BETA's project, and BETA has no channel there.
    expect(await w.channelProject(BETA, TEAM, CHANNEL)).toBeUndefined();
    // A binding row for DEMO's team planted under BETA's partition is never read for the @mention: the team's company is DEMO's, from its operator binding.
    w.db.set({ pk: `ORG#${BETA}#SLACK_BINDING#${TEAM}`, sk: "CHANNEL#C0BETAPLANT", teamId: TEAM, channelId: "C0BETAPLANT", projectName: "demo-tasklog", updatedAt: TIME, updatedBy: BOB });
    expect(await w.mentionProject(TEAM, "C0BETAPLANT")).toBeUndefined();
  });

  it("drift in the company's own partition is dropped: rows naming the other company", async () => {
    const w = world();
    // A revision row under DEMO's partition that names BETA: never DEMO's revision (the catalog points at it).
    w.db.set({ pk: `ORG#${DEMO}#PROJECT#demo-shop`, sk: rev(2), entityType: "PROJECT", companyId: BETA, definition: definition("demo-shop", 2, BETA_CANARY) });
    w.db.set({ pk: `ORG#${DEMO}#PROJECT_CATALOG`, sk: "PROJECT#demo-shop", entityType: "PROJECT_CATALOG", latestRevision: 2 });
    const read = await w.read(OWNER, "demo-shop");
    expect(JSON.stringify(read.body)).not.toContain(BETA_CANARY);
  });

  it("the built-in (implicit) company is unchanged: legacy keys only, read and written byte for byte", async () => {
    const w = world();
    // The helpers pick the legacy keys for the built-in company.
    expect(revisionPkFor(IMPLICIT_COMPANY_ID, "old-app")).toBe("PROJECT#old-app");
    expect(revisionKeyFor(IMPLICIT_COMPANY_ID, "old-app", 1)).toEqual({ pk: "PROJECT#old-app", sk: rev(1) });
    expect(grantKeyFor(IMPLICIT_COMPANY_ID, LEGACY, "old-app")).toEqual({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#old-app" });
    expect(projectMemberRowKeyFor(IMPLICIT_COMPANY_ID, "old-app", LEGACY)).toEqual({ pk: "PROJECT_MEMBERS#old-app", sk: `DEVELOPER#${LEGACY}` });

    const answer = await w.access(LEGACY);
    expect(answer.status).toBe(200);
    expect(answer.body.projects).toEqual([{ name: "old-app", access: "granted" }]);
    expect((await w.read(LEGACY, "old-app")).body).toEqual({ name: "old-app", latestRevision: 1, access: "granted", repositories: [
      { name: "rovara-old-app", url: "https://github.com/acme/rovara-old-app.git", defaultBranch: "branch-r1", fullName: "acme/rovara-old-app" },
    ] });
    expect((await w.setupStatus(LEGACY, "old-app")).status).toBe(200);
    expect(await w.start(IMPLICIT_COMPANY_ID, LEGACY, "old-app")).toEqual({ allowed: true });
    expect(await w.channelProject(IMPLICIT_COMPANY_ID, LEGACY_TEAM, LEGACY_CHANNEL)).toBe("old-app");
    // The built-in company never reaches the named companies' layouts, and they never reach its legacy project.
    for (const name of ["demo-tasklog", "demo-shop"]) expect((await w.read(LEGACY, name)).status).toBe(404);
    expect((await w.read(OWNER, "old-app")).status).toBe(404);
    expect((await w.read(BOB, "old-app")).status).toBe(404);
    expect(await w.start(DEMO, OWNER, "old-app")).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
    expect(await w.channelProject(DEMO, LEGACY_TEAM, LEGACY_CHANNEL)).toBeUndefined();
    // Nothing the journey did wrote a company-layout row for the built-in company.
    expect(w.db.find((item) => String(item.pk).startsWith(`ORG#${IMPLICIT_COMPANY_ID}#`))).toEqual([]);
  });
});
