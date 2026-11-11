// Who may turn unattended work on. Turning a trigger on, and deciding a chain's gate, are the owner's acts and nothing else's: each is an approval request the `Approvers` port verifies, bound to the exact
// thing (the request id, its revision and its digest), so a proof for one trigger or one gate is no use for another or for a changed one. A trigger's own run, a chain step's report, an event's text and a model
// never reach this: they have no way to produce a proof, and nothing in the automation folder issues one.
import { createHash } from "node:crypto";
import {
  agentXError, approvalProofKey, canonicalJson, companyScoped, when,
  type ApprovalProof, type ApprovalRequest, type Approvers, type Principal, type TransactItem,
} from "@agentx/contracts";
import { putRow } from "./kit.js";

export const AUTOMATION_APPROVAL_KINDS = ["trigger_on", "chain_gate"] as const;
export type AutomationApprovalKind = (typeof AUTOMATION_APPROVAL_KINDS)[number];

export const AUTOMATION_PROOF_PARTITION = "AUTOMATION_PROOF";
const proofUseKey = (companyId: string, proof: ApprovalProof) => ({ pk: companyScoped(companyId, AUTOMATION_PROOF_PARTITION), sk: approvalProofKey(proof) });

/** The request a surface presents and a proof is checked against. `facts` is what the owner saw (it is hashed into the digest, so a change after they looked makes the proof stale). */
export function automationRequest(input: { companyId: string; kind: AutomationApprovalKind; subjectId: string; revision: number; facts: unknown; project?: string | undefined }): ApprovalRequest {
  return {
    companyId: input.companyId, requestId: `automation:${input.kind}:${input.subjectId}:${String(input.revision)}`, kind: input.kind, subject: { type: input.kind === "trigger_on" ? "trigger" : "chain_gate", id: input.subjectId },
    ...(input.project === undefined ? {} : { projectName: input.project }), revision: input.revision, artifactDigest: createHash("sha256").update(canonicalJson(input.facts), "utf8").digest("hex"),
    // Unattended paid work is high risk: the strongest method the approvers offer is the one that counts.
    risk: "high",
  };
}

/**
 * Checks the owner's proof for the request and returns who approved and the row that uses the proof up (it goes in the SAME transaction as the change, written only if absent, so two racing calls cannot both
 * succeed). Throws `FORBIDDEN` when the approvers do not accept it.
 */
export async function verifyOwnerProof(approvers: Approvers, request: ApprovalRequest, proof: ApprovalProof | undefined): Promise<{ approver: Principal; method: string; used: TransactItem }> {
  if (proof === undefined) throw agentXError("FORBIDDEN", "this needs the owner's approval, given on the local page");
  const verdict = await approvers.verify(request, proof);
  if (!verdict.approved) throw agentXError("FORBIDDEN", `the approval was not accepted: ${verdict.reason}`);
  return { approver: verdict.approver, method: verdict.method, used: putRow(proofUseKey(request.companyId, proof), "AUTOMATION_PROOF", { requestId: request.requestId, kind: request.kind, at: new Date().toISOString() }, when.absent()) };
}
