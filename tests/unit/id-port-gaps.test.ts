// Owner decision 211 (identity mechanisms live in Code): the four Approvers port gaps Cloud's adapter lists (G1-G4), closed in Code's port, Code's local owner and the fake approvers.
// Every new field is optional and every new operation has a safe default, so an adapter or caller that does not know them behaves as before. Nothing here is switched in: no route or gate reads the new
// fields yet. The pure rules (`signInRulesFor`, `checkApprovalSignInFor`, `checkApproverCount`, `isValidApprovalCardRef`) are what a caller will use when it is.
import { describe, expect, it } from "vitest";
import {
  approvalProofKey, checkApprovalSignInFor, checkApproverCount, isValidApprovalCardRef, signInRulesFor,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalSignInScope, type ApprovalVerdict, type Principal,
} from "@agentx/contracts";
import { LOCAL_SESSION_METHOD, createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { FAKE_ONE_TIME_PART, FAKE_SESSION_METHOD, createFakeApprovers } from "../../packages/broker/src/ports/fake-approvers.js";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();
// Tokens are built at run time: nothing in this file looks like a key.
const token = (...words: string[]): string => words.join("-");
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";

const person = (personId: string, overrides: Partial<Principal> = {}): Principal => ({ companyId: COMPANY, personId, displayName: personId, roles: ["owner"], provider: "example-idp", ...overrides });
const approved = (approver: Principal, extra: Partial<Extract<ApprovalVerdict, { approved: true }>> = {}): Extract<ApprovalVerdict, { approved: true }> =>
  ({ approved: true, approver, method: "m", proofId: `p-${approver.personId}`, ...extra });

const WINDOW_10M = { mode: "window", seconds: 600 } as const;
const WINDOW_1H = { mode: "window", seconds: 3600 } as const;

// ---- G1: a sign-in rule per answer, per risk and per method ----

describe("G1: signInRulesFor (which sign-in rules apply to one answer)", () => {
  it("keeps the older `signIn` meaning exactly: a high-risk approval and every rejection, from every method; never a request for changes, never a low or medium approval", () => {
    const requirement: Pick<ApprovalRequirement, "signIn"> = { signIn: WINDOW_10M };
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "high", method: "a" })).toEqual({ ok: true, rules: [WINDOW_10M] });
    expect(signInRulesFor(requirement, { outcome: "reject", risk: "low", method: "a" })).toEqual({ ok: true, rules: [WINDOW_10M] });
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "medium", method: "a" })).toEqual({ ok: true, rules: [] });
    expect(signInRulesFor(requirement, { outcome: "request_changes", risk: "high", method: "a" })).toEqual({ ok: true, rules: [] });
  });

  it("a request whose risk is not known is treated as high (fail closed)", () => {
    expect(signInRulesFor({ signIn: WINDOW_10M }, { outcome: "approve", risk: undefined, method: "a" })).toEqual({ ok: true, rules: [WINDOW_10M] });
  });

  it("no rule at all when the plug-in names none (Code)", () => {
    expect(signInRulesFor({}, { outcome: "reject", risk: "high", method: "a" })).toEqual({ ok: true, rules: [] });
  });

  it("a scoped rule applies only to its answers, risks and methods (Cloud's medium window from outside places; a browser needs none)", () => {
    const scopes: ApprovalSignInScope[] = [
      { outcomes: ["approve"], risks: ["medium"], methods: ["chat-x"], rule: WINDOW_1H },
      { outcomes: ["reject", "request_changes"], methods: ["chat-x"], rule: WINDOW_1H },
    ];
    const requirement = { signInRules: scopes };
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "medium", method: "chat-x" })).toEqual({ ok: true, rules: [WINDOW_1H] });
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "medium", method: "browser" })).toEqual({ ok: true, rules: [] });
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "low", method: "chat-x" })).toEqual({ ok: true, rules: [] });
    expect(signInRulesFor(requirement, { outcome: "request_changes", risk: "high", method: "chat-x" })).toEqual({ ok: true, rules: [WINDOW_1H] });
    expect(signInRulesFor(requirement, { outcome: "reject", risk: "low", method: "chat-x" })).toEqual({ ok: true, rules: [WINDOW_1H] });
  });

  it("a scoped rule adds to the older rule and never removes it (stricter only)", () => {
    const requirement = { signIn: WINDOW_10M, signInRules: [{ outcomes: ["approve"], risks: ["high"], methods: ["browser"], rule: WINDOW_1H }] as ApprovalSignInScope[] };
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "high", method: "browser" })).toEqual({ ok: true, rules: [WINDOW_10M, WINDOW_1H] });
    expect(signInRulesFor(requirement, { outcome: "approve", risk: "high", method: "other" })).toEqual({ ok: true, rules: [WINDOW_10M] });
  });

  it("an unreadable scope is never skipped: the answer is invalid_rule (fail closed)", () => {
    const bad = (scope: unknown) => signInRulesFor({ signInRules: [scope as ApprovalSignInScope] }, { outcome: "approve", risk: "low", method: "a" });
    expect(bad({ outcomes: [], rule: WINDOW_1H })).toEqual({ ok: false, reason: "invalid_rule" });
    expect(bad({ outcomes: ["approve"], methods: [], rule: WINDOW_1H })).toEqual({ ok: false, reason: "invalid_rule" });
    expect(bad({ outcomes: ["approve"], risks: [], rule: WINDOW_1H })).toEqual({ ok: false, reason: "invalid_rule" });
    expect(bad({ outcomes: ["merge"], rule: WINDOW_1H })).toEqual({ ok: false, reason: "invalid_rule" });
    expect(bad({ outcomes: ["approve"], rule: { mode: "window", seconds: 1 } })).toEqual({ ok: false, reason: "invalid_rule" });
    expect(bad({ outcomes: ["approve"], rule: WINDOW_1H, extra: true })).toEqual({ ok: false, reason: "invalid_rule" });
    expect(signInRulesFor({ signInRules: "nope" as unknown as ApprovalSignInScope[] }, { outcome: "approve", risk: "low", method: "a" })).toEqual({ ok: false, reason: "invalid_rule" });
    // Even when the bad scope is about another answer: a plug-in's rules are data, and one broken entry means none can be trusted.
    expect(signInRulesFor({ signInRules: [{ outcomes: ["reject"], rule: { mode: "nope" } } as unknown as ApprovalSignInScope] }, { outcome: "approve", risk: "low", method: "a" })).toEqual({ ok: false, reason: "invalid_rule" });
  });
});

