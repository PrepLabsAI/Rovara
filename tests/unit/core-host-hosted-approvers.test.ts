// Switch-on lane L2a: the deployed approvers point. The task owner (the broker's existing rule), a live member, a fresh step-up proved for one act and bound to its card, and the act's
// one-time part claimed in the company's own partition (commit spends it, release gives a live claim back, a lapsed claim stays spent).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NEEDS_SETTLING_CALLER, type ApprovalAnswer, type ApprovalProof, type ApprovalRequest, type IdentityProvider, type OrgId,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  STEP_UP_APPROVAL_METHOD, STEP_UP_CLAIM_MS, STEP_UP_PROOF_LIFETIME_MS, createHostedApprovers, issueStepUpApproval, stepUpApprovalKeyOf, stepUpClaimKey, type StepUpApprovalInput,
} from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity, hostedSecurityModules } from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { approvalSignInSettingKey } from "../../packages/broker/src/core/decisions/sign-in-setting.js";
import { createDecisionGate, type DecisionSubject } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { withPolicyHookApprovers } from "../../packages/broker/src/core/policy-hook/approvers.js";
import { runApproversConformance } from "../support/ports/policy-conformance.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const TASK_A = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK_B = "1f0e9d8c-7b6a-4594-8382-716f5e4d3c2b";
const DIGEST = "a".repeat(64);
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const SIGNING_KEY = "callback-signing-key-for-tests-0123456789abcdef";
const KEY = stepUpApprovalKeyOf(SIGNING_KEY);
const STEP_UP = { at: new Date(NOW - 60_000).toISOString(), method: "passkey" };

/** Ada owns TASK_A in company A; Bea is another member of A; Cy owns TASK_B in company B. */
const MEMBERS: Record<string, { companyId: OrgId; role: "member" | "admin" }> = { ada: { companyId: A, role: "member" }, bea: { companyId: A, role: "admin" }, cy: { companyId: B, role: "member" } };
const identity = (overrides: Partial<Record<string, { companyId: OrgId; role: "member" | "admin" } | undefined>> = {}): IdentityProvider => createHostedIdentity({
  membershipOf: async (personId) => (personId in overrides ? overrides[personId] : MEMBERS[personId]),
  displayNameOf: async (personId) => (personId in MEMBERS ? personId.toUpperCase() : undefined),
});

function seededStore(): MemoryDocumentStore {
  const store = new MemoryDocumentStore();
  void store.put({ item: { ...taskKey(TASK_A), entityType: "DEVELOPER_TASK", taskId: TASK_A, companyId: A, developerId: "ada", project: "demo" } });
  void store.put({ item: { ...taskKey(TASK_B), entityType: "DEVELOPER_TASK", taskId: TASK_B, companyId: B, developerId: "cy", project: "demo" } });
  return store;
}

const cardOf = (taskId: string, version = DIGEST) => ({ cardId: `approve_plan:${taskId}`, contentVersion: version });
const requestFor = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  companyId: A, requestId: "decision-request-0001", kind: "plan", subject: { type: "task", id: TASK_A }, projectName: "demo", revision: 3, artifactDigest: DIGEST,
  risk: "high", outcome: "approve", card: cardOf(TASK_A), settlesClaims: true, ...overrides,
});
const input = (overrides: Partial<StepUpApprovalInput> = {}): StepUpApprovalInput => ({
  companyId: A, personId: "ada", stepUp: STEP_UP, requestId: "decision-request-0001", kind: "plan", taskId: TASK_A, revision: 3, artifactDigest: DIGEST, outcome: "approve", card: cardOf(TASK_A), ...overrides,
});
let proofs = 0;
const proofFor = (request: ApprovalRequest, token: string): ApprovalProof => ({
  proofId: `proof-${++proofs}`, method: STEP_UP_APPROVAL_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token,
});
const issued = (overrides: Partial<StepUpApprovalInput> = {}, at = NOW): string => issueStepUpApproval(KEY, input(overrides), at).token;

function world(options: { now?: () => number; key?: Buffer | undefined; identity?: IdentityProvider } = {}) {
  const store = seededStore();
  const clock = { now: NOW };
  const approvers = createHostedApprovers({ store, identity: options.identity ?? identity(), key: "key" in options ? options.key : KEY, now: () => new Date(options.now?.() ?? clock.now) });
  return { store, clock, approvers };
}

