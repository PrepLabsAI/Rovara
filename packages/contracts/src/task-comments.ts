// Comments, replies and suggestions on a task page (spec 061, slice 2): the limits, the stored shapes, the text rules,
// and the planner's answers to the comments an owner sent with Request changes.
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactText } from "./redaction.js";
import { lastFencedBlock } from "./workflow-proposed-checks.js";

export const COMMENT_TEXT_MAX_CHARS = 2_000;
export const AGENTX_ANSWER_MAX_CHARS = 3_000;
export const PLANNER_ANSWER_REASON_MAX_CHARS = 200;
/** Comments, replies and AgentX replies together, per task. */
export const TASK_COMMENT_ITEMS_MAX = 300;
export const COMMENT_THREAD_REPLIES_MAX = 20;
/** The most comments one decision can include: keeps the planner's answers and the transaction small. */
export const DECISION_COMMENTS_MAX = 25;
export const COMMENT_RATE = { comments: 30, suggestions: 60, windowMs: 600_000 } as const;
export const AGENTX_ASK_RATE = { perPersonPerHour: 6, perTaskPerHour: 20, perThread: 5 } as const;
export const NUDGE_WINDOW_MS = 600_000;
/** A question waiting longer than this shows as not answered. */
export const ANSWER_STALE_MS = 600_000;
export const PAGE_POLL_MS = 20_000;
export const PAGE_API_BODY_MAX_BYTES = 16_384;
export const PAGE_NOTE_MAX_CHARS = 500;
/** What a stored comment's text may hold: a person's text after redaction (which can lengthen it), or an AgentX answer. */
const STORED_TEXT_MAX_CHARS = 4_000;
const NAME_MAX_CHARS = 80;

export type CommentDocument = "requirements" | "design" | "plan";
export type CommentTarget = { kind: "claim"; id: string } | { kind: "decision"; id: string } | { kind: "check"; id: string } | { kind: "document" };

const UuidSchema = z.string().uuid();
const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DateTimeSchema = z.string().datetime();
const ClaimIdSchema = z.string().regex(/^[1-9][0-9]{0,2}(\.[1-9][0-9]{0,2}){0,2}$/);
const DecisionIdSchema = z.string().regex(/^d[1-9][0-9]?$/);
const OptionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const CheckIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const NameSchema = z.string().trim().min(1).max(NAME_MAX_CHARS);

export const CommentDocumentSchema = z.enum(["requirements", "design", "plan"]);

export const CommentTargetSchema: z.ZodType<CommentTarget> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claim"), id: ClaimIdSchema }).strict(),
  z.object({ kind: z.literal("decision"), id: DecisionIdSchema }).strict(),
  z.object({ kind: z.literal("check"), id: CheckIdSchema }).strict(),
  z.object({ kind: z.literal("document") }).strict(),
]);

const PersonAuthorSchema = z.object({
  kind: z.literal("person"),
  developerId: DeveloperIdSchema,
  slackUserId: z.string().regex(/^[UW][A-Z0-9]{2,31}$/).optional(),
  name: NameSchema,
  /** Set from the writer's role when the comment is written, never from what the request says. */
  owner: z.boolean(),
}).strict();

const AgentXAuthorSchema = z.object({
  kind: z.literal("agentx"),
  /** "answer": AgentX answered a question asked on the page; "planner": the planner's answer after Request changes. */
  source: z.enum(["answer", "planner"]),
  outcome: z.enum(["done", "not_changed"]).optional(),
  /** Planner replies: the version written in answer. */
  forVersion: z.number().int().positive().optional(),
}).strict();

