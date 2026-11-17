// The facts the log's `plan_summary` is made of, read from the task and its plan document: the card's summary lines (`core/decisions/plan-summary.ts`), the risk tier the decision gate grades the plan at, and the
// estimate range the task keeps. Read at the moment the plan waits for review, for the revision that waits.
import { formatRunLimitUsd, type DocumentStore, type OrgId, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import { documentSummary } from "../decisions/plan-summary.js";
import type { DecisionGate } from "../decisions/approval-gate.js";
import { WORKFLOW_DOCUMENT_KIND, currentDocumentType } from "../decisions/workflow-subject.js";
import type { ArtifactReader } from "../task-flow/deps.js";
import { taskKey } from "../task-flow/keys.js";
import type { PlanSummaryFacts } from "./milestones.js";

export interface PlanSummarySourceDeps {
  store: Pick<DocumentStore, "get">;
  artifacts: ArtifactReader | undefined;
  gate: Pick<DecisionGate, "requirement">;
}

/** The summary of the plan this company's task waits on, or undefined when it does not wait on one, the document cannot be read or says nothing usable. */
export function planSummarySourceOf(deps: PlanSummarySourceDeps): (orgId: OrgId, taskId: string) => Promise<PlanSummaryFacts | undefined> {
  return async (orgId, taskId) => {
    const task = await deps.store.get(taskKey(taskId));
    if (task === undefined || (task["orgId"] ?? task["companyId"]) !== orgId || task["closedAt"] !== undefined) return undefined;
    const workflow = task["workflow"] as WorkflowSnapshot | undefined;
    if (workflow === undefined || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
    const artifact: WorkflowArtifact | undefined = workflow.artifacts.filter((entry) => entry.type === currentDocumentType(workflow)).at(-1);
    if (artifact === undefined) return undefined;
    const summary = documentSummary(await loadWorkflowDocument(textReaderOf(deps.artifacts), artifact, {}).catch(() => undefined));
    if (summary === undefined) return undefined;
    const found = await deps.gate.requirement(orgId, WORKFLOW_DOCUMENT_KIND, taskId);
    const estimate = task["runEstimate"] as { lowUsd?: unknown; highUsd?: unknown } | undefined;
    return {
      revision: workflow.revision, needed: summary.needed, lines: summary.lines, risk: found?.risk ?? "high",
      ...(typeof estimate?.lowUsd === "number" && typeof estimate.highUsd === "number" ? { estimate: `${formatRunLimitUsd(estimate.lowUsd)} to ${formatRunLimitUsd(estimate.highUsd)}` } : {}),
    };
  };
}