// ---- the port's own suite

const STANDING = issued();
runApproversConformance("deployed approvers (task owner, fresh step-up, card-bound one-time proof)", {
  create: async () => world().approvers,
  request: requestFor(),
  acceptable: proofFor(requestFor(), STANDING),
  forgedToken: `${STANDING.slice(0, -4)}AAAA`,
  claims: {
    proof: proofFor(requestFor(), STANDING),
    withClock: async () => {
      let now = NOW;
      return { approvers: world({ now: () => now }).approvers, lapse: () => { now += STEP_UP_CLAIM_MS + 1_000; } };
    },
  },
  cardBound: { request: requestFor(), proof: proofFor(requestFor(), STANDING) },
});

describe("the deployed approvers point", () => {
  it("offers one method for every answer, a step-up within the default ten minutes, and the task owner may approve their own task", async () => {
    expect(await world().approvers.requirement(requestFor())).toEqual({
      methods: [STEP_UP_APPROVAL_METHOD], minApprovers: 1, selfApprovalAllowed: true,
      strongMethods: [STEP_UP_APPROVAL_METHOD], rejectMethods: [STEP_UP_APPROVAL_METHOD], changesMethods: [STEP_UP_APPROVAL_METHOD],
      signIn: { mode: "window", seconds: 600 },
    });
  });

  it("names the task owner, from membership, with the step-up as the sign-in time and factor, and claims the one-time part in the company's partition", async () => {
    const { approvers, store } = world();
    const request = requestFor();
    const verdict = await approvers.verify(request, proofFor(request, issued()));
    expect(verdict).toMatchObject({ approved: true, method: STEP_UP_APPROVAL_METHOD, approver: { companyId: A, personId: "ada", provider: HOSTED_IDENTITY_PROVIDER, roles: ["member"], authTime: STEP_UP.at, methods: ["passkey"] } });
    const claimId = verdict.approved ? verdict.claimId! : "";
    const [company, hash] = claimId.split(".");
    expect(company).toBe(A);
    expect(await store.get(stepUpClaimKey(A, hash!))).toMatchObject({ entityType: "APPROVAL_STEP_UP_CLAIM", companyId: A, state: "claimed" });
    expect((await store.get(stepUpClaimKey(A, hash!)))?.pk).toBe(`ORG#${A}#APPROVAL_STEP_UP_CLAIM`);
  });

  it("works under the policy hook's stricter-only wrapper without losing the claim operations", async () => {
    const { approvers } = world();
    const hook = { prepare: async () => ({}) as never, send: async () => ({ answered: true as const, answer: { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true }, expiresAt: NOW + 60_000 }), audit: async () => undefined };
    const wrapped = withPolicyHookApprovers(approvers, hook as never, { now: () => NOW });
    expect(typeof wrapped.commitClaim).toBe("function");
    const request = requestFor();
    const verdict = await wrapped.verify(request, proofFor(request, issued()));
    expect(verdict.approved).toBe(true);
    expect(await wrapped.commitClaim!(verdict.approved ? verdict.claimId! : "")).toEqual({ applied: true });
  });

  describe("refuses, with a fixed reason, and never burns the proof on a refusal", () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => Promise<{ request: ApprovalRequest; proof: ApprovalProof }>, string]> = [
      ["a method it does not offer", async () => { const r = requestFor(); return { request: r, proof: { ...proofFor(r, issued()), method: "code-host-comment" } }; }, "unknown_method"],
      ["a caller that does not settle claims", async () => { const r = requestFor(); const { settlesClaims: _drop, ...plain } = r; void _drop; return { request: plain, proof: proofFor(r, issued()) }; }, NEEDS_SETTLING_CALLER],
      ["a subject that is not a task", async () => { const r = requestFor({ subject: { type: "project", id: TASK_A } }); return { request: r, proof: proofFor(r, issued()) }; }, "no_rule_for_this_request"],
      ["a malformed company", async () => { const r = requestFor({ companyId: "not-a-company" }); return { request: r, proof: proofFor(r, issued()) }; }, "no_rule_for_this_request"],
      ["a token it did not sign", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issueStepUpApproval(stepUpApprovalKeyOf("another-install-key-0123456789abcdef"), input(), NOW).token) }; }, "not_a_valid_proof"],
      ["an empty token", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, "") }; }, "not_a_valid_proof"],
      ["a proof issued for another decision", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ requestId: "decision-request-0002" })) }; }, "other_request"],
      ["a proof issued for another kind of decision", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ kind: "design" })) }; }, "other_kind"],
      ["a proof issued for another task", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ taskId: TASK_B, card: cardOf(TASK_B) })) }; }, "other_subject"],
      ["a proof issued for another revision", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ revision: 2 })) }; }, "other_revision"],
      ["a proof issued for other content", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ artifactDigest: "b".repeat(64), card: cardOf(TASK_A, "b".repeat(64)) })) }; }, "other_content"],
      ["a proof issued for another answer", async () => { const r = requestFor({ outcome: "reject" }); return { request: r, proof: proofFor(r, issued({ outcome: "approve" })) }; }, "other_answer"],
      ["an approval proof for a request that names no answer is an approval; a rejection proof is not", async () => { const { outcome: _o, ...r } = requestFor(); void _o; return { request: r, proof: proofFor(r, issued({ outcome: "reject" })) }; }, "other_answer"],
      ["a request that names no card", async () => { const { card: _c, ...r } = requestFor(); void _c; return { request: r, proof: proofFor(r, issued()) }; }, "card_not_named"],
      ["a card the proof was not issued for", async () => { const r = requestFor({ card: { cardId: `spec_choice:${TASK_A}`, contentVersion: DIGEST } }); return { request: r, proof: proofFor(r, issued()) }; }, "other_card"],
      ["a card of another task", async () => { const card = cardOf(TASK_B); const r = requestFor({ card }); return { request: r, proof: proofFor(r, issued({ card })) }; }, "card_not_for_this_request"],
      ["a card version that is not the content seen", async () => { const card = cardOf(TASK_A, "v2"); const r = requestFor({ card }); return { request: r, proof: proofFor(r, issued({ card })) }; }, "card_not_for_this_request"],
      ["a proof past its two minutes", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({}, NOW - STEP_UP_PROOF_LIFETIME_MS)) }; }, "proof_expired"],
      ["a request past its own expiry", async () => { const r = requestFor({ expiresAt: new Date(NOW).toISOString() }); return { request: r, proof: proofFor(r, issued()) }; }, "expired"],
      ["a step-up older than ten minutes", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ stepUp: { at: new Date(NOW - 600_001).toISOString(), method: "passkey" } })) }; }, "sign_in_not_fresh"],
      ["a step-up from the future beyond the clock skew", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ stepUp: { at: new Date(NOW + 120_001).toISOString(), method: "email_code" } })) }; }, "sign_in_not_fresh"],
      ["a person who is not a member any more", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued()) }; }, "not_a_member"],
      ["another member of the company who is not the task owner", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({ personId: "bea" })) }; }, "not_the_task_owner"],
      ["a project the task is not in", async () => { const r = requestFor({ projectName: "other" }); return { request: r, proof: proofFor(r, issued()) }; }, "not_the_task_owner"],
    ];
    it.each(cases)("%s", async (name, build, reason) => {
      const w = name.startsWith("a person who is not") ? world({ identity: identity({ ada: undefined }) }) : world();
      const { request, proof } = await build(w);
      const verdict = await w.approvers.verify(request, proof);
      expect(verdict).toEqual({ approved: false, reason });
      // Fixed words: no token, person or content in the reason.
      if (proof.token !== "") expect(JSON.stringify(verdict)).not.toContain(proof.token.slice(4, 24));
      expect(JSON.stringify(verdict)).not.toContain("ada");
      // Nothing was claimed in either company: a refusal never burns a proof.
      for (const company of [A, B]) expect((await w.store.query({ pk: `ORG#${company}#APPROVAL_STEP_UP_CLAIM` })).items).toEqual([]);
    });

    it("refuses a step-up factor Code does not own, and an unreadable people read, without throwing", async () => {
      expect(() => issueStepUpApproval(KEY, input({ stepUp: { at: STEP_UP.at, method: "slack" } }), NOW)).toThrow("a step-up approval cannot be issued for this input");
      const failing = world({ identity: { capabilities: { interactiveSignIn: false, externalAccounts: false }, getPrincipal: async () => { throw new Error("dynamo down ada"); } } as unknown as IdentityProvider });
      const request = requestFor();
      expect(await failing.approvers.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "people_unreadable" });
    });

    it("refuses every proof on a host with no proof key (the dispatcher)", async () => {
      const request = requestFor();
      expect(await world({ key: undefined }).approvers.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "method_not_available" });
    });
  });

  it("refuses a window longer than the default, or shorter than a minute", () => {
    for (const windowSeconds of [601, 59, 1.5]) {
      expect(() => createHostedApprovers({ store: new MemoryDocumentStore(), identity: identity(), key: KEY, windowSeconds, now: () => new Date(NOW) })).toThrow(/step-up window/u);
    }
  });

  it("the one-time part: a second verify while claimed is refused; release frees it; commit spends it for ever; a lapsed claim stays spent", async () => {
    const { approvers, clock } = world();
    const token = issued();
    const attempt = (n: string) => { const request = requestFor({ requestId: `decision-request-0001.${n}` }); return approvers.verify(request, proofFor(request, token)); };
    const first = await attempt("a");
    expect((await attempt("b")).approved).toBe(false);
    await approvers.releaseClaim!(first.approved ? first.claimId! : "");
    const second = await attempt("c");
    expect(await approvers.commitClaim!(second.approved ? second.claimId! : "")).toEqual({ applied: true });
    expect(await attempt("d")).toEqual({ approved: false, reason: "proof_already_used" });
    // Another proof, claimed and never settled: after the claim window it is spent, and neither commit nor release changes that.
    const other = issued();
    const request = requestFor({ requestId: "decision-request-0001.e" });
    const lapsing = await approvers.verify(request, proofFor(request, other));
    clock.now += STEP_UP_CLAIM_MS;
    const claimId = lapsing.approved ? lapsing.claimId! : "";
    expect(await approvers.commitClaim!(claimId)).toEqual({ applied: false });
    await approvers.releaseClaim!(claimId);
    const again = requestFor({ requestId: "decision-request-0001.f" });
    expect(await approvers.verify(again, proofFor(again, other))).toEqual({ approved: false, reason: "proof_already_used" });
  });

  it("settles nothing for a malformed or guessed claim id", async () => {
    const { approvers } = world();
    const request = requestFor();
    const verdict = await approvers.verify(request, proofFor(request, issued()));
    const claimId = verdict.approved ? verdict.claimId! : "";
    const guessed = `${claimId.slice(0, claimId.lastIndexOf(".") + 1)}00000000-0000-4000-8000-000000000000`;
    expect(await approvers.commitClaim!(guessed)).toEqual({ applied: false });
    await approvers.releaseClaim!(guessed);
    for (const bad of ["", "nonsense", `${claimId}x`, 42 as unknown as string]) expect(await approvers.commitClaim!(bad)).toEqual({ applied: false });
    // The real claim is untouched by all of that.
    expect(await approvers.commitClaim!(claimId)).toEqual({ applied: true });
  });
});

