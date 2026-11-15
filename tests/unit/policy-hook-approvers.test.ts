// Lane H: "may this person decide this? is the sign-in fresh enough? is a second person needed?". Stricter only, refused at once with no answer. Owner row
// 11.5 (loosening a setting needs a second admin) is the "second person needed" answer.
import { describe, expect, it } from "vitest";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { stricterRequirement, withPolicyHookApprovers } from "../../packages/broker/src/core/policy-hook/approvers.js";
import { POLICY_HOOK_WORDS, checkApproverCount, type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type Principal } from "../../packages/contracts/src/index.js";
import { COMPANY, ISSUER, fakeService, makeKey, memoryAudit, settingsFor, signerOf } from "./policy-hook-fixture.js";

const install = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");
const T0 = 1_800_000_000_000;
const person = (personId: string, authTime?: string): Principal => ({ companyId: COMPANY, personId, displayName: personId, roles: ["admin"], provider: "sso", ...(authTime === undefined ? {} : { authTime }) });
const asker = person("admin-a");
const request = (extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ companyId: COMPANY, requestId: "req-1", kind: "setting.loosen", subject: { type: "setting", id: "review_mode" }, projectName: "web", revision: 1, artifactDigest: "d", requestedBy: asker, risk: "high", ...extra });
const proof: ApprovalProof = { proofId: "p1", method: "local-session", requestId: "req-1", revision: 1, artifactDigest: "d", token: "session-secret" };
const baseRequirement: ApprovalRequirement = { methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true, soleApproverAllowed: true };

function baseApprovers(verdict: ApprovalVerdict, released: string[] = []): Approvers {
  return { async requirement() { return baseRequirement; }, async verify() { return verdict; }, async commitClaim() { return { applied: true }; }, async releaseClaim(id) { released.push(id); } };
}

function world(answer: Parameters<typeof fakeService>[0]["answer"], base: Approvers) {
  const service = fakeService({ key: hookKey, now: () => T0, answer });
  const audit = memoryAudit();
  const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch, now: () => T0, audit: audit.sink });
  return { approvers: withPolicyHookApprovers(base, client, { now: () => T0 }), service, audit };
}

const loose = { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true };

