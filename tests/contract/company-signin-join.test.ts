import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { identityHarness, OIDC_ISSUER, httpEvent } from "../support/developer-fakes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";

const email = "person@example.test";
const personId = ownerKeyForSubject(OIDC_ISSUER, "person");
const companyId = "org_" + "a".repeat(20);
function world(verified = true) {
  const h = identityHarness({ oidc: {}, slackUsers: [{ userId: "U0SHARED", name: "Person", email }], oidcUsers: [{ sub: "person", email, email_verified: verified }, { sub: "other", email, email_verified: true }] });
  const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  const invoke = (event: unknown) => companyOperator({ store: company, now: h.now, log: h.deps.log, newCompanyId: () => companyId }, event);
  return { ...h, company, invoke };
}

it("an atomic preapproval can join exactly one of two people racing", async () => {
  const h = world(); await h.invoke({ kind: "company-create", name: "Company", firstAdminEmail: email, expiresInHours: 24 });
  const answers = await Promise.all([personId, "2".repeat(64)].map((personId) => h.company.join({ personId, companyId, email })));
  expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
  expect(answers.filter((answer) => !answer.ok)).toEqual([{ ok: false, reason: "not_invited" }]);
  const membership = h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")[0]!;
  expect(await companyMembershipFromDynamo(h.db, "signin").companyOf(membership.personId as string)).toBe(companyId);
  expect(await h.company.join({ personId: membership.personId as string, companyId, email })).toMatchObject({ ok: true });
  expect(h.db.refusals).toEqual([]);
});