describe("review round 1 (Lows)", () => {
  it("a company's own shorter fresh sign-in window binds the step-up; a longer one never widens the install's", async () => {
    const { approvers, store } = world();
    await store.put({ item: { ...approvalSignInSettingKey(A), revision: 1, setting: { mode: "window", seconds: 120 } } });
    expect((await approvers.requirement(requestFor())).signIn).toEqual({ mode: "window", seconds: 120 });
    const old = requestFor();
    expect(await approvers.verify(old, proofFor(old, issued({ stepUp: { at: new Date(NOW - 121_000).toISOString(), method: "passkey" } })))).toEqual({ approved: false, reason: "sign_in_not_fresh" });
    const recent = requestFor();
    expect((await approvers.verify(recent, proofFor(recent, issued({ stepUp: { at: new Date(NOW - 119_000).toISOString(), method: "passkey" } })))).approved).toBe(true);
    // A longer setting keeps ten minutes.
    const other = world();
    await other.store.put({ item: { ...approvalSignInSettingKey(A), revision: 1, setting: { mode: "window", seconds: 86_400 } } });
    expect((await other.approvers.requirement(requestFor())).signIn).toEqual({ mode: "window", seconds: 600 });
    const late = requestFor();
    expect(await other.approvers.verify(late, proofFor(late, issued({ stepUp: { at: new Date(NOW - 600_001).toISOString(), method: "passkey" } })))).toEqual({ approved: false, reason: "sign_in_not_fresh" });
  });

  it("a step-up factor Code does not own is refused even in a token signed with the install's key", async () => {
    const { approvers } = world();
    const body = Buffer.from(JSON.stringify({ c: A, p: "ada", r: "decision-request-0001", q: "plan", s: TASK_A, v: 3, d: DIGEST, o: "approve", k: [cardOf(TASK_A).cardId, DIGEST], a: STEP_UP.at, m: "slack", e: NOW + 60_000, n: "n".repeat(43) })).toString("base64url");
    const token = `su1.${body}.${createHmac("sha256", KEY).update(`su1.${body}`).digest("base64url")}`;
    const request = requestFor();
    expect(await approvers.verify(request, proofFor(request, token))).toEqual({ approved: false, reason: "sign_in_not_fresh" });
    // The same token with a factor Code owns is accepted (the hand-signed form is the issuer's).
    const good = Buffer.from(JSON.stringify({ c: A, p: "ada", r: "decision-request-0001", q: "plan", s: TASK_A, v: 3, d: DIGEST, o: "approve", k: [cardOf(TASK_A).cardId, DIGEST], a: STEP_UP.at, m: "passkey", e: NOW + 60_000, n: "n".repeat(43) })).toString("base64url");
    expect((await approvers.verify(request, proofFor(request, `su1.${good}.${createHmac("sha256", KEY).update(`su1.${good}`).digest("base64url")}`))).approved).toBe(true);
  });

  it("refuses a card that is not a readable card, and a card version other than the one signed even when it equals the content", async () => {
    const { approvers } = world();
    const unreadable = requestFor({ card: { cardId: 5, contentVersion: DIGEST } as never });
    expect(await approvers.verify(unreadable, proofFor(unreadable, issued()))).toEqual({ approved: false, reason: "card_not_named" });
    const request = requestFor();
    expect(await approvers.verify(request, proofFor(request, issued({ card: cardOf(TASK_A, "v-signed") })))).toEqual({ approved: false, reason: "other_card" });
  });

  it("requirement throws (a store fault) when the company's setting cannot be read, rather than show a window the company may have shortened", async () => {
    const { store } = world();
    const failing = createHostedApprovers({ store: { get: async (key) => { if (key.sk === "SETTING") throw new Error("down"); return await store.get(key); }, put: (r) => store.put(r), update: (r) => store.update(r), delete: (r) => store.delete(r) }, identity: identity(), key: KEY, now: () => new Date(NOW) });
    await expect(failing.requirement(requestFor())).rejects.toThrow("down");
  });

  it("a setting that cannot be read refuses, never falls back to the install's window", async () => {
    const { store } = world();
    const failing = createHostedApprovers({ store: { ...store, get: async (key) => { if (key.sk === "SETTING") throw new Error("down"); return await store.get(key); }, put: (r) => store.put(r), update: (r) => store.update(r), delete: (r) => store.delete(r) }, identity: identity(), key: KEY, now: () => new Date(NOW) });
    const request = requestFor();
    expect(await failing.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "company_rules_unreadable" });
  });

  it("refuses a token whose signature or body is spelled differently (canonical base64url only), and one that claims to live longer than two minutes", async () => {
    const { approvers } = world();
    const token = issued();
    const request = requestFor();
    // The signature's last character carries 2 unused bits: its "twin" decodes to the same bytes, so only the canonical check refuses it.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = ALPHABET.indexOf(token.at(-1)!);
    expect(last % 4).toBe(0);
    const twin = `${token.slice(0, -1)}${ALPHABET[last + 1]!}`;
    for (const variant of [twin, `${token}=`, `${token} `, token.replace("su1.", "su1.+")]) {
      expect(await approvers.verify(request, proofFor(request, variant))).toEqual({ approved: false, reason: "not_a_valid_proof" });
    }
    // Signed with the install's key but stating an expiry beyond the lifetime: refused.
    expect(await approvers.verify(request, proofFor(request, issued({}, NOW + 1_000)))).toEqual({ approved: false, reason: "proof_expired" });
    expect((await approvers.verify(request, proofFor(request, token))).approved).toBe(true);
  });

  it("refuses a task record of another company even when it names the person, and a task record for another id", async () => {
    const { approvers, store } = world();
    // Ada's id on a task row that belongs to company B (the row says so), presented as A's task.
    const strayTask = "2c3d4e5f-6a7b-4c8d-9e0f-a1b2c3d4e5f6";
    await store.put({ item: { ...taskKey(strayTask), entityType: "DEVELOPER_TASK", taskId: strayTask, companyId: B, developerId: "ada", project: "demo" } });
    const card = cardOf(strayTask);
    const request = requestFor({ subject: { type: "task", id: strayTask }, card });
    expect(await approvers.verify(request, proofFor(request, issued({ taskId: strayTask, card })))).toEqual({ approved: false, reason: "not_the_task_owner" });
    // A row stored under one task's key that names another task id.
    const misfiled = "3d4e5f6a-7b8c-4d9e-8f0a-b1c2d3e4f5a6";
    await store.put({ item: { ...taskKey(misfiled), entityType: "DEVELOPER_TASK", taskId: TASK_A, companyId: A, developerId: "ada", project: "demo" } });
    const card2 = cardOf(misfiled);
    const request2 = requestFor({ subject: { type: "task", id: misfiled }, card: card2 });
    expect(await approvers.verify(request2, proofFor(request2, issued({ taskId: misfiled, card: card2 })))).toEqual({ approved: false, reason: "not_the_task_owner" });
  });

  it("a person the identity point names for another company or another id is not a member", async () => {
    const wrong = (principal: Partial<{ companyId: string; personId: string }>) => world({ identity: { capabilities: { interactiveSignIn: false, externalAccounts: false }, getPrincipal: async (companyId: string, personId: string) => ({ companyId, personId, displayName: "x", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER, ...principal }) } as unknown as IdentityProvider });
    const request = requestFor();
    expect(await wrong({ companyId: B }).approvers.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "not_a_member" });
    expect(await wrong({ personId: "bea" }).approvers.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "not_a_member" });
  });

  it("a claim write that fails refuses (claim_unavailable) and the proof is not accepted later by a retry on the same row", async () => {
    const { store } = world();
    let fail = true;
    const flaky = createHostedApprovers({ store: { get: (k) => store.get(k), put: async (r) => { if (fail) { await store.put(r); throw new Error("timeout after write"); } return await store.put(r); }, update: (r) => store.update(r), delete: (r) => store.delete(r) }, identity: identity(), key: KEY, now: () => new Date(NOW) });
    const token = issued();
    const request = requestFor();
    expect(await flaky.verify(request, proofFor(request, token))).toEqual({ approved: false, reason: "claim_unavailable" });
    fail = false;
    expect(await flaky.verify(request, proofFor(request, token))).toEqual({ approved: false, reason: "proof_already_used" });
  });

  it("a policy hook that throws refuses the verdict and gives the claim back", async () => {
    const { approvers } = world();
    const hook = { prepare: async () => { throw new Error("hook down"); }, send: async () => { throw new Error("unused"); }, audit: async () => undefined };
    const wrapped = withPolicyHookApprovers(approvers, hook as never, { now: () => NOW });
    const token = issued();
    const request = requestFor();
    expect(await wrapped.verify(request, proofFor(request, token))).toEqual({ approved: false, reason: "company_rules_no_answer" });
    // Not burnt: the same proof is accepted by the adapter itself.
    expect((await approvers.verify(request, proofFor(request, token))).approved).toBe(true);
  });
});

