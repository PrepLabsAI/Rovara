// L4-P3 (owner 2026-11-17): the company's ONE control over Rovara's automatic runs, `GET/PUT /v1/app/company/system-runs`. A live company owner or admin reads it, ALLOWS it and WITHDRAWS it (DEC 254zzz73: no step-up either
// way; the live role and, to allow, the operator's ceiling decide). Withdrawing stops future runs at once (the effective gate is read on every use) and leaves the projects' own switches as they are.
// Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ON_THE_WEBSITE_MESSAGE, SYSTEM_RUNS_CONSENT_AUDIT, SystemRunsViewSchema, queryAll, type AuditEvent, type OrgId, type OrgRole } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { isSystemRunsPath, routeHostedSystemRuns } from "../../packages/broker/src/core-host/system-runs-routes.js";
import { SYSTEM_RUNS_WORDS } from "../../packages/broker/src/core/system-runs/consent-control.js";
import { effectiveSystemRunsGate, readSystemRunsConsentRow, systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { upkeepSettingsKey } from "../../packages/broker/src/core/upkeep/keys.js";
import { readUpkeepSetting } from "../../packages/broker/src/core/upkeep/settings.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const PERSON = "p1".repeat(32);
type Body = Record<string, any>;
interface Options { webApp?: boolean; store?: MemoryDocumentStore; company?: OrgId; role?: OrgRole; ceiling?: boolean; consent?: boolean; audit?: (event: AuditEvent, store: MemoryDocumentStore) => Promise<void>; transact?: "fail" }

function control(options: Options = {}) {
  const base = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const transacts: number[] = [];
  const reads: string[] = [];
  const store = new Proxy(base, {
    get: (target, key) => {
      if (key === "get") return async (...args: unknown[]) => { reads.push("get"); return (target.get as (...a: unknown[]) => Promise<unknown>).apply(target, args); };
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "transact") return async (items: readonly unknown[]) => { transacts.push(items.length); return options.transact === "fail" ? { applied: false, reason: "condition_failed", failed: [0] } : (target.transact.bind(target))(items as never); };
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const audited: AuditEvent[] = [];
  const audit = { stage: () => [], record: async (event: AuditEvent) => { if (options.audit !== undefined) await options.audit(event, base); audited.push(event); } };
  const flow = { store } as never;
  // Each request is one second after the one before (the first is T0), as a real clock would be: the audit ids differ by the row they replace.
  let calls = 0;
  const call = async (method: string, body?: unknown, who: { role?: OrgRole; path?: string; raw?: string } = {}) => {
    const path = who.path ?? "/v1/app/company/system-runs";
    calls += 1;
    const answer = await routeHostedSystemRuns({
      request: { method, path, headers: {}, body: who.raw ?? (body === undefined ? "" : JSON.stringify(body)) }, path,
      principal: { companyId: company, personId: PERSON, displayName: "x", roles: [], provider: "test" }, companyId: company, flow, role: who.role ?? options.role ?? "owner",
      ...(options.ceiling === false ? {} : { available: () => true }), audit, now: () => T0 + (calls - 1) * 1000,
      // Owner DEC 254zzz91: the Rovara website's own client by default.
      webApp: options.webApp ?? true,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  const put = (allowed: boolean, who: { role?: OrgRole } = {}, extra: Record<string, unknown> = {}) => call("PUT", { requestId: randomUUID(), allowed, ...extra }, who);
  if (options.consent === true) void base.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: new Date(T0 - 1000).toISOString(), requestId: randomUUID() } });
  return { store: base, company, audited, call, put, transacts, reads };
}
const errorOf = (answer: { body: Body }): { code: string; message: string } => answer.body["error"] as { code: string; message: string };
const consentOf = (store: MemoryDocumentStore, company: OrgId = COMPANY_A) => readSystemRunsConsentRow({ store, companyId: company });
type World = ReturnType<typeof control>;
const nothingDone = async (w: World) => { expect((await consentOf(w.store, w.company)).enabled).toBe(false); expect(w.audited).toEqual([]); expect(w.transacts).toEqual([]); };

describe("the path", () => {
  it("is GET and PUT on /v1/app/company/system-runs only", () => {
    expect(isSystemRunsPath("/v1/app/company/system-runs", "GET")).toBe(true);
    expect(isSystemRunsPath("/v1/app/company/system-runs", "PUT")).toBe(true);
    for (const [path, method] of [["/v1/app/company/system-runs", "POST"], ["/v1/app/company/system-runs", "DELETE"], ["/v1/app/company/system-runs/x", "GET"], ["/v1/app/company/system-run", "GET"], ["/v1/app/company", "GET"], ["/v1/app/projects/beacon/system-runs", "GET"]] as const) expect(isSystemRunsPath(path, method), `${method} ${path}`).toBe(false);
  });
});

describe("who may read and change it (a live company owner or admin only)", () => {
  // MUTANT R1: the role check is dropped or widened (a maintainer, a member or a reader reads or changes the company's setting).
  it("an owner and an admin read it; any other role is refused 403 in fixed words, whatever they send", async () => {
    for (const role of ["owner", "admin"] as const) {
      const w = control({ role });
      const answer = await w.call("GET");
      expect(answer.status).toBe(200);
      expect(SystemRunsViewSchema.parse(answer.body)).toEqual({ available: true, allowed: false, systemRunsOn: false });
    }
    for (const role of ["maintainer", "member", "viewer", "billing", "nobody"] as const) {
      const w = control({ role: role as OrgRole, consent: true });
      for (const answer of [await w.call("GET"), await w.put(true), await w.put(false), await w.call("PUT", undefined, { raw: "{not json" })]) {
        expect(answer.status, role).toBe(403);
        expect(errorOf(answer), role).toEqual({ code: "FORBIDDEN", message: SYSTEM_RUNS_WORDS.notAllowed });
      }
      expect((await consentOf(w.store)).enabled, role).toBe(true);
      expect(w.audited, role).toEqual([]);
    }
  });

  it("the answer is exactly the view: nothing else, no ids, no names", async () => {
    const w = control({ consent: true });
    const answer = await w.call("GET");
    expect(Object.keys(answer.body).sort()).toEqual(["allowed", "available", "systemRunsOn"]);
  });

  it("an unknown method or path under the handler is route-not-found", async () => {
    const w = control();
    expect(errorOf(await w.call("POST"))).toEqual({ code: "NOT_FOUND", message: "route not found" });
    expect(errorOf(await w.call("GET", undefined, { path: "/v1/app/company/other" })).code).toBe("NOT_FOUND");
  });
});

describe("allowing needs only the live owner or admin role and the operator's ceiling (DEC 254zzz73: no step-up)", () => {
  // MUTANT C1: the role check is dropped from allowing (a member allows the company's automatic runs).
  it("a signed-in owner or admin allows it with no step-up: the row is the company's own, the audit record names the person and the role, and no factor", async () => {
    for (const role of ["owner", "admin"] as const) {
      const w = control({ role });
      const answer = await w.put(true);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ available: true, allowed: true, systemRunsOn: true });
      const row = await consentOf(w.store);
      expect(row).toMatchObject({ enabled: true, changedAt: new Date(T0).toISOString() });
      expect(w.audited).toHaveLength(1);
      expect(w.audited[0]).toMatchObject({ action: SYSTEM_RUNS_CONSENT_AUDIT, companyId: COMPANY_A, actor: { type: "person", id: PERSON }, subject: { type: "company", id: COMPANY_A }, details: { basis: role === "owner" ? "company-owner" : "company-admin", on: true, previous: "none" } });
      expect(w.audited[0]!.details).not.toHaveProperty("stepUp");
    }
  });

  it("a member, a maintainer or a viewer still cannot allow it: 403 in fixed words, nothing read for the change, written or recorded", async () => {
    for (const role of ["member", "maintainer", "viewer"] as const) {
      const w = control({ role: role as OrgRole });
      const answer = await w.put(true);
      expect(answer.status, role).toBe(403);
      expect(errorOf(answer), role).toEqual({ code: "FORBIDDEN", message: SYSTEM_RUNS_WORDS.notAllowed });
      await nothingDone(w);
      expect(w.reads, role).toEqual([]);
    }
  });

  it("an owner of ANOTHER company allows only their own company's runs, never this one's", async () => {
    const store = new MemoryDocumentStore();
    const other = control({ store, company: COMPANY_B });
    expect((await other.put(true)).status).toBe(200);
    expect((await consentOf(store, COMPANY_A)).enabled).toBe(false);
    expect((await consentOf(store, COMPANY_B)).enabled).toBe(true);
    expect(other.audited.every((event) => event.companyId === COMPANY_B)).toBe(true);
  });

  // MUTANT C3: the body is read (and a bad body answered) before the role check.
  it("an owner's bad body is 400 and nothing is done", async () => {
    const w = control();
    for (const body of [{}, { requestId: "nope", allowed: true }, { requestId: randomUUID() }, { requestId: randomUUID(), allowed: "yes" }, { requestId: randomUUID(), allowed: true, extra: 1 }, []]) {
      const answer = await w.call("PUT", body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(answer).message).toBe("the request is not valid");
    }
    expect((await w.call("PUT", undefined, { raw: "{not json" })).status).toBe(400);
    await nothingDone(w);
  });

  // MUTANT C4: the ceiling check is dropped (an allow is recorded where nothing can run).
  it("with the operator's ceiling off an allow is 'unavailable'", async () => {
    const w = control({ ceiling: false });
    const answer = await w.put(true);
    expect(errorOf(answer)).toEqual({ code: "NOT_AVAILABLE_HERE", message: SYSTEM_RUNS_WORDS.unavailable });
    await nothingDone(w);
  });

  it("the same granting request again changes nothing and records nothing more", async () => {
    const requestId = randomUUID();
    const first = control();
    expect((await first.call("PUT", { requestId, allowed: true })).status).toBe(200);
    const again = control({ store: first.store });
    expect((await again.call("PUT", { requestId, allowed: true })).status).toBe(200);
    expect(again.audited).toEqual([]);
    expect(again.transacts).toEqual([]);
  });
});

describe("withdrawing stops the runs at once", () => {
  it("an owner and an admin withdraw it", async () => {
    for (const role of ["owner", "admin"] as const) {
      const w = control({ consent: true, role });
      const answer = await w.put(false);
      expect(answer.status, role).toBe(200);
      expect(answer.body).toEqual({ available: true, allowed: false, systemRunsOn: false });
      expect((await consentOf(w.store)).enabled).toBe(false);
      expect(w.audited).toHaveLength(1);
      expect(w.audited[0]!.details).toMatchObject({ on: false, previous: new Date(T0 - 1000).toISOString() });
      expect(w.audited[0]!.details).not.toHaveProperty("stepUp");
    }
  });

  // MUTANT W2: a withdrawal is refused while the operator's ceiling is off.
  it("a withdrawal works while the ceiling is off (turning off must always be easy)", async () => {
    const w = control({ consent: true, ceiling: false });
    const answer = await w.put(false);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ available: false, allowed: false, systemRunsOn: false });
    expect((await consentOf(w.store)).enabled).toBe(false);
  });

  // MUTANT W3: the withdrawal does not write the row (the gate then still says on), or writes it without the audit record.
  it("the effective gate is off right after the withdrawal, read on the very next use, with the ceiling still on", async () => {
    const w = control();
    const gate = effectiveSystemRunsGate({ ceiling: () => true, store: w.store, companyId: COMPANY_A });
    expect(await gate.enabled()).toBe(false);
    expect((await w.put(true)).status).toBe(200);
    expect(await gate.enabled()).toBe(true);
    expect((await w.put(false)).status).toBe(200);
    expect(await gate.enabled()).toBe(false);
    // On, off, on again with one request id are three distinct audit records.
    const requestId = randomUUID();
    await w.call("PUT", { requestId, allowed: true });
    await w.call("PUT", { requestId, allowed: false });
    await w.call("PUT", { requestId, allowed: true });
    expect(new Set(w.audited.map((event) => event.eventId)).size).toBe(w.audited.length);
  });

  // MUTANT W4: the withdrawal also switches the projects off (or removes their rows).
  it("the projects keep their own switch exactly as it was (they read as off only while the consent is off)", async () => {
    const w = control({ consent: true });
    const key = upkeepSettingsKey({ orgId: COMPANY_A, project: "beacon" });
    const row = { ...key, entityType: "UPKEEP_SETTINGS", orgId: COMPANY_A, project: "beacon", enabled: true, changedAt: "2026-11-16T00:00:00.000Z", requestId: randomUUID() };
    await w.store.put({ item: row });
    expect((await w.put(false)).status).toBe(200);
    expect(await w.store.get(key)).toEqual(row);
    expect((await readUpkeepSetting({ store: w.store, companyId: COMPANY_A }, "beacon")).enabled).toBe(true);
    // Allowing again brings them back without anyone touching the projects.
    expect((await w.put(true)).status).toBe(200);
    expect(await w.store.get(key)).toEqual(row);
  });

  it("withdrawing when nothing is allowed changes and records nothing", async () => {
    const w = control();
    const answer = await w.put(false);
    expect(answer.body).toEqual({ available: true, allowed: false, systemRunsOn: false });
    await nothingDone(w);
  });
});

