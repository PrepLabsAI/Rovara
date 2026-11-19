// Structured plans: what a structured planning prompt is given besides the request, read from the task's own records: the earlier documents of the task (the claim numbers they dropped
// may not come back; the one the owner asked to change, or the approved one this builds on, is handed over as data) and the project's checks. A document that cannot be read (missing, or no longer
// matching its digest) is left out; the run then plans without it.
import { retiredClaimIds, type PlanDocument, type PlanDocumentKind, type PlanOwnerAnswers, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
import { EARLIER_PLAN_MAX_BYTES, planDocumentKindOf } from "./answer.js";
import type { StructuredPlanContext, StructuredPlanInput } from "./prompts.js";

const ORDER: readonly PlanDocumentKind[] = ["requirements", "design", "plan"];

/** Every earlier structured document of this task, oldest first, with its artifact: a document that cannot be read back or fails its digest is skipped. */
export async function earlierPlans(deps: Pick<TaskFlowDeps, "artifacts">, workflow: Pick<WorkflowSnapshot, "artifacts">): Promise<Array<{ kind: PlanDocumentKind; version: number; plan: PlanDocument; sha256: string }>> {
  if (deps.artifacts === undefined) return [];
  const read = textReaderOf(deps.artifacts);
  const found: Array<{ kind: PlanDocumentKind; version: number; plan: PlanDocument; sha256: string }> = [];
  for (const artifact of workflow.artifacts) {
    if (artifact.format !== "structured" || (artifact.type !== "requirements" && artifact.type !== "design" && artifact.type !== "plan")) continue;
    const loaded = await loadWorkflowDocument((key) => read(key, EARLIER_PLAN_MAX_BYTES), artifact, {}).catch(() => undefined);
    if (loaded?.format === "structured") found.push({ kind: artifact.type, version: artifact.version, plan: loaded.plan, sha256: artifact.sha256 });
  }
  return found;
}

/** The owner's answers on the newest plan decision that carried any (`answerOverrides`), and whether any differs from AgentX's recommended answer. */
function answersOf(workflow: Pick<WorkflowSnapshot, "decisions">, sha256: string, plan: PlanDocument): { chosen: PlanOwnerAnswers["chosen"]; changed: boolean } {
  const decision = [...workflow.decisions].reverse().find((entry) => entry.artifactDigest === sha256 && (entry.source ?? "GATE") === "GATE" && (entry.decision === "APPROVE" || entry.decision === "REQUEST_CHANGES"));
  const chosen = (decision?.answerOverrides ?? []).map((answer) => ({ decisionId: answer.decisionId, optionId: answer.optionId }));
  const picked = new Map(chosen.map((answer) => [answer.decisionId, answer.optionId]));
  return { chosen, changed: (plan.decisions ?? []).some((entry) => (picked.get(entry.id) ?? entry.recommended) !== entry.recommended) };
}

/**
 * The rules and the document for a structured planning run, or undefined when the install asks for Markdown plans. `previous` is the document the owner asked to change (the same kind), else the last
 * approved document of an earlier phase.
 */
export async function structuredPlanContextOf(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot): Promise<{ rules: StructuredPlanInput; previous?: StructuredPlanContext | undefined } | undefined> {
  if (deps.planFormat === "markdown") return undefined;
  const kind = planDocumentKindOf(workflow);
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const earlier = await earlierPlans(deps, workflow);
  const same = earlier.filter((entry) => entry.kind === kind).at(-1);
  const before = workflow.path === "FULL" ? earlier.filter((entry) => ORDER.indexOf(entry.kind) < ORDER.indexOf(kind)).at(-1) : undefined;
  const base = same ?? before;
  let previous: StructuredPlanContext | undefined;
  if (base !== undefined) {
    const answers = answersOf(workflow, base.sha256, base.plan);
    // A document sent back mentions the answers only when the owner changed one; one that was approved always says how its decisions were settled.
    const chosen = base === same ? (answers.changed ? answers.chosen : undefined) : answers.chosen;
    previous = { kind: base.kind, version: base.version, plan: base.plan, ...(chosen === undefined ? {} : { chosen }) };
  }
  const policy = workflow.checkPolicy;
  return {
    rules: {
      kind, path: workflow.path, rovaraV2: workflow.definitionVersion === "1.1.0", retired: [...retiredClaimIds(earlier.map((entry) => entry.plan))],
      ...(policy === undefined || project === undefined ? {} : { checks: { repositoryPaths: project.definition.repositories.map((repository) => repository.path), required: policy.required } }),
    },
    ...(previous === undefined ? {} : { previous }),
  };
}
