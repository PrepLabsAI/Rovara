// L4-JA7 (journey audit B7): the hosted twin of the laptop's two "knowledge stays in Rovara" switches. The company's switch is an owner's or admin's; a project's is its admin's (maintainer) or a company owner's or admin's
// (the laptop's rule, decision 46b, and the lessons API's `mayChange`). The company comes only from live membership, a script token reads and sets nothing, every change is audited BEFORE the write, two companies keep their
// own rows, the rows are the very ones the knowledge gate and the wiki tools gate read, and refusals are fixed words.
import { readFileSync } from "node:fs";
import { KNOWLEDGE_STAYS_SENTENCE, type AuditEvent, type AuditSink, type DocumentStore, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { KNOWLEDGE_SWITCH_COMPANY_PATH, COMPANY_SWITCH_NEEDS_ADMIN, ON_THE_WEBSITE, PROJECT_SWITCH_NEEDS_ADMIN, createKnowledgeSwitchApi, isKnowledgeSwitchPath, type KnowledgeSwitchCaller } from "../../packages/broker/src/core-host/knowledge-switch-api.js";
import { DocumentLocalToolsSettings, documentLearningSettings } from "../../packages/broker/src/lessons/document-settings.js";
import { localToolsGate, wikiToolsGate } from "../../packages/broker/src/lessons/local-tools.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

setLearnedLessonsGate(() => true);

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const now = (): number => 1_800_000_000_000;
/** The words of a refusal without its code prefix ("" when it does not refuse). */
const messageOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return ""; } catch (error) { return error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : ""; } };

// People: who is in which company with which role, and who has which project role.
const members: Record<string, { companyId: OrgId; role: OrgRole }> = {
  ownerA: { companyId: A, role: "owner" }, adminA: { companyId: A, role: "admin" }, maintA: { companyId: A, role: "member" }, devA: { companyId: A, role: "member" }, strangerA: { companyId: A, role: "member" },
  ownerB: { companyId: B, role: "owner" }, maintB: { companyId: B, role: "member" },
};
const projectRoles: Record<string, ProjectRole> = { [`${A}/payments/maintA`]: "maintainer", [`${A}/payments/devA`]: "contributor", [`${B}/payments/maintB`]: "maintainer" };
const projects = new Set([`${A}/payments`, `${A}/ledger`, `${B}/payments`, `${B}/only-b`]);

class Ledger implements AuditSink {
  events: AuditEvent[] = [];
  fail = false;
  seenByStore: (() => number) | undefined;
  stage(): never[] { return []; }
  async record(event: AuditEvent): Promise<void> { if (this.fail) throw new Error("ledger down secret"); this.events.push(event); }
}