describe("G1: checkApprovalSignInFor (does this approver's sign-in satisfy every rule that applies)", () => {
  const requirement = { signInRules: [{ outcomes: ["approve"], risks: ["medium"], methods: ["chat-x"], rule: WINDOW_1H }] as ApprovalSignInScope[] };
  const at = { outcome: "approve", risk: "medium", method: "chat-x" } as const;
  const context = { companySignIn: false };

  it("refuses a medium approval from the outside place when the last sign-in is older than the window, and with no sign-in time", () => {
    expect(checkApprovalSignInFor(requirement, at, { authTime: iso(3601) }, NOW, context)).toEqual({ ok: false, reason: "sign_in_too_old" });
    expect(checkApprovalSignInFor(requirement, at, {}, NOW, context)).toEqual({ ok: false, reason: "no_sign_in_time" });
  });

  it("accepts it inside the window, and needs nothing from a place the rule does not name", () => {
    expect(checkApprovalSignInFor(requirement, at, { authTime: iso(60) }, NOW, context)).toEqual({ ok: true });
    expect(checkApprovalSignInFor(requirement, { ...at, method: "browser" }, {}, NOW, context)).toEqual({ ok: true });
  });

  it("every applying rule must hold: the strictest one decides", () => {
    const both = { signIn: WINDOW_10M, signInRules: [{ outcomes: ["reject"], rule: WINDOW_1H }] as ApprovalSignInScope[] };
    expect(checkApprovalSignInFor(both, { outcome: "reject", risk: "low", method: "a" }, { authTime: iso(1200) }, NOW, context)).toEqual({ ok: false, reason: "sign_in_too_old" });
    expect(checkApprovalSignInFor(both, { outcome: "reject", risk: "low", method: "a" }, { authTime: iso(300) }, NOW, context)).toEqual({ ok: true });
    // The looser rule first and the stricter one after it: the later rule still decides.
    const looserFirst = { signIn: WINDOW_1H, signInRules: [{ outcomes: ["reject"], rule: WINDOW_10M }] as ApprovalSignInScope[] };
    expect(checkApprovalSignInFor(looserFirst, { outcome: "reject", risk: "low", method: "a" }, { authTime: iso(1200) }, NOW, context)).toEqual({ ok: false, reason: "sign_in_too_old" });
  });

  it("`any-active` still needs the company's own sign-in, read from the identity adapter (as checkApprovalSignIn)", () => {
    const anyActive = { signInRules: [{ outcomes: ["approve"], rule: { mode: "any-active" } }] as ApprovalSignInScope[] };
    expect(checkApprovalSignInFor(anyActive, { outcome: "approve", risk: "low", method: "a" }, { authTime: iso(99_999) }, NOW, { companySignIn: false })).toEqual({ ok: false, reason: "no_company_sign_in" });
    expect(checkApprovalSignInFor(anyActive, { outcome: "approve", risk: "low", method: "a" }, { authTime: iso(99_999) }, NOW, { companySignIn: true })).toEqual({ ok: true });
  });

  it("an unreadable rule set refuses (invalid_rule), even for an answer it would not cover", () => {
    const broken = { signInRules: [{ outcomes: ["reject"], methods: [] }] as unknown as ApprovalSignInScope[] };
    expect(checkApprovalSignInFor(broken, at, { authTime: iso(1) }, NOW, context)).toEqual({ ok: false, reason: "invalid_rule" });
  });
});

