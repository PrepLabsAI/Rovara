// Spec 061 slice 2: comments, replies and suggestions on a task page. Each is its own item in the task's partition
// (`DEVTASK#<taskId>`), never inside the task item, and every write is conditional: comments on `rev`, the comment counter
// on its cap, rate items on their window. The writer's name and owner flag come from the session and its role.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENTX_ANSWER_MAX_CHARS, AGENTX_ASK_RATE, ANSWER_STALE_MS, COMMENT_RATE, COMMENT_THREAD_REPLIES_MAX, NUDGE_WINDOW_MS, SlackPageCommentMessageSchema, TASK_COMMENT_ITEMS_MAX, TaskCommentSchema,
  TaskSuggestionSchema, agentXError, agentxAnswerCommentId, cleanCommentText, diffPlanDocuments, pageCommentAttributes, pageCommentEventId, pageCommentId,
  planClaimIds, plannerReplyCommentId, redactText, sharedTaskKey,
  type AgentXError, type AgentXErrorCode, type CommentAnswer, type CommentDocument, type CommentTarget, type PlanDocument, type TaskComment,
  type TaskSuggestion, type WorkflowDecisionDetail, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { isConditional } from "../aws/broker-shared.js";
import { plainName } from "../aws/task-web.js";
import { loadWorkflowDocument, type LoadedDocument } from "./plan-artifacts.js";
import { can, taskOpen, type TaskAccess } from "./task-access.js";
import type { DeveloperTaskRecord } from "./task-records.js";

type CommentDependencies = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "actions" | "now" | "log">;
type TableDependencies = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">;

/** Who is acting on the page: their access to the task, and the signed-in caller it was resolved for. */
export interface PageActor extends TaskAccess { caller: DeveloperCaller }

/** Why the page refused a comment, a reply, an edit or a suggestion; the API answers each with its sentence. */
export type PageRefusalReason =
  | "empty" | "too_long" | "slow_down" | "not_here" | "closed" | "thread_full" | "task_full" | "not_yours" | "locked" | "changed"
  | "gone" | "owners_answer" | "not_allowed";

const REFUSALS: Record<PageRefusalReason, { code: AgentXErrorCode; message: string }> = {
  empty: { code: "CONFIG_INVALID", message: "Write something first." },
  too_long: { code: "CONFIG_INVALID", message: "Keep comments under 2,000 characters." },
  slow_down: { code: "TASK_BUSY", message: "You've posted a lot in the last 10 minutes. Try again in a few minutes." },
  not_here: { code: "IDEMPOTENCY_CONFLICT", message: "This task changed. Refresh the page and try again." },
  closed: { code: "IDEMPOTENCY_CONFLICT", message: "This task is closed, so it takes no new comments." },
  thread_full: { code: "CONFIG_INVALID", message: "This thread has 20 replies, the most it can hold." },
  task_full: { code: "CONFIG_INVALID", message: "This task has 300 comments, the most it can hold." },
  not_yours: { code: "FORBIDDEN", message: "Only the person who wrote a comment can change it." },
  locked: { code: "IDEMPOTENCY_CONFLICT", message: "Sent with a decision, so it can't be changed." },
  changed: { code: "IDEMPOTENCY_CONFLICT", message: "This task changed. Refresh the page and try again." },
  gone: { code: "IDEMPOTENCY_CONFLICT", message: "This comment was deleted." },
  owners_answer: { code: "FORBIDDEN", message: "Owners answer decisions themselves; suggestions are for teammates." },
  not_allowed: { code: "FORBIDDEN", message: "You can read this task but not comment on it." },
};

export type PageRefusal = AgentXError & { pageReason: PageRefusalReason };

export function pageRefusal(reason: PageRefusalReason): PageRefusal {
  const { code, message } = REFUSALS[reason];
  return Object.assign(agentXError(code, message), { pageReason: reason });
}

export function isPageRefusal(error: unknown): error is PageRefusal {
  return error instanceof Error && typeof (error as Partial<PageRefusal>).pageReason === "string";
}

const log = (deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
const iso = (deps: Pick<DeveloperTaskRouteDependencies, "now">) => new Date(deps.now()).toISOString();

const partition = (taskId: string) => `DEVTASK#${taskId}`;
export const commentKey = (taskId: string, commentId: string) => ({ pk: partition(taskId), sk: `COMMENT#${commentId}` });
export const commentCounterKey = (taskId: string) => ({ pk: partition(taskId), sk: "COMMENTS" });
const suggestionKey = (taskId: string, document: CommentDocument, decisionId: string, developerId: string) =>
  ({ pk: partition(taskId), sk: `SUGGEST#${document}#${decisionId}#${developerId}` });
const rateKey = (taskId: string, kind: string, actor: string) => ({ pk: partition(taskId), sk: `RATE#${kind}#${actor}` });
const nudgeKey = (taskId: string, developerId: string) => ({ pk: partition(taskId), sk: `NUDGE#${developerId}` });

/** The stored fields that are not part of a comment, suggestion or decision detail. */
const STORE_FIELDS: ReadonlySet<string> = new Set(["pk", "sk", "entityType"]);
export function withoutKeys(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !STORE_FIELDS.has(key)));
}