describe("two companies", () => {
  it("company B's owner, proof and claims never reach company A", async () => {
    const { approvers, store } = world();
    // B's owner with a proof issued for A's request (an install key is shared): not a member of A.
    const request = requestFor();
    expect(await approvers.verify(request, proofFor(request, issued({ personId: "cy" })))).toEqual({ approved: false, reason: "not_a_member" });
    // B's own proof, presented on A's request: the company it was issued for is B.
    const bRequest = requestFor({ companyId: B, subject: { type: "task", id: TASK_B }, card: cardOf(TASK_B) });
    const bToken = issued({ companyId: B, personId: "cy", taskId: TASK_B, card: cardOf(TASK_B) });
    expect(await approvers.verify(request, proofFor(request, bToken))).toEqual({ approved: false, reason: "wrong_company" });
    // A's task named on B's request (B's owner): A's task is not B's.
    const crossed = requestFor({ companyId: B });
    expect(await approvers.verify(crossed, proofFor(crossed, issued({ companyId: B, personId: "cy" })))).toEqual({ approved: false, reason: "not_the_task_owner" });
    // B's own decision works, and its claim lives in B's partition only.
    const verdict = await approvers.verify(bRequest, proofFor(bRequest, bToken));
    expect(verdict).toMatchObject({ approved: true, approver: { companyId: B, personId: "cy" } });
    const [company, hash] = (verdict.approved ? verdict.claimId! : "").split(".");
    expect(company).toBe(B);
    expect(await store.get(stepUpClaimKey(A, hash!))).toBeUndefined();
    // A claim id rewritten to name company A settles nothing, and B's claim is still live.
    const forged = (verdict.approved ? verdict.claimId! : "").replace(B, A);
    expect(await approvers.commitClaim!(forged)).toEqual({ applied: false });
    expect(await approvers.commitClaim!(verdict.approved ? verdict.claimId! : "")).toEqual({ applied: true });
  });
});

