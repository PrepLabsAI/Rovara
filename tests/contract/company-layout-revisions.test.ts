// R2-F1 lane 1 (owner DEC 254zzz80, 2026-11-18): for a NAMED company, every reader of a project's revisions reads the company's own partition
// (`ORG#<company>#PROJECT#<name>` / `REV#…`, catalog pointer, META status), never the legacy `PROJECT#<name>` rows; the built-in company and no company keep the
// legacy rows exactly. The company is the caller's LIVE membership. These tests seed the staging shape (company-layout revisions, catalog rows and META, no
// legacy project rows) through the deployed developer API.
//
// Grants are lane 2's (`grantKeyFor`). On this branch the grant readers still read `MEMBER#<person>`, so `grant()` writes the grant at BOTH the key lane 2
// reads (`grantKeyFor(company, person, project)`) and the key read today; once lane 2 lands, the legacy copy is ignored and the same assertions hold.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID, WORKSPACE_PROJECT_INDEX, orgProjectCatalogKey, orgProjectNameClaimKey, projectMetaKey, workspaceProjectIndexValue } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { boundedCompanyReads, companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { grantKeyFor, revisionKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { checkProjectAccess, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { projectsByRepository } from "../../packages/broker/src/aws/client-project-create.js";
import { projectsUsingInstallation } from "../../packages/broker/src/aws/github-lifecycle.js";
import { companyProjectIdByName, PROJECT_NAME_CLAIM } from "../../packages/broker/src/aws/company-project-names.js";
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
/** A stored project definition as staging holds demo-tasklog's. */
const definition = (name: string, revision: number, owner = "acme") => {
  const command = (args: string[], timeoutSeconds: number) => [{ executable: "npm", args, cwd: `repo/rovara-${name}`, timeoutSeconds }];
  return {
    name, revision, orchestratorInstructions: "Delegate.", setup: command(["ci"], 900), readiness: command(["test"], 1800),
    repositories: [{ name: `rovara-${name}`, url: `https://github.com/${owner}/rovara-${name}.git`, defaultBranch: `branch-r${revision}`, credentialRef: "github-agentx-sdlc", installationId: 173228775, githubRepositoryId: 1434821527, path: `repo/rovara-${name}` }],
  };
};

