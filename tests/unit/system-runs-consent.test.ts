// L4-P2 (owner DEC 254zzt, option A "two locks"): the company's CONSENT to Rovara's automatic runs, and the setup step that sets it together with the project's upkeep switch.
// Effective system runs = the operator's ceiling (`available`) AND the company's stored consent. Only a LIVE company owner or admin writes the consent; a maintainer (project administrator) toggles the project
// switch only; the setup PUT changes both in ONE transaction with an audit record for each, written before. Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ON_THE_WEBSITE_MESSAGE, SYSTEM_RUNS_CONSENT_WORDS, queryAll, type AuditEvent, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { routeHostedUpkeep, type HostedUpkeepWiring } from "../../packages/broker/src/core-host/upkeep-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { readSystemRunsConsentRow, systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { readUpkeepSetting, upkeepSwitchControl } from "../../packages/broker/src/core/upkeep/settings.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const OWNER = "o1".repeat(32);
const ADMIN = "a1".repeat(32);
const MAINTAINER = "p1".repeat(32);
const MEMBER = "m1".repeat(32);
const VIEWER = "v1".repeat(32);
const OUTSIDER = "x1".repeat(32);
const OWNER_B = "b1".repeat(32);
type Body = Record<string, any>;

const standingOf = (company: OrgId, project: string, person: string): SetupRunStanding => {
  if (company === COMPANY_A) {
    if (person === OWNER) return { access: "manage", basis: "company-owner" };
    if (person === ADMIN) return { access: "manage", basis: "company-admin" };
    if (person === MAINTAINER && project === "beacon") return { access: "manage", basis: "project-admin" };
    if ((person === VIEWER || person === MEMBER) && project === "beacon") return { access: "view" };
  }
  if (company === COMPANY_B && person === OWNER_B) return { access: "manage", basis: "company-owner" };
  return { access: "none" };
};

interface Options { webApp?: boolean; store?: MemoryDocumentStore; company?: OrgId; ceiling?: boolean; consent?: boolean; standing?: HostedUpkeepWiring["standing"]; cap?: HostedUpkeepWiring["cap"]; audit?: (event: AuditEvent, store: MemoryDocumentStore) => Promise<void>; transact?: "fail" }

