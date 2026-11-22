// Collection reads the host, never event text, and starts no machine or model.
import {
  ChangeRequestFeedbackSchema, WorkflowSnapshotSchema, WorkflowFeedbackBundleCommentsSchema, WorkflowFeedbackBundleSchema,
  collectWorkflowFeedbackBundles, hostRateLimitRetryAt, when,
  type ChangeRequestFeedback, type ObjectStorage, type ReadBudget, type WorkflowFeedbackBundle, type WorkflowFeedbackThreadObservation, type WorkflowSnapshot,
} from "@agentx/contracts";
import { isCoreFeedbackTask } from "./ownership.js";
import { findLinkedChangeRequest } from "../proof/revert/linked-change-requests.js";
import { changeRequestRef, type RepositoryResolver } from "../merge/host-port.js";
import { workflowUpdateItem } from "../merge/store.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import type { TaskRecord } from "../task-flow/records.js";
import { feedbackDigest, feedbackPrefix, FEEDBACK_ARTIFACT_MAX_BYTES, FEEDBACK_INPUTS_MAX_BYTES, prepareFeedbackBundle, saveFeedbackBundle } from "./artifacts.js";

export interface PrFeedbackCollectionDeps {
  flow: TaskFlowDeps;
  repository: RepositoryResolver;
  blobs: Pick<ObjectStorage, "put" | "get">;
  now: () => number;
}

/** One host read may take at most ten seconds and never outlive the sweep. */
async function boundedRead(read: () => Promise<ChangeRequestFeedback>, signal: AbortSignal): Promise<ChangeRequestFeedback> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("feedback read deadline exceeded"));
      timer = setTimeout(abort, 10_000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

/** A changed head belongs to ordinary outside-push tracking, never a collector retry. */
export class FeedbackHeadMoved extends Error {}

const KIND = { review: "REVIEW", review_comment: "REVIEW_COMMENT", discussion: "DISCUSSION" } as const;

type Pull = NonNullable<WorkflowSnapshot["pullRequests"]>[number];
function bundleOf(task: TaskRecord, pr: Pull, read: ChangeRequestFeedback, now: string): { bundle: WorkflowFeedbackBundle; observations: WorkflowFeedbackThreadObservation[]; reopened: boolean } {
  const current = task.workflow!;
  const comments = read.comments.map(comment => ({ ...comment, kind: KIND[comment.kind], url: comment.url === "" ? pr.url : comment.url,
    bodyDigest: feedbackDigest(comment.body), bodyBytes: Buffer.byteLength(comment.body, "utf8") }));
  // Validate the entire comment set before filtering; duplicate identities never disappear through a resolved-thread filter.
  if (new Set(comments.map(comment => comment.id)).size !== comments.length) throw new Error("duplicate feedback comment identity");
  const eligible = new Set(comments.filter(comment => comment.kind !== "REVIEW_COMMENT").map(comment => comment.id));
  const observations: WorkflowFeedbackThreadObservation[] = [];
  const threads = new Set<string>();
  const memberships = new Set<string>();
  let reopened = false;
  for (const thread of read.threads) {
    if (threads.has(thread.id) || new Set(thread.commentIds).size !== thread.commentIds.length) throw new Error("duplicate feedback thread membership");
    threads.add(thread.id);
    const members = thread.commentIds.map(id => {
      const comment = comments.find(entry => entry.id === id && entry.kind === "REVIEW_COMMENT" && entry.threadId === thread.id);
      if (comment === undefined || memberships.has(id)) throw new Error("feedback thread membership is incomplete");
      memberships.add(id);
      return comment;
    });
    const prior = (current.feedbackReview?.threadObservations ?? current.feedbackThreadObservations)?.find(entry => entry.repositoryId === pr.repositoryId && entry.number === pr.number && entry.threadId === thread.id);
    const ids = members.flatMap(comment => {
      if (!thread.resolved) return [comment.id];
      const old = prior?.comments.find(entry => entry.id === comment.id);
      return prior?.resolved && (old === undefined || old.updatedAt !== comment.updatedAt || old.bodyDigest !== comment.bodyDigest || prior.eligibleCommentIds.includes(comment.id)) ? [comment.id] : [];
    }).sort();
    if (prior?.resolved && (!thread.resolved || ids.some(id => !prior.eligibleCommentIds.includes(id)))) reopened = true;
    for (const id of ids) eligible.add(id);
    observations.push({ repositoryId: pr.repositoryId, number: pr.number, threadId: thread.id, resolved: thread.resolved,
      comments: members.map(({ id, updatedAt, bodyDigest }) => ({ id, updatedAt, bodyDigest })).sort((a, b) => a.id.localeCompare(b.id)), eligibleCommentIds: ids });
  }
  if (comments.some(comment => comment.kind === "REVIEW_COMMENT" && !memberships.has(comment.id))) throw new Error("inline feedback has no complete thread");
  const selected = WorkflowFeedbackBundleCommentsSchema.parse(comments.filter(comment => eligible.has(comment.id)).sort((a, b) => a.id.localeCompare(b.id)));
  return { reopened, observations, bundle: WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId: task.taskId, repositoryId: pr.repositoryId, number: pr.number,
    headSha: read.changeRequest.headRevision, headTreeSha: read.changeRequest.headTreeRevision, candidateDigest: current.candidate!.digest,
    producer: "broker-pr-feedback", version: "1", recordedAt: now, comments: selected, commentSetDigest: feedbackDigest(JSON.stringify(selected)), sourceDeliveryIds: [] }) };
}