function world() {
  const db = new FakeDynamoDb({ seed: 7 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: OWNER, sid: sid(OWNER), amr: "oidc" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, fullAccess: true, webApp: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name] of PEOPLE) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", displayName: name, email: `${name.toLowerCase()}@example.test`, revoked: false });
  // Staging's owner: an OIDC session through the install's own sign-in (the shared method), naming the company of their live membership.
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
    db.set({ pk: `SESSION#${sid(id)}`, sk: "META", sessionId: sid(id), developerId: id, amr: "oidc", clientId: "web-app", companyId, ...(companyId === IMPLICIT_COMPANY_ID ? {} : { installMethod: true }), startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  };
  db.set({ ...companyKey(A), entityType: "COMPANY", companyId: A, name: "Rovara Demo", status: "active", createdAt: TIME, createdBy: "operator" });
  db.set({ ...companyKey(B), entityType: "COMPANY", companyId: B, name: "Beta Labs", status: "active", createdAt: TIME, createdBy: "operator" });
  join(OWNER, A, "owner"); join(MEMBER, A, "member"); join(BOB, B, "member"); join(LEGACY, IMPLICIT_COMPANY_ID, "member");
  /** A project in the company layout, exactly as staging holds demo-tasklog: META, catalog row, revisions (no companyId field: the partition names the company). */
  const project = (companyId: string, name: string, revisions: number, owner = "acme") => {
    db.set({ ...projectMetaKey(companyId, name), entityType: "PROJECT_META", name, status: "active", createdAt: TIME, createdBy: OWNER, description: "demo" });
    db.set({ ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: revisions });
    for (let revision = 1; revision <= revisions; revision += 1) db.set({ ...revisionKeyFor(companyId, name, revision), entityType: "PROJECT", registeredAt: TIME, registeredBy: OWNER, definition: definition(name, revision, owner) });
  };
  /** A grant: at lane 2's key (staging's `ORG#<company>#MEMBER#<person>` rows) and at the key this branch's grant readers read (see the file comment). */
  const grant = (companyId: string, id: string, name: string, role = "developer") => {
    const row = { entityType: "MEMBERSHIP", ownerKey: id, projectName: name, role, projectRole: "maintainer", grantId: `g-${name}`, grantedAt: TIME, grantedBy: { developerId: OWNER } };
    db.set({ ...grantKeyFor(companyId, id, name), ...row });
    db.set({ pk: `MEMBER#${id}`, sk: `PROJECT#${name}`, ...row });
  };
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", clientRoutes: true,
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      projectArchiveTakesEffect: () => true,
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
  return {
    db, deps, project, grant, join, call,
    access: (id: string) => call(id, "POST", "/v1/dev/access", {}),
    read: (id: string, name: string) => call(id, "GET", `/v1/dev/client/projects/${name}`),
    projects: (id: string) => call(id, "GET", "/v1/dev/projects"),
  };
}

const names = (body: Record<string, unknown>) => (body.projects as Array<{ name: string }>).map((entry) => entry.name);
const latest = (body: Record<string, unknown>) => ({ latestRevision: body.latestRevision, branch: (body.repositories as Array<{ defaultBranch: string }>)[0]?.defaultBranch });

describe("R2-F1 lane 1: a named company's revisions come from its own partition", () => {
  it("the staging shape: the owner's access check lists the company's projects and the project read answers the latest revision (4 of 4)", async () => {
    const w = world();
    for (const name of ["demo-tasklog", "demo-shop", "demo-inventory"]) { w.project(A, name, name === "demo-tasklog" ? 4 : 1); w.grant(A, OWNER, name); }
    const answer = await w.access(OWNER);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ developerId: OWNER, companyId: A, companyRole: "owner", companyName: "Rovara Demo" });
    expect(answer.body.projects).toEqual([{ name: "demo-inventory", access: "granted" }, { name: "demo-shop", access: "granted" }, { name: "demo-tasklog", access: "granted" }]);
    const read = await w.read(OWNER, "demo-tasklog");
    expect(read).toEqual({ status: 200, body: { name: "demo-tasklog", latestRevision: 4, access: "granted", repositories: [
      { name: "rovara-demo-tasklog", url: "https://github.com/acme/rovara-demo-tasklog.git", defaultBranch: "branch-r4", fullName: "acme/rovara-demo-tasklog" },
    ] } });
    expect(names((await w.projects(OWNER)).body)).toEqual(["demo-inventory", "demo-shop", "demo-tasklog"]);
    // No legacy project row was needed: nothing under `PROJECT#<name>` exists.
    expect(w.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("PROJECT#"))).toEqual([]);
  });

  it("an administrator grant answers `administrator`; a member with no grant sees nothing, and with one sees only that project", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 1); w.project(A, "demo-shop", 1);
    w.grant(A, OWNER, "demo-tasklog", "administrator");
    expect((await w.access(OWNER)).body.projects).toEqual([{ name: "demo-tasklog", access: "administrator" }]);
    expect((await w.read(OWNER, "demo-tasklog")).body.access).toBe("administrator");
    expect((await w.access(MEMBER)).body.projects).toEqual([]);
    expect((await w.read(MEMBER, "demo-shop")).status).toBe(404);
    w.grant(A, MEMBER, "demo-shop");
    expect((await w.access(MEMBER)).body.projects).toEqual([{ name: "demo-shop", access: "granted" }]);
    expect((await w.read(MEMBER, "demo-tasklog")).status).toBe(404);
  });

  it("two companies, one project name: each reads its own revision, a legacy row of that name is never theirs, and a row naming the other company is dropped", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 2); w.grant(A, OWNER, "demo-tasklog");
    w.project(B, "demo-tasklog", 1); w.grant(B, BOB, "demo-tasklog");
    // A legacy row of the same name, stamped for company A (the earlier dual-write layout): never read for a named company.
    w.db.set({ pk: "PROJECT#demo-tasklog", sk: rev(9), entityType: "PROJECT", companyId: A, definition: definition("demo-tasklog", 9) });
    expect(latest((await w.read(OWNER, "demo-tasklog")).body)).toEqual({ latestRevision: 2, branch: "branch-r2" });
    expect(latest((await w.read(BOB, "demo-tasklog")).body)).toEqual({ latestRevision: 1, branch: "branch-r1" });
    expect(JSON.stringify((await w.access(BOB)).body)).not.toMatch(/Rovara Demo|branch-r2/);
    // A project only company A has: Bob never reads it, even holding a stray grant for it in his own company.
    w.project(A, "demo-shop", 1); w.grant(B, BOB, "demo-shop");
    expect((await w.read(BOB, "demo-shop")).status).toBe(404);
    expect(names((await w.access(BOB)).body)).toEqual(["demo-tasklog"]);
    // Drift: B's partition holding a revision row that names company A is not B's revision.
    w.db.set({ ...revisionKeyFor(B, "demo-tasklog", 1), entityType: "PROJECT", companyId: A, definition: definition("demo-tasklog", 1) });
    expect((await w.read(BOB, "demo-tasklog")).status).toBe(404);
    expect((await w.access(BOB)).body.projects).toEqual([]);
    // Live membership decides: Bob moved to company A reads A's revision at once.
    w.join(BOB, A, "member"); w.grant(A, BOB, "demo-tasklog");
    expect(latest((await w.read(BOB, "demo-tasklog")).body)).toEqual({ latestRevision: 2, branch: "branch-r2" });
  });

  it("the built-in company (golden): legacy rows answer exactly as before, and the company layout of a named company is never read for it", async () => {
    const w = world();
    w.db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#old-app", projectName: "old-app", role: "developer" });
    w.db.set({ pk: "PROJECT#old-app", sk: "REV#0001", definition: { name: "old-app", revision: 3, repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main" }] } });
    w.project(A, "old-app", 5);
    expect((await w.access(LEGACY)).body.projects).toEqual([{ name: "old-app", access: "granted" }]);
    expect((await w.read(LEGACY, "old-app")).body).toEqual({ name: "old-app", latestRevision: 3, access: "granted", repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", fullName: "acme/r" }] });
    // A legacy row stamped for another company stays out of the built-in company's answer, as before.
    w.db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#b-old", projectName: "b-old", role: "developer" });
    w.db.set({ pk: "PROJECT#b-old", sk: "REV#0001", companyId: B, definition: { name: "b-old", revision: 1, repositories: [] } });
    expect((await w.access(LEGACY)).body.projects).toEqual([{ name: "old-app", access: "granted" }]);
  });

  it("the latest revision in the core's order: the catalog pointer (an approved candidate too), else the newest non-candidate; an unparsable newest is no revision", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 2); w.grant(A, OWNER, "demo-tasklog");
    // A setup waiting for approval: a candidate revision 3, the catalog still on 2.
    w.db.set({ ...revisionKeyFor(A, "demo-tasklog", 3), entityType: "PROJECT", candidate: true, definition: definition("demo-tasklog", 3) });
    expect(latest((await w.read(OWNER, "demo-tasklog")).body)).toEqual({ latestRevision: 2, branch: "branch-r2" });
    // Approved: the catalog moves onto 3, which keeps its candidate flag (core/setup-agent/apply.ts).
    w.db.set({ ...orgProjectCatalogKey(A, "demo-tasklog"), entityType: "PROJECT_CATALOG", latestRevision: 3 });
    expect(latest((await w.read(OWNER, "demo-tasklog")).body)).toEqual({ latestRevision: 3, branch: "branch-r3" });
    // No catalog row: the newest that is not a candidate.
    w.db.delete(orgProjectCatalogKey(A, "demo-tasklog").pk, orgProjectCatalogKey(A, "demo-tasklog").sk);
    expect(latest((await w.read(OWNER, "demo-tasklog")).body)).toEqual({ latestRevision: 2, branch: "branch-r2" });
    w.db.set({ ...revisionKeyFor(A, "demo-tasklog", 4), entityType: "PROJECT", definition: { name: "demo-tasklog", revision: 4 } });
    expect((await w.read(OWNER, "demo-tasklog")).status).toBe(404);
    expect((await w.access(OWNER)).body.projects).toEqual([]);
  });

  it("archived (the project's META row, as the core reads it): still listed and readable, but its tasks are off, so no new task starts", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 1); w.grant(A, OWNER, "demo-tasklog");
    const before = (await w.projects(OWNER)).body.projects as Array<{ name: string; tasks: { enabled: boolean } }>;
    expect(before.map((p) => [p.name, p.tasks.enabled])).toEqual([["demo-tasklog", true]]);
    await expect(checkProjectAccess(w.deps, { developerId: OWNER }, "demo-tasklog")).resolves.toMatchObject({ revision: 1, access: "granted" });
    w.db.set({ ...projectMetaKey(A, "demo-tasklog"), entityType: "PROJECT_META", name: "demo-tasklog", status: "archived" });
    const after = (await w.projects(OWNER)).body.projects as Array<{ name: string; tasks: { enabled: boolean } }>;
    expect(after.map((p) => [p.name, p.tasks.enabled])).toEqual([["demo-tasklog", false]]);
    expect((await w.read(OWNER, "demo-tasklog")).status).toBe(200);
    await expect(checkProjectAccess(w.deps, { developerId: OWNER }, "demo-tasklog")).rejects.toMatchObject({ code: "PROJECT_TASKS_DISABLED" });
    // A META row naming another company is drift: read as archived (fail closed).
    w.db.set({ ...projectMetaKey(A, "demo-tasklog"), entityType: "PROJECT_META", name: "demo-tasklog", status: "active", companyId: B });
    await expect(checkProjectAccess(w.deps, { developerId: OWNER }, "demo-tasklog")).rejects.toMatchObject({ code: "PROJECT_TASKS_DISABLED" });
    // Restored: tasks on again.
    w.db.set({ ...projectMetaKey(A, "demo-tasklog"), entityType: "PROJECT_META", name: "demo-tasklog", status: "active" });
    await expect(checkProjectAccess(w.deps, { developerId: OWNER }, "demo-tasklog")).resolves.toMatchObject({ revision: 1 });
  });

  it("task start's project check (checkProjectAccess): another company's project of the same name is not found for a named company", async () => {
    const w = world();
    w.project(B, "beta-app", 1); w.grant(A, OWNER, "beta-app");
    await expect(checkProjectAccess(w.deps, { developerId: OWNER }, "beta-app")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    w.project(A, "beta-app", 1);
    await expect(checkProjectAccess(w.deps, { developerId: OWNER }, "beta-app")).resolves.toMatchObject({ revision: 1 });
  });

  it("code settings (GET): found through the company's own revisions, never another company's", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 1); w.grant(A, OWNER, "demo-tasklog");
    expect((await w.call(OWNER, "GET", "/v1/dev/client/projects/demo-tasklog/code-settings")).status).toBe(200);
    w.project(B, "beta-app", 1); w.grant(A, OWNER, "beta-app");
    expect((await w.call(OWNER, "GET", "/v1/dev/client/projects/beta-app/code-settings")).status).toBe(404);
  });

  it("setup status: a named company's project is found in its own partition; another company's same-named project or a legacy row is not", async () => {
    const w = world();
    // Only a legacy row (stamped for A, the earlier layout) and another company's project: not A's.
    w.db.set({ pk: "PROJECT#demo-tasklog", sk: rev(1), entityType: "PROJECT", companyId: A, definition: definition("demo-tasklog", 1) });
    w.project(B, "demo-tasklog", 1);
    const path = "/v1/dev/client/projects/demo-tasklog/setup-status";
    expect((await w.call(OWNER, "GET", path)).status).toBe(404);
    w.project(A, "demo-tasklog", 2);
    const answer = await w.call(OWNER, "GET", path);
    expect(answer.status).not.toBe(404);
  });

  it("the members route: a company owner with no grant manages the company's own-partition project; another company's owner does not, and a missing project is not registered", async () => {
    const w = world();
    w.join(BOB, B, "owner");
    w.project(A, "demo-tasklog", 1); w.grant(A, MEMBER, "demo-tasklog");
    const members = (id: string, name = "demo-tasklog") => w.call(id, "GET", `/v1/dev/client/projects/${name}/members`);
    expect((await members(OWNER)).status).toBe(200);
    // Bob owns company B, which has no such project: not his to manage.
    expect((await members(BOB)).status).toBe(403);
    w.project(B, "demo-tasklog", 1);
    expect((await members(BOB)).status).toBe(200);
    // A project only a legacy row names is not company A's.
    w.db.set({ pk: "PROJECT#legacy-only", sk: rev(1), entityType: "PROJECT", companyId: A, definition: definition("legacy-only", 1) });
    w.grant(A, OWNER, "legacy-only", "administrator");
    expect((await members(OWNER, "legacy-only")).status).toBe(404);
  });

  it("H1 probe: A's owner adds a member to A's project; B's owner (no such project in B: the name is A's install-wide) never lists them, and a member moved to B sees nothing", async () => {
    const w = world();
    w.join(BOB, B, "owner");
    w.project(A, "demo-tasklog", 1);
    w.db.set({ pk: "PROJECT_NAME_RESERVATION#demo-tasklog", sk: "RESERVATION", entityType: "PROJECT_NAME_RESERVATION", companyId: A, name: "demo-tasklog" });
    expect((await w.call(OWNER, "PUT", `/v1/dev/client/projects/demo-tasklog/members/${MEMBER}`)).status).toBe(200);
    const listed = await w.call(OWNER, "GET", "/v1/dev/client/projects/demo-tasklog/members");
    expect(listed.status).toBe(200);
    const bob = await w.call(BOB, "GET", "/v1/dev/client/projects/demo-tasklog/members");
    expect(bob.status).not.toBe(200);
    expect(JSON.stringify(bob.body)).not.toContain(MEMBER);
    // The member, granted on A's project, moves to company B: B has no demo-tasklog, so nothing is listed or readable for them.
    expect(names((await w.projects(MEMBER)).body)).toEqual(["demo-tasklog"]);
    w.join(MEMBER, B, "member");
    expect((await w.projects(MEMBER)).body.projects).toEqual([]);
    expect((await w.access(MEMBER)).body.projects).toEqual([]);
    expect((await w.read(MEMBER, "demo-tasklog")).status).toBe(404);
  });

  it("L2: a catalog pointer that names an unusable row is not a project a change can be fenced on: not found, never stale forever", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 2);
    expect((await w.call(OWNER, "GET", "/v1/dev/client/projects/demo-tasklog/archive-preview")).status).toBe(200);
    // The catalog names revision 5, which has no usable row: the read falls back to revision 2, which the catalog does not name.
    w.db.set({ ...orgProjectCatalogKey(A, "demo-tasklog"), entityType: "PROJECT_CATALOG", latestRevision: 5 });
    expect((await w.call(OWNER, "GET", "/v1/dev/client/projects/demo-tasklog/archive-preview")).status).toBe(404);
  });

  it("archive and restore: a named company's own-partition project; a waiting candidate does not block the archive, a moved catalog makes it stale", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 2);
    const preview = await w.call(OWNER, "GET", "/v1/dev/client/projects/demo-tasklog/archive-preview");
    expect(preview).toMatchObject({ status: 200, body: { orgId: A, project: "demo-tasklog", status: "active", expectedProjectRevision: 2, access: { actions: ["archive"] } } });
    // Another company's owner: the project looks missing.
    w.join(BOB, B, "owner");
    expect((await w.call(BOB, "GET", "/v1/dev/client/projects/demo-tasklog/archive-preview")).status).toBe(404);
    // A setup waiting for approval (candidate 3) does not make the preview stale.
    w.db.set({ ...revisionKeyFor(A, "demo-tasklog", 3), entityType: "PROJECT", candidate: true, definition: definition("demo-tasklog", 3) });
    const archived = await w.call(OWNER, "POST", "/v1/dev/client/projects/demo-tasklog/archive", { requestId: "0b9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8e", expectedRevision: 0, expectedProjectRevision: 2, acknowledgeNewWorkStops: true });
    expect(archived).toMatchObject({ status: 200, body: { receipt: { status: "archived", projectRevision: 2 } } });
    expect(w.db.get(projectMetaKey(A, "demo-tasklog").pk, "META")).toMatchObject({ status: "archived", lifecycleRevision: 1 });
    // The candidate is approved (the catalog moves to 3): a restore named at revision 2 is stale.
    w.db.set({ ...orgProjectCatalogKey(A, "demo-tasklog"), entityType: "PROJECT_CATALOG", latestRevision: 3 });
    const stale = await w.call(OWNER, "POST", "/v1/dev/client/projects/demo-tasklog/restore", { requestId: "1c9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8f", expectedRevision: 1, expectedProjectRevision: 2, acknowledgeNewWorkAllowed: true });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE" } } });
    const restored = await w.call(OWNER, "POST", "/v1/dev/client/projects/demo-tasklog/restore", { requestId: "1c9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8f", expectedRevision: 1, expectedProjectRevision: 3, acknowledgeNewWorkAllowed: true });
    expect(restored).toMatchObject({ status: 200, body: { receipt: { status: "active", projectRevision: 3 } } });
  });

  it("archive: a newer non-candidate revision written after the preview makes the change stale (the fence also holds with no catalog row)", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 1);
    w.db.delete(orgProjectCatalogKey(A, "demo-tasklog").pk, orgProjectCatalogKey(A, "demo-tasklog").sk);
    w.db.set({ ...revisionKeyFor(A, "demo-tasklog", 2), entityType: "PROJECT", definition: definition("demo-tasklog", 2) });
    const stale = await w.call(OWNER, "POST", "/v1/dev/client/projects/demo-tasklog/archive", { requestId: "0b9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8e", expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE" } } });
  });

  it("GET /v1/dev/workspaces: a named company lists its workspaces from its own index partition, never the bare-name partition another company shares", async () => {
    const w = world();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    w.project(A, "demo-tasklog", 1); w.grant(A, OWNER, "demo-tasklog");
    w.project(B, "demo-tasklog", 1); w.grant(B, BOB, "demo-tasklog");
    const workspace = (id: string, partition: string, extra: Record<string, unknown> = {}) => w.db.set({
      pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE", [WORKSPACE_PROJECT_INDEX.partitionKey]: partition, [WORKSPACE_PROJECT_INDEX.sortKey]: TIME,
      id, ownerKey: "o".repeat(64), projectName: "demo-tasklog", projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY",
      activeOperationId: null, fence: 1, createdAt: TIME, updatedAt: TIME, ...extra,
    });
    const ID_A = "00000000-0000-4000-8000-00000000000a", ID_B = "00000000-0000-4000-8000-00000000000b", ID_LEGACY = "00000000-0000-4000-8000-00000000000c", ID_DRIFT = "00000000-0000-4000-8000-00000000000d";
    workspace(ID_A, workspaceProjectIndexValue(A, "demo-tasklog"), { orgId: A });
    workspace(ID_B, workspaceProjectIndexValue(B, "demo-tasklog"), { orgId: B });
    workspace(ID_LEGACY, "demo-tasklog");
    // Drift in A's index partition: an item that names company B, and one that names no company.
    workspace(ID_DRIFT, workspaceProjectIndexValue(A, "demo-tasklog"), { orgId: B });
    workspace("00000000-0000-4000-8000-00000000000f", workspaceProjectIndexValue(A, "demo-tasklog"));
    const ids = async (id: string) => ((await w.call(id, "GET", "/v1/dev/workspaces")).body.workspaces as Array<{ id: string }>).map((entry) => entry.id);
    expect(await ids(OWNER)).toEqual([ID_A]);
    expect(await ids(BOB)).toEqual([ID_B]);
  });

  it("GET /v1/dev/workspaces for the built-in company (golden): the bare-name index partition, as before", async () => {
    const w = world();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    w.db.set({ pk: `MEMBER#${LEGACY}`, sk: "PROJECT#old-app", projectName: "old-app", role: "developer" });
    w.db.set({ pk: "PROJECT#old-app", sk: "REV#0001", definition: { name: "old-app", revision: 1, repositories: [] } });
    const ID = "00000000-0000-4000-8000-00000000000e";
    w.db.set({ pk: `WORKSPACE#${ID}`, sk: "META", entityType: "WORKSPACE", [WORKSPACE_PROJECT_INDEX.partitionKey]: "old-app", [WORKSPACE_PROJECT_INDEX.sortKey]: TIME,
      id: ID, ownerKey: "o".repeat(64), projectName: "old-app", projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY", activeOperationId: null, fence: 1, createdAt: TIME, updatedAt: TIME });
    expect(((await w.call(LEGACY, "GET", "/v1/dev/workspaces")).body.workspaces as Array<{ id: string }>).map((entry) => entry.id)).toEqual([ID]);
  });
});

