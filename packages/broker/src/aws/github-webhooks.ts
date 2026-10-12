import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { WORKFLOW_BLOCK_REASONS, WorkflowFeedbackBundleSchema, WorkflowFeedbackBundleCommentsSchema, WorkflowFeedbackBundleRefSchema, WorkflowSnapshotSchema, collectWorkflowFeedbackBundles, type WorkflowFeedbackBundle, type WorkflowFeedbackBundleRef, type WorkflowFeedbackThreadObservation, observeWorkflowPullRequest, observeWorkflowPullRequestMergedWithFix, recordWorkflowPullRequestHeadTrees, recordWorkflowPullRequestUpdate, workflowFollowsOnlyMerge, type WorkflowSnapshot } from "@agentx/contracts";
import { githubWorkflowPullRequestKey, type GithubWorkflowPullRequestRecord } from "../developer/task-records.js";
import { parseGitHubRepository, type GitHubPullRequestFeedback } from "../github-app.js";
import { isConditional } from "./broker-shared.js";
import { feedbackReopenedMeasure, type FeedbackReviewMeasure } from "../developer/feedback-review-measures.js";

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GitHubWebhookPayloadSchema = z.object({
  action: z.string().min(1).max(80),
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300) }).passthrough(),
  issue: z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]).optional(), pull_request: z.object({ url: z.string().url() }).passthrough().optional() }).passthrough().optional(),
  pull_request: z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]).optional(), merged: z.boolean().optional(),
    head: z.object({ sha: z.string() }).passthrough().optional() }).passthrough().optional(),
  review: z.object({ id: z.number().int().positive(), body: z.string().max(65_536).nullable().optional(), html_url: z.string().url(), updated_at: z.string().datetime().optional(), user: z.object({ login: z.string().min(1).max(100) }).passthrough() }).passthrough().optional(),
  comment: z.object({ id: z.number().int().positive(), body: z.string().max(65_536).nullable().optional(), html_url: z.string().url(), updated_at: z.string().datetime().optional(), path: z.string().max(500).optional(), line: z.number().int().positive().optional(), diff_hunk: z.string().max(8_000).optional(), user: z.object({ login: z.string().min(1).max(100) }).passthrough() }).passthrough().optional(),
}).passthrough();

const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "edited", "closed", "synchronize", "ready_for_review", "converted_to_draft"]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);
const MAX_REVIEW_COMMENT_CHARS = 8_000;
export const GITHUB_WEBHOOK_RECOVERY_INDEX = "github-webhook-recovery";
const GITHUB_WEBHOOK_RECOVERY_PK = "GITHUB_WEBHOOK_RECOVERY";
const MAX_WEBHOOK_ATTEMPTS = 8;

export const GITHUB_WEBHOOK_SIGNATURE_INVALID = "GitHub webhook signature is invalid";

export class GithubWebhookRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookRefusal";
  }
}

/** Transient delivery conflicts must receive a retryable response, not an authorization refusal. */
export class GithubWebhookRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookRetryableError";
  }
}

export interface ReceiveGithubWebhookInput {
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  authorizeRepository(scope: { installationId: number; repositoryId: number; fullName: string; pullRequestNumber: number }): Promise<boolean>;
  reserveDelivery(delivery: { deliveryId: string; installationId: number; repositoryId: number; eventHash: string; event: ReceivedGithubWebhook["event"] }): Promise<"reserved" | "retry" | "duplicate" | "conflict">;
}

export interface ReceivedGithubWebhook {
  delivery: "ACCEPTED" | "DUPLICATE";
  deliveryId: string;
  event: {
    kind: "PULL_REQUEST" | "PR_COMMENT";
    action: string;
    installationId: number;
    repositoryId: number;
    fullName: string;
    number: number;
    /** A push to the pull request (synchronize): the head GitHub says it now has. A hint, checked against GitHub's own read. */
    headSha?: string;
    comment?: { id: number; body: string; truncated: boolean; url: string; author: string; updatedAt?: string; path?: string; line?: number; diffHunk?: string; source: "review" | "review_comment" | "pr_discussion" };
  };
}

/** Looks up only an already-published PR; webhooks cannot associate arbitrary GitHub work with a task. */
export async function findLinkedGithubWorkflowPullRequest(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  repositoryFullName: string;
  number: number;
}): Promise<GithubWorkflowPullRequestRecord | undefined> {
  let key: ReturnType<typeof githubWorkflowPullRequestKey>;
  try {
    key = githubWorkflowPullRequestKey(input.repositoryFullName, input.number);
  } catch {
    return undefined;
  }
  const result = await input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = result.Item;
  if (item?.entityType !== "GITHUB_WORKFLOW_PR" || typeof item.repositoryFullName !== "string" || item.repositoryFullName.toLowerCase() !== input.repositoryFullName.toLowerCase()
    || item.number !== input.number || typeof item.repositoryId !== "string" || typeof item.taskId !== "string"
    || typeof item.workspaceId !== "string" || typeof item.candidateDigest !== "string" || typeof item.url !== "string") return undefined;
  return item as unknown as GithubWorkflowPullRequestRecord;
}

/** Requires the PR index, live workflow snapshot, pinned project repo and GitHub App identity to agree. */
export async function authorizeLinkedGithubWebhook(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  scope: { installationId: number; repositoryId: number; fullName: string; pullRequestNumber: number };
  loadTask(taskId: string): Promise<{ project: string; startingRevision: number; workflow?: {
    stage: string;
    state?: string | undefined;
    blockReason?: string | undefined;
    candidate?: { digest: string } | undefined;
    pullRequests?: Array<{ repositoryId: string; number: number; url: string; candidateDigest: string }> | undefined;
  } | undefined } | undefined>;
  repositoryUrl(projectName: string, revision: number, repositoryId: string): Promise<string | undefined>;
  verifyRepository(url: string, scope: { installationId: number; repositoryId: number; fullName: string }): Promise<boolean>;
}): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest({
    documentClient: input.documentClient,
    tableName: input.tableName,
    repositoryFullName: input.scope.fullName,
    number: input.scope.pullRequestNumber,
  });
  if (linked === undefined) return false;
  const task = await input.loadTask(linked.taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined || !tracksLinkedPullRequests(workflow)
    || !workflow.pullRequests?.some((pullRequest) => pullRequest.repositoryId === linked.repositoryId
      && pullRequest.number === linked.number && pullRequest.url === linked.url
      && pullRequest.candidateDigest === linked.candidateDigest)) return false;
  const repositoryUrl = await input.repositoryUrl(task.project, task.startingRevision, linked.repositoryId);
  if (repositoryUrl === undefined) return false;
  return input.verifyRepository(repositoryUrl, {
    installationId: input.scope.installationId,
    repositoryId: input.scope.repositoryId,
    fullName: input.scope.fullName,
  });
}