async function getItem(deps: TableDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

async function getComment(deps: TableDependencies, taskId: string, commentId: string): Promise<TaskComment | undefined> {
  const item = await getItem(deps, commentKey(taskId, commentId));
  if (item === undefined) return undefined;
  const parsed = TaskCommentSchema.safeParse(withoutKeys(item));
  return parsed.success ? parsed.data : undefined;
}

/** Every item of the task whose sort key starts with `prefix`, read page by page (at most `max`). */
async function queryPrefix(deps: TableDependencies, taskId: string, prefix: string, max: number): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": partition(taskId), ":prefix": prefix }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
  } while (start !== undefined && items.length < max);
  return items.slice(0, max);
}

const byTime = (left: { createdAt: string; commentId: string }, right: { createdAt: string; commentId: string }) =>
  left.createdAt.localeCompare(right.createdAt) || left.commentId.localeCompare(right.commentId);

/** The task's comments, replies and AgentX replies, oldest first. An item that does not read as a comment is left out and logged. */
export async function listTaskComments(deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "log">, taskId: string): Promise<TaskComment[]> {
  const comments: TaskComment[] = [];
  for (const item of await queryPrefix(deps, taskId, "COMMENT#", TASK_COMMENT_ITEMS_MAX)) {
    const parsed = TaskCommentSchema.safeParse(withoutKeys(item));
    if (parsed.success) comments.push(parsed.data);
    else log(deps, { event: "developer.task_comment_unreadable", taskId });
  }
  return comments.sort(byTime);
}

/** Comments a decision on `document` may include: people's, not deleted, not already sent, on any version up to `uptoVersion`; oldest first. */
export function openCommentsFor(comments: readonly TaskComment[], document: CommentDocument, uptoVersion: number): TaskComment[] {
  return comments
    .filter((comment) => comment.author.kind === "person" && comment.deletedAt === undefined && comment.lockedBy === undefined
      && comment.document === document && comment.version <= uptoVersion)
    .sort(byTime);
}

/** The document the task's current planning step is about (while it is written or waiting for its owner), if any. */
export function currentStepDocument(workflow: WorkflowSnapshot | undefined): CommentDocument | undefined {
  if (workflow === undefined || (workflow.stage !== "PLAN" && workflow.stage !== "PLAN_REVIEW")) return undefined;
  return workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan" : workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : "design";
}

function latestVersion(workflow: WorkflowSnapshot | undefined, document: CommentDocument): number | undefined {
  return (workflow?.artifacts ?? []).filter((artifact) => artifact.type === document).reduce<number | undefined>((latest, artifact) =>
    latest === undefined || artifact.version > latest ? artifact.version : latest, undefined);
}

/** One version of a document, read from this task's own storage and checked against its digest; undefined when it cannot be. */
export async function loadDocumentVersion(
  deps: Pick<DeveloperTaskRouteDependencies, "actions">, task: DeveloperTaskRecord, document: CommentDocument, version: number,
): Promise<LoadedDocument | undefined> {
  const artifact = (task.workflow?.artifacts ?? []).find((item) => item.type === document && item.version === version);
  if (artifact === undefined || !artifact.objectKey.startsWith(`private/${task.ownerKey}/${task.workspaceId}/`)) return undefined;
  const read = async (objectKey: string, maxBytes: number) => {
    try {
      return await deps.actions.readArtifact(objectKey, maxBytes);
    } catch {
      return undefined;
    }
  };
  return loadWorkflowDocument(read, artifact, {});
}

/** Whether a version has the claim, decision or check a comment names; a Markdown document takes whole-document comments only. */
function targetExists(document: LoadedDocument, target: CommentTarget, task: DeveloperTaskRecord): boolean {
  if (target.kind === "document") return true;
  if (document.format !== "structured") return false;
  const plan = document.plan;
  switch (target.kind) {
    case "claim": return planClaimIds(plan).includes(target.id);
    case "decision": return plan.decisions.some((decision) => decision.id === target.id);
    case "check": {
      const policy = task.workflow?.checkPolicy;
      const ids = [...(plan.checks?.proposed ?? []), ...(policy?.required ?? []), ...(policy?.optional ?? [])].map((check) => check.id);
      return ids.includes(target.id);
    }
  }
}

/** The writer's name as comments show it: one line, redacted, at most 80 characters. */
function writerName(caller: DeveloperCaller): string {
  return plainName(caller.name) ?? "A teammate";
}

const cancellationCodes = (error: unknown): string[] =>
  ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((reason) => reason.Code ?? "None");

/**
 * Counts one more use of a fixed-window limit: true while fewer than `limit` uses fall in the current window. One item per
 * actor and kind, overwritten in place when a new window starts, so the items stay bounded without expiring.
 */
export async function takeRate(
  deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now">,
  key: { taskId: string; kind: "comment" | "suggestion" | "change" | "ask"; actor: string },
  limit: number,
  windowMs: number,
): Promise<boolean> {
  return takeRateAt(deps, rateKey(key.taskId, key.kind, key.actor), limit, windowMs);
}

