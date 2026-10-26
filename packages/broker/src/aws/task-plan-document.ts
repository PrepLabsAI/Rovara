import { agentXError, redactText, type PlanDocument, type WorkflowArtifact } from "@agentx/contracts";
import { loadWorkflowDocument } from "../developer/plan-artifacts.js";
import { planCheckSummary, type PlanCheckSummary } from "../developer/plan-check-summary.js";
import { SELF_CHECK_NOT_APPLICABLE, loadPlanSelfCheck } from "../developer/plan-self-check.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";

/** PLANFULLDOC: the answer of `GET /v1/dev/tasks/:id/plan`. */
export interface TaskPlanDocumentView {
  taskId: string;
  document: "requirements" | "design" | "plan";
  version: number;
  /** The digest the document was approved or can be approved by (the recorded one, checked against the stored bytes). */
  sha256: string;
  approved: boolean;
  /** Whether this is the latest version of the document. */
  current: boolean;
  /** Every stored version of the document, oldest first. */
  versions: number[];
  /** The canonical plan document, whole: the same members the stored plan has, none cut. Untrusted model text. */
  content: PlanDocument;
  /** The plan's checks in plain words, with far fewer cuts than the Slack card. */
  summary: PlanCheckSummary;
}

/** The most of a self-check record that is read (a real one is a few kilobytes). */
const SELF_CHECK_READ_BYTES = 70_000;
const DOCUMENTS = ["requirements", "design", "plan"] as const;

/**
 * One stored version of a task's structured plan, whole. The caller has already shown the task is the caller's own. Only
 * this task's private storage is read, and only a document whose bytes match their recorded digest is returned. A
 * document stored as Markdown (before structured plans) is refused: it has no canonical form to return.
 */
export async function readTaskPlanDocument(
  task: DeveloperTaskRecord,
  read: (objectKey: string, maxBytes: number) => Promise<string | undefined>,
  query: { document?: string | null; version?: number | undefined },
): Promise<TaskPlanDocumentView> {
  const kind = query.document === undefined || query.document === null ? "plan" : DOCUMENTS.find((candidate) => candidate === query.document);
  if (kind === undefined) throw agentXError("CONFIG_INVALID", "document must be requirements, design or plan");
  const versions = (task.workflow?.artifacts ?? []).filter((artifact: WorkflowArtifact) => artifact.type === kind).sort((left, right) => left.version - right.version);
  const latest = versions.at(-1);
  const artifact = query.version === undefined ? latest : versions.find((candidate) => candidate.version === query.version);
  if (artifact === undefined || latest === undefined) {
    throw agentXError("NOT_FOUND", query.version === undefined ? `this task has no ${kind} document yet` : `this task has no ${kind} document v${query.version}`);
  }
  if (!artifact.objectKey.startsWith(`private/${task.ownerKey}/${task.workspaceId}/`)) throw agentXError("RUNTIME_UNAVAILABLE", `the ${kind} document v${artifact.version} could not be verified`);
  const loaded = await loadWorkflowDocument(read, artifact, {}).catch(() => undefined);
  if (loaded === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `the ${kind} document v${artifact.version} could not be verified`);
  if (loaded.format !== "structured") throw agentXError("NOT_FOUND", `the ${kind} document v${artifact.version} was written before structured plans and has no canonical form`);
  // What the plan self-check stored beside this document (only a coding plan is judged); no usable record is "not checked".
  const selfCheck = kind === "plan" ? await loadPlanSelfCheck(async (key) => read(key, SELF_CHECK_READ_BYTES), artifact) : SELF_CHECK_NOT_APPLICABLE;
  const approved = (task.workflow?.decisions ?? []).some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === artifact.sha256);
  return {
    taskId: task.taskId, document: kind, version: artifact.version, sha256: artifact.sha256, approved, current: artifact === latest,
    versions: versions.map((candidate) => candidate.version),
    content: redactedPlan(loaded.plan),
    summary: planCheckSummary(loaded.plan, { detail: "page", selfCheck }),
  };
}

/** The plan with secrets removed from every string in it, the way the task page and the Markdown copy show it. */
function redactedPlan(plan: PlanDocument): PlanDocument {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    return value;
  };
  return walk(plan) as PlanDocument;
}