/**
 * Whether the task follows its linked pull requests: from the first one opened until the task closes, in every stage (an
 * approved fix being coded, checked, reviewed or pushed included). Each linked pull request is matched by the reviewed code
 * it was recorded with, so a merge of the head GitHub has is observed in every one of these.
 */
function tracksLinkedPullRequests(workflow: { stage: string; pullRequests?: readonly unknown[] | undefined }): boolean {
  return workflow.stage !== "CLOSED" && (workflow.pullRequests ?? []).length > 0;
}

/** An approved fix's push that was taken for failed but that GitHub shows landed on a linked pull request. */
export interface LandedFixPush {
  workspaceId: string; repositoryId: string; repositoryFullName: string; number: number; url: string;
  headSha: string; previousHeadSha: string; candidateDigest: string; previousCandidateDigest: string; state: "open";
}

export interface ReconcileTaskPullRequestFeedbackInput {
  documentClient: { send(command: unknown): Promise<unknown> }; tableName: string;
  repositoryFullName: string; number: number; deliveryId: string;
  /** Broker-local bounded polling mode; omitted callers retain the full feedback behavior. */
  observationMode?: "feedback" | "merge";
  /** The head a push event says the pull request now has (a hint): until GitHub's own read shows it, nothing is decided. */
  expectedHeadSha?: string;
  loadTask(taskId: string): Promise<{ project: string; startingRevision: number; closedAt?: string; workflow?: WorkflowSnapshot } | undefined>;
  repositoryUrl(project: string, revision: number, repositoryId: string): Promise<string | undefined>;
  getCurrentFeedback(repositoryUrl: string, number: number): Promise<GitHubPullRequestFeedback>;
  /** Writes exact payload bytes to immutable content-addressed storage; never overwrites an artifact. */
  persistBundle(bundle: WorkflowFeedbackBundle, bytes: string, sha256: string): Promise<string>;
  saveWorkflow(taskId: string, expectedRevision: number, workflow: WorkflowSnapshot): Promise<void>;
  /** The head AgentX last pushed to a pull request (its pull request record), when it has one. */
  recordedHead?(workspaceId: string, repositoryId: string, number: number): Promise<string | undefined>;
  /** A commit's parents, as GitHub says. */
  commitParents?(repositoryUrl: string, commit: string): Promise<string[]>;
  /**
   * The comments a completed review was given (each one's ID, edit time and body digest), read from its immutable
   * bundles; undefined when they cannot be read.
   */
  reviewedComments?(taskId: string, bundleDigests: readonly string[]): Promise<Array<{ id: string; updatedAt: string; bodyDigest: string }> | undefined>;
  /**
   * Saves the workflow with the fix pushes it records that were taken for failed but landed, together with each pull
   * request's link to the task (now naming the fix) and its pull request record (now at the landed head).
   */
  saveLandedPushes?(taskId: string, expectedRevision: number, workflow: WorkflowSnapshot, pushes: readonly LandedFixPush[]): Promise<void>;
  /** Aggregate-only telemetry callback; must not add task/comment/user context. */
  measure?(entry: FeedbackReviewMeasure): void;
  now: string;
}

/** How long after AgentX records a push GitHub's read may still show the head before it (it takes seconds; this is generous). */
export const GITHUB_HEAD_LAG_WINDOW_MS = 10 * 60_000;