it.each(["absent", "withdrawn", "used", "expired", "wrong-email", "unverified", "unreadable"])("all not-invited causes have identical answers: %s", async (cause) => {
  const h = world(); await h.invoke({ kind: "company-create", name: "Company", firstAdminEmail: email, expiresInHours: 1 });
  const approval = h.db.find((row) => row.entityType === "COMPANY_PREAPPROVAL")[0]!;
  if (cause === "absent") h.db.delete(approval.pk as string, approval.sk as string);
  if (cause === "withdrawn" || cause === "used") h.db.set({ ...approval, status: cause });
  if (cause === "expired") h.tick(3600_000);
  if (cause === "unreadable") h.db.set({ ...approval, role: "owner" });
  expect(await h.company.join({ personId, companyId, ...(cause === "unverified" ? {} : { email: cause === "wrong-email" ? "other@example.test" : email }) })).toEqual({ ok: false, reason: "not_invited" });
  expect(h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toEqual([]);
});

it("a new implicit-company person still needs an invitation; only an existing non-revoked developer gets legacy membership", async () => {
  const h = world();
  expect(await h.company.join({ personId, companyId: IMPLICIT_COMPANY_ID, email })).toEqual({ ok: false, reason: "not_invited" });
  await h.deps.store.upsertDeveloper({ developerId: personId, provider: "oidc", issuer: OIDC_ISSUER, subject: "person", displayName: "Person", email });
  expect(await h.company.join({ personId, companyId: IMPLICIT_COMPANY_ID, email })).toMatchObject({ ok: true, membership: { role: "member", joinedVia: "legacy", companyId: IMPLICIT_COMPANY_ID } });
  expect(await h.company.join({ personId, companyId, email })).toEqual({ ok: false, reason: "member_elsewhere" });
});

it("looks up preapproval only in the method's company and bounds reads", async () => {
  const h = world(); await h.invoke({ kind: "company-create", name: "Company", firstAdminEmail: email, expiresInHours: 24 });
  const start = h.db.commandNames().length;
  expect(await h.company.join({ personId, companyId: IMPLICIT_COMPANY_ID, email })).toEqual({ ok: false, reason: "not_invited" });
  expect(h.db.commandNames().length - start).toBeLessThanOrEqual(4);
  expect(h.db.find((row) => row.pk === companyScoped(companyId, "PREAPPROVAL"))).toEqual([expect.objectContaining({ status: "live" })]);
});

it("refuses real first sign-in before a developer, email index, code, session or Slack link lookup is written", async () => {
  const h = world(); h.deps.company = h.company;
  const back = await h.signIn("oidc", "person");
  expect(back.searchParams.get("error_description")).toBe("not invited");
  expect(h.db.find((row) => ["DEVELOPER", "DEVELOPER_EMAIL", "AUTH_CODE", "SESSION"].includes(row.entityType as string))).toEqual([]);
  expect(h.fetch.calls.filter((call) => call.includes("lookupByEmail"))).toEqual([]);
});

it("the real server lets only one of two identities racing spend the same approval", async () => {
  const h = world(); h.deps.company = h.company;
  await h.invoke({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email, role: "member", expiresInHours: 24 });
  const answers = await Promise.all(["person", "other"].map((subject) => h.signIn("oidc", subject)));
  expect(answers.filter((answer) => answer.searchParams.has("code"))).toHaveLength(1);
  expect(answers.filter((answer) => answer.searchParams.get("error_description") === "not invited")).toHaveLength(1);
  expect(h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toHaveLength(1);
  expect(h.db.find((row) => row.entityType === "DEVELOPER")).toHaveLength(1);
  expect(h.db.find((row) => row.entityType === "AUTH_CODE")).toHaveLength(1);
});

it("first admin joins through the real server, and both code redemption and refresh recheck membership", async () => {
  const h = world(); h.deps.company = h.company;
  // This test exercises token revocation after a future successful fresh sign-in check.
  await h.invoke({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email, role: "admin", expiresInHours: 1 });
  const back = await h.signIn("oidc", "person");
  const code = back.searchParams.get("code")!;
  expect(await h.company.membership(personId)).toMatchObject({ role: "admin" });
  await h.invoke({ kind: "company-member-revoke", companyId: IMPLICIT_COMPANY_ID, personId });
  expect((await h.exchange(code)).status).toBe(400);
  await h.invoke({ kind: "company-member-restore", companyId: IMPLICIT_COMPANY_ID, personId });
  const signed = await h.exchange((await h.signIn("oidc", "person")).searchParams.get("code")!);
  expect(signed.status).toBe(200);
  await h.invoke({ kind: "company-member-revoke", companyId: IMPLICIT_COMPANY_ID, personId });
  expect((await h.refresh(signed.body.refresh_token as string)).status).toBe(400);
  expect(h.db.find((row) => row.entityType === "SESSION")).toEqual([expect.objectContaining({ revokedReason: "company_changed" })]);
});

it("refresh gives the existing implicit-company developer one legacy membership", async () => {
  const h = world();
  const signed = await h.exchange((await h.signIn("oidc", "person")).searchParams.get("code")!);
  h.deps.company = h.company;
  expect((await h.refresh(signed.body.refresh_token as string)).status).toBe(200);
  expect(h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toEqual([expect.objectContaining({ personId, companyId: IMPLICIT_COMPANY_ID, joinedVia: "legacy", role: "member" })]);
});

it("operator events are exposed only on the company-enabled sign-in handler", async () => {
  const h = world();
  const event = { kind: "company-create", name: "Company", firstAdminEmail: email, expiresInHours: 24 };
  expect(await h.handler(event as never)).toEqual({ ok: false, error: "invalid_request" });
  h.deps.company = h.company;
  expect(await h.handler(event as never)).toMatchObject({ ok: true, companyId: expect.stringMatching(/^org_[a-z0-9]{20}$/) as unknown });
});

it.each([null, [], "company-create", 1, undefined].map((event) => [event]))("company-mode dispatch refuses malformed root input: %s", async (event) => {
  const h = world(); h.deps.company = h.company;
  expect(await h.handler(event as never)).toEqual({ ok: false, error: "invalid_request" });
});

it("an unbound Slack workspace never defaults to the implicit company", async () => {
  const h = world(); h.deps.company = h.company; h.deps.slackTeamCompany = () => undefined;
  await h.invoke({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email, role: "member", expiresInHours: 24 });
  expect((await h.signIn("slack", "U0SHARED")).searchParams.get("error_description")).toBe("not invited");
  expect(h.db.find((row) => row.entityType === "DEVELOPER")).toEqual([]);
});

it("the browser review path also refuses before upsert or session creation", async () => {
  const h = world(); h.deps.company = h.company;
  const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111"));
  const link = /href="([^"]*method=oidc)"/.exec(start.body)![1]!.replaceAll("&amp;", "&");
  const selected = await h.http(httpEvent("GET", link));
  const event = httpEvent("GET", h.oidc.approve(selected.headers.location!, "person"));
  const back = await h.http({ ...event, headers: { cookie: start.cookies![0]!.split(";")[0]! } });
  expect(back.cookies?.some((cookie) => cookie.startsWith("__Host-agentx_review_session="))).toBe(false);
  expect(h.db.find((row) => ["DEVELOPER", "DEVELOPER_EMAIL", "AUTH_CODE", "SESSION"].includes(row.entityType as string))).toEqual([]);
});

it("browser session mint rechecks a revocation that happened after the profile write", async () => {
  const h = world(); h.deps.company = h.company;
  await h.invoke({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email, role: "member", expiresInHours: 1 });
  const upsert = h.deps.store.upsertDeveloper.bind(h.deps.store);
  h.deps.store.upsertDeveloper = async (...args) => {
    const profile = await upsert(...args);
    await h.company.setRevoked(IMPLICIT_COMPANY_ID, personId, true);
    return profile;
  };
  const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111"));
  const link = /href="([^"]*method=oidc)"/.exec(start.body)![1]!.replaceAll("&amp;", "&");
  const selected = await h.http(httpEvent("GET", link));
  const event = httpEvent("GET", h.oidc.approve(selected.headers.location!, "person"));
  const back = await h.http({ ...event, headers: { cookie: start.cookies![0]!.split(";")[0]! } });
  expect((await h.company.membership(personId))?.revokedAt).toBeDefined();
  expect(back.cookies?.some((cookie) => cookie.startsWith("__Host-agentx_review_session="))).toBe(false);
  expect(h.db.find((row) => row.entityType === "SESSION")).toEqual([]);
});

it("the real server returns identical bytes for every not-invited cause", async () => {
  const answers: string[] = [];
  for (const cause of ["absent", "withdrawn", "used", "expired", "different", "unverified"]) {
    const h = world(cause !== "unverified"); h.deps.company = h.company;
    if (cause !== "absent") await h.invoke({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email: cause === "different" ? "another@example.test" : email, role: "member", expiresInHours: 1 });
    if (cause === "used" || cause === "withdrawn") {
      const row = h.db.find((item) => item.entityType === "COMPANY_PREAPPROVAL")[0]!; h.db.set({ ...row, status: cause });
    }
    if (cause === "expired") h.tick(3600_000);
    const back = await h.signIn("oidc", "person");
    expect(back.searchParams.get("error_description")).toBe("not invited"); answers.push(back.toString());
    expect(h.db.find((row) => ["DEVELOPER", "DEVELOPER_EMAIL", "AUTH_CODE", "SESSION"].includes(row.entityType as string))).toEqual([]);
  }
  expect(new Set(answers).size).toBe(1);
});
