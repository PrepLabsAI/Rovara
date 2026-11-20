
import { describe, expect, it } from "vitest";
import {
  NEEDS_SETTLING_CALLER, type ApprovalAnswer, type ApprovalProof, type ApprovalRequest, type IdentityProvider, type OrgId,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  APPROVAL_PROOF_METHOD, APPROVAL_PROOF_CLAIM_MS, APPROVAL_PROOF_LIFETIME_MS, createHostedApprovers, issueApprovalProof, approvalProofKeyOf, approvalProofClaimKey, type ApprovalProofInput,
} from "../../packages/broker/src/core-host/hosted-approvers.js";
import { createHostedIdentity, hostedSecurityModules } from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
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
const KEY = approvalProofKeyOf(SIGNING_KEY);

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
const input = (overrides: Partial<ApprovalProofInput> = {}): ApprovalProofInput => ({
  companyId: A, personId: "ada", requestId: "decision-request-0001", kind: "plan", taskId: TASK_A, revision: 3, artifactDigest: DIGEST, outcome: "approve", card: cardOf(TASK_A), ...overrides,
});
let proofs = 0;
const proofFor = (request: ApprovalRequest, token: string): ApprovalProof => ({
  proofId: `proof-${++proofs}`, method: APPROVAL_PROOF_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token,
});
const issued = (overrides: Partial<ApprovalProofInput> = {}, at = NOW): string => issueApprovalProof(KEY, input(overrides), at).token;

function world(options: { now?: () => number; key?: Buffer | undefined; identity?: IdentityProvider } = {}) {
  const store = seededStore();
  const clock = { now: NOW };
  const approvers = createHostedApprovers({ store, identity: options.identity ?? identity(), key: "key" in options ? options.key : KEY, now: () => new Date(options.now?.() ?? clock.now) });
  return { store, clock, approvers };
}

// ---- the port's own suite

const STANDING = issued();
runApproversConformance("deployed approvers (task owner, card-bound one-time proof, no step-up)", {
  create: async () => world().approvers,
  request: requestFor(),
  acceptable: proofFor(requestFor(), STANDING),
  forgedToken: `${STANDING.slice(0, -4)}AAAA`,
  claims: {
    proof: proofFor(requestFor(), STANDING),
    withClock: async () => {
      let now = NOW;
      return { approvers: world({ now: () => now }).approvers, lapse: () => { now += APPROVAL_PROOF_CLAIM_MS + 1_000; } };
    },
  },
  cardBound: { request: requestFor(), proof: proofFor(requestFor(), STANDING) },
});

describe("the deployed approvers point", () => {

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
      ["a token it did not sign", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issueApprovalProof(approvalProofKeyOf("another-install-key-0123456789abcdef"), input(), NOW).token) }; }, "not_a_valid_proof"],
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
      ["a proof past its two minutes", async () => { const r = requestFor(); return { request: r, proof: proofFor(r, issued({}, NOW - APPROVAL_PROOF_LIFETIME_MS)) }; }, "proof_expired"],
      ["a request past its own expiry", async () => { const r = requestFor({ expiresAt: new Date(NOW).toISOString() }); return { request: r, proof: proofFor(r, issued()) }; }, "expired"],
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

    it("refuses an unreadable people read without throwing, and issues nothing for an input it cannot bind", async () => {
      expect(() => issueApprovalProof(KEY, input({ revision: 0 }), NOW)).toThrow("an approval proof cannot be issued for this input");
      const failing = world({ identity: { capabilities: { interactiveSignIn: false, externalAccounts: false }, getPrincipal: async () => { throw new Error("dynamo down ada"); } } as unknown as IdentityProvider });
      const request = requestFor();
      expect(await failing.approvers.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "people_unreadable" });
    });

    it("refuses every proof on a host with no proof key (the dispatcher)", async () => {
      const request = requestFor();
      expect(await world({ key: undefined }).approvers.verify(request, proofFor(request, issued()))).toEqual({ approved: false, reason: "method_not_available" });
    });
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

describe("registration", () => {
  const context = { installCompanyId: "org_install000000000000", now: () => new Date(NOW), env: {}, clients: {}, log: () => undefined };
  const env = { ROVARA_CORE_ALLOWED_COMPANIES: A };
  const people = { membershipOf: async (personId: string) => MEMBERS[personId], displayNameOf: async (personId: string) => (personId in MEMBERS ? personId : undefined) };

  it("hands the deployment's task-owner rule the company, the live person, the stored task and the company's own store (C6)", async () => {
    const store = seededStore();
    const asked: Array<{ companyId: string; personId: string; store: unknown; task: unknown }> = [];
    const modules = hostedSecurityModules({ env, identity: people, callbackSigningKey: SIGNING_KEY, taskOwner: async (input) => { asked.push({ companyId: input.companyId, personId: input.principal.personId, store: input.store, task: input.task }); return input.principal.personId === "bea"; } });
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), ...modules], context, areas: [] });
    const request = requestFor();
    expect(await registry.require("approvers").verify(request, proofFor(request, issued({ personId: "bea" })))).toMatchObject({ approved: true, approver: { personId: "bea" } });
    expect(asked).toEqual([{ companyId: A, personId: "bea", store: registry.require("storage"), task: { taskId: TASK_A, developerId: "ada", project: "demo" } }]);
    // The task's own person is not accepted on the record alone once the rule is given.
    const again = requestFor({ requestId: "decision-request-0002" });
    expect(await registry.require("approvers").verify(again, proofFor(again, issued({ personId: "ada", requestId: "decision-request-0002" })))).toEqual({ approved: false, reason: "not_the_task_owner" });
  });
});

