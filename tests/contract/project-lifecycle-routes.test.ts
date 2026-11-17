// Guided onboarding PR 16 (DEC 254n item 3): Archive and Restore for a project on the deployed developer API, as the signed-in person.
// Who: a live owner or admin of the project's company, or an administrator of that project. Never a plain member, never another company (their project looks missing).
// Preview first: each change has a read that says what it does and the revisions the change must name; a change made against other revisions is refused as stale.
import { describe, expect, it, vi } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID, ReviewedProjectArchiveOutcomeSchema, ReviewedProjectArchivePreviewSchema, ReviewedProjectRestoreOutcomeSchema, ReviewedProjectRestorePreviewSchema, SLACK_CHANNEL, channelBindingPartition, orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { ARCHIVE_NOT_ON_ENGINE, LIFECYCLE_BODY, LIFECYCLE_NOT_ALLOWED, LIFECYCLE_STALE, LIFECYCLE_UNREADABLE, lifecycleAccess, lifecycleAuditPrefix, lifecycleRequestKey, routeProjectLifecycle } from "../../packages/broker/src/aws/project-lifecycle-routes.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { definition } from "../support/task-flow-harness.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const ADA = "a".repeat(64);
const BEN = "b".repeat(64);
const CAL = "c".repeat(64);
const REQUEST = "0b9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8e";
const OTHER_REQUEST = "1c9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8f";
const CANARY = "leak-canary-31";
const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const P = (action: string, project = "alpha") => `/v1/dev/client/projects/${project}/${action}`;
const archiveBody = (over: Record<string, unknown> = {}) => ({ requestId: REQUEST, expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true, ...over });
const restoreBody = (over: Record<string, unknown> = {}) => ({ requestId: OTHER_REQUEST, expectedRevision: 1, expectedProjectRevision: 1, acknowledgeNewWorkAllowed: true, ...over });

