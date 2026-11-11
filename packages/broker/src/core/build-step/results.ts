// Lane L10, the build step: what a finished coding run, rerun of the checks or set of reviews meant. Cloud's `completedWorkflowItems` (about 600 lines of DynamoDB transaction items for these
// three modes) written on the document store: each reads what the worker reported against the schemas and the task's own record of where it started, applies the engine's pure transition
// (`recordWorkflowVerification`, `submitWorkflowReview`) and commits the new workflow, with the dispatch row of the step that follows, in one transaction.
//
// The approved work breakdown (spec 059: parts built in order or side by side) is read here too (`../work-breakdown/results.ts`): an ordered run's result must be the run the owner approved.
//
// The browser and API checks (E2E) join here when the install gives the flow its `e2e` seam: a candidate's checks pass only on a round the broker verified itself, and the rows that verdict
// stands on are fenced into the same transaction. Left out on purpose (not part of Code's wave 1): a custom step sequence (a program), and the
// design review. A workflow that carries any of them is not one this install starts. The second review by another company is here (`core/second-review`): the review step asks the service
// at its start and at its end, and without one the review is exactly what it was.
import {
  CheckReportSchema, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, WORKFLOW_NO_CODE_CHANGE_MESSAGE, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE,
  WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, WORKFLOW_SETUP_CHANGED_FILES_MESSAGE, WorkflowSnapshotSchema, WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON,
  WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, blockWorkflow, createCandidateManifest, endWorkflowCiFixUnrelated, noChangeFindingsFrom, recordWorkflowVerification,
  submitWorkflowReview, workflowIsReviewOnly, workflowPullRequestTrees, workflowReviewRoles, workflowSelectedChecks,
  blockingFindings, change, secondReviewBlockFinding, type CandidateRepository, type TransactItem, type UpdateOp, type WorkflowSnapshot,
} from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { isReapprovalStop, liveSteerChangeItems, liveSteerCodingStop, settleLiveSteerReapproval } from "../sessions/live-steer-reapproval.js";
import { DISPATCH_EXHAUSTED_ERROR } from "../task-flow/dispatch.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import type { StepOutcome } from "../task-flow/outcome.js";
import { toDocument, type OperationRecord, type TaskRecord } from "../task-flow/records.js";
import type { StoredSecondOpinion } from "../second-review/store.js";
import { blockTaskWorkflow, commitWorkflow, runDispatchRow } from "../task-flow/stage-machine.js";
import { iso, log } from "../task-flow/support.js";
import { checkCommandCouldNotRun, regressedCheckLabels } from "./check-results.js";
import { isNonCandidateRound, verifyWorkflowE2EEvidence } from "../e2e/verification.js";
import type { E2EVerificationDiagnostic } from "../e2e/authority.js";
import { SOURCE_TOO_LARGE_BLOCK_REASON, SOURCE_TOO_LARGE_CODE, readCandidateSourceExport, type CandidateSourceRef } from "../e2e/uploads.js";
import { GRAPH_NOT_CARRIED, GRAPH_RESULT_UNUSABLE, graphCandidateProblem, judgeGraphResult, progressAfterStoppedRun } from "../work-breakdown/results.js";

export interface Ended { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined; outcome?: StepOutcome | undefined }

const recordOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** Why a step stopped when its run ended FAILED or INTERRUPTED: the reason a failed result records too (Cloud's `workflowRunEndedReason`). */
export function runEndedReason(mode: "IMPLEMENT" | "CHECKS" | "REVIEW", status: string): string {
  const step = mode === "CHECKS" ? "verification retry" : mode === "REVIEW" ? "independent review" : "implementation";
  return `${step} operation ended ${status.toLowerCase()}`;
}

/** A rerun of the checks that ran on other code than the code the task holds. */
export const CHECKED_OTHER_CODE_REASON = WORKFLOW_BLOCK_REASONS.checkedOtherCode;

/** Whether the workflow's candidate is the code the open pull requests hold now: every open pull request's head is the commit the candidate has for its repository (and at least one is open). */
export function candidateIsOnPullRequest(workflow: WorkflowSnapshot): boolean {
  const open = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN");
  return open.length > 0 && open.every((pullRequest) => pullRequest.headSha !== undefined
    && workflow.candidate?.repositories.some((repository) => repository.repositoryId === pullRequest.repositoryId && repository.commitSha === pullRequest.headSha) === true);
}

/** A blocked VERIFY or REVIEW is looked at by Rovara's own fixing right away (a row, committed with the block); anything else is for the owner. */
export function autofixRowFor(deps: TaskFlowDeps, taskId: string, next: WorkflowSnapshot, now: string, cause?: "run-lost" | "dispatch-exhausted"): TransactItem[] {
  return next.state === "BLOCKED" && (next.stage === "VERIFY" || next.stage === "REVIEW") ? [dispatchRowItem(deps, taskId, next.revision, "AUTOFIX", now, now, cause)] : [];
}

/** How a run that did not finish came to end, for Rovara's own fixing: a lost run, or a start tried until its budget ran out, is the infrastructure's (one automatic retry), never the code's. */
export function causeOfEnd(ended: Ended): "run-lost" | "dispatch-exhausted" | undefined {
  if (ended.error === DISPATCH_EXHAUSTED_ERROR) return "dispatch-exhausted";
  return ended.status === "INTERRUPTED" ? "run-lost" : undefined;
}

/**
 * Commits the workflow `next` with the row of the step that follows it, then starts that step now (the row is also found by the sweep if this process dies first). A task that moved on while
 * the result was read changes nothing.
 */
export async function commitAndContinue(deps: TaskFlowDeps, task: TaskRecord, next: WorkflowSnapshot, now: string, cause?: "run-lost" | "dispatch-exhausted", taskOps: readonly UpdateOp[] = [], fences: readonly TransactItem[] = []): Promise<void> {
  const following = next.stage === "REVIEW" && next.state === "WAITING" ? [dispatchRowItem(deps, task.taskId, next.revision, "REVIEW", now)]
    : next.stage === "PULL_REQUEST" && next.state === "READY" ? [dispatchRowItem(deps, task.taskId, next.revision, "PUBLISH", now)]
    : autofixRowFor(deps, task.taskId, next, now, cause);
  const committed = await commitWorkflow(deps, task, next, [...fences, ...following], taskOps);
  const row = following[0];
  if (!committed || row === undefined || row.kind !== "put") return;
  const kind = row.item["kind"] as "REVIEW" | "PUBLISH" | "AUTOFIX";
  await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind }).catch((error: unknown) => log(deps, { event: "build_step.start_failed", taskId: task.taskId, kind, error: error instanceof Error ? error.name : "unknown" }));
}

// ---- coding, and a rerun of the checks

function blockReasonOfFailedRun(mode: "IMPLEMENT" | "CHECKS", ended: Ended, workflow: WorkflowSnapshot): string {
  const error = ended.error;
  // The owner's live message asked for a change outside the approved plan, so coding stopped: the owner decides (Revise the plan when the plan can take it in, else Retry coding or a new task).
  if (mode === "IMPLEMENT" && isReapprovalStop(error)) return liveSteerCodingStop(workflow, error);
  if (error?.includes(WORKFLOW_HISTORY_REWRITTEN_MESSAGE) === true) return WORKFLOW_HISTORY_REWRITTEN_MESSAGE;
  if (error?.includes(WORKFLOW_NO_CODE_CHANGE_MESSAGE) === true) return WORKFLOW_BLOCK_REASONS.noCodeChanged;
  // The checks' rerun could not first stop the programs earlier work left running, so no check ran: a person decides (nothing sends it back or retries it by itself).
  if (error?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true) return WORKFLOW_BLOCK_REASONS.leftoverProcesses;
  // The checks' fresh dev container ran its setup and that changed the project's files: the checks did not run on them.
  if (error?.includes(WORKFLOW_SETUP_CHANGED_FILES_MESSAGE) === true) return WORKFLOW_BLOCK_REASONS.setupChangedFiles;
  return runEndedReason(mode, ended.status);
}