// ---- G2: the sole-approver exception ----

describe("G2: checkApproverCount (how many distinct approvers, and whether the person who asked may be one)", () => {
  const maya = person("maya"), ana = person("ana");
  const twoNoSelf: Pick<ApprovalRequirement, "minApprovers" | "selfApprovalAllowed" | "soleApproverAllowed"> = { minApprovers: 2, selfApprovalAllowed: false };

  it("keeps the older rule: minApprovers distinct people, and no self-approval when it is not allowed", () => {
    expect(checkApproverCount(twoNoSelf, ana, [approved(maya)])).toEqual({ ok: false, reason: "needs_more_approvers" });
    expect(checkApproverCount(twoNoSelf, ana, [approved(maya), approved(maya, { proofId: "again" })])).toEqual({ ok: false, reason: "needs_more_approvers" });
    expect(checkApproverCount(twoNoSelf, ana, [approved(maya), approved(person("li"))])).toEqual({ ok: true });
    expect(checkApproverCount(twoNoSelf, ana, [approved(maya), approved(ana)])).toEqual({ ok: false, reason: "self_approval_not_allowed" });
    expect(checkApproverCount({ minApprovers: 1, selfApprovalAllowed: true }, ana, [approved(ana)])).toEqual({ ok: true });
    expect(checkApproverCount({ minApprovers: 0, selfApprovalAllowed: true }, undefined, [])).toEqual({ ok: false, reason: "needs_more_approvers" });
  });

  it("the same person under another provider is another approver only by the pair (provider, personId)", () => {
    expect(checkApproverCount(twoNoSelf, undefined, [approved(maya), approved(person("maya", { provider: "other-idp" }))])).toEqual({ ok: true });
  });

  it("a verdict marked sole approver lets the person who asked approve alone, only when the requirement allows the exception", () => {
    const allows = { ...twoNoSelf, soleApproverAllowed: true };
    expect(checkApproverCount(allows, ana, [approved(ana, { soleApprover: true })])).toEqual({ ok: true });
    // The adapter's mark is ignored when its requirement did not offer the exception (a mark alone never widens anything).
    expect(checkApproverCount(twoNoSelf, ana, [approved(ana, { soleApprover: true })])).toEqual({ ok: false, reason: "needs_more_approvers" });
    expect(checkApproverCount({ minApprovers: 1, selfApprovalAllowed: false }, ana, [approved(ana, { soleApprover: true })])).toEqual({ ok: false, reason: "self_approval_not_allowed" });
    expect(checkApproverCount({ ...allows, soleApproverAllowed: false }, ana, [approved(ana, { soleApprover: true })])).toEqual({ ok: false, reason: "needs_more_approvers" });
  });

  it("an unmarked verdict never benefits from the exception: the person who asked still cannot approve their own work", () => {
    const allows = { ...twoNoSelf, soleApproverAllowed: true };
    expect(checkApproverCount(allows, ana, [approved(ana)])).toEqual({ ok: false, reason: "needs_more_approvers" });
    expect(checkApproverCount(allows, ana, [approved(maya, { soleApprover: true }), approved(ana)])).toEqual({ ok: false, reason: "self_approval_not_allowed" });
  });

  it("a sole-approver mark from a person other than the one who asked also satisfies the count alone", () => {
    expect(checkApproverCount({ ...twoNoSelf, soleApproverAllowed: true }, ana, [approved(maya, { soleApprover: true })])).toEqual({ ok: true });
  });
});

