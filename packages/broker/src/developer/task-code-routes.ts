// The deployed API's task messages, pull request diff and plan comments (`/v1/dev/tasks/{id}/messages`, `/diff` and `/comments`):
// the calls a signed-in web app makes for a task's session and plan screens. Every route runs the task routes' own access rule
// (`resolveTaskAccess`: not yours and no such task read the same) and then the company rule (`rowInCompany`) on the task row
// before it reads or writes anything else. Shapes are fixed; input is checked at runtime and refused in fixed words.
//   - messages: a person's comment on the task's current plan document, or a steering note for the task's next step. A steering
//     note is the same `NOTE#` item the task flow reads (information only, never an instruction), written in one transaction with
//     the task's note count. Only the task's owner steers.
//   - diff: one page of one pull request's files, only for a pull request this task opened.
//   - comments: the plan documents' comments, listed and created through the task page's own comment store.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AppNoteSchema, COMMENT_RATE, CommentTargetSchema, IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, PAGE_API_BODY_MAX_BYTES, WORKFLOW_THREAD_NOTES_MAX,
  agentXError, cleanCommentText, redactText,
  type AppNote, type CommentDocument, type CommentTarget, type TaskComment,
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { isConditional } from "../aws/broker-shared.js";
import { plainName } from "../aws/task-web.js";
import { NOTE_KEEP_SECONDS, NOTE_SK_PREFIX, noteKey } from "../core/sessions/notes.js";
import { rowCompany, rowInCompany } from "./company-rows.js";
import { createTaskComment, currentStepDocument, listTaskComments, pageRefusal, takeRate, type PageActor } from "./page-comments.js";
import { resolveTaskAccess, taskOpen, type TaskAccess } from "./task-access.js";
import { taskAccessFence, } from "./task-people.js";
import { taskKey } from "./task-records.js";

// ---- the shapes (they mirror the web app's contract, version 0, by hand; the route tests pin them)

export interface TaskMessageView { messageId: string; kind: "comment" | "steer"; author: { developerId: string; name: string }; text: string; at: string; rev: number; threadId?: string; anchor?: string }
export interface TaskMessagesResponse { messages: TaskMessageView[]; next?: string }
export interface TaskMessageSendResponse { message: TaskMessageView }
export interface TaskDiffResponse { repository: string; number: number; page: number; files: Array<{ path: string; additions: number; deletions: number; patch: string }>; more: boolean }
export interface PlanCommentView { commentId: string; document: CommentDocument; author: { developerId: string; name: string }; text: string; at: string; rev: number; resolved: boolean }
export interface PlanCommentsResponse { comments: PlanCommentView[] }
export interface PlanCommentCreateResponse { comment: PlanCommentView }

// ---- the limits

/** Messages in one page: the default and the most a call may ask for. */
export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 100;
/** Files in one page of a diff, the most one file's patch shows, and the most pages a call may ask for. */
export const DIFF_FILES_PER_PAGE = 30;
export const DIFF_PATCH_MAX_CHARS = 30_000;
export const DIFF_PAGE_MAX = 100;
/** What a diff page says in place of a patch that is too long to show whole (never a silent cut). */
export const DIFF_PATCH_TOO_LONG = "This file's changes are too long to show here. Open the pull request to read them.";
const AGENTX_AUTHOR = { developerId: "agentx", name: "Rovara" } as const;
const NOT_FOUND_TASK = "no task here that you can see";

export interface DiffPageRead { files: Array<{ filename: string; additions: number; deletions: number; patch?: string }>; more: boolean }

type RouteDeps = DeveloperTaskRouteDependencies;

// ---- access

/**
 * The task a caller may see (the task routes' own rule), and only if it belongs to the company the call is for. The company is
 * checked on the bare task row FIRST, so a task of another company answers exactly as a missing task does, before the access rule
 * can say anything (it names the owner to a reader on the task's workspace who is not in its channel).
 */
async function accessFor(deps: RouteDeps, caller: DeveloperCaller, taskId: string, action?: Parameters<typeof resolveTaskAccess>[3]): Promise<TaskAccess> {
  const row = await readRow(deps, taskKey(taskId));
  if (row !== undefined && !rowInCompany(row, deps.companyId)) throw agentXError("TASK_NOT_FOUND", NOT_FOUND_TASK);
  const access = await resolveTaskAccess(deps, caller, taskId, action);
  if (!rowInCompany(access.task as unknown as Record<string, unknown>, deps.companyId)) throw agentXError("TASK_NOT_FOUND", NOT_FOUND_TASK);
  return access;
}