export function feedbackUnchanged(workflow: WorkflowSnapshot, bundles: WorkflowFeedbackBundle[], reopened: boolean): boolean {
  if (reopened) return false;
  const prior = workflow.feedbackReview;
  if (prior !== undefined) return prior.bundleRefs.length === bundles.length && bundles.every(bundle => prior.bundleRefs.some(ref =>
    ref.repositoryId === bundle.repositoryId && ref.number === bundle.number && ref.headSha === bundle.headSha && ref.headTreeSha === bundle.headTreeSha
    && ref.candidateDigest === bundle.candidateDigest && ref.commentSetDigest === bundle.commentSetDigest));
  if (bundles.every(bundle => bundle.comments.length === 0)) return true;
  const reviewed = workflow.feedbackReviewHistory?.at(-1);
  return reviewed?.status === "COMPLETE" && reviewed.candidateBindings.length === bundles.length && bundles.every(bundle => reviewed.candidateBindings.some(binding =>
    binding.repositoryId === bundle.repositoryId && binding.number === bundle.number && binding.commentSetDigest === bundle.commentSetDigest));
}

function requireCandidateHead(workflow: WorkflowSnapshot, pr: Pull, read: ChangeRequestFeedback): void {
      if (read.changeRequest.headRevision !== pr.headSha) throw new FeedbackHeadMoved("The pull request head changed outside Rovara.");
      if (!workflow.candidate!.repositories.some(repo => repo.repositoryId === pr.repositoryId && repo.treeSha === read.changeRequest.headTreeRevision)) throw new Error("feedback evidence does not match the pinned candidate");
}

export async function readCurrentFeedback(deps: PrFeedbackCollectionDeps, task: TaskRecord, budget: ReadBudget) {
  const workflow = task.workflow!;
  if (workflow.candidate === undefined) throw new Error("feedback candidate is missing");
    const bundles: WorkflowFeedbackBundle[] = [];
    const observations: WorkflowFeedbackThreadObservation[] = [];
    let reopened = false;
    const open = workflow.pullRequests?.filter(pr => pr.state === "OPEN" || pr.state === "UNKNOWN") ?? [];

    if (workflow.candidate.repositories.some(repo => !open.some(pr => pr.required && pr.repositoryId === repo.repositoryId))) throw new Error("feedback evidence does not match the pinned candidate");
    for (const pr of open) {
      const home = await deps.repository(task.project, task.startingRevision, pr.repositoryId, task.companyId);
      if (home === undefined) throw new Error("feedback evidence does not match the pinned candidate");
      const linked = await findLinkedChangeRequest(deps.flow.store, { hostKind: home.codeHost.kind, repositoryAddress: home.url, id: String(pr.number) });
      if (linked?.source !== "neutral" || linked.taskId !== task.taskId || linked.workspaceId !== task.workspaceId || linked.repositoryId !== pr.repositoryId || linked.number !== pr.number || linked.candidateDigest !== pr.candidateDigest || linked.url !== pr.url) throw new Error("feedback evidence does not match the pinned candidate");
      budget.beforeRequest();
      const read = ChangeRequestFeedbackSchema.parse(await boundedRead(() => home.codeHost.feedback(changeRequestRef(home.url, pr.number), { orgId: task.companyId }), budget.signal));
      if (budget.signal.aborted || read.changeRequest.ref.id !== String(pr.number) || read.changeRequest.ref.repository.url !== home.url || read.changeRequest.ref.url !== pr.url
        || read.comments.some(comment => comment.url !== "" && comment.url !== pr.url && !["#", "?", "/"].some(separator => comment.url.startsWith(pr.url + separator)))
        || read.changeRequest.state !== "open" || pr.candidateDigest !== workflow.candidate.digest) throw new Error("feedback evidence does not match the pinned candidate");
      requireCandidateHead(workflow, pr, read);
      const next = bundleOf(task, pr, read, new Date(deps.now()).toISOString());
      bundles.push(next.bundle); observations.push(...next.observations); reopened ||= next.reopened;
    }
  observations.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number || a.threadId.localeCompare(b.threadId));
  return { bundles, observations, reopened };
}