// ---- G4: the decision card a request is shown on ----

describe("G4: isValidApprovalCardRef", () => {
  it("accepts a card id and the version of it shown, and refuses empty, long or control text", () => {
    expect(isValidApprovalCardRef({ cardId: "approve_plan:t1", contentVersion: "a".repeat(64) })).toBe(true);
    expect(isValidApprovalCardRef({ cardId: "", contentVersion: "1" })).toBe(false);
    expect(isValidApprovalCardRef({ cardId: "c", contentVersion: "" })).toBe(false);
    expect(isValidApprovalCardRef({ cardId: "c".repeat(201), contentVersion: "1" })).toBe(false);
    expect(isValidApprovalCardRef({ cardId: "c", contentVersion: "v".repeat(101) })).toBe(false);
    expect(isValidApprovalCardRef({ cardId: "c\u0000", contentVersion: "1" })).toBe(false);
    expect(isValidApprovalCardRef({ cardId: "c", contentVersion: "1​" })).toBe(false);
    expect(isValidApprovalCardRef({ cardId: "c", contentVersion: 1 })).toBe(false);
    expect(isValidApprovalCardRef(undefined)).toBe(false);
  });
});

// ---- The fake approvers: every gap, as a Cloud-like plug-in would answer ----

const REQUEST: ApprovalRequest = { companyId: COMPANY, requestId: "req-1", kind: "plan", subject: { type: "task", id: "t1" }, revision: 3, artifactDigest: "b".repeat(64), risk: "high" };
const CARD = { cardId: "approve_plan:t1", contentVersion: "b".repeat(64) };
const STEP_UP = "fake-step-up";
const SESSION = token("fake", "session", "maya");
const ONCE = token("fake", "once", "secret", "for", "maya", "0123456789");
let proofs = 0;
const proofFor = (request: ApprovalRequest, overrides: Partial<ApprovalProof> = {}): ApprovalProof =>
  ({ proofId: `proof-${++proofs}`, method: STEP_UP, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token: SESSION, parts: { [FAKE_ONE_TIME_PART]: ONCE }, ...overrides });

function fake(options: { now?: () => number; card?: typeof CARD | undefined } = {}) {
  const maya = person("maya");
  return createFakeApprovers({
    people: [{ token: SESSION, principal: maya, soleApprover: true }],
    methods: [FAKE_SESSION_METHOD, STEP_UP],
    strongMethods: [STEP_UP],
    minApprovers: 2, selfApprovalAllowed: false, soleApproverAllowed: true,
    signInRules: [{ outcomes: ["approve"], risks: ["medium"], methods: [FAKE_SESSION_METHOD], rule: WINDOW_1H }],
    oneTime: [{ method: STEP_UP, token: SESSION, secret: ONCE, ...(options.card === undefined ? {} : { card: options.card }) }],
    now: options.now ?? (() => NOW),
  });
}