/** Event payloads are hints only. Recollect all linked PRs on every CAS retry. */
export async function reconcileTaskPullRequestFeedback(input: ReconcileTaskPullRequestFeedbackInput): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (!linked) throw new GithubWebhookRefusal("GitHub pull request is not linked to an AgentX workflow");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await input.loadTask(linked.taskId);
    const current = task?.workflow;
    // A task whose pull requests all merged is complete, and a closed task no longer follows its pull requests: a later
    // event (a redelivered merge, a comment, a merge after the owner closed the task) changes nothing, so it is neither
    // recorded nor said, and is not retried.
    if (task?.closedAt !== undefined || (current?.stage === "MERGED" && current.state === "COMPLETE")) return false;
    if (!task || !current || !tracksLinkedPullRequests(current)
      || !current.pullRequests?.some(pr => pr.repositoryId === linked.repositoryId && pr.number === linked.number
        && pr.url === linked.url && pr.candidateDigest === linked.candidateDigest)) {
      throw new GithubWebhookRefusal("linked workflow no longer matches the PR candidate");
    }
    const reads: Array<{ pr: NonNullable<WorkflowSnapshot["pullRequests"]>[number]; feedback: GitHubPullRequestFeedback; url: string; fullName: string }> = [];
    for (const pr of [...(current.pullRequests ?? [])].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number)) {
      const url = await input.repositoryUrl(task.project, task.startingRevision, pr.repositoryId);
      if (!url) throw new GithubWebhookRefusal("linked PR repository is missing from the pinned project");
      const parsed = parseGitHubRepository(url);
      const fullName = `${parsed.owner}/${parsed.name}`;
      const index = await findLinkedGithubWorkflowPullRequest({ ...input, repositoryFullName: fullName, number: pr.number });
      if (!index || index.taskId !== linked.taskId || index.repositoryId !== pr.repositoryId
        || index.url !== pr.url || index.candidateDigest !== pr.candidateDigest
        || pr.url !== `https://github.com/${fullName}/pull/${pr.number}`) throw new GithubWebhookRefusal("linked task PR scope mismatch");
      const feedback = await input.getCurrentFeedback(url, pr.number);
      if (feedback.pullRequest.number !== pr.number || feedback.pullRequest.url !== pr.url
        || feedback.comments.some(comment => !comment.url.startsWith(`${pr.url}#`))) throw new GithubWebhookRefusal("current GitHub feedback scope mismatch");
      if (input.observationMode === "merge" && (feedback.comments.length !== 0 || feedback.threads.length !== 0)) {
        throw new GithubWebhookRefusal("merge observation contained feedback data");
      }
      reads.push({ pr, feedback, url, fullName });
    }
    if (input.observationMode === "merge") {
      const completePublishedSet = current.candidate !== undefined && current.candidate.repositories.every(repository =>
        current.pullRequests?.some(pr => pr.required && pr.repositoryId === repository.repositoryId));
      let next = current;
      for (const { pr, feedback } of reads) {
        const state = feedback.pullRequest.state === "merged" ? "MERGED" : feedback.pullRequest.state === "closed" ? "CLOSED" : "OPEN";
        const exactHead = pr.headSha !== undefined && pr.headSha === feedback.pullRequest.headCommit;
        const expectedTree = pr.headTreeSha ?? current.candidate?.repositories.find(repository => repository.repositoryId === pr.repositoryId)?.treeSha;
        const exactIdentity = exactHead && expectedTree !== undefined && expectedTree === feedback.pullRequest.headTreeSha;
        if ((state === "MERGED" && (!exactIdentity || !completePublishedSet)) || (state === "OPEN" && !exactIdentity)) continue;
        if (pr.state !== state) next = observeWorkflowPullRequest(next, { repositoryId: pr.repositoryId, number: pr.number,
          candidateDigest: pr.candidateDigest, state, source: "GITHUB_API", observedAt: input.now }, input.now);
      }
      if (next === current) return false;
      try {
        await input.saveWorkflow(linked.taskId, current.revision, next);
        return true;
      } catch (error) {
        if (!isConditional(error)) throw error;
        continue;
      }
    }
    // GitHub moves a pull request's head a moment after a push. A push event whose head GitHub's read does not show yet,
    // while the read shows the head AgentX recorded or the pushed commit's parent, is read again later (the recovery
    // sweep): someone else's push is never missed, and AgentX's own push is never taken for someone else's.
    const pushed = input.expectedHeadSha === undefined ? undefined
      : reads.find(read => read.pr.number === input.number && read.fullName.toLowerCase() === input.repositoryFullName.toLowerCase());
    if (pushed !== undefined && input.expectedHeadSha !== undefined && pushed.feedback.pullRequest.state === "open"
      && pushed.feedback.pullRequest.headCommit !== input.expectedHeadSha) {
      const shown = pushed.feedback.pullRequest.headCommit;
      const behind = shown === pushed.pr.headSha
        || (input.commitParents !== undefined && (await input.commitParents(pushed.url, input.expectedHeadSha).catch(() => [] as string[])).includes(shown));
      if (behind) throw new GithubWebhookRetryableError("GitHub has not caught up with the pull request's head yet");
    }
    // The same lag, with no push event to hint at it: any event (a comment, a review, an edit) read just after AgentX
    // recorded its own push may still see the head before it. When GitHub's head is exactly the only parent of the head
    // AgentX recorded, the event is read again later instead of being taken for someone else's change. This only defers.
    // Only for a while after AgentX recorded its push: past that, GitHub has long caught up, and a head at the commit before
    // AgentX's push is someone resetting the branch, which the usual rules then judge (never as AgentX's own push).
    const recordedAt = current.pullRequestUpdatedAt === undefined ? Number.NaN : Date.parse(current.pullRequestUpdatedAt);
    const lagWindow = Number.isFinite(recordedAt) && Date.parse(input.now) - recordedAt <= GITHUB_HEAD_LAG_WINDOW_MS;
    if (input.commitParents !== undefined && lagWindow) {
      for (const read of reads) {
        const shown = read.feedback.pullRequest.headCommit;
        if (read.feedback.pullRequest.state !== "open" || read.pr.headSha === undefined || shown === read.pr.headSha) continue;
        const parents = await input.commitParents(read.url, read.pr.headSha).catch(() => [] as string[]);
        if (parents.length === 1 && parents[0] === shown) throw new GithubWebhookRetryableError("GitHub has not caught up with the pull request's head yet");
      }
    }
    // The head AgentX recorded, holding the tree recorded with it (the checked tree, for a record that has none).
    const headMatchesCandidate = ({ pr, feedback }: Pick<typeof reads[number], "pr" | "feedback">): boolean => pr.headSha !== undefined
      && pr.headSha === feedback.pullRequest.headCommit
      && (pr.headTreeSha ?? current.candidate?.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha) === feedback.pullRequest.headTreeSha;
    const changedHead = reads.some(read => (read.feedback.pullRequest.state === "open" || read.feedback.pullRequest.state === "merged")
      && !headMatchesCandidate(read));
    // While an approved fix is made or pushed (its push moves the head), or after its push failed, only a merge is followed.
    const onlyMerge = workflowFollowsOnlyMerge(current);
    // Only a fix whose checks and reviews passed is pushed: while it is pushed, or after its push failed.
    const fixPushed = current.stage === "PULL_REQUEST" || (current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed);
    // A pull request an earlier release recorded without its head's tree learns it while the candidate is still the code it
    // was opened with: once an approved fix is coded, the candidate is the fix's.
    const headTrees = onlyMerge ? [] : reads.filter(read => read.pr.headTreeSha === undefined && read.pr.headSha !== undefined
      && read.pr.candidateDigest === current.candidate?.digest && headMatchesCandidate(read))
      .map(({ pr, feedback }) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.headSha!, headTreeSha: feedback.pullRequest.headTreeSha }));
    /**
     * Whether GitHub's head is the approved fix AgentX pushed, not yet recorded on the task (its result was late, lost, or
     * taken for failed): the head's tree is exactly the fix's reviewed tree, and the pull request's record names that head
     * or the head's only parent is the head the task recorded.
     */
    const landedFix = async ({ pr, feedback, url }: typeof reads[number]): Promise<boolean> => {
      const head = feedback.pullRequest.headCommit;
      const fixTree = current.candidate?.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha;
      if (!fixPushed || pr.headSha === undefined || pr.state === "MERGED" || pr.candidateDigest === current.candidate?.digest
        || fixTree === undefined || fixTree !== feedback.pullRequest.headTreeSha || head === pr.headSha || !/^[a-f0-9]{40}$/.test(head)) return false;
      if (await input.recordedHead?.(linked.workspaceId, pr.repositoryId, pr.number) === head) return true;
      try {
        return input.commitParents !== undefined && JSON.stringify(await input.commitParents(url, head)) === JSON.stringify([pr.headSha]);
      } catch {
        return false;
      }
    };
    // A task blocked because its fix's push was taken for failed records that push once GitHub shows it landed.
    const pushTakenForFailed = current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed;
    const landed: LandedFixPush[] = [];
    let next = current;
    for (const read of reads) {
      const { pr, feedback } = read;
      const state = feedback.pullRequest.state === "merged" ? "MERGED" : feedback.pullRequest.state === "closed" ? "CLOSED" : "OPEN";
      if (onlyMerge && state !== "MERGED") {
        if (state === "OPEN" && pushTakenForFailed && input.saveLandedPushes !== undefined && current.candidate !== undefined && await landedFix(read)) {
          landed.push({ workspaceId: linked.workspaceId, repositoryId: pr.repositoryId, repositoryFullName: read.fullName, number: pr.number, url: pr.url,
            headSha: feedback.pullRequest.headCommit, previousHeadSha: pr.headSha!, candidateDigest: current.candidate.digest,
            previousCandidateDigest: pr.candidateDigest, state: "open" });
        }
        continue;
      }
      // A merge only completes this candidate-bound task when the merged PR still points at its checked publication.
      // Keep mismatched merged PRs in their prior workflow state so the task cannot become terminally complete.
      if (state === "MERGED" && !headMatchesCandidate({ pr, feedback })) {
        // The one exception: GitHub merged the approved fix AgentX pushed before its push was recorded.
        if (onlyMerge && await landedFix(read)) {
          next = observeWorkflowPullRequestMergedWithFix(next, { repositoryId: pr.repositoryId, number: pr.number,
            headSha: feedback.pullRequest.headCommit, headTreeSha: feedback.pullRequest.headTreeSha, observedAt: input.now }, input.now);
        }
        continue;
      }
      if (pr.state !== state) next = observeWorkflowPullRequest(next, { repositoryId: pr.repositoryId, number: pr.number,
        candidateDigest: pr.candidateDigest, state, source: "GITHUB_API", observedAt: input.now }, input.now);
    }
    // Recorded as a push would have been: the task waits for the merge again once every pull request holds the fix.
    const recordedPushes = landed.length > 0 && next.stage === "WAIT_FOR_MERGE" && next.state === "BLOCKED" ? landed : [];
    if (recordedPushes.length > 0) {
      next = recordWorkflowPullRequestUpdate(next, { updates: recordedPushes.map(push => ({ repositoryId: push.repositoryId, number: push.number,
        headSha: push.headSha, headTreeSha: current.candidate!.repositories.find(repo => repo.repositoryId === push.repositoryId)!.treeSha })), now: input.now });
    }
    const open = reads.filter(r => r.feedback.pullRequest.state === "open");
    let reopenedFeedback = false;
    if (onlyMerge) {
      if (next === current) return false;
    } else if (changedHead || open.length === 0) {
      if (!current.feedbackReview && next === current
        && (!changedHead || current.state === "BLOCKED")) {
        if (headTrees.length === 0) return false;
      } else {
        const previousReport = current.feedbackReview?.reviewRef;
        const history = [...(current.feedbackReviewHistory ?? [])];
        if (previousReport && !history.some(r => r.sha256 === previousReport.sha256)) history.push(previousReport);
        next = WorkflowSnapshotSchema.parse({ ...next, revision: next.revision + 1,
          ...(changedHead ? { state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestChanged } : {}),
          feedbackReview: undefined, feedbackReviewHistory: history, updatedAt: input.now });
      }
    } else {
      const observations: WorkflowFeedbackThreadObservation[] = [];
      const bundles = open.map(({ pr, feedback }): WorkflowFeedbackBundle => {
        const comments = feedback.comments.map(c => ({ ...c, bodyDigest: digest(c.body), bodyBytes: Buffer.byteLength(c.body, "utf8") }));
        const eligible = new Set(comments.filter(c => c.kind !== "REVIEW_COMMENT").map(c => c.id));
        const threadIds = new Set<string>();
        for (const thread of feedback.threads) {
          if (threadIds.has(thread.id)) throw new GithubWebhookRetryableError("duplicate thread state");
          threadIds.add(thread.id);
          const members = thread.commentIds.map(id => comments.find(c => c.id === id && c.threadId === thread.id));
          if (members.some(c => c === undefined) || new Set(thread.commentIds).size !== thread.commentIds.length) throw new GithubWebhookRetryableError("thread comment state is incomplete");
          const prior = (current.feedbackReview?.threadObservations ?? (current.feedbackReview === undefined ? current.feedbackThreadObservations : undefined))?.find(t => t.repositoryId === pr.repositoryId && t.number === pr.number && t.threadId === thread.id);
          const ids = members.flatMap(comment => {
            if (!comment) return [];
            if (!thread.resolved) return [comment.id];
            // A resolved thread starts excluded. Once observed resolved, new/edited feedback remains eligible across retries.
            const previous = prior?.comments.find(c => c.id === comment.id);
            return prior?.resolved && (!previous || previous.updatedAt !== comment.updatedAt || previous.bodyDigest !== comment.bodyDigest
              || prior.eligibleCommentIds.includes(comment.id)) ? [comment.id] : [];
          });
          if (prior?.resolved && (!thread.resolved || ids.some(id => !prior.eligibleCommentIds.includes(id)))) reopenedFeedback = true;
          ids.forEach(id => eligible.add(id));
          observations.push({ repositoryId: pr.repositoryId, number: pr.number, threadId: thread.id, resolved: thread.resolved,
            comments: members.map(c => ({ id: c!.id, updatedAt: c!.updatedAt, bodyDigest: c!.bodyDigest })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), eligibleCommentIds: ids.sort() });
        }
        if (comments.some(c => c.kind === "REVIEW_COMMENT" && (!c.threadId || !threadIds.has(c.threadId)))) throw new GithubWebhookRetryableError("inline thread state is incomplete");
        // Approval authorizes future work. It does not establish that GitHub feedback was addressed.
        const selected = comments.filter(c => eligible.has(c.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const normalizedComments = WorkflowFeedbackBundleCommentsSchema.parse(selected);
        const normalized = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId: current.taskId, repositoryId: pr.repositoryId, number: pr.number,
          headSha: feedback.pullRequest.headCommit, headTreeSha: feedback.pullRequest.headTreeSha,
          candidateDigest: current.candidate!.digest, commentSetDigest: digest(JSON.stringify(normalizedComments)),
          producer: "agentx-github-reconciler", version: "1", recordedAt: input.now, comments: normalizedComments, sourceDeliveryIds: [input.deliveryId] });
        return WorkflowFeedbackBundleSchema.parse({ ...normalized, commentSetDigest: digest(JSON.stringify(normalized.comments)) });
      });
      observations.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number || a.threadId.localeCompare(b.threadId));
      const prior = current.feedbackReview;
      const same = prior && prior.bundleRefs.length === bundles.length && bundles.every(b => prior.bundleRefs.some(p =>
        p.repositoryId === b.repositoryId && p.number === b.number && p.headSha === b.headSha && p.headTreeSha === b.headTreeSha
        && p.candidateDigest === b.candidateDigest && p.commentSetDigest === b.commentSetDigest));
      // Unchanged content (comment set, heads, trees and threads) is never collected again: a new bundle would be recorded
      // under another digest only for its delivery ID and time, and an owner's decision bound to the old one would be stale.
      // No feedback yet and none now (an approval with no summary, a pull request marked ready): nothing to review or say.
      // Feedback only in resolved review threads is no feedback either: a resolved thread starts excluded.
      // The feedback a finished round already reviewed is not new either: once its approved fix is pushed, GitHub's event for
      // that push (or any later event before someone says something new) finds the same comments on the pull request.
      // "The same" is each comment's identity, words and edit time: an inline comment the fix outdated loses its line, and
      // a thread resolved after the fix leaves the set, without anything new having been said.
      const lastReviewed = current.feedbackReviewHistory?.at(-1);
      let alreadyReviewed = false;
      if (prior === undefined && lastReviewed?.status === "COMPLETE") {
        const reviewed = await input.reviewedComments?.(linked.taskId, lastReviewed.bundleDigests).catch(() => undefined);
        alreadyReviewed = reviewed !== undefined
          ? bundles.every(b => b.comments.every(c => reviewed.some(r => r.id === c.id && r.updatedAt === c.updatedAt && r.bodyDigest === c.bodyDigest)))
          : lastReviewed.candidateBindings.length === bundles.length && bundles.every(b => lastReviewed.candidateBindings.some(binding =>
            binding.repositoryId === b.repositoryId && binding.number === b.number && binding.commentSetDigest === b.commentSetDigest));
      }
      const nothingToReview = prior === undefined && (alreadyReviewed
        || (observations.every(o => o.eligibleCommentIds.length === 0) && bundles.every(b => b.comments.length === 0)));
      if (same && sameThreadObservations(prior.threadObservations ?? [], observations) && next === current) {
        if (headTrees.length === 0) return false;
      } else if (nothingToReview) {
        // Feedback only in resolved threads: nothing to review, but the threads are remembered as seen, so a later reply
        // in one of them is compared with what was there.
        if (observations.length > 0 && !sameThreadObservations(current.feedbackThreadObservations ?? [], observations)) {
          next = WorkflowSnapshotSchema.parse({ ...next, revision: next.revision + 1, feedbackThreadObservations: observations, updatedAt: input.now });
        }
        if (next === current && headTrees.length === 0) return false;
      } else {
        // A step is running (the review of earlier feedback): nothing can be collected now, so nothing is stored. The
        // delivery is kept, and the recovery sweep collects again once the step is done.
        if (current.state === "RUNNING") throw new GithubWebhookRetryableError("the task is running a step");
        const refs: WorkflowFeedbackBundleRef[] = [];
        for (const bundle of bundles) {
          const bytes = JSON.stringify(bundle); const sha256 = digest(bytes);
          const objectKey = await input.persistBundle(bundle, bytes, sha256);
          const { sourceDeliveryIds: deliveryIds, comments, ...metadata } = bundle;
          void deliveryIds;
          refs.push(WorkflowFeedbackBundleRefSchema.parse({ ...metadata, sha256, objectKey, comments: comments.map(({ body, ...ref }) => { void body; return ref; }) }));
        }
        next = collectWorkflowFeedbackBundles(next, { bundleRefs: refs, threadObservations: observations }, input.now);
        if (next.feedbackThreadObservations !== undefined) next = WorkflowSnapshotSchema.parse({ ...next, feedbackThreadObservations: undefined });
      }
    }
    if (headTrees.length > 0) next = recordWorkflowPullRequestHeadTrees(next, headTrees, input.now);
    try {
      if (recordedPushes.length > 0) await input.saveLandedPushes!(linked.taskId, current.revision, next, recordedPushes);
      else await input.saveWorkflow(linked.taskId, current.revision, next);
      if (reopenedFeedback) {
        const measure = feedbackReopenedMeasure(input.now);
        if (measure !== undefined) input.measure?.(measure);
      }
      return true;
    }
    catch (error) { if (!isConditional(error)) throw error; }
  }
  throw new GithubWebhookRetryableError("workflow kept changing during feedback reconciliation");
}

