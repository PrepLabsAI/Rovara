// Lane L10, the build step: opening the pull request of exactly the code whose checks and reviews passed. Cloud's `startTaskWorkflowPublicationFromSystem` (developer-tasks/publication.ts), the
// pull request callback (`reconcilePullRequest`, aws/broker/pull-request-reconcile.ts) and the publish branch of `completedWorkflowItems`, on the code-host port.
//
// The safety rules are Cloud's, unchanged: the worker publishes only the tree the checks and reviews passed on; the HOST, not the worker, says what the pushed branch holds (its head must be the
// reported commit, that commit's tree the checked one, and the commit must stand on the task's pinned base) before a change request is opened from it; the opened change request's own head is
// read again and one that is not the checked code is closed and recorded nowhere; a change request is always a draft, since a person merges. What is left out: the checked-HEAD mode and the
// required browser and API round (E2E), the project's catalog pointer, the spec gate, the attribution trailers, the CodeBuild gates, and replace and revert (not a workflow's).
import {
  PullRequestResultSchema, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, agentXError, blockWorkflow, change, when, registerWorkflowPullRequest, unblockWorkflowPublication, workflowPublicationRetryable, workflowRequestId,
  type ChangeRequestRef, type CodeHost, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { codeHostForRecord, providerOf } from "../../plugins/routing.js";
import { lessonsUsedOf, riskFromFiles, ticketIssueKeyOf } from "./changed-files.js";
import { openBranchWriters } from "../branch-sync/branch-writers.js";
import { linkedChangeRequestStep } from "../proof/revert/linked-change-requests.js";
import { pullRequestTitle, workflowPullRequestBody } from "../proof/workflow-pull-request-body.js";
import { codeHostRepositoryKey, requireRepositoryKey } from "../merge/repository-key.js";
import { prHeadItems, recoveryRowKey } from "../merge/store.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { stageAudit } from "../task-flow/admission.js";
import { dispatchRowItem, resolveRowItem } from "../task-flow/dispatch-rows.js";
import { newId } from "../task-flow/support.js";
import { fromDocument, toDocument, type OperationRecord, type PublicationExpectation, type TaskRecord } from "../task-flow/records.js";
import { workspaceOperations } from "../task-flow/reads.js";
import { acceptStep, commitWorkflow, runDispatchRow, type StepStart } from "../task-flow/stage-machine.js";
import { iso, log } from "../task-flow/support.js";
import { startPullRequestUpdate } from "./maintain.js";
import { approvedCodingPlan } from "./plan-input.js";
import { pullRequestRecordKey, taskOfOperation, type PullRequestRecord } from "./records.js";
import { jsonOf, locate, settled, type RowRef } from "./start.js";
import type { Ended } from "./results.js";

/** The branch a publication pushes: named after the operation, so two publications never share one. */
export const headBranchOf = (operationId: string): string => `agentx/${operationId}`;

const scopeOf = (deps: Pick<TaskFlowDeps, "companyId">) => ({ orgId: deps.companyId });

// ---- starting a publication

/**
 * Opens the draft pull request of the candidate whose checks and reviews passed, with no one asking. One repository at a time, the first without a pull request; the next is due when this
 * one's result lands. STALE unless the task is open and ready to publish at the row's revision. The request id is made from the task, revision, candidate, repository and attempt (the
 * attempt counts this tree's publications that ended without succeeding), so a recovered row is the first one's duplicate. After a failed publication the system never tries again on its own
 * (the task is blocked with Retry); the owner's retry does, with the next attempt's id.
 */
export async function startPublication(deps: TaskFlowDeps, row: RowRef, options: { ownerRetry?: boolean } = {}): Promise<StepStart> {
  const ownerRetry = options.ownerRetry === true;
  const found = await locate(deps, row, (workflow) => (ownerRetry ? workflowPublicationRetryable(workflow) : workflow.stage === "PULL_REQUEST" && workflow.state === "READY") && workflow.candidate !== undefined);
  if (found === "stale") return settled(deps, row, "STALE");
  if (found === "waiting") return "WAITING";
  const { task, workspace } = found;
  const { workflow } = task;
  const candidate = workflow.candidate!;
  if (deps.codeHosts === undefined) throw agentXError("CONFIG_INVALID", "no code host is set up, so there is nowhere to open the pull request");
  const repository = [...candidate.repositories].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
    .find((entry) => !(workflow.pullRequests ?? []).some((pullRequest) => pullRequest.repositoryId === entry.repositoryId));
  // Every repository has its pull request: an approved fix whose checks and reviews passed is pushed to them instead.
  if (repository === undefined) return startPullRequestUpdate(deps, row, { task, workspace });
  const failedOperations = (await workspaceOperations(deps, task.workspaceId)).filter((operation) => operation.kind === "publish" && ["FAILED", "INTERRUPTED", "CANCELLED"].includes(operation.status)
    && operation.publication?.repository === repository.repositoryId && operation.publication.expectedTreeSha === repository.treeSha && operation.publication.candidateDigest === candidate.digest);
  const attempt = 1 + failedOperations.length;
  if (attempt > 1 && !ownerRetry) return settled(deps, row, "STALE");
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === repository.repositoryId);
  if (project === undefined || definition === undefined) return settled(deps, row, "STALE");
  const host = codeHostForRecord(deps.codeHosts, definition); // an unknown host is refused here, before anything is claimed, with the router's sentence
  if (ownerRetry && failedOperations.length > 0) await closeOrphanedDrafts(deps, task, workflow, host, definition.url, new Set(failedOperations.map((operation) => operation.id)), repository.repositoryId);
  const receivedAt = iso(deps);
  const plan = await approvedCodingPlan(deps.artifacts, workflow).catch(() => undefined);
  const rovaraV2 = workflow.definitionVersion === "1.1.0";
  // The risk is judged again for this code and recorded with it, without moving the revision (it is derived from the very code this write is conditioned on). The changed files are read from the code host
  // AFTER the push (`verifyPublishedChanges`), never from what the worker reports, so until then the level is high and says why.
  const judged = rovaraV2 ? riskFromFiles(workflow, undefined) : workflow;
  const title = pullRequestTitle(task.title, rovaraV2);
  const proof = await deps.designReview?.proofContext?.(deps, task, workflow).catch(() => undefined);
  const secondLines = deps.secondReview?.prLines(task, candidate.digest, workflow.acceptedFindings) ?? [];
  const lessonsUsed = await lessonsUsedOf(deps, task, repository.repositoryId);
  const linearIssueKey = await ticketIssueKeyOf(deps, task);
  const body = workflowPullRequestBody(task, judged, plan?.text, undefined, { ...(linearIssueKey === undefined ? {} : { linearIssueKey }), ...(lessonsUsed === undefined ? {} : { lessonsUsed }), ...(secondLines.length === 0 ? {} : { secondReviewLines: secondLines }), ...(proof === undefined ? {} : { proof }) });
  const baseCommitSha = (workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === repository.repositoryId)?.baseCommitSha;
  const operationId = newId(deps);
  const headBranch = headBranchOf(operationId);
  const publication: PublicationExpectation = {
    repository: repository.repositoryId, repositoryUrl: definition.url, headBranch, baseBranch: definition.defaultBranch, title, body, draft: true,
    expectedTreeSha: repository.treeSha, ...(baseCommitSha === undefined ? {} : { expectedBaseCommit: baseCommitSha }), candidateDigest: candidate.digest, workflowRevision: workflow.revision,
  };
  const next: WorkflowSnapshot = workflow.state === "BLOCKED" ? unblockWorkflowPublication(judged, receivedAt) : ownerRetry ? { ...judged, revision: workflow.revision + 1, updatedAt: receivedAt } : judged;
  const accepted = await acceptStep(deps, {
    task, workspace, kind: "publish", operationId, requestId: workflowRequestId("agentx-auto-publish", task.taskId, row.workflowRevision, candidate.digest, repository.repositoryId, attempt),
    prompt: "publish", workflow: { current: workflow, next }, publication, extraActions: ["pull-request"],
    payload: jsonOf({
      mode: "create", repository: repository.repositoryId, title, body, headBranch, candidateTreeSha: repository.treeSha, publicationMode: "CHECKED_TREE",
      ...(baseCommitSha === undefined ? {} : { workflowBaseCommit: baseCommitSha }),
    }),
    requires: ["publish.candidateTree", "publish.contextDigest", ...(baseCommitSha === undefined ? [] : ["publish.workflowBase"])],
    extra: [resolveRowItem(deps, task.taskId, row.workflowRevision)],
  });
  return settled(deps, row, accepted.result);
}

