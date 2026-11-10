// The one way a stored structured plan is read back for a decision: the bytes are checked against the digest the approval binds, and a document that cannot be read (missing, changed, damaged) is
// reported as unreadable, never as "a plan with nothing in it". Every surface that offers or takes an approval, and the work breakdown bound with it, reads the plan through this function, so they
// all fail closed together.
import type { PlanDocument, WorkflowArtifact } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { ArtifactReader } from "../task-flow/deps.js";

export type LoadedPlanDocument = { kind: "structured"; plan: PlanDocument } | { kind: "unreadable" };

/** A structured artifact, read back and checked against its digest. A Markdown artifact is not a structured plan: ask only for artifacts whose `format` is "structured". */
export async function loadPlanDocument(artifacts: ArtifactReader | undefined, artifact: WorkflowArtifact): Promise<LoadedPlanDocument> {
  try {
    const loaded = await loadWorkflowDocument(textReaderOf(artifacts), artifact, {});
    return loaded?.format === "structured" ? { kind: "structured", plan: loaded.plan } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** What a decision is checked against, read from the plan itself: its decisions with their option ids and recommendation, and what it says of needing no change. */
export function planFactsOf(plan: PlanDocument): { planDecisions: Array<{ id: string; optionIds: string[]; recommended: string }>; noChangeNeeded?: unknown } {
  return {
    planDecisions: plan.decisions.map((entry) => ({ id: entry.id, optionIds: entry.options.map((option) => option.id), recommended: entry.recommended })),
    ...(plan.noChangeNeeded === undefined ? {} : { noChangeNeeded: { ...plan.noChangeNeeded, restatement: plan.title } }),
  };
}
