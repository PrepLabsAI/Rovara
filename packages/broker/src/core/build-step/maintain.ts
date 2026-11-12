// Lane L10, the build step: changes to a pull request Rovara already opened. Two moves, both a `maintain` operation on the task's own branch, onto the head the workflow recorded:
//  - APPEND: the fix of a round (failing CI, a conflict) whose checks and reviews passed is pushed as exactly the reviewed tree on the task's pinned base (Cloud's
//    `startTaskWorkflowPullRequestUpdate`, `reconcilePullRequestUpdate`, `completedPullRequestUpdateItems`);
//  - SYNC: the base branch is merged into the pull request's branch (`git merge --no-ff`, never a rebase, never a force-push), when merge tracking asked for it (Cloud's
//    `startTaskWorkflowBranchSyncFromSystem`, `completedBranchSyncItems`; what a finished merge is lives in `core/branch-sync`).
// As in Cloud, the code host, not the worker, says what the branch holds afterwards, and a head that moved (a person's push) is never overwritten.
//
// Left out: the rewrite of the pull request's description with the feedback fixes (feedback rounds are not in Code's wave 1), the merged-state bookkeeping that a merge found here would
// also settle (merge tracking finds a merge on its own pass), and Cloud's autonomy re-read before a paid conflict round (the decider already read it when it asked for the merge).
import {
  BASE_MERGED_NEEDS_YOU_MILESTONE, BASE_MERGED_RECHECKING_MILESTONE, PullRequestLifecycleResultSchema, WORKFLOW_BLOCK_REASONS, WORKFLOW_FIX_DROPS_BASE_CHANGES, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED, agentXError, blockWorkflowPullRequestUpdate, change, endWorkflowBranchSync,
  WorkflowSnapshotSchema, nextWorkflowPullRequestUpdate, observeWorkflowPullRequestMergedWithFix, recordWorkflowBranchSync, recordWorkflowPullRequestUpdate, startWorkflowBranchSyncRun, startWorkflowPullRequestUpdate, when,
  workflowRequestId, CONFLICT_ROUNDS_MAX, WorkflowTransitionError, holdWorkflowCandidateOnPullRequests,
  type CodeHost, type TransactItem, type WorkflowPullRequestUpdateCause, type WorkflowSnapshot,
  COMMIT_ID_PATTERN,
} from "@agentx/contracts";
import { codeHostForRecord, providerOf } from "../../plugins/routing.js";
import { branchSyncRequestId, planBranchSyncOutcome, type BranchSyncGithub } from "../branch-sync/branch-sync.js";
import { linkedChangeRequestKey } from "../proof/revert/linked-change-requests.js";
import { riskFromFiles } from "./changed-files.js";
import { requireRepositoryKey } from "../merge/repository-key.js";
import { prHeadItems } from "../merge/store.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem, resolveRowItem } from "../task-flow/dispatch-rows.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import { acceptStep, commitWorkflow, runDispatchRow, type StepStart } from "../task-flow/stage-machine.js";
import { iso, log } from "../task-flow/support.js";
import { announceTaskEnd, completedByMerge } from "../task-flow/task-end.js";
import { jsonOf, locate, settled, type Located, type RowRef } from "./start.js";
import { pullRequestRecordKey, pullRequestRecordOf, taskOfOperation } from "./records.js";
import type { Ended } from "./results.js";

const scopeOf = (deps: Pick<TaskFlowDeps, "companyId">) => ({ orgId: deps.companyId });
/** A commit id of any hash length (item C4): the core never decides it is SHA-1. */
const SHA = COMMIT_ID_PATTERN;
const objectOf = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the pull request update callback must be an object");
  return value as Record<string, unknown>;
};


// ---- the push of an approved fix

