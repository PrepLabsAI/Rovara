// Design review stage: builds the Proof section's design context from what the broker holds, through two ports the AWS layer supplies (no new env var, no IAM: they read the task's own artifact store and
// its own approval record). Fail closed: no design review on the task, no approved design, a text that does not hash to the approved digest, or an approval record that is missing gives NO context, and the Proof section
// is then exactly what it was. Nothing about an unapproved design is ever claimed.
import type { WorkflowSnapshot } from "@agentx/contracts";
import { approvedDesignDigestOf } from "./approved-design.js";
import { verifiedDesignText } from "./proof-links.js";
import type { DesignProofApproval, ProofDesignContext } from "./proof-line.js";

export interface ProofDesignPorts {
  /** The latest design document's text. Undefined where it cannot be read. */
  designText(workflow: WorkflowSnapshot): Promise<string | undefined>;
  /**
   * The approval as the broker recorded it for this design digest (approver, tier, open blockers, the cleaned one-line reason). Undefined where none is recorded: the line is then left out rather than guessed
   * from the request or the page.
   */
  approval(workflow: WorkflowSnapshot, designDigest: string): Promise<DesignProofApproval | undefined>;
}

export async function loadProofDesignContext(ports: ProofDesignPorts, workflow: WorkflowSnapshot): Promise<ProofDesignContext | undefined> {
  if (workflow.designReview === undefined) return undefined;
  const digest = approvedDesignDigestOf(workflow);
  if (digest === undefined) return undefined;
  const text = await ports.designText(workflow);
  const approved = { digest, text: text ?? "" };
  if (text === undefined || verifiedDesignText(approved) === undefined) return undefined;
  const approval = await ports.approval(workflow, digest);
  if (approval === undefined) return undefined;
  return { approved, review: workflow.designReview, approval };
}