describe("policy hook: decisions", () => {
  it("row 11.5: a second person needed means the asker cannot approve, no sole approver", async () => {
    const w = world(() => ({ ...loose, secondPerson: true }), baseApprovers({ approved: true, approver: asker, method: "local-session", proofId: "p1", soleApprover: true }));
    const requirement = await w.approvers.requirement(request());
    expect(requirement).toEqual({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: false });
    expect(w.service.asked[0]!.q).toEqual({ cid: COMPANY, pid: "web", stage: "requirement", what: "setting.loosen", styp: "setting", sid: "review_mode", risk: "high", by: "admin-a" });
    expect(await w.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "self_approval_not_allowed" });
    const verdict = { approved: true as const, approver: asker, method: "local-session", proofId: "p1", soleApprover: true as const };
    expect(checkApproverCount(requirement, asker, [verdict])).toEqual({ ok: false, reason: "self_approval_not_allowed" });
  });

  it("row 11.5: a second admin's approval passes, with the sole-approver mark removed", async () => {
    const other = person("admin-b");
    const w = world(() => ({ ...loose, secondPerson: true }), baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1", soleApprover: true }));
    expect(await w.approvers.verify(request(), proof)).toEqual({ approved: true, approver: other, method: "local-session", proofId: "p1" });
    expect(w.service.asked[0]!.q).toMatchObject({ stage: "verdict", per: "admin-b", by: "admin-a" });
  });

  it("with no one named as asker, a second person means two approvers", () => {
    const anonymous: ApprovalRequest = { ...request() };
    delete anonymous.requestedBy;
    expect(stricterRequirement(baseRequirement, { ...loose, secondPerson: true }, anonymous).minApprovers).toBe(2);
  });

  it("stricter only: a looser answer never loosens the install's requirement", () => {
    const strict: ApprovalRequirement = { methods: ["local-session"], minApprovers: 3, selfApprovalAllowed: false, signIn: { mode: "window", seconds: 300 } };
    expect(stricterRequirement(strict, { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true, signInMaxAgeSeconds: 86_400 }, request())).toEqual(strict);
    expect(stricterRequirement(strict, { allow: true, minApprovers: 5, secondPerson: false, selfApproval: true, signInMaxAgeSeconds: 60 }, request())).toEqual({ ...strict, minApprovers: 5, signIn: { mode: "window", seconds: 60 } });
    expect(stricterRequirement({ ...baseRequirement, signIn: { mode: "any-active" } }, { ...loose, signInMaxAgeSeconds: 600 }, request()).signIn).toEqual({ mode: "window", seconds: 600 });
    expect(stricterRequirement(baseRequirement, loose, request())).toEqual(baseRequirement);
  });

  it("no answer at the requirement refuses at once with fixed words; a no refuses too", async () => {
    const down = world(() => new Response("down", { status: 503 }), baseApprovers({ approved: false, reason: "x" }));
    await expect(down.approvers.requirement(request())).rejects.toThrow(POLICY_HOOK_WORDS.decideNoAnswer);
    expect(down.service.asked).toHaveLength(1);
    const no = world(() => ({ ...loose, allow: false }), baseApprovers({ approved: false, reason: "x" }));
    await expect(no.approvers.requirement(request())).rejects.toThrow(POLICY_HOOK_WORDS.decideRefused);
  });

  it("no answer or a no at the verdict refuses at once and gives back the verdict's claim", async () => {
    const released: string[] = [];
    const verdict: ApprovalVerdict = { approved: true, approver: person("admin-b"), method: "browser-step-up", proofId: "p1", claimId: "claim-1" };
    const down = world(() => new Error("connect refused"), baseApprovers(verdict, released));
    expect(await down.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "company_rules_no_answer" });
    const no = world(() => ({ ...loose, allow: false }), baseApprovers(verdict, released));
    expect(await no.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "company_rules_refused" });
    expect(released).toEqual(["claim-1", "claim-1"]);
    expect(down.audit.events[0]).toMatchObject({ action: "policy_hook.no_answer" });
  });

  it("is the sign-in fresh enough: an older sign-in, or none, is refused", async () => {
    const fresh = person("admin-b", new Date(T0 - 60_000).toISOString());
    const stale = person("admin-b", new Date(T0 - 3_600_000).toISOString());
    const answer = () => ({ ...loose, signInMaxAgeSeconds: 600 });
    expect((await world(answer, baseApprovers({ approved: true, approver: fresh, method: "m", proofId: "p1" })).approvers.verify(request(), proof)).approved).toBe(true);
    expect(await world(answer, baseApprovers({ approved: true, approver: stale, method: "m", proofId: "p1" })).approvers.verify(request(), proof)).toEqual({ approved: false, reason: "sign_in_not_fresh" });
    expect(await world(answer, baseApprovers({ approved: true, approver: person("admin-b"), method: "m", proofId: "p1" })).approvers.verify(request(), proof)).toEqual({ approved: false, reason: "sign_in_not_fresh" });
  });

  it("stricter only: the install's own refusal stands and the service is not asked", async () => {
    const w = world(() => loose, baseApprovers({ approved: false, reason: "proof_mismatch" }));
    expect(await w.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "proof_mismatch" });
    expect(w.service.asked).toHaveLength(0);
  });

  it("keeps the base adapter's claim methods, and adds none it lacks", async () => {
    const plain: Approvers = { async requirement() { return baseRequirement; }, async verify() { return { approved: false, reason: "x" }; } };
    const w = world(() => loose, plain);
    expect("commitClaim" in w.approvers).toBe(false);
    expect("releaseClaim" in w.approvers).toBe(false);
    expect(typeof world(() => loose, baseApprovers({ approved: false, reason: "x" })).approvers.commitClaim).toBe("function");
  });
});