function harness(options: { companies?: boolean; fullAccess?: boolean; engine?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 5 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADA, sid: "s-ada", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), ...(options.fullAccess === false ? {} : { fullAccess: true }), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name, sid] of [[ADA, "Ada", "s-ada"], [BEN, "Ben", "s-ben"], [CAL, "Cal", "s-cal"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false });
    db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member", revoked = false) => db.set({ pk: `COMPANY_MEMBER#${id}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME, ...(revoked ? { revokedAt: TIME } : {}) });
  const project = (name: string, companyId: string | undefined, revision = 1) => db.set({ pk: `PROJECT#${name}`, sk: `REV#${String(revision).padStart(12, "0")}`, entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }), definition: { name, revision } });
  const grant = (id: string, name: string, role: "administrator" | "developer") => db.set({ pk: `MEMBER#${id}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: id, projectName: name, role, grantedAt: TIME });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW,
    ...(options.companies === false ? {} : { companies: companyMembershipFromDynamo(db, "SignIn") }),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", clientRoutes: true,
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      ...(options.engine === false ? {} : { projectArchiveTakesEffect: (companyId: string) => companyId === A || companyId === B || companyId === IMPLICIT_COMPANY_ID }),
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string, sid: string) => { claims.sub = id; claims.sid = sid; };
  const meta = (companyId: string, name = "alpha") => db.get(projectMetaKey(companyId, name).pk, "META");
  return { db, claims, deps, call, as, join, project, grant, meta };
}
const error = (code: string, message: string) => ({ error: { code, message } });
const MISSING = { status: 404, body: error("NOT_FOUND", "project not found") };

describe("the archive preview", () => {
  it("answers the company, status, the revisions a change must name, and what archiving does", async () => {
    const h = harness(); h.join(ADA, A, "admin"); h.project("alpha", A);
    const answer = await h.call("GET", P("archive-preview"));
    expect(answer).toEqual({ status: 200, body: {
      orgId: A, project: "alpha", status: "active", expectedRevision: 0, expectedProjectRevision: 1, checkedAt: new Date(NOW).toISOString(), access: { actions: ["archive"] },
      impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 0, slackChannelsStayLinked: true, deletesNothing: true },
    } });
    expect(ReviewedProjectArchivePreviewSchema.parse(answer.body)).toEqual(answer.body);
  });

  it("counts the project's own linked Slack channels only, in the caller's company", async () => {
    const h = harness(); h.join(ADA, IMPLICIT_COMPANY_ID, "owner"); h.join(BEN, A, "owner"); h.project("alpha", undefined); h.project("gamma", A);
    h.deps.developer.slackTeamId = "T0LEGACY1";
    // With no Slack company layer the install's own team is the implicit company's only.
    for (const [channel, project] of [["C1", "alpha"], ["C2", "alpha"], ["C3", "beta"], ["C4", "gamma"]] as const) h.db.set({ pk: channelBindingPartition(SLACK_CHANNEL, "T0LEGACY1"), sk: `CHANNEL#${channel}`, projectName: project });
    expect((await h.call("GET", P("archive-preview"))).body).toMatchObject({ orgId: IMPLICIT_COMPANY_ID, impact: { linkedSlackChannels: 2 } });
    h.as(BEN, "s-ben");
    expect((await h.call("GET", P("archive-preview", "gamma"))).body).toMatchObject({ orgId: A, impact: { linkedSlackChannels: 0 } });
  });

  it("shows a project user the preview with no action they may take", async () => {
    const h = harness(); h.join(ADA, A, "member"); h.project("alpha", A); h.grant(ADA, "alpha", "developer");
    expect(await h.call("GET", P("archive-preview"))).toMatchObject({ status: 200, body: { access: { actions: [] } } });
    expect(await h.call("GET", P("restore-preview"))).toMatchObject({ status: 200, body: { access: { actions: [] } } });
  });

  it("answers the restore preview with its own words", async () => {
    const h = harness(); h.join(ADA, A, "admin"); h.project("alpha", A);
    expect((await h.call("POST", P("archive"), archiveBody())).status).toBe(200);
    const answer = await h.call("GET", P("restore-preview"));
    expect(answer).toEqual({ status: 200, body: {
      orgId: A, project: "alpha", status: "archived", expectedRevision: 1, expectedProjectRevision: 1, checkedAt: new Date(NOW).toISOString(), prerequisites: "not_required", access: { actions: ["restore"] },
      impact: { allowsNewWork: true, linkedSlackChannels: 0 },
    } });
    expect(ReviewedProjectRestorePreviewSchema.parse(answer.body)).toEqual(answer.body);
    // An active project offers no restore, an archived one no archive.
    expect((await h.call("GET", P("archive-preview"))).body).toMatchObject({ status: "archived", access: { actions: [] } });
  });
});

