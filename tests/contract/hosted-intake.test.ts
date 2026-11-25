// Lead 2 L2-4: the tracker intake on hosted Code. The real Linear app webhook (#838/#842), the real connection store over the DynamoDB double, the real intake engine
// (`intakePortsOf` over a memory store) through `createHostedIntake`, the real developer dispatcher for the waiting-ticket routes, and a fake Linear behind the fetch seam.
// Two companies throughout: company B's Linear workspace has a team id and a Linear user id that are the SAME strings as company A's.
import { createHmac, randomUUID } from "node:crypto";
import { DEFAULT_TICKET_UPDATES, NEW_HOSTED_TICKET_UPDATES, ticketUpdatesSettingsKey } from "@agentx/contracts";
import { readTicketUpdates, saveTicketUpdates } from "../../packages/broker/src/core/ticket-updates/index.js";
import { describe, expect, it, vi } from "vitest";
import { INTAKE_WAIT_REASON_WORDS, IntakeWaitingListSchema, intakeItemIdOf, type AuditEvent, type OrgId, type Principal } from "@agentx/contracts";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { fakeLinear, LINEAR_APP, LINEAR_WEBHOOK_SECRET, testSealer, WORKSPACE_A, type FakeWorkspace } from "../support/fake-linear-oauth.js";
import { RecordingStore } from "../support/intake-world.js";
import { companyProjectRow } from "../support/company-layout-projects.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { LinearConnections, type LinearAppSettings } from "../../packages/broker/src/aws/linear-connections.js";
import { handleLinearAppWebhook } from "../../packages/broker/src/aws/linear-app-webhook.js";
import { linearAppIntakeDeliver } from "../../packages/broker/src/aws/linear-app-intake.js";
import { linkAccount } from "../../packages/broker/src/core/people/account-links.js";
import { createHostedIntake, hostedTrackerFor, intakeFenceKeyOf, ticketSessionStartExtras, type HostedIntakeCompany } from "../../packages/broker/src/aws/hosted-intake.js";
import { INTAKE_WORDS, isIntakePath, routeHostedIntake } from "../../packages/broker/src/core-host/intake-routes.js";
import { appRouteOf, devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { withCoreRoutes } from "../../packages/broker/src/aws/core-engine-root.js";
import { listWaitingIntakeItems } from "../../packages/broker/src/core/intake/store.js";
import { ingestIntake } from "../../packages/broker/src/core/intake/engine.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const PERSON_B = "e".repeat(64);
const MAYA = "a".repeat(64);
const BO = "b".repeat(64);
const DEV = "c".repeat(64);
const BASE = "/v1/dev/company/linear";
/** More teams in the pilot workspace, so each test project can have a team of its own. */
const EXTRA_TEAMS = ["x1", "x2", "x3", "x4", "x5"].map((id) => ({ id: `team-a-${id}`, key: id.toUpperCase(), name: `Extra ${id}` }));
WORKSPACE_A.teams.push(...EXTRA_TEAMS);
const WORKSPACE_D: FakeWorkspace = { id: "dddd4444-0000-4000-8000-00000000000d", name: "Delta Linear", urlKey: "delta", teams: [{ id: "team-a-eng", key: "ENG", name: "Engineering" }] };
const sign = (raw: string) => createHmac("sha256", LINEAR_WEBHOOK_SECRET).update(Buffer.from(raw, "utf8")).digest("hex");
const T0 = Date.parse(TIME);
/** The doorbell: a delivery names an issue by id (and a team) and nothing else is believed. */
const issueRung = (workspace: FakeWorkspace, at: number, key = "ENG-1") => ({
  type: "Issue", action: "update", organizationId: workspace.id, webhookTimestamp: at, data: { id: `issue-${workspace.urlKey}-${key}`, teamId: "team-a-eng" },
});

async function world(options: { onCore?: readonly string[] } = {}) {
  const h = companyRouteHarness();
  const now = Date.parse(TIME);
  h.deps.now = () => now;
  const linear = fakeLinear(() => now);
  const logs: Array<Record<string, unknown>> = [];
  const app: LinearAppSettings = { ...LINEAR_APP };
  const settings = async () => app;
  const connections = new LinearConnections({ documentClient: h.db, tableName: "State", sealer: testSealer(), fetch: linear.fetch, now: () => now, app: settings, log: (e) => logs.push(e), sleep: async () => undefined });
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  h.deps.developer.linearConnect = { connections, app: settings, fetch: linear.fetch, log: (e) => logs.push(e) };
  const member = (personId: string, companyId: string, role: "owner" | "admin" | "member") => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: `Person ${personId.slice(0, 2)}` });
  };
  const as = (personId: string) => {
    const sid = `session-${personId.slice(0, 4)}`;
    h.db.set({ pk: `SESSION#${sid}`, sk: "META", developerId: personId, amr: "slack", startedAt: TIME, endsAt: now / 1000 + 86_400 });
    h.claims.sub = personId; h.claims.sid = sid;
  };
  // DEC 254zzz80: a named company's grants live in its own partition.
  const grant = (personId: string, project: string, companyId: string, role: "developer" | "administrator") => h.db.set({ pk: `ORG#${companyId}#MEMBER#${personId}`, sk: `PROJECT#${project}`, projectName: project, role, companyId });
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown> };
  };
  const connect = async (workspace: FakeWorkspace) => {
    const started = await call("POST", `${BASE}/connect`, {});
    const code = linear.approve(started.body.authorizeUrl as string, workspace);
    expect((await call("POST", `${BASE}/complete`, { state: started.body.state, code })).status).toBe(200);
  };
  // A team starts work in ONE project (6.2b), so each project the tests add takes a team of its own: alpha and bravo take `team-a-eng`, the rest the extra teams the workspace has.
  const taken = new Set<string>();
  const project = async (name: string, companyId: string) => {
    h.db.set(companyProjectRow(companyId, name, 1)); // DEC 254zzz80: a named company's project in its own partition
    const teamId = ["team-a-eng", ...EXTRA_TEAMS.map((team) => team.id)].find((id) => !taken.has(`${companyId}:${id}`))!;
    taken.add(`${companyId}:${teamId}`);
    expect((await call("PUT", `${BASE}/projects/${name}`, { teamId })).status).toBe(200);
  };
  member(PERSON, A, "admin"); as(PERSON); await connect(WORKSPACE_A); await project("alpha", A);
  member(PERSON_B, B, "admin"); as(PERSON_B); await connect(WORKSPACE_D); await project("bravo", B);
  member(MAYA, A, "member"); member(BO, B, "member"); member(DEV, A, "member");

  // The core's side: one memory store (keys are company-scoped), live membership from the sign-in table double, the broker's grant rows.
  const store = new RecordingStore();
  const starts: Array<{ companyId: string; personId: string; project: string; requestId: string }> = [];
  const audits: AuditEvent[] = [];
  const startedByRequest = new Map<string, string>();
  const membershipOf = async (personId: string) => {
    const item = h.db.get(membershipKey(personId).pk, membershipKey(personId).sk) as Record<string, unknown> | undefined;
    return item === undefined || item["revokedAt"] !== undefined ? undefined : { companyId: item["companyId"] as string, role: item["role"] as string };
  };
  const companyOf = (companyId: OrgId): HostedIntakeCompany => ({
    store,
    identity: { getPrincipal: async (asked, personId): Promise<Principal | undefined> => {
      const m = await membershipOf(personId);
      return m === undefined || m.companyId !== asked ? undefined : { companyId: asked, personId, displayName: "x", roles: [m.role], provider: "hosted" };
    } },
    access: { checkStart: async (principal, name) => {
      const m = await membershipOf(principal.personId);
      const row = h.db.get(`ORG#${companyId}#MEMBER#${principal.personId}`, `PROJECT#${name}`) as Record<string, unknown> | undefined;
      return m?.companyId === companyId && principal.companyId === companyId && row?.["companyId"] === companyId ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: "no" };
    } },
    // The flow's start as the hosted runtime runs it for a ticket: its session and ticket binding in the start's own transaction (`ticketSessionStartExtras`), once per request id.
    // Batch 14: the company flow carries its deps (intakePortsOf reads them for a tracker parent); these starts never reach them.
    flow: { deps: {} as never, start: (async (caller: { principal: Principal; ticket?: { system: string; id: string; url: string } }, request: { requestId: string; project: string; title?: string }) => {
      const known = startedByRequest.get(request.requestId);
      if (known !== undefined) return { task: { taskId: known } };
      const taskId = randomUUID();
      startedByRequest.set(request.requestId, taskId);
      starts.push({ companyId, personId: caller.principal.personId, project: request.project, requestId: request.requestId });
      const extras = ticketSessionStartExtras(companyId)({ taskId, workspaceId: randomUUID(), project: request.project, title: request.title ?? "t", principal: caller.principal, client: "tracker", receivedAt: TIME, ...(caller.ticket === undefined ? {} : { ticket: caller.ticket }) });
      await store.transact([...extras.items]);
      return { task: { taskId } };
    }) as never },
    audit: { record: async (event) => { audits.push(event); } },
  });
  const onCore = new Set(options.onCore ?? [A, B]);
  const intake = createHostedIntake({ connections, fenceKey: intakeFenceKeyOf("test-signing-key"), now: () => now, log: (e) => logs.push(e), companyFor: async (companyId) => (onCore.has(companyId) ? companyOf(companyId) : undefined) });
  h.deps.developer.coreIntake = intake;
  const deliver = linearAppIntakeDeliver({ connections, app: settings, intakeFor: (companyId, options) => intake.intakeFor(companyId, options), now: () => now, fetch: linear.fetch, log: (e) => logs.push(e) });
  let at = now;
  const appHook = (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    return handleLinearAppWebhook({ connections, app: settings, now: () => now, deliver, log: (e) => logs.push(e) }, { rawBody: raw, headers: { "linear-signature": sign(raw) } });
  };
  /** A ticket the person labelled `rovara` a minute from now (after the team was picked and after any link made in the tests), then Linear's delivery for it. */
  const ticket = async (workspace: FakeWorkspace, actor?: string, key = "ENG-1") => {
    at += 1;
    linear.addIssue(workspace, { id: `issue-${workspace.urlKey}-${key}`, identifier: key, title: `Fix the login (${workspace.urlKey})`, labels: ["rovara"], history: actor === undefined ? [] : [{ id: `h-${String(at)}`, createdAt: new Date(T0 + 60_000).toISOString(), actorId: actor, addedLabelIds: ["lbl-rovara"] }] });
    return appHook(issueRung(workspace, at, key));
  };
  // A member's own link (written by the link routes in production, linear-account-link-routes.ts): under the company, in the workspace it was made in.
  const link = (companyId: string, organizationId: string, linearUserId: string, personId: string, linkedAt = TIME) => linkAccount(store, { companyId, provider: "linear", tenant: organizationId, accountId: linearUserId, personId, display: "", linkedAt });
  return { h, linear, logs, connections, store, starts, audits, intake, call, as, grant, member, ticket, link, now, project, onCore };
}