function world(over: { store?: DocumentStore; companyOf?: Parameters<typeof createKnowledgeSwitchApi>[0]["companyOf"] } = {}) {
  const ledger = new Ledger();
  const inner = new MemoryDocumentStore();
  const writes: Array<{ audited: number; sk: string }> = [];
  // A store that notes how many audit records existed at the moment of each write: the record must come first.
  const store: DocumentStore = over.store ?? new Proxy(inner, { get(target, prop, receiver) {
    if (prop === "put") return async (...args: Parameters<DocumentStore["put"]>) => { writes.push({ audited: ledger.events.length, sk: String((args[0] as { item: { sk: string } }).item.sk) }); return await target.put(...args); };
    const value = Reflect.get(target, prop, receiver) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } });
  const api = createKnowledgeSwitchApi({
    store, audit: ledger, now,
    companyOf: over.companyOf ?? (async (caller) => members[caller.personId]),
    projectExists: async (companyId, project) => projects.has(`${companyId}/${project}`),
    projectRole: async (companyId, project, personId) => projectRoles[`${companyId}/${project}/${personId}`],
  });
  return { api, ledger, store: inner, writes, localTools: new DocumentLocalToolsSettings(inner) };
}
type World = ReturnType<typeof world>;
const call = (w: World, method: string, path: string, caller: KnowledgeSwitchCaller, body?: unknown) =>
  w.api.answer({ method, path, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, caller);
const company = (w: World, method: "GET" | "PUT", who: string, body?: unknown) => call(w, method, KNOWLEDGE_SWITCH_COMPANY_PATH, { personId: who, webApp: true }, body);
const project = (w: World, method: "GET" | "PUT", who: string, name = "payments", body?: unknown) => call(w, method, `/v1/dev/projects/${name}/lessons/local-tools`, { personId: who, webApp: true }, body);

describe("the company's switch: Knowledge stays in Rovara", () => {

  it("only an owner or admin reads or sets it: a member, a project admin and a developer are refused in fixed words and nothing is written", async () => {
    const w = world();
    for (const who of ["maintA", "devA", "strangerA"]) {
      await expect(company(w, "GET", who), who).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(company(w, "PUT", who, { stays: true }), who).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await messageOf(company(w, "PUT", who, { stays: true }))).toBe(COMPANY_SWITCH_NEEDS_ADMIN);
    }
    expect(await w.localTools.readCompany(A)).toBe(false);
    expect(w.writes).toEqual([]);
    expect(w.ledger.events).toEqual([]);
  });

  it("no record, no change: a ledger that cannot take the record leaves the row as it was, with fixed words and no cause", async () => {
    const w = world();
    w.ledger.fail = true;
    await expect(company(w, "PUT", "ownerA", { stays: true })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await messageOf(company(w, "PUT", "ownerA", { stays: true }))).not.toContain("secret");
    expect(await w.localTools.readCompany(A)).toBe(false);
    expect(w.writes).toEqual([]);
  });

  it("takes exactly { stays: boolean } and answers only GET and PUT on exactly this path", async () => {
    const w = world();
    for (const body of ["", "not json", "{}", { stays: "yes" }, { stays: 1 }, { stays: true, company: B }, { enabled: true }, [], null]) {
      await expect(company(w, "PUT", "ownerA", body), JSON.stringify(body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    await expect(call(w, "POST", KNOWLEDGE_SWITCH_COMPANY_PATH, { personId: "ownerA", webApp: true }, { stays: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(w, "DELETE", KNOWLEDGE_SWITCH_COMPANY_PATH, { personId: "ownerA", webApp: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(w, "GET", `${KNOWLEDGE_SWITCH_COMPANY_PATH}/${B}`, { personId: "ownerA", webApp: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes).toEqual([]);
  });
});

describe("a project's switch: local coding tools can fetch lessons", () => {

  it("a developer on the project reads it but cannot change it; a member with no part in the project is told there is no such project", async () => {
    const w = world();
    expect(await project(w, "GET", "devA")).toMatchObject({ canChange: false });
    await expect(project(w, "PUT", "devA", "payments", { enabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await messageOf(project(w, "PUT", "devA", "payments", { enabled: false }))).toBe(PROJECT_SWITCH_NEEDS_ADMIN);
    for (const method of ["GET", "PUT"] as const) await expect(project(w, method, "strangerA", "payments", { enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes).toEqual([]);
    expect(await w.localTools.read(A, "payments")).toEqual({ companyStays: false });
  });

  it("a project the company does not have, another company's project, and a bad name are all the same 'No such project.'", async () => {
    const w = world();
    for (const name of ["nothing", "only-b", "a%20b", "%E0%A4%A", "x".repeat(300)]) {
      await expect(project(w, "GET", "ownerA", name), name).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await messageOf(project(w, "GET", "ownerA", name)), name).toBe("No such project.");
      await expect(project(w, "PUT", "ownerA", name, { enabled: false }), name).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(w.writes).toEqual([]);
  });

  it("is audited BEFORE the write, with the project's scope and the new value; a ledger that fails changes nothing", async () => {
    const w = world();
    await project(w, "PUT", "maintA", "payments", { enabled: false });
    expect(w.writes).toEqual([{ audited: 1, sk: "LESSONSET#LOCALTOOLS" }]);
    expect(w.ledger.events[0]).toMatchObject({ companyId: A, action: "lesson.local_tools_switched", details: { scope: "project", enabled: false } });
    expect(JSON.stringify(w.ledger.events[0])).not.toContain("payments");
    const f = world();
    f.ledger.fail = true;
    await expect(project(f, "PUT", "maintA", "payments", { enabled: false })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await f.localTools.read(A, "payments")).toEqual({ companyStays: false });
  });

  it("the company's switch closes every project and the state names it; the project's own choice is kept underneath", async () => {
    const w = world();
    await project(w, "PUT", "maintA", "payments", { enabled: true });
    await company(w, "PUT", "ownerA", { stays: true });
    expect(await project(w, "GET", "devA")).toEqual({ enabled: false, own: true, reason: "company_stays", preset: "standard", companyStays: true, canChange: false });
    await company(w, "PUT", "ownerA", { stays: false });
    expect(await project(w, "GET", "devA")).toMatchObject({ enabled: true, own: true });
  });
});

describe("the website's own client only (owner DEC 254zzz99)", () => {
  const nonWeb: KnowledgeSwitchCaller[] = [{ personId: "ownerA" }, { personId: "ownerA", webApp: false }];
  it("a full-access caller that is not the web app gets the fixed 'Do this on the Rovara website' words on both PUTs, before anything is read, audited or written", async () => {
    const w = world();
    for (const caller of nonWeb) {
      await expect(call(w, "PUT", KNOWLEDGE_SWITCH_COMPANY_PATH, caller, { stays: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await messageOf(call(w, "PUT", KNOWLEDGE_SWITCH_COMPANY_PATH, caller, { stays: true }))).toBe(ON_THE_WEBSITE);
      expect(await messageOf(call(w, "PUT", "/v1/dev/projects/payments/lessons/local-tools", caller, { enabled: false }))).toBe(ON_THE_WEBSITE);
      // Even a bad body or a project that does not exist is the website words first: nothing about the request is looked at.
      expect(await messageOf(call(w, "PUT", "/v1/dev/projects/nothing/lessons/local-tools", caller, "garbage"))).toBe(ON_THE_WEBSITE);
    }
    expect(w.writes).toEqual([]);
    expect(w.ledger.events).toEqual([]);
    expect(await w.localTools.readCompany(A)).toBe(false);
    expect(ON_THE_WEBSITE).toBe("Do this on the Rovara website: the command line and AI tools cannot make this change.");
  });
});

describe("two companies keep their own", () => {
  it("the same project name in two companies is two switches, and an owner never reaches the other company by any word in the request", async () => {
    const w = world();
    await project(w, "PUT", "maintA", "payments", { enabled: false });
    expect(await w.localTools.read(A, "payments")).toEqual({ projectOn: false, companyStays: false });
    expect(await w.localTools.read(B, "payments")).toEqual({ companyStays: false });
    expect(await project(w, "GET", "maintB")).toMatchObject({ enabled: true });
    // B's owner sets the company switch; A is not touched, and A's owner still reads A's own.
    await company(w, "PUT", "ownerB", { stays: true });
    expect(await w.localTools.readCompany(A)).toBe(false);
    expect(await w.localTools.readCompany(B)).toBe(true);
    expect(await company(w, "GET", "ownerA")).toEqual({ stays: false });
    expect(await project(w, "GET", "maintA")).toMatchObject({ companyStays: false });
    // A's project admin is nobody in B: B's project is "No such project." for them (A's catalog does not have it).
    await expect(project(w, "GET", "maintA", "only-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Every written row sits under the member company's own partition.
    expect(w.writes.map((row) => row.sk).sort()).toEqual(["LESSONSET#COMPANYSTAY", "LESSONSET#LOCALTOOLS"]);
  });

  it("a person who is in no company, or whose membership read fails or is malformed, is told to sign in again and nothing is read or written", async () => {
    for (const companyOf of [async () => undefined, async () => ({ companyId: "not-a-company", role: "owner" as const }), async () => ({ companyId: A, role: "root" as never }), async () => { throw new Error("down"); }, async () => null as never]) {
      const w = world({ companyOf });
      await expect(company(w, "GET", "ownerA")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(company(w, "PUT", "ownerA", { stays: true })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(project(w, "GET", "ownerA")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(project(w, "PUT", "ownerA", "payments", { enabled: false })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(w.writes).toEqual([]);
    }
  });
});

describe("a script token reads and sets nothing (a tool must never change its own gate)", () => {
  it("is refused on all four routes before any read or write", async () => {
    const w = world();
    const token = { personId: "ownerA", webApp: true, scriptToken: { tokenId: "t" } };
    for (const [method, path, body] of [["GET", KNOWLEDGE_SWITCH_COMPANY_PATH], ["PUT", KNOWLEDGE_SWITCH_COMPANY_PATH, { stays: true }], ["GET", "/v1/dev/projects/payments/lessons/local-tools"], ["PUT", "/v1/dev/projects/payments/lessons/local-tools", { enabled: false }]] as const) {
      await expect(call(w, method, path, token, body), `${method} ${path}`).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(w.writes).toEqual([]);
    expect(w.ledger.events).toEqual([]);
  });
});

describe("faults are fixed words", () => {
  it("a store that fails, a store that cannot be made and a stored value that is not valid never leak their cause", async () => {
    const secret = new Error("secret table name");
    const broken = { get: async () => { throw secret; }, put: async () => { throw secret; }, delete: async () => { throw secret; }, query: async () => { throw secret; }, transact: async () => { throw secret; } } as unknown as DocumentStore;
    const w = world({ store: broken });
    for (const run of [() => company(w, "GET", "ownerA"), () => company(w, "PUT", "ownerA", { stays: true }), () => project(w, "GET", "ownerA"), () => project(w, "PUT", "ownerA", "payments", { enabled: false })]) {
      await expect(run()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(await messageOf(run())).not.toContain("secret");
    }
    const late = createKnowledgeSwitchApi({ store: async () => { throw secret; }, audit: new Ledger(), now, companyOf: async () => ({ companyId: A, role: "owner" }), projectExists: async () => true, projectRole: async () => undefined });
    expect(await messageOf(late.answer({ method: "GET", path: KNOWLEDGE_SWITCH_COMPANY_PATH }, { personId: "x" }))).not.toContain("secret");
    // A stored value that is not a boolean is not "unset": the read refuses (the gates fail closed on the same row).
    const bad = world();
    await bad.store.put({ item: { pk: "x", sk: "y" } }).catch(() => undefined);
    const probe = createKnowledgeSwitchApi({ store: { ...(bad.store as object), get: async () => ({ stays: "yes" }) } as unknown as DocumentStore, audit: new Ledger(), now, companyOf: async () => ({ companyId: A, role: "owner" }), projectExists: async () => true, projectRole: async () => undefined });
    await expect(probe.answer({ method: "GET", path: KNOWLEDGE_SWITCH_COMPANY_PATH }, { personId: "x" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("a project role read that fails is no role (the person is not on the project), never a grant", async () => {
    const w = world();
    const api = createKnowledgeSwitchApi({ store: w.store, audit: w.ledger, now, companyOf: async () => ({ companyId: A, role: "member" }), projectExists: async () => true, projectRole: async () => { throw new Error("down"); } });
    await expect(api.answer({ method: "PUT", path: "/v1/dev/projects/payments/lessons/local-tools", body: JSON.stringify({ enabled: false }) }, { personId: "maintA", webApp: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.ledger.events).toEqual([]);
  });

  it("a catalog read that fails is 'unavailable', not 'no such project' and not a write", async () => {
    const w = world();
    const api = createKnowledgeSwitchApi({ store: w.store, audit: w.ledger, now, companyOf: async () => ({ companyId: A, role: "owner" }), projectExists: async () => { throw new Error("down"); }, projectRole: async () => undefined });
    await expect(api.answer({ method: "PUT", path: "/v1/dev/projects/payments/lessons/local-tools", body: JSON.stringify({ enabled: false }) }, { personId: "x", webApp: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.ledger.events).toEqual([]);
  });
});

describe("one stored value, read by every gate", () => {
  it("what the API sets is what the knowledge gate (AK3's localToolsGate) and the wiki tools gate (#1033) read on their very next call", async () => {
    const w = world();
    const gates = { localTools: new DocumentLocalToolsSettings(w.store), settings: documentLearningSettings(w.store) };
    const key = { workspaceId: A, project: "payments" };
    expect(await localToolsGate(gates, key)).toMatchObject({ kind: "on" });
    expect(await wikiToolsGate(gates, key)).toBeUndefined();
    await project(w, "PUT", "maintA", "payments", { enabled: false });
    expect(await localToolsGate(gates, key)).toEqual({ kind: "off", reason: "project_setting" });
    expect(await wikiToolsGate(gates, key)).toBeUndefined();
    await project(w, "PUT", "maintA", "payments", { enabled: true });
    await company(w, "PUT", "ownerA", { stays: true });
    expect(await localToolsGate(gates, key)).toEqual({ kind: "off", reason: "company_stays" });
    expect(await wikiToolsGate(gates, key)).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
    // Another company's gate is untouched.
    expect(await localToolsGate(gates, { workspaceId: B, project: "payments" })).toMatchObject({ kind: "on" });
    expect(await wikiToolsGate(gates, { workspaceId: B, project: "payments" })).toBeUndefined();
    await company(w, "PUT", "ownerA", { stays: false });
    expect(await wikiToolsGate(gates, key)).toBeUndefined();
  });

  it("the setters are the laptop's own functions, and the stored items are the ones DocumentLocalToolsSettings keeps", () => {
    const source = readFileSync("packages/broker/src/core-host/knowledge-switch-api.ts", "utf8");
    expect(source).toContain("setCompanyLocalTools(deps,");
    expect(source).toContain("setProjectLocalTools(deps,");
    expect(source).toContain("readLocalToolsState(");
    expect(source).toContain("new DocumentLocalToolsSettings(store)");
  });
});

describe("the route table and the router", () => {
  it("has exactly these four rows, all full access, and the path test matches exactly these paths", () => {
    expect(DEV_ROUTES.filter((route) => route.path.endsWith("/lessons/local-tools")).map((route) => `${route.method} ${route.path} ${route.requires}`).sort()).toEqual([
      "GET /v1/dev/company/lessons/local-tools full", "GET /v1/dev/projects/{project}/lessons/local-tools full",
      "PUT /v1/dev/company/lessons/local-tools full", "PUT /v1/dev/projects/{project}/lessons/local-tools full",
    ]);
    expect(isKnowledgeSwitchPath(KNOWLEDGE_SWITCH_COMPANY_PATH)).toBe(true);
    expect(isKnowledgeSwitchPath("/v1/dev/projects/payments/lessons/local-tools")).toBe(true);
    for (const other of ["/v1/dev/company/lessons/local-tools/", "/v1/dev/company/lessons", "/v1/dev/projects/p/lessons/local-tools/x", "/v1/dev/projects//lessons/local-tools", "/v1/dev/projects/a/b/lessons/local-tools", "/v1/dev/me/lessons/local-tools", "/v1/app/org/lessons/local-tools"]) expect(isKnowledgeSwitchPath(other), other).toBe(false);
  });
});
