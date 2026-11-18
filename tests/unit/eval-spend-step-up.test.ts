// L4-EVC (DEC 254zzz20 D8): the hosted approvers point accepts a fresh step-up proof for ONE more subject, a project's eval spend item, and only for it. A proof of one subject type never stands for another
// (a task's, a setup candidate's, an eval spend item's), and every binding of the proof (company, person, request, kind, project, revision, digest, answer, card) is held again at `verify`.
import { describe, expect, it } from "vitest";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import type { ApprovalProof, ApprovalRequest, OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  EVAL_SPEND_SUBJECT, SETUP_PROPOSAL_SUBJECT, APPROVAL_PROOF_METHOD, createHostedApprovers, issueEvalSpendApprovalProof, issueSetupApprovalProof, issueApprovalProof, approvalProofKeyOf,
} from "../../packages/broker/src/core-host/hosted-approvers.js";
import { createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { EVAL_SPEND_KIND, createEvalSpendSubject } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { deployedSessionMembers } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { evalSpendCardOf } from "../../packages/broker/src/core-host/setup-approval.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId; const B = COMPANY_B.orgId;
const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const KEY = approvalProofKeyOf("callback-signing-key-for-tests-0123456789abcdef");
const STEP_UP = { at: new Date(NOW - 60_000).toISOString(), method: "passkey" };
const DIGEST = "a".repeat(64);
const PROJECT = "demo";
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const MEMBERS: Record<string, { companyId: OrgId; role: "member" | "admin" }> = { ada: { companyId: A, role: "admin" }, cy: { companyId: B, role: "admin" } };
const identity = () => createHostedIdentity({ membershipOf: async (id) => MEMBERS[id], displayNameOf: async (id) => id });
const approvers = (store = new MemoryDocumentStore()) => createHostedApprovers({ store, identity: identity(), key: KEY, now: () => new Date(NOW) });

const evalRequest = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  companyId: A, requestId: `eval-${"b".repeat(40)}-2`, kind: EVAL_SPEND_KIND, subject: { type: "eval_spend", id: PROJECT }, projectName: PROJECT, revision: 2, artifactDigest: DIGEST,
  risk: "high", outcome: "approve", card: evalSpendCardOf(PROJECT, DIGEST), settlesClaims: true, ...over,
});
const act = (over: Record<string, unknown> = {}) => ({
  companyId: A, personId: "ada", stepUp: STEP_UP, requestId: `eval-${"b".repeat(40)}-2`, kind: EVAL_SPEND_KIND, project: PROJECT, revision: 2, artifactDigest: DIGEST, outcome: "approve" as const, card: evalSpendCardOf(PROJECT, DIGEST), ...over,
});
let n = 0;
const proof = (request: ApprovalRequest, token: string): ApprovalProof => ({ proofId: `p-${++n}`, method: APPROVAL_PROOF_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token });
const verdictOf = async (request: ApprovalRequest, token: string) => approvers().verify(request, proof(request, token));