/** Pushes the fix whose checks and reviews passed to the pull request Rovara opened, one pull request at a time (the next is due when this one's result lands). */
export async function startPullRequestUpdate(deps: TaskFlowDeps, row: RowRef, located: Pick<Located, "task" | "workspace">): Promise<StepStart> {
  const { task, workspace } = located;
  const workflow = task.workflow as WorkflowSnapshot & { candidate: NonNullable<WorkflowSnapshot["candidate"]> };
  const pullRequest = nextWorkflowPullRequestUpdate(workflow);
  const repository = workflow.candidate.repositories.find((entry) => entry.repositoryId === pullRequest?.repositoryId);
  const baseCommitSha = workflow.reviewBase?.find((entry) => entry.repositoryId === repository?.repositoryId)?.baseCommitSha;
  if (pullRequest === undefined) {
    // Every open pull request already holds the candidate (a merge of the base that was checked and reviewed again, or a fix whose push landed before its result): there is nothing to push, and the task
    // waits for the merge. The owner's Retry at a publication block does the same, so a repeat finds it done (the revision moved on) and an unrepeated one is not left blocked.
    let held: WorkflowSnapshot | undefined;
    try { held = holdWorkflowCandidateOnPullRequests(workflow, iso(deps)); } catch (error) { if (!(error instanceof WorkflowTransitionError)) throw error; }
    if (held === undefined) return settled(deps, row, "STALE");
    if (!await commitWorkflow(deps, task, held, [resolveRowItem(deps, task.taskId, row.workflowRevision)])) return settled(deps, row, "STALE");
    return "STARTED";
  }
  if (workflow.state !== "READY") return settled(deps, row, "STALE");
  if (repository === undefined) return settled(deps, row, "STALE");
  const block = async (cause?: WorkflowPullRequestUpdateCause): Promise<StepStart> => {
    await commitWorkflow(deps, task, blockWorkflowPullRequestUpdate(workflow, { numbers: [pullRequest.number], ...(cause === undefined ? {} : { cause }), now: iso(deps) }), [resolveRowItem(deps, task.taskId, row.workflowRevision)]);
    return "STALE";
  };
  // A pull request recorded before Rovara kept its head, or a task with no pinned base, cannot be pushed to as reviewed.
  if (pullRequest.headSha === undefined || baseCommitSha === undefined || deps.codeHosts === undefined) return block();
  const record = await pullRequestRecordOf(deps, task.workspaceId, repository.repositoryId, pullRequest.number);
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === repository.repositoryId);
  if (record === undefined || definition === undefined) return block();
  // A pull request that changed at the host since Rovara opened it (its head moved, or it merged or closed) is not pushed to.
  const host = codeHostForRecord(deps.codeHosts, definition);
  const remote = await host.getChangeRequest({ repository: { url: definition.url }, id: String(pullRequest.number), url: pullRequest.url }, scopeOf(deps));
  if (remote.state !== "open" || remote.headRevision !== pullRequest.headSha) return block("HEAD_MOVED");
  const receivedAt = iso(deps);
  const started = startWorkflowPullRequestUpdate(workflow, receivedAt);
  // The code on the pull request changes with this push, so its risk is judged again for the new code (the changed files are read from the code host after the push, so until then the level is high).
  const judged = workflow.definitionVersion === "1.1.0" ? riskFromFiles(started, undefined) : started;
  const mergeBaseCommit = workflow.fixSource === "conflict" ? workflow.conflictBase : undefined;
  const maintenance = {
    action: "append" as const, repository: repository.repositoryId, pullRequestNumber: pullRequest.number, headBranch: record.headBranch, baseBranch: record.baseBranch, expectedHeadCommit: pullRequest.headSha,
    workflowCandidate: { candidateDigest: workflow.candidate.digest, treeSha: repository.treeSha, baseCommitSha, ...(mergeBaseCommit === undefined ? {} : { mergeBaseCommit }) },
  };
  const accepted = await acceptStep(deps, {
    task, workspace, kind: "maintain", requestId: workflowRequestId("agentx-auto-update", task.taskId, row.workflowRevision, workflow.candidate.digest, repository.repositoryId, 1),
    prompt: "update", workflow: { current: workflow, next: judged }, maintenance, extraActions: ["pull-request-update"],
    payload: jsonOf({
      action: "append", repository: repository.repositoryId, pullRequestNumber: pullRequest.number, headBranch: record.headBranch, baseBranch: record.baseBranch, expectedHeadCommit: pullRequest.headSha,
      workflowCandidateTreeSha: repository.treeSha, workflowBaseCommit: baseCommitSha,
      ...(workflow.fixSource === undefined ? {} : { workflowFix: { source: workflow.fixSource } }), ...(mergeBaseCommit === undefined ? {} : { workflowMergeBase: mergeBaseCommit }),
    }),
    requires: ["task.workflowPullRequestUpdate", ...(workflow.fixSource === undefined ? [] : ["task.workflowFix"]), ...(mergeBaseCommit === undefined ? [] : ["maintain.workflowSync"])],
    extra: [resolveRowItem(deps, task.taskId, row.workflowRevision)],
  });
  return settled(deps, row, accepted.result);
}

// ---- the merge of the base branch

/**
 * The merge of the base branch into a pull request's branch, started with no one asking. The task is at WAIT_FOR_MERGE/READY with the merge marked (the tracking pass queued it and counted it
 * against the day's merges). Before any machine is asked for, the pull request's head at the host must still be the head the merge is for (a person's push wins and ends the merge) and the base
 * branch's commit is read now: that exact commit is merged. Every way the merge cannot start ends it (the task waits for the merge as it did).
 */