describe("Linear app events start work on hosted Code", () => {
  it("a linked member's ticket starts as that member in that company; the same Linear user id in company B waits there", async () => {
    const w = await world();
    await w.link(A, WORKSPACE_A.id, "user-maya", MAYA);
    // Linked but with no right to start work on the project: waits (no_authority), nothing starts.
    await w.ticket(WORKSPACE_A, "user-maya", "ENG-2");
    expect(w.starts).toEqual([]);
    expect((await listWaitingIntakeItems({ store: w.store, now: () => w.now }, A, "alpha")).map((item) => item.reason)).toEqual(["no_authority"]);
    w.grant(MAYA, "alpha", A, "developer");
    expect((await w.ticket(WORKSPACE_A, "user-maya")).status).toBe(200);
    expect(w.starts).toEqual([expect.objectContaining({ companyId: A, personId: MAYA, project: "alpha" })]);
    // Company B's workspace sends a ticket by the same Linear user id string: B has no link, so it waits in B and nothing starts.
    expect((await w.ticket(WORKSPACE_D, "user-maya")).status).toBe(200);
    expect(w.starts).toHaveLength(1);
    const waitingB = await listWaitingIntakeItems({ store: w.store, now: () => w.now }, B, "bravo");
    expect(waitingB.map((item) => item.reason)).toEqual(["unlinked"]);
    expect((await listWaitingIntakeItems({ store: w.store, now: () => w.now }, A, "alpha")).map((item) => item.id)).toEqual(["ENG-2"]);
  });

  it("a member who links AFTER their act is not credited for it: the ticket waits as unlinked, a later edit still starts nothing (a late link is not consent for an old act)", async () => {
    const w = await world();
    w.grant(MAYA, "alpha", A, "developer");
    // Maya's label is a minute after the team pick; her link is an hour after it.
    await w.link(A, WORKSPACE_A.id, "user-maya", MAYA, new Date(Date.parse(TIME) + 3_600_000).toISOString());
    await w.ticket(WORKSPACE_A, "user-maya", "ENG-3");
    await w.ticket(WORKSPACE_A, "user-maya", "ENG-3");
    expect(w.starts).toEqual([]);
    expect((await listWaitingIntakeItems({ store: w.store, now: () => w.now }, A, "alpha")).map((item) => [item.id, item.reason])).toEqual([["ENG-3", "unlinked"]]);
  });

  it("a company whose new tasks are not on the core has no intake: logged, nothing stored", async () => {
    const w = await world({ onCore: [B] });
    await w.link(A, WORKSPACE_A.id, "user-maya", MAYA);
    w.grant(MAYA, "alpha", A, "developer");
    await w.ticket(WORKSPACE_A, "user-maya");
    expect(w.starts).toEqual([]);
    expect(w.logs.some((e) => e.event === "linear.intake_not_wired" && e.companyId === A)).toBe(true);
    expect(await listWaitingIntakeItems({ store: w.store, now: () => w.now }, A, "alpha")).toEqual([]);
  });
});