const pageActor = async (deps: RouteDeps, caller: DeveloperCaller, taskId: string): Promise<PageActor> => ({ ...await accessFor(deps, caller, taskId), caller });

// ---- input

const RequestIdSchema = z.string().min(1).max(128);
const AnchorSchema = z.string().min(1).max(100);
const SendMessageSchema = z.object({
  requestId: RequestIdSchema, kind: z.enum(["comment", "steer"]), text: z.string().max(PAGE_API_BODY_MAX_BYTES), threadId: z.string().uuid().optional(), anchor: AnchorSchema.optional(),
}).strict();
const CreateCommentSchema = z.object({
  requestId: RequestIdSchema, document: z.enum(["requirements", "design", "plan"]), text: z.string().max(PAGE_API_BODY_MAX_BYTES), anchor: AnchorSchema.optional(), replyTo: z.string().uuid().optional(),
}).strict();

function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `the ${what} request is invalid`);
  return parsed.data;
}

/** A comment's target as the web app names it: `claim:1.2`, `decision:d1`, `check:name`, or `document` (or nothing). */
export function targetOfAnchor(anchor: string | undefined): CommentTarget {
  if (anchor === undefined || anchor === "document") return { kind: "document" };
  const split = anchor.indexOf(":");
  const parsed = split < 1 ? undefined : CommentTargetSchema.safeParse({ kind: anchor.slice(0, split), id: anchor.slice(split + 1) });
  if (parsed === undefined || !parsed.success) throw agentXError("CONFIG_INVALID", "the anchor is invalid");
  return parsed.data;
}
const anchorOfTarget = (target: CommentTarget): string | undefined => target.kind === "document" ? undefined : `${target.kind}:${target.id}`;

// ---- plan comments

const authorOf = (comment: TaskComment): { developerId: string; name: string } =>
  comment.author.kind === "person" ? { developerId: comment.author.developerId, name: shownName(comment.author.name) } : { ...AGENTX_AUTHOR };

/** A name as a view shows it: one line, redacted, at most 80 characters. */
function shownName(name: string): string {
  return plainName(name) ?? "A teammate";
}

function planCommentView(comment: TaskComment): PlanCommentView {
  // `resolved`: the comment was sent with a decision, so the planner has handled it and it can no longer change.
  return { commentId: comment.commentId, document: comment.document, author: authorOf(comment), text: redactText(comment.text), at: comment.createdAt, rev: comment.rev, resolved: comment.lockedBy !== undefined };
}

const liveComments = (comments: readonly TaskComment[]): TaskComment[] => comments.filter((comment) => comment.deletedAt === undefined);

/** `GET /v1/dev/tasks/{id}/comments`: the task's plan comments, oldest first (a task holds at most 300). */
export async function listPlanComments(deps: RouteDeps, caller: DeveloperCaller, taskId: string): Promise<PlanCommentsResponse> {
  const { task } = await accessFor(deps, caller, taskId, "read");
  return { comments: liveComments(await listTaskComments(deps, task.taskId)).map(planCommentView) };
}

function latestVersionOf(task: TaskAccess["task"], document: CommentDocument): number {
  return (task.workflow?.artifacts ?? []).filter((artifact) => artifact.type === document).reduce((latest, artifact) => Math.max(latest, artifact.version), 0);
}

async function postComment(deps: RouteDeps, actor: PageActor, input: { requestId: string; document: CommentDocument; text: string; anchor?: string; parentId?: string }): Promise<TaskComment> {
  const target = input.parentId === undefined ? targetOfAnchor(input.anchor) : { kind: "document" as const };
  const version = latestVersionOf(actor.task, input.document);
  const { comment } = await createTaskComment(deps, actor, {
    requestId: input.requestId, document: input.document, version: version === 0 ? 1 : version, target, ...(input.parentId === undefined ? {} : { parentId: input.parentId }), text: input.text, ask: false,
  });
  return comment;
}