export const TaskCommentSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: UuidSchema,
  commentId: UuidSchema,
  /** A reply's top-level comment; replies are one level deep. */
  parentId: UuidSchema.optional(),
  document: CommentDocumentSchema,
  version: z.number().int().positive(),
  target: CommentTargetSchema,
  author: z.discriminatedUnion("kind", [PersonAuthorSchema, AgentXAuthorSchema]),
  /** Plain text, redacted when written; empty once deleted. */
  text: z.string().max(STORED_TEXT_MAX_CHARS),
  createdAt: DateTimeSchema,
  editedAt: DateTimeSchema.optional(),
  deletedAt: DateTimeSchema.optional(),
  rev: z.number().int().positive(),
  /** Set when a decision included the comment: it can no longer be edited or deleted. */
  lockedBy: z.object({ requestId: UuidSchema, decision: z.enum(["APPROVE", "REQUEST_CHANGES"]), at: DateTimeSchema }).strict().optional(),
  ask: z.object({ state: z.enum(["answering", "answered", "failed", "unavailable"]), at: DateTimeSchema }).strict().optional(),
}).strict().superRefine((comment, context) => {
  if (comment.deletedAt === undefined && comment.text.length === 0) context.addIssue({ code: "custom", path: ["text"], message: "a comment needs text" });
  if (comment.deletedAt !== undefined && comment.text.length > 0) context.addIssue({ code: "custom", path: ["text"], message: "a deleted comment keeps no text" });
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;

/** One person's suggested option on one decision of one document version. */
export const TaskSuggestionSchema = z.object({
  document: CommentDocumentSchema,
  decisionId: DecisionIdSchema,
  developerId: DeveloperIdSchema,
  optionId: OptionIdSchema,
  name: NameSchema,
  artifactSha256: DigestSchema,
  version: z.number().int().positive(),
  at: DateTimeSchema,
  rev: z.number().int().positive(),
}).strict();
export type TaskSuggestion = z.infer<typeof TaskSuggestionSchema>;

/**
 * The full record of one decision made with answers or comments, kept beside the task: every answer with whether the
 * owner opened it, and the included comments in order (the planner and coder see them as refs c1, c2 and so on).
 */
export const WorkflowDecisionDetailSchema = z.object({
  taskId: UuidSchema,
  requestId: UuidSchema,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  artifactSha256: DigestSchema,
  answers: z.array(z.object({ decisionId: DecisionIdSchema, optionId: OptionIdSchema, opened: z.boolean() }).strict()).max(20),
  includedCommentIds: z.array(UuidSchema).max(DECISION_COMMENTS_MAX),
  note: z.string().trim().min(1).max(PAGE_NOTE_MAX_CHARS).optional(),
  at: DateTimeSchema,
}).strict();
export type WorkflowDecisionDetail = z.infer<typeof WorkflowDecisionDetailSchema>;

/** A UUID-shaped ID derived from text, so the same input always names the same item. */
function derivedUuid(input: string): string {
  const digest = createHash("sha256").update(input, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** A person's comment: derived from who wrote it and the page's request ID, so a resent request is the same comment. */
export function pageCommentId(developerId: string, requestId: string): string {
  return derivedUuid(`page-comment\0${developerId}\0${requestId}`);
}

/** AgentX's answer to a question asked on the page: one per asked comment. */
export function agentxAnswerCommentId(askedCommentId: string): string {
  return derivedUuid(`agentx-answer\0${askedCommentId}`);
}

/** The planner's answer to an included comment, for the version it wrote. */
export function plannerReplyCommentId(commentId: string, artifactId: string): string {
  return derivedUuid(`planner-answer\0${commentId}\0${artifactId}`);
}

/** Where a comment sits, in words: "claim 2.1", "decision d1", "check unit-tests" or "the whole document". */
export function commentTargetText(target: CommentTarget): string {
  return target.kind === "document" ? "the whole document" : `${target.kind} ${target.id}`;
}

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
// Every control character but the line feed (a tab is turned into a space first).
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * A comment as it is stored: trimmed, with control and direction-changing characters removed (a tab becomes a space,
 * line breaks stay), at most two blank lines in a row, and secrets redacted. The length limit applies to what the
 * person wrote.
 */
export function cleanCommentText(raw: string): { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" } {
  const text = raw
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(CONTROL_CHARACTERS, "")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (text.length > COMMENT_TEXT_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text: redactText(text).slice(0, STORED_TEXT_MAX_CHARS) };
}

/** The info string of the fenced block in which the planner answers each included comment. */
export const COMMENT_ANSWERS_INFO_STRING = "agentx-comment-answers";
const COMMENT_ANSWERS_READ_MAX = 100;

export interface CommentAnswer { ref: string; outcome: "done" | "not_changed"; reason: string }

/** Model text as one plain line: redacted, no control or direction characters, cut to `max` characters. */
function oneLine(value: string, max: number): string {
  const flat = redactText(value).replace(BIDI_CONTROLS, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The planner's answers to the included comments, from the last `agentx-comment-answers` block of its answer. Never
 * throws: a missing, unclosed or unreadable block is no answers; an entry for an unknown ref, a repeated ref, an
 * unknown outcome or an empty reason is left out; each reason is redacted, put on one line and cut to 200 characters.
 */
export function parseCommentAnswers(answer: string, refs: ReadonlySet<string>): CommentAnswer[] {
  const block = lastFencedBlock(answer, COMMENT_ANSWERS_INFO_STRING);
  if (typeof block !== "string") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const answers: CommentAnswer[] = [];
  for (const entry of raw.slice(0, COMMENT_ANSWERS_READ_MAX) as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { comment, outcome, reason } = entry as Record<string, unknown>;
    if (typeof comment !== "string" || !refs.has(comment) || seen.has(comment)) continue;
    if (outcome !== "done" && outcome !== "not_changed") continue;
    if (typeof reason !== "string") continue;
    const text = oneLine(reason, PLANNER_ANSWER_REASON_MAX_CHARS);
    if (text.length === 0) continue;
    seen.add(comment);
    answers.push({ ref: comment, outcome, reason: text });
  }
  return answers;
}

// sameAnswers lives in task-workflow.ts, beside the decision replay check that uses it.

/** Whether two ID lists hold the same IDs, whatever their order. */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, index) => id === right[index]);
}