describe("the hosted intake's own checks", () => {
  it("start and dismiss refuse a presser the identity does not vouch for as that person in that company, and a malformed ticket id", async () => {
    const store = new RecordingStore();
    let answer: Principal | undefined;
    const started: string[] = [];
    const intake = createHostedIntake({
      connections: { connection: async () => undefined }, fenceKey: intakeFenceKeyOf("k"), now: () => Date.parse(TIME), log: () => undefined,
      companyFor: async () => ({
        store, identity: { getPrincipal: async () => answer }, access: { checkStart: async () => ({ allowed: true }) },
        flow: { deps: {} as never, start: (async () => { started.push("x"); return { task: { taskId: randomUUID() } }; }) as never }, audit: { record: async () => undefined },
      }),
    });
    // A real waiting ticket (an outsider's), so a refused dismiss is the presser check and not a missing item.
    const ports = await intake.intakeFor(A);
    await ingestIntake(ports!, { orgId: A, project: "alpha", channel: "tracker", externalRef: { system: "linear", id: "ENG-9", url: "https://linear.app/acme/issue/ENG-9/x" }, title: "t", actor: { kind: "unknown" } });
    const item = intakeItemIdOf("linear", "ENG-9");
    expect((await listWaitingIntakeItems({ store, now: () => Date.parse(TIME) }, A, "alpha")).map((entry) => entry.itemId)).toEqual([item]);
    for (const wrong of [undefined, { companyId: B, personId: DEV }, { companyId: A, personId: MAYA }]) {
      answer = wrong === undefined ? undefined : { ...wrong, displayName: "x", roles: ["admin"], provider: "hosted" };
      expect(await intake.start(A, "alpha", item, DEV)).toEqual({ outcome: "forbidden" });
      expect(await intake.dismiss(A, "alpha", item, DEV)).toBe(false);
    }
    answer = { companyId: A, personId: DEV, displayName: "x", roles: ["admin"], provider: "hosted" };
    for (const bad of ["A".repeat(32), "a".repeat(31), "../x"]) expect(await intake.start(A, "alpha", bad, DEV)).toEqual({ outcome: "not_found" });
    expect(started).toEqual([]);
    expect(await intake.dismiss(A, "alpha", item, DEV)).toBe(true);
  });
});