/** Re-fetches every linked PR at worker start and proves the saved approval still covers that exact snapshot. */
export async function verifyTaskPullRequestFeedbackCurrent(input: Pick<ReconcileTaskPullRequestFeedbackInput, "documentClient" | "tableName" | "loadTask" | "repositoryUrl" | "getCurrentFeedback" | "repositoryFullName" | "number">): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (!linked) return false;
  const task = await input.loadTask(linked.taskId);
  const workflow = task?.workflow;
  const approval = workflow?.feedbackDispatchApproval;
  const review = workflow?.feedbackReview;
  if (!task || !workflow || !approval || !review || review.status !== "APPROVED" || workflow.candidate?.digest !== approval.candidateDigest) return false;
  const prs = [...(workflow.pullRequests ?? [])].filter(pr => pr.state === "OPEN" || pr.state === "UNKNOWN")
    .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number);
  if (prs.length !== review.bundleRefs.length) return false;
  const observations: WorkflowFeedbackThreadObservation[] = [];
  for (const pr of prs) {
    const url = await input.repositoryUrl(task.project, task.startingRevision, pr.repositoryId);
    if (!url) return false;
    const fullName = (() => { const parsed = parseGitHubRepository(url); return `${parsed.owner}/${parsed.name}`; })();
    const index = await findLinkedGithubWorkflowPullRequest({ ...input, repositoryFullName: fullName, number: pr.number });
    if (!index || index.taskId !== linked.taskId || index.repositoryId !== pr.repositoryId || index.url !== pr.url || index.candidateDigest !== approval.candidateDigest) return false;
    const feedback = await input.getCurrentFeedback(url, pr.number);
    if (feedback.pullRequest.state !== "open" || feedback.pullRequest.headCommit !== pr.headSha
      || feedback.pullRequest.headTreeSha !== workflow.candidate.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha
      || feedback.pullRequest.url !== pr.url || feedback.comments.some(comment => !comment.url.startsWith(`${pr.url}#`))) return false;
    const comments = feedback.comments.map(comment => ({ ...comment, bodyDigest: digest(comment.body), bodyBytes: Buffer.byteLength(comment.body, "utf8") }));
    const eligible = new Set(comments.filter(comment => comment.kind !== "REVIEW_COMMENT").map(comment => comment.id));
    const seenThreads = new Set<string>();
    for (const thread of feedback.threads) {
      if (seenThreads.has(thread.id)) return false;
      seenThreads.add(thread.id);
      const members = thread.commentIds.map(id => comments.find(comment => comment.id === id && comment.threadId === thread.id));
      if (members.some(comment => comment === undefined) || new Set(thread.commentIds).size !== thread.commentIds.length) return false;
      const prior = review.threadObservations?.find(item => item.repositoryId === pr.repositoryId && item.number === pr.number && item.threadId === thread.id);
      const eligibleIds = members.flatMap(comment => {
        if (!comment) return [];
        if (!thread.resolved) return [comment.id];
        const previous = prior?.comments.find(item => item.id === comment.id);
        return prior?.resolved && (!previous || previous.updatedAt !== comment.updatedAt || previous.bodyDigest !== comment.bodyDigest
          || prior.eligibleCommentIds.includes(comment.id)) ? [comment.id] : [];
      }).sort();
      eligibleIds.forEach(id => eligible.add(id));
      observations.push({ repositoryId: pr.repositoryId, number: pr.number, threadId: thread.id, resolved: thread.resolved,
        comments: members.map(comment => ({ id: comment!.id, updatedAt: comment!.updatedAt, bodyDigest: comment!.bodyDigest })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), eligibleCommentIds: eligibleIds });
    }
    if (comments.some(comment => comment.kind === "REVIEW_COMMENT" && (!comment.threadId || !seenThreads.has(comment.threadId)))) return false;
    const selected = comments.filter(comment => eligible.has(comment.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const normalizedComments = WorkflowFeedbackBundleCommentsSchema.parse(selected);
    const ref = review.bundleRefs.find(bundle => bundle.repositoryId === pr.repositoryId && bundle.number === pr.number);
    if (!ref || ref.candidateDigest !== approval.candidateDigest || ref.headSha !== feedback.pullRequest.headCommit
      || ref.headTreeSha !== feedback.pullRequest.headTreeSha
      || ref.commentSetDigest !== digest(JSON.stringify(normalizedComments))) return false;
  }
  observations.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number || a.threadId.localeCompare(b.threadId));
  return sameThreadObservations(review.threadObservations ?? [], observations);
}