describe("the audit record comes first, and the row changes only if it is still the one that was read", () => {
  // MUTANT A1: the row is written before the audit record, or an audit failure still writes.
  it("an audit record that cannot be written changes nothing (allow and withdraw)", async () => {
    const allow = control({ audit: async () => { throw new Error("down"); } });
    const refused = await allow.put(true);
    expect(refused.status).toBe(503);
    expect(errorOf(refused)).toEqual({ code: "AUDIT_UNAVAILABLE", message: SYSTEM_RUNS_WORDS.auditUnavailable });
    expect((await consentOf(allow.store)).enabled).toBe(false);
    const withdraw = control({ consent: true, audit: async () => { throw new Error("down"); } });
    expect((await withdraw.put(false)).status).toBe(503);
    expect((await consentOf(withdraw.store)).enabled).toBe(true);
  });

  it("the audit record is in the sink BEFORE the row exists", async () => {
    let seen: boolean | undefined;
    const w = control({ audit: async (_event, store) => { seen = (await consentOf(store)).enabled; } });
    await w.put(true);
    expect(seen).toBe(false);
  });

  // MUTANT A2: the write is unconditional (a concurrent change between the read and the write is overwritten) or a failed transaction answers success.
  it("a row that changed between the read and the write loses (try again), and a failed transaction writes nothing", async () => {
    const racing = control({ consent: true, audit: async (event, store) => {
      if (event.action === SYSTEM_RUNS_CONSENT_AUDIT) await store.put({ item: { ...systemRunsConsentKey(COMPANY_A), entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY_A, enabled: true, changedAt: "2026-11-17T11:59:58.000Z", requestId: randomUUID() } });
    } });
    const lost = await racing.put(false);
    expect(lost.status).toBe(503);
    expect((await consentOf(racing.store)).enabled).toBe(true);
    const failing = control({ transact: "fail" });
    expect((await failing.put(true)).status).toBe(503);
    expect((await consentOf(failing.store)).enabled).toBe(false);
  });
});