/** `POST /v1/dev/tasks/{id}/comments`: a comment on a plan document (or a reply), through the task page's comment store. */
export async function createPlanComment(deps: RouteDeps, caller: DeveloperCaller, taskId: string, value: unknown): Promise<PlanCommentCreateResponse> {
  const input = parseInput(CreateCommentSchema, value, "comment");
  const actor = await pageActor(deps, caller, taskId);
  const comment = await postComment(deps, actor, { requestId: input.requestId, document: input.document, text: input.text, ...(input.anchor === undefined ? {} : { anchor: input.anchor }), ...(input.replyTo === undefined ? {} : { parentId: input.replyTo }) });
  return { comment: planCommentView(comment) };
}

// ---- messages

function commentMessage(comment: TaskComment): TaskMessageView {
  const anchor = anchorOfTarget(comment.target);
  return {
    messageId: comment.commentId, kind: "comment", author: authorOf(comment), text: redactText(comment.text), at: comment.createdAt, rev: comment.rev,
    ...(comment.parentId === undefined ? {} : { threadId: comment.parentId }), ...(anchor === undefined ? {} : { anchor }),
  };
}

function steerMessage(note: AppNote): TaskMessageView {
  return { messageId: note.messageId, kind: "steer", author: { developerId: note.developerId, name: shownName(note.name) }, text: redactText(note.text), at: note.receivedAt, rev: 1 };
}

/**
 * A stored steering note, if the row reads as one. A note carries no company of its own (the task flow reads it with a strict
 * shape): it belongs to its task's company, which the caller has already checked. A note that DOES name a company must name this one.
 */
function noteOf(item: Record<string, unknown>, deps: RouteDeps): AppNote | undefined {
  const named = rowCompany(item);
  if (named === null || (named !== undefined && named !== (deps.companyId ?? IMPLICIT_COMPANY_ID))) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, companyId: _company, orgId: _org, [INDEX_EXPIRY_ATTRIBUTE]: _expires, ...fields } = item;
  void _pk; void _sk; void _type; void _company; void _org; void _expires;
  const parsed = AppNoteSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

/** The task's steering notes (the ones a person sent), oldest first, from the task's own partition and company; at most the notes a task keeps. */
async function readSteerNotes(deps: RouteDeps, taskId: string): Promise<AppNote[]> {
  const notes: AppNote[] = [];
  let start: Record<string, unknown> | undefined;
  let read = 0;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": NOTE_SK_PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      read += 1;
      if (read > WORKFLOW_THREAD_NOTES_MAX) break;
      // A Slack reply (no `source`), a note of another company, or a note that does not read is not a steering note: it is left out.
      const note = noteOf(item, deps);
      if (note !== undefined) notes.push(note);
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined && read <= WORKFLOW_THREAD_NOTES_MAX);
  return notes;
}

const CursorSchema = z.object({ at: z.string().datetime(), id: z.string().min(1).max(64) }).strict();
const encodeCursor = (message: TaskMessageView): string => Buffer.from(JSON.stringify({ at: message.at, id: message.messageId }), "utf8").toString("base64url");
function decodeCursor(cursor: string): { at: string; id: string } {
  const refused = () => agentXError("CONFIG_INVALID", "the page marker is invalid");
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw refused();
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (!parsed.success) throw refused();
    return parsed.data;
  } catch {
    throw refused();
  }
}
const byPlace = (left: TaskMessageView, right: TaskMessageView) => left.at.localeCompare(right.at) || left.messageId.localeCompare(right.messageId);

function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return MESSAGES_PAGE_DEFAULT;
  if (!/^[0-9]{1,4}$/u.test(raw) || Number(raw) < 1 || Number(raw) > MESSAGES_PAGE_MAX) throw agentXError("CONFIG_INVALID", `limit must be a whole number from 1 to ${MESSAGES_PAGE_MAX}`);
  return Number(raw);
}

/** `GET /v1/dev/tasks/{id}/messages`: comments and steering notes together, oldest first, `limit` (1 to 100) at a time; `next` goes back as `cursor`. */
export async function listTaskMessages(deps: RouteDeps, caller: DeveloperCaller, taskId: string, url: URL): Promise<TaskMessagesResponse> {
  const limit = pageLimit(url);
  const rawCursor = url.searchParams.get("cursor");
  const after = rawCursor === null ? undefined : decodeCursor(rawCursor);
  const { task } = await accessFor(deps, caller, taskId, "read");
  const all = [...liveComments(await listTaskComments(deps, task.taskId)).map(commentMessage), ...(await readSteerNotes(deps, task.taskId)).map(steerMessage)].sort(byPlace);
  const rest = after === undefined ? all : all.filter((message) => message.at.localeCompare(after.at) > 0 || (message.at === after.at && message.messageId.localeCompare(after.id) > 0));
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { messages: page, ...(rest.length > limit && last !== undefined ? { next: encodeCursor(last) } : {}) };
}

