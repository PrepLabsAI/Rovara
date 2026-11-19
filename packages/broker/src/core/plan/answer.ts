// Structured plans (the plan step): what a planning run's saved answer (`plan.md`) becomes. This is the part of Cloud's `storePlanAnswer` (`aws/broker/plan-answers.ts`) that reads and
// judges the planner's text and stores nothing: it parses the answer as a structured plan document, holds it to the rules of the task (the plan's parts, one repository for ordered work, no
// application intent that was not offered), credits the owner's request as the plan's "why" and gives the canonical JSON the digest is made from. The caller stores the bytes, runs the
// self-check (`self-check.ts`) and submits the artifact. Nothing here names a store, a model or a code host.
import {
  PLAN_WHY_REQUEST_MAX_CHARS, WORKFLOW_PLAN_MAX_BYTES, canonicalPlanJson, hideEmailAddresses, parsePlanDocument, planAnswerMissingParts, retiredClaimIds, validateTaskGraph,
  type PlanDocument, type PlanDocumentKind, type WorkflowCheck, type WorkflowCheckProposal, type WorkflowSnapshot,
} from "@agentx/contracts";
import { TASK_OWNER_LABEL, taskOwnerLabel } from "../../developer/task-records.js";
import { cutText } from "../task-flow/support.js";

/** What Rovara says of a plan it could not read: the problems found, at most this many, kept so Retry planning can tell the planner what to fix. */
export const PLAN_UNREADABLE_ERRORS_MAX = 5;
/** The most bytes of an earlier structured document read back to find the claim numbers that are retired. */
export const EARLIER_PLAN_MAX_BYTES = 32_768;
/** Who a plan's "why" credits when the task kept no request text (a task from before it was stored): the planner's own entries, under this name. */
export const PLANNER_WHY_AUTHOR = "AgentX's summary";

/** The document a planning run writes at this point of the workflow (a Quick task writes the coding plan at once; a Full one writes requirements, then a design, then the coding plan). */
export function planDocumentKindOf(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): PlanDocumentKind {
  return workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
}

export interface PlanAnswerInput {
  /** The planner's saved answer, as the worker uploaded it. */
  content: string;
  kind: PlanDocumentKind;
  workflow: Pick<WorkflowSnapshot, "definitionVersion" | "checkPolicy">;
  /** The task: its id (a work breakdown is bound to it), the owner's request and the name it was made under. */
  task: { taskId: string; requestText?: string | undefined; developerName?: string | undefined; ticket?: { system: string; id: string } | undefined };
  /** The project revision the task started on: its repositories (the plan's checks run in one of them). */
  repositories: ReadonlyArray<{ name: string; path: string }>;
  /** Every earlier structured document of this task, oldest first: the claim numbers they dropped may not come back. */
  earlier: readonly PlanDocument[];
  /** Whether this planning run was asked for (and its worker parses) the schema-v2 application plan. Code never offers it, so a plan that holds one is unreadable. */
  applicationPlanNegotiated?: boolean;
  /** The text Rovara parses and the text the plan's parts are read from can differ (a coding plan with the project's CI checks added). Absent: `content`. */
  parsedContent?: string;
}

export type PlanAnswer =
  | { ok: true; plan: PlanDocument; canonical: string; proposal?: WorkflowCheckProposal | undefined; noChangeNeeded: boolean }
  | { ok: false; errors: string[] };

/** How the plan page credits the words of a task that started from a ticket: "from ticket ENG-1". */
export const TICKET_WHY_AUTHOR_PREFIX = "from ticket ";