describe("waiting-ticket routes (the one /v1/app address; core-host/intake-routes.ts)", () => {
  const list = (project = "alpha") => `/v1/app/projects/${project}/intake`;
  const act = (itemId: string, what: "start" | "dismiss", project = "alpha") => `/v1/app/projects/${project}/intake/${itemId}/${what}`;
  async function waitingWorld() {
    const w = await world();
    await w.ticket(WORKSPACE_A, "user-stranger");
    await w.ticket(WORKSPACE_D, "user-stranger", "ENG-2");
    const [item] = await listWaitingIntakeItems({ store: w.store, now: () => w.now }, A, "alpha");
    const [itemB] = await listWaitingIntakeItems({ store: w.store, now: () => w.now }, B, "bravo");
    // The person's standing on the project in their own company, read live from the membership and grant rows (the setup run's own rule: a company owner or admin, or the project's administrator, manages; any grant views).
    const standing = async (personId: string, companyId: OrgId, project: string) => {
      const m = w.h.db.get(membershipKey(personId).pk, membershipKey(personId).sk) as Record<string, unknown> | undefined;
      if (m === undefined || m["companyId"] !== companyId) return { access: "none" } as const;
      if (m["role"] === "owner") return { access: "manage", basis: "company-owner" } as const;
      if (m["role"] === "admin") return { access: "manage", basis: "company-admin" } as const;
      const grant = w.h.db.get(`ORG#${companyId}#MEMBER#${personId}`, `PROJECT#${project}`) as Record<string, unknown> | undefined;
      return grant === undefined ? ({ access: "none" } as const) : grant["role"] === "administrator" ? ({ access: "manage", basis: "project-admin" } as const) : ({ access: "view" } as const);
    };
    const projects: Record<string, string[]> = { [A]: ["alpha"], [B]: ["bravo"] };
    /** One request AS a person of a company, through the routes' own entry. */
    const asApp = async (personId: string, companyId: OrgId, method: string, path: string, body?: unknown) => {
      const answer = await routeHostedIntake({
        request: { method, path, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, path,
        principal: { companyId, personId, displayName: "x", roles: [], provider: "hosted" }, companyId,
        flow: { projects: { latest: async (name: string) => (projects[companyId]?.includes(name) === true ? ({ definition: {} } as never) : undefined) } } as never,
        wiring: { standing, intake: () => w.intake }, intake: w.intake,
      });
      return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown> };
    };
    return { ...w, itemId: item!.itemId, itemB: itemB!.itemId, asApp };
  }
  const message = (answer: { body: Record<string, unknown> }) => (answer.body.error as { message: string }).message;

  it("has a full-access row for each route at the /v1/app address, none at the old /v1/dev one, and the router's pattern matches only those", () => {
    expect(appRouteOf("GET", "/v1/app/projects/alpha/intake")?.requires).toBe("full");
    expect(appRouteOf("POST", `/v1/app/projects/alpha/intake/${"a".repeat(32)}/start`)?.requires).toBe("full");
    expect(appRouteOf("POST", `/v1/app/projects/alpha/intake/${"a".repeat(32)}/dismiss`)?.requires).toBe("full");
    expect(appRouteOf("GET", `/v1/app/projects/alpha/intake/${"a".repeat(32)}/start`)).toBeUndefined();
    expect(devRouteOf("GET", "/v1/dev/projects/alpha/intake")).toBeUndefined();
    expect(devRouteOf("POST", `/v1/dev/projects/alpha/intake/${"a".repeat(32)}/start`)).toBeUndefined();
    expect(isIntakePath("/v1/app/projects/alpha/intake", "GET")).toBe(true);
    expect(isIntakePath(`/v1/app/projects/alpha/intake/${"a".repeat(32)}/dismiss`, "POST")).toBe(true);
    expect(isIntakePath("/v1/app/projects/alpha/intake/x/approve", "POST")).toBe(false);
    expect(isIntakePath("/v1/app/projects/alpha/intake/updates", "GET")).toBe(false);
  });

  it("another company's project, a missing one, a bad name and a member without a grant all get the same 404; a developer gets the fixed 403", async () => {
    const w = await waitingWorld();
    const refusals = [await w.asApp(PERSON, A, "GET", list("bravo")), await w.asApp(PERSON, A, "GET", list("nothing")), await w.asApp(PERSON, A, "GET", list("..%2F")), await w.asApp(DEV, A, "GET", list("alpha"))];
    for (const refusal of refusals) expect([refusal.status, message(refusal)]).toEqual([404, INTAKE_WORDS.projectNotFound]);
    // A copy of another company's ticket id under one's own project is not found either.
    const cross = await w.asApp(PERSON, A, "POST", act(w.itemB, "dismiss"), { requestId: randomUUID() });
    expect([cross.status, message(cross)]).toEqual([404, INTAKE_WORDS.noTicket]);
    w.grant(DEV, "alpha", A, "developer");
    const developer = await w.asApp(DEV, A, "GET", list());
    expect([developer.status, message(developer)]).toEqual([403, INTAKE_WORDS.adminOnly]);
    expect((await w.asApp(DEV, A, "POST", act(w.itemId, "start"), { requestId: randomUUID() })).status).toBe(403);
    expect((await w.asApp(DEV, A, "POST", act(w.itemId, "dismiss"), { requestId: randomUUID() })).status).toBe(403);
    expect(w.starts).toEqual([]);
  });

  it("each row says, for THIS person, why it waits in Code's own words and whether they may Start or dismiss it: a project admin who may start can; a company admin with no grant sees it and cannot Start", async () => {
    const w = await waitingWorld();
    w.grant(DEV, "alpha", A, "administrator");
    const asAdmin = await w.asApp(DEV, A, "GET", list());
    expect(asAdmin.status).toBe(200);
    expect(IntakeWaitingListSchema.safeParse(asAdmin.body).success).toBe(true);
    expect((asAdmin.body.items as Array<Record<string, unknown>>)).toEqual([expect.objectContaining({ itemId: w.itemId, reason: "unlinked", reasonWords: INTAKE_WAIT_REASON_WORDS.unlinked, canStart: true, canDismiss: true })]);
    const asCompanyAdmin = await w.asApp(PERSON, A, "GET", list());
    expect((asCompanyAdmin.body.items as Array<Record<string, unknown>>)).toEqual([expect.objectContaining({ itemId: w.itemId, canStart: false, canDismiss: true })]);
    // The words name no page that does not exist (the old "Tracker people" screen).
    expect(INTAKE_WAIT_REASON_WORDS.unlinked).not.toContain("Tracker people");
  });

  it("the project's admin starts a waiting ticket as themselves; the press is audited; a second press starts nothing", async () => {
    const w = await waitingWorld();
    w.grant(DEV, "alpha", A, "administrator");
    const started = await w.asApp(DEV, A, "POST", act(w.itemId, "start"), { requestId: randomUUID() });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ started: true });
    expect(w.starts).toEqual([expect.objectContaining({ companyId: A, personId: DEV, project: "alpha" })]);
    expect(w.audits).toEqual([expect.objectContaining({ companyId: A, actor: { type: "person", id: DEV }, action: "intake.ticket_started", subject: { type: "intake_item", id: w.itemId } })]);
    const again = await w.asApp(DEV, A, "POST", act(w.itemId, "start"), { requestId: randomUUID() });
    expect(again.body).toMatchObject({ started: false });
    expect(w.starts).toHaveLength(1);
  });

  it("a company admin with no grant on the project may see and dismiss, but Start is the fixed 403", async () => {
    const w = await waitingWorld();
    const start = await w.asApp(PERSON, A, "POST", act(w.itemId, "start"), { requestId: randomUUID() });
    expect([start.status, message(start)]).toEqual([403, INTAKE_WORDS.cannotStart]);
    expect(w.starts).toEqual([]);
    const dismissed = await w.asApp(PERSON, A, "POST", act(w.itemId, "dismiss"), { requestId: randomUUID() });
    expect([dismissed.status, dismissed.body.dismissed]).toEqual([200, true]);
    expect(w.audits).toEqual([expect.objectContaining({ companyId: A, actor: { type: "person", id: PERSON }, action: "intake.ticket_dismissed" })]);
    expect((await w.asApp(PERSON, A, "POST", act(w.itemId, "dismiss"), { requestId: randomUUID() })).body.dismissed).toBe(true);
    expect((await w.asApp(PERSON, A, "GET", list())).body.items).toEqual([]);
    // Company B's ticket is untouched.
    expect(await listWaitingIntakeItems({ store: w.store, now: () => w.now }, B, "bravo")).toHaveLength(1);
  });

  it("a bad body, a bad ticket id and an unknown ticket are refused with fixed words", async () => {
    const w = await waitingWorld();
    expect((await w.asApp(PERSON, A, "POST", act(w.itemId, "dismiss"), { requestId: "nope" })).status).toBe(400);
    for (const id of ["f".repeat(32), "not-an-id"]) {
      const answer = await w.asApp(PERSON, A, "POST", act(id, "dismiss"), { requestId: randomUUID() });
      expect([answer.status, message(answer)]).toEqual([404, INTAKE_WORDS.noTicket]);
      expect(JSON.stringify(answer.body)).not.toContain(id);
    }
  });

  it("a standing the seam cannot tell is a fixed 503, and one that is not a known shape reads as none (never as manage)", async () => {
    const w = await waitingWorld();
    const base = { request: { method: "GET", path: list(), headers: {} } as never, path: list(), principal: { companyId: A, personId: PERSON, displayName: "x", roles: [], provider: "hosted" }, companyId: A, flow: { projects: { latest: async () => ({}) as never } } as never, intake: w.intake };
    const down = await routeHostedIntake({ ...base, wiring: { standing: async () => { throw new Error("people down: secret"); }, intake: () => w.intake } });
    expect([down.statusCode, (JSON.parse(down.body) as { error: { message: string } }).error.message]).toEqual([503, INTAKE_WORDS.unavailable]);
    const odd = await routeHostedIntake({ ...base, wiring: { standing: async () => ({ access: "manage", basis: "stranger" }) as never, intake: () => w.intake } });
    expect(odd.statusCode).toBe(404);
  });
});