describe("R2-F1 lane 1: stored-data readers of a named company's revisions", () => {
  const budget = (db: FakeDynamoDb) => boundedCompanyReads(db, () => NOW);

  it("the repository picker's marks (projectsByRepository): a named company's own catalog and own revisions; the built-in company's legacy rows as before", async () => {
    const w = world();
    w.project(A, "demo-tasklog", 2, "acme");
    w.project(B, "demo-tasklog", 1, "beta");
    // A legacy row of the same name stamped for A (the earlier layout) is never read for A.
    w.db.set({ pk: "PROJECT#demo-tasklog", sk: rev(1), entityType: "PROJECT", companyId: A, definition: definition("demo-tasklog", 1, "legacy") });
    expect([...(await projectsByRepository(w.db, "State", A, budget(w.db))).entries()]).toEqual([["acme/rovara-demo-tasklog", ["demo-tasklog"]]]);
    expect([...(await projectsByRepository(w.db, "State", B, budget(w.db))).entries()]).toEqual([["beta/rovara-demo-tasklog", ["demo-tasklog"]]]);
    // Drift in A's partition (a revision naming B) marks nothing.
    w.db.set({ ...revisionKeyFor(A, "demo-tasklog", 2), entityType: "PROJECT", companyId: B, definition: definition("demo-tasklog", 2, "acme") });
    expect([...(await projectsByRepository(w.db, "State", A, budget(w.db))).entries()]).toEqual([]);
    // Golden: no company reads the install's catalog and legacy rows.
    w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#old-app", entityType: "PROJECT_CATALOG", name: "old-app", latestRevision: 1 });
    w.db.set({ pk: "PROJECT#old-app", sk: rev(1), entityType: "PROJECT", definition: definition("old-app", 1, "old") });
    expect([...(await projectsByRepository(w.db, "State", undefined, budget(w.db))).entries()]).toEqual([["old/rovara-old-app", ["old-app"]]]);
  });

  it("a GitHub disconnect's project check (projectsUsingInstallation): a named company's own catalog and revisions, never the install catalog", async () => {
    const w = world();
    const installation = { installationId: 173228775, accountLogin: "acme" };
    const deps = { documentClient: w.db, tableName: "State", now: () => NOW };
    w.project(A, "demo-tasklog", 1, "acme");
    w.project(B, "beta-app", 1, "acme");
    expect(await projectsUsingInstallation(deps, A, installation)).toEqual(["demo-tasklog"]);
    expect(await projectsUsingInstallation(deps, B, installation)).toEqual(["beta-app"]);
    // A legacy catalog entry and row stamped for A is the earlier layout: not read for A.
    w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#old-a", entityType: "PROJECT_CATALOG", name: "old-a", latestRevision: 1 });
    w.db.set({ pk: "PROJECT#old-a", sk: rev(1), entityType: "PROJECT", companyId: A, definition: definition("old-a", 1, "acme") });
    expect(await projectsUsingInstallation(deps, A, installation)).toEqual(["demo-tasklog"]);
    // Golden: the built-in company still reads the install catalog (old-a is A's there, so not the built-in company's).
    w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#old-app", entityType: "PROJECT_CATALOG", name: "old-app", latestRevision: 1 });
    w.db.set({ pk: "PROJECT#old-app", sk: rev(1), entityType: "PROJECT", definition: definition("old-app", 1, "acme") });
    expect(await projectsUsingInstallation(deps, IMPLICIT_COMPANY_ID, installation)).toEqual(["old-app"]);
  });

  it("a project id by name (companyProjectIdByName): a named company's claim holds only while the project has a revision in its own partition", async () => {
    const w = world();
    const set = (companyId: typeof A, name: string, projectId: string) => w.db.set({ ...orgProjectNameClaimKey(companyId, name), entityType: PROJECT_NAME_CLAIM, companyId, name, projectId });
    set(A, "web", "web-k3j9x2");
    // Only a legacy row stamped for A (the earlier layout): not A's project.
    w.db.set({ pk: "PROJECT#web-k3j9x2", sk: rev(1), entityType: "PROJECT", companyId: A, definition: definition("web-k3j9x2", 1) });
    expect(await companyProjectIdByName(w.db, "State", A, "web")).toBeUndefined();
    w.project(A, "web-k3j9x2", 1);
    expect(await companyProjectIdByName(w.db, "State", A, "web")).toBe("web-k3j9x2");
    // Company B's same claim: its own partition has no such project.
    set(B, "web", "web-k3j9x2");
    expect(await companyProjectIdByName(w.db, "State", B, "web")).toBeUndefined();
  });
});