/** `takeRate` for any rate item. */
async function takeRateAt(
  deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now">,
  Key: { pk: string; sk: string },
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const window = Math.floor(deps.now() / windowMs) * windowMs;
  const increment = async (): Promise<boolean> => {
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key, UpdateExpression: "SET #count = #count + :one",
        ConditionExpression: "windowStart = :window AND #count < :limit",
        ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":one": 1, ":window": window, ":limit": limit },
      }));
      return true;
    } catch (error) {
      if (!isConditional(error)) throw error;
      return false;
    }
  };
  if (await increment()) return true;
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key, UpdateExpression: "SET entityType = :type, windowStart = :window, #count = :one",
      ConditionExpression: "attribute_not_exists(windowStart) OR windowStart < :window",
      ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":type": "TASK_RATE", ":window": window, ":one": 1 },
    }));
    return true;
  } catch (error) {
    if (!isConditional(error)) throw error;
    // Another request started this window between the two writes: count this one in it, once.
    return increment();
  }
}

/**
 * Opens the writer's comment nudge window (FR-044), at most once per 10 minutes: the notifier posts one batched nudge per
 * window when it is due. Best effort: a failure is logged and never fails the comment.
 */
async function openNudgeWindow(deps: CommentDependencies, comment: TaskComment, name: string): Promise<void> {
  if (comment.author.kind !== "person") return;
  const now = deps.now();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: nudgeKey(comment.taskId, comment.author.developerId),
      UpdateExpression: "SET entityType = :type, taskId = :taskId, developerId = :developerId, #name = :name, windowStart = :now, nudgeId = :nudgeId, dueAt = :due",
      ConditionExpression: "attribute_not_exists(windowStart) OR windowStart <= :windowAgo",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: {
        ":type": "TASK_COMMENT_NUDGE", ":taskId": comment.taskId, ":developerId": comment.author.developerId, ":name": name,
        ":now": new Date(now).toISOString(), ":nudgeId": comment.commentId, ":due": new Date(now + NUDGE_WINDOW_MS).toISOString(),
        ":windowAgo": new Date(now - NUDGE_WINDOW_MS).toISOString(),
      },
    }));
  } catch (error) {
    if (!isConditional(error)) log(deps, { event: "developer.task_comment_nudge_failed", taskId: comment.taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

/** A counter update that adds one item: refused once the task holds 300. */
function counterAdd(deps: TableDependencies, taskId: string) {
  return {
    Update: {
      TableName: deps.tableName, Key: commentCounterKey(taskId),
      UpdateExpression: "SET entityType = :counterType, taskId = :taskId ADD #count :one, #seq :one",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#seq": "seq" },
      ExpressionAttributeValues: { ":counterType": "TASK_COMMENT_COUNTER", ":taskId": taskId, ":one": 1, ":max": TASK_COMMENT_ITEMS_MAX },
    },
  };
}

/** A counter update that tells the open pages something changed, without adding an item. */
export function counterTouch(deps: TableDependencies, taskId: string) {
  return {
    Update: {
      TableName: deps.tableName, Key: commentCounterKey(taskId),
      UpdateExpression: "SET entityType = :counterType, taskId = :taskId ADD #seq :one",
      ConditionExpression: "attribute_not_exists(#count) OR #count <= :max",
      ExpressionAttributeNames: { "#count": "count", "#seq": "seq" },
      ExpressionAttributeValues: { ":counterType": "TASK_COMMENT_COUNTER", ":taskId": taskId, ":one": 1, ":max": TASK_COMMENT_ITEMS_MAX },
    },
  };
}

/**
 * Posts a comment or a reply. A new comment goes only on the latest version of the document the current planning step is
 * about, and on a claim, decision or check that version has; a reply joins any thread while the task is open, and sits
 * on its parent's document, version and target. A resent request (same person, same request ID) returns the stored comment.
 */
export async function createTaskComment(
  deps: CommentDependencies,
  actor: PageActor,
  input: { requestId: string; document: CommentDocument; version: number; target: CommentTarget; parentId?: string; text: string; ask: boolean },
): Promise<{ comment: TaskComment; duplicate: boolean }> {
  const { task, caller } = actor;
  if (!can(actor.role, "comment")) throw pageRefusal("not_allowed");
  const commentId = pageCommentId(caller.developerId, input.requestId);
  const existing = await getComment(deps, task.taskId, commentId);
  if (existing !== undefined) return { comment: existing, duplicate: true };
  if (!taskOpen(task)) throw pageRefusal("closed");
  const cleaned = cleanCommentText(input.text);
  if (!cleaned.ok) throw pageRefusal(cleaned.reason);

  let place: { document: CommentDocument; version: number; target: CommentTarget };
  let parent: TaskComment | undefined;
  if (input.parentId !== undefined) {
    parent = await getComment(deps, task.taskId, input.parentId);
    if (parent === undefined || parent.author.kind !== "person" || parent.parentId !== undefined || parent.deletedAt !== undefined) throw pageRefusal("not_here");
    if ((parent.replyCount ?? 0) >= COMMENT_THREAD_REPLIES_MAX) throw pageRefusal("thread_full");
    place = { document: parent.document, version: parent.version, target: parent.target };
  } else {
    const document = currentStepDocument(task.workflow);
    if (document !== input.document || latestVersion(task.workflow, document) !== input.version) throw pageRefusal("not_here");
    const loaded = await loadDocumentVersion(deps, task, document, input.version);
    if (loaded === undefined || !targetExists(loaded, input.target, task)) throw pageRefusal("not_here");
    place = { document, version: input.version, target: input.target };
  }
  // A full task is said before any of the writer's limit is spent; the transaction checks the cap again.
  const stored = await getItem(deps, commentCounterKey(task.taskId));
  if (typeof stored?.count === "number" && stored.count >= TASK_COMMENT_ITEMS_MAX) throw pageRefusal("task_full");
  if (!await takeRate(deps, { taskId: task.taskId, kind: "comment", actor: caller.developerId }, COMMENT_RATE.comments, COMMENT_RATE.windowMs)) {
    throw pageRefusal("slow_down");
  }

  const name = writerName(caller);
  const comment = TaskCommentSchema.parse({
    schemaVersion: 1, taskId: task.taskId, commentId, ...(parent === undefined ? {} : { parentId: parent.commentId }), ...place,
    author: { kind: "person", developerId: caller.developerId, ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }), name, owner: actor.role === "owner" },
    text: cleaned.text, createdAt: iso(deps), rev: 1,
  });
  const items: unknown[] = [
    { Put: { TableName: deps.tableName, Item: { ...commentKey(task.taskId, commentId), entityType: "TASK_COMMENT", ...comment }, ConditionExpression: "attribute_not_exists(pk)" } },
    counterAdd(deps, task.taskId),
  ];
  if (parent !== undefined) {
    items.push({
      Update: {
        TableName: deps.tableName, Key: commentKey(task.taskId, parent.commentId), UpdateExpression: "ADD replyCount :one",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(parentId) AND attribute_not_exists(deletedAt) AND #author.#kind = :person AND (attribute_not_exists(replyCount) OR replyCount < :maxReplies)",
        ExpressionAttributeNames: { "#author": "author", "#kind": "kind" },
        ExpressionAttributeValues: { ":one": 1, ":person": "person", ":maxReplies": COMMENT_THREAD_REPLIES_MAX },
      },
    });
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items as never }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const codes = cancellationCodes(error);
      if (codes[0] === "ConditionalCheckFailed") {
        const raced = await getComment(deps, task.taskId, commentId);
        if (raced !== undefined) return { comment: raced, duplicate: true };
      }
      if (codes[1] === "ConditionalCheckFailed") throw pageRefusal("task_full");
      if (codes[2] === "ConditionalCheckFailed") {
        const now = parent === undefined ? undefined : await getComment(deps, task.taskId, parent.commentId);
        throw pageRefusal(now !== undefined && (now.replyCount ?? 0) >= COMMENT_THREAD_REPLIES_MAX ? "thread_full" : "not_here");
      }
    }
    throw error;
  }
  await openNudgeWindow(deps, comment, name);
  return { comment, duplicate: false };
}

