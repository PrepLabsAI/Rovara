// Switch-on lane L11 (owner decision 211, gaps G3 and G4): the approval gate as the caller of an Approvers adapter that claims one-time parts. The gate asks with `settlesClaims` only where the
// adapter offers both `commitClaim` and `releaseClaim`, names the card the person answered on, spends every claim once its transaction applied, gives it back when the decision stopped or lost,
// leaves it to lapse when the transaction's outcome is unknown, and answers a repeat of a finished decision whose one-time proof is spent as the same decision again.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, NEEDS_SETTLING_CALLER, createWorkflowSnapshot, submitWorkflowArtifact,
  type ApprovalProof, type ApprovalRequest, type ApprovalVerdict, type Approvers, type JsonValue, type Principal, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, waitingDocumentDigest, workflowTaskKey } from "../../packages/broker/src/core/decisions/workflow-subject.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const OWNER = localOwnerPrincipal();
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const NOW = new Date("2026-11-15T12:00:00.000Z");
const METHOD = "one-time-step-up";

function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: "2026-11-15T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-15T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${TASK_ID}/plan-v1.json`, createdAt: "2026-11-15T10:00:00.000Z", format: "structured" },
  });
}

/** An adapter that claims a one-time part per token (as lane L2a's point does): a claimed or spent token is `proof_already_used`; a released one may be claimed again. */
function claimingApprovers(options: { settles?: boolean; selfApprovalAllowed?: boolean; onVerify?: () => Promise<void>; reapprove?: boolean; commitThrows?: boolean } = {}) {
  const requests: ApprovalRequest[] = [];
  const committed: string[] = [];
  const released: string[] = [];
  const held = new Map<string, string>();
  const approvers: Approvers = {
    async requirement() { return { methods: [METHOD], minApprovers: 1, selfApprovalAllowed: options.selfApprovalAllowed ?? true, strongMethods: [METHOD], rejectMethods: [METHOD], changesMethods: [METHOD] }; },
    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      requests.push(request);
      if (request.settlesClaims !== true) return { approved: false, reason: NEEDS_SETTLING_CALLER };
      if (held.has(proof.token) && options.reapprove !== true) return { approved: false, reason: "proof_already_used" };
      const claimId = `claim-${String(requests.length)}`;
      held.set(proof.token, claimId);
      await options.onVerify?.();
      return { approved: true, approver: OWNER, method: proof.method, proofId: proof.proofId, claimId };
    },
  };
  if (options.settles !== false) {
    approvers.commitClaim = options.commitThrows === true
      ? (claimId) => { committed.push(claimId); throw new Error("not a promise"); }
      : async (claimId) => { committed.push(claimId); return { applied: true }; };
    approvers.releaseClaim = async (claimId) => { released.push(claimId); for (const [token, id] of held) if (id === claimId) held.delete(token); };
  }
  return { approvers, requests, committed, released };
}

async function world(adapter: ReturnType<typeof claimingApprovers>, options: { requestedBy?: Principal } = {}) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workflowTaskKey(TASK_ID), entityType: "DEVELOPER_TASK", orgId: COMPANY, project: "web", workflow: JSON.parse(JSON.stringify(waiting())) as JsonValue } });
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low", ...(options.requestedBy === undefined ? {} : { requestedBy: () => options.requestedBy }) });
  const gate = createDecisionGate({ store, approvers: adapter.approvers, audit: createNoopAuditSink(), subjects: [subject], now: () => NOW });
  const stage = async () => ((await store.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot).stage;
  return { store, gate, stage };
}

const CARD = { cardId: `approve_plan:${TASK_ID}`, contentVersion: "b".repeat(64) };
function attempt(overrides: Partial<DecisionAttempt> = {}): DecisionAttempt {
  const workflow = waiting();
  return {
    companyId: COMPANY, kind: "workflow-document", subjectId: TASK_ID, requestId: randomUUID(), outcome: "approve",
    seen: { revision: workflow.revision, artifactDigest: waitingDocumentDigest(workflow)! }, credentials: [{ method: METHOD, token: randomUUID() }], card: CARD, ...overrides,
  };
}

describe("the approval gate settles one-time claims (gap G3) and names the card (gap G4)", () => {

  it("gives back a claim the adapter took while a repeat was read (a replay changes nothing)", async () => {
    const adapter = claimingApprovers({ reapprove: true });
    const w = await world(adapter);
    const first = attempt();
    expect(await w.gate.decide(first)).toMatchObject({ status: "decided" });
    expect(await w.gate.decide(first)).toMatchObject({ status: "replayed" });
    expect(adapter.committed).toEqual(["claim-1"]);
    expect(adapter.released).toEqual(["claim-2"]);
  });

  it("keeps a recorded decision when the adapter's commit throws at once (not a rejected promise): the claim lapses to spent", async () => {
    const adapter = claimingApprovers({ commitThrows: true });
    const w = await world(adapter);
    expect(await w.gate.decide(attempt())).toMatchObject({ status: "decided" });
    expect(adapter.committed).toEqual(["claim-1"]);
    expect(await w.stage()).toBe("IMPLEMENT");
  });
});