/** The "why" of a stored plan: the owner's own request first, credited to the owner (the planner's own entries are discarded). A task that kept no request keeps the planner's, under Rovara's name for them. */
export function planWhyOf(task: { requestText?: string | undefined; developerName?: string | undefined; ticket?: { system: string; id: string } | undefined }, plannerEntries: PlanDocument["why"]): PlanDocument["why"] {
  if (task.requestText === undefined) return plannerEntries.map((entry) => ({ text: entry.text, author: PLANNER_WHY_AUTHOR }));
  // A task started from a ticket asks what the ticket says: its words are the ticket's, and the owner reading the plan must not take them for their own.
  if (task.ticket !== undefined) return [{ text: hideEmailAddresses(cutText(task.requestText, PLAN_WHY_REQUEST_MAX_CHARS)), author: cutText(`${TICKET_WHY_AUTHOR_PREFIX}${task.ticket.id}`, 80) }];
  const name = cutText(task.developerName ?? "", 80);
  return [{ text: hideEmailAddresses(cutText(task.requestText, PLAN_WHY_REQUEST_MAX_CHARS)), author: name === "" ? TASK_OWNER_LABEL : taskOwnerLabel(name) }];
}

/** The checks the plan's `checks` member is read against: the project's repositories and what the task's policy always runs. Absent for a task with no check policy. */
function checksInputOf(input: PlanAnswerInput): { repositoryPaths: string[]; required: WorkflowCheck[]; optionalCount: number; listRequired?: boolean } | undefined {
  const policy = input.workflow.checkPolicy;
  if (input.kind !== "plan" || policy === undefined) return undefined;
  return {
    repositoryPaths: input.repositories.map((repository) => repository.path),
    required: policy.required,
    optionalCount: policy.optional.length,
    ...(input.workflow.definitionVersion === "1.1.0" ? { listRequired: true } : {}),
  };
}

/**
 * Reads the planner's answer. A readable plan gives its canonical JSON (the bytes the digest and the owner's approval bind); an unreadable one gives the problems, in the document reader's own
 * words, which Retry planning (and the one automatic second run) tell the planner.
 */
export function readPlanAnswer(input: PlanAnswerInput): PlanAnswer {
  if (Buffer.byteLength(input.content, "utf8") > WORKFLOW_PLAN_MAX_BYTES) return { ok: false, errors: ["the answer is too long"] };
  const checks = checksInputOf(input);
  const parsed = parsePlanDocument(input.parsedContent ?? input.content, { kind: input.kind, retiredClaimIds: retiredClaimIds([...input.earlier]), ...(checks === undefined ? {} : { checks }) });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  // Rovara Code version 2: a coding plan names what changes, which files and how it is tested. The worker asked once more when a part was missing; a plan still missing one is unreadable.
  if (input.workflow.definitionVersion === "1.1.0" && input.kind === "plan") {
    const missing = planAnswerMissingParts(input.content, parsed.plan);
    if (missing.length > 0) return { ok: false, errors: missing };
  }
  // Defense in depth with the worker's own check: a version 2 intent is stored only from a run that negotiated it.
  if (parsed.plan.e2e?.schemaVersion === 2 && input.applicationPlanNegotiated !== true) {
    return { ok: false, errors: ["the plan: e2e schemaVersion 2 was not offered for this planning step; use the schemaVersion 1 portable intent, or leave e2e out"] };
  }
  if (parsed.plan.workBreakdown !== undefined) {
    if (input.repositories.length !== 1) return { ok: false, errors: ["ordered work is available only for a task pinned to one registered repository"] };
    const graph = validateTaskGraph(parsed.plan.workBreakdown, { taskId: input.task.taskId, repositoryId: input.repositories[0]!.name });
    if (!graph.ok) return { ok: false, errors: graph.errors };
  }
  const plan: PlanDocument = { ...parsed.plan, why: planWhyOf(input.task, parsed.plan.why) };
  const canonical = canonicalPlanJson(plan);
  if (Buffer.byteLength(canonical, "utf8") > WORKFLOW_PLAN_MAX_BYTES) return { ok: false, errors: ["the plan is too long once saved"] };
  return { ok: true, plan, canonical, ...("proposal" in parsed && parsed.proposal !== undefined ? { proposal: parsed.proposal } : {}), noChangeNeeded: parsed.plan.noChangeNeeded !== undefined };
}