/** The author's own comment, still theirs to change: not sent with a decision, not deleted, and at the revision they saw. */
async function changeableComment(deps: CommentDependencies, actor: PageActor, commentId: string, rev: number): Promise<TaskComment> {
  if (!can(actor.role, "comment")) throw pageRefusal("not_allowed");
  if (!taskOpen(actor.task)) throw pageRefusal("closed");
  const comment = await getComment(deps, actor.task.taskId, commentId);
  if (comment === undefined) throw pageRefusal("not_here");
  if (comment.author.kind !== "person" || comment.author.developerId !== actor.caller.developerId) throw pageRefusal("not_yours");
  if (comment.lockedBy !== undefined) throw pageRefusal("locked");
  if (comment.deletedAt !== undefined) throw pageRefusal("gone");
  if (comment.rev !== rev) throw pageRefusal("changed");
  // Edits and deletes are limited as new comments are: each one is a write every open page sees.
  if (!await takeRate(deps, { taskId: actor.task.taskId, kind: "change", actor: actor.caller.developerId }, COMMENT_RATE.changes, COMMENT_RATE.windowMs)) {
    throw pageRefusal("slow_down");
  }
  return comment;
}

/** Writes an edit or a delete conditioned on the revision the author saw; a lost race says what happened instead. */
async function writeChange(deps: CommentDependencies, actor: PageActor, comment: TaskComment, change: { set: string; values: Record<string, unknown> }): Promise<void> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.tableName, Key: commentKey(comment.taskId, comment.commentId),
            UpdateExpression: `SET ${change.set}, #rev = #rev + :one`,
            ConditionExpression: "#rev = :rev AND attribute_not_exists(lockedBy) AND attribute_not_exists(deletedAt) AND #author.#developerId = :me",
            ExpressionAttributeNames: { "#rev": "rev", "#author": "author", "#developerId": "developerId", "#text": "text" },
            ExpressionAttributeValues: { ...change.values, ":one": 1, ":rev": comment.rev, ":me": actor.caller.developerId },
          },
        },
        counterTouch(deps, comment.taskId),
      ] as never,
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const now = await getComment(deps, comment.taskId, comment.commentId);
      throw pageRefusal(now?.lockedBy !== undefined ? "locked" : now?.deletedAt !== undefined ? "gone" : "changed");
    }
    throw error;
  }
}