describe("two companies", () => {
  // MUTANT T1: the row is keyed by a shared key or another company's id.
  it("company A's allow and withdrawal touch only A's row; B's owner sees B's own state; a row naming another company is no consent", async () => {
    const store = new MemoryDocumentStore();
    const a = control({ store });
    const b = control({ store, company: COMPANY_B });
    expect((await a.put(true)).status).toBe(200);
    expect((await consentOf(store, COMPANY_A)).enabled).toBe(true);
    expect((await consentOf(store, COMPANY_B)).enabled).toBe(false);
    expect((await b.call("GET")).body).toEqual({ available: true, allowed: false, systemRunsOn: false });
    expect((await b.put(true)).status).toBe(200);
    expect((await a.put(false)).status).toBe(200);
    expect((await consentOf(store, COMPANY_A)).enabled).toBe(false);
    expect((await consentOf(store, COMPANY_B)).enabled).toBe(true);
    expect(await queryAll(store, { pk: `ORG#${COMPANY_B}#SYSTEM_RUNS` })).toHaveLength(1);
    expect(a.audited.every((event) => event.companyId === COMPANY_A)).toBe(true);
    expect(b.audited.every((event) => event.companyId === COMPANY_B)).toBe(true);
    const damaged = new MemoryDocumentStore();
    await damaged.put({ item: { ...systemRunsConsentKey(COMPANY_A), entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY_B, enabled: true } });
    expect((await control({ store: damaged }).call("GET")).body).toMatchObject({ allowed: false, systemRunsOn: false });
  });
});

describe("owner DEC 254zzz91: allowing is the Rovara website's own client's act", () => {
  it("the website's client allows; a CLI or AI-tool client gets 403 with the website words and nothing is done", async () => {
    const web = control();
    expect((await web.put(true)).status).toBe(200);
    expect((await consentOf(web.store)).enabled).toBe(true);
    for (const role of ["owner", "admin"] as const) {
      const w = control({ webApp: false, role });
      const answer = await w.put(true);
      expect(answer.status).toBe(403);
      expect(errorOf(answer)).toEqual({ code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE });
      await nothingDone(w);
    }
  });

  it("a member on the website's client is still refused for the role, not for the client", async () => {
    const w = control({ role: "member" });
    const answer = await w.put(true);
    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).not.toBe(ON_THE_WEBSITE_MESSAGE);
    await nothingDone(w);
  });

  it("withdrawing from a CLI or AI-tool client still works", async () => {
    const w = control({ webApp: false, consent: true });
    await Promise.resolve();
    expect((await w.put(false)).status).toBe(200);
    expect((await consentOf(w.store)).enabled).toBe(false);
  });
});