export async function startBranchSync(deps: TaskFlowDeps, row: RowRef): Promise<StepStart> {
  const found = await locate(deps, row, (workflow) => workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "READY" && workflow.branchSync !== undefined);
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  const marker = workflow.branchSync!;
  const end = async (): Promise<StepStart> => {
    await commitWorkflow(deps, task, endWorkflowBranchSync(workflow, iso(deps)), [resolveRowItem(deps, task.taskId, row.workflowRevision)]);
    return "STALE";
  };
  const pullRequest = (workflow.pullRequests ?? []).find((entry) => entry.repositoryId === marker.repositoryId && entry.number === marker.number && (entry.state === "OPEN" || entry.state === "UNKNOWN"));
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === marker.repositoryId);
  const record = await pullRequestRecordOf(deps, task.workspaceId, marker.repositoryId, marker.number);
  if (pullRequest === undefined || pullRequest.headSha !== marker.expectedHeadCommit || definition === undefined || record === undefined || deps.codeHosts === undefined) return end();
  const host = codeHostForRecord(deps.codeHosts, definition);
  const repositoryRef = { url: definition.url };
  // A person's push wins: if the head is no longer the one this merge is for, nothing is merged.
  const remote = await host.getChangeRequest({ repository: repositoryRef, id: String(marker.number), url: pullRequest.url }, scopeOf(deps));
  if (remote.state !== "open" || remote.headRevision !== marker.expectedHeadCommit) return end();
  const baseCommit = await host.baseBranchHead(repositoryRef, record.baseBranch, scopeOf(deps));
  if (!SHA.test(baseCommit)) throw agentXError("RUNTIME_UNAVAILABLE", "the code host did not say what the base branch is at");
  const receivedAt = iso(deps);
  const accepted = await acceptStep(deps, {
    task, workspace, kind: "maintain", requestId: branchSyncRequestId(task.taskId, workflow.revision, baseCommit), prompt: "sync",
    workflow: { current: workflow, next: startWorkflowBranchSyncRun(workflow, receivedAt) }, extraActions: ["pull-request-update"],
    maintenance: { action: "sync", repository: marker.repositoryId, pullRequestNumber: marker.number, headBranch: record.headBranch, baseBranch: record.baseBranch, expectedHeadCommit: marker.expectedHeadCommit, workflowSync: { baseCommit, expectedHeadCommit: marker.expectedHeadCommit } },
    payload: jsonOf({ action: "sync", repository: marker.repositoryId, pullRequestNumber: marker.number, headBranch: record.headBranch, baseBranch: record.baseBranch, expectedHeadCommit: marker.expectedHeadCommit, workflowSync: { baseCommit, expectedHeadCommit: marker.expectedHeadCommit } }),
    requires: ["maintain.workflowSync"], extra: [resolveRowItem(deps, task.taskId, row.workflowRevision)],
  });
  return settled(deps, row, accepted.result);
}

// ---- the worker's update callback

/**
 * The worker pushed to the pull request's branch and says so. The callback is held to what the operation was started with (the pull request, the branch, the head it was for); the host must show the
 * pull request open, from the recorded branch, at the pushed commit (or, while the host's own head lags a push, with its branch already at the commit). Then the record learns the new head.
 */