/** The author edits their comment's text (cleaned and redacted again); the comment's revision moves on. */
export async function editTaskComment(deps: CommentDependencies, actor: PageActor, input: { commentId: string; rev: number; text: string }): Promise<TaskComment> {
  const comment = await changeableComment(deps, actor, input.commentId, input.rev);
  const cleaned = cleanCommentText(input.text);
  if (!cleaned.ok) throw pageRefusal(cleaned.reason);
  const at = iso(deps);
  await writeChange(deps, actor, comment, { set: "#text = :text, editedAt = :at", values: { ":text": cleaned.text, ":at": at } });
  return TaskCommentSchema.parse({ ...comment, text: cleaned.text, editedAt: at, rev: comment.rev + 1 });
}

/** The author deletes their comment: its text is removed at once; who wrote it, when, and its place in the thread stay. */
export async function deleteTaskComment(deps: CommentDependencies, actor: PageActor, input: { commentId: string; rev: number }): Promise<TaskComment> {
  const comment = await changeableComment(deps, actor, input.commentId, input.rev);
  const at = iso(deps);
  await writeChange(deps, actor, comment, { set: "#text = :empty, deletedAt = :at", values: { ":empty": "", ":at": at } });
  return TaskCommentSchema.parse({ ...comment, text: "", deletedAt: at, rev: comment.rev + 1 });
}

/**
 * A teammate suggests one option on a decision of the current step's latest version, or (null) takes their suggestion
 * back. One per person per decision; only an owner's answer is ever recorded as the decision.
 */
export async function setSuggestion(deps: CommentDependencies, actor: PageActor, input: { document: CommentDocument; decisionId: string; optionId: string | null }): Promise<void> {
  const { task, caller } = actor;
  if (!can(actor.role, "suggest")) throw pageRefusal(actor.role === "owner" ? "owners_answer" : "not_allowed");
  if (!taskOpen(task)) throw pageRefusal("closed");
  const version = latestVersion(task.workflow, input.document);
  if (currentStepDocument(task.workflow) !== input.document || version === undefined) throw pageRefusal("not_here");
  const loaded = await loadDocumentVersion(deps, task, input.document, version);
  const decision = loaded?.format === "structured" ? loaded.plan.decisions.find((entry) => entry.id === input.decisionId) : undefined;
  if (loaded === undefined || decision === undefined || (input.optionId !== null && !decision.options.some((option) => option.id === input.optionId))) {
    throw pageRefusal("not_here");
  }
  if (!await takeRate(deps, { taskId: task.taskId, kind: "suggestion", actor: caller.developerId }, COMMENT_RATE.suggestions, COMMENT_RATE.windowMs)) {
    throw pageRefusal("slow_down");
  }
  const Key = suggestionKey(task.taskId, input.document, input.decisionId, caller.developerId);
  const existing = await getItem(deps, Key);
  const rev = typeof existing?.rev === "number" ? existing.rev : undefined;
  const guard = rev === undefined
    ? { ConditionExpression: "attribute_not_exists(pk)" }
    : { ConditionExpression: "#rev = :rev", ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": rev } };
  let write: unknown;
  if (input.optionId === null) {
    if (existing === undefined) return;
    write = { Delete: { TableName: deps.tableName, Key, ...guard } };
  } else {
    const suggestion = TaskSuggestionSchema.parse({
      document: input.document, decisionId: input.decisionId, developerId: caller.developerId, optionId: input.optionId, name: writerName(caller),
      artifactSha256: loaded.artifact.sha256, version, at: iso(deps), rev: (rev ?? 0) + 1,
    });
    write = { Put: { TableName: deps.tableName, Item: { ...Key, entityType: "TASK_SUGGESTION", ...suggestion }, ...guard } };
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [write, counterTouch(deps, task.taskId)] as never }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") throw pageRefusal("changed");
    throw error;
  }
}

/** Every suggestion on the task, as stored. */
export async function listSuggestions(deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "log">, taskId: string): Promise<TaskSuggestion[]> {
  const suggestions: TaskSuggestion[] = [];
  for (const item of await queryPrefix(deps, taskId, "SUGGEST#", 2_000)) {
    const parsed = TaskSuggestionSchema.safeParse(withoutKeys(item));
    if (parsed.success) suggestions.push(parsed.data);
    else log(deps, { event: "developer.task_suggestion_unreadable", taskId });
  }
  return suggestions.sort((left, right) => left.at.localeCompare(right.at) || left.developerId.localeCompare(right.developerId));
}

