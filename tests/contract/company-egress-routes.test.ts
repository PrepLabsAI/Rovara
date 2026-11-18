// L4-EGR: GET /v1/dev/company/egress-addresses through the real developer dispatcher, the real membership reader and the SDK double. Two companies throughout: both read the SAME
// addresses (they belong to the install), only a live owner or admin reads them, and every refusal is fixed words with no echo.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CompanyEgressAddressesViewSchema, EGRESS_ADDRESSES_ADMIN_ONLY, EGRESS_ADDRESSES_UNAVAILABLE } from "@agentx/contracts";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { routeCompanyEgress } from "../../packages/broker/src/aws/company-egress-routes.js";
import { APP_ROUTES, DEV_ROUTES, devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const PERSON_B = "e".repeat(64);
const PATH = "/v1/dev/company/egress-addresses";
const ADDRESSES = "203.0.113.195,198.51.100.187";
type Answer = Record<string, unknown> & { error: { code: string; message: string } };

function world(options: { value?: string | undefined; wired?: boolean; throws?: boolean } = {}) {
  const h = companyRouteHarness();
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  const value = "value" in options ? options.value : ADDRESSES;
  if (options.wired !== false) h.deps.developer.companyEgress = { addresses: () => { if (options.throws === true) throw new Error("boom 10.0.0.9"); return value; } };
  const as = (personId: string, companyId: string, role: "owner" | "admin" | "member" = "owner", extra: Record<string, unknown> = {}) => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME, ...extra });
    h.db.set({ pk: `SESSION#session-${personId}`, sk: "META", developerId: personId, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: personId === PERSON ? "Ada Owner" : "Bea Admin" });
    h.claims.sub = personId; h.claims.sid = `session-${personId}`;
  };
  as(PERSON, A);
  const call = async (method = "GET", path = PATH, body?: unknown) => {
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  return { h, as, call };
}
const viewOf = (body: Answer) => { const { requestId: _r, ...rest } = body; void _r; return CompanyEgressAddressesViewSchema.parse(rest); };

describe("GET /v1/dev/company/egress-addresses", () => {
  it("an owner reads the install's addresses, in order, and the answer is exactly the contract", async () => {
    const w = world();
    const read = await w.call();
    expect(read.status).toBe(200);
    expect(viewOf(read.body)).toEqual({ addresses: ["203.0.113.195", "198.51.100.187"] });
  });

  it("an admin reads them too", async () => {
    const w = world();
    w.as(PERSON_B, A, "admin");
    expect(viewOf((await w.call()).body)).toEqual({ addresses: ["203.0.113.195", "198.51.100.187"] });
  });

  it("two companies on one install read the SAME addresses (they belong to the install, not to a company)", async () => {
    const w = world();
    const first = viewOf((await w.call()).body);
    w.as(PERSON_B, B, "owner");
    const second = viewOf((await w.call()).body);
    expect(second).toEqual(first);
    expect(second.addresses).toHaveLength(2);
  });

  it("a member (any company) is refused in fixed words, with no address in the answer", async () => {
    const w = world();
    w.as(PERSON_B, B, "member");
    const refused = await w.call();
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(EGRESS_ADDRESSES_ADMIN_ONLY);
    expect(refused.raw).not.toMatch(/44\.235|44\.226/u);
  });

  it("needs a live, unrevoked membership, and a person with no membership is signed out of the route", async () => {
    const w = world();
    w.as(PERSON, A, "owner", { revokedAt: TIME });
    expect((await w.call()).status).toBe(401);
    const stranger = world();
    stranger.h.db.delete?.(membershipKey(PERSON).pk, membershipKey(PERSON).sk);
    expect((await stranger.call()).status).toBe(401);
  });

  it("the role is the live membership, never a header, query or claim: a member who sends role=owner is still refused", async () => {
    const w = world();
    w.as(PERSON_B, A, "member");
    const answer = await w.h.read(`${PATH}?role=owner&company=${B}`, { method: "GET", headers: { "x-role": "owner", "x-company": B } });
    expect(answer.statusCode).toBe(403);
  });

  it("an install without the addresses (an older release, or an empty value) reads an empty list, not an error", async () => {
    for (const value of [undefined, ""]) expect(viewOf((await world({ value }).call()).body)).toEqual({ addresses: [] });
  });

  it("a malformed value is never shown in part: a fixed 503 (a bad address, a private one, a duplicate, a space, too many)", async () => {
    for (const value of ["203.0.113.195,nope", "10.0.0.5", "203.0.113.195,203.0.113.195", "203.0.113.195, 198.51.100.187", "1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5", "203.0.113.195,", "::1", "<script>"]) {
      const answer = await world({ value }).call();
      expect([value, answer.status]).toEqual([value, 503]);
      expect(answer.body.error.message).toBe(EGRESS_ADDRESSES_UNAVAILABLE);
      expect(answer.raw).not.toContain("203.0.113");
    }
    const threw = await world({ throws: true }).call();
    expect(threw.status).toBe(503);
    expect(threw.raw).not.toMatch(/boom|10\.0\.0\.9/u);
  });

  it("is unknown where the wiring is absent, and refuses every other method", async () => {
    expect((await world({ wired: false }).call()).status).toBe(404);
    const w = world();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect([method, (await w.call(method, PATH, {})).status]).toEqual([method, 404]);
  });

  it("the route's own membership check (defence in depth, behind the dispatcher's company lookup): a membership of another company, another person or a revoked one is signed out, whatever role it holds", async () => {
    const w = world();
    const send = async (item: Record<string, unknown> | undefined, asked: string = A) => {
      if (item !== undefined) w.h.db.set({ ...membershipKey(PERSON_B), entityType: "COMPANY_MEMBERSHIP", joinedAt: TIME, ...item });
      return routeCompanyEgress({ documentClient: w.h.db, signInTableName: "SignIn", wiring: { addresses: () => ADDRESSES } }, { developerId: PERSON_B } as never, asked, { method: "GET", headers: {}, path: PATH } as never);
    };
    // The control: an owner of A asking for A reads the list.
    expect(await send({ personId: PERSON_B, companyId: A, role: "owner" })).toEqual({ addresses: ["203.0.113.195", "198.51.100.187"] });
    // The caller's membership is company B's but the dispatcher said A: refused.
    await expect(send({ personId: PERSON_B, companyId: B, role: "owner" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    // A membership row that names another person.
    await expect(send({ personId: PERSON, companyId: A, role: "owner" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    // Revoked.
    await expect(send({ personId: PERSON_B, companyId: A, role: "owner", revokedAt: TIME })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    // Not a company id.
    await expect(send({ personId: PERSON_B, companyId: "not-a-company", role: "owner" }, "not-a-company")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("the hosted broker wires the route to its ROVARA_EGRESS_ADDRESSES variable (the only place the value comes from)", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(source).toContain("companyEgress: { addresses: () => process.env[EGRESS_ADDRESSES_VARIABLE] }");
  });

  it("has exactly one additive route row, full access only, and no row on the app routes", () => {
    expect(DEV_ROUTES.filter((route) => route.path === PATH)).toEqual([{ method: "GET", path: PATH, requires: "full" }]);
    expect(devRouteOf("GET", PATH)).toEqual({ method: "GET", path: PATH, requires: "full" });
    expect(devRouteOf("POST", PATH)).toBeUndefined();
    expect(APP_ROUTES.filter((route) => route.path.includes("egress"))).toEqual([]);
  });
});
