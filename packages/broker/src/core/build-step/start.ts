// Lane L10, the build step: starting the steps after the plan is approved. Each start reads the task fresh, answers STALE when the task is no longer where the dispatch row left it, and
// accepts the operation in one transaction with the workflow change that makes it RUNNING (the stage machine's `acceptStep`). The request id of each is made from the task, the revision and
// the candidate, so a recovered or repeated row is the first one's duplicate.
import { planApprovalSkipped } from "../task-flow/stage-selection.js";
import { createHash } from "node:crypto";
import {
  AgentXError, EVIDENCE_CAPTURE_FEATURE, WORKFLOW_BLOCK_REASONS, abandonWorkflowFix, blockWorkflow, isBaseMergedRetry, sendBackProblems, workflowIsReviewOnly, workflowRequestId, workflowReviewRoles, workflowSelectedChecks, workflowVerificationPosition,
  WORKFLOW_PLAN_MAX_BYTES, ownerPlanInstructions, type JsonValue, type ProjectCommand, type ProjectDefinition, type WorkflowApprovedPlan, type WorkflowDependencyInvocation, type WorkflowReviewChecks, type WorkflowSnapshot,
} from "@agentx/contracts";
import { readCiEvidence, ciFixPrompt, ciFixPromptWithoutOutput } from "../ci-fix/ci-fix.js";
import { conflictFixPrompt } from "../branch-sync/branch-sync.js";
import { withTestRule } from "../proof/verification-report.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { resolveRowItem } from "../task-flow/dispatch-rows.js";
import { readTask } from "../task-flow/reads.js";
import type { StepTestPlan } from "../test-env/seam.js";
import { toDocument, type TaskRecord, type WorkspaceRecord } from "../task-flow/records.js";
import { acceptStep, acceptStepWithNotes, commitWorkflow, readWorkspace, type StepStart } from "../task-flow/stage-machine.js";
import { iso, log, newId } from "../task-flow/support.js";
import { firstGraphInvocation, restartedGraphInvocation, resumeGraphInvocation, workflowWithCurrentGraphOperation } from "../work-breakdown/invocation.js";
import { codeHostForRecord } from "../../plugins/routing.js";
import { shortenMarkdown } from "../../developer/plan-document-reader.js";
import { approvedCodingPlan, reviewPlanOf } from "./plan-input.js";
import {
  AUTOMATIC_REVIEW_NOTE, AUTOMATIC_REVIEW_ONLY_NOTE, NO_PUBLISH_NOTE, implementPrompt, ownerConstraintsSection, promptTagId, reviewCheckCommand, reviewPrompt, selectedCheckCommands,
  sendBackPrompt, sendBackProblemsPromptSection,
} from "./prompts.js";