/**
 * A publication that was interrupted after its draft was opened (the worker's result was lost) leaves a draft nobody tracks. Before the owner's Retry opens another from a new branch, the draft an
 * earlier failed attempt of this very publication opened, and that the workflow never registered, is READ at the host first: it is closed only when it is still a draft, open, and at the commit
 * Rovara recorded (so no person pushed to it and nobody marked it ready). Any other is left as it is, with the reason on its record and in the log: a person has taken it up.
 */
async function closeOrphanedDrafts(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot, host: CodeHost, repositoryUrl: string, failedOperationIds: ReadonlySet<string>, repositoryId: string): Promise<void> {
  const page = await deps.store.query({ pk: `WORKSPACE#${task.workspaceId}`, sk: { op: "beginsWith", prefix: `PULL_REQUEST#${repositoryId}#` }, limit: 50 });
  for (const item of page.items) {
    const record = fromDocument<PullRequestRecord>(item);
    if (record === undefined || record.state !== "open" || !failedOperationIds.has(record.createdByOperationId) || (workflow.pullRequests ?? []).some((entry) => entry.number === record.number && entry.repositoryId === repositoryId)) continue;
    const ref: ChangeRequestRef = { repository: { url: repositoryUrl }, id: String(record.number), url: record.url };
    const key = pullRequestRecordKey(task.workspaceId, repositoryId, record.number);
    try {
      const status = await host.changeRequestStatus(ref, scopeOf(deps));
      if (status.state !== "open" || !status.draft || status.headRevision !== record.expectedHeadCommit || status.reviews.length > 0) {
        const why = status.state !== "open" ? `it is ${status.state}` : !status.draft ? "it was marked ready" : status.headRevision !== record.expectedHeadCommit ? "someone pushed to it" : "it has reviews";
        await deps.store.update({ key, ops: [change.set("leftOpen", `Rovara did not close this earlier draft: ${why}.`), change.set("updatedAt", iso(deps))], condition: when.present() });
        log(deps, { event: "build_step.orphaned_draft_left", taskId: task.taskId, number: record.number, why });
        continue;
      }
      await host.updateChangeRequest(ref, { state: "closed" }, scopeOf(deps));
      await deps.store.update({ key, ops: [change.set("state", "closed"), change.set("updatedAt", iso(deps))], condition: when.present() });
    } catch (error) {
      log(deps, { event: "build_step.orphaned_draft_not_closed", taskId: task.taskId, number: record.number, error: error instanceof Error ? error.name : "unknown" });
    }
  }
}