function hosted(options: Options = {}) {
  const base = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const transacts: number[] = [];
  // A store whose `transact` can be made to fail, and that counts the items of each transaction.
  const store = new Proxy(base, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "transact") return async (items: readonly unknown[]) => { transacts.push(items.length); return options.transact === "fail" ? { applied: false, reason: "condition_failed", failed: [0] } : (target.transact.bind(target))(items as never); };
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const audited: AuditEvent[] = [];
  const projects = ["beacon", "other"];
  const flow = { store, projects: { latest: async (name: string) => (projects.includes(name) ? { definition: { repositories: [] } } : undefined) } } as never;
  const wiring: HostedUpkeepWiring = { standing: options.standing ?? (async (person, org, project) => standingOf(org, project, person)), ...(options.ceiling === false ? {} : { available: () => true }), ...(options.cap === undefined ? {} : { cap: options.cap }) };
  const audit = { stage: () => [], record: async (event: AuditEvent) => { if (options.audit !== undefined) await options.audit(event, base); audited.push(event); } };
  const call = async (person: string, method: "GET" | "PUT", project: string, body?: unknown) => {
    const answer = await routeHostedUpkeep({
      request: { method, path: `/v1/app/projects/${project}/upkeep`, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, path: `/v1/app/projects/${project}/upkeep`,
      principal: { companyId: company, personId: person, displayName: "x", roles: [], provider: "test" }, companyId: company, flow, wiring, audit, now: () => T0,
      // Owner DEC 254zzz91: the Rovara website's own client by default; a test that is not one says so.
      webApp: options.webApp ?? true,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  if (options.consent === true) void base.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: new Date(T0).toISOString(), requestId: randomUUID() } });
  return { store: base, company, audited, call, transacts };
}
const errorOf = (answer: { body: Body }): { code: string; message: string } => answer.body["error"] as { code: string; message: string };
const setup = (w: ReturnType<typeof hosted>, person: string, body: Record<string, unknown> = {}) => w.call(person, "PUT", "beacon", { requestId: randomUUID(), on: true, allowSystemRuns: true, ...body });
const consentOf = (store: MemoryDocumentStore, company: OrgId = COMPANY_A) => readSystemRunsConsentRow({ store, companyId: company });
const nothingWritten = async (w: ReturnType<typeof hosted>) => {
  expect((await consentOf(w.store)).enabled).toBe(false);
  expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
};

describe("the consent is written only by a live company owner or admin", () => {
  // MUTANT role check: a project administrator, a member or a reader may set the consent through the setup step.
  it("an owner and an admin set it; a project administrator, a member and a reader get 403 in fixed words and NOTHING is written or recorded", async () => {
    for (const person of [OWNER, ADMIN]) {
      const w = hosted();
      const answer = await setup(w, person);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ enabled: true, systemRunsOn: true, available: true });
      expect((await consentOf(w.store)).enabled).toBe(true);
    }
    for (const person of [MAINTAINER, MEMBER, VIEWER]) {
      const w = hosted();
      const answer = await setup(w, person);
      expect(answer.status, person).toBe(403);
      // The maintainer MAY manage the project, so the words are the consent's own; a reader gets the project switch's.
      expect(errorOf(answer).message).toBe(person === MAINTAINER ? SYSTEM_RUNS_CONSENT_WORDS.notAllowed : "Only company owners and admins, or this project's admins, can switch nightly upkeep on or off.");
      await nothingWritten(w);
      expect(w.audited).toEqual([]);
      expect(w.transacts).toEqual([]);
    }
  });

  // MUTANT M2: the setup step's owner/admin gate before the availability check is dropped (the in-core check still refuses, but the ceiling-off answer would then leak "unavailable" to a maintainer).
  it("a maintainer asking for the consent step is told 403 (not 'unavailable') even while the ceiling is off", async () => {
    const w = hosted({ ceiling: false });
    const answer = await setup(w, MAINTAINER);
    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SYSTEM_RUNS_CONSENT_WORDS.notAllowed);
  });

  it("no role on the project is the uniform 404 and another company's person has no standing here", async () => {
    const w = hosted();
    expect(await setup(w, OUTSIDER)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    expect(await setup(w, OWNER_B)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    await nothingWritten(w);
  });

  // MUTANT live role: the role is taken from the first read (the page's view), not read again at the write.
  it("the role is read live AT THE WRITE: an owner demoted between the view and the write writes nothing", async () => {
    let reads = 0;
    const w = hosted({ standing: async (person, org, project) => { reads += 1; return reads <= 2 ? standingOf(org, project, person) : { access: "manage", basis: "project-admin" }; } });
    const answer = await setup(w, OWNER);
    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SYSTEM_RUNS_CONSENT_WORDS.notAllowed);
    await nothingWritten(w);
    expect(w.audited).toEqual([]);
  });

  it("only owners and admins can withdraw it, and a withdrawal that also asks for upkeep ON is refused", async () => {
    const w = hosted({ consent: true });
    expect((await setup(w, MAINTAINER, { on: false, allowSystemRuns: false })).status).toBe(403);
    expect((await consentOf(w.store)).enabled).toBe(true);
    const contradiction = await setup(w, OWNER, { on: true, allowSystemRuns: false });
    expect(contradiction.status).toBe(400);
    expect(errorOf(contradiction).message).toBe(SYSTEM_RUNS_CONSENT_WORDS.contradiction);
    expect((await consentOf(w.store)).enabled).toBe(true);
    const off = await setup(w, ADMIN, { on: false, allowSystemRuns: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, systemRunsOn: false });
    expect((await consentOf(w.store)).enabled).toBe(false);
  });

  it("the ceiling off: the setup step is refused as unavailable, nothing written or recorded, and an owner is told so before a maintainer's 403 does not apply", async () => {
    const w = hosted({ ceiling: false });
    const answer = await setup(w, OWNER);
    expect(answer.body).toEqual({ error: { code: "NOT_AVAILABLE_HERE", message: "Nightly upkeep isn't available on this Rovara yet" } });
    await nothingWritten(w);
    expect(w.audited).toEqual([]);
  });
});

