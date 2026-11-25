// S1: answering the blocking review findings (Fix or Accept each, a note to Accept) as a registry effect. The move is the engine's own (`resolveReviewFindings`). Risk is computed from the input: any Accept lets the pull request
// open past a finding, so it is `high` and carries a confirm that lists each accepted finding with its reason; all Fix is `money` (a paid round of coding). A SECURITY finding is never accepted from Slack in this cut: the press
// is refused `needs_web` before anything is written (the engine refuses it too: `requirePageForSecurityAccept`), while Fix on the same finding works.
import { WORKFLOW_RESOLVE_FINDINGS_MAX, openReviewFindings, workflowResolveFindingsOffered, type ActionBinding, type ActionValues, type ConfirmLines, type TaskActionRisk, type WorkflowSnapshot } from "@agentx/contracts";
import { createTaskActions } from "../../task-flow/task-actions.js";
import type { TaskRecord } from "../../task-flow/records.js";
import type { ActionEnv, ActionCaller, Description, PressContext, Performed } from "../types.js";
import { needsWebRefusal, inert, staleRefusal, textOf } from "./values.js";
import { spendIsNotBlocking, taskIsOpen } from "./moves.js";

export const findingsWhen = (task: TaskRecord): ActionBinding | undefined => {
  const workflow = task.workflow;
  if (!taskIsOpen(task) || workflow === undefined || task.purpose !== undefined || !spendIsNotBlocking(workflow) || !workflowResolveFindingsOffered(workflow)) return undefined;
  const open = openReviewFindings(workflow).length;
  return open >= 1 && open <= WORKFLOW_RESOLVE_FINDINGS_MAX && workflow.candidate !== undefined ? { revision: workflow.revision, digest: workflow.candidate.digest } : undefined;
};

/** One answer per open finding, from the form: the choice, and its note. A finding left unanswered is a missing input. */
export interface Answer { findingId: string; action: "FIX" | "ACCEPT"; note: string }
export function answersOf(workflow: WorkflowSnapshot, values: ActionValues): Answer[] {
  return openReviewFindings(workflow).map((finding) => {
    const choice = textOf(values, finding.findingId);
    return { findingId: finding.findingId, action: choice === "ACCEPT" ? "ACCEPT" : "FIX", note: textOf(values, `${finding.findingId}#note`) };
  });
}

const accepts = (workflow: WorkflowSnapshot, values: ActionValues): Answer[] => answersOf(workflow, values).filter((answer) => answer.action === "ACCEPT");

export function findingsRisk(task: TaskRecord, values: ActionValues): TaskActionRisk {
  return task.workflow !== undefined && accepts(task.workflow, values).length > 0 ? "high" : "money";
}

export async function describeFindings(_env: ActionEnv, _caller: ActionCaller, task: TaskRecord, _binding: ActionBinding, values: ActionValues): Promise<Description> {
  const workflow = task.workflow!;
  const open = openReviewFindings(workflow);
  const spec = { fields: [{
    kind: "per-item" as const, id: "findings", label: "Each blocking finding", noteMax: 1_000, noteRequiredFor: "ACCEPT",
    choices: [{ value: "FIX", label: "Fix it", selected: true }, { value: "ACCEPT", label: "Accept it (needs a reason)" }],
    items: open.map((finding) => ({ id: finding.findingId, text: inert(`${finding.role === "SECURITY" ? "Security: " : ""}${finding.text}${finding.file === undefined ? "" : ` (${finding.file}${finding.line === undefined ? "" : `:${String(finding.line)}`})`}`, 560), role: finding.role })),
  }] };
  const accepted = accepts(workflow, values);
  if (accepted.length === 0) return { spec };
  const byId = new Map(open.map((finding) => [finding.findingId, finding]));
  const lines = [
    "These findings will no longer block the pull request:",
    ...accepted.map((answer) => `- ${inert(byId.get(answer.findingId)?.text ?? "", 160)} (reason: ${inert(answer.note, 200)})`),
    "The pull request can open with them. The reasons go in its description.",
  ].slice(0, 20);
  const confirm: ConfirmLines = { title: "Accept these findings", lines, button: "Accept and continue", danger: true };
  return { spec, confirm, bound: accepted.map((answer) => [answer.findingId, answer.note]) };
}

export async function performFindings(ctx: PressContext): Promise<Performed> {
  const workflow = ctx.task.workflow!;
  const answers = answersOf(workflow, ctx.values);
  const security = new Set(openReviewFindings(workflow).filter((finding) => finding.role === "SECURITY").map((finding) => finding.findingId));
  if (answers.some((answer) => answer.action === "ACCEPT" && security.has(answer.findingId))) throw needsWebRefusal("A security finding is accepted on the Rovara web page");
  if (answers.some((answer) => answer.action === "ACCEPT" && answer.note === "")) throw staleRefusal("give a reason for each finding you accept");
  const digest = ctx.binding.digest;
  if (digest === undefined) throw staleRefusal("these findings are out of date");
  await createTaskActions(ctx.deps, ctx.env.options).resolveFindings(ctx.caller, ctx.task.taskId, {
    requestId: ctx.requestId, expectedRevision: ctx.binding.revision, candidateDigest: digest,
    resolutions: answers.map((answer) => ({ findingId: answer.findingId, action: answer.action, note: answer.note })),
  }, "slack");
  return { status: "started" };
}
