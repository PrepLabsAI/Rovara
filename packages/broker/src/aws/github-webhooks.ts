import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { WorkflowFeedbackBundleSchema, WorkflowFeedbackBundleRefSchema, WorkflowSnapshotSchema, collectWorkflowFeedbackBundles, type WorkflowFeedbackBundle, type WorkflowFeedbackBundleRef, type WorkflowFeedbackThreadObservation, dismissDeletedWorkflowFeedback, observeWorkflowPullRequest, requestWorkflowFeedback, type WorkflowSnapshot } from "@agentx/contracts";
import { githubWorkflowPullRequestKey, type GithubWorkflowPullRequestRecord } from "../developer/task-records.js";
import { parseGitHubRepository, type GitHubPullRequestFeedback } from "../github-app.js";
import { isConditional } from "./broker-shared.js";

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GitHubWebhookPayloadSchema = z.object({
  action: z.string().min(1).max(80),
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300) }).passthrough(),
  issue: z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]).optional(), pull_request: z.object({ url: z.string().url() }).passthrough().optional() }).passthrough().optional(),
  pull_request: z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]).optional(), merged: z.boolean().optional() }).passthrough().optional(),
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
  if (task === undefined || workflow === undefined || workflow.candidate?.digest !== linked.candidateDigest
    || (workflow.stage !== "WAIT_FOR_MERGE" && workflow.stage !== "MERGED")
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

/** Re-fetches GitHub's current PR state and writes only to the linked task's current candidate. */
export async function reconcileGithubWorkflowPullRequest(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  repositoryFullName: string;
  number: number;
  loadTask(taskId: string): Promise<{ project: string; startingRevision: number; workflow?: WorkflowSnapshot } | undefined>;
  repositoryUrl(projectName: string, revision: number, repositoryId: string): Promise<string | undefined>;
  getCurrentState(repositoryUrl: string, number: number): Promise<"OPEN" | "CLOSED" | "MERGED">;
  saveWorkflow(taskId: string, expectedRevision: number, workflow: WorkflowSnapshot): Promise<void>;
  now: string;
}): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (linked === undefined) throw new GithubWebhookRefusal("GitHub pull request is not linked to an AgentX workflow");
  const task = await input.loadTask(linked.taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined || workflow.candidate?.digest !== linked.candidateDigest) {
    throw new GithubWebhookRefusal("linked workflow no longer matches the pull request candidate");
  }
  const repositoryUrl = await input.repositoryUrl(task.project, task.startingRevision, linked.repositoryId);
  if (repositoryUrl === undefined) throw new GithubWebhookRefusal("linked pull request repository is no longer in the pinned project revision");
  const state = await input.getCurrentState(repositoryUrl, linked.number);
  const prior = workflow.pullRequests?.find((pullRequest) => pullRequest.repositoryId === linked.repositoryId && pullRequest.number === linked.number);
  if (prior === undefined || prior.candidateDigest !== linked.candidateDigest) {
    throw new GithubWebhookRefusal("linked pull request is not part of the current workflow candidate");
  }
  if (prior.state === state) return false;
  const next = observeWorkflowPullRequest(workflow, {
    repositoryId: linked.repositoryId,
    number: linked.number,
    candidateDigest: linked.candidateDigest,
    state,
    source: "GITHUB_API",
    observedAt: input.now,
  }, input.now);
  await input.saveWorkflow(linked.taskId, workflow.revision, next);
  return true;
}

export interface ReconcileTaskPullRequestFeedbackInput {
  documentClient: { send(command: unknown): Promise<unknown> }; tableName: string;
  repositoryFullName: string; number: number; deliveryId: string;
  loadTask(taskId: string): Promise<{ project: string; startingRevision: number; workflow?: WorkflowSnapshot } | undefined>;
  repositoryUrl(project: string, revision: number, repositoryId: string): Promise<string | undefined>;
  getCurrentFeedback(repositoryUrl: string, number: number): Promise<GitHubPullRequestFeedback>;
  /** Writes exact payload bytes to immutable content-addressed storage; never overwrites an artifact. */
  persistBundle(bundle: WorkflowFeedbackBundle, bytes: string, sha256: string): Promise<string>;
  saveWorkflow(taskId: string, expectedRevision: number, workflow: WorkflowSnapshot): Promise<void>;
  now: string;
}