/** The note's id for one person's request: the same request is the same note, and nobody else can name it. */
const noteIdOf = (developerId: string, requestId: string): string => `msg_${createHash("sha256").update(`steer\0${developerId}\0${requestId}`, "utf8").digest("hex").slice(0, 20)}`;

const STEER_ATTEMPTS = 3;
const FULL_REASON = "this task already holds all the messages it keeps";
const PLAIN_TASK_REASON = "this task takes instructions only from its owner's next request";

/** Why this task takes no steering note now (a refusal costs the caller none of their rate). */
function steerRefusal(task: TaskAccess["task"]): void {
  if (!taskOpen(task)) throw pageRefusal("closed");
  if (task.workflow === undefined) throw agentXError("CONFIG_INVALID", PLAIN_TASK_REASON);
  if ((task.threadNoteCount ?? 0) >= WORKFLOW_THREAD_NOTES_MAX) throw agentXError("CONFIG_INVALID", FULL_REASON);
}

async function readRow(deps: RouteDeps, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}


/** A steering note for the task's next step (owner only): one transaction writes the note and counts it on the task. */
async function steer(deps: RouteDeps, caller: DeveloperCaller, taskId: string, input: { requestId: string; text: string }): Promise<TaskMessageView> {
  let access = await accessFor(deps, caller, taskId, "control");
  const messageId = noteIdOf(caller.developerId, input.requestId);
  const existing = await readRow(deps, noteKey(access.task.taskId, messageId));
  if (existing !== undefined) {
    const saved = noteOf(existing, deps);
    if (saved === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used");
    return steerMessage(saved);
  }
  const cleaned = cleanCommentText(input.text);
  if (!cleaned.ok) throw pageRefusal(cleaned.reason);
  steerRefusal(access.task);
  if (!await takeRate(deps, { taskId, kind: "steer", actor: caller.developerId }, COMMENT_RATE.comments, COMMENT_RATE.windowMs)) throw pageRefusal("slow_down");
  for (let attempt = 0; attempt < STEER_ATTEMPTS; attempt += 1) {
    const task = access.task;
    steerRefusal(task);
    if (task.workflow === undefined) throw agentXError("CONFIG_INVALID", PLAIN_TASK_REASON);
    const nowMs = deps.now();
    // A step that took notes through a mark at or after now: this one is stamped strictly after it, so the next step reads it.
    const mark = task.threadNotesFedThrough;
    let receivedAt = new Date(nowMs).toISOString();
    if (mark !== undefined && mark >= receivedAt) receivedAt = new Date(Math.max(nowMs, Date.parse(mark) + 1)).toISOString();
    const note: AppNote = AppNoteSchema.parse({
      schemaVersion: 1, source: "app", taskId: task.taskId, developerId: caller.developerId, name: plainName(caller.name) ?? "A teammate", isOwner: true,
      sessionId: task.taskId, messageId, text: cleaned.text, truncated: false, receivedAt, workflowRevision: task.workflow.revision,
    });
    const items = [
      { Put: { TableName: deps.tableName, Item: { ...noteKey(task.taskId, messageId), entityType: "WORKFLOW_THREAD_NOTE", ...note, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + NOTE_KEEP_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" } },
      {
        Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "ADD threadNoteCount :one",
          ConditionExpression: "attribute_exists(workflow) AND attribute_not_exists(closedAt) AND (attribute_not_exists(threadNoteCount) OR threadNoteCount < :max) AND (attribute_not_exists(threadNotesFedThrough) OR threadNotesFedThrough < :receivedAt)",
          ExpressionAttributeValues: { ":one": 1, ":max": WORKFLOW_THREAD_NOTES_MAX, ":receivedAt": receivedAt },
        },
      },
      taskAccessFence(deps.tableName, task.taskId, access.peopleRevision),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return steerMessage(note);
    } catch (error) {
      if (!isConditional(error) && !(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
      // The same request committed first, or the task changed (a step took notes, it closed, it filled): decide again from a fresh read.
      const raced = await readRow(deps, noteKey(task.taskId, messageId));
      const saved = raced === undefined ? undefined : noteOf(raced, deps);
      if (saved !== undefined) return steerMessage(saved);
      access = await accessFor(deps, caller, taskId, "control");
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while sending; try again");
}

/** `POST /v1/dev/tasks/{id}/messages`: a comment on the task's current plan document, or a steering note (owner only) for its next step. */
export async function sendTaskMessage(deps: RouteDeps, caller: DeveloperCaller, taskId: string, value: unknown): Promise<TaskMessageSendResponse> {
  const input = parseInput(SendMessageSchema, value, "message");
  if (input.kind === "steer") {
    if (input.threadId !== undefined || input.anchor !== undefined) throw agentXError("CONFIG_INVALID", "the message request is invalid");
    return { message: await steer(deps, caller, taskId, { requestId: input.requestId, text: input.text }) };
  }
  const actor = await pageActor(deps, caller, taskId);
  const comment = await postComment(deps, actor, {
    requestId: input.requestId, document: currentStepDocument(actor.task.workflow) ?? "plan", text: input.text,
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }), ...(input.threadId === undefined ? {} : { parentId: input.threadId }),
  });
  return { message: commentMessage(comment) };
}

// ---- the pull request diff
// A patch is the repository's own code, shown raw (redacting it would change the diff); the task's readers are the people the project admits.

const DiffQuerySchema = z.object({ repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), number: z.number().int().positive().max(2_147_483_647), page: z.number().int().min(1).max(DIFF_PAGE_MAX) });
const whole = (raw: string | null): number | undefined => raw !== null && /^[0-9]{1,10}$/u.test(raw) ? Number(raw) : undefined;
const DiffFileSchema = z.object({ filename: z.string().min(1).max(500), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), patch: z.string().optional() });
const DiffReadSchema = z.object({ files: z.array(DiffFileSchema).max(DIFF_FILES_PER_PAGE), more: z.boolean() });

/** The pull request's repository as GitHub spells it, from the URL the broker stored when the task opened it; anything else is not read. */
function githubRepositoryUrl(url: string, number: number): string | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/pull\/([0-9]{1,10})$/u.exec(url);
  return match === null || Number(match[3]) !== number || [match[1], match[2]].some((part) => part === "." || part === "..") ? undefined : `https://github.com/${match[1]}/${match[2]}`;
}

/** `GET /v1/dev/tasks/{id}/diff?repository=&number=&page=`: one page of one pull request's files, for a pull request this task opened. */
export async function readTaskDiff(deps: RouteDeps, caller: DeveloperCaller, taskId: string, url: URL): Promise<TaskDiffResponse> {
  const query = DiffQuerySchema.safeParse({
    repository: url.searchParams.get("repository") ?? undefined, number: whole(url.searchParams.get("number")),
    page: url.searchParams.has("page") ? whole(url.searchParams.get("page")) : 1,
  });
  if (!query.success) throw agentXError("CONFIG_INVALID", "the diff request is invalid");
  const { task } = await accessFor(deps, caller, taskId, "read");
  const opened = (await deps.actions.pullRequests(task.workspaceId)).find((pullRequest) => pullRequest.repository === query.data.repository && pullRequest.number === query.data.number);
  if (opened === undefined) throw agentXError("NOT_FOUND", "no such pull request on this task");
  const repositoryUrl = githubRepositoryUrl(opened.url, opened.number);
  if (repositoryUrl === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this pull request's diff cannot be read");
  if (deps.readPullRequestDiff === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "pull request diffs are not available on this install");
  let read: DiffPageRead;
  try {
    const parsed = DiffReadSchema.safeParse(await deps.readPullRequestDiff(repositoryUrl, opened.number, query.data.page));
    if (!parsed.success) throw new Error("unreadable");
    read = { files: parsed.data.files.map((file) => ({ filename: file.filename, additions: file.additions, deletions: file.deletions, ...(file.patch === undefined ? {} : { patch: file.patch }) })), more: parsed.data.more };
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "this pull request's diff cannot be read");
  }
  return {
    repository: query.data.repository, number: query.data.number, page: query.data.page, more: read.more,
    files: read.files.map((file) => ({
      path: file.filename, additions: file.additions, deletions: file.deletions,
      patch: file.patch === undefined ? "" : file.patch.length > DIFF_PATCH_MAX_CHARS ? DIFF_PATCH_TOO_LONG : file.patch,
    })),
  };
}