/**
 * The suggestions that still apply to `version` of a document: those made on it, and those made on an earlier version
 * whose decision did not change and whose option still exists.
 */
export function suggestionsFor(
  suggestions: readonly TaskSuggestion[],
  input: { document: CommentDocument; version: number; plan: PlanDocument; plans: ReadonlyMap<number, PlanDocument> },
): TaskSuggestion[] {
  return suggestions.filter((suggestion) => {
    if (suggestion.document !== input.document || suggestion.version > input.version) return false;
    const decision = input.plan.decisions.find((entry) => entry.id === suggestion.decisionId);
    if (decision === undefined || !decision.options.some((option) => option.id === suggestion.optionId)) return false;
    if (suggestion.version === input.version) return true;
    const earlier = input.plans.get(suggestion.version);
    if (earlier === undefined) return false;
    const diff = diffPlanDocuments(earlier, input.plan);
    return !diff.decisionsChanged.includes(decision.id) && !diff.decisionsAdded.includes(decision.id);
  });
}

/**
 * The planner's answers to the comments a Request changes or an Approve sent (refs c1, c2 and so on, in the decision's
 * order), written as replies from AgentX under each comment's thread, on the document the comment was made on. Each reply has an ID derived from the comment and the new version,
 * so a repeat finds it already there. Each one counts toward the task's 300 items; once the cap is reached the rest are
 * left out and logged (counts only, never text). A write that meets another in flight is tried once more; any other
 * failure skips that one reply (logged) and the rest are still written.
 */
export async function writePlannerReplies(
  deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now" | "log">,
  input: { taskId: string; artifactId: string; version: number; detail: WorkflowDecisionDetail; answers: readonly CommentAnswer[] },
): Promise<{ written: number }> {
  const { taskId } = input;
  let written = 0;
  for (const [index, answer] of input.answers.entries()) {
    const commentId = input.detail.includedCommentIds[Number(answer.ref.slice(1)) - 1];
    if (!/^c[1-9][0-9]*$/u.test(answer.ref) || commentId === undefined) continue;
    const comment = await getComment(deps, taskId, commentId);
    if (comment === undefined) continue;
    const reply = TaskCommentSchema.parse({
      schemaVersion: 1, taskId, commentId: plannerReplyCommentId(commentId, input.artifactId), parentId: comment.parentId ?? comment.commentId,
      document: comment.document, version: comment.version, target: comment.target,
      // Which document handled the comment, and the claim it cites, are worked out when the page is read (nothing more is stored).
      author: { kind: "agentx", source: "planner", outcome: answer.outcome, forVersion: input.version },
      text: answer.reason, createdAt: iso(deps), rev: 1,
    });
    const send = () => deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: deps.tableName, Item: { ...commentKey(taskId, reply.commentId), entityType: "TASK_COMMENT", ...reply }, ConditionExpression: "attribute_not_exists(pk)" } },
        counterAdd(deps, taskId),
      ] as never,
    }));
    // Best effort per entry: one reply that cannot be written is logged (names only, never text) and the rest go on.
    const outcome = await send().then(() => "written" as const, async (error: unknown) => {
      const codes = cancellationCodes(error);
      if (error instanceof Error && error.name === "TransactionCanceledException" && codes.includes("TransactionConflict")) {
        return send().then(() => "written" as const, (again: unknown) => classify(again));
      }
      return classify(error);
    }).catch((error: unknown) => {
      log(deps, { event: "developer.planner_reply_not_written", taskId, errorName: error instanceof Error ? error.name : "unknown" });
      return "skipped" as const;
    });
    if (outcome === "written") written += 1;
    if (outcome === "full") {
      log(deps, { event: "developer.planner_replies_full", taskId, written, skipped: input.answers.length - index });
      break;
    }
  }
  return { written };
}

/** What a failed planner reply write means: already written (a repeat), the task is full, or anything else (thrown). */
function classify(error: unknown): "duplicate" | "full" {
  if (error instanceof Error && error.name === "TransactionCanceledException") {
    const codes = cancellationCodes(error);
    if (codes[0] === "ConditionalCheckFailed") return "duplicate";
    if (codes[1] === "ConditionalCheckFailed") return "full";
  }
  throw error;
}

/** Where a page comment's question goes: the Slack service's request queue (FIFO). */
export interface SlackRequestQueue {
  send(message: { body: string; groupId: string; deduplicationId: string; attributes: Record<string, { DataType: "String"; StringValue: string }> }): Promise<void>;
}

type AskDependencies = CommentDependencies & { slackRequestQueue?: SlackRequestQueue | undefined };