describe("who may archive and restore", () => {
  it("lets a company owner, a company admin and the project's administrator do both", async () => {
    for (const [role, grant] of [["owner", undefined], ["admin", undefined], ["member", "administrator"]] as const) {
      const h = harness(); h.join(ADA, A, role); h.project("alpha", A); if (grant !== undefined) h.grant(ADA, "alpha", grant);
      const archived = await h.call("POST", P("archive"), archiveBody());
      expect(archived.status, `${role}/${grant}`).toBe(200);
      expect(ReviewedProjectArchiveOutcomeSchema.parse(archived.body)).toEqual(archived.body);
      const restored = await h.call("POST", P("restore"), restoreBody());
      expect(restored.status, `${role}/${grant}`).toBe(200);
      expect(ReviewedProjectRestoreOutcomeSchema.parse(restored.body)).toEqual(restored.body);
    }
  });

  it("refuses a plain member who uses the project, in fixed words, and changes nothing", async () => {
    const h = harness(); h.join(ADA, A, "member"); h.project("alpha", A); h.grant(ADA, "alpha", "developer");
    const refused = { status: 403, body: error("FORBIDDEN", LIFECYCLE_NOT_ALLOWED) };
    expect(await h.call("POST", P("archive"), archiveBody())).toEqual(refused);
    h.db.set({ ...projectMetaKey(A, "alpha"), entityType: "PROJECT_META", status: "archived", lifecycleRevision: 1 });
    expect(await h.call("POST", P("restore"), restoreBody())).toEqual(refused);
    expect(h.meta(A)).toMatchObject({ status: "archived", lifecycleRevision: 1 });
  });

  it("answers another company's project, a project the person may not use, a missing one and a bad name alike (uniform 404)", async () => {
    const h = harness(); h.join(ADA, A, "admin"); h.join(BEN, B, "admin"); h.join(CAL, A, "member");
    h.project("foreign", B); h.grant(ADA, "foreign", "administrator");
    h.project("legacy", undefined);
    h.project("closed", A);
    for (const [who, sid, names] of [[ADA, "s-ada", ["foreign", "legacy", "nothing", "%E0%A4%A", CANARY]], [CAL, "s-cal", ["closed", "foreign", "nothing"]]] as const) {
      h.as(who, sid);
      for (const project of names) {
        for (const action of ["archive-preview", "restore-preview"]) {
          const answer = await h.call("GET", P(action, project));
          expect(answer, `${action} ${project}`).toEqual(MISSING);
        }
        expect(await h.call("POST", P("archive", project), archiveBody())).toEqual(MISSING);
        expect(await h.call("POST", P("restore", project), restoreBody())).toEqual(MISSING);
      }
    }
    expect(h.meta(B, "foreign")).toBeUndefined();
    // B's own admin still reaches B's project.
    h.as(BEN, "s-ben");
    expect((await h.call("POST", P("archive", "foreign"), archiveBody())).status).toBe(200);
    expect(h.meta(B, "foreign")).toMatchObject({ status: "archived" });
    expect(h.meta(A, "foreign")).toBeUndefined();
  });

  it("an administrator of one project is refused on another project of the same company", async () => {
    const h = harness(); h.join(ADA, A, "member"); h.project("alpha", A); h.project("beta", A); h.grant(ADA, "alpha", "administrator"); h.grant(ADA, "beta", "developer");
    expect((await h.call("POST", P("archive", "alpha"), archiveBody())).status).toBe(200);
    expect(await h.call("POST", P("archive", "beta"), archiveBody())).toEqual({ status: 403, body: error("FORBIDDEN", LIFECYCLE_NOT_ALLOWED) });
    expect(h.meta(A, "beta")).toBeUndefined();
  });

  it("reads the role live: a demoted admin or a removed member is refused at once", async () => {
    const h = harness(); h.join(ADA, A, "admin"); h.project("alpha", A);
    expect((await h.call("GET", P("archive-preview"))).body).toMatchObject({ access: { actions: ["archive"] } });
    h.join(ADA, A, "member");
    expect(await h.call("POST", P("archive"), archiveBody())).toEqual(MISSING);
    h.join(ADA, A, "admin", true);
    expect(await h.call("POST", P("archive"), archiveBody())).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
  });

  it("refuses a sign-in client without full access before reading anything", async () => {
    const h = harness({ fullAccess: false }); h.join(ADA, A, "owner"); h.project("alpha", A);
    expect(await h.call("POST", P("archive"), archiveBody())).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.meta(A)).toBeUndefined();
  });

  it("without the company layer every project looks missing, even to its administrator", async () => {
    const h = harness({ companies: false }); h.project("alpha", undefined); h.grant(ADA, "alpha", "administrator");
    expect(await h.call("GET", P("archive-preview"))).toEqual(MISSING);
    expect(await h.call("POST", P("archive"), archiveBody())).toEqual(MISSING);
    expect(h.db.find((item) => String(item.pk).startsWith("ORG#"))).toEqual([]);
  });

  it("keeps the method table: a preview is read, a change is posted", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    for (const [method, action] of [["POST", "archive-preview"], ["GET", "archive"], ["POST", "restore-preview"], ["GET", "restore"], ["DELETE", "archive"]] as const) {
      expect(await h.call(method, P(action), method === "POST" ? archiveBody() : undefined)).toEqual({ status: 404, body: error("NOT_FOUND", "route not found") });
    }
  });

  it("the rule itself: owners, admins and the project's administrators manage; a project user sees; anyone else nothing", () => {
    expect(lifecycleAccess("owner", undefined)).toBe("manage");
    expect(lifecycleAccess("admin", undefined)).toBe("manage");
    expect(lifecycleAccess("member", "administrator")).toBe("manage");
    expect(lifecycleAccess("member", "developer")).toBe("view");
    expect(lifecycleAccess("member", undefined)).toBe("none");
  });
});