/** A UUID made from text (the workflow's retry record wants one): the same text always gives the same one, so a repeated retry is recognised. */
export function uuidFrom(text: string): string {
  const hex = createHash("sha256").update(`agentx-retry\0${text}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RowRef { taskId: string; workflowRevision: number }

/** The task a row stands for, when it is still open at the revision the row was written for; the workspace, when it can take a step. */
export interface Located { task: TaskRecord & { workflow: WorkflowSnapshot }; workspace: WorkspaceRecord }

export async function locate(deps: TaskFlowDeps, row: RowRef, where: (workflow: WorkflowSnapshot) => boolean): Promise<Located | "stale" | "waiting"> {
  const task = await readTask(deps, row.taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== row.workflowRevision || !where(workflow)) return "stale";
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "stale";
  if (workspace.status === "PREPARING") return "waiting";
  return { task: task as Located["task"], workspace };
}

/** Resolves the row, whatever the answer, when the step it stood for was started or is no longer wanted. */
export async function settled(deps: TaskFlowDeps, row: RowRef, result: StepStart): Promise<StepStart> {
  if (result === "STALE" || result === "DUPLICATE") await deps.store.transact([resolveRowItem(deps, row.taskId, row.workflowRevision)]);
  return result;
}

export const jsonOf = <T extends object>(value: T): Record<string, JsonValue> => toDocument(value);

/** The base commit of each repository the task started from: the pinned one, else the one preparation recorded. */
export function baseOf(task: TaskRecord, workflow: WorkflowSnapshot): { workflowBase?: Record<string, JsonValue>[] } {
  const base = workflow.reviewBase ?? task.preparedBase;
  return base === undefined ? {} : { workflowBase: base.map((entry) => jsonOf(entry)) };
}

/** The head a CI fix starts from: the one open pull request's recorded head (none for a conflict round, which works on the merge's files, or for several pull requests). */
function fixStartHead(workflow: WorkflowSnapshot): string | undefined {
  if (workflow.fixSource === undefined || workflow.fixSource === "conflict") return undefined;
  const open = (workflow.pullRequests ?? []).filter((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN");
  return open.length === 1 ? open[0]!.headSha : undefined;
}

async function repositoryOf(deps: TaskFlowDeps, task: TaskRecord, repositoryId: string): Promise<ProjectDefinition["repositories"][number] | undefined> {
  const project = await deps.projects.revision(task.project, task.startingRevision);
  return project?.definition.repositories.find((candidate) => candidate.name === repositoryId);
}

/**
 * A fix is made for the head Rovara pushed. If a person pushed meanwhile, the round stops before any model run is paid for: the task waits for the merge again (merge tracking says someone
 * else pushed and stops fixing), and nothing of theirs is overwritten. A pull request whose head cannot be read is not the head recorded.
 */
async function personPushedMeanwhile(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot): Promise<boolean> {
  if (workflow.fixSource === undefined || deps.codeHosts === undefined) return false;
  for (const pullRequest of (workflow.pullRequests ?? []).filter((entry) => (entry.state === "OPEN" || entry.state === "UNKNOWN") && entry.headSha !== undefined)) {
    const repository = await repositoryOf(deps, task, pullRequest.repositoryId);
    if (repository === undefined) return true;
    let head: string | undefined;
    try {
      const host = codeHostForRecord(deps.codeHosts, repository);
      head = (await host.getChangeRequest({ repository: { url: repository.url }, id: String(pullRequest.number), url: "" }, { orgId: deps.companyId })).headRevision;
    } catch (error) {
      log(deps, { event: "build_step.head_unreadable", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
      return true;
    }
    if (head !== pullRequest.headSha) return true;
  }
  return false;
}

// ---- coding

/**
 * Starts a coding run for the task, with no one asking: the first run after the plan is approved, a send-back to coding (the owner's or Rovara's own), or a fix round for failing CI or a
 * conflict. A repeat of the row is the same run.
 */
export async function startImplementation(deps: TaskFlowDeps, row: RowRef): Promise<StepStart> {
  const found = await locate(deps, row, (workflow) => workflow.stage === "IMPLEMENT" && workflow.state === "READY");
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  // A fix is made for the head Rovara pushed: if a person pushed meanwhile, the round ends here and the task waits for the merge again.
  if (await personPushedMeanwhile(deps, task, workflow)) {
    await commitWorkflow(deps, task, abandonWorkflowFix(workflow, iso(deps)));
    return settled(deps, row, "STALE");
  }
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-implement", task.taskId, workflow.revision);
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  const found2 = sendBackProblems(workflow);
  let prompt: string;
  let approvedPlan: WorkflowApprovedPlan | undefined;
  if (workflow.fixSource === "ci" && found2.length === 0) {
    // The first run of a fix for failing CI is told what CI said, kept when the round started; the coder has the plan in its conversation.
    const block = await readCiEvidence(deps.store, task.taskId, deps.companyId, workflow.revision);
    prompt = block === undefined ? ciFixPromptWithoutOutput({ names: workflow.fixProblems ?? [], notes: NO_PUBLISH_NOTE }) : ciFixPrompt({ block, notes: NO_PUBLISH_NOTE });
  } else if (workflow.fixSource === "conflict" && found2.length === 0) {
    // The workspace is in the state the conflicting merge left; the run is told which files.
    prompt = conflictFixPrompt({ paths: workflow.fixProblems ?? [], notes: NO_PUBLISH_NOTE });
  } else {
    const plan = await approvedCodingPlan(deps.artifacts, workflow);
    // The plan as structured data for the worker's conversation compaction: the worker never reads it back out of the prompt, which can hold a teammate's words.
    approvedPlan = { markdown: shortenMarkdown(plan.text, WORKFLOW_PLAN_MAX_BYTES), sha256: plan.sha256, ownerInstructions: ownerPlanInstructions(workflow) };
    // A plan nobody approved (the lighter flow skipped the approval of a small change) is never called approved.
    const approved = !planApprovalSkipped(workflow, plan.sha256);
    prompt = found2.length === 0
      ? implementPrompt(plan, approved)
      : sendBackPrompt({ problems: sendBackProblemsPromptSection(found2, promptTagId(task, requestId)), plan, constraints: ownerConstraintsSection(workflow, plan), ownerNote: lastOwnerWords(workflow), approved });
  }
  const startFrom = fixStartHead(workflow);
  const readiness = selectedCheckCommands(workflow).readiness;
  // Ordered work (spec 059): a plan the owner approved with a work breakdown is coded as that breakdown, never as plain coding. A fix round (CI, a conflict, feedback) carries none (the worker protocol forbids it): it
  // works on the code the ordered run left.
  let graph: { invocation: WorkflowDependencyInvocation; note?: string } | undefined;
  if (workflow.workflowDependenciesApproval !== undefined && workflow.fixSource === undefined) {
    try {
      if (workflow.workflowDependenciesOperationId === undefined) graph = await firstGraphInvocation(deps, task);
      else {
        // A run that goes on from an earlier one: a retry resumes from the checkpoints the history acknowledged; a send-back runs the whole plan again over the code the workspace holds.
        const resumed = await resumeGraphInvocation(deps, task);
        if (resumed !== undefined) graph = { invocation: found2.length > 0 ? restartedGraphInvocation(resumed, workflow) : resumed };
      }
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      // A refusal is the plan's, not a hiccup of the machine: it blocks the task with its sentence instead of being tried until the row is given up on.
      log(deps, { event: "build_step.work_breakdown_refused", taskId: task.taskId, code: error.code });
      await commitWorkflow(deps, task, blockWorkflow(workflow, error.message.replace(`${error.code}: `, "").slice(0, 500), receivedAt));
      return settled(deps, row, "STALE");
    }
  }
  // The approved test environment this task pinned: its dependencies are started for the coding run (the working sandbox gets them while the agent codes). A plan that cannot be built blocks the task with its sentence.
  const testPlan = await testPlanFor(deps, task, "IMPLEMENT", undefined);
  if (typeof testPlan === "string") {
    await commitWorkflow(deps, task, blockWorkflow(workflow, testPlan, receivedAt));
    return settled(deps, row, "STALE");
  }
  const operationId = graph === undefined ? undefined : newId(deps);
  const payload = jsonOf({
    ...(readiness === undefined ? {} : { readiness }),
    ...(testPlan === undefined ? {} : { testEnvironment: testPlan.plan }),
    ...baseOf(task, workflow),
    ...(workflow.fixSource === undefined ? {} : { workflowFix: { source: workflow.fixSource, ...(startFrom === undefined ? {} : { startFrom }) } }),
    ...(graph === undefined ? {} : { workflowDependencies: graph.invocation }),
    ...(approvedPlan === undefined ? {} : { workflowApprovedPlan: approvedPlan }),
  });
  const accepted = await acceptStepWithNotes(deps, {
    task, workspace, requestId, prompt: withTestRule(prompt, next), workflowMode: "IMPLEMENT",
    workflow: { current: workflow, next: operationId === undefined ? next : workflowWithCurrentGraphOperation(next, operationId, graph?.invocation) },
    extra: [resolveRowItem(deps, task.taskId, row.workflowRevision)], payload,
    requires: [
      "task.workflowMode", ...(readiness === undefined ? [] : ["task.readiness"]), ...(payload["workflowBase"] === undefined ? [] : ["task.workflowBase"]), ...(workflow.fixSource === undefined ? [] : ["task.workflowFix"]),
      ...(graph === undefined ? [] : ["task.workflowDependencies"]),
      ...(testPlan === undefined ? [] : testPlan.requires),
    ],
    extraActions: ["candidate-export", "candidate-build-source", "baseline-source"],
    ...(graph === undefined || operationId === undefined ? {} : { workflowDependencies: graph.invocation, operationId, ...(graph.note === undefined ? {} : { firstEvent: graph.note }) }),
  });
  return settled(deps, row, accepted.result);
}

/** The words the owner sent the work back with, when it was the owner: the last send-back decision that is not Rovara's own. */
function lastOwnerWords(workflow: WorkflowSnapshot): string | undefined {
  const sent = workflow.decisions.filter((decision) => decision.decision === "REQUEST_CHANGES" && decision.actorRole !== "AGENTX" && decision.source === "SEND_BACK").at(-1);
  return sent?.reason;
}

// ---- checks again

/**
 * Runs the selected checks again on the code the workspace holds (a CHECKS run), from a VERIFY that blocked: Rovara's own one automatic retry for a hiccup of the check runner, or the
 * owner's Retry. The decisions that allow it are the caller's; this is the move.
 */
export async function startChecksRerun(deps: TaskFlowDeps, row: RowRef, retry: { requestId: string; actorId: string; automaticDecision?: WorkflowSnapshot["decisions"][number] | undefined }): Promise<StepStart> {
  const found = await locate(deps, row, (workflow) => workflow.stage === "VERIFY" && workflow.state === "BLOCKED");
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  const policy = workflow.checkPolicy;
  if (policy === undefined) return settled(deps, row, "STALE");
  const selected = workflowSelectedChecks(policy);
  const receivedAt = iso(deps);
  const { blockReason: _blockReason, ...unblocked } = workflow;
  void _blockReason;
  const next: WorkflowSnapshot = {
    ...unblocked, revision: workflow.revision + 1, stage: "VERIFY", state: "RUNNING", ...workflowVerificationPosition(workflow),
    verificationRetries: [...(workflow.verificationRetries ?? []), { requestId: uuidFrom(retry.requestId), actorId: retry.actorId, selectedOptionalCheckIds: [...policy.selectedOptionalIds], selectedProposedCheckIds: policy.selectedProposedIds ?? policy.proposed.map((check) => check.id), at: receivedAt }],
    ...(retry.automaticDecision === undefined ? {} : { decisions: [...workflow.decisions, retry.automaticDecision] }),
    updatedAt: receivedAt,
  };
  const readiness = selected.map((check) => check.command);
  // Lane L12: a rerun of the checks also saves the raw parts of its evidence (test reports, coverage) for the pack, when this install keeps evidence.
  const capture = deps.keepEvidence !== undefined;
  // The task's pinned environment: a verification run whose first commands are the environment's checks is told its selection, budget and dependencies.
  const testPlan = await testPlanFor(deps, task, "CHECKS", readiness);
  if (typeof testPlan === "string") {
    await commitWorkflow(deps, task, blockWorkflow(workflow, testPlan, receivedAt));
    return settled(deps, row, "STALE");
  }
  const payload = jsonOf({ ...(readiness.length === 0 ? {} : { readiness }), ...(testPlan === undefined ? {} : { testEnvironment: testPlan.plan }), ...(capture ? { evidenceCapture: true } : {}), ...baseOf(task, workflow) });
  const accepted = await acceptStep(deps, {
    task, workspace, requestId: workflowRequestId("agentx-checks", task.taskId, workflow.revision), prompt: "Run the task's selected checks again on the current code. Do not edit files.", workflowMode: "CHECKS",
    workflow: { current: workflow, next }, extra: [resolveRowItem(deps, task.taskId, row.workflowRevision)], payload,
    requires: ["task.workflowMode", ...(readiness.length === 0 ? [] : ["task.readiness"]), ...(payload["workflowBase"] === undefined ? [] : ["task.workflowBase"]), ...(capture ? [EVIDENCE_CAPTURE_FEATURE] : []), ...(testPlan === undefined ? [] : testPlan.requires)],
  });
  return settled(deps, row, accepted.result);
}

/** The test plan of a step, or the sentence that refuses it (a dependency that cannot be pinned, a dev container): never a plan with the dependencies left out, which would only fail the tests in a confusing way. */
async function testPlanFor(deps: TaskFlowDeps, task: TaskRecord, mode: "IMPLEMENT" | "CHECKS", readiness: readonly ProjectCommand[] | undefined): Promise<StepTestPlan | string | undefined> {
  if (deps.testEnvironment === undefined) return undefined;
  try {
    return await deps.testEnvironment.stepPlan({ project: task.project, taskId: task.taskId, mode, ...(readiness === undefined ? {} : { readiness }) });
  } catch (error) {
    if (error instanceof AgentXError) return error.message.replace(`${error.code}: `, "").slice(0, 500);
    throw error;
  }
}

// ---- reviews

/**
 * Whether the task is at the reviews of a merged base's automatic re-run (decision 70(c)): the newest decision is Rovara's re-run after a merge of the base, for the candidate now at REVIEW, which an open pull
 * request holds. The reviews that follow are paid work of a round Rovara decided itself.
 */
export function isBaseMergedRecheckRound(workflow: WorkflowSnapshot): boolean {
  const candidate = workflow.candidate;
  const last = workflow.decisions.at(-1);
  return workflow.stage === "REVIEW" && workflow.state === "WAITING" && workflow.fixSource === undefined && candidate !== undefined && last !== undefined && isBaseMergedRetry(last)
    && last.auto?.candidateDigest === candidate.digest
    && (workflow.pullRequests ?? []).some((pullRequest) => (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN") && pullRequest.candidateDigest === candidate.digest);
}

/** Whether how far Rovara may act on its own was lowered to `suggest` (a setting that cannot be read reads as `suggest`). An install with no autonomy seam never stops the reviews. */
async function autonomyLowered(deps: TaskFlowDeps, task: TaskRecord): Promise<boolean> {
  if (deps.autonomy === undefined) return false;
  const found = await deps.autonomy(task).catch(() => ({ autonomy: "suggest" as const }));
  return found.autonomy === "suggest";
}

function reviewChecksOf(workflow: WorkflowSnapshot): WorkflowReviewChecks | undefined {
  const verification = workflow.verification;
  if (verification === undefined) return undefined;
  if (verification.reviewOnly === true) {
    const noneReason = workflow.checkPolicy?.noneReason;
    return { reviewOnly: true, checks: [], ...(noneReason === undefined ? {} : { noneReason }) };
  }
  const byId = new Map(workflowSelectedChecks(workflow.checkPolicy).map((check) => [check.id, check]));
  const checks = verification.results.flatMap((result) => {
    const check = byId.get(result.checkId);
    return check === undefined ? [] : [{ label: check.label, command: reviewCheckCommand(check.command) }];
  });
  return checks.length === 0 ? undefined : { reviewOnly: false, checks };
}

/**
 * Starts the read-only code and security reviews of exactly the candidate whose selected checks passed, with no one asking. STALE unless the task is open and still waiting for review at
 * the row's revision with that candidate's passing checks (or blocked, for a retry). A repeat is the first one's duplicate.
 */
export async function startReview(deps: TaskFlowDeps, row: RowRef, options: { retry?: boolean; automaticDecision?: WorkflowSnapshot["decisions"][number] | undefined } = {}): Promise<StepStart> {
  const found = await locate(deps, row, (workflow) => workflow.stage === "REVIEW" && (workflow.state === "WAITING" || (options.retry === true && workflow.state === "BLOCKED")));
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  // Decision 70(c): the reviews after Rovara's own re-run of a merged base's checks are paid work of a round Rovara decided itself: how far it may act is read again, and if it was lowered to `suggest` since, the
  // round stops here, cleanly, before any review is paid for. The owner's Retry (retry: true) is their own go-ahead.
  if (options.retry !== true && isBaseMergedRecheckRound(workflow) && await autonomyLowered(deps, task)) {
    await commitWorkflow(deps, task, blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.recheckAutonomyLowered, iso(deps)), [resolveRowItem(deps, task.taskId, row.workflowRevision)]);
    return "STALE";
  }
  const candidate = workflow.candidate;
  const verification = workflow.verification;
  if (candidate === undefined || verification === undefined || verification.candidateDigest !== candidate.digest
    || (verification.results.length === 0 && !(verification.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy))) || verification.results.some((result) => result.status !== "PASS")) {
    return settled(deps, row, "STALE");
  }
  const receivedAt = iso(deps);
  const roles = workflowReviewRoles(workflow);
  const { blockReason: _blockReason, reviews: _reviews, ...base } = workflow;
  void _blockReason; void _reviews;
  const kept = (workflow.reviews ?? []).filter((review) => !roles.includes(review.role));
  const next: WorkflowSnapshot = {
    ...base, ...(kept.length === 0 ? {} : { reviews: kept }), revision: workflow.revision + 1, state: "RUNNING",
    ...(options.automaticDecision === undefined ? {} : { decisions: [...workflow.decisions, options.automaticDecision] }), updatedAt: receivedAt,
  };
  const plan = await reviewPlanOf(deps.artifacts, workflow);
  const checks = reviewChecksOf(workflow);
  // Second review: does this review carry a second reviewer? It runs INSIDE this operation, so there is no second step, hold or row; with the feature off, or the mode `off`, this is nothing.
  const second = deps.secondReview === undefined ? {} : await deps.secondReview.prepare({ task, reviewers: roles });
  const note = verification.reviewOnly === true ? AUTOMATIC_REVIEW_ONLY_NOTE : AUTOMATIC_REVIEW_NOTE;
  const payload = jsonOf({
    workflowReviewNote: note, ...baseOf(task, workflow),
    ...(checks === undefined ? {} : { workflowReviewChecks: checks }),
    ...(plan === undefined ? {} : { workflowReviewPlan: plan }),
    ...(workflow.definitionVersion === "1.1.0" ? { workflowReviewRisk: true } : {}),
    ...(roles.length === 2 ? {} : { workflowReviewers: roles }),
    ...(second.field === undefined ? {} : { workflowSecondReviewer: jsonOf(second.field) }),
  });
  const accepted = await acceptStep(deps, {
    task, workspace, requestId: workflowRequestId("agentx-auto-review", task.taskId, workflow.revision, candidate.digest), prompt: reviewPrompt({ candidateDigest: candidate.digest, roles }), workflowMode: "REVIEW",
    workflow: { current: workflow, next }, extra: [resolveRowItem(deps, task.taskId, row.workflowRevision)], payload, ...(second.record === undefined ? {} : { secondReviewPlan: second.record }),
    requires: ["task.workflowMode", "task.workflowReview", ...(checks === undefined ? [] : ["task.workflowReviewChecks"]), ...(plan === undefined ? [] : ["task.workflowReviewPlan"]), ...(payload["workflowReviewRisk"] === undefined ? [] : ["task.workflowReviewRisk"]), ...(roles.length === 2 ? [] : ["task.workflowReviewers"])],
  }).catch(async (error: unknown) => {
    // A start that threw carries no operation: the allowance held for its second review goes back before the error goes on.
    await deps.secondReview?.releaseHold(second.record?.reservationId);
    throw error;
  });
  // The step did not start (the task moved on, the workspace was busy, or it repeats one that started): the allowance held for this start goes back now; a started step's own hold is released when it ends.
  if (accepted.result !== "STARTED") await deps.secondReview?.releaseHold(second.record?.reservationId);
  return settled(deps, row, accepted.result);
}
