// Task actions (owner decision 198), review findings: the owner answers each blocking review finding, "accept" it with a reason (the change goes ahead despite it, and the reason goes in the pull request) or "fix" it
// (optional instructions); only the findings to fix go back to coding. Cloud's `resolveTaskWorkflowFindings`, over the ports. Today Code has no way for the owner to decide a finding.
//
// The move is the engine's own (`resolveWorkflowReviewFindings`: owner only, every blocking finding answered exactly once, an accept needs a reason of 1 to 500 characters, at the exact revision and candidate; the
// accepted findings are recorded for that candidate only). A fix returns the task to coding like a send-back does (`send-back.ts`), with the findings to fix as the problems (the accepted ones are no longer blocking, so
// the coding step lists only the others) and the owner's per-finding instructions kept whole beside the workflow (`owner-note.ts`). With every finding accepted and no other review problem the draft pull request is due,
// committed with the decision as a passing review's result commits it.
//
// What it holds, each one tested: who acts (owner or co-owner), the revision and the candidate the person saw, one answer per finding, a reason for every accept (a security finding too), the same request id once, and
// the money and access of whatever starts: a fix is a round of paid coding (cap, `Admission`, access); the pull request needs the project to take new work and the person to be allowed to have it run. A decision that
// starts nothing (another review still blocks) writes only the decision.
import {
  WorkflowResolveFindingsInputSchema, WorkflowTransitionError, agentXError, openReviewFindings, resolveWorkflowReviewFindings, sendBackProblems, workflowFindingProblem,
  type WorkflowResolveFindingsInput, type WorkflowSnapshot,
} from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { dispatchRowItem } from "./dispatch-rows.js";
import { findingAcceptItem, type FindingAcceptMethod } from "./finding-accept.js";
import { ownerNoteItem } from "./owner-note.js";
import { CLOSED_TASK, NEVER_STARTED_TASK, WAITING_FOR_SPEND, admitRound, loadTaskAsOwner, ownerWords, parseBody, requireMayStartWork, waitingForSpend, type TaskActionsOptions } from "./owner-round.js";
import { readTask, taskViewOf, type TaskView } from "./reads.js";
import { commitWorkflow, readWorkspace, runDispatchRow } from "./stage-machine.js";
import { iso, log } from "./support.js";

export const FINDINGS_OUT_OF_DATE = "these findings are out of date; refresh the task and try again";
export const REQUEST_ID_USED = "this request ID was already used for another decision on this task; use a new one";

/** The step the answers made due, if any. */
type Due = "IMPLEMENT" | "REVIEW" | "PUBLISH";

/**
 * `via` is how the answer reached Rovara, recorded with the person for every finding accepted (DECISIONS 201: a tool holding the API token may accept, with a reason, as the person; the pull request says so).
 * A surface says what it is: the laptop's token route is `api-token`, the task's own page `page`.
 */
