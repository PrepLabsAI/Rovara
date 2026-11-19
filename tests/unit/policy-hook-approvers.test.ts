// Lane H: "may this person decide this? is the sign-in fresh enough? is a second person needed?". Stricter only, refused at once with no answer. Owner row
// 11.5 (loosening a setting needs a second admin) is the "second person needed" answer.
import { describe, expect, it } from "vitest";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { personPressOf, stricterRequirement, withPolicyHookApprovers } from "../../packages/broker/src/core/policy-hook/approvers.js";
import { checkApproverCount, type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type Principal } from "../../packages/contracts/src/index.js";
import { COMPANY, ISSUER, fakeService, makeKey, memoryAudit, settingsFor, signerOf } from "./policy-hook-fixture.js";
import { mergeWorld, TASK_ID } from "../support/merge-world.js";
import { pressMergeAsPerson } from "../../packages/broker/src/core/merge/merge.js";

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
  let clock = T0;
  const service = fakeService({ key: hookKey, now: () => clock, answer });
  const audit = memoryAudit();
  const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch, now: () => clock, audit: audit.sink });
  return { approvers: withPolicyHookApprovers(base, client, { now: () => clock }), service, audit, advance: (ms: number) => { clock += ms; } };
}

const loose = { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true };

describe("policy hook: decisions", () => {
  it("a website press asks as the task creator, even when another person presses; request data cannot supply the requester", async () => {
    const worldMerge = await mergeWorld();
    await worldMerge.seedTracking();
    const creator = person("task-creator");
    const presser = person("different-presser");
    const requests: ApprovalRequest[] = [];
    const asked: Array<{ by?: string; per?: string; stage?: string }> = [];
    const deps = {
      ...worldMerge.deps,
      requesterOf: async () => creator,
      personPress: async (req: ApprovalRequest, by: Principal) => {
        requests.push(req);
        const serviceWorld = world(() => loose, baseApprovers({ approved: false, reason: "unused" }));
        const prepared = await personPressOf(serviceWorld.approvers)!.decideForPerson(req, by);
        asked.push(serviceWorld.service.asked[0]!.q);
        return prepared;
      },
    };
    const prepared = await (await import("../../packages/broker/src/core/merge/merge.js")).prepareMerge(deps, { taskId: TASK_ID, requestId: worldMerge.requestId() });
    expect(prepared.request.requestedBy).toEqual(creator);
    expect(prepared.request.requestedBy).not.toEqual(presser);
    expect(await pressMergeAsPerson(deps, { taskId: TASK_ID, requestId: worldMerge.requestId(), presserPersonId: presser.personId, presser, expectedHeads: worldMerge.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })) })).toMatchObject({ status: "MERGED" });
    expect(requests.at(-1)?.requestedBy).toEqual(creator);
    expect(asked.at(-1)).toMatchObject({ stage: "verdict", by: "task-creator", per: "different-presser" });
  });

  it("refuses a website press with no resolved task creator before asking rules or merging", async () => {
    const merge = await mergeWorld();
    await merge.seedTracking();
    let asked = false;
    const deps = { ...merge.deps, requesterOf: async () => undefined, personPress: async () => { asked = true; return { allowed: true as const }; } };
    await expect(pressMergeAsPerson(deps, { taskId: TASK_ID, requestId: merge.requestId(), presserPersonId: "different-presser", presser: person("different-presser") })).rejects.toThrow("someone other than the requester must merge");
    expect(asked).toBe(false);
  });

  it("website press uses the verdict transport and fails closed for service refusal, no answer, and a raised approver count", async () => {
    const other = person("admin-b");
    const allow = world(() => loose, baseApprovers({ approved: false, reason: "unused" }));
    const decision = (req: ApprovalRequest, approver: Principal) => personPressOf(allow.approvers)!.decideForPerson(req, approver);
    expect(await decision(request(), other)).toEqual({ allowed: true });
    expect(allow.service.asked.map((asked) => asked.q.stage)).toEqual(["verdict"]);
    expect(await personPressOf(world(() => ({ ...loose, allow: false }), baseApprovers({ approved: false, reason: "unused" })).approvers)!.decideForPerson(request(), other)).toEqual({ allowed: false, reason: "company_rules_refused" });
    expect(await personPressOf(world(() => new Error("offline"), baseApprovers({ approved: false, reason: "unused" })).approvers)!.decideForPerson(request(), other)).toEqual({ allowed: false, reason: "company_rules_no_answer" });
    expect(await personPressOf(world(() => ({ ...loose, minApprovers: 2 }), baseApprovers({ approved: false, reason: "unused" })).approvers)!.decideForPerson(request(), other)).toEqual({ allowed: false, reason: "company_rules_refused" });
  });

  it("a second-person rule refuses the task creator and permits another person", async () => {
    const w = world(() => ({ ...loose, secondPerson: true }), baseApprovers({ approved: false, reason: "unused" }));
    const decide = (req: ApprovalRequest, approver: Principal) => personPressOf(w.approvers)!.decideForPerson(req, approver);
    const req = request({ requestedBy: asker });
    expect(await decide(req, asker)).toEqual({ allowed: false, reason: "self_approval_not_allowed" });
    expect(await decide(req, person("admin-b"))).toEqual({ allowed: true });
  });

  it("row 11.5: a second person needed means the asker cannot approve, no sole approver", async () => {
    const w = world(() => ({ ...loose, secondPerson: true }), baseApprovers({ approved: true, approver: asker, method: "local-session", proofId: "p1", soleApprover: true }));
    const requirement = await w.approvers.requirement(request());
    expect(requirement).toEqual({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: false });
    expect(await w.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "self_approval_not_allowed" });
    expect(w.service.asked.map((asked) => asked.q)).toEqual([{ cid: COMPANY, pid: "web", stage: "verdict", what: "setting.loosen", styp: "setting", sid: "review_mode", risk: "high", by: "admin-a", per: "admin-a" }]);
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

  it("stricter only: a looser answer never loosens the install's requirement, and the install's own sign-in rule is kept as it was", () => {
    const strict: ApprovalRequirement = { methods: ["local-session"], minApprovers: 3, selfApprovalAllowed: false, signIn: { mode: "window", seconds: 300 } };
    expect(stricterRequirement(strict, { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true, signInMaxAgeSeconds: 86_400 }, request())).toEqual(strict);
    expect(stricterRequirement(strict, { allow: true, minApprovers: 5, secondPerson: false, selfApproval: true }, request())).toEqual({ ...strict, minApprovers: 5 });
    expect(stricterRequirement(baseRequirement, loose, request())).toEqual(baseRequirement);
    // A second person needed rules out self-approval even if the same answer says self-approval is fine.
    expect(stricterRequirement(baseRequirement, { ...loose, secondPerson: true, selfApproval: true }, request()).selfApprovalAllowed).toBe(false);
  });

  it("DEC 254zzz73: an answer's signInMaxAgeSeconds (a re-sign-in window) is accepted on the wire and ignored: it adds no sign-in rule and refuses no verdict", async () => {
    expect(stricterRequirement(baseRequirement, { ...loose, signInMaxAgeSeconds: 60 }, request())).toEqual(baseRequirement);
    expect(stricterRequirement(baseRequirement, { ...loose, signInMaxAgeSeconds: 0 }, request()).signIn).toBeUndefined();
    const answer = () => ({ ...loose, signInMaxAgeSeconds: 600 });
    for (const approver of [person("admin-b", new Date(T0 - 3_600_000).toISOString()), person("admin-b"), person("admin-b", new Date(T0 + 120_000).toISOString())]) {
      expect((await world(answer, baseApprovers({ approved: true, approver, method: "m", proofId: "p1" })).approvers.verify(request(), proof)).approved).toBe(true);
    }
    // The other parts of the same answer still bind: a "no" refuses.
    expect(await world(() => ({ ...loose, allow: false, signInMaxAgeSeconds: 600 }), baseApprovers({ approved: true, approver: person("admin-b"), method: "m", proofId: "p1" })).approvers.verify(request(), proof)).toEqual({ approved: false, reason: "company_rules_refused" });
  });

  it("reading the requirement (pages, probes) never asks: the stricter default first, then the last known answer", async () => {
    const other = person("admin-b");
    const w = world(() => loose, baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1" }));
    expect(await w.approvers.requirement(request())).toEqual({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: false });
    expect(await w.approvers.requirement(request({ requestId: "probe" }))).toEqual({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: false });
    expect(w.service.asked).toHaveLength(0);
    expect((await w.approvers.verify(request(), proof)).approved).toBe(true);
    expect(w.service.asked).toHaveLength(1);
    expect(await w.approvers.requirement(request({ requestId: "req-2" }))).toEqual(baseRequirement);
    expect(w.service.asked).toHaveLength(1);
    // With the service down, reading still answers (the last known requirement), and a real decision refuses at once.
    const down = world(() => new Response("down", { status: 503 }), baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1" }));
    expect((await down.approvers.requirement(request())).selfApprovalAllowed).toBe(false);
    expect(await down.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "company_rules_no_answer" });
  });

  it("rules got stricter since the requirement was handed out: the verdict is refused, and the next requirement carries the new rule", async () => {
    const other = person("admin-b");
    let answer = loose;
    const w = world(() => answer, baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1" }));
    await w.approvers.verify(request(), proof);
    expect(await w.approvers.requirement(request({ requestId: "req-2" }))).toEqual(baseRequirement);
    answer = { ...loose, minApprovers: 3 };
    expect(await w.approvers.verify(request({ requestId: "req-2" }), { ...proof, requestId: "req-2" })).toEqual({ approved: false, reason: "company_rules_changed" });
    // The same request stays held to the count first handed out (another caller may still count with it), even after a stricter read.
    expect((await w.approvers.requirement(request({ requestId: "req-2" }))).minApprovers).toBe(3);
    expect(await w.approvers.verify(request({ requestId: "req-2" }), { ...proof, requestId: "req-2" })).toEqual({ approved: false, reason: "company_rules_changed" });
    // A new request reads the new rule and passes; the old one recovers once its entry lapses (10 minutes).
    expect((await w.approvers.requirement(request({ requestId: "req-3" }))).minApprovers).toBe(3);
    expect((await w.approvers.verify(request({ requestId: "req-3" }), { ...proof, requestId: "req-3" })).approved).toBe(true);
    w.advance(10 * 60_000);
    await w.approvers.verify(request({ requestId: "req-4" }), { ...proof, requestId: "req-4" });
    expect((await w.approvers.requirement(request({ requestId: "req-2" }))).minApprovers).toBe(3);
    expect((await w.approvers.verify(request({ requestId: "req-2" }), { ...proof, requestId: "req-2" })).approved).toBe(true);
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


  it("a stricter count or no self-approval turns the install's sole-approver exception off", async () => {
    expect(stricterRequirement(baseRequirement, { ...loose, minApprovers: 2 }, request()).soleApproverAllowed).toBeUndefined();
    expect(stricterRequirement(baseRequirement, { ...loose, selfApproval: false }, request()).soleApproverAllowed).toBeUndefined();
    expect(stricterRequirement(baseRequirement, loose, request()).soleApproverAllowed).toBe(true);
    const sole = { approved: true as const, approver: asker, method: "local-session", proofId: "p1", soleApprover: true as const };
    expect(await world(() => ({ ...loose, selfApproval: false }), baseApprovers(sole)).approvers.verify(request(), proof)).toEqual({ approved: false, reason: "self_approval_not_allowed" });
    const two = world(() => ({ ...loose, minApprovers: 2 }), baseApprovers(sole));
    expect(await two.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "company_rules_changed" });
    expect(await two.approvers.requirement(request())).toEqual({ methods: ["local-session"], minApprovers: 2, selfApprovalAllowed: true });
    expect(await two.approvers.verify(request(), proof)).toEqual({ approved: true, approver: asker, method: "local-session", proofId: "p1" });
  });


  it("a cached answer is used only while it is alive, and a no is kept as the stricter default", async () => {
    const other = person("admin-b");
    let answer: Record<string, unknown> = loose;
    const w = world(() => answer, baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1" }));
    await w.approvers.verify(request(), proof);
    expect(await w.approvers.requirement(request({ requestId: "r2" }))).toEqual(baseRequirement);
    w.advance(61_000);
    expect((await w.approvers.requirement(request({ requestId: "r3" }))).selfApprovalAllowed).toBe(false);
    answer = { ...loose, allow: false };
    expect((await w.approvers.verify(request({ requestId: "r4" }), { ...proof, requestId: "r4" })).approved).toBe(false);
    expect((await w.approvers.requirement(request({ requestId: "r5" }))).selfApprovalAllowed).toBe(false);
    // The answer is kept per asker: another person's request does not read it.
    answer = loose;
    await w.approvers.verify(request({ requestId: "r6" }), { ...proof, requestId: "r6" });
    expect((await w.approvers.requirement(request({ requestId: "r7", requestedBy: person("admin-c") }))).selfApprovalAllowed).toBe(false);
  });

  it("the loosest count handed out for a request is what verify checks, even after a stricter read of the same request", async () => {
    const other = person("admin-b");
    let answer = loose;
    const w = world(() => answer, baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1" }));
    await w.approvers.verify(request({ requestId: "warm" }), { ...proof, requestId: "warm" });
    expect((await w.approvers.requirement(request())).minApprovers).toBe(1);
    answer = { ...loose, minApprovers: 2 };
    await w.approvers.verify(request({ requestId: "other" }), { ...proof, requestId: "other" });
    expect((await w.approvers.requirement(request())).minApprovers).toBe(2);
    expect(await w.approvers.verify(request(), proof)).toEqual({ approved: false, reason: "company_rules_changed" });
  });

  it("a caller that never read the requirement here is held to the install's own count", async () => {
    const other = person("admin-b");
    const noAsker: ApprovalRequest = { ...request() };
    delete noAsker.requestedBy;
    const w = world(() => ({ ...loose, secondPerson: true }), baseApprovers({ approved: true, approver: other, method: "local-session", proofId: "p1" }));
    expect(await w.approvers.verify(noAsker, proof)).toEqual({ approved: false, reason: "company_rules_changed" });
    expect((await w.approvers.verify(request(), proof)).approved).toBe(true);
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
