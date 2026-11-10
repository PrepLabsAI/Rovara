// Design review stage: what the approval gate needs to know about a design under review, kept out of the gate itself. The gate (core/decisions/approval-gate.ts) decides WHO may approve, with the approvers port and the
// risk tier given here; a design that went through review is graded by `riskTierOf("approve_design")` from the review's facts, so a high-risk design needs the strong proof, a sign-in window and a person other than the requester
// when the approvers plug-in says so. The rules of the review itself are these three functions: the tier, the blocker reason and the approval record the pull request's Proof section reads.
import { DESIGN_REVIEW_HIGH_RISK_REASONS, readDesignMeta, type DecisionRisk, type DesignReason, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import { raiseRisk } from "@agentx/contracts";
import type { LoadedDocument } from "../../developer/plan-document-reader.js";
import { gradePlanRisk, planFactsOf } from "../decisions/plan-risk.js";
import { SubjectRefusal, type DecisionAttempt } from "../decisions/approval-gate.js";
import { riskTierOf } from "../decisions/risk-tier.js";
import { designApprovalProofLine, designApprovalReason, DESIGN_REASON_NOT_ALLOWED_MESSAGE, DESIGN_REASON_REQUIRED_MESSAGE } from "./approval.js";
import { designCardFactsOf } from "./card-source.js";

/** Whether this workflow waits on a design that went through design review. */
export const isReviewedDesign = (workflow: WorkflowSnapshot): boolean => workflow.designReview !== undefined && workflow.reviewPhase === "DESIGN" && workflow.stage === "PLAN_REVIEW";

/** Where the approval of one design (by its digest) is kept: Cloud's key, so the pull request's Proof section reads the same record. */
export const designApprovalKey = (taskId: string, digest: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: `DESIGN_APPROVAL#${digest}` });

/** The design's own `touches[]` codes. A design that does not read has none (the broker stored only a design that reads, so this is for the card of an older one); the codes can only raise a tier. */
export function designTouchesOf(designMarkdown: string | undefined): DesignReason[] {
  if (designMarkdown === undefined) return [];
  const meta = readDesignMeta(designMarkdown);
  return meta.ok ? [...meta.meta.touches] : [];
}

/** The tier of the design waiting now, worked out from the broker's own facts and the paths the design names (`planFactsOf`) (never model text, never lowered by a client). Undefined for a workflow that is not waiting on a reviewed design. */
export function designRiskOf(workflow: WorkflowSnapshot, designMarkdown: string | undefined, files: readonly string[] = []): DecisionRisk | undefined {
  if (!isReviewedDesign(workflow) || workflow.designReview === undefined) return undefined;
  const facts = designCardFactsOf(workflow.designReview, designTouchesOf(designMarkdown));
  return riskTierOf("approve_design", { design: { files, review: facts } }, {}).risk;
}

/**
 * The tier of the document waiting for approval, as the approval gate asks for it. A coding plan, or a design that did not go through review, is `gradePlanRisk` (what the document says, raised to the core's own floor over its text and the
 * request). A design that went through review is also graded from the review's facts and the paths the design names, and the higher of the two stands: neither can lower the other.
 */
export function gradeApprovalRisk(input: { loaded: LoadedDocument | undefined; workflow: WorkflowSnapshot; requestText?: string | undefined; costHighUsd?: number | undefined }): DecisionRisk {
  const base = gradePlanRisk(input);
  const reviewed = designRiskOf(input.workflow, input.loaded?.markdown, planFactsOf(input.loaded, input.workflow).files);
  return reviewed === undefined ? base : raiseRisk(reviewed, base);
}

/** Throws `SubjectRefusal` for an approval that breaks a rule of the review: a design with an open blocker is approved only with a one-line reason, and a reason is taken nowhere else. Other outcomes are not held to it. */
export function checkDesignApproval(workflow: WorkflowSnapshot, attempt: Pick<DecisionAttempt, "outcome" | "reason">): void {
  if (attempt.outcome !== "approve" || !isReviewedDesign(workflow) || workflow.designReview === undefined) return;
  const openBlockers = designCardFactsOf(workflow.designReview, []).blockers.length;
  const reason = designApprovalReason({ openBlockers, blockerReason: attempt.reason });
  if (reason.ok) return;
  throw new SubjectRefusal("invalid", reason.code === "reason_required" ? DESIGN_REASON_REQUIRED_MESSAGE : DESIGN_REASON_NOT_ALLOWED_MESSAGE);
}

/** The record an approved design leaves under its digest, in the decision's own transaction: who approved, at what tier, how many blockers were open and the cleaned reason, which the Proof section reads. */
export function designApprovalRecordItems(input: { taskId: string; before: WorkflowSnapshot; after: WorkflowSnapshot; attempt: Pick<DecisionAttempt, "outcome" | "reason" | "requestId">; approverId: string; approverLabel: string; risk: DecisionRisk | undefined; at: string }): TransactItem[] {
  const { before, attempt } = input;
  if (attempt.outcome !== "approve" || !isReviewedDesign(before) || before.designReview === undefined) return [];
  const digest = before.artifacts.filter((artifact) => artifact.type === "design").at(-1)?.sha256;
  if (digest === undefined) return [];
  const openBlockers = designCardFactsOf(before.designReview, []).blockers.length;
  const reason = designApprovalReason({ openBlockers, blockerReason: attempt.reason });
  const proofReason = reason.ok ? reason.proofReason : undefined;
  const proofLine = designApprovalProofLine(openBlockers, proofReason);
  return [{
    kind: "put",
    item: {
      ...designApprovalKey(input.taskId, digest), entityType: "DESIGN_APPROVAL", taskId: input.taskId, designDigest: digest, approverId: input.approverId, approverLabel: input.approverLabel,
      tier: input.risk ?? "high", openBlockers, requestId: attempt.requestId, at: input.at, ...(proofReason === undefined ? {} : { proofReason }), ...(proofLine === undefined ? {} : { proofLine }),
    },
  }];
}

export { DESIGN_REVIEW_HIGH_RISK_REASONS };
