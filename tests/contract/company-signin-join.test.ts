import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
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

it.each([null, [], "company-create", 1, undefined].map((event) => [event]))("company-mode dispatch refuses malformed root input: %s", async (event) => {
  const h = world(); h.deps.company = h.company;
  expect(await h.handler(event as never)).toEqual({ ok: false, error: "invalid_request" });
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
