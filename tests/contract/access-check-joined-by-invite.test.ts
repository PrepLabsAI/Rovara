// DEC 254b (f): the access answer says whether THIS session's own sign-in joined the company by spending a live pre-approval (an invite).
// Recorded by the sign-in server on the session at mint; never from a token claim, the request or an access rule.
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { AccessCheckResponseSchema, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { OIDC_ISSUER } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { B, person, SECRET, sharedSignInWorld as world, X } from "../support/company-shared-signin-world.js";

const forge = (token: string, extra: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...decodeJwt(token), ...extra })).toString("base64url")}.sig`;

describe("joinedByInvite in the access answer (DEC 254b f)", () => {
  it("true for the session whose sign-in spent the invite, kept across refresh; absent on the same person's later sign-in", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "member", expiresInHours: 24 });
    const joined = await w.signIn("carol", { company: X });
    expect((await w.access(joined.access)).body).toMatchObject({ companyId: X, companyRole: "member", joinedByInvite: true });
    const rotated = await w.refresh(joined.refresh!);
    expect((await w.access(rotated.body.access_token as string)).body).toMatchObject({ joinedByInvite: true });
    const later = await w.signIn("carol", { company: X });
    expect((await w.access(later.access)).body).not.toHaveProperty("joinedByInvite");
    const plain = await w.signIn("carol");
    expect((await w.access(plain.access)).body).not.toHaveProperty("joinedByInvite");
  });

  it("true for an invite into a company with its own issuer, and into the built-in company", async () => {
    const w = world();
    await w.setup();
    const bob = await w.signIn("bob", { company: B });
    expect((await w.access(bob.access)).body).toMatchObject({ companyId: B, companyRole: "admin", joinedByInvite: true });
    await w.operator({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email: "dana@example.test", role: "member", expiresInHours: 24 });
    const dana = await w.signIn("dana");
    expect((await w.access(dana.access)).body).toMatchObject({ companyId: IMPLICIT_COMPANY_ID, joinedByInvite: true });
  });

  it("absent for a self-serve owner, a legacy join, a session with no company, and the developer-id form", async () => {
    const w = world();
    const first = await w.setup();
    // The owner's first, company-less session (refused now that they have a company), then their company session.
    expect((await w.access(first.access)).status).toBe(401);
    const owner = await w.signIn("owner");
    expect((await w.access(owner.access)).body).not.toHaveProperty("joinedByInvite");
    const fresh = await w.signIn("carol");
    expect((await w.access(fresh.access)).body).toEqual(expect.not.objectContaining({ joinedByInvite: expect.anything() as unknown, companyId: expect.anything() as unknown }));
    await w.deps.store.upsertDeveloper({ developerId: person("legacy"), provider: "oidc", issuer: OIDC_ISSUER, subject: "legacy", displayName: "Legacy" });
    const legacy = await w.signIn("legacy");
    expect((await w.access(legacy.access)).body).toMatchObject({ companyId: IMPLICIT_COMPANY_ID });
    expect((await w.access(legacy.access)).body).not.toHaveProperty("joinedByInvite");
    // The confidential client's developer-id form reads no session, so never says it.
    await w.signIn("bob", { company: B });
    const basic = `Basic ${Buffer.from(`web-app:${SECRET}`).toString("base64")}`;
    const answer = await w.callWith("POST", "/v1/dev/access", basic, { developerId: person("bob") });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ companyId: B });
    expect(answer.body).not.toHaveProperty("joinedByInvite");
  });

  it("never from a claim, the request or a session it was not recorded on", async () => {
    const w = world();
    await w.setup();
    const owner = await w.signIn("owner");
    expect((await w.access(forge(owner.access!, { joinedByInvite: true }))).body).not.toHaveProperty("joinedByInvite");
    expect((await w.call("POST", "/v1/dev/access", owner.access, { joinedByInvite: true })).status).toBe(400);
    // A recorded mark on a session whose company no longer matches live membership: the whole answer is refused.
    const bob = await w.signIn("bob", { company: B });
    const session = w.sessionOf(person("bob"))[0]!;
    w.db.set({ ...session, companyId: X });
    expect((await w.access(bob.access)).status).toBe(401);
    // A mark that is not exactly true is not one.
    w.db.set({ ...session, joinedByInvite: "true" });
    expect((await w.access(bob.access)).body).not.toHaveProperty("joinedByInvite");
  });

  it("an access rule can neither set nor clear it", async () => {
    const w = world();
    await w.setup();
    const bob = await w.signIn("bob", { company: B });
    const owner = await w.signIn("owner");
    w.routes.developer.accessRules = [() => ({ joinedByInvite: true, administrator: false } as never)];
    expect((await w.access(owner.access)).body).not.toHaveProperty("joinedByInvite");
    w.routes.developer.accessRules = [() => ({ joinedByInvite: false } as never), () => ({ projects: [] })];
    expect((await w.access(bob.access)).body).toMatchObject({ joinedByInvite: true });
    // A rule that tries to change the frozen answer fails, and a failed rule refuses the whole answer (never a changed one).
    w.routes.developer.accessRules = [(_context, answer) => { (answer as { joinedByInvite?: boolean }).joinedByInvite = false; return undefined; }];
    expect((await w.access(bob.access)).status).toBe(401);
  });

  it("absent when Code's company layer is off, whatever the session holds", async () => {
    const w = world();
    await w.setup();
    const bob = await w.signIn("bob", { company: B });
    const { companies: _c, ...off } = w.routes; void _c;
    const answer = await w.callOn(off, "POST", "/v1/dev/access", bob.access, {});
    expect(JSON.stringify(answer.body)).not.toContain("joinedByInvite");
  });

  it("the schema takes it only as a boolean and only with a company", () => {
    const base = { developerId: "a".repeat(64), displayName: "A", nameChosen: false, administrator: false, projects: [], notices: [] };
    expect(AccessCheckResponseSchema.safeParse({ ...base, companyId: X, companyRole: "member", joinedByInvite: true }).success).toBe(true);
    expect(AccessCheckResponseSchema.safeParse({ ...base, joinedByInvite: true }).success).toBe(false);
    expect(AccessCheckResponseSchema.safeParse({ ...base, companyId: X, companyRole: "member", joinedByInvite: "yes" }).success).toBe(false);
  });

  it("two racing joins by one person spend the invite once: only the winner reports it", async () => {
    const db = new FakeDynamoDb();
    const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => Date.parse("2026-11-17T00:00:00Z") });
    db.set({ pk: `ORG#${X}#COMPANY`, sk: "META", entityType: "COMPANY", companyId: X, name: "Acme", status: "active", createdAt: "2026-11-16T00:00:00.000Z", createdBy: "operator" });
    await store.preapprove(X, "carol@example.test", "member", 24);
    const id = person("carol");
    const answers = await Promise.all([store.join({ personId: id, companyId: X, email: "carol@example.test" }), store.join({ personId: id, companyId: X, email: "carol@example.test" })]);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(answers.filter((answer) => answer.ok && answer.viaPreapproval === true)).toHaveLength(1);
    const again = await store.join({ personId: id, companyId: X, email: "carol@example.test" });
    expect(again).toMatchObject({ ok: true });
    expect(again).not.toHaveProperty("viaPreapproval");
  });
});