/**
 * Whether two thread observation lists hold the same content, compared field by field. A stored list is read back from
 * DynamoDB, which keeps no map's attribute order, so its JSON text differs from a freshly built list's even when every
 * value is the same.
 */
function sameThreadObservations(left: readonly WorkflowFeedbackThreadObservation[], right: readonly WorkflowFeedbackThreadObservation[]): boolean {
  const content = (observations: readonly WorkflowFeedbackThreadObservation[]) => JSON.stringify(observations.map(observation => [
    observation.repositoryId, observation.number, observation.threadId, observation.resolved,
    observation.comments.map(comment => [comment.id, comment.updatedAt, comment.bodyDigest]), observation.eligibleCommentIds,
  ]));
  return content(left) === content(right);
}
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function removeControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d || code === 0x7f ? " " : character;
  }).join("");
}

export async function reserveGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  eventHash: string;
  event: ReceivedGithubWebhook["event"];
  now: string;
}): Promise<"reserved" | "retry" | "duplicate" | "conflict"> {
  if (!DELIVERY_ID.test(input.deliveryId) || !/^[a-f0-9]{64}$/.test(input.eventHash)
    || !Number.isSafeInteger(input.installationId) || input.installationId < 1
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1) {
    throw new GithubWebhookRefusal("GitHub delivery identity is invalid");
  }
  const key = { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" };
  const record = {
    ...key,
    entityType: "GITHUB_WEBHOOK_DELIVERY",
    deliveryId: input.deliveryId,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    eventHash: input.eventHash,
    status: "RECEIVED",
    receivedAt: input.now,
    event: input.event,
    nextAttemptAt: input.now,
    webhookRecoveryPk: GITHUB_WEBHOOK_RECOVERY_PK,
    webhookRecoverySk: `${input.now}#${input.deliveryId}`,
  };
  try {
    await input.documentClient.send(new PutCommand({
      TableName: input.tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return "reserved";
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  const stored = await input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (stored.Item?.eventHash === input.eventHash
    && stored.Item?.installationId === input.installationId
    && stored.Item?.repositoryId === input.repositoryId) {
    return stored.Item.status === "COMPLETED" ? "duplicate" : "retry";
  }
  return "conflict";
}

/** Marks a delivery complete only after all of its task effects have been durably recorded. */
export async function completeGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
}): Promise<void> {
  if (!DELIVERY_ID.test(input.deliveryId) || !/^[0-9a-f-]{36}$/i.test(input.leaseToken) || !Number.isFinite(Date.parse(input.now))) {
    throw new GithubWebhookRefusal("GitHub delivery completion identity is invalid");
  }
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: "SET #status = :completed, completedAt = :now REMOVE leaseToken, leaseExpiresAt, webhookRecoveryPk, webhookRecoverySk, nextAttemptAt",
      ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": "PROCESSING", ":leaseToken": input.leaseToken, ":completed": "COMPLETED", ":now": input.now },
    }));
  } catch (error) {
    if (isConditional(error)) throw new GithubWebhookRefusal("GitHub delivery is missing or already complete");
    throw error;
  }
}

