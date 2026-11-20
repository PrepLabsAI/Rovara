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
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
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

function hosted(options: { store?: MemoryDocumentStore; company?: OrgId; audit?: (event: AuditEvent) => Promise<void>; projects?: string[]; schedule?: HostedUpkeepWiring["schedule"]; standing?: HostedUpkeepWiring["standing"]; available?: boolean; consent?: boolean } = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  // The company's consent (L4-P2): given unless a test says otherwise (the cases of this file that are not about the second lock).
  if (options.consent !== false) void store.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: new Date(T0).toISOString(), requestId: randomUUID() } });
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
/** The view a person gets (L4-P2 contract): the company admins (owner, admin) may also set the consent and raise the cap; nobody else. `systemRunsOn` is the ceiling AND the consent. */
const view = (enabled: boolean, who: "admin" | "maintainer" | "reader", over: Record<string, unknown> = {}): Body => ({
  enabled, canManage: who !== "reader", available: true, systemRunsOn: true, canEnableSystemRuns: who === "admin", cap: { monthlyUsd: null, canRaise: who === "admin" },
  // L4-SR1: a manager of an available install reads this month's nightly spend (a real zero with no runs); a reader never does.
  ...(who === "reader" ? {} : { spend: { month: "2026-11", spentUsd: 0, runs: 0, unknownRuns: 0 } }), ...over,
});
const NOT_FOUND = { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };

describe("reading: any role reads, off by default, everyone else the same 404", () => {

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

  it("the body is strict: nothing but { requestId, on }; a cap or any other field is refused and nothing is written", async () => {
    const w = hosted();
    for (const body of [{}, { on: true }, { requestId: randomUUID() }, { requestId: "nope", on: true }, { requestId: randomUUID(), on: "yes" }, { requestId: randomUUID(), on: true, monthlyCapUsd: 1_000 }, { requestId: randomUUID(), on: true, enabled: true }, { requestId: randomUUID(), on: true, allowSystemRuns: "yes" }, { requestId: randomUUID(), on: true, allowSystemRuns: false }, [] as never]) {
      expect((await put(w, OWNER, "beacon", body)).status).toBe(400);
    }
    expect(w.audited).toHaveLength(0);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
  });

});

describe("availability: the switch stays hidden until nightly runs really happen here", () => {
  // MUTANT availability: the switch is changed (or recorded) while this deployment cannot run nightly upkeep.
  it("a deployment with no runner says available false and refuses a change in fixed words: nothing recorded, nothing written, no schedule touched", async () => {
    const calls: string[] = [];
    const w = hosted({ available: false, schedule: () => ({ put: async () => { calls.push("put"); }, remove: async () => { calls.push("remove"); } }) });
    expect(await w.call(OWNER, "GET", "beacon")).toEqual({ status: 200, body: view(false, "admin", { available: false, systemRunsOn: false, canEnableSystemRuns: false, spend: undefined }) });
    const refused = await put(w, OWNER, "beacon", { requestId: randomUUID(), on: true });
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: { code: "NOT_AVAILABLE_HERE", message: "Nightly upkeep isn't available on this Rovara yet" } });
    expect(w.audited).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
    // Who still comes first: a reader is 403 and a person with no role the uniform 404, so availability reveals nothing to them.
    expect((await put(w, VIEWER, "beacon", { requestId: randomUUID(), on: true })).status).toBe(403);
    expect(await put(w, OUTSIDER, "beacon", { requestId: randomUUID(), on: true })).toEqual(NOT_FOUND);
    expect(await w.call(VIEWER, "GET", "beacon")).toEqual({ status: 200, body: view(false, "reader", { available: false, systemRunsOn: false }) });
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
    expect(JSON.parse(answer.body)).toEqual(view(false, "admin", { available: false, systemRunsOn: false, canEnableSystemRuns: false, spend: undefined }));
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
    const laptop = (enabled: boolean) => ({ enabled, canManage: true, available: true, systemRunsOn: true, canEnableSystemRuns: false, cap: { monthlyUsd: null, canRaise: false } });
    expect(await w.call(w.owner, "GET", "app")).toEqual({ status: 200, body: laptop(false) });
    const requestId = randomUUID();
    expect(await w.call(w.owner, "PUT", "app", { requestId, on: true })).toEqual({ status: 200, body: laptop(true) });
    expect(await w.call(w.owner, "PUT", "app", { requestId, on: true })).toEqual({ status: 200, body: laptop(true) });
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