export async function updatePullRequest(deps: TaskFlowDeps, operation: OperationRecord, value: unknown): Promise<{ url: string; state: "open" | "closed" | "merged"; reconciled: boolean }> {
  const expected = operation.maintenance;
  if (operation.kind !== "maintain" || expected === undefined) throw agentXError("CALLBACK_FORBIDDEN", "operation cannot update a pull request");
  if (deps.codeHosts === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "no code host is set up");
  const input = objectOf(value);
  const allowed = new Set(["repository", "pullRequestNumber", "action", "headBranch", "baseBranch", "previousCommit", "commit"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw agentXError("CONFIG_INVALID", "pull request update callback contains unknown fields");
  for (const key of ["repository", "pullRequestNumber", "action", "headBranch", "baseBranch"] as const) {
    if (input[key] !== expected[key]) throw agentXError("CALLBACK_FORBIDDEN", `pull request update callback ${key} is outside the operation scope`);
  }
  if (input["previousCommit"] !== expected.expectedHeadCommit) throw agentXError("STALE_FENCE", "pull request update used a stale expected head");
  if (typeof input["commit"] !== "string" || !/^[a-f0-9]{40,64}$/u.test(input["commit"])) throw agentXError("CONFIG_INVALID", "updated pull request commit is invalid");
  const commit = input["commit"];
  const record = await pullRequestRecordOf(deps, operation.workspaceId, expected.repository, expected.pullRequestNumber);
  if (record === undefined) throw agentXError("NOT_FOUND", "the pull request is not known");
  if (record.expectedHeadCommit === commit) return { url: record.url, state: "open", reconciled: true };
  if (record.expectedHeadCommit !== expected.expectedHeadCommit) throw agentXError("STALE_FENCE", "pull request record changed before callback reconciliation");
  const task = await taskOfOperation(deps, operation);
  const project = task === undefined ? undefined : await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === expected.repository);
  if (definition === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not part of the task's registered project revision");
  const host = codeHostForRecord(deps.codeHosts, definition);
  const repositoryRef = { url: record.repositoryUrl };
  const remote = await host.getChangeRequest({ repository: repositoryRef, id: String(record.number), url: record.url }, scopeOf(deps));
  // The host moves a pull request's head a moment after a push to its branch, and the worker calls back right after its push: a pull request still at the head before the push holds the update when
  // its branch, which the host reads from Git itself, already points at the pushed commit.
  const branchHoldsUpdate = async (): Promise<boolean> => {
    if (remote.headRevision !== expected.expectedHeadCommit) return false;
    try { return await host.branchHead(repositoryRef, record.headBranch, scopeOf(deps)) === commit; } catch { return false; }
  };
  if (remote.state !== "open" || remote.sourceBranch !== record.headBranch || remote.targetBranch !== record.baseBranch || (remote.headRevision !== commit && !await branchHoldsUpdate())) {
    throw agentXError("STALE_FENCE", "the pull request state does not match the worker update");
  }
  // The record says whose head this is, and merge tracking reads it as Rovara's: so it learns a head only after the host shows that head is what this operation was asked to push (review M2).
  // A fix: exactly the reviewed tree, as a fast-forward of the recorded head (a conflict round's: the recorded head first and the base commit it merged second). A merge of the base: a commit of
  // exactly the recorded head and the base commit it was asked for (what its tree holds is checked again by the checks and reviews that follow it).
  const parents = await host.commitParents(repositoryRef, commit, scopeOf(deps));
  const wanted = expected.action === "sync" ? [expected.expectedHeadCommit, expected.workflowSync?.baseCommit ?? ""]
    : expected.workflowCandidate?.mergeBaseCommit === undefined ? [expected.expectedHeadCommit] : [expected.expectedHeadCommit, expected.workflowCandidate.mergeBaseCommit];
  if (JSON.stringify(parents) !== JSON.stringify(wanted)) throw agentXError("STALE_FENCE", "the pushed commit is not built on the head and base this operation was asked for");
  if (expected.action === "append" && await host.tree(repositoryRef, commit, scopeOf(deps)) !== expected.workflowCandidate?.treeSha) throw agentXError("STALE_FENCE", "the pushed tree is not the reviewed tree");
  const written = await deps.store.update({
    key: pullRequestRecordKey(operation.workspaceId, expected.repository, expected.pullRequestNumber),
    ops: [change.set("expectedHeadCommit", commit), change.set("state", remote.state), change.set("updatedAt", iso(deps))], condition: when.eq("expectedHeadCommit", expected.expectedHeadCommit),
  });
  return { url: remote.ref.url, state: remote.state, reconciled: !written.applied };
}

// ---- the end of a maintain operation

/**
 * A push the update callback took but the end of the operation refused (its tree was not the reviewed one, the run failed, the merge was not recorded): the pull request's record goes back to the head
 * Rovara had, so a head Rovara never accepted is never read as Rovara's. Only when the workflow still holds the old head (a push that was recorded is not undone).
 */
async function restoreRecordHead(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord): Promise<void> {
  const maintenance = operation.maintenance;
  const workflow = task.workflow;
  if (maintenance === undefined || workflow === undefined) return;
  const held = workflow.pullRequests?.find((entry) => entry.repositoryId === maintenance.repository && entry.number === maintenance.pullRequestNumber)?.headSha;
  const record = await pullRequestRecordOf(deps, task.workspaceId, maintenance.repository, maintenance.pullRequestNumber);
  if (record === undefined || held !== maintenance.expectedHeadCommit || record.expectedHeadCommit === maintenance.expectedHeadCommit) return;
  await deps.store.update({
    key: pullRequestRecordKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber),
    ops: [change.set("expectedHeadCommit", maintenance.expectedHeadCommit), change.set("updatedAt", iso(deps))], condition: when.eq("expectedHeadCommit", record.expectedHeadCommit),
  }).catch(() => undefined);
}

/**
 * Whether Rovara re-runs the checks of a merged base by itself (decision 70(c)): automatic fixing is on and the task does not need E2E (its recheck has no source export, so it stays the owner's Retry).
 * It decides whether the AUTOFIX row (cause `base-merged`) is written and which milestone is said: "re-checking" when it is, "needs you" when it is not.
 */
export function baseMergedRechecksItself(deps: Pick<TaskFlowDeps, "autofix">, recheck: Pick<WorkflowSnapshot, "e2e">): boolean {
  return deps.autofix?.enabled !== false && recheck.e2e?.required !== true;
}

/** The link of a pull request to its task names the candidate it holds; a fix or a merge gives a new one. Conditional on the digest read, so a link that moved meanwhile is the newer writer's. */
async function rekeyItems(deps: TaskFlowDeps, host: CodeHost, definitionUrl: string, task: TaskRecord, before: WorkflowSnapshot, after: WorkflowSnapshot): Promise<TransactItem[]> {
  const items: TransactItem[] = [];
  for (const pullRequest of after.pullRequests ?? []) {
    const earlier = before.pullRequests?.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number);
    if (earlier === undefined || earlier.candidateDigest === pullRequest.candidateDigest) continue;
    // Links are filed by the connection's PROVIDER (as publish files them); a row an earlier build filed under the connection's own name is still the one to move (dual read, lane P2 review N1).
    let key = linkedChangeRequestKey(providerOf(host), definitionUrl, String(pullRequest.number));
    if (key === undefined) throw agentXError("CONFIG_INVALID", "the pull request cannot be linked to this task");
    if (host.kind !== providerOf(host) && (await deps.store.get(key)) === undefined) key = linkedChangeRequestKey(host.kind, definitionUrl, String(pullRequest.number)) ?? key;
    items.push({ kind: "update", key, ops: [change.set("candidateDigest", pullRequest.candidateDigest)], condition: when.and(when.eq("taskId", task.taskId), when.eq("candidateDigest", earlier.candidateDigest)) });
  }
  return items;
}