/** Claims a received/retryable delivery, or recovers a worker whose processing lease expired. */
export async function claimGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
  leaseMs?: number;
}): Promise<boolean> {
  const leaseMs = input.leaseMs ?? 60_000;
  const now = Date.parse(input.now);
  if (!DELIVERY_ID.test(input.deliveryId) || !/^[0-9a-f-]{36}$/i.test(input.leaseToken)
    || !Number.isFinite(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw new GithubWebhookRefusal("GitHub delivery claim identity is invalid");
  }
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: "SET #status = :processing, leaseToken = :leaseToken, leaseExpiresAt = :leaseExpiresAt, webhookRecoveryPk = :recoveryPk, webhookRecoverySk = :recoverySk, updatedAt = :now REMOVE nextAttemptAt ADD attempts :one",
      ConditionExpression: "((#status = :received OR #status = :retryable) AND (attribute_not_exists(nextAttemptAt) OR nextAttemptAt <= :now)) OR (#status = :processing AND leaseExpiresAt <= :now)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":processing": "PROCESSING", ":received": "RECEIVED", ":retryable": "RETRYABLE", ":leaseToken": input.leaseToken,
        ":leaseExpiresAt": new Date(now + leaseMs).toISOString(), ":now": input.now, ":one": 1,
        ":recoveryPk": GITHUB_WEBHOOK_RECOVERY_PK,
        ":recoverySk": `${new Date(now + leaseMs).toISOString()}#${input.deliveryId}`,
      },
    }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Releases an owned claim for durable retry; stale workers cannot overwrite a newer claim. */