/** The confirmation that each starting commit is real history at the host the repository names, before the first pin. A repository whose host is not registered here is refused. */
async function confirmStartingCommits(deps: TaskFlowDeps, task: TaskRecord, candidate: ReturnType<typeof createCandidateManifest>): Promise<void> {
  if (deps.codeHosts === undefined) return;
  const project = await deps.projects.revision(task.project, task.startingRevision);
  for (const repository of candidate.repositories) {
    const definition = project?.definition.repositories.find((entry) => entry.name === repository.repositoryId);
    if (definition === undefined) throw new Error("candidate repository is not registered");
    const host = codeHostForRecord(deps.codeHosts, definition);
    await host.tree({ url: definition.url }, repository.baseCommitSha as string, { orgId: deps.companyId });
  }
}

/**
 * After a coding run or a rerun of the checks ended. Failed: the step blocks with a reason the owner reads. Succeeded: the code it ended on is the candidate; its checks are read against the
 * plan's policy and, when every selected check passed on that very code, the reviews are due. Anything the report does not prove blocks the step with its own reason.
 */
export async function recordBuilt(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord, ended: Ended): Promise<void> {
  const workflow = task.workflow;
  const mode = operation.workflowMode === "CHECKS" ? "CHECKS" as const : "IMPLEMENT" as const;
  // The result counts only while the task waits for exactly this run; a late one changes nothing.
  if (workflow === undefined || operation.workflowRevision === undefined || workflow.revision !== operation.workflowRevision || workflow.state !== "RUNNING") return;
  if (workflow.stage !== (mode === "CHECKS" ? "VERIFY" : "IMPLEMENT")) return;
  if (ended.status === "CANCELLED") return;
  const now = iso(deps);
  const reported = recordOf(ended.outcome?.kind === "built" ? ended.outcome.result : undefined);
  if (ended.status !== "SUCCEEDED") {
    // A coding run that left the code as it was reports what it found (redacted and bounded again here); it is kept only with that stop.
    const reason = blockReasonOfFailedRun(mode, ended, workflow);
    let blocked = blockWorkflow(workflow, reason, now, { noChangeFindings: noChangeFindingsFrom(reported["noChangeFindings"]) });
    // An ordered run that stopped marks the item it was on as unknown, so a retry resumes only from what was acknowledged as done.
    const marked = mode === "IMPLEMENT" ? progressAfterStoppedRun(workflow, operation, now) : workflow.workflowDependenciesProgress ?? [];
    if (marked.length > (workflow.workflowDependenciesProgress ?? []).length) blocked = WorkflowSnapshotSchema.parse({ ...blocked, workflowDependenciesProgress: marked });
    // The owner's message ids are kept with the block that offers Revise the plan, in the same transaction, so a card that offers it always has its record.
    const kept = mode === "IMPLEMENT" ? liveSteerChangeItems(task.taskId, blocked, ended.error, now) : [];
    if (kept.length > 0) {
      if (await commitWorkflow(deps, task, blocked, kept)) await settleLiveSteerReapproval({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.log === undefined ? {} : { log: deps.log }) }, task, ended.error);
      return;
    }
    await commitAndContinue(deps, task, blocked, now, causeOfEnd(ended));
    if (mode === "IMPLEMENT" && isReapprovalStop(ended.error)) await settleLiveSteerReapproval({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.log === undefined ? {} : { log: deps.log }) }, task, ended.error);
    return;
  }

  const checks = CheckReportSchema.safeParse(reported["checks"]);
  // The record that is blocked while the checks are recorded: recording a verification starts from a blocked VERIFY.
  const verifying = { ...blockWorkflow(workflow, "candidate checks are being recorded", now), stage: "VERIFY" as const };
  let failure: string = WORKFLOW_BLOCK_REASONS.checksUnconfirmed;
  let detail: string | undefined;
  let regressedChecks: string[] | undefined;
  let failedE2ERound: NonNullable<NonNullable<WorkflowSnapshot["e2e"]>["failedRound"]> | undefined;
  let e2eFences: TransactItem[] = [];
  let next: WorkflowSnapshot;
  // Ordered work (spec 059): the run's result must be the approved run's, item by item, before any of its code is believed.
  const judged = mode === "IMPLEMENT" ? judgeGraphResult(operation, workflow, reported) : undefined;
  try {
    if (judged?.binding !== undefined && (!judged.valid || !judged.complete)) { failure = GRAPH_RESULT_UNUSABLE; throw new Error(failure); }
    // The one run that may go without a graph is a CI, conflict or feedback fix (the worker protocol forbids a fix to carry one), and then only when the workflow names a different run as carrying the graph.
    // Every start that carries a binding writes that run's id onto the workflow in the same transaction as the operation, so a fix keeps the first build's id. Any other unbound run still blocks.
    if (mode === "IMPLEMENT" && judged?.binding === undefined && workflow.workflowDependenciesApproval !== undefined && workflow.stage === "IMPLEMENT"
      && !(workflow.fixSource !== undefined && workflow.workflowDependenciesOperationId !== undefined && workflow.workflowDependenciesOperationId !== operation.id)) {
      failure = GRAPH_NOT_CARRIED; throw new Error(failure);
    }
    if (mode === "CHECKS" && workflow.stage !== "VERIFY") { failure = WORKFLOW_BLOCK_REASONS.checkRetryStale; throw new Error("verification retry stage changed"); }
    if (!checks.success) { failure = WORKFLOW_BLOCK_REASONS.checkReportUnreadable; throw new Error("invalid check report"); }
    // Review only: the approved plan and the project select no check, so "no checks ran" is the expected report. A task with no stored policy is never this.
    const reviewOnly = workflowIsReviewOnly(workflow.checkPolicy);
    if (reviewOnly && checks.data.status === "regression") {
      failure = WORKFLOW_BLOCK_REASONS.regressionFound; detail = checks.data.status; regressedChecks = regressedCheckLabels(checks.data.checks);
      throw new Error("a rerun test regressed");
    }
    if (checks.data.status === "not_verified" && !reviewOnly) {
      failure = checks.data.notVerifiedReason === "no_checks" ? WORKFLOW_BLOCK_REASONS.noChecksConfigured : WORKFLOW_BLOCK_REASONS.checkRunnerFailed;
      detail = checks.data.notVerifiedReason ?? checks.data.status;
      throw new Error("checks were not verified");
    }
    const project = await deps.projects.revision(task.project, task.startingRevision);
    if (project === undefined) throw new Error("the project revision is gone");
    const expectedRepositories = project.definition.repositories.map((repository) => repository.name).sort();
    const candidate = createCandidateManifest((Array.isArray(reported["workflowCandidateRepositories"]) ? reported["workflowCandidateRepositories"] : []) as CandidateRepository[]);
    const checkedCandidate = createCandidateManifest((Array.isArray(reported["workflowCheckCandidateRepositories"]) ? reported["workflowCheckCandidateRepositories"] : []) as CandidateRepository[]);
    // The result must bind the final combined candidate: its digest, and the tree of the last item (in parallel, of the last part merged).
    const graphProblem = judged === undefined ? undefined : graphCandidateProblem(judged, candidate);
    if (graphProblem !== undefined) { failure = graphProblem; throw new Error(failure); }
    if (candidate.repositories.map((repository) => repository.repositoryId).sort().join("\n") !== expectedRepositories.join("\n")) { failure = WORKFLOW_BLOCK_REASONS.repositoriesIncomplete; throw new Error("candidate repositories are incomplete"); }
    // The browser and API checks: the committed source of this code must be on file, and a candidate's round must be verified by the broker before the checks can pass.
    let e2eQualification: ReturnType<typeof qualificationOf> | undefined;
    if (workflow.e2e?.required === true && deps.e2e !== undefined) {
      if (mode === "IMPLEMENT") {
        const ref = (operation as OperationRecord & { candidateSourceRef?: CandidateSourceRef }).candidateSourceRef;
        const exported = ref === undefined || ref.candidateDigest !== candidate.digest ? undefined : await readCandidateSourceExport({ objects: deps.e2e.objects }, ref);
        if (exported === undefined) {
          failure = (operation as OperationRecord & { candidateSourceRefused?: unknown }).candidateSourceRefused === SOURCE_TOO_LARGE_CODE ? SOURCE_TOO_LARGE_BLOCK_REASON : WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON;
          throw new Error(failure);
        }
      } else {
        const round = operation.workflowE2EAdmission;
        if (isNonCandidateRound(round)) throw new Error("a baseline, replay or grounding round is never a candidate's checks");
        if (workflow.e2e.currentGroupRunIds.length === 0 || workflow.e2e.currentRoundId === undefined || round === undefined || operation.workflowE2EEvidenceRef === undefined) {
          failure = "the current candidate-bound E2E round or its private evidence is missing"; throw new Error(failure);
        }
        const diagnostic: E2EVerificationDiagnostic = {};
        // The operation's stored record still says RUNNING: this is the one callback that ends it, and only a run that succeeded reaches verification.
        const verdict = await verifyWorkflowE2EEvidence(deps.e2e, operation, task, candidate, undefined, diagnostic, { terminalStatus: "SUCCEEDED" });
        e2eFences = diagnostic.authorityChecks ?? [];
        if (e2eFences.length === 0) {
          const why = diagnostic.application === true ? diagnostic.reason?.slice(0, 240) : undefined;
          failure = diagnostic.application === true && diagnostic.authorityEvaluated !== true && why !== undefined ? `admitted E2E evidence is incomplete or unknown (${why})`
            : diagnostic.runtimeChange === "requalified" && why !== undefined ? `${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}${why}`
            : diagnostic.runtimeChange === "unusable" && why !== undefined ? `${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}${why}`
            : diagnostic.runtimeChange === "accounts" && why !== undefined ? `${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}${why}`
            : `current E2E authority snapshot could not be fenced at terminal persistence${why === undefined ? "" : ` (${why})`}`;
          throw new Error(failure);
        }
        if (verdict !== "PASS") {
          if (verdict === "FAILED") {
            failedE2ERound = { status: "FAILED", candidateDigest: candidate.digest, roundId: round.roundId, groupRunIds: [...round.groupRunIds],
              admissionSha256: round.admissionRef.sha256, evidenceSha256: operation.workflowE2EEvidenceRef.sha256 };
          }
          failure = verdict === "FAILED" ? "one or more admitted E2E groups failed" : `admitted E2E evidence is incomplete or unknown${diagnostic.reason === undefined ? "" : ` (${diagnostic.reason})`}`;
          throw new Error(failure);
        }
        e2eQualification = qualificationOf(workflow, candidate.digest, round, operation.workflowE2EEvidenceRef.sha256);
      }
    }
    // A rerun of the checks is of the code the task already has: other code under the same checks (the merge of the base the host shows is not the code the worker's workspace holds, say) is not it.
    if (mode === "CHECKS" && workflow.candidate !== undefined && candidate.digest !== workflow.candidate.digest) { failure = CHECKED_OTHER_CODE_REASON; throw new Error("the checks ran on other code than the candidate"); }
    // An approved fix to an open pull request that leaves every repository's code as the pull request holds it changed nothing: there is nothing to check again or push.
    const pullRequestTrees = workflowPullRequestTrees(workflow);
    // Not a Send back from the recheck of a merge of the base (no fix is under way and the candidate is what the pull requests hold): that coding run exports the merged code so its checks (E2E included)
    // can run on it, and it may leave the code as it is.
    const sentBackFromRecheck = workflow.fixSource === undefined && candidateIsOnPullRequest(workflow);
    if (mode === "IMPLEMENT" && pullRequestTrees !== undefined && !sentBackFromRecheck && candidate.repositories.every((repository) => pullRequestTrees.get(repository.repositoryId) === repository.treeSha)) {
      failure = WORKFLOW_BLOCK_REASONS.fixChangedNothing; throw new Error("the fix left the pull request's code as it was");
    }
    if (checkedCandidate.digest !== candidate.digest) { failure = WORKFLOW_BLOCK_REASONS.codeChangedAfterChecks; throw new Error("checked candidate is stale"); }
    // Reviewers judge the change from the task's base, so every repository must say where it started, and it must be where preparation checked out.
    if (candidate.repositories.some((repository) => repository.baseCommitSha === undefined)) { failure = WORKFLOW_BLOCK_REASONS.startUnrecorded; throw new Error("candidate has no base commit"); }
    const pinnedBase = workflow.reviewBase;
    const expectedBase = pinnedBase ?? task.preparedBase;
    if (expectedBase === undefined) { failure = WORKFLOW_BLOCK_REASONS.startUnrecorded; throw new Error("the task has no prepared base commit"); }
    if (candidate.repositories.some((repository) => expectedBase.find((entry) => entry.repositoryId === repository.repositoryId)?.baseCommitSha !== repository.baseCommitSha)) {
      failure = WORKFLOW_BLOCK_REASONS.startChanged; throw new Error("candidate base commit differs from the task's base");
    }
    // Before the first pin, the code host has each starting commit, so the base is real history and not a local commit.
    if (pinnedBase === undefined) {
      try { await confirmStartingCommits(deps, task, candidate); } catch (error) { failure = WORKFLOW_BLOCK_REASONS.startUnconfirmed; throw error; }
    }
    // The worker reports the readiness commands it was sent as `readiness:<index>`, in the order of the selected checks; agent-claimed entries never stand in for them, and a missing one is unknown.
    const selected = workflowSelectedChecks(workflow.checkPolicy);
    const byId = new Map(checks.data.checks.filter((entry) => entry.source === "project").map((entry) => [entry.id, entry]));
    const results = selected.map((check, index) => {
      const entry = byId.get(`readiness:${index}`);
      const status = entry === undefined || entry.after === "not_run" || entry.after === "unknown" ? "UNKNOWN" as const : entry.after === "passed" ? "PASS" as const : "FAILED" as const;
      // The worker's report of a program it could not start, which is all the check's output then holds; any other spawn error with no exit code is the same.
      const programNotFound = status === "FAILED" && entry?.output.trim() === `spawn ${check.command.executable} ENOENT`;
      const neverStarted = status === "FAILED" && !programNotFound && entry?.exitCode == null && /^spawn \S+ E[A-Z]+$/u.test(entry?.output.trim() ?? "");
      const broken = status === "FAILED" && entry !== undefined && (programNotFound || neverStarted || checkCommandCouldNotRun(check.command, entry.exitCode, entry.output));
      return { checkId: check.id, status, ...(programNotFound ? { programNotFound: true as const } : {}), ...(broken ? { broken: true as const } : {}), ...(neverStarted ? { neverStarted: true as const } : {}) };
    });
    if (results.length === 0 && !reviewOnly) { failure = WORKFLOW_BLOCK_REASONS.noCheckResults; throw new Error("there are no selected check results"); }
    next = recordWorkflowVerification(verifying, {
      candidate,
      checks: { candidateDigest: candidate.digest, producer: "agentx-worker-checks", environmentId: task.workspaceId, recordedAt: now, results, ...(reviewOnly ? { reviewOnly: true } : {}) },
      now,
      ...(e2eQualification === undefined ? {} : { e2eQualification }),
    });
    // Proof and evidence (lane L12): the verification is recorded, so the run's evidence is assembled for this code. Informational and bounded; a fault changes nothing.
    await deps.keepEvidence?.({ task, operation, workflow, candidateDigest: candidate.digest, checks: checks.data.checks }).catch((error: unknown) => log(deps, { event: "build_step.evidence_not_kept", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  } catch (error) {
    log(deps, { event: "build_step.verification_blocked", taskId: task.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown", reason: failure, ...(detail === undefined ? {} : { detail }) });
    if (failure === WORKFLOW_BLOCK_REASONS.fixChangedNothing && workflow.fixSource === "ci") {
      // A round for failing CI that left the code as the pull request holds it: the failure is not this change's, so a person is asked to look (the round stays counted).
      next = endWorkflowCiFixUnrelated(workflow, now);
    } else {
      next = failure === WORKFLOW_BLOCK_REASONS.fixChangedNothing ? blockWorkflow(workflow, failure, now)
        : blockWorkflow(verifying, failure, now, { ...(regressedChecks === undefined ? {} : { regressedChecks }), ...(failedE2ERound === undefined ? {} : { failedE2ERound }) });
    }
  }
  // The rows the E2E verdict stands on ride in the same transaction: if any of them moved after it was judged, the verdict is not recorded.
  await commitAndContinue(deps, task, next, now, undefined, [], next.state === "BLOCKED" ? [] : e2eFences);
}

/** What a passing candidate round records on the workflow: the digests the approval fixed and the round's own references. */
function qualificationOf(workflow: WorkflowSnapshot, candidateDigest: string, round: NonNullable<OperationRecord["workflowE2EAdmission"]>, evidenceSha256: string) {
  const admitted = workflow.e2e;
  if (admitted === undefined) throw new Error("trusted E2E aggregate references are unavailable");
  return { candidateDigest, contractDigest: admitted.contractDigest, policyDigest: admitted.policyDigest, bundleDigest: admitted.bundleDigest, executionPlanDigest: admitted.executionPlanDigest,
    roundId: round.roundId, groupRunIds: [...round.groupRunIds], admissionSha256: round.admissionRef.sha256, evidenceSha256 };
}

// ---- reviews

/**
 * After the reviews ended. Failed: the step blocks (the owner's Retry, or Rovara's own one automatic retry, runs it again). Succeeded: every report must be for this very code, from this very
 * run, and exactly the reviews the step asked for; each is recorded with the engine's own transition. Passed reviews make the pull request due; findings block the step.
 */
export async function recordReviewed(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord, ended: Ended): Promise<void> {
  const workflow = task.workflow;
  if (workflow === undefined || operation.workflowRevision === undefined || workflow.revision !== operation.workflowRevision || workflow.state !== "RUNNING" || workflow.stage !== "REVIEW") return;
  if (ended.status === "CANCELLED") return;
  const now = iso(deps);
  if (ended.status !== "SUCCEEDED") {
    // A review that stopped because its base rule files could not be verified says so; the programs earlier work left running could not be stopped: its own reason; any other stop keeps the generic one.
    const reason = ended.error?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.ruleFilesUnverified
      : ended.error?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.leftoverProcesses
      : runEndedReason("REVIEW", ended.status);
    await commitAndContinue(deps, task, blockWorkflow(workflow, reason, now), now, causeOfEnd(ended));
    return;
  }
  const reported = recordOf(ended.outcome?.kind === "reviewed" ? ended.outcome.result : undefined);
  let reviewFailure = "independent candidate review was invalid, incomplete, or stale";
  let next: WorkflowSnapshot;
  // Second review: the second reviewer ran INSIDE this operation. Its report is not among the reviews below (the worker writes it under its own result key), so it cannot clear or fail a first review.
  // An `on` opinion that blocks is handed to the reviews' own transition, so it decides the move whenever the first reviews cleared. The opinion and the block are stored in this same write. `null`: an opinion of
  // earlier code is dropped; undefined: nothing to write.
  let secondOpinion: StoredSecondOpinion | null | undefined;
  try {
    const reviews = reported["workflowReviews"];
    if (!Array.isArray(reviews)) throw new Error("review result has an invalid report collection");
    const candidate = createCandidateManifest((Array.isArray(reported["workflowCandidateRepositories"]) ? reported["workflowCandidateRepositories"] : []) as CandidateRepository[]);
    if (workflow.candidate?.digest !== candidate.digest) throw new Error("review result is stale, incomplete, or came from another operation");
    // What the workflow keeps of a report: neither the same-model flag (the broker's own record of the dispatch, never the worker's say) nor the model-failure sentence. The workflow's review
    // record is strict, so a key a build that does not know it would fail after a rollback.
    const kept = reviews.map((review) => {
      const { sameModelAsBuild: _reported, modelFailure: _failure, ...report } = recordOf(review);
      void _reported; void _failure;
      return report;
    });
    // A new review of this code starts without the earlier second review's block (the new opinion sets it again if it blocks).
    const { blockReason: _earlier, secondReviewBlock: _earlierSecond, ...base } = workflow;
    void _earlier; void _earlierSecond;
    const opinion = deps.secondReview?.opinionOf({
      recorded: operation.secondReviewPlan, operationId: operation.id, terminalStatus: ended.status, result: reported, ...(deps.modelCalls === undefined ? {} : { aliasesCalled: deps.modelCalls(operation.id) ?? new Set<string>() }), currentCandidateDigest: workflow.candidate?.digest, accepted: workflow.acceptedFindings, now,
    });
    secondOpinion = opinion ?? (task.secondOpinion === undefined ? undefined : null);
    const secondBlocks = opinion?.opinion.blocked === true;
    for (const review of kept) {
      if (review["operationId"] !== operation.id) throw new Error("review result is stale, incomplete, or came from another operation");
      submitWorkflowReview(base, review, now, { secondReviewBlocks: secondBlocks });
    }
    // Exactly the reviews the step asks for: two of one kind would leave the stage waiting for the other.
    const roles = kept.map((review) => review["role"]).sort();
    const asked = workflowReviewRoles(workflow);
    if (roles.length !== asked.length || roles.some((role, index) => role !== asked[index])) {
      reviewFailure = WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE;
      throw new Error("review result does not hold one code review and one security review");
    }
    next = base;
    for (const review of kept) next = submitWorkflowReview(next, review, now, { secondReviewBlocks: secondBlocks });
    const blockedReport = opinion?.opinion.blocked === true ? opinion.opinion.report : undefined;
    if (blockedReport !== undefined) {
      // The block is kept IN the workflow (secondReviewBlock), so accepting the first review's findings can never clear it.
      next = WorkflowSnapshotSchema.parse({ ...next, secondReviewBlock: { candidateDigest: candidate.digest, findings: blockingFindings(blockedReport, workflow.acceptedFindings).slice(0, 20).map(secondReviewBlockFinding) } });
    }
  } catch {
    secondOpinion = undefined;
    next = blockWorkflow(workflow, reviewFailure, now);
  }
  const opinionOps: UpdateOp[] = secondOpinion === undefined ? [] : secondOpinion === null ? [change.remove("secondOpinion")] : [change.set("secondOpinion", toDocument(secondOpinion))];
  await commitAndContinue(deps, task, next, now, undefined, opinionOps);
}

export { blockTaskWorkflow };
