// Rovara Code (playbook round 2, R1a): a path the start named always runs. Every start that puts a path in the request sets `intent.pathFrom` to "request": a typed `quick:` or `full:`
// prefix, a Slack Quick or Full button, the app API's `path` field, the MCP `workflow_path` argument (a required tool parameter, so the AI client names it), the setup draft's "open a pull
// request" start (always QUICK), and "Make a change anyway" (which carries over the first task's path only when that was "request" too). A start that left the choice to Understand has
// "understand". Understand may answer a question instead of planning only when the start named no path: otherwise its answer is read as the restatement of the change to plan, as it already
// is for a task that follows an answered one. The web's Start work box sends no path, so its starts are Understand's to route. The effect of a named path is only ever more planning and approval.
import type { IntentAssessment, WorkflowPath, WorkflowSnapshot } from "@agentx/contracts";

/** The assumption an explicit-path conversion states, in fixed words (the person's own choice is the only thing named). */
export function explicitPathAssumption(path: WorkflowPath): string {
  return `You chose ${path === "FULL" ? "Full" : "Quick"}, so I planned the change instead of answering.`;
}

/** True when the start named the path (a prefix, a button, the app API `path`, MCP `workflow_path`, the setup-draft pull request start or change-anyway), not Understand. A hand-off or a start that left the choice open is not. */
export function isExplicitPath(workflow: Pick<WorkflowSnapshot, "intent">): boolean {
  return workflow.intent?.pathFrom === "request";
}

const EARLIER_ANSWER_ASSUMPTION = "An earlier answer said no change was needed; you asked for the change anyway.";

/**
 * What Understand's assessment means for this task. An `answer` ends the task Answered, except for a task that follows an answered one (`followsAnswer`) and a task whose person chose the
 * path (`workflow.intent.pathFrom`), which plan the change instead. Anything else is returned as it is.
 */
export function assessmentForTask(input: { assessment: IntentAssessment; workflow: Pick<WorkflowSnapshot, "intent" | "path">; followsAnswer: boolean }): IntentAssessment {
  const { assessment, workflow } = input;
  if (assessment.kind !== "answer" || !(input.followsAnswer || isExplicitPath(workflow))) return assessment;
  return { kind: "ready", path: workflow.path, restatement: assessment.restatement, assumptions: [input.followsAnswer ? EARLIER_ANSWER_ASSUMPTION : explicitPathAssumption(workflow.path)] };
}

/**
 * The `design first:` prefix of a request (Slack and Linear intake, beside `quick:` and `full:`): the person asks for the design to be reviewed before any code, whatever the project's setting says. It may be
 * followed by `quick:` or `full:` (design first runs Full either way: the design review forces it). `rest` is the request without the prefix. Case and spacing are the person's.
 */
export function parseDesignFirstPrefix(text: string): { designFirst: boolean; rest: string } {
  const match = /^\s*design[\s_-]+first\s*:\s*([\s\S]*)$/iu.exec(text);
  return match === null ? { designFirst: false, rest: text } : { designFirst: true, rest: match[1]! };
}
