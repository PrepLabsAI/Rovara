// Structured plans: the words a planning run is given when it is asked for a structured plan document (Cloud's `task-operations.ts` planning prompt and `workflow-inputs.ts`
// `structuredWorkflowPrompt`, on the ports). The rules of the document itself (the claim tree, the decisions, the checks, the quality list) are the public `planDocumentInstructions` and
// `planChecksInstructions`; this module only decides which of them a step is asked for and how a revision or the next phase is introduced. The Markdown plan prompt (`step-prompts.ts`) is
// what a worker that cannot read a structured plan is asked for.
import { PLAN_PHASE_LIMITS, planChecksInstructions, planDocumentInstructions, previousPlanDocumentBlock } from "../../developer/plan-instructions.js";
import { ROVARA_CODE_PLAN_GUIDANCE, canonicalPlanJson, type PlanDocument, type PlanDocumentKind, type PlanOwnerAnswers, type WorkflowCheck } from "@agentx/contracts";
import { ownerAnswersSentence } from "../../developer/owner-answers-text.js";

const KIND_NAMES: Record<PlanDocumentKind, string> = { requirements: "requirements", design: "design", plan: "coding plan" };

/** A structured document a planning run is told about: the earlier version of this document, or the approved document this one builds on. */
export interface StructuredPlanContext {
  kind: PlanDocumentKind;
  version: number;
  plan: PlanDocument;
  /** The owner's answers to that document's decisions, as they approved it (an empty list: AgentX's recommended answer to each) or sent it back with them changed. Absent: none are mentioned. */
  chosen?: PlanOwnerAnswers["chosen"] | undefined;
}

/** What a structured planning prompt needs of the project and the task. */
export interface StructuredPlanInput {
  kind: PlanDocumentKind;
  path: "QUICK" | "FULL";
  /** Rovara Code version 2 (every Code task): the plan may say no code change is needed and a coding plan must name what changes, which files and how it is tested. */
  rovaraV2: boolean;
  /** Claim numbers the task's earlier documents dropped: they may not come back. */
  retired?: readonly string[] | undefined;
  /** Present for a task with a check policy: the repositories the checks run in and the checks that always run. */
  checks?: { repositoryPaths: readonly string[]; required: readonly Pick<WorkflowCheck, "label" | "command">[] } | undefined;
}

/** The rules of a structured planning run for one document kind. */
export function structuredPlanRules(input: StructuredPlanInput): string {
  const instructions = planDocumentInstructions({
    kind: input.kind, path: input.path, anchors: true, planQuality: true,
    ...(input.rovaraV2 ? { noChangeOption: true, requiredParts: true } : {}),
    ...(input.retired === undefined || input.retired.length === 0 ? {} : { retired: input.retired }),
  });
  const checks = input.kind === "plan" && input.checks !== undefined ? `\n\n${planChecksInstructions(input.checks.repositoryPaths, input.checks.required)}` : "";
  // Rovara Code version 2: what a coding plan is told about input rules, tests and the repository's CI checks (found wanting when plans were graded); it adds to the rules above and never replaces them.
  const guidance = input.rovaraV2 && input.kind === "plan" ? `\n\nInstructions from Rovara Code, Plan step. They add to the rules above and never replace them.\n\n${ROVARA_CODE_PLAN_GUIDANCE}` : "";
  return `Planning phase only. Do not edit, write, or create files. Inspect the request and repository. ${PLAN_PHASE_LIMITS} Avoid filler and include only material risks or genuine unanswered questions. This document is shown to the owner for approval before the next phase or code changes.\n\n${instructions}${checks}${guidance}`;
}

/**
 * How a step that follows a decision is introduced. Changes sent back: the planner gets the current document as data, to write back whole, with the owner's changed answers. Approval of a
 * Full phase: the next phase builds on the approved document, whose claims keep their IDs, and the owner's answers settle its decisions. The first document of a task has no introduction.
 */
export function structuredPlanIntro(input: { kind: PlanDocumentKind; previous?: StructuredPlanContext | undefined }): string {
  const { previous } = input;
  if (previous === undefined) return "";
  const answers = previous.chosen === undefined ? "" : ownerAnswersSentence(previous.plan, previous.chosen);
  if (previous.kind === input.kind) {
    return `Revise the current ${KIND_NAMES[input.kind]}. The owner's requested changes follow the document.${answers}\n\nReturn the complete revised document. Do not edit files.\n\n${previousPlanDocumentBlock({ json: canonicalPlanJson(previous.plan) })}`;
  }
  const next = input.kind === "design" ? "design" : "coding plan";
  return `Prepare the next owner-review document for this request. The owner approved the ${KIND_NAMES[previous.kind]} (version ${previous.version}) below. Write the ${next} as the planning instructions describe, building on the approved document. Do not edit files.${answers}\n\n${previousPlanDocumentBlock({ json: canonicalPlanJson(previous.plan) })}`;
}