describe("hosted wiring", () => {
  it("write-back writes a Linear ticket with the company's own token only; another company's scope is refused; no other tracker", async () => {
    const w = await world();
    w.linear.addIssue(WORKSPACE_A, { id: "issue-acme-ENG-1", identifier: "ENG-1", title: "x" });
    const trackerA = hostedTrackerFor(A, w.connections, w.linear.fetch)("linear")!;
    await trackerA.comment!({ tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" }, "Rovara started work.", { orgId: A });
    expect(w.linear.comments).toEqual([expect.objectContaining({ workspace: WORKSPACE_A.id })]);
    await expect(trackerA.comment!({ tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" }, "x", { orgId: B })).rejects.toThrow("another company");
    expect(w.linear.comments).toHaveLength(1);
    expect(hostedTrackerFor(A, w.connections)("jira")).toBeUndefined();
  });

  it("the developer configuration is byte-identical while the switch is off, and gains coreIntake only with an intake", () => {
    const config = { issuer: "x" };
    expect(withCoreRoutes(config, { coreTasks: undefined, coreApp: undefined })).toBe(config);
    const coreTasks = { route: async () => undefined };
    expect(withCoreRoutes(config, { coreTasks, coreApp: undefined })).toEqual({ issuer: "x", coreTasks });
    const intake = createHostedIntake({ connections: { connection: async () => undefined }, fenceKey: intakeFenceKeyOf("k"), now: () => 0, log: () => undefined, companyFor: async () => undefined });
    expect(withCoreRoutes(config, { coreTasks, coreApp: undefined, intake })).toEqual({ issuer: "x", coreTasks, coreIntake: intake });
  });

});

describe("L4-LP2: a project's first tracker team saves the new-hosted ticket-updates default, once, and never over a saved choice", () => {
  const settingsOf = (w: Awaited<ReturnType<typeof world>>, company: OrgId, project: string) => readTicketUpdates({ store: w.store, now: () => w.now }, company, project);

  it("a saved status_only stays status_only (and a saved anything else), however the team is set", async () => {
    const w = await world();
    w.as(PERSON);
    await saveTicketUpdates({ store: w.store, now: () => w.now }, { orgId: A, project: "delta", requestId: randomUUID(), by: "owner", settings: { ...DEFAULT_TICKET_UPDATES, level: "status_only" } });
    await w.project("delta", A);
    const kept = await settingsOf(w, A, "delta");
    expect(kept.revision).toBe(1);
    expect(kept.settings.level).toBe("status_only");
    await saveTicketUpdates({ store: w.store, now: () => w.now }, { orgId: A, project: "echo", requestId: randomUUID(), by: "owner", settings: { ...DEFAULT_TICKET_UPDATES, level: "decisions" } });
    await w.project("echo", A);
    expect((await settingsOf(w, A, "echo")).settings.level).toBe("decisions");
  });

  it("only the FIRST team: a project that already had one (an existing project) is unchanged by another team choice, and a later choice never rewrites the default", async () => {
    const w = await world();
    w.as(PERSON);
    // alpha got its team before the intake existed: changing its team again seeds nothing.
    expect((await w.call("PUT", `${BASE}/projects/alpha`, { teamId: "team-a-eng" })).status).toBe(200);
    expect((await settingsOf(w, A, "alpha")).revision).toBe(0);
    await w.project("foxtrot", A);
    await saveTicketUpdates({ store: w.store, now: () => w.now }, { orgId: A, project: "foxtrot", requestId: randomUUID(), by: "owner", settings: { ...NEW_HOSTED_TICKET_UPDATES, level: "decisions" }, });
    expect((await w.call("PUT", `${BASE}/projects/foxtrot`, { teamId: "team-a-x5" })).status).toBe(200);
    expect((await settingsOf(w, A, "foxtrot")).settings.level).toBe("decisions");
  });

  it("two companies: the same project name in each is seeded separately; a company whose tasks do not start on the core saves nothing", async () => {
    const w = await world({ onCore: [A] });
    expect(await w.intake.seedTicketUpdates(A, "hotel", MAYA)).toBe("seeded");
    expect(await w.intake.seedTicketUpdates(B, "hotel", BO)).toBe("no_intake");
    expect((await settingsOf(w, B, "hotel")).revision).toBe(0);
    const both = await world();
    expect(await both.intake.seedTicketUpdates(A, "hotel", MAYA)).toBe("seeded");
    expect(await both.intake.seedTicketUpdates(B, "hotel", BO)).toBe("seeded");
    expect((await settingsOf(both, A, "hotel")).revision).toBe(1);
    expect((await settingsOf(both, B, "hotel")).revision).toBe(1);
  });

  it("a team read that fails counts as 'had a team' (nothing is seeded); a seed that fails never fails the team PUT; an item that does not parse is kept, not overwritten", async () => {
    const w = await world();
    w.as(PERSON);
    const real = w.connections.teamPick.bind(w.connections);
    w.connections.teamPick = async () => { throw new Error("unreadable"); };
    await w.project("india", A);
    expect((await settingsOf(w, A, "india")).revision).toBe(0);
    w.connections.teamPick = real;
    const seeded = vi.spyOn(w.intake, "seedTicketUpdates").mockRejectedValue(new Error("store down"));
    {
      await w.project("juliet", A);
      expect(seeded).toHaveBeenCalledTimes(1);
      expect((await settingsOf(w, A, "juliet")).revision).toBe(0);
      expect((await w.call("GET", `${BASE}/projects/juliet`)).status).toBe(200);
    }
    seeded.mockRestore();
    const key = ticketUpdatesSettingsKey(A, "kilo");
    await w.store.put({ item: { ...key, entityType: "TICKET_UPDATES", orgId: A, project: "kilo", settings: { level: "nonsense" }, revision: 4 } });
    expect(await w.intake.seedTicketUpdates(A, "kilo", MAYA)).toBe("kept");
    expect((await w.store.get(key))!["revision"]).toBe(4);
  });
});