// ---- the worker's pull request callback

const ALLOWED = new Set(["repository", "repositoryUrl", "headBranch", "baseBranch", "commit", "title", "body", "checks"]);

/** The change requests' ancestry walk: bounded, so a deep history cannot hold a callback. */
const ANCESTRY_WALK_MAX = 512;

async function onPinnedBase(host: CodeHost, repositoryUrl: string, commit: string, base: string | undefined, deps: Pick<TaskFlowDeps, "companyId">): Promise<boolean> {
  if (base === undefined) return true;
  const pending = [commit];
  const seen = new Set<string>();
  while (pending.length > 0 && seen.size < ANCESTRY_WALK_MAX) {
    const current = pending.shift()!;
    if (current === base) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of await host.commitParents({ url: repositoryUrl }, current, scopeOf(deps))) {
      if (!/^[a-f0-9]{40,64}$/u.test(parent)) return false;
      pending.push(parent);
    }
  }
  return false;
}

/** A publication whose branch or opened change request is not the checked code: the task stops in plain words with Retry opening the pull request. Only a task still ready to publish its candidate. */
async function blockUncheckedPublication(deps: TaskFlowDeps, operation: OperationRecord): Promise<void> {
  try {
    const task = await taskOfOperation(deps, operation);
    const workflow = task?.workflow;
    if (task === undefined || workflow === undefined || workflow.stage !== "PULL_REQUEST" || workflow.state !== "READY" || workflow.candidate?.digest !== operation.publication?.candidateDigest) return;
    await commitWorkflow(deps, task, blockWorkflow(workflow, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, iso(deps)));
  } catch (error) {
    log(deps, { event: "build_step.unchecked_publication_block_failed", operationId: operation.id, error: error instanceof Error ? error.name : "unknown" });
  }
}