describe("fake approvers: the gaps as a plug-in states them", () => {
  it("states its scoped sign-in rules and that it offers the sole-approver exception (G1, G2)", async () => {
    const requirement = await fake().requirement(REQUEST);
    expect(requirement.signInRules).toEqual([{ outcomes: ["approve"], risks: ["medium"], methods: [FAKE_SESSION_METHOD], rule: WINDOW_1H }]);
    expect(requirement.soleApproverAllowed).toBe(true);
  });

  it("marks the sole approver on the verdict (G2)", async () => {
    const verdict = await fake().verify(REQUEST, proofFor(REQUEST, { method: FAKE_SESSION_METHOD, parts: undefined }));
    expect(verdict).toMatchObject({ approved: true, soleApprover: true });
  });

  it("never marks a sole approver when it does not offer the exception (G2)", async () => {
    const approvers = createFakeApprovers({ people: [{ token: SESSION, principal: person("maya"), soleApprover: true }], now: () => NOW });
    expect((await approvers.requirement(REQUEST)).soleApproverAllowed).toBeUndefined();
    const verdict = await approvers.verify(REQUEST, proofFor(REQUEST, { method: FAKE_SESSION_METHOD, parts: undefined }));
    expect(verdict.approved).toBe(true);
    if (verdict.approved) expect(verdict.soleApprover).toBeUndefined();
  });
});

describe("fake approvers G3: a proof with two secrets, claimed by verify and then spent or given back", () => {
  const second = (n: number): ApprovalRequest => ({ ...REQUEST, requestId: `req-1.${String(n)}` });

  it("needs the one-time part: a step-up proof without it, or with another, is refused", async () => {
    const approvers = fake();
    expect((await approvers.verify(REQUEST, proofFor(REQUEST, { parts: undefined }))).approved).toBe(false);
    expect((await approvers.verify(REQUEST, proofFor(REQUEST, { parts: { [FAKE_ONE_TIME_PART]: `${ONCE}x` } }))).approved).toBe(false);
  });

  it("gives no claim to a caller that does not settle claims, and stays read-only for it (the older single-shot verify)", async () => {
    const approvers = fake();
    const verdict = await approvers.verify(REQUEST, proofFor(REQUEST));
    expect(verdict.approved).toBe(true);
    if (verdict.approved) expect(verdict.claimId).toBeUndefined();
    // Not claimed: the same one-time part still checks out for the next attempt (the caller's commit is still the guarantee there).
    expect((await approvers.verify(second(1), proofFor(second(1)))).approved).toBe(true);
  });

  it("claims the one-time part for a caller that settles claims: a second attempt is refused while it is claimed", async () => {
    const approvers = fake();
    const first = await approvers.verify({ ...REQUEST, settlesClaims: true }, proofFor(REQUEST));
    expect(first.approved).toBe(true);
    const claimId = first.approved ? first.claimId : undefined;
    expect(typeof claimId).toBe("string");
    expect(await approvers.verify({ ...second(2), settlesClaims: true }, proofFor(second(2)))).toEqual({ approved: false, reason: "one_time_part_claimed" });
    // Read-only callers are refused too while it is claimed: a claim is a claim.
    expect((await approvers.verify(second(3), proofFor(second(3)))).approved).toBe(false);
  });

  it("a released claim gives the part back; a committed one spends it for ever; settling twice changes nothing", async () => {
    const approvers = fake();
    const first = await approvers.verify({ ...REQUEST, settlesClaims: true }, proofFor(REQUEST));
    const claimId = first.approved ? first.claimId! : "";
    await approvers.releaseClaim!(claimId);
    await approvers.releaseClaim!(claimId);
    const again = await approvers.verify({ ...second(4), settlesClaims: true }, proofFor(second(4)));
    expect(again.approved).toBe(true);
    const againId = again.approved ? again.claimId! : "";
    await approvers.commitClaim!(againId);
    await approvers.releaseClaim!(againId);
    await approvers.commitClaim!(againId);
    expect(await approvers.verify({ ...second(5), settlesClaims: true }, proofFor(second(5)))).toEqual({ approved: false, reason: "one_time_part_spent" });
    expect((await approvers.verify(second(6), proofFor(second(6)))).approved).toBe(false);
  });

  it("an unknown claim id is a no-op, and a claim the caller never settles lapses by itself", async () => {
    let now = NOW;
    const approvers = fake({ now: () => now });
    await approvers.commitClaim!("no-such-claim");
    await approvers.releaseClaim!("no-such-claim");
    expect((await approvers.verify({ ...REQUEST, settlesClaims: true }, proofFor(REQUEST))).approved).toBe(true);
    expect((await approvers.verify({ ...second(7), settlesClaims: true }, proofFor(second(7)))).approved).toBe(false);
    now += 10 * 60_000;
    expect((await approvers.verify({ ...second(8), settlesClaims: true }, proofFor(second(8)))).approved).toBe(true);
  });

  it("the single-use key of a proof is unchanged by its parts (stored markers keep their keys)", () => {
    const base = { method: STEP_UP, token: SESSION, requestId: "r" };
    expect(approvalProofKey({ ...base, parts: { [FAKE_ONE_TIME_PART]: ONCE } } as Parameters<typeof approvalProofKey>[0])).toBe(approvalProofKey(base));
  });
});

