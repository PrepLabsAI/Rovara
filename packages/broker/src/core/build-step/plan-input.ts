// Lane L10, the build step: the approved coding plan, read back and checked against the digest the approval recorded (Cloud's `approvedCodingPlan`). The structured plan reader is the
// public `loadWorkflowDocument` (it takes a read function, so it needs no object store of its own): a structured plan is given as its Markdown copy, a Markdown plan as it was saved.
import { WORKFLOW_PLAN_MAX_BYTES, agentXError, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument, shortenMarkdown } from "../../developer/plan-document-reader.js";
import { planOwnerAnswers } from "../../developer/owner-answers.js";
import type { ArtifactReader } from "../task-flow/deps.js";

export interface ApprovedPlan {
  text: string;
  sha256: string;
  /** The plan's "Not changing" list (a structured plan only). */
  notChanging?: string[];
}

/** Reads a document by object key as text, at most `maxBytes` of it; undefined when it cannot be read. */
export function textReaderOf(artifacts: ArtifactReader | undefined): (objectKey: string, maxBytes: number) => Promise<string | undefined> {
  return async (objectKey, maxBytes) => {
    if (artifacts === undefined) return undefined;
    const bytes = await artifacts.get(objectKey, maxBytes);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  };
}

/** The owner-approved coding plan. WORKSPACE_NOT_READY when it is missing or no longer matches its digest: coding never starts from a plan nobody approved. */
export async function approvedCodingPlan(artifacts: ArtifactReader | undefined, workflow: Pick<WorkflowSnapshot, "artifacts" | "decisions">): Promise<ApprovedPlan> {
  const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  if (plan === undefined) throw agentXError("WORKSPACE_NOT_READY", "the approved coding plan is missing");
  // The coder is told the document's decisions are settled: with the owner's answers when the approval carried any, else with AgentX's recommended answer to each (a Markdown plan has none).
  const approval = [...workflow.decisions].reverse().find((decision) => decision.decision === "APPROVE" && decision.artifactDigest === plan.sha256 && (decision.source ?? "GATE") === "GATE");
  const answers = approval?.answerOverrides === undefined ? "recommended" as const : planOwnerAnswers(approval.answerOverrides, []);
  const loaded = await loadWorkflowDocument(textReaderOf(artifacts), plan, { answers });
  if (loaded === undefined) throw agentXError("WORKSPACE_NOT_READY", "the approved coding plan failed its digest check");
  return { text: loaded.markdown, sha256: plan.sha256, ...(loaded.format === "structured" ? { notChanging: loaded.plan.notChanging } : {}) };
}

/**
 * What the reviewers are shown of the plan the owner approved: its Markdown copy, cut to the plan limit, and the approved artifact's digest. A plan that is missing or no longer matches
 * its digest is not shown (the reviewers then judge the change without it) rather than holding the reviews back.
 */
export async function reviewPlanOf(artifacts: ArtifactReader | undefined, workflow: Pick<WorkflowSnapshot, "artifacts" | "decisions">): Promise<{ markdown: string; sha256: string } | undefined> {
  try {
    const approved = await approvedCodingPlan(artifacts, workflow);
    return { markdown: shortenMarkdown(approved.text, WORKFLOW_PLAN_MAX_BYTES), sha256: approved.sha256 };
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === "WORKSPACE_NOT_READY") return undefined;
    throw error;
  }
}