describe("registration", () => {
  const context = { installCompanyId: "org_install000000000000", now: () => new Date(NOW), env: {}, clients: {}, log: () => undefined };
  const env = { ROVARA_CORE_ALLOWED_COMPANIES: A };
  const people = { membershipOf: async (personId: string) => MEMBERS[personId], displayNameOf: async (personId: string) => (personId in MEMBERS ? personId : undefined) };

  it("is a step 5 module after identity, never Code's laptop default, and on the broker it verifies with the key derived from the callback signing key", async () => {
    const store = seededStore();
    const modules = hostedSecurityModules({ env, identity: people, callbackSigningKey: SIGNING_KEY });
    expect(modules.map((module) => module.point)).toEqual(["metering", "admission", "identity", "approvers", "audit-sink"]);
    expect(modules.some((module) => module.isDefault === true)).toBe(false);
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), ...modules], context, areas: [] });
    const request = requestFor();
    expect(await registry.require("approvers").verify(request, proofFor(request, issued()))).toMatchObject({ approved: true, approver: { personId: "ada" } });
  });

  it("on the dispatcher (no key) it is registered and refuses every proof", async () => {
    const modules = hostedSecurityModules({ env, identity: people });
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => seededStore() }), ...modules], context, areas: [] });
    const request = requestFor();
    expect(await registry.require("approvers").verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "method_not_available" });
  });
});