/** Records what became of a question to AgentX on the comment, conditioned on the comment being the one the page wrote. */
async function setAsk(deps: CommentDependencies, comment: TaskComment, state: NonNullable<TaskComment["ask"]>["state"], expected?: NonNullable<TaskComment["ask"]>["state"]): Promise<TaskComment> {
  const ask = { state, at: iso(deps) };
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: deps.tableName, Key: commentKey(comment.taskId, comment.commentId),
          UpdateExpression: "SET #ask = :ask",
          ConditionExpression: expected === undefined ? "#rev = :rev AND attribute_not_exists(deletedAt)" : "#ask.#state = :expected",
          ExpressionAttributeNames: { "#ask": "ask", ...(expected === undefined ? { "#rev": "rev" } : { "#state": "state" }) },
          ExpressionAttributeValues: { ":ask": ask, ...(expected === undefined ? { ":rev": comment.rev } : { ":expected": expected }) },
        },
      },
      counterTouch(deps, comment.taskId),
    ] as never,
  }));
  return { ...comment, ask };
}

/**
 * "Ask AgentX to reply to this comment" (spec 061 slice 2): queues the comment's question for the Slack service, which answers it in
 * task mode with no tools and writes the answer back. Only for a task started in Slack (its own thread) when the queue is
 * set up; otherwise the comment says AgentX can answer only there. Limited per person (6 an hour), per task (20 an hour)
 * and per thread (5 AgentX answers); a limited ask leaves the comment as it is. A queue that refuses the message marks the
 * question failed; the comment always stands. Answers on one task run one at a time and never queue behind the thread.
 */