describe("archiving and restoring", () => {
  it("refuses an archive where the company's tasks don't run on the engine that honours it; a restore still works", async () => {
    for (const engine of [false, "other-company"] as const) {
      const h = harness(engine === false ? { engine: false } : {}); h.join(ADA, A, "owner"); h.project("alpha", A);
      if (engine === "other-company") h.deps.developer.projectArchiveTakesEffect = (companyId) => companyId === B;
      expect((await h.call("GET", P("archive-preview"))).body).toMatchObject({ status: "active", access: { actions: [] } });
      expect(await h.call("POST", P("archive"), archiveBody())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", ARCHIVE_NOT_ON_ENGINE) });
      expect(h.meta(A)).toBeUndefined();
      h.db.set({ ...projectMetaKey(A, "alpha"), entityType: "PROJECT_META", status: "archived", lifecycleRevision: 1 });
      expect((await h.call("GET", P("restore-preview"))).body).toMatchObject({ access: { actions: ["restore"] } });
      expect((await h.call("POST", P("restore"), restoreBody())).status).toBe(200);
      expect(h.meta(A)).toMatchObject({ status: "active", lifecycleRevision: 2 });
    }
  });

  it("the write's own fences: a change that landed after the read (another archive and restore, or a new project revision) makes this one stale", async () => {
    for (const between of ["lifecycle", "revision"] as const) {
      const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
      const send = h.db.send;
      let fired = false;
      h.db.send = async (command) => {
        if (!fired && command.constructor.name === "TransactWriteCommand") {
          fired = true;
          if (between === "lifecycle") h.db.set({ ...projectMetaKey(A, "alpha"), entityType: "PROJECT_META", status: "active", lifecycleRevision: 2 });
          else h.project("alpha", A, 2);
        }
        return send(command);
      };
      expect(await h.call("POST", P("archive"), archiveBody()), between).toEqual({ status: 409, body: error("CHANGE_STALE", LIFECYCLE_STALE) });
      expect(h.meta(A), between).toEqual(between === "lifecycle" ? expect.objectContaining({ status: "active", lifecycleRevision: 2 }) : undefined);
      expect(h.db.find((item) => String(item.pk).includes("PROJECT_LIFECYCLE#")), between).toEqual([]);
    }
  });

  it("archives: new work is refused by the engine, a receipt and an audit row naming the person are kept", async () => {
    const h = harness(); h.join(ADA, A, "admin"); h.project("alpha", A);
    h.db.set({ ...projectRevisionKey(A, "alpha", 1), entityType: "PROJECT", companyId: A, definition: { ...definition, name: "alpha" } });
    h.db.set({ ...orgProjectCatalogKey(A, "alpha"), entityType: "PROJECT_CATALOG", companyId: A, name: "alpha", latestRevision: 1 });
    const engine = createStoreProjectSource({ get: async (key) => h.db.get(key.pk, key.sk) as never, query: async () => ({ items: [] }) }, A);
    expect(await engine.latest("alpha")).toMatchObject({ definition: { name: "alpha" } });
    expect(await engine.latest("alpha")).not.toHaveProperty("archived");
    const answer = await h.call("POST", P("archive"), archiveBody());
    expect(answer).toEqual({ status: 200, body: {
      receipt: { project: "alpha", status: "archived", revision: 1, projectRevision: 1, archivedAt: new Date(NOW).toISOString(), egressReconciliation: "pending" },
      replayed: false,
      current: { orgId: A, project: "alpha", status: "archived", expectedRevision: 1, expectedProjectRevision: 1, checkedAt: new Date(NOW).toISOString(), access: { actions: [] }, impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 0, slackChannelsStayLinked: true, deletesNothing: true } },
      effects: { egress: "not_attempted", archiveHook: "not_configured" },
    } });
    expect(h.meta(A)).toMatchObject({ entityType: "PROJECT_META", status: "archived", lifecycleRevision: 1, companyId: A, project: "alpha", lifecycleChangedBy: ADA });
    const audits = h.db.find(() => true).filter((item) => item.pk === lifecycleRequestKey(A, "alpha", REQUEST).pk && String(item.sk).startsWith(lifecycleAuditPrefix));
    expect(audits).toEqual([expect.objectContaining({ entityType: "PROJECT_LIFECYCLE_AUDIT", companyId: A, project: "alpha", action: "archive", personId: ADA, basis: "company-admin", fromRevision: 0, toRevision: 1, projectRevision: 1 })]);
    // The engine's own read of the project now says archived (start, rounds and setup refuse on it).
    expect(await engine.latest("alpha")).toMatchObject({ archived: true });
  });

  it("restores: the engine takes new work again", async () => {
    const h = harness(); h.join(ADA, A, "member"); h.project("alpha", A); h.grant(ADA, "alpha", "administrator");
    await h.call("POST", P("archive"), archiveBody());
    const answer = await h.call("POST", P("restore"), restoreBody());
    expect(answer).toEqual({ status: 200, body: {
      receipt: { project: "alpha", status: "active", revision: 2, projectRevision: 1, restoredAt: new Date(NOW).toISOString(), egressReconciliation: "pending" },
      replayed: false,
      current: { orgId: A, project: "alpha", status: "active", expectedRevision: 2, expectedProjectRevision: 1, checkedAt: new Date(NOW).toISOString(), prerequisites: "not_required", access: { actions: [] }, impact: { allowsNewWork: true, linkedSlackChannels: 0 } },
      effects: { egress: "not_attempted" },
    } });
    expect(h.meta(A)).toMatchObject({ status: "active", lifecycleRevision: 2, lifecycleChangedBy: ADA });
    const audits = h.db.find(() => true).filter((item) => String(item.sk).startsWith(lifecycleAuditPrefix));
    expect(audits.map((row) => [row.action, row.basis, row.fromRevision, row.toRevision])).toEqual(expect.arrayContaining([["archive", "project-admin", 0, 1], ["restore", "project-admin", 1, 2]]));
  });

  it("a repeat of the same request answers the first receipt and changes nothing more", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    const first = await h.call("POST", P("archive"), archiveBody());
    const again = await h.call("POST", P("archive"), archiveBody());
    expect(again).toEqual({ status: 200, body: { ...first.body, replayed: true, effects: { egress: "not_attempted", archiveHook: "not_attempted" } } });
    expect(h.meta(A)).toMatchObject({ lifecycleRevision: 1 });
    expect(h.db.find(() => true).filter((item) => String(item.sk).startsWith(lifecycleAuditPrefix))).toHaveLength(1);
  });

  it("a request id used by another person, or for the other change, is refused as stale", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.join(BEN, A, "admin"); h.project("alpha", A);
    await h.call("POST", P("archive"), archiveBody());
    h.as(BEN, "s-ben");
    expect(await h.call("POST", P("archive"), archiveBody())).toEqual({ status: 409, body: error("CHANGE_STALE", LIFECYCLE_STALE) });
    expect(await h.call("POST", P("restore"), restoreBody({ requestId: REQUEST }))).toEqual({ status: 409, body: error("CHANGE_STALE", LIFECYCLE_STALE) });
    expect(h.meta(A)).toMatchObject({ status: "archived", lifecycleRevision: 1 });
  });

  it("the same person reusing a request id for the other change is refused, not answered with the first receipt", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    expect((await h.call("POST", P("archive"), archiveBody())).status).toBe(200);
    expect(await h.call("POST", P("restore"), restoreBody({ requestId: REQUEST }))).toEqual({ status: 409, body: error("CHANGE_STALE", LIFECYCLE_STALE) });
    expect(h.meta(A)).toMatchObject({ status: "archived", lifecycleRevision: 1 });
  });

  it("a removed person (their sign-in record revoked) is refused even while a membership row still reads", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    h.db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "slack", displayName: "Ada", revoked: true });
    for (const answer of [await h.call("GET", P("archive-preview")), await h.call("POST", P("archive"), archiveBody())]) expect(answer).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
    expect(h.meta(A)).toBeUndefined();
  });

  it("the routes' own membership check: no live membership, or one that names no company, is a sign-in refusal before any project read", async () => {
    const db = new FakeDynamoDb({ seed: 9 });
    db.set({ pk: "PROJECT#alpha", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "alpha", revision: 1 } });
    for (const membership of [undefined, { companyId: "not-a-company", role: "owner" as const }]) {
      const ctx = { documentClient: db, tableName: "State", now: () => NOW, membershipOf: async () => membership, grantRole: async () => "administrator" as const, archiveTakesEffect: () => true, linkedSlackChannels: async () => 0 };
      for (const action of ["archive-preview", "archive"] as const) {
        await expect(routeProjectLifecycle(ctx, { personId: ADA, project: "alpha", action, body: JSON.stringify(archiveBody()) })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      }
    }
    expect(db.commandNames()).toEqual([]);
  });

  it("refuses a change made against other revisions, another status or another company, as stale", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A, 1); h.project("alpha", A, 2);
    const stale = { status: 409, body: error("CHANGE_STALE", LIFECYCLE_STALE) };
    const writes = () => h.db.commandNames().filter((name) => name === "TransactWriteCommand").length;
    expect(await h.call("POST", P("archive"), archiveBody())).toEqual(stale); // project revision 2 is the latest now
    expect(await h.call("POST", P("archive"), archiveBody({ expectedProjectRevision: 2, expectedRevision: 1 }))).toEqual(stale);
    expect(await h.call("POST", P("archive"), archiveBody({ expectedProjectRevision: 2, expectedOrgId: B }))).toEqual(stale);
    expect(await h.call("POST", P("restore"), restoreBody({ expectedProjectRevision: 2, expectedRevision: 0 }))).toEqual(stale); // not archived
    // Refused from what was read, before any write is tried (the write's own condition is the second fence, for a change that lands in between).
    expect(writes()).toBe(0);
    expect(h.meta(A)).toBeUndefined();
    expect((await h.call("POST", P("archive"), archiveBody({ expectedProjectRevision: 2, expectedOrgId: A }))).status).toBe(200);
    expect(await h.call("POST", P("archive"), archiveBody({ requestId: OTHER_REQUEST, expectedProjectRevision: 2, expectedRevision: 1 }))).toEqual(stale); // already archived
  });

  it("two changes at once: exactly one wins, the other is stale", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.join(BEN, A, "admin"); h.project("alpha", A);
    const benCall = async () => { h.as(BEN, "s-ben"); return h.call("POST", P("archive"), archiveBody({ requestId: OTHER_REQUEST })); };
    const answers = await Promise.all([h.call("POST", P("archive"), archiveBody()), benCall()]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(h.meta(A)).toMatchObject({ status: "archived", lifecycleRevision: 1 });
    expect(h.db.find(() => true).filter((item) => String(item.sk).startsWith(lifecycleAuditPrefix))).toHaveLength(1);
  });

  it("refuses unknown fields, a missing acknowledgement and bad values in fixed words that echo nothing", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    for (const body of [archiveBody({ extra: CANARY }), archiveBody({ acknowledgeNewWorkStops: false }), archiveBody({ requestId: CANARY }), archiveBody({ expectedRevision: -1 }), archiveBody({ expectedOrgId: CANARY }), `{${CANARY}`, ""]) {
      const answer = await h.call("POST", P("archive"), body);
      expect(answer).toEqual({ status: 400, body: error("CONFIG_INVALID", LIFECYCLE_BODY) });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(await h.call("POST", P("restore"), restoreBody({ acknowledgeNewWorkAllowed: undefined }))).toEqual({ status: 400, body: error("CONFIG_INVALID", LIFECYCLE_BODY) });
    expect(h.meta(A)).toBeUndefined();
  });

  it("a project state row that does not read is refused whole, never guessed", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    h.db.set({ ...projectMetaKey(A, "alpha"), entityType: "PROJECT_META", status: CANARY });
    for (const answer of [await h.call("GET", P("archive-preview")), await h.call("POST", P("archive"), archiveBody())]) {
      expect(answer).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", LIFECYCLE_UNREADABLE) });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
  });

  it("keeps an earlier row's other fields (a laptop's setup check) when it archives", async () => {
    const h = harness(); h.join(ADA, A, "owner"); h.project("alpha", A);
    h.db.set({ ...projectMetaKey(A, "alpha"), entityType: "PROJECT_META", status: "active", setupCheck: { status: "ready" } });
    expect((await h.call("POST", P("archive"), archiveBody())).status).toBe(200);
    expect(h.meta(A)).toMatchObject({ status: "archived", lifecycleRevision: 1, setupCheck: { status: "ready" } });
  });
});