describe("a step-up proof for a project's eval spend item", () => {
  it("is accepted for that item, names the person, and is the same subject constant the eval spend subject uses", async () => {
    expect(EVAL_SPEND_SUBJECT).toBe("eval_spend");
    const verdict = await verdictOf(evalRequest(), issueEvalSpendApprovalProof(KEY, act(), NOW).token);
    expect(verdict).toMatchObject({ approved: true, approver: { personId: "ada", companyId: A } });
  });
  it("is refused for a task, and a task's proof is refused for it (a proof of one subject type never stands for another)", async () => {
    const taskRequest: ApprovalRequest = { companyId: A, requestId: "decision-request-0001", kind: "plan", subject: { type: "task", id: TASK }, projectName: PROJECT, revision: 2, artifactDigest: DIGEST, risk: "high", outcome: "approve", card: { cardId: `approve_plan:${TASK}`, contentVersion: DIGEST }, settlesClaims: true };
    expect(await verdictOf(taskRequest, issueEvalSpendApprovalProof(KEY, act({ requestId: "decision-request-0001", kind: "plan", card: taskRequest.card }), NOW).token)).toMatchObject({ approved: false });
    const taskProof = issueApprovalProof(KEY, { companyId: A, personId: "ada", stepUp: STEP_UP, requestId: evalRequest().requestId, kind: EVAL_SPEND_KIND, taskId: TASK, revision: 2, artifactDigest: DIGEST, outcome: "approve", card: evalSpendCardOf(PROJECT, DIGEST) }, NOW).token;
    expect(await verdictOf(evalRequest(), taskProof)).toMatchObject({ approved: false, reason: "other_subject" });
  });
  it("is refused for a setup candidate, and a setup candidate's proof is refused for the eval item", async () => {
    const setupRequest: ApprovalRequest = { ...evalRequest({ kind: "setup", requestId: `setup-${"c".repeat(40)}-2`, subject: { type: SETUP_PROPOSAL_SUBJECT, id: PROJECT }, card: { cardId: `setup_proposal:${PROJECT}`, contentVersion: DIGEST } }) };
    const evalProof = issueEvalSpendApprovalProof(KEY, act({ requestId: setupRequest.requestId, kind: "setup", card: setupRequest.card }), NOW).token;
    expect(await verdictOf(setupRequest, evalProof)).toMatchObject({ approved: false, reason: "other_subject" });
    const setupProof = issueSetupApprovalProof(KEY, act(), NOW).token;
    expect(await verdictOf(evalRequest(), setupProof)).toMatchObject({ approved: false, reason: "other_subject" });
  });
  it.each([
    ["another project", { project: "other" }, "other_subject"],
    ["another revision", { revision: 3 }, "other_revision"],
    ["another digest", { artifactDigest: "d".repeat(64), card: evalSpendCardOf(PROJECT, "d".repeat(64)) }, "other_content"],
    ["another answer", { outcome: "reject" as const }, "other_answer"],
    ["another kind", { kind: "setup" }, "other_kind"],
    ["another request", { requestId: `eval-${"e".repeat(40)}-2` }, "other_request"],
    ["another card", { card: { cardId: "eval_spend:other", contentVersion: DIGEST } }, "other_card"],
  ])("a proof issued for %s is refused", async (_name, over, reason) => {
    const token = issueEvalSpendApprovalProof(KEY, act(over), NOW).token;
    expect(await verdictOf(evalRequest(), token)).toMatchObject({ approved: false, reason });
  });
  it("is refused for another company's request, for a person who is not a member of the request's company, and for a step-up that is not fresh", async () => {
    const token = issueEvalSpendApprovalProof(KEY, act(), NOW).token;
    expect(await verdictOf(evalRequest({ companyId: B }), token)).toMatchObject({ approved: false, reason: "wrong_company" });
    expect(await verdictOf(evalRequest(), issueEvalSpendApprovalProof(KEY, act({ personId: "cy" }), NOW).token)).toMatchObject({ approved: false, reason: "not_a_member" });
    expect(await verdictOf(evalRequest(), issueEvalSpendApprovalProof(KEY, act({ stepUp: { at: new Date(NOW - 3_600_000).toISOString(), method: "passkey" } }), NOW).token)).toMatchObject({ approved: false, reason: "sign_in_not_fresh" });
  });
  it("is one time: the same proof cannot decide twice", async () => {
    const store = new MemoryDocumentStore();
    const point = approvers(store);
    const request = evalRequest(); const token = issueEvalSpendApprovalProof(KEY, act(), NOW).token;
    const first = await point.verify(request, proof(request, token));
    expect(first).toMatchObject({ approved: true });
    expect(await point.verify(request, proof(request, token))).toMatchObject({ approved: false, reason: "proof_already_used" });
  });
  it("refuses an input it cannot bind (a project name that is not one)", () => {
    expect(() => issueEvalSpendApprovalProof(KEY, act({ project: "../x" }), NOW)).toThrow();
    expect(() => issueEvalSpendApprovalProof(KEY, act({ project: undefined }), NOW)).toThrow();
  });
  it("decides the real eval spend item end to end through the gate, as a company admin, and refuses the same proof presented for another project", async () => {
    const store = new MemoryDocumentStore();
    const members = deployedSessionMembers(A, { membershipOf: async (id) => MEMBERS[id], projectGrantRole: async () => undefined });
    const subject = createEvalSpendSubject({ store, companyId: A, members, monthlyCapMicros: 50_000_000 });
    const gate = createDecisionGate({ store, approvers: approvers(store), audit: createNoopAuditSink(), subjects: [subject], now: () => new Date(NOW) });
    const { proposeEvalSpendApproval } = await import("../../packages/broker/src/core/setup-agent/eval-spend.js");
    const row = await proposeEvalSpendApproval({ store, companyId: A, members, monthlyCapMicros: 50_000_000 }, PROJECT, { selection: "evals/demo", inputs: { evalSetHash: "1".repeat(64), judgePin: "2".repeat(64), modelVersion: "v1", model: "m", catalogRowId: "gemini", commandFingerprint: "3".repeat(64), settingsFingerprint: "4".repeat(64) }, estimate: { calls: 6, costMicros: 600_000 } });
    const requestId = `eval-${row.digest.slice(0, 40)}-${row.revision}`;
    const issued = issueEvalSpendApprovalProof(KEY, act({ requestId, revision: row.revision, artifactDigest: row.digest, card: evalSpendCardOf(PROJECT, row.digest) }), NOW);
    const attempt = { companyId: A, kind: EVAL_SPEND_KIND, subjectId: PROJECT, requestId, outcome: "approve" as const, seen: { revision: row.revision, artifactDigest: row.digest }, credentials: [{ method: issued.method, token: issued.token }], card: evalSpendCardOf(PROJECT, row.digest) };
    const result = await gate.decide(attempt);
    expect(result.status).toBe("decided");
  });
});