/** Event payloads are hints only. Recollect all linked PRs on every CAS retry. */
export async function reconcileTaskPullRequestFeedback(input: ReconcileTaskPullRequestFeedbackInput): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (!linked) throw new GithubWebhookRefusal("GitHub pull request is not linked to an AgentX workflow");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await input.loadTask(linked.taskId);
    const current = task?.workflow;
    if (!task || !current || current.candidate?.digest !== linked.candidateDigest
      || !current.pullRequests?.some(pr => pr.repositoryId === linked.repositoryId && pr.number === linked.number
        && pr.url === linked.url && pr.candidateDigest === linked.candidateDigest)
      || (current.stage !== "WAIT_FOR_MERGE" && current.stage !== "MERGED")) {
      throw new GithubWebhookRefusal("linked workflow no longer matches the PR candidate");
    }
    const reads: Array<{ pr: NonNullable<WorkflowSnapshot["pullRequests"]>[number]; feedback: GitHubPullRequestFeedback }> = [];
    for (const pr of [...(current.pullRequests ?? [])].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number)) {
      const url = await input.repositoryUrl(task.project, task.startingRevision, pr.repositoryId);
      if (!url) throw new GithubWebhookRefusal("linked PR repository is missing from the pinned project");
      const parsed = parseGitHubRepository(url);
      const fullName = `${parsed.owner}/${parsed.name}`;
      const index = await findLinkedGithubWorkflowPullRequest({ ...input, repositoryFullName: fullName, number: pr.number });
      if (!index || index.taskId !== linked.taskId || index.repositoryId !== pr.repositoryId
        || index.url !== pr.url || index.candidateDigest !== current.candidate.digest
        || pr.url !== `https://github.com/${fullName}/pull/${pr.number}`) throw new GithubWebhookRefusal("linked task PR scope mismatch");
      const feedback = await input.getCurrentFeedback(url, pr.number);
      if (feedback.pullRequest.number !== pr.number || feedback.pullRequest.url !== pr.url
        || feedback.comments.some(comment => !comment.url.startsWith(`${pr.url}#`))) throw new GithubWebhookRefusal("current GitHub feedback scope mismatch");
      reads.push({ pr, feedback });
    }
    let next = current;
    for (const { pr, feedback } of reads) {
      const state = feedback.pullRequest.state === "merged" ? "MERGED" : feedback.pullRequest.state === "closed" ? "CLOSED" : "OPEN";
      if (pr.state !== state) next = observeWorkflowPullRequest(next, { repositoryId: pr.repositoryId, number: pr.number,
        candidateDigest: pr.candidateDigest, state, source: "GITHUB_API", observedAt: input.now }, input.now);
    }
    const open = reads.filter(r => r.feedback.pullRequest.state === "open");
    const changedHead = open.some(({ pr, feedback }) => !current.candidate!.repositories.some(repo => repo.repositoryId === pr.repositoryId && repo.commitSha === feedback.pullRequest.headCommit));
    if (changedHead || open.length === 0) {
      if (!current.feedbackReview && !current.feedback && next === current
        && (!changedHead || current.state === "BLOCKED")) return false;
      const previousReport = current.feedbackReview?.reviewRef;
      const history = [...(current.feedbackReviewHistory ?? [])];
      if (previousReport && !history.some(r => r.sha256 === previousReport.sha256)) history.push(previousReport);
      next = WorkflowSnapshotSchema.parse({ ...next, revision: next.revision + 1,
        ...(changedHead ? { state: "BLOCKED", blockReason: "GitHub PR head changed; candidate verification and feedback review must be refreshed" } : {}),
        feedback: undefined, feedbackReview: undefined, feedbackReviewHistory: history, updatedAt: input.now });
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
          const prior = current.feedbackReview?.threadObservations?.find(t => t.repositoryId === pr.repositoryId && t.number === pr.number && t.threadId === thread.id);
          const ids = members.flatMap(comment => {
            if (!comment) return [];
            if (!thread.resolved) return [comment.id];
            // A resolved thread starts excluded. Once observed resolved, new/edited feedback remains eligible across retries.
            const previous = prior?.comments.find(c => c.id === comment.id);
            return prior?.resolved && (!previous || previous.updatedAt !== comment.updatedAt || previous.bodyDigest !== comment.bodyDigest
              || prior.eligibleCommentIds.includes(comment.id)) ? [comment.id] : [];
          });
          ids.forEach(id => eligible.add(id));
          observations.push({ repositoryId: pr.repositoryId, number: pr.number, threadId: thread.id, resolved: thread.resolved,
            comments: members.map(c => ({ id: c!.id, updatedAt: c!.updatedAt, bodyDigest: c!.bodyDigest })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), eligibleCommentIds: ids.sort() });
        }
        if (comments.some(c => c.kind === "REVIEW_COMMENT" && (!c.threadId || !threadIds.has(c.threadId)))) throw new GithubWebhookRetryableError("inline thread state is incomplete");
        // Approval authorizes future work. It does not establish that GitHub feedback was addressed.
        const selected = comments.filter(c => eligible.has(c.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        return WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId: current.taskId, repositoryId: pr.repositoryId, number: pr.number,
          headSha: feedback.pullRequest.headCommit, candidateDigest: current.candidate!.digest, commentSetDigest: digest(JSON.stringify(selected)),
          producer: "agentx-github-reconciler", version: "1", recordedAt: input.now, comments: selected, sourceDeliveryIds: [input.deliveryId] });
      });
      observations.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number || a.threadId.localeCompare(b.threadId));
      const prior = current.feedbackReview;
      const same = prior && prior.bundleRefs.length === bundles.length && bundles.every(b => prior.bundleRefs.some(p =>
        p.repositoryId === b.repositoryId && p.number === b.number && p.headSha === b.headSha && p.candidateDigest === b.candidateDigest && p.commentSetDigest === b.commentSetDigest));
      if (same && JSON.stringify(prior.threadObservations ?? []) === JSON.stringify(observations) && next === current) return false;
      const refs: WorkflowFeedbackBundleRef[] = [];
      for (const bundle of bundles) {
        const bytes = JSON.stringify(bundle); const sha256 = digest(bytes);
        const objectKey = await input.persistBundle(bundle, bytes, sha256);
        const { sourceDeliveryIds: _deliveryIds, comments, ...metadata } = bundle;
        refs.push(WorkflowFeedbackBundleRefSchema.parse({ ...metadata, sha256, objectKey, comments: comments.map(({ body: _body, ...ref }) => ref) }));
      }
      next = collectWorkflowFeedbackBundles(next, { bundleRefs: refs, threadObservations: observations }, input.now);
    }
    try { await input.saveWorkflow(linked.taskId, current.revision, next); return true; }
    catch (error) { if (!isConditional(error)) throw error; }
  }
  throw new GithubWebhookRetryableError("workflow kept changing during feedback reconciliation");
}
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** Persists linked PR comments as an owner decision; deliveries can never start implementation. */
export async function recordLinkedGithubWorkflowFeedback(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  repositoryFullName: string;
  number: number;
  action: string;
  comment: { id: number; body: string; url: string; author: string; updatedAt?: string; path?: string; line?: number; diffHunk?: string };
  proposedPlan?: string;
  loadWorkflow(taskId: string): Promise<WorkflowSnapshot | undefined>;
  now: string;
}): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (linked === undefined) throw new GithubWebhookRefusal("GitHub pull request is not linked to an AgentX workflow");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await input.loadWorkflow(linked.taskId);
    if (current === undefined || current.candidate?.digest !== linked.candidateDigest
      || !current.pullRequests?.some((pullRequest) => pullRequest.repositoryId === linked.repositoryId && pullRequest.number === linked.number
        && pullRequest.candidateDigest === linked.candidateDigest && pullRequest.state !== "MERGED")) {
      throw new GithubWebhookRefusal("linked PR feedback no longer matches an open task candidate");
    }
    let next: WorkflowSnapshot;
    if (input.action === "deleted") {
      next = dismissDeletedWorkflowFeedback(current, String(input.comment.id), input.now);
      if (next === current) return false;
    } else {
      const priorComments = current.feedback?.status === "PENDING" && current.feedback.repositoryId === linked.repositoryId
        && current.feedback.number === input.number && current.feedback.candidateDigest === linked.candidateDigest
        ? current.feedback.comments : [];
      const existing = priorComments.find((comment) => comment.id === String(input.comment.id));
      if (existing?.updatedAt !== undefined && input.comment.updatedAt !== undefined
        && Date.parse(input.comment.updatedAt) < Date.parse(existing.updatedAt)) return false;
      const comments = [...priorComments.filter((comment) => comment.id !== String(input.comment.id)), {
        id: String(input.comment.id), url: input.comment.url, author: input.comment.author, body: input.comment.body,
        ...(input.comment.updatedAt === undefined ? {} : { updatedAt: input.comment.updatedAt }),
      }].slice(-20);
      const feedbackId = createHash("sha256").update(JSON.stringify({
        taskId: linked.taskId, repositoryId: linked.repositoryId, number: input.number,
        candidateDigest: linked.candidateDigest, comments: [...comments].sort((left, right) => left.id.localeCompare(right.id)),
      })).digest("hex");
      if (current.feedback?.status === "PENDING" && current.feedback.feedbackId === feedbackId) return false;
      next = requestWorkflowFeedback(current, {
        feedbackId, repositoryId: linked.repositoryId, number: input.number, candidateDigest: linked.candidateDigest,
        comments,
        proposedPlan: input.proposedPlan ?? buildGithubFeedbackPlan(input.comment, []),
      }, input.now);
    }
    try {
      await input.documentClient.send(new UpdateCommand({
        TableName: input.tableName,
        Key: { pk: `DEVTASK#${linked.taskId}`, sk: "META" },
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":workflow": next, ":now": input.now, ":revision": current.revision },
      }));
      return true;
    } catch (error) {
      if (!isConditional(error)) throw error;
      // A distinct PR event advanced the workflow. Reload and merge this comment on the next pass.
    }
  }
  throw new GithubWebhookRetryableError("workflow kept changing while recording PR feedback; retry this GitHub delivery");
}

