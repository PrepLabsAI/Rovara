// MEMBERSHIP-READ-FAILS-SAFE, the sign-in server's mint paths (follow-up to tests/unit/removed-member-refresh.test.ts): a read that FAILS is the retryable 503 and ends nothing; a read that
// ANSWERS keeps its old refusal. One test per path the first pass missed: the code grant (the code must still be usable), the companyless check and the legacy seat at a refresh.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, SHARED_RAW_IDS } from "../../packages/testing/src/isolation/two-company.js";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { CompanyInviteStore } from "../../packages/broker/src/developer/company-invites.js";
import { companyMayMint } from "../../packages/broker/src/developer/session-mint.js";
import { isMembershipReadFailure } from "../../packages/broker/src/core/membership-read.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const failMembershipReadsOnce = (h: { db: { injectFault(fault: { command?: string; match?: (input: Record<string, unknown>) => boolean; error: { name: string; message?: string }; times?: number }): void } }) =>
  h.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk.startsWith("COMPANY_MEMBER#"), error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });

describe("the code grant", () => {
  it("a membership read that fails BEFORE the code is burned answers the retryable 503, and the SAME code works on the retry", async () => {
    const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
    const signed = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
    const code = new URL(signed.headers.location!).searchParams.get("code")!;
    failMembershipReadsOnce(h);
    const blip = await h.exchange(code);
    expect([blip.status, blip.body.error]).toEqual([503, "temporarily_unavailable"]);
    expect(h.db.find((row) => String(row.pk).startsWith("CODE#")).map((row) => row.usedAt), "the code is not burned by a failed read").toEqual([undefined]);
    const retried = await h.exchange(code);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toHaveProperty("refresh_token");
  });
});

describe("the mint check", () => {
  it("the companyless check: a failed read throws the retryable failure (a refresh would answer 503), a clean answer of 'a member' is still no", async () => {
    const db = new FakeDynamoDb({ seed: 1 });
    const company = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => Date.UTC(2026, 10, 25) });
    const invites = new CompanyInviteStore({ documentClient: db, tableName: "signin", now: () => Date.UTC(2026, 10, 25), company, selfServeAllowed: true });
    const person = "c".repeat(64);
    db.set({ pk: `DEVELOPER#${person}`, sk: "META", entityType: "DEVELOPER", provider: "oidc", issuer: "https://x.example", subject: "s", revoked: false, companyless: true, firstSignInAt: "2026-11-01T00:00:00.000Z" });
    expect(await invites.companylessEligible(person), "control: no membership row and a companyless record").toBe(true);
    failMembershipReadsOnce({ db });
    await expect(invites.companylessEligible(person)).rejects.toSatisfy(isMembershipReadFailure);
    db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: COMPANY_A.orgId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
    expect(await invites.companylessEligible(person), "a person who has a membership row is not companyless").toBe(false);
  });

  it("a legacy-seat person at a refresh: a failed read or write inside the join is the retryable failure, never 'may not mint'", async () => {
    const db = new FakeDynamoDb({ seed: 2 });
    const company = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => Date.UTC(2026, 10, 25) });
    const person = "a".repeat(64);
    const deps = { company, slackCompany: async () => undefined, companyless: async () => false };
    // No membership row: the built-in company's legacy seat is attempted. Every call the join makes after the first read fails.
    db.injectFault({ command: "GetCommand", match: (input) => !(input.Key as { pk: string }).pk.startsWith("COMPANY_MEMBER#"), error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1000 });
    await expect(companyMayMint(deps, person, "oidc", IMPLICIT_COMPANY_ID, undefined, true)).rejects.toSatisfy(isMembershipReadFailure);
  });
});