export async function resolveReviewFindings(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, taskId: string, value: unknown, via: FindingAcceptMethod = "api-token"): Promise<TaskView> {
  const request = parseBody(WorkflowResolveFindingsInputSchema, value);
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const workflow = task.workflow;
  if (workflow === undefined || task.purpose !== undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  // A repeat answers what the first one did and writes nothing; the same id for other answers, or for another kind of decision, is refused.
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.source !== "FINDINGS" || prior.workflowRevision !== request.expectedRevision || !sameAnswers(workflow, request, prior.reason)) throw agentXError("IDEMPOTENCY_CONFLICT", REQUEST_ID_USED);
    return taskViewOf(deps, task);
  }
  // A person's move never skips an approval of more spend.
  if (waitingForSpend(workflow)) throw agentXError("CONFIG_INVALID", WAITING_FOR_SPEND);
  if (request.expectedRevision !== workflow.revision || workflow.candidate?.digest !== request.candidateDigest) throw agentXError("IDEMPOTENCY_CONFLICT", FINDINGS_OUT_OF_DATE);
  const now = iso(deps);
  let next: WorkflowSnapshot;
  try {
    next = resolveWorkflowReviewFindings(workflow, request, { actorId: acting.actorId }, { now }, acting.authority);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  const fixes = request.resolutions.filter((resolution) => resolution.action === "FIX").length;
  const accepts = request.resolutions.length - fixes;
  const due = dueAfter(next, fixes > 0);
  // Anything that starts work needs a workspace that can take it.
  if (due !== undefined) {
    const workspace = await readWorkspace(deps, task.workspaceId);
    if (workspace === undefined || workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    if (workspace.status === "PREPARATION_FAILED") throw agentXError("CONFIG_INVALID", NEVER_STARTED_TASK);
  }
  // A fix (or a custom sequence's next coding or review step) is a round of paid model work: cap, admission, access. The draft pull request spends no model money of its own, but starts work for this person all the same.
  if (due === "IMPLEMENT" || due === "REVIEW") await admitRound(deps, options, { task, caller, requestId: request.requestId });
  else if (due !== undefined) await requireMayStartWork(deps, task);
  const committed = await commitWorkflow(deps, task, next, [
    ...(due === undefined ? [] : [dispatchRowItem(deps, task.taskId, next.revision, due, now)]),
    ...(acting.items ?? []),
    ...(accepts === 0 ? [] : [findingAcceptItem({ taskId: task.taskId, requestId: request.requestId, person: caller.principal, method: via, fingerprints: request.resolutions.filter((resolution) => resolution.action === "ACCEPT").map((resolution) => resolution.findingId), at: now, now: deps.now?.() ?? new Date() })]),
    ...(fixes === 0 ? [] : [ownerNoteItem({ taskId: task.taskId, requestId: request.requestId, text: fixInstructions(workflow, next, request), now: deps.now?.() ?? new Date() })]),
    ...stageAudit(deps, {
      eventId: `task.findings_resolved:${task.taskId}:${request.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.findings_resolved", subject: { type: "task", id: task.taskId },
      // Counts only: the findings' text is reviewer output and the reasons are the owner's words, kept on the workflow.
      details: { project: task.project, revision: workflow.revision, accepted: accepts, toFix: fixes, securityAccepted: acceptedOfRole(workflow, request, "SECURITY"), method: via },
    }),
  ]);
  if (!committed) {
    const fresh = await readTask(deps, task.taskId);
    const again = fresh?.workflow?.decisions.find((decision) => decision.requestId === request.requestId);
    if (fresh?.workflow !== undefined && again?.source === "FINDINGS" && again.workflowRevision === request.expectedRevision && sameAnswers(fresh.workflow, request, again.reason)) return taskViewOf(deps, fresh);
    throw agentXError("IDEMPOTENCY_CONFLICT", FINDINGS_OUT_OF_DATE);
  }
  if (due !== undefined) {
    await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: due })
      .catch((error: unknown) => log(deps, { event: "task_actions.findings_start_deferred", taskId: task.taskId, kind: due, error: error instanceof Error ? error.name : "unknown" }));
  }
  return taskViewOf(deps, (await readTask(deps, task.taskId)) ?? task);
}

/**
 * The step the answers made due. A fix is coding again. With every finding accepted: the draft pull request when the reviews now stand; in a custom sequence, the next review or coding step; otherwise nothing (another
 * review still blocks, or the sequence ended).
 */
function dueAfter(next: WorkflowSnapshot, fixed: boolean): Due | undefined {
  if (fixed) return next.stage === "IMPLEMENT" && next.state === "READY" ? "IMPLEMENT" : undefined;
  if (next.stage === "PULL_REQUEST" && next.state === "READY" && next.candidate !== undefined) return "PUBLISH";
  if (next.program === undefined) return undefined;
  if (next.stage === "REVIEW" && next.state === "WAITING" && next.candidate !== undefined) return "REVIEW";
  if (next.stage === "IMPLEMENT" && next.state === "READY") return "IMPLEMENT";
  return undefined;
}

/**
 * What the coder is told besides the problems: only the findings listed are to be fixed, and the owner's instruction for each, numbered in the order the problems are listed (the order the coding step lists them in,
 * which is not always the order the owner answered in). The findings' own text is reviewer output and is not repeated here; the owner's words stand outside the untrusted tags.
 */
function fixInstructions(before: WorkflowSnapshot, next: WorkflowSnapshot, request: WorkflowResolveFindingsInput): string {
  const answers = new Map(request.resolutions.map((resolution) => [resolution.findingId, resolution]));
  const toFix = openReviewFindings(before).filter((finding) => answers.get(finding.findingId)?.action === "FIX");
  const lines: string[] = [];
  sendBackProblems(next).forEach((problem, index) => {
    const finding = toFix.find((candidate) => { const listed = workflowFindingProblem(candidate.role, candidate); return listed.source === problem.source && listed.text === problem.text; });
    // The owner's words, redacted of anything key-shaped like every other kept instruction.
    const note = finding === undefined ? "" : ownerWords(answers.get(finding.findingId)?.note ?? "");
    if (note !== "") lines.push(`${index + 1}. ${note}`);
  });
  return lines.length === 0
    ? "Fix only the problems listed. The owner gave no further instructions for them."
    : `Fix only the problems listed. The owner's instructions for them, numbered in the order the problems are listed:\n${lines.join("\n")}`;
}

/** How many of the findings the request accepts are the given review's. */
function acceptedOfRole(workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput, role: "CRITIC" | "SECURITY"): number {
  const open = new Map(openReviewFindings(workflow).map((finding) => [finding.findingId, finding]));
  return request.resolutions.filter((resolution) => resolution.action === "ACCEPT" && open.get(resolution.findingId)?.role === role).length;
}

/**
 * Whether a repeat of a request says what the first one did: the same counts (the decision's reason is "N accepted, M to fix"), and every finding it accepts is recorded as accepted with the same reason by the same
 * kind of owner. The fixed ones are checked by their count; their instructions are kept beside the workflow and are not compared.
 */
function sameAnswers(workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput, priorReason: string): boolean {
  const accepts = request.resolutions.filter((resolution) => resolution.action === "ACCEPT");
  if (priorReason !== `${accepts.length} accepted, ${request.resolutions.length - accepts.length} to fix`) return false;
  return accepts.every((resolution) => (workflow.acceptedFindings ?? []).some((entry) => entry.fingerprint === resolution.findingId && entry.reason === resolution.note));
}