export async function recordMaintained(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord, ended: Ended): Promise<void> {
  const maintenance = operation.maintenance;
  const workflow = task.workflow;
  if (maintenance === undefined || workflow === undefined || task.closedAt !== undefined) return;
  if (ended.status === "CANCELLED") {
    // A merge of the base that was stopped pushed nothing: the task waits for the merge as it did.
    if (maintenance.action === "sync" && workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "RUNNING" && workflow.branchSync !== undefined) await commitWorkflow(deps, task, endWorkflowBranchSync(workflow, iso(deps)));
    return;
  }
  if (maintenance.action === "append") await recordAppended(deps, task, workflow, operation, ended);
  else await recordSynced(deps, task, workflow, operation, ended);
}

async function recordAppended(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot, operation: OperationRecord, ended: Ended): Promise<void> {
  const maintenance = operation.maintenance!;
  const binding = maintenance.workflowCandidate;
  if (binding === undefined || workflow.stage !== "PULL_REQUEST" || workflow.state !== "RUNNING" || workflow.candidate?.digest !== binding.candidateDigest) return;
  const pullRequest = workflow.pullRequests?.find((entry) => entry.repositoryId === maintenance.repository && entry.number === maintenance.pullRequestNumber);
  if (pullRequest === undefined) return;
  const now = iso(deps);
  const fail = async (cause?: WorkflowPullRequestUpdateCause): Promise<void> => {
    await commitWorkflow(deps, task, blockWorkflowPullRequestUpdate(workflow, { numbers: [pullRequest.number], ...(cause === undefined ? {} : { cause }), now }));
    await restoreRecordHead(deps, task, operation);
  };
  // Why the push failed, by the worker's own error: it could not take a reviewed fix; the head moved or the push was not a fast-forward; or anything else on the way stopped it.
  const cause: WorkflowPullRequestUpdateCause = ended.status === "SUCCEEDED" ? "PUSH_REFUSED"
    : ended.error?.includes(WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED) === true ? "WORKER_OUTDATED"
      : ended.error?.includes(WORKFLOW_FIX_DROPS_BASE_CHANGES) === true ? "BASE_CHANGES_DROPPED"
      : ended.error?.startsWith("STALE_FENCE") === true ? "HEAD_MOVED" : "PUSH_REFUSED";
  if (cause === "WORKER_OUTDATED") { await fail(cause); return; }
  let pushedCommit: string | undefined;
  const candidateRepository = workflow.candidate.repositories.find((entry) => entry.repositoryId === maintenance.repository);
  if (ended.status === "SUCCEEDED") {
    const pushed = PullRequestLifecycleResultSchema.safeParse(ended.outcome?.kind === "published" ? ended.outcome.result : undefined);
    if (!pushed.success || pushed.data.action !== "append" || pushed.data.repository !== maintenance.repository || pushed.data.number !== maintenance.pullRequestNumber
      || pushed.data.treeSha !== binding.treeSha || candidateRepository?.treeSha !== binding.treeSha || !SHA.test(pushed.data.commit)) { await fail("PUSH_REFUSED"); return; }
    pushedCommit = pushed.data.commit;
  }
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === maintenance.repository);
  if (definition === undefined || deps.codeHosts === undefined) { if (pushedCommit === undefined) await fail(cause); return; }
  const host = codeHostForRecord(deps.codeHosts, definition);
  const scope = scopeOf(deps);
  const repositoryRef = { url: definition.url };
  const record = await pullRequestRecordOf(deps, task.workspaceId, maintenance.repository, maintenance.pullRequestNumber);
  // The host, not the worker, says what the pull request now holds. A failed push may still have landed: then the host's head is Rovara's fast-forward of the recorded head, on the reviewed tree.
  let head: string;
  let headTree: string;
  let state: "open" | "closed" | "merged";
  let sourceBranch: string;
  try {
    const remote = await host.getChangeRequest({ repository: repositoryRef, id: String(maintenance.pullRequestNumber), url: pullRequest.url }, scope);
    head = remote.headRevision; state = remote.state; sourceBranch = remote.sourceBranch;
    if (head === maintenance.expectedHeadCommit && state === "open") {
      const branchHead = await host.branchHead(repositoryRef, maintenance.headBranch, scope).catch(() => undefined);
      if (branchHead !== undefined && branchHead !== head && SHA.test(branchHead)) head = branchHead;
    }
    headTree = await host.tree(repositoryRef, head, scope);
  } catch (error) {
    if (pushedCommit === undefined) { await fail(cause); return; }
    throw error;
  }
  const onReviewedTree = sourceBranch === maintenance.headBranch && headTree === binding.treeSha && head !== maintenance.expectedHeadCommit && SHA.test(head);
  // A fix is a fast-forward of the head the task recorded (its only parent); a conflict round's fix is a merge commit: the recorded head first and the base commit it merged second, and nothing else.
  const parentsAreOurs = async (): Promise<boolean> => {
    try {
      return JSON.stringify(await host.commitParents(repositoryRef, head, scope)) === JSON.stringify(binding.mergeBaseCommit === undefined ? [maintenance.expectedHeadCommit] : [maintenance.expectedHeadCommit, binding.mergeBaseCommit]);
    } catch { return false; }
  };
  const landed = onReviewedTree && (pushedCommit !== undefined ? head === pushedCommit && record?.expectedHeadCommit === head : record?.expectedHeadCommit === head || await parentsAreOurs())
    && (binding.mergeBaseCommit === undefined || await parentsAreOurs());
  if (!landed || state === "closed") { await fail(pushedCommit === undefined ? cause : "HEAD_MOVED"); return; }
  const updated = state === "merged"
    ? observeWorkflowPullRequestMergedWithFix(workflow, { repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha: head, headTreeSha: binding.treeSha, observedAt: now }, now)
    : recordWorkflowPullRequestUpdate(workflow, { updates: [{ repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha: head, headTreeSha: binding.treeSha }], now });
  // A conflict round's fix was pushed as the merge of the base commit: the candidate is now on that base, so the next review and fix see only Rovara's change.
  const next = binding.mergeBaseCommit !== undefined && state !== "merged"
    ? recordWorkflowBranchSync(updated, { repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha: head, headTreeSha: binding.treeSha, baseCommitSha: binding.mergeBaseCommit, now })
    : updated;
  const items: TransactItem[] = [
    ...(await rekeyItems(deps, host, definition.url, task, workflow, next)),
    ...(record !== undefined && record.expectedHeadCommit !== head
      ? [{ kind: "update" as const, key: pullRequestRecordKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber), ops: [change.set("expectedHeadCommit", head), change.set("state", state), change.set("updatedAt", now)], condition: when.eq("expectedHeadCommit", maintenance.expectedHeadCommit) }] : []),
    ...prHeadItems({ orgId: deps.companyId, repositoryKey: requireRepositoryKey(providerOf(host), definition.url), headSha: head, taskId: task.taskId, repositoryId: pullRequest.repositoryId, number: pullRequest.number, branch: maintenance.headBranch }, Date.parse(now)),
    // More pull requests to go: the next push is due, as the first one was after the reviews.
    ...(next.stage === "PULL_REQUEST" && next.state === "READY" ? [dispatchRowItem(deps, task.taskId, next.revision, "PUBLISH", now)] : []),
  ];
  if (!(await commitWorkflow(deps, task, next, items))) return;
  // The pushed fix was found merged and that completes the task: the host is told it ended, once (a later close does not tell it again).
  if (completedByMerge(workflow, next)) await announceTaskEnd(deps, task.taskId, "merged");
  if (next.stage === "PULL_REQUEST" && next.state === "READY") await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "PUBLISH" }).catch((error: unknown) => log(deps, { event: "build_step.start_failed", taskId: task.taskId, kind: "PUBLISH", error: error instanceof Error ? error.name : "unknown" }));
}