export async function queueCommentAnswer(
  deps: AskDependencies,
  input: { task: DeveloperTaskRecord; comment: TaskComment; caller: DeveloperCaller },
): Promise<{ outcome: "queued" | "limited" | "unavailable" | "failed"; comment: TaskComment }> {
  const { task, comment, caller } = input;
  let answering: TaskComment | undefined;
  try {
    const share = task.share;
    const userId = caller.slackUserId ?? task.slackUserId;
    const threadTs = share?.threadTs;
    const shared = share === undefined || threadTs === undefined ? undefined
      : await getItem(deps, sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs }));
    const startedInSlack = shared?.taskId === task.taskId && shared.workflowThread === true && shared.closedAt === undefined;
    const queue = deps.slackRequestQueue;
    if (queue === undefined || share === undefined || threadTs === undefined || !startedInSlack || userId === undefined || comment.author.kind !== "person") {
      return { outcome: "unavailable", comment: await setAsk(deps, comment, "unavailable") };
    }
    // The message is built (and checked) before anything is spent or marked.
    const message = SlackPageCommentMessageSchema.parse({
      version: 1, eventId: pageCommentEventId(comment.commentId), thread: { teamId: share.teamId, channelId: share.channelId, threadTs }, userId,
      text: comment.text, receivedAt: iso(deps), pageComment: { taskId: task.taskId, commentId: comment.commentId },
    });
    // The thread's limit first: AgentX's answers there and the questions still being answered (no limit is spent on a
    // refused ask). Then every hourly limit is checked before any of them is spent.
    const threadId = comment.parentId ?? comment.commentId;
    const inThread = (await listTaskComments(deps, task.taskId)).filter((item) => item.commentId !== comment.commentId && (item.parentId === threadId || item.commentId === threadId));
    // A question still "answering" past ANSWER_STALE_MS already shows as "couldn't answer", so it holds no place.
    const now = deps.now();
    const answers = inThread.filter((item) => (item.author.kind === "agentx" && item.author.source === "answer")
      || (item.ask?.state === "answering" && now - Date.parse(item.ask.at) <= ANSWER_STALE_MS));
    if (answers.length >= AGENTX_ASK_RATE.perThread) return { outcome: "limited", comment };
    const limits = [
      { key: rateKey(task.taskId, "ask", caller.developerId), limit: AGENTX_ASK_RATE.perPersonPerHour },
      { key: rateKey(task.taskId, "ask", "task"), limit: AGENTX_ASK_RATE.perTaskPerHour },
      { key: askRateAcrossTasksKey(caller.developerId), limit: AGENTX_ASK_RATE.perPersonAllTasksPerHour },
    ];
    for (const entry of limits) if (!await rateRoom(deps, entry.key, entry.limit, HOUR_MS)) return { outcome: "limited", comment };
    for (const entry of limits) if (!await takeRateAt(deps, entry.key, entry.limit, HOUR_MS)) return { outcome: "limited", comment };
    answering = await setAsk(deps, comment, "answering");
    await queue.send({
      body: JSON.stringify(message),
      groupId: createHash("sha256").update(`page-comment\0${task.taskId}`, "utf8").digest("hex"),
      deduplicationId: message.eventId,
      attributes: pageCommentAttributes(),
    });
    log(deps, { event: "developer.comment_answer_queued", taskId: task.taskId });
    return { outcome: "queued", comment: answering };
  } catch (error) {
    // The comment is posted whatever happens here: the question reads as not answered rather than waiting for ever.
    log(deps, { event: "developer.comment_answer_queue_failed", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
    const failed = answering === undefined
      ? await setAsk(deps, comment, "failed").catch(() => undefined)
      : await setAsk(deps, answering, "failed", "answering").catch(() => undefined);
    return { outcome: "failed", comment: failed ?? { ...comment, ask: { state: "failed", at: iso(deps) } } };
  }
}

/** The per-person limit on questions to AgentX over all of a person's tasks: its own item, outside any task. */
const askRateAcrossTasksKey = (developerId: string) => ({ pk: `ASKRATE#${developerId}`, sk: "RATE#ask" });

/** Counts one question to AgentX against `developerId`'s limit over all their tasks (30 an hour). */
export function takeAskRateAcrossTasks(deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now">, developerId: string): Promise<boolean> {
  return takeRateAt(deps, askRateAcrossTasksKey(developerId), AGENTX_ASK_RATE.perPersonAllTasksPerHour, HOUR_MS);
}

/** Whether a fixed-window limit has room for one more, without counting it. */
async function rateRoom(deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now">, Key: { pk: string; sk: string }, limit: number, windowMs: number): Promise<boolean> {
  const window = Math.floor(deps.now() / windowMs) * windowMs;
  const stored = await getItem(deps, Key);
  return stored === undefined || typeof stored.windowStart !== "number" || stored.windowStart < window || typeof stored.count !== "number" || stored.count < limit;
}

const HOUR_MS = 3_600_000;

/**
 * AgentX's answer to an asked comment, from the task's own thread identity (checked by the caller): ANSWERED writes
 * AgentX's reply under the comment's thread (redacted, at most 3,000 characters; it counts toward the task's 300 items)
 * and marks the question answered; FAILED marks it failed. Only a question still waiting takes an answer; a repeat of an
 * outcome already recorded answers the same and writes nothing.
 */
export async function writeCommentAnswer(
  deps: CommentDependencies,
  input: { taskId: string; commentId: string; outcome: "ANSWERED" | "FAILED"; text?: string },
): Promise<"answered" | "failed"> {
  const comment = await getComment(deps, input.taskId, input.commentId);
  if (comment === undefined || comment.author.kind !== "person" || comment.ask === undefined) throw pageRefusal("changed");
  const state = comment.ask.state;
  if (state === "answered" || state === "failed") return state;
  if (state === "skipped") return "failed";
  if (state !== "answering") throw pageRefusal("changed");
  // Deleted, or edited after it was asked: the answer would be to words no longer there, so it is not shown. An ask is only
  // ever set on a comment at rev 1, so any edit at all came after it; comparing editedAt with the ask's time would trust
  // two clocks to agree.
  if (comment.deletedAt !== undefined || comment.editedAt !== undefined) {
    await setAsk(deps, comment, "skipped", "answering");
    return "failed";
  }
  if (input.outcome === "FAILED") {
    await setAsk(deps, comment, "failed", "answering");
    return "failed";
  }
  // Model text: redacted, direction and control characters removed (line breaks kept), at most 3,000 characters.
  const text = Array.from(redactText(input.text ?? "").replace(/\r\n?/gu, "\n").replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu, "")
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/gu, " ").trim()).slice(0, AGENTX_ANSWER_MAX_CHARS).join("").trim();
  if (text === "") {
    await setAsk(deps, comment, "failed", "answering");
    return "failed";
  }
  const reply = TaskCommentSchema.parse({
    schemaVersion: 1, taskId: input.taskId, commentId: agentxAnswerCommentId(comment.commentId), parentId: comment.parentId ?? comment.commentId,
    document: comment.document, version: comment.version, target: comment.target, author: { kind: "agentx", source: "answer" },
    text, createdAt: iso(deps), rev: 1,
  });
  const ask = { state: "answered" as const, at: iso(deps) };
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: deps.tableName, Item: { ...commentKey(input.taskId, reply.commentId), entityType: "TASK_COMMENT", ...reply }, ConditionExpression: "attribute_not_exists(pk)" } },
        counterAdd(deps, input.taskId),
        {
          Update: {
            TableName: deps.tableName, Key: commentKey(input.taskId, comment.commentId), UpdateExpression: "SET #ask = :ask",
            // The comment as it was read: not deleted or edited since.
            ConditionExpression: "#ask.#state = :answering AND #rev = :rev AND attribute_not_exists(deletedAt)",
            ExpressionAttributeNames: { "#ask": "ask", "#state": "state", "#rev": "rev" },
            ExpressionAttributeValues: { ":ask": ask, ":answering": "answering", ":rev": comment.rev },
          },
        },
      ] as never,
    }));
  } catch (error) {
    const codes = cancellationCodes(error);
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const now = await getComment(deps, input.taskId, input.commentId);
      if (now?.ask?.state === "answered" || now?.ask?.state === "failed") return now.ask.state;
      if (now?.ask?.state === "skipped") return "failed";
      if (now !== undefined && now.ask?.state === "answering" && codes[2] === "ConditionalCheckFailed" && (now.deletedAt !== undefined || now.rev !== comment.rev)) {
        await setAsk(deps, now, "skipped", "answering");
        return "failed";
      }
      // The task holds 300 items: the answer cannot be kept, so the question reads as not answered.
      if (codes[1] === "ConditionalCheckFailed") {
        log(deps, { event: "developer.comment_answer_full", taskId: input.taskId });
        await setAsk(deps, comment, "failed", "answering");
        return "failed";
      }
    }
    throw error;
  }
  return "answered";
}
