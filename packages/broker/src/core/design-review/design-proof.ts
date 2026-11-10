// Design review stage: the design's part of the Proof, read from what the broker holds. Fail closed: no design review on the task, no approved design, a text that does not hash to the approved digest, or an approval record
// that is missing gives NO context, and the Proof is then exactly what it was. Nothing about an unapproved design is ever claimed.
//   - `loadDesignProof`: the approved design (read back through the artifact store and checked against the digest the approval named) and the approval record the design's approval wrote in its own transaction (decision.ts);
//   - `proofDesignOf`: the shape the Proof section reads (`core/proof/proof-section.ts` `ProofDesignContext`): the one design line, and the `§3.N` subsections of the approved design that name each requirement.
import type { DocumentStore, WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { ProofContext, ProofDesignContext as ProofSectionDesign } from "../proof/proof-section.js";
import type { ArtifactReader } from "../task-flow/deps.js";
import { designApprovalKey } from "./decision.js";
import { loadProofDesignContext } from "./proof-context.js";
import { designLinksByClaim } from "./proof-links.js";
import { designProofLine, type DesignProofApproval, type ProofDesignContext } from "./proof-line.js";

export interface DesignProofDeps { store: Pick<DocumentStore, "get">; artifacts: ArtifactReader | undefined }

/** The approved design's context for a task, or undefined. Informational: a fault leaves the design out and nothing else. */
export async function loadDesignProof(deps: DesignProofDeps, taskId: string, workflow: WorkflowSnapshot): Promise<ProofDesignContext | undefined> {
  try {
    return await loadProofDesignContext({
      async designText(current) {
        const artifact = current.artifacts.filter((entry) => entry.type === "design").at(-1);
        if (artifact === undefined || deps.artifacts === undefined) return undefined;
        return (await loadWorkflowDocument(textReaderOf(deps.artifacts), artifact, {}).catch(() => undefined))?.markdown;
      },
      async approval(_current, designDigest): Promise<DesignProofApproval | undefined> {
        const item = await deps.store.get(designApprovalKey(taskId, designDigest));
        if (item === undefined || item["designDigest"] !== designDigest || typeof item["approverLabel"] !== "string") return undefined;
        const tier = item["tier"];
        const blockers = item["openBlockers"];
        if ((tier !== "low" && tier !== "medium" && tier !== "high") || typeof blockers !== "number" || !Number.isInteger(blockers) || blockers < 0) return undefined;
        return { approverLabel: item["approverLabel"], tier, openBlockers: blockers, ...(typeof item["proofReason"] === "string" ? { reason: item["proofReason"] } : {}) };
      },
    }, workflow);
  } catch {
    return undefined;
  }
}

/** The Proof section's input from the design context: the line, and the links to sections of the APPROVED design only. */
export const proofDesignOf = (context: ProofDesignContext): ProofSectionDesign => ({
  line: designProofLine(context),
  linksFor: (claimIds) => designLinksByClaim(claimIds, context.approved),
});

/** What the Proof section's `design` input reads for a task (to be handed to `loadProofContext`). */
export function proofDesignReader(deps: DesignProofDeps, taskId: string): (workflow: WorkflowSnapshot) => Promise<ProofSectionDesign | undefined> {
  return async (workflow) => {
    const context = await loadDesignProof(deps, taskId, workflow);
    return context === undefined ? undefined : proofDesignOf(context);
  };
}

/**
 * The Proof section's input for a task that went through design review: the approved coding plan's claims with the design line and the links to the approved design. Undefined (the pull request is then described exactly as for
 * any other task) when there is no approved design, no approval record, or the coding plan has no claims for a Proof table to list.
 */
export async function designProofContextOf(deps: DesignProofDeps, taskId: string, workflow: WorkflowSnapshot): Promise<ProofContext | undefined> {
  try {
    const design = await proofDesignReader(deps, taskId)(workflow);
    const planArtifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
    if (design === undefined || planArtifact === undefined || deps.artifacts === undefined) return undefined;
    const loaded = await loadWorkflowDocument(textReaderOf(deps.artifacts), planArtifact, { answers: "recommended" });
    if (loaded?.format !== "structured" || loaded.plan.claims.length === 0) return undefined;
    return { plan: loaded.plan, design };
  } catch {
    return undefined;
  }
}
