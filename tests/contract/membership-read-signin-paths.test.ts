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
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
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

  it("a legacy-seat person at a refresh: a THROTTLED seat write is the retryable failure (never 'may not mint', which revokes); a lost race is the refusal it always was", async () => {
    const now = () => Date.UTC(2026, 10, 25);
    const legacy = (db: FakeDynamoDb, subject: string) => {
      const person = ownerKeyForSubject("https://x.example", subject);
      db.set({ pk: `DEVELOPER#${person}`, sk: "META", entityType: "DEVELOPER", provider: "oidc", issuer: "https://x.example", subject, revoked: false, firstSignInAt: "2026-11-01T00:00:00.000Z", lastSignInAt: "2026-11-01T00:00:00.000Z" });
      return person;
    };
    const db = new FakeDynamoDb({ seed: 3 });
    const company = new CompanySignInStore({ documentClient: db, tableName: "signin", now });
    const deps = { company, slackCompany: async () => undefined, companyless: async () => false };
    expect(await companyMayMint(deps, legacy(db, "control"), "oidc", IMPLICIT_COMPANY_ID, undefined, true), "control: the seat is written").toBe(true);
    const throttled = legacy(db, "throttled");
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });
    await expect(companyMayMint(deps, throttled, "oidc", IMPLICIT_COMPANY_ID, undefined, true)).rejects.toSatisfy(isMembershipReadFailure);
    expect(await companyMayMint(deps, throttled, "oidc", IMPLICIT_COMPANY_ID, undefined, true), "the retry seats the person").toBe(true);
    const raced = legacy(db, "raced");
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ConditionalCheckFailedException", message: "lost the race" }, times: 1 });
    expect(await companyMayMint(deps, raced, "oidc", IMPLICIT_COMPANY_ID, undefined, true), "a lost race re-reads and finds no seat: refused").toBe(false);
    // A CANCELLED transaction is a lost race only when a condition failed; a cancellation for any other reason (throttled, conflicting) is a failed write.
    const cancelled = legacy(db, "cancelled");
    for (const Code of ["ThrottlingError", "TransactionConflict"]) {
      db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", message: Code, cancellationReasons: [{ Code }, { Code: "None" }] }, times: 1 });
      await expect(companyMayMint(deps, cancelled, "oidc", IMPLICIT_COMPANY_ID, undefined, true), Code).rejects.toSatisfy(isMembershipReadFailure);
    }
    expect(await companyMayMint(deps, cancelled, "oidc", IMPLICIT_COMPANY_ID, undefined, true), "the retry seats the person").toBe(true);
    const lost = legacy(db, "lost");
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", message: "condition", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }, times: 1 });
    expect(await companyMayMint(deps, lost, "oidc", IMPLICIT_COMPANY_ID, undefined, true), "a cancellation WITH a failed condition is the real lost race: refused").toBe(false);
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

describe("the refresh of a merged or connected sign-in (stillSeated) and the company's sign-in settings", () => {
  async function mergedMember() {
    const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
    const signed = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
    const token = await h.exchange(new URL(signed.headers.location!).searchParams.get("code")!);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    const session = h.db.find((row) => String(row.pk).startsWith("SESSION#"))[0]!;
    const survivor = h.db.find((row) => String(row.pk).startsWith("DEVELOPER#") && row.sk === "META")[0]!;
    const alias = "b".repeat(64);
    h.db.set({ ...survivor, pk: `DEVELOPER#${alias}`, mergedInto: String(survivor.pk).slice("DEVELOPER#".length) });
    h.db.set({ ...session, signedInId: alias });
    return { h, alias, refreshToken: token.body.refresh_token as string };
  }
  const sessions = (h: Awaited<ReturnType<typeof mergedMember>>["h"]) => h.db.find((row) => String(row.pk).startsWith("SESSION#")).map((row) => row.revokedReason);

  it("control: a session whose sign-in is merged into the person renews", async () => {
    const { h, refreshToken } = await mergedMember();
    expect((await h.refresh(refreshToken)).status).toBe(200);
  });

  it("a merge-walk hop whose read FAILS is the retryable 503 and the session is kept; the SAME token renews once the read is back", async () => {
    const { h, alias, refreshToken } = await mergedMember();
    h.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk === `DEVELOPER#${alias}`, error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });
    const blip = await h.refresh(refreshToken);
    expect([blip.status, blip.body.error]).toEqual([503, "temporarily_unavailable"]);
    expect(sessions(h), "nothing is revoked by a failed read").toEqual([undefined]);
    expect((await h.refresh(refreshToken)).status).toBe(200);
  });

  it("a merge-walk hop that ANSWERS 'revoked' still ends the session (sign_in_unlinked)", async () => {
    const { h, alias, refreshToken } = await mergedMember();
    h.db.set({ ...h.db.get(`DEVELOPER#${alias}`, "META")!, revoked: true });
    expect((await h.refresh(refreshToken)).status).toBe(400);
    expect(sessions(h)).toEqual(["sign_in_unlinked"]);
  });

  it("each read of the company's sign-in settings at a refresh (the shared-method check, then the issuer selection) that FAILS is the retryable 503 and the session is kept, never an ended sign-in", async () => {
    let failures = 0;
    for (let nth = 1; nth <= 4; nth += 1) {
      const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
      const signed = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
      const token = await h.exchange(new URL(signed.headers.location!).searchParams.get("code")!);
      const read = h.company.read.bind(h.company);
      let seen = 0;
      h.company.read = async (key) => { if (key.pk.endsWith("SIGNIN_ISSUER")) { seen += 1; if (seen === nth) throw new Error("the store failed"); } return read(key); };
      const answer = await h.refresh(token.body.refresh_token as string);
      expect([nth, [200, 503].includes(answer.status), sessions({ db: h.db } as never)]).toEqual([nth, true, [undefined]]);
      if (answer.status === 503) { failures += 1; expect(answer.body.error).toBe("temporarily_unavailable"); }
    }
    expect(failures, "the issuer row is read more than once on a refresh, and each read was failed in turn").toBeGreaterThanOrEqual(2);
  });

  it("the company's sign-in settings (issuer row) that cannot be READ at a refresh are the retryable 503 and the session is kept", async () => {
    const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
    const signed = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
    const token = await h.exchange(new URL(signed.headers.location!).searchParams.get("code")!);
    const refreshToken = token.body.refresh_token as string;
    const read = h.company.read.bind(h.company);
    h.company.read = async (key) => { if (key.pk.endsWith("SIGNIN_ISSUER")) throw new Error("the store failed"); return read(key); };
    const blip = await h.refresh(refreshToken);
    expect([blip.status, blip.body.error]).toEqual([503, "temporarily_unavailable"]);
    expect(sessions({ db: h.db } as never)).toEqual([undefined]);
    h.company.read = read;
    expect((await h.refresh(refreshToken)).status).toBe(200);
  });
});