describe("fake approvers G4: a step-up bound to the card and the version shown", () => {
  it("accepts the proof for the card and version it was issued for", async () => {
    expect((await fake({ card: CARD }).verify({ ...REQUEST, card: CARD }, proofFor(REQUEST))).approved).toBe(true);
  });

  it("refuses it for a request that names no card, another card, another version, or a card that cannot be read", async () => {
    const approvers = fake({ card: CARD });
    expect(await approvers.verify(REQUEST, proofFor(REQUEST))).toEqual({ approved: false, reason: "card_not_named" });
    expect(await approvers.verify({ ...REQUEST, card: { ...CARD, cardId: "approve_plan:t2" } }, proofFor(REQUEST))).toEqual({ approved: false, reason: "other_card" });
    expect(await approvers.verify({ ...REQUEST, card: { ...CARD, contentVersion: "c".repeat(64) } }, proofFor(REQUEST))).toEqual({ approved: false, reason: "other_card" });
    expect(await approvers.verify({ ...REQUEST, card: { cardId: "", contentVersion: "1" } }, proofFor(REQUEST))).toEqual({ approved: false, reason: "card_not_named" });
  });
});

// ---- Code's local owner: the safe default for each gap ----

describe("local owner: each gap's absent value, which changes nothing", () => {
  const owner = localOwnerPrincipal();
  const SESSION_TOKEN = token("local", "owner", "page", "proof");
  const local = () => createLocalOwnerApprovers({ owner, verifySession: (value) => value === SESSION_TOKEN });
  const request: ApprovalRequest = { ...REQUEST, companyId: owner.companyId };
  const proof = (overrides: Partial<ApprovalProof> = {}): ApprovalProof => ({ proofId: `lp-${++proofs}`, method: LOCAL_SESSION_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token: SESSION_TOKEN, ...overrides });

  it("names no scoped sign-in rule and does not offer the sole-approver exception (G1, G2): the requirement is what it was", async () => {
    expect(await local().requirement(request)).toEqual({ methods: [LOCAL_SESSION_METHOD], minApprovers: 1, selfApprovalAllowed: true, strongMethods: [LOCAL_SESSION_METHOD], rejectMethods: [LOCAL_SESSION_METHOD], changesMethods: [LOCAL_SESSION_METHOD] });
  });

  it("never claims (G3): no claim id even for a caller that settles claims, no claim operations, and extra parts change nothing", async () => {
    const approvers = local();
    expect("commitClaim" in approvers).toBe(false);
    expect("releaseClaim" in approvers).toBe(false);
    const verdict = await approvers.verify({ ...request, settlesClaims: true }, proof({ parts: { extra: "ignored" } }));
    expect(verdict.approved).toBe(true);
    if (verdict.approved) {
      expect(verdict.claimId).toBeUndefined();
      expect(verdict.soleApprover).toBeUndefined();
    }
    expect((await approvers.verify(request, proof({ token: "guess", parts: { extra: SESSION_TOKEN } }))).approved).toBe(false);
  });

  it("accepts a request that names a card exactly as one that does not (G4: the local owner binds proofs by request, revision and digest)", async () => {
    expect((await local().verify({ ...request, card: CARD }, proof())).approved).toBe(true);
  });
});
