// Audit gap 11b (2026-11-18): a project's ticket-sharing settings on the hosted core (core-host/ticket-updates-routes.ts), the laptop's intake/updates route (local/app/intake.ts) with the hosted rule:
//   GET /v1/app/projects/{project}/intake/updates -> { settings, canEdit, access }; PUT { requestId, settings } -> the same view.
// Rules under test: the laptop's defaults and answer shape; a company owner or admin, or the project's administrator, changes; any role on the project reads (canEdit false); everyone else, another company's
// project, a project the person has no role on, a missing one and a malformed name get the SAME 404; a reader's change is 403; the audit record is written BEFORE the row; one request id is one act;
// every row is keyed by company AND project. Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_TICKET_UPDATES, TicketUpdatesViewSchema, ticketUpdatesSettingsKey, ticketWriteAccessKey, type AuditEvent, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { TICKET_UPDATES_WORDS, isTicketUpdatesPath, routeHostedTicketUpdates, type HostedTicketUpdatesWiring } from "../../packages/broker/src/core-host/ticket-updates-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { readTicketUpdates } from "../../packages/broker/src/core/ticket-updates/settings.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-18T12:00:00.000Z");
const OWNER = "o1".repeat(32);
const ADMIN = "a1".repeat(32);
const PROJECT_ADMIN = "p1".repeat(32);
const VIEWER = "v1".repeat(32);
const OUTSIDER = "x1".repeat(32);
const OWNER_B = "b1".repeat(32);
type Body = Record<string, any>;

const standingOf = (company: OrgId, project: string, person: string): SetupRunStanding => {
  if (company === COMPANY_A) {
    if (person === OWNER) return { access: "manage", basis: "company-owner" };
    if (person === ADMIN) return { access: "manage", basis: "company-admin" };
    if (person === PROJECT_ADMIN && project === "beacon") return { access: "manage", basis: "project-admin" };
    if (person === VIEWER && project === "beacon") return { access: "view" };
  }
  if (company === COMPANY_B && person === OWNER_B) return { access: "manage", basis: "company-owner" };
  return { access: "none" };
};

const DECISIONS = { comments: true, changeStatus: true, statuses: { started: "Doing" }, level: "decisions" } as const;

