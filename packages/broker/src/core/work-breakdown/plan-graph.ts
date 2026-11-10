// the work breakdown of an approved coding plan, read back from the plan's stored document.
//
// A coding plan may carry an ordered list of parts (`workBreakdown`, spec 059): a graph of 1 to 8 items with dependency links, in the one repository the task is pinned to. Approving the plan approves its graph:
// the decision names the graph's digest, the engine records it with the approval (`workflowDependenciesApproval`), and every later start of the ordered run reloads the exact document the approval named and checks the graph
// against that digest again. A graph is never read from the model's answer, a comment or a message.
import { agentXError, taskGraphDigest, validateTaskGraph, type TaskGraphV1, type WorkflowArtifact } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { WORKFLOW_BREAKDOWN_REFUSALS } from "../../developer/workflow-actions.js";
import { textReaderOf } from "../build-step/plan-input.js";
import { loadPlanDocument } from "../plan/document.js";
import type { ArtifactReader, TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
import { workflowDependenciesAllowed } from "./parallel-parts.js";

/** The graph a plan document carries, read from the document the artifact names (bytes checked against its digest). Undefined for a Markdown plan, an unreadable one, or a plan with no breakdown. */
export async function planGraphOf(artifacts: ArtifactReader | undefined, artifact: WorkflowArtifact): Promise<TaskGraphV1 | undefined> {
  const loaded = await loadWorkflowDocument(textReaderOf(artifacts), artifact, {});
  return loaded?.format === "structured" ? loaded.plan.workBreakdown : undefined;
}

/** What a refused approval says when the plan it names cannot be read back. */
export const PLAN_UNREADABLE = "the plan could not be read back, so it was not approved; refresh and try again";

/** What approving a plan binds: the graph's digest, or nothing for a plan with no breakdown; or the sentence that refuses the approval. */
export type BreakdownAnswer = { digest?: string; refusal?: undefined } | { refusal: string; digest?: undefined };

/**
 * The breakdown an approval of the plan waiting now would bind, read from the stored document the artifact digest names. Version 1 tasks need the install's switch; the task must be pinned to one repository; the
 * graph must be valid for this task and that repository. Every Code surface that decides a plan (the page, a card, a comment) gets the digest from here, derived from the same document the decision binds by its own
 * digest, so a surface cannot bind a graph the person was not shown.
 */
export async function breakdownForApproval(
  deps: Pick<TaskFlowDeps, "artifacts" | "projects" | "workflowDependenciesEnabled">,
  task: { taskId: string; project: string; startingRevision: number },
  workflow: { artifacts: readonly WorkflowArtifact[]; definitionVersion?: string },
  artifactDigest: string,
): Promise<BreakdownAnswer> {
  const artifact = workflow.artifacts.find((entry) => entry.type === "plan" && entry.sha256 === artifactDigest);
  if (artifact === undefined || artifact.format !== "structured") return {};
  // A structured plan that cannot be read now (a storage fault, bytes that no longer match the approval's digest) is refused, never approved as a plan with no breakdown: ordered work never falls back to plain coding.
  const loaded = await loadPlanDocument(deps.artifacts, artifact);
  if (loaded.kind !== "structured") return { refusal: PLAN_UNREADABLE };
  const graph: TaskGraphV1 | undefined = loaded.plan.workBreakdown;
  if (graph === undefined) return {};
  if (!workflowDependenciesAllowed(deps, workflow)) return { refusal: WORKFLOW_BREAKDOWN_REFUSALS.notEnabled };
  const pinned = await deps.projects.revision(task.project, task.startingRevision);
  if (pinned === undefined || pinned.definition.repositories.length !== 1) return { refusal: WORKFLOW_BREAKDOWN_REFUSALS.onePinnedRepository };
  const validated = validateTaskGraph(graph, { taskId: task.taskId, repositoryId: pinned.definition.repositories[0]!.name });
  if (!validated.ok) return { refusal: `the approved work breakdown is invalid: ${validated.errors.join("; ")}` };
  return { digest: taskGraphDigest(validated.graph) };
}

/** The approved graph of a task, reloaded from the exact plan the approval named and checked against the approval's digest again. WORKSPACE_NOT_READY when it cannot be: ordered work never falls back to plain coding. */
export async function approvedGraphOf(deps: Pick<TaskFlowDeps, "artifacts">, task: Pick<TaskRecord, "taskId">, workflow: { artifacts: readonly WorkflowArtifact[]; workflowDependenciesApproval?: { artifactDigest: string; graphDigest: string } | undefined }): Promise<TaskGraphV1 | undefined> {
  const approval = workflow.workflowDependenciesApproval;
  if (approval === undefined) return undefined;
  const artifact = workflow.artifacts.find((entry) => entry.type === "plan" && entry.sha256 === approval.artifactDigest);
  if (artifact === undefined) throw agentXError("WORKSPACE_NOT_READY", "the approved work breakdown plan is missing");
  const graph = await planGraphOf(deps.artifacts, artifact);
  if (graph === undefined || graph.taskId !== task.taskId || taskGraphDigest(graph) !== approval.graphDigest) throw agentXError("WORKSPACE_NOT_READY", "the approved work breakdown failed its digest check");
  return graph;
}