const objectOf = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the pull request callback must be an object");
  return value as Record<string, unknown>;
};

/**
 * The worker pushed its branch and asks the broker to open the pull request. The request is held to what the publication was started with; the host says what the branch holds; the change
 * request is opened as a draft; its own head is read again. Throws CALLBACK_FORBIDDEN (and blocks the task) for code that is not the checked code.
 */
export async function openPullRequest(deps: TaskFlowDeps, operation: OperationRecord, value: unknown): Promise<{ number: number; url: string; reconciled: boolean; draft: boolean }> {
  const expected = operation.publication;
  if (operation.kind !== "publish" || expected === undefined) throw agentXError("CALLBACK_FORBIDDEN", "operation cannot create a pull request");
  if (deps.codeHosts === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "no code host is set up");
  const input = objectOf(value);
  if (Object.keys(input).some((key) => !ALLOWED.has(key))) throw agentXError("CONFIG_INVALID", "pull request callback contains unknown fields");
  for (const key of ["repository", "repositoryUrl", "headBranch", "baseBranch", "title"] as const) {
    if (input[key] !== expected[key]) throw agentXError("CALLBACK_FORBIDDEN", `pull request callback ${key} is outside the operation scope`);
  }
  if (input["body"] !== undefined && input["body"] !== expected.body) throw agentXError("CALLBACK_FORBIDDEN", "pull request callback body is outside the operation scope");
  if (typeof input["commit"] !== "string" || !/^[a-f0-9]{40,64}$/u.test(input["commit"])) throw agentXError("CONFIG_INVALID", "published commit is invalid");
  const commit = input["commit"];
  // Still the publication of the current candidate: a task that moved on (a send back, a close) gets no pull request from a late callback.
  const task = await taskOfOperation(deps, operation);
  const workflow = task?.workflow;
  const candidateRepository = workflow?.candidate?.repositories.find((entry) => entry.repositoryId === expected.repository);
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.stage !== "PULL_REQUEST" || workflow.state !== "READY" || workflow.candidate?.digest !== expected.candidateDigest
    || candidateRepository?.treeSha !== expected.expectedTreeSha) {
    throw agentXError("STALE_FENCE", "this publication is no longer the task's current one");
  }
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === expected.repository);
  if (definition === undefined || definition.url !== expected.repositoryUrl) throw agentXError("CONFIG_INVALID", "published pull request repository is not part of the task's registered project revision");
  const host = codeHostForRecord(deps.codeHosts, definition);
  const scope = scopeOf(deps);
  const repositoryRef = { url: expected.repositoryUrl };
  // GitHub, not the worker, says what the branch holds.
  const head = await host.branchHead(repositoryRef, expected.headBranch, scope);
  if (head !== commit || await host.tree(repositoryRef, commit, scope) !== expected.expectedTreeSha || !await onPinnedBase(host, expected.repositoryUrl, commit, expected.expectedBaseCommit, deps)) {
    await blockUncheckedPublication(deps, operation);
    throw agentXError("CALLBACK_FORBIDDEN", "the pushed commit is not the checked code");
  }
  // A workflow publication is always a draft: humans merge.
  const reconciled = await host.reconcileChangeRequest({ repository: repositoryRef, sourceBranch: expected.headBranch, targetBranch: expected.baseBranch, title: expected.title, body: expected.body, draft: true }, scope);
  const number = Number(reconciled.ref.id);
  const ref: ChangeRequestRef = { repository: repositoryRef, id: reconciled.ref.id, url: reconciled.ref.url };
  // The branch could move between the check and the open (a force-push): the opened change request's own head must still be the checked commit, or it is closed again and nothing is recorded.
  let sound = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const details = await host.getChangeRequest(ref, scope);
      sound = details.headRevision === commit && await host.tree(repositoryRef, commit, scope) === expected.expectedTreeSha && await onPinnedBase(host, expected.repositoryUrl, commit, expected.expectedBaseCommit, deps);
      // A read that succeeded is judged as it stands (as Cloud does): only a read that FAILED is read again, so a branch put back between reads cannot be waited for.
      break;
    } catch (error) {
      log(deps, { event: "build_step.publication_head_unreadable", operationId: operation.id, attempt, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  if (!sound) {
    await host.updateChangeRequest(ref, { state: "closed" }, scope).catch((error: unknown) => log(deps, { event: "build_step.unchecked_pull_request_close_failed", operationId: operation.id, number, error: error instanceof Error ? error.name : "unknown" }));
    await blockUncheckedPublication(deps, operation);
    throw agentXError("CALLBACK_FORBIDDEN", "the opened pull request is not the checked code");
  }
  const record: PullRequestRecord = {
    ...pullRequestRecordKey(operation.workspaceId, expected.repository, number), entityType: "PULL_REQUEST", workspaceId: operation.workspaceId, repository: expected.repository,
    repositoryUrl: expected.repositoryUrl, number, url: reconciled.ref.url, state: "open", headBranch: expected.headBranch, baseBranch: expected.baseBranch, expectedHeadCommit: commit,
    title: expected.title, body: reconciled.draftRefused === true ? `This pull request could not be opened as a draft; it is not ready to merge.\n\n${expected.body}` : expected.body,
    createdByOperationId: operation.id, updatedAt: iso(deps),
  };
  // The record and the audit fact of the opening commit together (a repeat of this callback is the same occurrence: its event is already there, and the record is only written again).
  // `repositoryKey` names the repository the way the merge audit event does (the same key function), so one pull request's events can be matched. `repository` stays as it was.
  const repositoryKey = codeHostRepositoryKey(providerOf(host), expected.repositoryUrl);
  const audit = stageAudit(deps, {
    eventId: `pull_request.opened:${operation.id}`, actor: { type: "person", id: task.developerId }, action: "pull_request.opened", subject: { type: "task", id: task.taskId },
    details: { repository: expected.repository, ...(repositoryKey === undefined ? {} : { repositoryKey }), number: String(number) },
  });
  const written = await deps.store.transact([{ kind: "put", item: toDocument(record) }, ...audit]);
  if (!written.applied) await deps.store.put({ item: toDocument(record) });
  return { number, url: reconciled.ref.url, reconciled: reconciled.reconciled, draft: reconciled.draftRefused !== true };
}

// ---- the end of a publication

/**
 * After a publication ended. Failed: the task stops with Retry opening the pull request, and nothing starts it again by itself. Succeeded: the worker's result is read against the record the
 * callback wrote and against the host once more; the pull request is registered with the workflow, linked back to the task, its head indexed, the branch recorded as Rovara's alone
 * (`openBranchWriters`), and merge tracking enrolled, all in one commit. The last repository's pull request moves the task on to wait for the merge.
 */
export async function recordPublished(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord, ended: Ended): Promise<void> {
  const workflow = task.workflow;
  const expected = operation.publication;
  if (workflow === undefined || expected === undefined || workflow.stage !== "PULL_REQUEST" || workflow.state !== "READY" || workflow.candidate?.digest !== expected.candidateDigest) return;
  const now = iso(deps);
  if (ended.status !== "SUCCEEDED") {
    if (ended.status !== "CANCELLED") await commitWorkflow(deps, task, blockWorkflow(workflow, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, now));
    return;
  }
  try {
    const published = PullRequestResultSchema.safeParse(ended.outcome?.kind === "published" ? ended.outcome.result : undefined);
    if (!published.success || published.data.repository !== expected.repository) throw agentXError("CONFIG_INVALID", "workflow pull request result is invalid");
    if (deps.codeHosts === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "no code host is set up");
    const project = await deps.projects.revision(task.project, task.startingRevision);
    const definition = project?.definition.repositories.find((entry) => entry.name === published.data.repository);
    if (definition === undefined) throw agentXError("CONFIG_INVALID", "published pull request repository is not part of the task's registered project revision");
    const host = codeHostForRecord(deps.codeHosts, definition);
    const recordKey = pullRequestRecordKey(operation.workspaceId, published.data.repository, published.data.number);
    const recorded = fromDocument<PullRequestRecord>(await deps.store.get(recordKey));
    if (recorded === undefined || recorded.url !== published.data.url || recorded.expectedHeadCommit !== published.data.commit || recorded.createdByOperationId !== operation.id) {
      throw agentXError("STALE_FENCE", "published pull request head does not match the broker-verified publication");
    }
    const candidateRepository = workflow.candidate.repositories.find((entry) => entry.repositoryId === published.data.repository);
    if (candidateRepository === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "cannot verify the published pull request against the checked candidate");
    const ref: ChangeRequestRef = { repository: { url: definition.url }, id: String(published.data.number), url: published.data.url };
    const details = await host.getChangeRequest(ref, scopeOf(deps));
    const headTreeSha = await host.tree({ url: definition.url }, details.headRevision, scopeOf(deps));
    if (details.state !== "open" || details.headRevision !== recorded.expectedHeadCommit || headTreeSha !== candidateRepository.treeSha) {
      throw agentXError("STALE_FENCE", "published pull request does not contain the exact checked candidate tree");
    }
    const repositoryKey = requireRepositoryKey(providerOf(host), definition.url);
    const link = linkedChangeRequestStep({
      hostKind: providerOf(host), repositoryAddress: definition.url, changeRequestId: String(published.data.number), repositoryId: published.data.repository, number: published.data.number, url: published.data.url,
      taskId: task.taskId, workspaceId: task.workspaceId, candidateDigest: workflow.candidate.digest, createdAt: now,
    });
    if (link === undefined) throw agentXError("CONFIG_INVALID", "the code host's repository cannot be linked to this task");
    const next = registerWorkflowPullRequest(workflow, {
      repositoryId: published.data.repository, number: published.data.number, url: published.data.url, headSha: recorded.expectedHeadCommit, headTreeSha, candidateDigest: workflow.candidate.digest, required: true,
    }, now);
    const items: TransactItem[] = [
      link,
      // More repositories to go: the next draft pull request is due, as the first one was after the reviews.
      ...(next.stage === "PULL_REQUEST" && next.state === "READY" ? [dispatchRowItem(deps, task.taskId, next.revision, "PUBLISH", now)] : []),
      // The head, for the check and status events that name only a commit.
      ...prHeadItems({ orgId: deps.companyId, repositoryKey, headSha: recorded.expectedHeadCommit, taskId: task.taskId, repositoryId: published.data.repository, number: published.data.number, branch: recorded.headBranch }, Date.parse(now)),
      // The task's tracking row: merge tracking reads it back (kind `tracking`); the first pull request enrols the task.
      ...((workflow.pullRequests ?? []).length === 0 ? [{ kind: "put" as const, item: toDocument({ ...recoveryRowKey(task.taskId), entityType: "WORKFLOW_MERGE_RECOVERY", taskId: task.taskId, kind: "tracking", createdAt: now, updatedAt: now, attempts: 0, nextAttemptAt: Date.parse(now) }) }] : []),
    ];
    if (!(await commitWorkflow(deps, task, next, items))) return;
    // Rovara created this branch and opened its pull request: from now on a pass may tell whether anyone else wrote to it. Created once, so a repeat leaves it as it is.
    await openBranchWriters(deps.store, { orgId: deps.companyId, repositoryId: published.data.repository, branch: recorded.headBranch }, now);
    if (next.stage === "PULL_REQUEST" && next.state === "READY") {
      await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "PUBLISH" }).catch((error: unknown) => log(deps, { event: "build_step.start_failed", taskId: task.taskId, kind: "PUBLISH", error: error instanceof Error ? error.name : "unknown" }));
    }
  } catch (error) {
    // The result could not be believed: the task stops with Retry; the pull request, if one was opened, was closed by the callback when it was not the checked code.
    log(deps, { event: "build_step.publication_not_recorded", taskId: task.taskId, operationId: operation.id, error: error instanceof Error ? error.name : "unknown" });
    await commitWorkflow(deps, task, blockWorkflow(workflow, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, now));
  }
}