function hosted(options: { store?: MemoryDocumentStore; company?: OrgId; audit?: (event: AuditEvent) => Promise<void>; projects?: string[]; standing?: HostedTicketUpdatesWiring["standing"]; trackers?: string[] } = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const audited: AuditEvent[] = [];
  const projects = options.projects ?? ["beacon", "other"];
  const flow = { store, projects: { latest: async (name: string) => (projects.includes(name) ? { definition: { repositories: [] } } : undefined) } } as never;
  const wiring: HostedTicketUpdatesWiring = { standing: options.standing ?? (async (person, org, project) => standingOf(org, project, person)), trackers: options.trackers ?? ["linear"] };
  const audit = { record: options.audit ?? (async (event: AuditEvent) => { audited.push(event); }) };
  const call = async (person: string, method: string, project: string, body?: unknown) => {
    const path = `/v1/app/projects/${project}/intake/updates`;
    const answer = await routeHostedTicketUpdates({
      request: { method, path, headers: {}, body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) }, path,
      principal: { companyId: company, personId: person, displayName: "x", roles: [], provider: "test" }, companyId: company, flow, wiring, audit, now: () => T0,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  return { store, company, audited, call };
}
const put = (w: ReturnType<typeof hosted>, person: string, project: string, body: unknown) => w.call(person, "PUT", project, body);
const NOT_FOUND = { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
const defaults = { ...DEFAULT_TICKET_UPDATES, statuses: { ...DEFAULT_TICKET_UPDATES.statuses } };

describe("the path", () => {
  it("is GET and PUT on exactly /v1/app/projects/{project}/intake/updates", () => {
    expect(isTicketUpdatesPath("/v1/app/projects/beacon/intake/updates", "GET")).toBe(true);
    expect(isTicketUpdatesPath("/v1/app/projects/beacon/intake/updates", "PUT")).toBe(true);
    for (const [path, method] of [["/v1/app/projects/beacon/intake/updates", "POST"], ["/v1/app/projects/beacon/intake/updates", "DELETE"], ["/v1/app/projects/beacon/intake/updates/x", "GET"], ["/v1/app/projects/beacon/intake", "GET"], ["/v1/app/projects/beacon/intake/sources", "PUT"], ["/v1/app/projects//intake/updates", "GET"]] as const) {
      expect(isTicketUpdatesPath(path, method), `${method} ${path}`).toBe(false);
    }
  });
});

describe("reading: any role reads, the laptop's defaults, everyone else the same 404", () => {
  it("answers the laptop's view shape: the defaults, canEdit for a manager, and Linear's write access as last seen", async () => {
    const w = hosted();
    for (const person of [OWNER, ADMIN, PROJECT_ADMIN]) {
      const got = await w.call(person, "GET", "beacon");
      expect(got).toEqual({ status: 200, body: { settings: defaults, canEdit: true, access: [{ tracker: "linear", state: "ok" }] } });
      expect(TicketUpdatesViewSchema.safeParse(got.body).success).toBe(true);
    }
    expect(await w.call(VIEWER, "GET", "beacon")).toEqual({ status: 200, body: { settings: defaults, canEdit: false, access: [{ tracker: "linear", state: "ok" }] } });
    await w.store.put({ item: { ...ticketWriteAccessKey(COMPANY_A, "linear"), entityType: "TICKET_WRITE_ACCESS", orgId: COMPANY_A, tracker: "linear", state: "needs_write_access", at: "2026-11-18T10:00:00.000Z" } });
    expect((await w.call(VIEWER, "GET", "beacon")).body.access).toEqual([{ tracker: "linear", state: "needs_write_access", at: "2026-11-18T10:00:00.000Z" }]);
  });

  it("a person with no role, a role on another project only, a missing project and a malformed name all answer the identical 404; nothing is written", async () => {
    const w = hosted();
    expect(await w.call(OUTSIDER, "GET", "beacon")).toEqual(NOT_FOUND);
    expect(await w.call(VIEWER, "GET", "other")).toEqual(NOT_FOUND);
    expect(await w.call(PROJECT_ADMIN, "GET", "other")).toEqual(NOT_FOUND);
    expect(await w.call(OWNER, "GET", "missing")).toEqual(NOT_FOUND);
    expect(await w.call(OWNER, "GET", "bad%20name")).toEqual(NOT_FOUND);
    expect(await w.call(OWNER, "GET", "%E0%A4%A")).toEqual(NOT_FOUND);
    expect(await put(w, OUTSIDER, "beacon", { requestId: randomUUID(), settings: DECISIONS })).toEqual(NOT_FOUND);
    expect(await put(w, PROJECT_ADMIN, "other", { requestId: randomUUID(), settings: DECISIONS })).toEqual(NOT_FOUND);
    expect(await put(w, OWNER, "missing", { requestId: randomUUID(), settings: DECISIONS })).toEqual(NOT_FOUND);
    expect(w.audited).toHaveLength(0);
    expect(await w.store.get(ticketUpdatesSettingsKey(COMPANY_A, "beacon"))).toBeUndefined();
  });

  it("a standing the seam cannot tell is a fixed 503; one that is not a known shape is read as none (never as manage)", async () => {
    const throwing = hosted({ standing: async () => { throw new Error("people down: secret"); } });
    const refused = await throwing.call(OWNER, "GET", "beacon");
    expect(refused).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: TICKET_UPDATES_WORDS.unreadable } } });
    const odd = hosted({ standing: async () => ({ access: "manage", basis: "stranger" }) as never });
    expect(await odd.call(OWNER, "GET", "beacon")).toEqual(NOT_FOUND);
    expect(await put(odd, OWNER, "beacon", { requestId: randomUUID(), settings: DECISIONS })).toEqual(NOT_FOUND);
    expect(odd.audited).toHaveLength(0);
  });
});

