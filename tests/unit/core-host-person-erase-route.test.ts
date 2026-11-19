// Person erase on the deployed API (row 13.1): off is byte-identical; only an owner or admin of the member company can erase someone else in that company (DEC 254zzz73: no step-up).
import { describe, expect, it } from "vitest";
import { ON_THE_WEBSITE_MESSAGE, when, type AuditSink, type OrgId, type OrgRole, type Principal } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { personErasedKey, type PersonEraseDeps } from "../../packages/broker/src/core/people/erase.js";
import { ERASE_NEEDS_ADMIN, ERASE_NOT_YOURSELF, ERASE_REMOVE_FIRST, createPersonEraseRoute, type PersonEraseCaller, type PersonEraseRouteOptions } from "../../packages/broker/src/core-host/person-erase-route.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const REQ = "11111111-2222-4333-8444-555555555555";
const TARGET = "dev_mallory";

const principal = (personId: string, companyId: string = A): Principal => ({ companyId, personId, displayName: "x", roles: [], provider: "developer" });

interface Setup { store: MemoryDocumentStore; reads: string[]; erased: string[]; options: PersonEraseRouteOptions }
function setup(overrides: Partial<PersonEraseRouteOptions> & { serving?: boolean; role?: OrgRole; company?: string } = {}): Setup {
  const store = new MemoryDocumentStore();
  const reads: string[] = [];
  const erased: string[] = [];
  const audit: AuditSink = { stage: (event) => [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: event.eventId, entityType: "AUDIT" }, condition: when.absent() }], record: async () => undefined };
  const deps = (): PersonEraseDeps => ({
    store, audit, now: () => NOW, objects: { deleteEveryVersion: async () => true },
    eraseLearning: async (company, person) => { erased.push(`${company}/${person}`); },
    eraseWiki: async () => undefined,
  });
  const options: PersonEraseRouteOptions = {
    app: { serving: overrides.serving ?? true },
    companyOf: async () => { reads.push("membership"); return { companyId: overrides.company ?? A, role: overrides.role ?? "admin" }; },
    standing: async () => "former",
    eraseDeps: (companyId) => { reads.push(`deps:${companyId}`); return deps(); },
    ...overrides,
  };
  return { store, reads, erased, options };
}

const post = (person = TARGET, body: unknown = { requestId: REQ }) => ({ method: "POST", path: `/v1/app/people/${person}/erase`, headers: {}, body: JSON.stringify(body) }) as never;
// Owner DEC 254zzz91: the Rovara website's own client by default; a test that is not one says so.
const caller = (extra: Partial<PersonEraseCaller> = {}): PersonEraseCaller => ({ principal: principal("dev_admin"), webApp: true, ...extra });
const answer = async (s: Setup, request = post(), who = caller()) => {
  const response = await createPersonEraseRoute(s.options).route(request, who);
  return response === undefined ? undefined : { status: response.statusCode, body: JSON.parse(response.body ?? "{}") as { receipt?: Record<string, unknown>; error?: unknown } };
};