describe("effective = ceiling AND consent (the four combinations, as the page reads them)", () => {
  // MUTANT the AND: systemRunsOn follows the ceiling alone, or the consent alone.
  it("systemRunsOn is true only with the ceiling AND the consent; canEnableSystemRuns needs the ceiling and a company admin", async () => {
    const cells: Array<[boolean, boolean, boolean, boolean]> = [[false, false, false, false], [false, true, false, false], [true, false, false, true], [true, true, true, true]];
    for (const [ceiling, consent, on, canEnable] of cells) {
      const w = hosted({ ceiling, consent });
      const owner = (await w.call(OWNER, "GET", "beacon")).body;
      expect(owner, `ceiling=${String(ceiling)} consent=${String(consent)}`).toMatchObject({ available: ceiling, systemRunsOn: on, canEnableSystemRuns: canEnable });
      const maintainer = (await w.call(MAINTAINER, "GET", "beacon")).body;
      expect(maintainer).toMatchObject({ available: ceiling, systemRunsOn: on, canEnableSystemRuns: false, canManage: true });
      expect((await w.call(VIEWER, "GET", "beacon")).body).toMatchObject({ canManage: false, canEnableSystemRuns: false, cap: { canRaise: false } });
    }
  });

  it("the cap is null where the host has no gateway read, the gateway's number where it has one, and only an owner or admin can raise it; a read that fails or is not a plain number is null", async () => {
    const none = hosted({ consent: true });
    expect((await none.call(OWNER, "GET", "beacon")).body["cap"]).toEqual({ monthlyUsd: null, canRaise: true });
    const read = hosted({ consent: true, cap: async (company, project) => (company === COMPANY_A && project === "beacon" ? 40 : null) });
    expect((await read.call(OWNER, "GET", "beacon")).body["cap"]).toEqual({ monthlyUsd: 40, canRaise: true });
    expect((await read.call(MAINTAINER, "GET", "beacon")).body["cap"]).toEqual({ monthlyUsd: 40, canRaise: false });
    expect((await read.call(VIEWER, "GET", "beacon")).body["cap"]).toEqual({ monthlyUsd: null, canRaise: false });
    for (const bad of [async () => { throw new Error("down"); }, async () => Number.NaN, async () => -1, async () => "25" as never, async () => Infinity]) {
      expect((await hosted({ consent: true, cap: bad }).call(OWNER, "GET", "beacon")).body["cap"]).toEqual({ monthlyUsd: null, canRaise: true });
    }
  });

  // MUTANT: a maintainer's plain ON is allowed without the company's consent (a switch that records "on" and runs nothing).
  it("a maintainer's plain switch: ON needs the consent already given (403 in fixed words, nothing written); OFF always works; with the consent ON works", async () => {
    const w = hosted();
    const refused = await w.call(MAINTAINER, "PUT", "beacon", { requestId: randomUUID(), on: true });
    expect(refused).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: SYSTEM_RUNS_CONSENT_WORDS.needsConsent } } });
    await nothingWritten(w);
    expect(w.audited).toEqual([]);
    // The company's owner sets it up (consent + ON); the maintainer may then toggle the project switch both ways, but never the consent.
    expect((await setup(w, OWNER)).status).toBe(200);
    expect((await w.call(MAINTAINER, "PUT", "beacon", { requestId: randomUUID(), on: false })).body).toMatchObject({ enabled: false, systemRunsOn: true });
    expect((await w.call(MAINTAINER, "PUT", "beacon", { requestId: randomUUID(), on: true })).body).toMatchObject({ enabled: true, systemRunsOn: true });
    expect((await consentOf(w.store)).enabled).toBe(true);
    // An owner's plain OFF leaves the consent as it was.
    expect((await w.call(OWNER, "PUT", "beacon", { requestId: randomUUID(), on: false })).body).toMatchObject({ enabled: false, systemRunsOn: true });
    // With the consent withdrawn, a plain ON is refused again, for an owner too (the setup step is the way).
    await setup(w, OWNER, { on: false, allowSystemRuns: false });
    expect((await w.call(OWNER, "PUT", "beacon", { requestId: randomUUID(), on: true })).body).toEqual({ error: { code: "FORBIDDEN", message: SYSTEM_RUNS_CONSENT_WORDS.needsConsent } });
  });
});

