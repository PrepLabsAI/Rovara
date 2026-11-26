// MEMBERSHIP-READ-FAILS-SAFE (was REMOVED-MEMBER-ANSWER; briefs/arch-cleanup/REMOVED-MEMBER-ANSWER-FINDINGS.md): the sign-in server's refresh grant re-checks the person's live
// membership (session-mint.ts companyMayMint). Two answers matter to Cloud, which treats a 400 invalid_grant as "this sign-in is over" and a 503 as "Code is down, keep the sign-in":
//   (1) a REMOVED member's refresh is refused (400 invalid_grant) and their session ends: the right answer, pinned here so the fix for (2) cannot loosen it;
//   (2) a member whose membership row could not be READ for a moment (a throttled or timed-out store read) must get a retryable answer and keep the session. Today `companyMayMint` turns the
//       throw into "no membership" and refreshTokenGrant REVOKES the session ("company_changed") before answering 400, so one failed read ends the person's sign-in for good.
import { describe, expect, it } from "vitest";
import { COMPANY_A, SHARED_RAW_IDS } from "../../packages/testing/src/isolation/two-company.js";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";

const person = ownerKeyForSubject(`https://${COMPANY_A.label.toLowerCase()}.identity.example.test`, SHARED_RAW_IDS.user);

async function signedInMember() {
  const h = signinCompanyWorld();
  await h.create(COMPANY_A.orgId);
  const signed = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
  const token = await h.exchange(new URL(signed.headers.location!).searchParams.get("code")!);
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  return { h, refreshToken: token.body.refresh_token as string };
}
const sessions = (h: Awaited<ReturnType<typeof signedInMember>>["h"]) => h.db.find((row) => String(row.pk).startsWith("SESSION#")).map((row) => ({ revokedAt: row.revokedAt, revokedReason: row.revokedReason }));

describe("the refresh grant and the person's live membership", () => {
  it("(control) a member's refresh is renewed", async () => {
    const { h, refreshToken } = await signedInMember();
    const first = await h.refresh(refreshToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(sessions(h)).toEqual([{}]);
  });

  it("a REMOVED member's refresh is refused (400 invalid_grant) and the session ends", async () => {
    const { h, refreshToken } = await signedInMember();
    const row = h.db.get(`COMPANY_MEMBER#${person}`, "COMPANY")!;
    h.db.set({ ...row, revokedAt: new Date(h.now()).toISOString(), revokedBy: "operator" });
    const answer = await h.refresh(refreshToken);
    expect([answer.status, answer.body.error]).toEqual([400, "invalid_grant"]);
    expect(sessions(h)).toEqual([expect.objectContaining({ revokedReason: "company_changed" })]);
  });

  it("a membership read that FAILS once is a retryable answer and the session is kept: the same refresh token works when the store is back", async () => {
    const { h, refreshToken } = await signedInMember();
    h.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk.startsWith("COMPANY_MEMBER#"), error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });
    const blip = await h.refresh(refreshToken);
    expect([blip.status, blip.body.error], `the answer to a refresh while the membership read failed: ${JSON.stringify(blip.body)}`).toEqual([503, "temporarily_unavailable"]);
    expect(sessions(h), "the session is not revoked by a failed read").toEqual([{}]);
    const later = await h.refresh(refreshToken);
    expect(later.status, JSON.stringify(later.body)).toBe(200);
  });

  it("PROOF (a failing read keeps no one in): a REMOVED person's refresh during a failed read is refused as RETRYABLE and never granted; once the read works it is refused for good and the session ends", async () => {
    const { h, refreshToken } = await signedInMember();
    const row = h.db.get(`COMPANY_MEMBER#${person}`, "COMPANY")!;
    h.db.set({ ...row, revokedAt: new Date(h.now()).toISOString(), revokedBy: "operator" });
    h.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk.startsWith("COMPANY_MEMBER#"), error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });
    const blip = await h.refresh(refreshToken);
    expect([blip.status, blip.body.error]).toEqual([503, "temporarily_unavailable"]);
    expect(blip.body, "no token is granted during a failed read").not.toHaveProperty("access_token");
    expect(sessions(h), "nothing is revoked on a failed read").toEqual([{}]);
    const later = await h.refresh(refreshToken);
    expect([later.status, later.body.error], "a read that answers 'removed' ends the sign-in").toEqual([400, "invalid_grant"]);
    expect(sessions(h)).toEqual([expect.objectContaining({ revokedReason: "company_changed" })]);
  });

  it("a failed read during a refresh spends nothing: the refresh token is not rotated, so the SAME token renews the member once the store is back (still signed in)", async () => {
    const { h, refreshToken } = await signedInMember();
    h.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk.startsWith("COMPANY_MEMBER#"), error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });
    expect((await h.refresh(refreshToken)).status).toBe(503);
    expect(h.db.find((row) => String(row.pk).startsWith("REFRESH#")).map((row) => row.usedAt), "the presented token is unspent").toEqual([undefined]);
    const renewed = await h.refresh(refreshToken);
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(renewed.body).toHaveProperty("access_token");
    expect(sessions(h)).toEqual([{}]);
  });
});
