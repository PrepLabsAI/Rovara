// #1613: GET/PUT /v1/dev/company/details through the real developer dispatcher, the real membership reader and, for the rename, the real sign-in service's company store
// (company-operator.ts `company-rename`) over the same SDK double. Two companies throughout: the company is always the caller's live membership.
import { describe, expect, it } from "vitest";
import { CompanyDetailsViewSchema, IMPLICIT_COMPANY_ID, NOT_IN_A_COMPANY_MESSAGE } from "@agentx/contracts";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { COMPANY_RENAME_ADMIN_ONLY, COMPANY_RENAME_BODY_INVALID, COMPANY_DETAILS_UNAVAILABLE } from "../../packages/broker/src/aws/company-details-routes.js";
import { CompanySignInStore, companyKey, companyMemberKey } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const PATH = "/v1/dev/company/details";
const OTHER = "e".repeat(64), THIRD = "f".repeat(64), GONE = "c".repeat(64);
type Answer = Record<string, unknown> & { error: { code: string; message: string } };

function world(options: { rename?: boolean } = {}) {
  const h = companyRouteHarness();
  const logs: Array<Record<string, unknown>> = [];
  const store = new CompanySignInStore({ documentClient: h.db, tableName: "SignIn", now: () => Date.parse(TIME) });
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  if (options.rename !== false) {
    h.deps.developer.companyRename = async (input) => {
      const answer = await companyOperator({ store, now: () => Date.parse(TIME), log: (entry) => logs.push(entry) }, { kind: "company-rename", ...input });
      return answer.ok ? { ok: true } : { ok: false, error: answer.error === "not_found" ? "not_found" : "unavailable" };
    };
  }
  const company = (companyId: string, name: string) => h.db.set({ ...companyKey(companyId), entityType: "COMPANY", companyId, name, status: "active", createdAt: TIME, createdBy: "operator" });
  const member = (personId: string, companyId: string, role: "owner" | "admin" | "member", extra: Record<string, unknown> = {}) => {
    const row = { entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME, ...extra };
    h.db.set({ ...membershipKey(personId), ...row });
    h.db.set({ ...companyMemberKey(companyId, personId), ...row, entityType: "COMPANY_MEMBER_VIEW" });
  };
  const signedInAs = (personId: string) => {
    h.db.set({ pk: `SESSION#session-${personId}`, sk: "META", developerId: personId, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: "Someone" });
    h.claims.sub = personId; h.claims.sid = `session-${personId}`;
  };
  company(A, "acme-install"); company(B, "Other Co");
  member(PERSON, A, "owner"); member(OTHER, A, "member"); member(GONE, A, "member", { revokedAt: TIME, revokedBy: PERSON }); member(THIRD, B, "admin");
  signedInAs(PERSON);
  const call = async (method: string, body?: unknown) => {
    const answer = await h.read(PATH, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const nameOf = (companyId: string) => h.db.get(companyKey(companyId).pk, "META")?.["name"];
  const renameLogs = () => h.db.find((item) => item["entityType"] === "COMPANY_LOG" && item["event"] === "company-rename");
  return { h, logs, member, signedInAs, call, nameOf, renameLogs };
}

const viewOf = (body: Answer) => { const { requestId: _r, ...rest } = body; void _r; return CompanyDetailsViewSchema.parse(rest); };

describe("GET /v1/dev/company/details", () => {
  it("shows the caller's company: its name, ID, their role and the people in it now (a removed person and another company's are not counted)", async () => {
    const w = world();
    expect(viewOf((await w.call("GET")).body)).toEqual({ companyId: A, name: "acme-install", role: "owner", members: 2 });
    w.signedInAs(OTHER);
    expect(viewOf((await w.call("GET")).body)).toEqual({ companyId: A, name: "acme-install", role: "member", members: 2 });
    w.signedInAs(THIRD);
    expect(viewOf((await w.call("GET")).body)).toEqual({ companyId: B, name: "Other Co", role: "admin", members: 1 });
  });

  it("tells a person in no company, a removed person, or one still in the built-in company that they are not in one, never that their sign-in ended", async () => {
    const w = world();
    const nobody = "a".repeat(64);
    w.member("b".repeat(64), IMPLICIT_COMPANY_ID, "owner");
    for (const personId of [nobody, GONE, "b".repeat(64)]) {
      w.signedInAs(personId);
      const answer = await w.call("GET");
      expect(answer.status).toBe(403);
      expect(answer.body.error).toEqual({ code: "FORBIDDEN", message: NOT_IN_A_COMPANY_MESSAGE });
      expect(answer.raw).not.toMatch(/sign-in has ended/u);
    }
  });

  it("answers the fixed retry words when the company record does not read, without echoing it", async () => {
    const w = world();
    w.h.db.set({ ...companyKey(A), entityType: "COMPANY", companyId: B, name: "Other Co", status: "active", createdAt: TIME, createdBy: "operator" });
    const answer = await w.call("GET");
    expect(answer.status).toBe(503);
    expect(answer.body.error.message).toBe(COMPANY_DETAILS_UNAVAILABLE);
    expect(answer.raw).not.toContain(B);
  });
});

describe("PUT /v1/dev/company/details", () => {
  it("renames the caller's company for an owner or admin, logs who did it, and every read then shows the new name; the other company is untouched", async () => {
    const w = world();
    const renamed = await w.call("PUT", { name: "  Acme Corp  " });
    expect(renamed.status).toBe(200);
    expect(viewOf(renamed.body)).toEqual({ companyId: A, name: "Acme Corp", role: "owner", members: 2 });
    expect(w.nameOf(A)).toBe("Acme Corp");
    expect(w.nameOf(B)).toBe("Other Co");
    expect(w.renameLogs()).toEqual([expect.objectContaining({ companyId: A, personId: PERSON })]);
    expect(JSON.stringify(w.renameLogs())).not.toContain("Acme");
    expect(JSON.stringify(w.logs)).not.toContain("Acme");
    expect(viewOf((await w.call("GET")).body).name).toBe("Acme Corp");

    w.signedInAs(THIRD);
    expect(viewOf((await w.call("PUT", { name: "Beta Ltd" })).body)).toMatchObject({ companyId: B, name: "Beta Ltd", role: "admin" });
    expect(w.nameOf(A)).toBe("Acme Corp");
  });

  it("refuses a member who is not an owner or admin, with the reason, and changes nothing", async () => {
    const w = world();
    w.signedInAs(OTHER);
    const answer = await w.call("PUT", { name: "Hijacked" });
    expect(answer.status).toBe(403);
    expect(answer.body.error).toEqual({ code: "FORBIDDEN", message: COMPANY_RENAME_ADMIN_ONLY });
    expect(w.nameOf(A)).toBe("acme-install");
    expect(w.renameLogs()).toEqual([]);
  });

  it("refuses a name the company create would refuse, and any other field, without echoing what was sent", async () => {
    const w = world();
    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(81) }, { name: "Bad‮name" }, { name: "A\nB" }, { name: 7 }, { name: "Fine", companyId: B }, "not json", undefined]) {
      const answer = await w.call("PUT", body);
      expect(answer.status).toBe(400);
      expect(answer.body.error).toEqual({ code: "CONFIG_INVALID", message: COMPANY_RENAME_BODY_INVALID });
    }
    expect(w.nameOf(A)).toBe("acme-install");
    expect(w.nameOf(B)).toBe("Other Co");
  });

  it("is a no-op for the same name, and fails closed with fixed words where the rename cannot be made", async () => {
    const w = world();
    expect(viewOf((await w.call("PUT", { name: "acme-install" })).body).name).toBe("acme-install");
    expect(w.renameLogs()).toEqual([]);
    const unwired = world({ rename: false });
    const answer = await unwired.call("PUT", { name: "Acme Corp" });
    expect(answer.status).toBe(503);
    expect(answer.body.error.message).toBe(COMPANY_DETAILS_UNAVAILABLE);
    expect(unwired.nameOf(A)).toBe("acme-install");
  });
});

describe("the sign-in service's company-rename", () => {
  const setUp = () => { const w = world(); return { w, store: new CompanySignInStore({ documentClient: w.h.db, tableName: "SignIn", now: () => Date.parse(TIME) }) }; };
  const rename = (store: CompanySignInStore, event: Record<string, unknown>) => companyOperator({ store, now: () => Date.parse(TIME), log: () => undefined }, { kind: "company-rename", ...event });

  it("checks the named actor itself: a plain member, a removed person or another company's admin changes nothing", async () => {
    const { w, store } = setUp();
    for (const createdBy of [OTHER, GONE, THIRD]) expect(await rename(store, { companyId: A, name: "Nope", createdBy })).toMatchObject({ ok: false, error: "unavailable" });
    expect(w.nameOf(A)).toBe("acme-install");
  });

  it("never renames the built-in company, or a company with no record", async () => {
    const { store } = setUp();
    expect(await rename(store, { companyId: IMPLICIT_COMPANY_ID, name: "Nope", createdBy: PERSON })).toEqual({ ok: false, error: "invalid_request" });
    expect(await rename(store, { companyId: "org_" + "z".repeat(20), name: "Nope", createdBy: PERSON })).toEqual({ ok: false, error: "not_found" });
  });
});
