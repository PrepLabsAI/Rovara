// Lead 4 N1: the nightly upkeep ON/OFF switch route, hosted (core-host/upkeep-routes.ts) and on `rovara up` (local/app/upkeep.ts).
//   GET /v1/app/projects/{project}/upkeep -> { enabled, canManage }; PUT { requestId, on } -> the same view.
// Rules under test: off by default; a company owner or admin, or the project's administrator, switches it; any role on the project reads it; everyone else, another company's project, a project the person has no role on,
// a missing one and a malformed name get the SAME 404; a reader's change is 403; the audit record is written BEFORE the row; the same request id with the same choice is one act, with the other choice a new act;
// every row is keyed by company AND project. Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, queryAll, type AuditEvent, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { routeHostedUpkeep, isUpkeepPath, type HostedUpkeepWiring } from "../../packages/broker/src/core-host/upkeep-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createLocalUpkeep } from "../../packages/broker/src/local/app/upkeep.js";
import { upkeepIsOn, upkeepSwitchControl } from "../../packages/broker/src/core/upkeep/settings.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const OWNER = "o1".repeat(32);
const ADMIN = "a1".repeat(32);
const PROJECT_ADMIN = "p1".repeat(32);
const VIEWER = "v1".repeat(32);
const OUTSIDER = "x1".repeat(32);
type Body = Record<string, any>;

const standingOf = (company: OrgId, project: string, person: string): SetupRunStanding => {
  if (company === COMPANY_A) {
    if (person === OWNER) return { access: "manage", basis: "company-owner" };
    if (person === ADMIN) return { access: "manage", basis: "company-admin" };
    if (person === PROJECT_ADMIN && project === "beacon") return { access: "manage", basis: "project-admin" };
    if (person === VIEWER && project === "beacon") return { access: "view" };
  }
  if (company === COMPANY_B && person === "b1".repeat(32)) return { access: "manage", basis: "company-owner" };
  return { access: "none" };
};