describe("the setup PUT: consent and the project switch in ONE transaction, audited for both", () => {
  // MUTANT: the two rows are written with two separate puts (or the consent is written outside the transaction).
  it("one store transaction with both rows; the consent row names the company only (no person), the switch row its project", async () => {
    const w = hosted();
    const requestId = randomUUID();
    expect((await w.call(OWNER, "PUT", "beacon", { requestId, on: true, allowSystemRuns: true })).status).toBe(200);
    expect(w.transacts).toEqual([2]);
    const consent = await w.store.get(systemRunsConsentKey(COMPANY_A));
    expect(consent).toMatchObject({ entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY_A, enabled: true, requestId });
    expect(JSON.stringify(consent)).not.toContain(OWNER);
    expect(await readUpkeepSetting({ store: w.store, companyId: COMPANY_A }, "beacon")).toMatchObject({ enabled: true });
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#other` })).toHaveLength(0);
  });

  it("a failed transaction writes NEITHER row and the page is told to try again", async () => {
    const w = hosted({ transact: "fail" });
    const answer = await setup(w, OWNER);
    expect(answer.status).toBe(503);
    await nothingWritten(w);
    expect(w.transacts).toEqual([2]);
  });

  // MUTANT: only one of the two audit records is written, or either is written after the change.
  it("one audit record for the company's consent and one for the project's switch, both BEFORE any row changes, naming the person and why", async () => {
    const seenConsent: boolean[] = [];
    const seenSwitch: boolean[] = [];
    const w = hosted({ audit: async (event, store) => {
      (event.action === "system_runs.consent_set" ? seenConsent : seenSwitch).push((await consentOf(store)).enabled || (await readUpkeepSetting({ store, companyId: COMPANY_A }, "beacon")).enabled);
    } });
    await setup(w, ADMIN);
    expect(seenConsent).toEqual([false]);
    expect(seenSwitch).toEqual([false]);
    expect(w.audited.map((event) => event.action)).toEqual(["system_runs.consent_set", "upkeep.upkeep_switched"]);
    expect(w.audited[0]).toMatchObject({ companyId: COMPANY_A, actor: { type: "person", id: ADMIN }, subject: { type: "company", id: COMPANY_A }, details: { basis: "company-admin", on: true, previous: "none" } });
    expect(w.audited[1]).toMatchObject({ companyId: COMPANY_A, actor: { type: "person", id: ADMIN }, subject: { type: "project", id: "beacon" }, details: { project: "beacon", basis: "company-admin", on: true } });
  });

  it("an audit record that cannot be written (either one) changes nothing", async () => {
    for (const failing of ["system_runs.consent_set", "upkeep.upkeep_switched"]) {
      const w = hosted({ audit: async (event) => { if (event.action === failing) throw new Error("audit down"); } });
      const answer = await setup(w, OWNER);
      expect(errorOf(answer).code, failing).toBe("AUDIT_UNAVAILABLE");
      expect(answer.status).toBeGreaterThanOrEqual(500);
      await nothingWritten(w);
      expect(w.transacts).toEqual([]);
    }
  });

  it("the same request id with the same choices is one act; on, off, on with ONE id leaves distinct audit ids in a sink that drops a repeated id", async () => {
    const seen = new Map<string, AuditEvent>();
    const w = hosted({ audit: async (event) => { if (!seen.has(event.eventId)) seen.set(event.eventId, event); } });
    const requestId = randomUUID();
    await w.call(OWNER, "PUT", "beacon", { requestId, on: true, allowSystemRuns: true });
    const afterFirst = seen.size;
    await w.call(OWNER, "PUT", "beacon", { requestId, on: true, allowSystemRuns: true });
    expect(seen.size).toBe(afterFirst);
    expect(w.transacts).toEqual([2]);
    await w.call(OWNER, "PUT", "beacon", { requestId, on: false, allowSystemRuns: false });
    await w.call(OWNER, "PUT", "beacon", { requestId, on: true, allowSystemRuns: true });
    const consents = [...seen.values()].filter((event) => event.action === "system_runs.consent_set").map((event) => event.details?.["on"]);
    expect(consents).toEqual([true, false, true]);
    expect((await consentOf(w.store)).enabled).toBe(true);
  });

  // MUTANT (review L2): the two puts are unconditional, so a concurrent change between the read and the write is overwritten.
  it("a row that changed between the read and the write loses: the setup step writes neither row and says to try again", async () => {
    const w = hosted({ audit: async (event, store) => {
      if (event.action === "system_runs.consent_set") await store.put({ item: { ...systemRunsConsentKey(COMPANY_A), entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY_A, enabled: false, changedAt: "2026-11-17T11:59:59.000Z", requestId: randomUUID() } });
    } });
    const answer = await setup(w, OWNER);
    expect(answer.status).toBe(503);
    expect((await consentOf(w.store)).enabled).toBe(false);
    expect(await queryAll(w.store, { pk: `ORG#${COMPANY_A}#UPKEEP#beacon` })).toHaveLength(0);
  });

  it("the schedule follows the project's switch in the setup step", async () => {
    const calls: string[] = [];
    const base = hosted();
    const w = (() => {
      const wiring: HostedUpkeepWiring = { standing: async (person, org, project) => standingOf(org, project, person), available: () => true, schedule: () => ({ put: async (scope) => { calls.push(`put:${scope.project}`); }, remove: async (scope) => { calls.push(`remove:${scope.project}`); } }) };
      const flow = { store: base.store, projects: { latest: async () => ({ definition: { repositories: [] } }) } } as never;
      return (person: string, body: unknown) => routeHostedUpkeep({ request: { method: "PUT", path: "/v1/app/projects/beacon/upkeep", headers: {}, body: JSON.stringify(body) }, path: "/v1/app/projects/beacon/upkeep", principal: { companyId: COMPANY_A, personId: person, displayName: "x", roles: [], provider: "test" }, companyId: COMPANY_A, flow, wiring, audit: { stage: () => [], record: async () => undefined }, now: () => T0, webApp: true });
    })();
    await w(OWNER, { requestId: randomUUID(), on: true, allowSystemRuns: true });
    await w(OWNER, { requestId: randomUUID(), on: false, allowSystemRuns: false });
    expect(calls).toEqual(["put:beacon", "remove:beacon"]);
  });

  it("in the core: the standing must say company admin, a plain manage is not enough (kills a check that reads only `access`)", async () => {
    const store = new MemoryDocumentStore();
    const deps = { store, companyId: COMPANY_A, now: () => T0, available: () => true, standing: async () => ({ access: "manage" as const }), record: async () => undefined, recordConsent: async () => undefined };
    await expect(upkeepSwitchControl(deps, MAINTAINER, "beacon", { requestId: randomUUID(), on: true, allowSystemRuns: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await readSystemRunsConsentRow({ store, companyId: COMPANY_A })).enabled).toBe(false);
  });
});

describe("two companies", () => {
  it("company A's consent opens nothing for company B, and each company's setup step writes only its own row", async () => {
    const store = new MemoryDocumentStore();
    const a = hosted({ store });
    const b = hosted({ store, company: COMPANY_B });
    expect((await setup(a, OWNER)).status).toBe(200);
    expect((await consentOf(store, COMPANY_A)).enabled).toBe(true);
    expect((await consentOf(store, COMPANY_B)).enabled).toBe(false);
    expect((await b.call(OWNER_B, "GET", "beacon")).body).toMatchObject({ systemRunsOn: false, canEnableSystemRuns: true });
    // A's owner through B's route has no standing; B's owner sets B's own row only.
    expect(await setup(b, OWNER)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    expect((await setup(b, OWNER_B)).status).toBe(200);
    expect((await consentOf(store, COMPANY_B)).enabled).toBe(true);
    // B's owner withdraws B's consent: A's stays.
    await setup(b, OWNER_B, { on: false, allowSystemRuns: false });
    expect((await consentOf(store, COMPANY_B)).enabled).toBe(false);
    expect((await consentOf(store, COMPANY_A)).enabled).toBe(true);
    expect(await queryAll(store, { pk: `ORG#${COMPANY_B}#SYSTEM_RUNS` })).toHaveLength(1);
  });

  it("a consent row that names another company (a damaged or copied row) is no consent", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...systemRunsConsentKey(COMPANY_A), entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY_B, enabled: true } });
    expect((await hosted({ store }).call(OWNER, "GET", "beacon")).body).toMatchObject({ systemRunsOn: false });
  });
});

