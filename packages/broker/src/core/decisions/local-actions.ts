// The decision side of what the local pages and the PR comment commands (lane L8) ask of the task flow (lane L6b): `decidePlan`, `decideDesign` and the PR commands' `decide`, through the approval gate. They
// carry the proof the surface collected, and say in words fit to show whether it was accepted. Nothing here decides who may approve: the gate and the Approvers seam do.
//
// What L8 assumes beyond this stays with the task flow and is NOT here: the reads of `LocalPageData` (pending list, plan and design pages, lessons, proof report), `LocalPageActions.addComment` and
// `lessonAction`, and `PrCommandWorld.pendingFor`, `lesson` and `stop` (they need the task index, page comments, lessons and the pull request to task map: lanes L6a, L7a/b and L11).
import type { ApprovalProof } from "@agentx/contracts";
import type { ApprovalOffer, LocalActionResult } from "../local-pages/views.js";
import type { DecisionAttempt, DecisionGate, GateRefusalReason, GateResult } from "./approval-gate.js";
import { WORKFLOW_DOCUMENT_KIND } from "./workflow-subject.js";

const WORDS: Record<GateRefusalReason, { reason: "stale" | "refused" | "not_found" | "invalid"; message: string }> = {
  stale: { reason: "stale", message: "This changed since you read it. Read the latest and decide again." },
  not_waiting: { reason: "stale", message: "This is no longer waiting for a decision." },
  expired: { reason: "stale", message: "This request has expired." },
  not_found: { reason: "not_found", message: "That is no longer there." },
  invalid: { reason: "invalid", message: "That was not understood." },
  unsupported: { reason: "refused", message: "Rovara does not decide this here." },
  method_not_allowed: { reason: "refused", message: "That way of approving is not allowed for this decision." },
  not_approved: { reason: "refused", message: "That was not accepted." },
  not_the_approver: { reason: "refused", message: "That person cannot decide this." },
  self_approval_not_allowed: { reason: "refused", message: "Someone else has to decide this." },
  needs_more_approvers: { reason: "refused", message: "More approvers are needed." },
  proof_already_used: { reason: "refused", message: "That was already used. Read the page again." },
  request_id_reused: { reason: "refused", message: "That was already decided differently." },
  invalid_outcome: { reason: "refused", message: "That is not ready to be decided." },
  sign_in_not_fresh: { reason: "refused", message: "Sign in again, then decide." },
};

/** What a gate answer says to a page or a comment. A repeat of a finished decision is a success (the same answer again). */
export function localResultOf(result: GateResult, done?: string): LocalActionResult {
  if (result.status !== "refused") return { ok: true, ...(done === undefined ? {} : { message: done }) };
  return { ok: false, ...WORDS[result.reason] };
}

export interface DecisionActionsOptions {
  gate: DecisionGate;
  companyId: string;
}

/** What one surface decision names; the proof is the surface's (a page's signed local-session proof, or a comment id). */
interface SurfaceDecision {
  taskId: string;
  approval: ApprovalOffer;
  proof: ApprovalProof;
  outcome: DecisionAttempt["outcome"];
  note?: string | undefined;
  via?: "PAGE";
}

export function createDecisionActions(options: DecisionActionsOptions) {
  const decide = async (input: SurfaceDecision, done: string): Promise<LocalActionResult> => {
    // The proof names the request, revision and digest the person saw; the gate checks them against the stored state and builds what the Approvers seam is asked about from that state alone.
    if (input.proof.requestId !== input.approval.requestId || input.proof.revision !== input.approval.revision || input.proof.artifactDigest !== input.approval.artifactDigest) {
      return { ok: false, ...WORDS.invalid };
    }
    const reason = input.note?.trim();
    if (input.outcome !== "approve" && (reason === undefined || reason === "")) return { ok: false, reason: "invalid", message: "Say what to change." };
    const result = await options.gate.decide({
      companyId: options.companyId, kind: WORKFLOW_DOCUMENT_KIND, subjectId: input.taskId, requestId: input.approval.requestId, outcome: input.outcome,
      seen: { revision: input.approval.revision, artifactDigest: input.approval.artifactDigest },
      credentials: [{ method: input.proof.method, token: input.proof.token, ...(input.proof.claimedAccount === undefined ? {} : { claimedAccount: input.proof.claimedAccount }) }],
      ...(reason === undefined || reason === "" ? {} : { reason }), details: input.via === undefined ? {} : { via: input.via },
    });
    return localResultOf(result, done);
  };
  return {
    /** The plan page's Approve and Request changes. */
    decidePlan: (input: { taskId: string; decision: "approve" | "changes"; note?: string; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult> =>
      decide({ taskId: input.taskId, approval: input.approval, proof: input.proof, outcome: input.decision === "approve" ? "approve" : "request_changes", note: input.note, via: "PAGE" }, input.decision === "approve" ? "Approved. Rovara is going ahead." : "Sent back with your changes."),
    /** The design page's Approve and Reject. A rejected design is sent back with the reason (a task is closed on its own page, not by a click on a design). */
    decideDesign: (input: { taskId: string; decision: "approve" | "reject"; note?: string; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult> =>
      decide({ taskId: input.taskId, approval: input.approval, proof: input.proof, outcome: input.decision === "approve" ? "approve" : "request_changes", note: input.note, via: "PAGE" }, input.decision === "approve" ? "Approved." : "Sent back."),
    /** `PrCommandWorld.decide`: a comment's `/rovara approve` or `/rovara changes: ...`. */
    decideFromComment: (input: { taskId: string; decision: "approve" | "changes"; note?: string; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult> =>
      decide({ taskId: input.taskId, approval: input.approval, proof: input.proof, outcome: input.decision === "approve" ? "approve" : "request_changes", note: input.note }, input.decision === "approve" ? "Approved." : "Sent back."),
  };
}