describe("the decision gate as this point's caller (lane L11: it settles claims and names the card)", () => {
  const setup = () => {
    const { approvers, store } = world();
    const applied: string[] = [];
    const subject: DecisionSubject = {
      kind: "plan-doc",
      async load() { return { key: taskKey(TASK_A), guard: { op: "exists", path: ["pk"] }, waiting: true, request: { kind: "plan", subject: { type: "task", id: TASK_A }, projectName: "demo", revision: 3, artifactDigest: DIGEST, risk: "high" }, state: {} }; },
      apply(_loaded, attempt) { applied.push(attempt.requestId); return { ops: [{ op: "set", path: ["decided"], value: true }] }; },
    };
    const gate = createDecisionGate({ store, approvers, audit: { stage: () => [], record: async () => undefined }, subjects: [subject], now: () => new Date(NOW) });
    const claims = async () => (await store.query({ pk: approvalProofClaimKey(A, "x").pk })).items;
    const outcome: ApprovalAnswer = "approve";
    const attempt = (token: string, extra: Record<string, unknown> = {}) => ({ companyId: A, kind: "plan-doc", subjectId: TASK_A, requestId: "decision-request-0001", outcome, seen: { revision: 3, artifactDigest: DIGEST }, credentials: [{ method: APPROVAL_PROOF_METHOD, token }], ...extra });
    return { gate, applied, claims, attempt };
  };

  it("decides with the card, spends the one-time part, and answers a repeat as the same decision", async () => {
    const t = setup();
    const token = issued();
    expect(await t.gate.decide(t.attempt(token, { card: cardOf(TASK_A) }))).toMatchObject({ status: "decided" });
    expect(t.applied).toEqual(["decision-request-0001"]);
    expect(await t.claims()).toEqual([expect.objectContaining({ state: "spent" })]);
    expect(await t.gate.decide(t.attempt(token, { card: cardOf(TASK_A) }))).toMatchObject({ status: "replayed" });
    expect(t.applied).toEqual(["decision-request-0001"]);
  });
});

// Web task channel C6 (plan 4.1, decision D5): a co-owner the People rule names may decide a core task's document; nobody else may.
describe("the deployed approvers point: co-owners (the task-owner seam)", () => {
  type OwnerCheck = NonNullable<Parameters<typeof createHostedApprovers>[0]["taskOwner"]>;
  const seamWorld = (taskOwner: OwnerCheck) => {
    const store = seededStore();
    return { store, approvers: createHostedApprovers({ store, identity: identity(), key: KEY, now: () => new Date(NOW), taskOwner }) };
  };

  it("refuses when the seam says no, throws, or answers anything but true; the task's own person is not accepted by the stored record alone once the seam is given", async () => {
    for (const taskOwner of [async () => false, async () => { throw new Error("people down"); }, async () => "yes" as never, async () => undefined as never] satisfies OwnerCheck[]) {
      const { approvers, store } = seamWorld(taskOwner);
      const r = requestFor();
      const verdict = await approvers.verify(r, proofFor(r, issued({ personId: "ada" })));
      expect(verdict).toMatchObject({ approved: false });
      expect((await store.query({ pk: approvalProofClaimKey(A, "x").pk })).items).toEqual([]);
    }
    const { approvers } = seamWorld(async () => { throw new Error("people down zzq"); });
    const r = requestFor();
    expect(await approvers.verify(r, proofFor(r, issued({ personId: "bea" })))).toEqual({ approved: false, reason: "people_unreadable" });
  });

  it("still refuses a non-member, another company's task and a project mismatch before the seam can say yes", async () => {
    const yes: OwnerCheck = async () => true;
    const { approvers } = seamWorld(yes);
    const gone = createHostedApprovers({ store: seededStore(), identity: identity({ bea: undefined }), key: KEY, now: () => new Date(NOW), taskOwner: yes });
    const r1 = requestFor();
    expect(await gone.verify(r1, proofFor(r1, issued({ personId: "bea" })))).toEqual({ approved: false, reason: "not_a_member" });
    // Cy is a member of B only: asking for company A's task through company A's request is another company's person.
    const r2 = requestFor();
    expect(await approvers.verify(r2, proofFor(r2, issued({ personId: "cy" })))).toEqual({ approved: false, reason: "not_a_member" });
    const r3 = requestFor({ projectName: "other" });
    expect(await approvers.verify(r3, proofFor(r3, issued({ personId: "bea" })))).toEqual({ approved: false, reason: "not_the_task_owner" });
    // The company's own task, but the request names another company's task id.
    const r4 = requestFor({ subject: { type: "task", id: TASK_B }, card: cardOf(TASK_B) });
    expect(await approvers.verify(r4, proofFor(r4, issued({ personId: "bea", taskId: TASK_B, card: cardOf(TASK_B) })))).toEqual({ approved: false, reason: "not_the_task_owner" });
  });
});