// ---- L4-P3 (owner 2026-11-17), DEC 254zzz73: ALLOWING and withdrawing need a live company owner or admin, and no step-up -----------------------------------------------------------------------
describe("allowing needs a live company owner or admin and no step-up (the setup PUT)", () => {
  const nothingDone = async (w: ReturnType<typeof hosted>) => { await nothingWritten(w); expect(w.audited).toEqual([]); expect(w.transacts).toEqual([]); };

  it("a signed-in owner or admin allows the runs with no step-up; the consent's audit record names the role and no factor", async () => {
    for (const [person, basis] of [[OWNER, "company-owner"], [ADMIN, "company-admin"]] as const) {
      const w = hosted();
      const answer = await setup(w, person);
      expect(answer.status, person).toBe(200);
      expect(answer.body).toMatchObject({ enabled: true, systemRunsOn: true });
      const consent = w.audited.find((event) => event.action === "system_runs.consent_set")!;
      expect(consent.details).toMatchObject({ on: true, basis });
      expect(consent.details).not.toHaveProperty("stepUp");
    }
  });

  // MUTANT S3: the role check is dropped from allowing.
  it("a maintainer, a member and a reader are refused for their role and nothing is written, recorded or transacted", async () => {
    for (const person of [MAINTAINER, MEMBER, VIEWER]) {
      const w = hosted();
      const answer = await setup(w, person);
      expect(answer.status, person).toBe(403);
      expect(errorOf(answer).code, person).toBe("FORBIDDEN");
      await nothingDone(w);
    }
  });

  it("an owner of another company cannot allow this company's runs: their project is not found here, and nothing changes", async () => {
    const w = hosted();
    expect(await setup(w, OWNER_B)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    await nothingDone(w);
  });

  // MUTANT S4: the ceiling check is dropped.
  it("with the ceiling off the answer is 'unavailable'", async () => {
    const w = hosted({ ceiling: false });
    expect(errorOf(await setup(w, OWNER)).code).toBe("NOT_AVAILABLE_HERE");
    await nothingDone(w);
  });

  it("an owner and an admin withdraw it", async () => {
    for (const person of [OWNER, ADMIN]) {
      const w = hosted({ consent: true });
      const answer = await setup(w, person, { on: false, allowSystemRuns: false });
      expect(answer.status, person).toBe(200);
      expect(answer.body).toMatchObject({ enabled: false, systemRunsOn: false });
      expect((await consentOf(w.store)).enabled).toBe(false);
      expect(w.audited.find((event) => event.action === "system_runs.consent_set")!.details).toMatchObject({ on: false });
    }
  });

  // MUTANT S6: the withdrawal's role check is dropped.
  it("a maintainer, a member and a reader cannot withdraw (403) and nothing changes", async () => {
    for (const person of [MAINTAINER, MEMBER, VIEWER]) {
      const w = hosted({ consent: true });
      const answer = await setup(w, person, { on: false, allowSystemRuns: false });
      expect(answer.status, person).toBe(403);
      expect((await consentOf(w.store)).enabled).toBe(true);
      expect(w.audited).toEqual([]);
    }
  });

  it("the project's plain switch stays a maintainer's act", async () => {
    const w = hosted({ consent: true });
    expect((await w.call(MAINTAINER, "PUT", "beacon", { requestId: randomUUID(), on: true })).status).toBe(200);
    expect((await w.call(MAINTAINER, "PUT", "beacon", { requestId: randomUUID(), on: false })).status).toBe(200);
  });
});

describe("owner DEC 254zzz91: allowing the company's automatic runs is the Rovara website's own client's act", () => {
  it("the website's client allows them; a CLI or AI-tool client (not webApp) gets 403 with the website words and NOTHING is written or recorded", async () => {
    const web = hosted();
    expect((await setup(web, OWNER)).status).toBe(200);
    expect((await consentOf(web.store)).enabled).toBe(true);
    for (const person of [OWNER, ADMIN]) {
      const w = hosted({ webApp: false });
      const answer = await setup(w, person);
      expect(answer.status).toBe(403);
      expect(errorOf(answer)).toEqual({ code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE });
      await nothingWritten(w);
      expect(w.audited).toEqual([]);
    }
  });

  it("the role and company rules still refuse first, on the website's own client too: a maintainer, a member and another company's owner allow nothing", async () => {
    for (const person of [MAINTAINER, MEMBER, OWNER_B]) {
      const w = hosted({ webApp: true });
      const answer = await setup(w, person);
      expect(answer.status).not.toBe(200);
      expect(errorOf(answer).message).not.toBe(ON_THE_WEBSITE_MESSAGE);
      await nothingWritten(w);
    }
  });

  it("withdrawing them from a CLI or AI-tool client still works (turning off must be easy)", async () => {
    const w = hosted({ consent: true, webApp: false });
    await Promise.resolve();
    const answer = await w.call(OWNER, "PUT", "beacon", { requestId: randomUUID(), on: false, allowSystemRuns: false });
    expect(answer.status).toBe(200);
    expect((await consentOf(w.store)).enabled).toBe(false);
  });
});