async function reviewedIdentities(deps: PrFeedbackCollectionDeps, task: TaskRecord, bundles: WorkflowFeedbackBundle[]): Promise<boolean> {
  const wf = task.workflow!;
  const reviewed = wf.feedbackReviewHistory?.at(-1);
  if (wf.feedbackReview !== undefined || reviewed?.status !== "COMPLETE") return false;
  const old: WorkflowFeedbackBundle[] = [];
  for (const binding of reviewed.candidateBindings) {
    const key = `${feedbackPrefix(task)}${binding.bundleDigest}.json`;
    const bytes = await deps.blobs.get(key, FEEDBACK_ARTIFACT_MAX_BYTES);
    if (bytes === undefined || bytes.byteLength > FEEDBACK_ARTIFACT_MAX_BYTES || feedbackDigest(bytes) !== binding.bundleDigest) throw new Error("reviewed feedback evidence is unavailable");
    const bundle = WorkflowFeedbackBundleSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (bundle.taskId !== task.taskId || bundle.repositoryId !== binding.repositoryId || bundle.number !== binding.number || bundle.commentSetDigest !== binding.commentSetDigest) throw new Error("reviewed feedback identity mismatch");
    old.push(bundle);
  }
  return bundles.every(bundle => bundle.comments.every(comment => old.some(prior => prior.repositoryId === bundle.repositoryId && prior.number === bundle.number
    && prior.comments.some(c => c.id === comment.id && c.updatedAt === comment.updatedAt && c.bodyDigest === comment.bodyDigest))));
}

async function rememberThreads(deps: PrFeedbackCollectionDeps, task: TaskRecord, observations: WorkflowFeedbackThreadObservation[]): Promise<"unchanged" | "collected" | "retry"> {
  const wf = task.workflow!;
  if (observations.length === 0 || JSON.stringify(wf.feedbackThreadObservations ?? []) === JSON.stringify(observations)) return "unchanged";
  const next = WorkflowSnapshotSchema.parse({ ...wf, revision: wf.revision + 1, feedbackThreadObservations: observations, updatedAt: new Date(deps.now()).toISOString() });
  const update = workflowUpdateItem(task.taskId, next, wf.revision, wf);
  update.condition = when.and(update.condition!, when.eq("companyId", task.companyId));
  return (await deps.flow.store.transact([update])).applied ? "collected" : "retry";
}

async function noNewFeedback(deps: PrFeedbackCollectionDeps, task: TaskRecord, bundles: WorkflowFeedbackBundle[], reopened: boolean): Promise<boolean> {
  return task.workflow!.feedbackReview === undefined && (bundles.every(b => b.comments.length === 0) || (!reopened && await reviewedIdentities(deps, task, bundles)));
}

export async function collectPrFeedback(deps: PrFeedbackCollectionDeps, task: TaskRecord, budget: ReadBudget): Promise<"unchanged" | "collected" | "retry"> {
  const workflow = task.workflow;
  if (!await isCoreFeedbackTask(deps.flow, task)) return "retry";
  if (task.closedAt !== undefined || task.releasedAt !== undefined || workflow?.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING" || workflow.candidate === undefined) return "unchanged";
  // A collecting round is recovered by its dispatch, never recollected over a running critic.
  if (workflow.feedbackReview?.status === "COLLECTING") return "unchanged";
  if (!(workflow.pullRequests ?? []).some(pr => pr.state === "OPEN" || pr.state === "UNKNOWN")) return "unchanged";
  try {
    const { bundles, observations, reopened } = await readCurrentFeedback(deps, task, budget);
    if (await noNewFeedback(deps, task, bundles, reopened)) return rememberThreads(deps, task, observations);
    if (feedbackUnchanged(workflow, bundles, reopened)) return "unchanged";
    const totalBytes = bundles.reduce((total, bundle) => total + prepareFeedbackBundle(task, bundle).bytes.byteLength, 0);
    if (totalBytes > FEEDBACK_INPUTS_MAX_BYTES) throw new Error("feedback bundle set exceeds its byte bound");
    const refs = [];
    for (const bundle of bundles) refs.push(await saveFeedbackBundle(deps.blobs, task, bundle));
    const now = new Date(deps.now()).toISOString();
    const next = collectWorkflowFeedbackBundles(workflow, { bundleRefs: refs, threadObservations: observations }, now);
    const update = workflowUpdateItem(task.taskId, next, workflow.revision, workflow);
    update.condition = when.and(update.condition!, when.eq("companyId", task.companyId));
    const committed = await deps.flow.store.transact([update, dispatchRowItem(deps.flow, task.taskId, next.revision, "REVIEW", now)]);
    return committed.applied ? "collected" : "retry";
  } catch (error) { return collectionFailure(error); }
}

function collectionFailure(error: unknown): "unchanged" | "retry" {
  if (error instanceof FeedbackHeadMoved) return "unchanged";
  if (hostRateLimitRetryAt(error) !== undefined) throw error;
  return "retry";
}