async function recordSynced(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot, operation: OperationRecord, ended: Ended): Promise<void> {
  const maintenance = operation.maintenance!;
  const binding = maintenance.workflowSync;
  const marker = workflow.branchSync;
  // Only the merge the task is waiting on counts: it must still be at WAIT_FOR_MERGE/RUNNING with this exact merge marked; anything else is dropped.
  if (binding === undefined || workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "RUNNING" || marker === undefined || marker.repositoryId !== maintenance.repository
    || marker.number !== maintenance.pullRequestNumber || marker.expectedHeadCommit !== binding.expectedHeadCommit) return;
  const pullRequest = workflow.pullRequests?.find((entry) => entry.repositoryId === marker.repositoryId && entry.number === marker.number);
  if (pullRequest === undefined || pullRequest.headSha !== binding.expectedHeadCommit) return;
  const now = iso(deps);
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === maintenance.repository);
  const parsed = ended.status === "SUCCEEDED" ? PullRequestLifecycleResultSchema.safeParse(ended.outcome?.kind === "published" ? ended.outcome.result : undefined) : undefined;
  const reported = parsed?.success === true && parsed.data.repository === maintenance.repository ? parsed.data : undefined;
  // What the host shows now. A merge the worker says it pushed is never judged without it (the result is then recorded by the next attempt); for a merge that failed, an unreadable host shows nothing.
  let github: BranchSyncGithub | undefined;
  let parentsFailure: Error | undefined;
  let host: ReturnType<typeof codeHostForRecord> | undefined;
  try {
    if (definition === undefined || deps.codeHosts === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "cannot verify the merged pull request against the merge");
    host = codeHostForRecord(deps.codeHosts, definition);
    const scope = scopeOf(deps);
    const repositoryRef = { url: definition.url };
    const remote = await host.getChangeRequest({ repository: repositoryRef, id: String(maintenance.pullRequestNumber), url: pullRequest.url }, scope);
    let head = remote.headRevision;
    if (head === binding.expectedHeadCommit && remote.state === "open") {
      const branchHead = await host.branchHead(repositoryRef, maintenance.headBranch, scope).catch(() => undefined);
      if (branchHead !== undefined && branchHead !== head && SHA.test(branchHead)) head = branchHead;
    }
    const headTreeSha = await host.tree(repositoryRef, head, scope);
    // A parents read that fails is not "no merge": the merge is judged on them, so the failure is retried by the next attempt.
    const parents = head !== binding.expectedHeadCommit
      ? await host.commitParents(repositoryRef, head, scope).catch((failure: unknown) => { parentsFailure = failure instanceof Error ? failure : new Error("the merge's parents could not be read"); return undefined; }) : undefined;
    if (parentsFailure !== undefined) throw parentsFailure;
    github = { state: remote.state, headBranch: remote.sourceBranch, headCommit: head, headTreeSha, parents };
  } catch (error) {
    if (parentsFailure !== undefined || (reported !== undefined && reported.commit !== binding.expectedHeadCommit)) throw error;
  }
  const outcome = planBranchSyncOutcome({
    askFirst: false, workflow, binding: { repositoryId: marker.repositoryId, number: marker.number, baseCommit: binding.baseCommit, expectedHeadCommit: binding.expectedHeadCommit },
    terminalStatus: ended.status, terminalError: ended.error, result: reported, github, baseBranch: maintenance.baseBranch, recordedBranch: maintenance.headBranch, now,
  });
  const milestone = (kind: "fixing" | "stuck", text: string, n: number): TransactItem[] => deps.milestones === undefined ? [] : deps.milestones.items({
    kind, orgId: deps.companyId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: now, text: text.slice(0, 500),
    pullRequests: [{ repository: marker.repositoryId, number: marker.number, url: pullRequest.url }],
  }, n);
  let committed: boolean;
  // A merge that ends without being recorded (nothing pushed, a failed or lost run with no merge on the host, a stop): the pull request's record goes back to the head Rovara had, so a head it did not
  // accept is not read as its own. A merge the host shows with the right parents is recorded whatever the run's status: it is a new candidate that is checked and reviewed again (decision 67b).
  if (outcome.kind === "unchanged") { committed = await commitWorkflow(deps, task, outcome.workflow); await restoreRecordHead(deps, task, operation); }
  else if (outcome.kind === "stopped" || outcome.kind === "asked" || outcome.kind === "gave_up") { committed = await commitWorkflow(deps, task, outcome.workflow, milestone("stuck", outcome.message, outcome.workflow.revision)); await restoreRecordHead(deps, task, operation); }
  else if (outcome.kind === "conflict") {
    const round = outcome.workflow.fixRounds?.conflict ?? 1;
    committed = await commitWorkflow(deps, task, outcome.workflow, [
      dispatchRowItem(deps, task.taskId, outcome.workflow.revision, "IMPLEMENT", now),
      ...milestone("fixing", `The branch conflicts with ${maintenance.baseBranch}, so Rovara is resolving it (try ${String(round)} of ${String(CONFLICT_ROUNDS_MAX)}).`, outcome.workflow.revision),
    ]);
  } else {
    // A clean merge, on the host. It is a NEW CANDIDATE, not a trusted one (owner decision 67b): the host shows the right parents, but not what the merge's tree holds beyond them, so the checks and the
    // reviews run again on it before the task may wait for the merge and the pull request may be called ready. The earlier checks, reviews and accepted findings are not carried over; the task is blocked at
    // VERIFY with the reason (the owner's Retry checks runs them, or Rovara's own automatic retry below; merge tracking marks a pull request ready only while the task waits for the merge).
    if (host === undefined || definition === undefined) return;
    const record = await pullRequestRecordOf(deps, task.workspaceId, maintenance.repository, maintenance.pullRequestNumber);
    const { verification: _verification, reviews: _reviews, acceptedFindings: _accepted, ...merged } = outcome.workflow;
    void _verification; void _reviews; void _accepted;
    const recheck = WorkflowSnapshotSchema.parse({ ...merged, stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.baseMergedRecheck, updatedAt: now });
    const rechecksItself = baseMergedRechecksItself(deps, recheck);
    committed = await commitWorkflow(deps, task, recheck, [
      // Said in the milestone feed once, truthfully: Rovara re-checking by itself (information), or the task waiting for the owner (needs you). When the row is written Rovara may still end up asking (the autonomy,
      // the spend and the allowances are read at the look): that ask writes the "needs you" line then.
      ...milestone(rechecksItself ? "fixing" : "stuck", rechecksItself ? BASE_MERGED_RECHECKING_MILESTONE : BASE_MERGED_NEEDS_YOU_MILESTONE, recheck.revision),
      // Decision 70(c): the checks re-run by themselves. The AUTOFIX row (cause `base-merged`) commits with the block; the policy reads the autonomy again (`suggest` asks), the spend and the day budget, and
      // allows one automatic retry per candidate and three a day per task (its own allowance, not the task's lifetime automatic actions); admission holds the company's allowance per ten minutes. A task that
      // needs E2E is not synced (and its conflict merge, were it clean, stays the owner's Retry): its recheck has no source export.
      ...(rechecksItself ? [dispatchRowItem(deps, task.taskId, recheck.revision, "AUTOFIX", now, now, "base-merged")] : []),
      ...(await rekeyItems(deps, host, definition.url, task, workflow, outcome.workflow)),
      ...(record !== undefined && record.expectedHeadCommit !== outcome.headSha
        ? [{ kind: "update" as const, key: pullRequestRecordKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber), ops: [change.set("expectedHeadCommit", outcome.headSha), change.set("state", "open"), change.set("updatedAt", now)], condition: when.eq("expectedHeadCommit", maintenance.expectedHeadCommit) }] : []),
      ...prHeadItems({ orgId: deps.companyId, repositoryKey: requireRepositoryKey(providerOf(host), definition.url), headSha: outcome.headSha, taskId: task.taskId, repositoryId: marker.repositoryId, number: marker.number, branch: maintenance.headBranch }, Date.parse(now)),
    ]);
    // The row is looked at right away; a sweep finds it if this process dies first.
    if (committed && rechecksItself) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: recheck.revision, kind: "AUTOFIX" }).catch((error: unknown) => log(deps, { event: "build_step.start_failed", taskId: task.taskId, kind: "AUTOFIX", error: error instanceof Error ? error.name : "unknown" }));
  }
  if (committed && outcome.kind === "conflict") await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: outcome.workflow.revision, kind: "IMPLEMENT" }).catch((error: unknown) => log(deps, { event: "build_step.start_failed", taskId: task.taskId, kind: "IMPLEMENT", error: error instanceof Error ? error.name : "unknown" }));
}
