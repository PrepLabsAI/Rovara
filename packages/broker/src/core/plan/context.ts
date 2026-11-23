// Structured plans: what a structured planning prompt is given besides the request, read from the task's own records: the earlier documents of the task (the claim numbers they dropped
// may not come back; the one the owner asked to change, or the approved one this builds on, is handed over as data) and the project's checks. A document that cannot be read (missing, or no longer
// matching its digest) is left out; the run then plans without it.
import { retiredClaimIds, type JsonValue, type PlanDocument, type PlanDocumentKind, type PlanOwnerAnswers, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
import { EARLIER_PLAN_MAX_BYTES, planDocumentKindOf } from "./answer.js";
import type { StructuredPlanContext, StructuredPlanInput } from "./prompts.js";

import type { ApplicationE2ESeams } from "../e2e/application-seams.js";
import { offersApplicationE2EPlan } from "../../e2e/feature-plan-executable-kinds.js";

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

function previousPlanContext(workflow: WorkflowSnapshot, base: Awaited<ReturnType<typeof earlierPlans>>[number] | undefined, sentBack: boolean): StructuredPlanContext | undefined {

  if (base !== undefined) {
    const answers = answersOf(workflow, base.sha256, base.plan);
    // A document sent back mentions the answers only when the owner changed one; one that was approved always says how its decisions were settled.
    const chosen = sentBack ? (answers.changed ? answers.chosen : undefined) : answers.chosen;
    return { kind: base.kind, version: base.version, plan: base.plan, ...(chosen === undefined ? {} : { chosen }) };
  }
  return undefined;
}

/**
 * The rules and the document for a structured planning run, or undefined when the install asks for Markdown plans. `previous` is the document the owner asked to change (the same kind), else the last
 * approved document of an earlier phase.
 */
export async function structuredPlanContextOf(deps: Omit<TaskFlowDeps, "applicationE2E"> & { applicationE2E?: Pick<ApplicationE2ESeams, "planning"> }, task: TaskRecord, workflow: WorkflowSnapshot): Promise<{ rules: StructuredPlanInput; previous?: StructuredPlanContext | undefined } | undefined> {
  if (deps.planFormat === "markdown") return undefined;
  const kind = planDocumentKindOf(workflow);
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const earlier = await earlierPlans(deps, workflow);
  const same = earlier.filter((entry) => entry.kind === kind).at(-1);
  const before = workflow.path === "FULL" ? earlier.filter((entry) => ORDER.indexOf(entry.kind) < ORDER.indexOf(kind)).at(-1) : undefined;
  const base = same ?? before;
  const previous = previousPlanContext(workflow, base, base === same);
  const policy = workflow.checkPolicy;
  const e2ePlanningContext = kind === "plan" ? await deps.applicationE2E?.planning.context({ ...task, workflow }) : undefined;
  return {
    rules: {
      ...(e2ePlanningContext === undefined ? {} : { e2ePlanningContext }),
      kind, path: workflow.path, rovaraV2: workflow.definitionVersion === "1.1.0", retired: [...retiredClaimIds(earlier.map((entry) => entry.plan))],
      ...(policy === undefined || project === undefined ? {} : { checks: { repositoryPaths: project.definition.repositories.map((repository) => repository.path), required: policy.required } }),
    },
    ...(previous === undefined ? {} : { previous }),
  };
}

/** The worker feature that parses the version 2 application intent (the legacy delivery drops the version for a worker without it; the core never drops: the step is refused, as for every feature). */
export const APPLICATION_PLAN_FEATURE = "task.workflowE2EApplicationPlan";

/**
 * What a structured planning run is dispatched with: the payload that tells the worker (and, from the stored operation, the broker) how to read the answer, and the worker features the step needs.
 * A run that was offered the application planning context (a pinned project revision with an e2e policy, and a target whose runtime is ready: executable kinds) is also told the version 2 application
 * intent is allowed (`workflowE2EPlanVersion: 2`), exactly when the planner's prompt asks for it (`offersApplicationE2EPlan`, the legacy path's own test). Without that flag the worker and
 * `processPlanAnswer` refuse the v2 plan the planner was asked to write. Every other project's dispatch is what it always was.
 */
export function structuredPlanDispatch(structured: Awaited<ReturnType<typeof structuredPlanContextOf>>, workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): { payload?: Record<string, JsonValue>; requires: string[] } {
  if (structured === undefined) return { requires: ["task.workflowMode"] };
  const application = offersApplicationE2EPlan(structured.rules.e2ePlanningContext);
  return {
    payload: { planFormat: "structured", ...(application ? { workflowE2EPlanVersion: 2 } : {}), ...(workflow.path === "FULL" && workflow.reviewPhase !== undefined ? { workflowPhase: workflow.reviewPhase } : {}) },
    requires: ["task.workflowMode", "task.structuredPlans", ...(application ? [APPLICATION_PLAN_FEATURE] : [])],
  };
}