function hosted(options: { store?: MemoryDocumentStore; company?: OrgId; audit?: (event: AuditEvent) => Promise<void>; projects?: string[]; schedule?: HostedUpkeepWiring["schedule"]; standing?: HostedUpkeepWiring["standing"]; available?: boolean } = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const audited: AuditEvent[] = [];
  const projects = options.projects ?? ["beacon", "other"];
  const flow = { store, projects: { latest: async (name: string) => (projects.includes(name) ? { definition: { repositories: [] } } : undefined) } } as never;
  const wiring: HostedUpkeepWiring = { standing: options.standing ?? (async (person, org, project) => standingOf(org, project, person)), schedule: options.schedule, ...(options.available === false ? {} : { available: () => true }) };
  const audit = { stage: () => [], record: options.audit ?? (async (event: AuditEvent) => { audited.push(event); }) };
  const call = async (person: string, method: "GET" | "PUT", project: string, body?: unknown) => {
    const answer = await routeHostedUpkeep({
      request: { method, path: `/v1/app/projects/${project}/upkeep`, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, path: `/v1/app/projects/${project}/upkeep`,
      principal: { companyId: company, personId: person, displayName: "x", roles: [], provider: "test" }, companyId: company, flow, wiring, audit: audit, now: () => T0,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  return { store, company, audited, call };
}
const put = (w: ReturnType<typeof hosted>, person: string, project: string, body: unknown) => w.call(person, "PUT", project, body);
const NOT_FOUND = { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };

describe("reading: any role reads, off by default, everyone else the same 404", () => {
  it("shows a manager enabled false canManage true, and a reader canManage false", async () => {
    const w = hosted();
    for (const person of [OWNER, ADMIN, PROJECT_ADMIN]) expect(await w.call(person, "GET", "beacon")).toEqual({ status: 200, body: { enabled: false, canManage: true, available: true } });
    expect(await w.call(VIEWER, "GET", "beacon")).toEqual({ status: 200, body: { enabled: false, canManage: false, available: true } });
  });

  it("a person with no role, a role on another project only, a missing project and a malformed name all answer the identical 404", async () => {
    const w = hosted();
    expect(await w.call(OUTSIDER, "GET", "beacon")).toEqual(NOT_FOUND);
    expect(await w.call(VIEWER, "GET", "other")).toEqual(NOT_FOUND);
    expect(await w.call(PROJECT_ADMIN, "GET", "other")).toEqual(NOT_FOUND);
    expect(await w.call(OWNER, "GET", "missing")).toEqual(NOT_FOUND);
    expect(await w.call(OWNER, "GET", "bad%20name")).toEqual(NOT_FOUND);
    expect(await w.call(OWNER, "GET", "%E0%A4%A")).toEqual(NOT_FOUND);
    expect(await put(w, OUTSIDER, "beacon", { requestId: randomUUID(), on: true })).toEqual(NOT_FOUND);
    expect(await put(w, VIEWER, "other", { requestId: randomUUID(), on: true })).toEqual(NOT_FOUND);
    expect(w.audited).toHaveLength(0);
  });

  it("a standing the seam cannot tell, or one that is not a known shape, is read as none (never as manage)", async () => {
    const throwing = hosted({ standing: async () => { throw new Error("people down"); } });
    expect((await throwing.call(OWNER, "GET", "beacon")).status).toBe(503);
    const odd = hosted({ standing: async () => ({ access: "manage", basis: "stranger" }) as never });
    expect(await odd.call(OWNER, "GET", "beacon")).toEqual(NOT_FOUND);
    expect(await put(odd, OWNER, "beacon", { requestId: randomUUID(), on: true })).toEqual(NOT_FOUND);
    expect(odd.audited).toHaveLength(0);
  });

  it("only GET and PUT on exactly this path belong to the route", () => {
    expect(isUpkeepPath("/v1/app/projects/beacon/upkeep", "GET")).toBe(true);
    expect(isUpkeepPath("/v1/app/projects/beacon/upkeep", "PUT")).toBe(true);
    for (const [path, method] of [["/v1/app/projects/beacon/upkeep", "POST"], ["/v1/app/projects/beacon/upkeep", "DELETE"], ["/v1/app/projects/beacon/upkeep/extra", "GET"], ["/v1/app/projects/beacon/upkeeps", "GET"], ["/v1/app/projects/upkeep", "GET"]] as const) expect(isUpkeepPath(path, method)).toBe(false);
  });
});

describe("switching: who, the strict body, the audit record first", () => {
  // MUTANT role check: a reader (or anyone with a role) may switch it.
  it("a company owner, a company admin and the project's administrator switch it on and off; a reader gets 403 in fixed words and nothing changes", async () => {
    const w = hosted();
    for (const person of [OWNER, ADMIN, PROJECT_ADMIN]) {
      expect(await put(w, person, "beacon", { requestId: randomUUID(), on: true })).toEqual({ status: 200, body: { enabled: true, canManage: true, available: true } });
      expect((await w.call(VIEWER, "GET", "beacon")).body).toEqual({ enabled: true, canManage: false, available: true });
      expect(await put(w, person, "beacon", { requestId: randomUUID(), on: false })).toEqual({ status: 200, body: { enabled: false, canManage: true, available: true } });
    }
    const denied = await put(w, VIEWER, "beacon", { requestId: randomUUID(), on: true });
    expect(denied).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only company owners and admins, or this project's admins, can switch nightly upkeep on or off." } } });
    expect(await upkeepIsOn({ store: w.store, companyId: COMPANY_A }, "beacon")).toBe(false);
  });

  it("the project's administrator manages their project only", async () => {
    const w = hosted();
    expect(await put(w, PROJECT_ADMIN, "other", { requestId: randomUUID(), on: true })).toEqual(NOT_FOUND);
    expect(await upkeepIsOn({ store: w.store, companyId: COMPANY_A }, "other")).toBe(false);
  });

  it("the body is strict: nothing but { requestId, on }; a cap or any other field is refused and nothing is written", async () => {
    const w = hosted();
    for (const body of [{}, { on: true }, { requestId: randomUUID() }, { requestId: "nope", on: true }, { requestId: randomUUID(), on: "yes" }, { requestId: randomUUID(), on: true, monthlyCapUsd: 1_000 }, { requestId: randomUUID(), on: true, enabled: true }, [] as never]) {
      expect((await put(w, OWNER, "beacon", body)).status).toBe(400);
    }
    expect(w.audited).toHaveLength(0);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
  });

  it("the audit record names the person and why they were allowed, and is written BEFORE the row; one that cannot be written changes nothing", async () => {
    const seen: boolean[] = [];
    const store = new MemoryDocumentStore();
    const w = hosted({ store, audit: async () => { seen.push(await upkeepIsOn({ store, companyId: COMPANY_A }, "beacon")); } });
    await put(w, ADMIN, "beacon", { requestId: randomUUID(), on: true });
    expect(seen).toEqual([false]);
    const w2 = hosted();
    await put(w2, PROJECT_ADMIN, "beacon", { requestId: randomUUID(), on: true });
    expect(w2.audited[0]).toMatchObject({ companyId: COMPANY_A, actor: { type: "person", id: PROJECT_ADMIN }, action: "upkeep.upkeep_switched", subject: { type: "project", id: "beacon" }, details: { project: "beacon", basis: "project-admin", on: true } });
    const broken = hosted({ audit: async () => { throw new Error("audit down"); } });
    const answer = await put(broken, OWNER, "beacon", { requestId: randomUUID(), on: true });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect((answer.body["error"] as { code: string }).code).toBe("AUDIT_UNAVAILABLE");
    expect(await upkeepIsOn({ store: broken.store, companyId: COMPANY_A }, "beacon")).toBe(false);
  });

  // MUTANT replay rule: a reused request id is a replay whatever the choice.
  it("the same request id with the same choice is one act; with the OTHER choice it is a new act", async () => {
    const w = hosted();
    const requestId = randomUUID();
    expect((await put(w, OWNER, "beacon", { requestId, on: true })).body.enabled).toBe(true);
    expect((await put(w, OWNER, "beacon", { requestId, on: true })).body.enabled).toBe(true);
    expect(w.audited).toHaveLength(1);
    // The same id, the other choice: it switches it off and records a second act with its own event id.
    expect((await put(w, OWNER, "beacon", { requestId, on: false })).body.enabled).toBe(false);
    expect(w.audited).toHaveLength(2);
    expect(new Set(w.audited.map((event) => event.eventId)).size).toBe(2);
    expect(await upkeepIsOn({ store: w.store, companyId: COMPANY_A }, "beacon")).toBe(false);
    // And back on with the same id once more.
    expect((await put(w, OWNER, "beacon", { requestId, on: true })).body.enabled).toBe(true);
    expect(w.audited).toHaveLength(3);
  });

  // MUTANT audit id: the event id leaves out the row the act replaces, so on, off, on with one request id is dropped as a repeat by a sink that dedupes on the id.
  it("on, then off, then on with ONE request id leaves three distinct audit records in a sink that drops a repeated event id", async () => {
    const seen = new Map<string, AuditEvent>();
    const w = hosted({ audit: async (event) => { if (!seen.has(event.eventId)) seen.set(event.eventId, event); } });
    const requestId = randomUUID();
    await put(w, OWNER, "beacon", { requestId, on: true });
    await put(w, OWNER, "beacon", { requestId, on: false });
    await put(w, OWNER, "beacon", { requestId, on: true });
    expect(await upkeepIsOn({ store: w.store, companyId: COMPANY_A }, "beacon")).toBe(true);
    expect([...seen.values()].map((event) => event.details?.["on"])).toEqual([true, false, true]);
  });

  it("a replay by a person who lost their role is refused first (the standing is read before the replay is looked at)", async () => {
    let allowed = true;
    const w = hosted({ standing: async (person, org, project) => (allowed ? standingOf(org, project, person) : { access: "none" }) });
    const requestId = randomUUID();
    await put(w, OWNER, "beacon", { requestId, on: true });
    allowed = false;
    expect(await put(w, OWNER, "beacon", { requestId, on: true })).toEqual(NOT_FOUND);
  });

  it("the schedule follows the switch: ON puts the project's night, OFF removes it; a project that never turned it on has none", async () => {
    const calls: string[] = [];
    const w = hosted({ schedule: (company) => ({ put: async (scope) => { calls.push(`put:${company}:${scope.orgId}:${scope.project}`); }, remove: async (scope) => { calls.push(`remove:${scope.orgId}:${scope.project}`); } }) });
    expect(calls).toEqual([]);
    await put(w, OWNER, "beacon", { requestId: randomUUID(), on: true });
    await put(w, OWNER, "beacon", { requestId: randomUUID(), on: false });
    expect(calls).toEqual([`put:${COMPANY_A}:${COMPANY_A}:beacon`, `remove:${COMPANY_A}:beacon`]);
  });
});

describe("availability: the switch stays hidden until nightly runs really happen here", () => {
  // MUTANT availability: the switch is changed (or recorded) while this deployment cannot run nightly upkeep.
  it("a deployment with no runner says available false and refuses a change in fixed words: nothing recorded, nothing written, no schedule touched", async () => {
    const calls: string[] = [];
    const w = hosted({ available: false, schedule: () => ({ put: async () => { calls.push("put"); }, remove: async () => { calls.push("remove"); } }) });
    expect(await w.call(OWNER, "GET", "beacon")).toEqual({ status: 200, body: { enabled: false, canManage: true, available: false } });
    const refused = await put(w, OWNER, "beacon", { requestId: randomUUID(), on: true });
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: { code: "NOT_AVAILABLE_HERE", message: "Nightly upkeep isn't available on this Rovara yet" } });
    expect(w.audited).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
    // Who still comes first: a reader is 403 and a person with no role the uniform 404, so availability reveals nothing to them.
    expect((await put(w, VIEWER, "beacon", { requestId: randomUUID(), on: true })).status).toBe(403);
    expect(await put(w, OUTSIDER, "beacon", { requestId: randomUUID(), on: true })).toEqual(NOT_FOUND);
    expect(await w.call(VIEWER, "GET", "beacon")).toEqual({ status: 200, body: { enabled: false, canManage: false, available: false } });
  });

  it("in the core, who comes before availability: a reader is 403 and a person with no role 404 even while nothing can run", async () => {
    const store = new MemoryDocumentStore();
    const deps = { store, companyId: COMPANY_A, now: () => T0, standing: async (person: string, project: string) => standingOf(COMPANY_A, project, person) };
    const body = { requestId: randomUUID(), on: true };
    await expect(upkeepSwitchControl(deps, VIEWER, "beacon", body)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(upkeepSwitchControl(deps, OUTSIDER, "beacon", body)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(upkeepSwitchControl(deps, OWNER, "beacon", body)).rejects.toMatchObject({ code: "NOT_AVAILABLE_HERE" });
  });

  it("a seam that throws or answers anything but true reads as not available", async () => {
    const w = hosted();
    const flaky = { standing: async (person: string, org: OrgId, project: string) => standingOf(org, project, person), available: () => { throw new Error("x"); } } as HostedUpkeepWiring;
    const answer = await routeHostedUpkeep({
      request: { method: "GET", path: "/v1/app/projects/beacon/upkeep", headers: {}, body: "" }, path: "/v1/app/projects/beacon/upkeep",
      principal: { companyId: COMPANY_A, personId: OWNER, displayName: "x", roles: [], provider: "test" }, companyId: COMPANY_A,
      flow: { store: w.store, projects: { latest: async () => ({ definition: { repositories: [] } }) } } as never, wiring: flaky, audit: { stage: () => [], record: async () => undefined }, now: () => T0,
    });
    expect(JSON.parse(answer.body)).toEqual({ enabled: false, canManage: true, available: false });
  });

  it("on a laptop with no local runner the answer says available false and a change is refused", async () => {
    const store = new MemoryDocumentStore();
    const flow = { store, projects: { latest: async () => ({ definition: { repositories: [] } }) } } as never;
    const upkeep = createLocalUpkeep({ flow, owner: { personId: "owner-1" } as never, audit: { stage: () => [], record: async () => undefined }, now: () => T0 });
    const owner = { principal: { roles: ["owner"], personId: "owner-1", displayName: "Owner" } } as never;
    const got = await upkeep.routes({ method: "GET", path: "/v1/app/projects/app/upkeep", headers: {}, body: "" }, owner);
    expect(JSON.parse(got!.body)).toEqual({ enabled: false, canManage: true, available: false });
    const refused = await upkeep.routes({ method: "PUT", path: "/v1/app/projects/app/upkeep", headers: {}, body: JSON.stringify({ requestId: randomUUID(), on: true }) }, owner);
    expect(refused!.statusCode).toBe(404);
    expect(await upkeepIsOn({ store, companyId: IMPLICIT_COMPANY_ID }, "app")).toBe(false);
  });
});

describe("isolation: every row is keyed by company AND project", () => {
  it("two projects: ON for beacon leaves other off, and each reads its own row", async () => {
    const w = hosted();
    await put(w, OWNER, "beacon", { requestId: randomUUID(), on: true });
    expect((await w.call(OWNER, "GET", "beacon")).body.enabled).toBe(true);
    expect((await w.call(OWNER, "GET", "other")).body.enabled).toBe(false);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(1);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#other` })).toHaveLength(0);
  });

  it("two companies: the same project name in company B is its own switch, and company A's person cannot reach it", async () => {
    const store = new MemoryDocumentStore();
    const a = hosted({ store });
    const b = hosted({ store, company: COMPANY_B });
    await put(a, OWNER, "beacon", { requestId: randomUUID(), on: true });
    expect((await b.call("b1".repeat(32), "GET", "beacon")).body).toEqual({ enabled: false, canManage: true, available: true });
    // Company A's owner, asking through company B's route, has no standing there.
    expect(await b.call(OWNER, "GET", "beacon")).toEqual(NOT_FOUND);
    expect(await put(b, OWNER, "beacon", { requestId: randomUUID(), on: false })).toEqual(NOT_FOUND);
    expect(await upkeepIsOn({ store, companyId: COMPANY_A }, "beacon")).toBe(true);
    expect(await upkeepIsOn({ store, companyId: COMPANY_B }, "beacon")).toBe(false);
    await put(b, "b1".repeat(32), "beacon", { requestId: randomUUID(), on: true });
    expect(await queryAll(store, { pk: `ORG#${COMPANY_B}#UPKEEP#beacon` })).toHaveLength(1);
  });
});

describe("on a laptop: the owner of the install only", () => {
  const COMPANY = IMPLICIT_COMPANY_ID;
  const setup = (projects = ["app", "site"], available = true) => {
    const store = new MemoryDocumentStore();
    const audited: AuditEvent[] = [];
    const flow = { store, projects: { latest: async (name: string) => (projects.includes(name) ? { definition: { repositories: [] } } : undefined) } } as never;
    const upkeep = createLocalUpkeep({ flow, owner: { personId: "owner-1" } as never, ...(available ? { available: () => true } : {}), audit: { stage: () => [], record: async (event: AuditEvent) => { audited.push(event); } }, now: () => T0 });
    const owner = { principal: { roles: ["owner"], personId: "owner-1", displayName: "Owner" } } as never;
    const call = async (caller: unknown, method: string, project: string, body?: unknown) => {
      const answer = await upkeep.routes({ method, path: `/v1/app/projects/${project}/upkeep`, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, caller as never);
      return answer === undefined ? undefined : { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
    };
    return { store, audited, call, owner };
  };

  it("reads off by default, switches on and off, audits first, and keeps two projects apart", async () => {
    const w = setup();
    expect(await w.call(w.owner, "GET", "app")).toEqual({ status: 200, body: { enabled: false, canManage: true, available: true } });
    const requestId = randomUUID();
    expect(await w.call(w.owner, "PUT", "app", { requestId, on: true })).toEqual({ status: 200, body: { enabled: true, canManage: true, available: true } });
    expect(await w.call(w.owner, "PUT", "app", { requestId, on: true })).toEqual({ status: 200, body: { enabled: true, canManage: true, available: true } });
    expect(w.audited).toHaveLength(1);
    expect((await w.call(w.owner, "PUT", "app", { requestId, on: false }))?.body.enabled).toBe(false);
    expect(w.audited).toHaveLength(2);
    await w.call(w.owner, "PUT", "app", { requestId: randomUUID(), on: true });
    expect((await w.call(w.owner, "GET", "site"))?.body.enabled).toBe(false);
    expect(await upkeepIsOn({ store: w.store, companyId: COMPANY }, "app")).toBe(true);
  });

  it("refuses a script token and anyone who is not the owner, answers 404 for a missing project, and leaves other paths and methods alone", async () => {
    const w = setup();
    const token = { principal: { roles: ["owner"], personId: "owner-1" }, scriptToken: { tokenId: "t" } };
    const guest = { principal: { roles: [], personId: "guest" } };
    expect((await w.call(token, "PUT", "app", { requestId: randomUUID(), on: true }))?.status).toBe(403);
    expect((await w.call(guest, "GET", "app"))?.status).toBe(403);
    expect(await w.call(w.owner, "GET", "missing")).toEqual(NOT_FOUND);
    expect(await w.call(w.owner, "POST", "app", { requestId: randomUUID(), on: true })).toBeUndefined();
    expect(await w.call(w.owner, "DELETE", "app")).toBeUndefined();
    expect(w.audited).toHaveLength(0);
  });
});