export async function retryGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
}): Promise<void> {
  const existing = await input.documentClient.send(new GetCommand({
    TableName: input.tableName,
    Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
    ConsistentRead: true,
  })) as { Item?: { attempts?: number } };
  const attempts = typeof existing.Item?.attempts === "number" ? existing.Item.attempts : 1;
  const terminal = attempts >= MAX_WEBHOOK_ATTEMPTS;
  const delayMs = Math.min(60_000 * (2 ** Math.max(0, attempts - 1)), 60 * 60_000);
  const nextAttemptAt = new Date(Date.parse(input.now) + delayMs).toISOString();
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: terminal
        ? "SET #status = :dead, updatedAt = :now REMOVE leaseToken, leaseExpiresAt, webhookRecoveryPk, webhookRecoverySk, nextAttemptAt"
        : "SET #status = :retryable, updatedAt = :now, nextAttemptAt = :nextAttemptAt, webhookRecoveryPk = :recoveryPk, webhookRecoverySk = :recoverySk REMOVE leaseToken, leaseExpiresAt",
      ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        // DynamoDB refuses a request that carries a value no expression uses, so each branch sends only its own.
        ":processing": "PROCESSING", ":leaseToken": input.leaseToken, ":now": input.now,
        ...(terminal
          ? { ":dead": "DEAD" }
          : { ":retryable": "RETRYABLE", ":nextAttemptAt": nextAttemptAt, ":recoveryPk": GITHUB_WEBHOOK_RECOVERY_PK, ":recoverySk": `${nextAttemptAt}#${input.deliveryId}` }),
      },
    }));
  } catch (error) {
    if (isConditional(error)) throw new GithubWebhookRefusal("GitHub delivery claim is no longer owned by this worker");
    throw error;
  }
}

/** Permanently refused events leave the retry index; transient failures use the backoff path. */
export async function rejectGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
}): Promise<void> {
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: "SET #status = :dead, updatedAt = :now REMOVE leaseToken, leaseExpiresAt, webhookRecoveryPk, webhookRecoverySk, nextAttemptAt",
      ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": "PROCESSING", ":dead": "DEAD", ":leaseToken": input.leaseToken, ":now": input.now },
    }));
  } catch (error) {
    if (isConditional(error)) throw new GithubWebhookRefusal("GitHub delivery claim is no longer owned by this worker");
    throw error;
  }
}

/** Reads only due delivery rows through the sparse recovery index. */
export async function listDueGithubWebhookDeliveries(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: string;
  limit?: number;
}): Promise<Array<{ deliveryId: string; event: ReceivedGithubWebhook["event"] }>> {
  const response = await input.documentClient.send(new QueryCommand({
    TableName: input.tableName,
    IndexName: GITHUB_WEBHOOK_RECOVERY_INDEX,
    KeyConditionExpression: "webhookRecoveryPk = :pk AND webhookRecoverySk <= :sk",
    ExpressionAttributeValues: { ":pk": GITHUB_WEBHOOK_RECOVERY_PK, ":sk": `${input.now}#~` },
    Limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
  })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).flatMap((item) => typeof item.deliveryId === "string" && item.event !== undefined
    && item.status !== "COMPLETED" && item.status !== "DEAD"
    ? [{ deliveryId: item.deliveryId, event: item.event as ReceivedGithubWebhook["event"] }]
    : []);
}

/** Processes one reserved event under a lease; provider failure leaves a durable retry state. */
export async function processGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  received: ReceivedGithubWebhook;
  process(event: ReceivedGithubWebhook["event"], deliveryId: string): Promise<void>;
  now(): string;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<"PROCESSED" | "DUPLICATE" | "IN_PROGRESS"> {
  if (input.received.delivery === "DUPLICATE") return "DUPLICATE";
  const leaseToken = randomUUID();
  const claimAt = input.now();
  const claimed = await claimGithubWebhookDelivery({
    documentClient: input.documentClient,
    tableName: input.tableName,
    deliveryId: input.received.deliveryId,
    leaseToken,
    now: claimAt,
  });
  if (!claimed) return "IN_PROGRESS";
  try {
    await input.process(input.received.event, input.received.deliveryId);
    await completeGithubWebhookDelivery({
      documentClient: input.documentClient,
      tableName: input.tableName,
      deliveryId: input.received.deliveryId,
      leaseToken,
      now: input.now(),
    });
    return "PROCESSED";
  } catch (error) {
    // Record the cause first so a failure while saving the delivery's state cannot hide it. Name and code only:
    // messages can carry request or response text.
    const log = input.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
    const code = (error as { code?: unknown } | null)?.code;
    log({
      event: "github_webhook.delivery_failed",
      deliveryId: input.received.deliveryId,
      error: error instanceof Error ? error.name : "unknown",
      ...(typeof code === "string" ? { code } : {}),
      outcome: error instanceof GithubWebhookRefusal ? "rejected" : "retry",
    });
    if (error instanceof GithubWebhookRefusal) {
      await rejectGithubWebhookDelivery({ documentClient: input.documentClient, tableName: input.tableName, deliveryId: input.received.deliveryId, leaseToken, now: input.now() });
    } else {
      await retryGithubWebhookDelivery({ documentClient: input.documentClient, tableName: input.tableName, deliveryId: input.received.deliveryId, leaseToken, now: input.now() });
    }
    throw error;
  }
}

