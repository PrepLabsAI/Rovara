// Person erase on the deployed API (row 13.1): off is byte-identical; only an owner or admin of the member company, with a FRESH STEP-UP of a factor Code owns, can erase someone else in that company.
import { describe, expect, it } from "vitest";
import { when, type AuditSink, type OrgId, type OrgRole, type Principal } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { personErasedKey, type PersonEraseDeps } from "../../packages/broker/src/core/people/erase.js";
import { ERASE_NEEDS_ADMIN, ERASE_NOT_YOURSELF, ERASE_ON_A_PAGE, createPersonEraseRoute, type PersonEraseCaller, type PersonEraseRouteOptions } from "../../packages/broker/src/core-host/person-erase-route.js";
import { STEP_UP_WINDOW_NO_ANSWER, freshStepUp } from "../../packages/broker/src/core-host/step-up.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const REQ = "11111111-2222-4333-8444-555555555555";
const TARGET = "dev_mallory";

const principal = (personId: string, companyId: string = A): Principal => ({ companyId, personId, displayName: "x", roles: [], provider: "developer" });
const fresh = (secondsAgo = 30, method = "passkey") => ({ at: new Date(NOW - secondsAgo * 1000).toISOString(), method });

interface Setup { store: MemoryDocumentStore; reads: string[]; erased: string[]; options: PersonEraseRouteOptions }
function setup(overrides: Partial<PersonEraseRouteOptions> & { serving?: boolean; role?: OrgRole; company?: string } = {}): Setup {
  const store = new MemoryDocumentStore();
  const reads: string[] = [];
  const erased: string[] = [];
  const audit: AuditSink = { stage: (event) => [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: event.eventId, entityType: "AUDIT" }, condition: when.absent() }], record: async () => undefined };
  const deps = (): PersonEraseDeps => ({
    store, audit, now: () => NOW, objects: { deleteEveryVersion: async () => true },
    eraseLearning: async (company, person) => { erased.push(`${company}/${person}`); },
  });
  const options: PersonEraseRouteOptions = {
    app: { serving: overrides.serving ?? true },
    companyOf: async () => { reads.push("membership"); return { companyId: overrides.company ?? A, role: overrides.role ?? "admin" }; },
    eraseDeps: (companyId) => { reads.push(`deps:${companyId}`); return deps(); },
    ...overrides,
  };
  return { store, reads, erased, options };
}

const post = (person = TARGET, body: unknown = { requestId: REQ }) => ({ method: "POST", path: `/v1/app/people/${person}/erase`, headers: {}, body: JSON.stringify(body) }) as never;
const caller = (extra: Partial<PersonEraseCaller> = {}): PersonEraseCaller => ({ principal: principal("dev_admin"), stepUp: fresh(), ...extra });
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

  it("an admin with a fresh passkey step-up erases a person of their own company and gets the receipt", async () => {
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

  it("a script token cannot erase", async () => {
    const s = setup();
    expect((await answer(s, post(), caller({ scriptToken: { tokenId: "t1" } })))?.status).toBe(403);
    expect(s.erased).toEqual([]);
  });

  it("refuses without a step-up, with a stale one, a future one, a loose time form, or a federated method (Slack, Google, GitHub)", async () => {
    const cases: Array<PersonEraseCaller["stepUp"]> = [undefined, fresh(601), fresh(-600), { at: "2026-11-15T09:59:30Z", method: "passkey" }, fresh(30, "slack"), fresh(30, "oidc"), fresh(30, "github")];
    for (const stepUp of cases) {
      const s = setup();
      const got = await answer(s, post(), caller({ stepUp }));
      expect(got).toEqual({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: ERASE_ON_A_PAGE } } });
      expect(s.erased).toEqual([]);
    }
  });

  it("a step-up in the body is ignored: only the verified caller's counts", async () => {
    const s = setup();
    expect((await answer(s, post(TARGET, { requestId: REQ, stepUp: fresh() }), caller({ stepUp: undefined })))?.status).toBe(400);
    expect((await answer(s, post(TARGET, { requestId: REQ }), caller({ stepUp: undefined })))?.status).toBe(403);
  });

  it("the company's window can only shorten the default; an unreadable answer refuses with 503", async () => {
    expect((await answer(setup({ stepUpWindowSeconds: async () => 20 })))?.status).toBe(403);
    expect((await answer(setup({ stepUpWindowSeconds: async () => 86_400 }), post(), caller({ stepUp: fresh(900) })))?.status).toBe(403);
    expect((await answer(setup({ stepUpWindowSeconds: async () => 0 })))?.status).toBe(403);
    expect((await answer(setup({ stepUpWindowSeconds: async () => 60 })))?.status).toBe(200);
    for (const bad of [async () => { throw new Error("x"); }, async () => "60", async () => 1.5, async () => -1]) {
      const got = await answer(setup({ stepUpWindowSeconds: bad }));
      expect(got).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: STEP_UP_WINDOW_NO_ANSWER } } });
    }
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

describe("freshStepUp (the decision routes' contract)", () => {
  it("accepts each of Code's own factors inside the window and refuses at the exact edge", async () => {
    for (const method of ["email_code", "passkey", "company_reauth"]) await expect(freshStepUp({ stepUp: fresh(30, method) }, undefined, NOW, "x")).resolves.toMatchObject({ method });
    await expect(freshStepUp({ stepUp: fresh(30) }, async () => 29, NOW, "x")).rejects.toThrow();
    await expect(freshStepUp({ stepUp: fresh(30) }, async () => 30, NOW, "x")).resolves.toBeDefined();
  });

  it("a zero window refuses even a step-up made this very moment; an answer above a day is no answer (503)", async () => {
    await expect(freshStepUp({ stepUp: fresh(0) }, async () => 0, NOW, "x")).rejects.toThrow(/x/u);
    await expect(freshStepUp({ stepUp: fresh(0) }, async () => 86_401, NOW, "x")).rejects.toThrow(STEP_UP_WINDOW_NO_ANSWER);
  });

  it("does not ask the company rules service when there is no step-up", async () => {
    let asked = false;
    await expect(freshStepUp({}, async () => { asked = true; return 600; }, NOW, "x")).rejects.toThrow();
    expect(asked).toBe(false);
  });
});