describe("changing: a company owner or admin, or the project's administrator; a reader is refused", () => {
  it("each manager saves, and the view answers what was saved; the audit record names the person and why", async () => {
    for (const [person, basis] of [[OWNER, "company-owner"], [ADMIN, "company-admin"], [PROJECT_ADMIN, "project-admin"]] as const) {
      const w = hosted();
      const requestId = randomUUID();
      const saved = await put(w, person, "beacon", { requestId, settings: DECISIONS });
      expect(saved).toEqual({ status: 200, body: { settings: DECISIONS, canEdit: true, access: [{ tracker: "linear", state: "ok" }] } });
      expect((await readTicketUpdates({ store: w.store, now: () => T0 }, COMPANY_A, "beacon")).settings).toEqual(DECISIONS);
      expect(w.audited).toHaveLength(1);
      expect(w.audited[0]).toMatchObject({ companyId: COMPANY_A, actor: { type: "person", id: person }, action: "ticket_updates.changed", subject: { type: "project", id: "beacon" }, details: { project: "beacon", basis, requestId, level: "decisions", comments: true, changeStatus: true } });
    }
  });

  it("refuses a reader with 403 in fixed words, before the body is read and with nothing written", async () => {
    const w = hosted();
    expect(await put(w, VIEWER, "beacon", { requestId: randomUUID(), settings: DECISIONS })).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: TICKET_UPDATES_WORDS.notAllowed } } });
    expect(await put(w, VIEWER, "beacon", "not json")).toMatchObject({ status: 403 });
    expect(w.audited).toHaveLength(0);
    expect(await w.store.get(ticketUpdatesSettingsKey(COMPANY_A, "beacon"))).toBeUndefined();
  });

  it("refuses a body that is not the laptop's { requestId, settings } with fixed words that echo nothing", async () => {
    const w = hosted();
    for (const body of ["not json", {}, { requestId: "x", settings: DECISIONS }, { requestId: randomUUID(), settings: { ...DECISIONS, level: "everything" } }, { requestId: randomUUID(), settings: DECISIONS, extra: "<canary>" }, { requestId: randomUUID(), settings: { ...DECISIONS, statuses: { started: "x\u0007" } } }]) {
      const refused = await put(w, OWNER, "beacon", body);
      expect(refused, JSON.stringify(body)).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: TICKET_UPDATES_WORDS.badRequest } } });
    }
    expect(w.audited).toHaveLength(0);
  });

  it("writes the audit record BEFORE the row: an audit that fails changes nothing", async () => {
    const store = new MemoryDocumentStore();
    const order: string[] = [];
    const w = hosted({ store, audit: async () => { order.push((await store.get(ticketUpdatesSettingsKey(COMPANY_A, "beacon"))) === undefined ? "audit-before-row" : "audit-after-row"); } });
    await put(w, OWNER, "beacon", { requestId: randomUUID(), settings: DECISIONS });
    expect(order).toEqual(["audit-before-row"]);
    const broken = hosted({ audit: async () => { throw new Error("ledger down: secret"); } });
    const refused = await put(broken, OWNER, "beacon", { requestId: randomUUID(), settings: DECISIONS });
    expect(refused).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: TICKET_UPDATES_WORDS.unreadable } } });
    expect(await broken.store.get(ticketUpdatesSettingsKey(COMPANY_A, "beacon"))).toBeUndefined();
  });

  it("one request id is one act: the same settings again answer what is saved; other settings with the same id are refused", async () => {
    const w = hosted();
    const requestId = randomUUID();
    await put(w, OWNER, "beacon", { requestId, settings: DECISIONS });
    expect(await put(w, OWNER, "beacon", { requestId, settings: DECISIONS })).toMatchObject({ status: 200, body: { settings: DECISIONS } });
    expect(await put(w, OWNER, "beacon", { requestId, settings: { ...DECISIONS, level: "full" } })).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: TICKET_UPDATES_WORDS.requestIdReused } } });
    expect((await readTicketUpdates({ store: w.store, now: () => T0 }, COMPANY_A, "beacon")).revision).toBe(1);
    // The refused reuse records nothing: the trail holds the one change (the replay is the same event id, kept once by the sink).
    expect(new Set(w.audited.map((event) => event.eventId)).size).toBe(1);
  });
});

describe("isolation: every row is keyed by company AND project", () => {
  it("two projects: a save for beacon leaves other on the defaults", async () => {
    const w = hosted();
    await put(w, OWNER, "beacon", { requestId: randomUUID(), settings: DECISIONS });
    expect((await w.call(OWNER, "GET", "beacon")).body.settings).toEqual(DECISIONS);
    expect((await w.call(OWNER, "GET", "other")).body.settings).toEqual(defaults);
  });

  it("two companies: the same project name in company B is its own setting, and company A's owner cannot reach it", async () => {
    const store = new MemoryDocumentStore();
    const a = hosted({ store });
    const b = hosted({ store, company: COMPANY_B });
    await put(a, OWNER, "beacon", { requestId: randomUUID(), settings: DECISIONS });
    expect((await b.call(OWNER_B, "GET", "beacon")).body.settings).toEqual(defaults);
    // Company A's owner, asking through company B's route, has no standing there.
    expect(await b.call(OWNER, "GET", "beacon")).toEqual(NOT_FOUND);
    expect(await put(b, OWNER, "beacon", { requestId: randomUUID(), settings: { ...DECISIONS, level: "full" } })).toEqual(NOT_FOUND);
    expect((await readTicketUpdates({ store, now: () => T0 }, COMPANY_B, "beacon")).revision).toBe(0);
    expect((await readTicketUpdates({ store, now: () => T0 }, COMPANY_A, "beacon")).settings).toEqual(DECISIONS);
    // Company B's write access is its own: A's "needs write access" is not shown to B.
    await store.put({ item: { ...ticketWriteAccessKey(COMPANY_A, "linear"), entityType: "TICKET_WRITE_ACCESS", orgId: COMPANY_A, tracker: "linear", state: "needs_write_access", at: "2026-11-18T10:00:00.000Z" } });
    expect((await b.call(OWNER_B, "GET", "beacon")).body.access).toEqual([{ tracker: "linear", state: "ok" }]);
    expect(JSON.stringify((await b.call(OWNER_B, "GET", "beacon")).body)).not.toContain(COMPANY_A);
  });
});