/** Shared endpoint path: verify, durably reserve, claim, process, then record the outcome. */
export async function handleGithubWebhook(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  authorizeRepository: ReceiveGithubWebhookInput["authorizeRepository"];
  process(event: ReceivedGithubWebhook["event"], deliveryId: string): Promise<void>;
  now(): string;
}): Promise<{ status: "ACCEPTED" | "DUPLICATE" | "IN_PROGRESS"; deliveryId: string }> {
  const received = await receiveGithubWebhook({
    rawBody: input.rawBody,
    headers: input.headers,
    secret: input.secret,
    authorizeRepository: input.authorizeRepository,
    reserveDelivery: (delivery) => reserveGithubWebhookDelivery({
      documentClient: input.documentClient,
      tableName: input.tableName,
      ...delivery,
      now: input.now(),
    }),
  });
  const processed = await processGithubWebhookDelivery({
    documentClient: input.documentClient,
    tableName: input.tableName,
    received,
    process: (event, deliveryId) => input.process(event, deliveryId),
    now: () => input.now(),
  });
  return {
    status: processed === "PROCESSED" ? "ACCEPTED" : processed,
    deliveryId: received.deliveryId,
  };
}

/** Validates GitHub's X-Hub-Signature-256 over the unchanged UTF-8 request body. */
export function verifyGithubWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) return false;
  const supplied = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Verifies provider signature, event shape and configured repository scope before reserving a delivery. */
export async function receiveGithubWebhook(input: ReceiveGithubWebhookInput): Promise<ReceivedGithubWebhook> {
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_048_576) throw new GithubWebhookRefusal("GitHub webhook payload exceeds the size limit");
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!verifyGithubWebhookSignature(input.rawBody, headers["x-hub-signature-256"], input.secret)) {
    throw new GithubWebhookRefusal(GITHUB_WEBHOOK_SIGNATURE_INVALID);
  }
  const deliveryId = headers["x-github-delivery"];
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw new GithubWebhookRefusal("GitHub webhook delivery ID is invalid");
  const eventName = headers["x-github-event"];
  if (eventName !== "pull_request" && eventName !== "pull_request_review" && eventName !== "pull_request_review_comment" && eventName !== "issue_comment") {
    throw new GithubWebhookRefusal("GitHub webhook event type is unsupported");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new GithubWebhookRefusal("GitHub webhook JSON body is invalid");
  }
  const parsed = GitHubWebhookPayloadSchema.safeParse(raw);
  const object = parsed.success ? parsed.data : undefined;
  if (object === undefined) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  let number: number;
  let comment: ReceivedGithubWebhook["event"]["comment"];
  if (eventName === "pull_request" && object.pull_request !== undefined && PULL_REQUEST_ACTIONS.has(object.action)) {
    number = object.pull_request.number;
  } else if (eventName === "pull_request_review" && object.pull_request !== undefined && object.review !== undefined && REVIEW_ACTIONS.has(object.action)) {
    number = object.pull_request.number;
    comment = toComment(object.review, "review");
  } else if (eventName === "pull_request_review_comment" && object.pull_request !== undefined && object.comment !== undefined && COMMENT_ACTIONS.has(object.action)) {
    number = object.pull_request.number;
    comment = toComment(object.comment, "review_comment");
  } else if (eventName === "issue_comment" && object.issue?.pull_request !== undefined && object.comment !== undefined && COMMENT_ACTIONS.has(object.action)) {
    number = object.issue.number;
    comment = toComment(object.comment, "pr_discussion");
  } else {
    throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  }
  const scope = {
    installationId: object.installation.id,
    repositoryId: object.repository.id,
    fullName: object.repository.full_name.toLowerCase(),
    pullRequestNumber: number,
  };
  if (!await input.authorizeRepository(scope)) throw new GithubWebhookRefusal("GitHub webhook repository is outside the registered installation and repository scope");
  const event: ReceivedGithubWebhook["event"] = {
    kind: comment === undefined ? "PULL_REQUEST" : "PR_COMMENT",
    action: object.action,
    installationId: scope.installationId,
    repositoryId: scope.repositoryId,
    fullName: scope.fullName,
    number,
    ...(eventName === "pull_request" && object.action === "synchronize" && /^[a-f0-9]{40}$/.test(object.pull_request?.head?.sha ?? "") ? { headSha: object.pull_request!.head!.sha } : {}),
    ...(comment === undefined ? {} : { comment }),
  };
  const reserved = await input.reserveDelivery({
    deliveryId,
    ...scope,
    // GitHub signs the body, not X-GitHub-Event; bind the unsigned dispatch header into the
    // idempotency identity so a reused delivery cannot be reinterpreted as another event type.
    eventHash: createHash("sha256").update(eventName, "utf8").update("\0").update(input.rawBody, "utf8").digest("hex"),
    event,
  });
  if (reserved === "conflict") throw new GithubWebhookRefusal("GitHub delivery ID was reused with different content");
  return {
    delivery: reserved === "duplicate" ? "DUPLICATE" : "ACCEPTED",
    deliveryId,
    event,
  };
}

function toComment(input: { id: number; body?: string | null | undefined; html_url: string; updated_at?: string | undefined; path?: string | undefined; line?: number | undefined; diff_hunk?: string | undefined; user: { login: string } }, source: NonNullable<ReceivedGithubWebhook["event"]["comment"]>["source"]): NonNullable<ReceivedGithubWebhook["event"]["comment"]> {
  let url: URL;
  try {
    url = new URL(input.html_url);
  } catch {
    throw new GithubWebhookRefusal("GitHub PR comment URL is invalid");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username !== "" || url.password !== "") {
    throw new GithubWebhookRefusal("GitHub PR comment URL is outside the GitHub web origin");
  }
  const body = removeControlCharacters(input.body ?? "");
  return {
    id: input.id,
    body: body.slice(0, MAX_REVIEW_COMMENT_CHARS),
    truncated: body.length > MAX_REVIEW_COMMENT_CHARS,
    url: url.toString(),
    author: input.user.login,
    ...(input.updated_at === undefined ? {} : { updatedAt: input.updated_at }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.line === undefined ? {} : { line: input.line }),
    ...(input.diff_hunk === undefined ? {} : { diffHunk: input.diff_hunk.slice(0, 4_000) }),
    source,
  };
}
