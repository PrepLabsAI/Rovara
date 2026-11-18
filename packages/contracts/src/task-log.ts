// The task log (owner decision 254z d, design B1): one short, ordered list of entries per task that every surface draws from, so a question asked, an answer given anywhere, an approval or a pull request is
// said once and each channel (the Slack thread, the Linear or Jira ticket, the web page) is only a renderer of it. The core writes an entry in the same transaction as the change that caused it, under a key made
// from what happened (not from the time), so the same event again is the same entry.
//
// The log holds text (a question, an answer, a plan's summary lines), so it is NOT a work event (those stay content-free). It lives in the task's own partition: it follows the task's retention and erase.
// Every text in it is already redacted, one bounded block, and free of control characters when it is written; a surface that draws it still makes it inert for its own place (mentions, links, markup).
// This file depends on nothing but zod and the ticket moments, so the browser and the broker both import it.
import { z } from "zod";
import { TICKET_UPDATE_MOMENTS } from "./ticket-updates.js";

/** The kinds of entry, closed: a new kind is a contract change. */
export const TASK_LOG_KINDS = ["status", "plan_summary", "question", "answer", "approval", "pr"] as const;
export type TaskLogKind = (typeof TASK_LOG_KINDS)[number];

/** Where an answer or an approval was given. */
export const TASK_LOG_SURFACES = ["web", "slack", "linear", "jira", "github", "cli", "mcp"] as const;
export const TaskLogSurfaceSchema = z.enum(TASK_LOG_SURFACES);
export type TaskLogSurface = z.infer<typeof TaskLogSurfaceSchema>;

/** How a surface is named in a sentence: "Ana Ruiz, in Slack". */
export const TASK_LOG_SURFACE_WORDS: Readonly<Record<TaskLogSurface, string>> = {
  web: "on the Rovara page", slack: "in Slack", linear: "in Linear", jira: "in Jira", github: "on GitHub", cli: "in the terminal", mcp: "in an AI tool",
};

/** The most entries a task's log holds and a reader reads. */
export const TASK_LOG_ENTRIES_MAX = 200;
/** The most characters of a question or an answer in the log (design B2). */
export const TASK_LOG_TEXT_MAX = 500;
export const TASK_LOG_PLAN_LINES_MAX = 5;
export const TASK_LOG_PLAN_LINE_MAX = 200;
export const TASK_LOG_PLAN_NEEDED_MAX = 300;
export const TASK_LOG_PERSON_MAX = 80;
export const TASK_LOG_CHOICES_MAX = 4;
export const TASK_LOG_PULL_REQUESTS_MAX = 5;

const NoControls = (text: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(text);
const PlainText = (max: number) => z.string().min(1).max(max).refine(NoControls, "must not contain control or invisible characters");
/** An entry's key: made from what happened (a moment, a question, a request id), so the same event is the same entry. */
export const TaskLogEntryKeySchema = z.string().regex(/^[a-z_]{2,20}:[A-Za-z0-9._#:-]{1,120}$/u);
const Base = { key: TaskLogEntryKeySchema, at: z.string().datetime() } as const;
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/u);

export const TaskLogEntrySchema = z.discriminatedUnion("kind", [
  /** A milestone of the task: started, plan ready, pull request opened, merged, closed. */
  z.object({ ...Base, kind: z.literal("status"), moment: z.enum(TICKET_UPDATE_MOMENTS) }).strict(),
  /** The lines the decision card shows for the plan waiting for review, with its risk tier and estimate range. */
  z.object({
    ...Base, kind: z.literal("plan_summary"), revision: z.number().int().min(0), needed: PlainText(TASK_LOG_PLAN_NEEDED_MAX),
    lines: z.array(PlainText(TASK_LOG_PLAN_LINE_MAX)).min(1).max(TASK_LOG_PLAN_LINES_MAX), risk: z.enum(["low", "medium", "high"]), estimate: PlainText(80).optional(),
  }).strict(),
  z.object({
    ...Base, kind: z.literal("question"), questionId: IdSchema, round: z.number().int().min(0), text: PlainText(TASK_LOG_TEXT_MAX),
    choices: z.array(PlainText(80)).min(1).max(TASK_LOG_CHOICES_MAX).optional(),
  }).strict(),
  z.object({
    ...Base, kind: z.literal("answer"), questionId: IdSchema, round: z.number().int().min(0), text: PlainText(TASK_LOG_TEXT_MAX), by: PlainText(TASK_LOG_PERSON_MAX), surface: TaskLogSurfaceSchema,
  }).strict(),
  z.object({
    ...Base, kind: z.literal("approval"), what: z.enum(["plan", "requirements", "design", "pull_request"]), outcome: z.enum(["approved", "changes_requested", "rejected"]),
    /** The first characters of the digest of what was decided on (the code `/rovara approve <code>` names), when there is a document. */
    code: z.string().regex(/^[0-9a-f]{8}$/u).optional(), revision: z.number().int().min(0).optional(), by: PlainText(TASK_LOG_PERSON_MAX), surface: TaskLogSurfaceSchema,
  }).strict(),
  z.object({ ...Base, kind: z.literal("pr"), urls: z.array(z.string().url().max(2048)).min(1).max(TASK_LOG_PULL_REQUESTS_MAX) }).strict(),
]);
export type TaskLogEntry = z.infer<typeof TaskLogEntrySchema>;
export type TaskLogEntryOf<Kind extends TaskLogKind> = Extract<TaskLogEntry, { kind: Kind }>;

/** The row of one entry in the task's partition (the same layout as the task's other rows: `DEVTASK#<task>`). */
export function taskLogKey(taskId: string, entryKey: string): { pk: string; sk: string } {
  if (!/^[0-9a-f-]{36}$/u.test(taskId)) throw new Error("a task id is a uuid");
  if (!TaskLogEntryKeySchema.safeParse(entryKey).success) throw new Error("not a task log entry key");
  return { pk: `DEVTASK#${taskId}`, sk: `TASKLOG#${entryKey}` };
}

/** The prefix every entry of the task has under its partition. */
export const TASK_LOG_SORT_PREFIX = "TASKLOG#";

/**
 * What a reader gets from `GET /v1/app/sessions/<session>/log` (B5): the task's log, oldest first, at most `TASK_LOG_ENTRIES_MAX` entries, each one as it was written (redacted, bounded, one line) and nothing else of the
 * rows (no company, no task id). Who may read it is who may read the task's session (`core/sessions/access.ts`); anyone else gets the missing session's answer.
 */
export const TaskLogViewSchema = z.object({ entries: z.array(TaskLogEntrySchema).max(TASK_LOG_ENTRIES_MAX) }).strict();
export type TaskLogView = z.infer<typeof TaskLogViewSchema>;