export function buildGithubFeedbackPlan(
  comment: { body: string; path?: string; line?: number; diffHunk?: string },
  changedFiles: ReadonlyArray<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>,
): string {
  const target = comment.path === undefined ? undefined : changedFiles.find((file) => file.filename === comment.path);
  const files = target === undefined ? changedFiles.slice(0, 8) : [target];
  const diff = target?.patch ?? comment.diffHunk;
  const safeBody = removeControlCharacters(comment.body).trim().slice(0, 500);
  const changed = files.length === 0 ? "No changed-file data was available; inspect the linked PR before choosing files." : files
    .map((file) => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`).join("\n");
  const excerpt = diff === undefined ? "The PR did not provide a diff excerpt for this comment." : `Relevant diff excerpt:\n\`\`\`diff\n${removeControlCharacters(diff).slice(0, 500)}\n\`\`\``;
  return `Proposed fix for owner review\n\nFeedback: ${safeBody || "(comment has no text)"}\nTarget: ${comment.path === undefined ? "review the changed files below" : `\`${comment.path}\`${comment.line === undefined ? "" : ` near line ${comment.line}`}`}\n\nCurrent PR diff files:\n${changed}\n\n${excerpt}\n\nAfter approval, inspect the surrounding code, make the smallest change that addresses the feedback, add or update a focused regression test, then rerun the project-required checks and candidate-bound reviews. AgentX will not reply on GitHub.`.slice(0, 1_900);
}

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
        ":processing": "PROCESSING", ":retryable": "RETRYABLE", ":dead": "DEAD", ":leaseToken": input.leaseToken, ":now": input.now,
        ...(terminal ? {} : { ":nextAttemptAt": nextAttemptAt, ":recoveryPk": GITHUB_WEBHOOK_RECOVERY_PK, ":recoverySk": `${nextAttemptAt}#${input.deliveryId}` }),
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
    throw new GithubWebhookRefusal("GitHub webhook signature is invalid");
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