describe("person erase route", () => {
  it("off: answers nothing and reads nothing", async () => {
    const s = setup({ serving: false });
    expect(await answer(s)).toBeUndefined();
    expect(s.reads).toEqual([]);
  });

  it("is not its path or not POST: answers nothing", async () => {
    const s = setup();
    expect(await createPersonEraseRoute(s.options).route({ method: "GET", path: `/v1/app/people/${TARGET}/erase`, headers: {} }, caller())).toBeUndefined();
    expect(await createPersonEraseRoute(s.options).route({ method: "POST", path: "/v1/app/people/x", headers: {} }, caller())).toBeUndefined();
    expect(s.reads).toEqual([]);
  });

  it("a signed-in admin with no step-up erases a person of their own company and gets the receipt", async () => {
    const s = setup();
    const got = await answer(s);
    expect(got?.status).toBe(200);
    expect(got?.body.receipt).toMatchObject({ personId: TARGET, alreadyErased: false, evidence: "done" });
    expect(await s.store.get(personErasedKey(A, TARGET))).toMatchObject({ by: "dev_admin", companyId: A });
    expect(s.erased).toEqual([`${A}/${TARGET}`]);
  });

  it("an owner may too; a member may not", async () => {
    expect((await answer(setup({ role: "owner" })))?.status).toBe(200);
    const member = setup({ role: "member" });
    expect(await answer(member)).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ERASE_NEEDS_ADMIN } } });
    expect(member.erased).toEqual([]);
  });

  it("the company is membership's, never the principal's claim: a principal of another company is a sign-in refusal", async () => {
    const s = setup();
    expect((await answer(s, post(), caller({ principal: principal("dev_admin", B) })))?.status).toBe(401);
    expect(s.erased).toEqual([]);
  });

  it("a membership reader that throws or answers junk is a sign-in refusal, never the install's company", async () => {
    for (const companyOf of [async () => { throw new Error("down"); }, async () => undefined, async () => ({ companyId: "acme", role: "admin" as OrgRole }), async () => ({ companyId: A, role: "root" as never })]) {
      const s = setup({ companyOf });
      expect((await answer(s))?.status).toBe(401);
      expect(s.erased).toEqual([]);
    }
  });

  it("owner DEC 254zzz91: a CLI or AI-tool client (not the Rovara website's own) is refused with the website words, and nothing is erased or read past the role", async () => {
    const s = setup();
    const { webApp: _web, ...cli } = caller();
    void _web;
    expect(await answer(s, post(), cli)).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } } });
    expect(s.erased).toEqual([]);
    expect(await s.store.get(personErasedKey(A, TARGET))).toBeUndefined();
    // The website's own client erases the same person.
    expect((await answer(setup(), post(), caller()))?.status).toBe(200);
  });

  it("a script token cannot erase", async () => {
    const s = setup();
    expect((await answer(s, post(), caller({ scriptToken: { tokenId: "t1" } })))?.status).toBe(403);
    expect(s.erased).toEqual([]);
  });

  it("an admin of ANOTHER company never reaches this company's people: the membership's company decides, and the person reads as not found there", async () => {
    // The caller is B's admin (membership says B); the person is a former member of A only.
    const s = setup({ company: B, standing: async (companyId) => (companyId === A ? "former" : "unknown") });
    const got = await answer(s, post(), caller({ principal: principal("dev_admin", B) }));
    expect(got).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    expect(s.erased).toEqual([]);
    expect(await s.store.get(personErasedKey(A, TARGET))).toBeUndefined();
  });

  it("only a person the company removed is erased: a member is told to remove them first, a stranger is not found (no probing), an unreadable answer refuses", async () => {
    const member = setup({ standing: async () => "member" });
    expect(await answer(member)).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ERASE_REMOVE_FIRST } } });
    const stranger = setup({ standing: async () => "unknown" });
    expect(await answer(stranger)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    for (const standing of [async () => { throw new Error(TARGET); }, async () => "junk" as never]) {
      const s = setup({ standing });
      const got = await answer(s);
      expect(got?.status).toBe(503);
      expect(JSON.stringify(got)).not.toContain(TARGET);
    }
    for (const s of [member, stranger]) { expect(s.erased).toEqual([]); expect(await s.store.get(personErasedKey(A, TARGET))).toBeUndefined(); }
  });

  it("nobody erases themselves here", async () => {
    const s = setup();
    expect(await answer(s, post("dev_admin"))).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ERASE_NOT_YOURSELF } } });
  });

  it("a body with any other key, no request id or a non-UUID is refused without echoing it; a person id that is not plain is not found", async () => {
    const s = setup();
    for (const body of [{}, { requestId: "x" }, { requestId: REQ, personId: "dev_other" }]) {
      const got = await answer(s, post(TARGET, body));
      expect(got?.status).toBe(400);
      expect(JSON.stringify(got)).not.toContain("dev_other");
    }
    expect((await answer(s, post("a%23b")))?.status).toBe(404);
    expect((await answer(s, post("%E0%A4%A")))?.status).toBe(404);
    expect(s.erased).toEqual([]);
  });

  it("an engine fault is answered in fixed words, naming nobody", async () => {
    const s = setup({ eraseDeps: () => { throw new Error(`boom ${TARGET}`); } });
    const got = await answer(s);
    expect(got?.status).toBe(503);
    expect(JSON.stringify(got)).not.toContain(TARGET);
  });
});
