// Spec 061 slice 2: comments, replies and suggestions on a task page. Each is its own item in the task's partition
// (`DEVTASK#<taskId>`), never inside the task item, and every write is conditional: comments on `rev`, the comment counter
// on its cap, rate items on their window. The writer's name and owner flag come from the session and its role.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_ANSWER_MAX_CHARS, AGENTX_ASK_RATE, COMMENT_RATE, COMMENT_THREAD_REPLIES_MAX, NUDGE_WINDOW_MS, TASK_COMMENT_ITEMS_MAX, TaskCommentSchema, agentXError, agentxAnswerCommentId, cleanCommentText, pageCommentId, planClaimIds, redactText, type AgentXError, type AgentXErrorCode, type CommentDocument, type CommentTarget, type TaskComment, type WorkflowSnapshot } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { isConditional } from "../aws/broker-shared.js";
import { plainName } from "./plain-name.js";
import { loadWorkflowDocument, type LoadedDocument } from "./plan-document-reader.js";
import { can, taskOpen, type TaskAccess } from "./task-access.js";
import { taskAccessFence } from "./task-people.js";
import { taskKey, type DeveloperTaskRecord } from "./task-records.js";

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
const rateKey = (taskId: string, kind: string, actor: string) => ({ pk: partition(taskId), sk: `RATE#${kind}#${actor}` });
const nudgeKey = (taskId: string, developerId: string) => ({ pk: partition(taskId), sk: `NUDGE#${developerId}` });

/** The page document and lifecycle read by a human write must still be the current open task. */
function taskPageFence(tableName: string, task: DeveloperTaskRecord) {
  const workflow = task.workflow;
  return workflow === undefined
    ? { ConditionCheck: { TableName: tableName, Key: taskKey(task.taskId), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(workflow)" } }
    : { ConditionCheck: {
      TableName: tableName, Key: taskKey(task.taskId),
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":revision": workflow.revision, ":stage": workflow.stage, ":state": workflow.state },
    } };
}

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
  key: { taskId: string; kind: "comment" | "suggestion" | "change" | "ask" | "steer"; actor: string },
  limit: number,
  windowMs: number,
  access?: Pick<TaskAccess, "peopleRevision" | "task">,
): Promise<boolean> {
  return takeRateAt(deps, rateKey(key.taskId, key.kind, key.actor), limit, windowMs,
    access === undefined ? undefined : { task: access.task, ...(access.peopleRevision === undefined ? {} : { peopleRevision: access.peopleRevision }) });
}

/** `takeRate` for any rate item. */
async function takeRateAt(
  deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now">,
  Key: { pk: string; sk: string },
  limit: number,
  windowMs: number,
  access?: { task: DeveloperTaskRecord; peopleRevision?: number },
): Promise<boolean> {
  const window = Math.floor(deps.now() / windowMs) * windowMs;
  const write = async (Update: Record<string, unknown>): Promise<void> => {
    if (access === undefined) {
      await deps.documentClient.send(new UpdateCommand(Update as never));
      return;
    }
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [{ Update }, taskPageFence(deps.tableName, access.task), taskAccessFence(deps.tableName, access.task.taskId, access.peopleRevision)] as never,
    }));
  };
  const increment = async (): Promise<boolean> => {
    try {
      await write({
        TableName: deps.tableName, Key, UpdateExpression: "SET #count = #count + :one",
        ConditionExpression: "windowStart = :window AND #count < :limit",
        ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":one": 1, ":window": window, ":limit": limit },
      });
      return true;
    } catch (error) {
      if (!isConditional(error)) throw error;
      return false;
    }
  };
  if (await increment()) return true;
  try {
    await write({
      TableName: deps.tableName, Key, UpdateExpression: "SET entityType = :type, windowStart = :window, #count = :one",
      ConditionExpression: "attribute_not_exists(windowStart) OR windowStart < :window",
      ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":type": "TASK_RATE", ":window": window, ":one": 1 },
    });
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
  if (!can(actor.role, "commentWrite")) throw pageRefusal("not_allowed");
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
  if (!await takeRate(deps, { taskId: task.taskId, kind: "comment", actor: caller.developerId }, COMMENT_RATE.comments, COMMENT_RATE.windowMs, actor)) {
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
  items.push(taskPageFence(deps.tableName, task), taskAccessFence(deps.tableName, task.taskId, actor.peopleRevision));
  // A comment that came from a stored share ("Can view") is tied to the share row: revoked between the decision and this write, it writes nothing (the share row's own role is the one a share holds: viewer).
  const shareCheck = actor.sharedRow === undefined ? undefined : items.length;
  if (actor.sharedRow !== undefined) items.push({ ConditionCheck: { TableName: deps.tableName, Key: actor.sharedRow, ConditionExpression: "attribute_exists(pk) AND #role = :viewer", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":viewer": "viewer" } } });
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items as never }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const codes = cancellationCodes(error);
      if (codes[0] === "ConditionalCheckFailed") {
        const raced = await getComment(deps, task.taskId, commentId);
        if (raced !== undefined) return { comment: raced, duplicate: true };
      }
      if (shareCheck !== undefined && codes[shareCheck] === "ConditionalCheckFailed") throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
      if (codes[1] === "ConditionalCheckFailed") throw pageRefusal("task_full");
      if (codes[2] === "ConditionalCheckFailed" && parent !== undefined) {
        const now = parent === undefined ? undefined : await getComment(deps, task.taskId, parent.commentId);
        throw pageRefusal(now !== undefined && (now.replyCount ?? 0) >= COMMENT_THREAD_REPLIES_MAX ? "thread_full" : "not_here");
      }
    }
    throw error;
  }
  await openNudgeWindow(deps, comment, name);
  return { comment, duplicate: false };
}


/** Where a page comment's question goes: the Slack service's request queue (FIFO). */
export interface SlackRequestQueue {
  send(message: { body: string; groupId: string; deduplicationId: string; attributes: Record<string, { DataType: "String"; StringValue: string }> }): Promise<void>;
}


/** Records what became of a question to AgentX on the comment, conditioned on the comment being the one the page wrote. */
async function setAsk(
  deps: CommentDependencies,
  comment: TaskComment,
  state: NonNullable<TaskComment["ask"]>["state"],
  expected?: NonNullable<TaskComment["ask"]>["state"],
  access?: Pick<TaskAccess, "peopleRevision" | "task">,
): Promise<TaskComment> {
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
      ...(access === undefined ? [] : [taskPageFence(deps.tableName, access.task), taskAccessFence(deps.tableName, comment.taskId, access.peopleRevision)]),
    ] as never,
  }));
  return { ...comment, ask };
}


/** The per-person limit on questions to AgentX over all of a person's tasks: its own item, outside any task. */
const askRateAcrossTasksKey = (developerId: string) => ({ pk: `ASKRATE#${developerId}`, sk: "RATE#ask" });

/** Counts one question to AgentX against `developerId`'s limit over all their tasks (30 an hour). */
export function takeAskRateAcrossTasks(deps: TableDependencies & Pick<DeveloperTaskRouteDependencies, "now">, developerId: string): Promise<boolean> {
  return takeRateAt(deps, askRateAcrossTasksKey(developerId), AGENTX_ASK_RATE.perPersonAllTasksPerHour, HOUR_MS);
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