describe("the decision gate today", () => {
  it("is refused whole until its caller settles claims and names the card (lane L11 switches that in): fail closed, nothing decided", async () => {
    const { approvers, store } = world();
    let applied = false;
    const subject: DecisionSubject = {
      kind: "plan-doc",
      async load() { return { key: taskKey(TASK_A), guard: { op: "exists", path: ["pk"] }, waiting: true, request: { kind: "plan", subject: { type: "task", id: TASK_A }, projectName: "demo", revision: 3, artifactDigest: DIGEST, risk: "high" }, state: {} }; },
      apply() { applied = true; return { ops: [] }; },
    };
    const gate = createDecisionGate({ store, approvers, audit: { stage: () => [], record: async () => undefined }, subjects: [subject], now: () => new Date(NOW) });
    const outcome: ApprovalAnswer = "approve";
    const result = await gate.decide({ companyId: A, kind: "plan-doc", subjectId: TASK_A, requestId: "decision-request-0001", outcome, seen: { revision: 3, artifactDigest: DIGEST }, credentials: [{ method: STEP_UP_APPROVAL_METHOD, token: issued() }] });
    expect(result).toEqual({ status: "refused", reason: "not_approved", detail: `Not approved: ${NEEDS_SETTLING_CALLER}.` });
    expect(applied).toBe(false);
  });
});

