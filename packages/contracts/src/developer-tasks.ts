// Spec 025 phase 25b: the developer task API's names and wire shapes. Requests are strict; the MCP
// server parses responses with the non-strict schemas here, so a newer control plane can add fields.
import { Buffer } from "node:buffer";
import { z } from "zod";
import { cleanDisplayName } from "./display-name.js";
import { OperationStatusSchema } from "./operation.js";
import { DeveloperShareModeSchema } from "./project.js";

export const DEVELOPER_TASK_OWNER_ISSUER = "agentx-developer-task";
export const DEVELOPER_INSTRUCTIONS_MAX_BYTES = 65_536;
export const DEVELOPER_TASK_TITLE_MAX = 120;
export const DEVELOPER_CLIENT_NAME_MAX = 40;
export const DEVELOPER_TASK_SUMMARY_MAX = 4_000;
export const DEVELOPER_FAILURE_MESSAGE_MAX = 1_000;
export const DEVELOPER_EVENT_TEXT_MAX = 300;
export const DEVELOPER_EVENTS_MAX = 50;
export const DEVELOPER_EVENTS_DEFAULT = 10;
export const DEVELOPER_TASK_LIST_MAX = 50;
export const DEVELOPER_TASK_LIST_DEFAULT = 20;
export const DEVELOPER_WAIT_MAX_SECONDS = 600;
export const UNKNOWN_CLIENT_NAME = "an AI tool";

export const DeveloperTaskStatusSchema = z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);
export type DeveloperTaskStatus = z.infer<typeof DeveloperTaskStatusSchema>;
export const ENDED_TASK_STATUSES: ReadonlySet<DeveloperTaskStatus> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);

export const DeveloperTaskFailureCategorySchema = z.enum(["setup_failed", "worker_unavailable", "task_failed", "timed_out", "interrupted", "publication_failed"]);
export type DeveloperTaskFailureCategory = z.infer<typeof DeveloperTaskFailureCategorySchema>;

export const DeveloperInstructionsSchema = z
  .string()
  .min(1, "instructions are empty")
  .refine((value) => Buffer.byteLength(value, "utf8") <= DEVELOPER_INSTRUCTIONS_MAX_BYTES, `instructions exceed ${DEVELOPER_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`);

const RequestIdSchema = z.string().uuid();
const hasControlCharacter = (value: string) => [...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
});

export const StartDeveloperTaskRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    project: z.string().min(1).max(200),
    instructions: DeveloperInstructionsSchema,
    title: z.string().max(DEVELOPER_TASK_TITLE_MAX).optional(),
    client: z.string().max(200).optional(),
    // 25c: sharing. 25b accepts the fields and refuses a request to share (R9).
    shareToChannel: z.boolean().optional(),
    shareMode: DeveloperShareModeSchema.optional(),
    channel: z.string().min(1).max(80).optional(),
  })
  .strict();
export type StartDeveloperTaskRequest = z.infer<typeof StartDeveloperTaskRequestSchema>;

export const ContinueDeveloperTaskRequestSchema = z.object({ requestId: RequestIdSchema, instructions: DeveloperInstructionsSchema }).strict();
export type ContinueDeveloperTaskRequest = z.infer<typeof ContinueDeveloperTaskRequestSchema>;

export const DeveloperTaskActionRequestSchema = z.object({ requestId: RequestIdSchema }).strict();
export type DeveloperTaskActionRequest = z.infer<typeof DeveloperTaskActionRequestSchema>;

export const DeveloperPullRequestRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    title: z.string().trim().min(1).max(256).refine((value) => !hasControlCharacter(value), "title contains control characters"),
    body: z
      .string()
      .refine((value) => !value.includes("\0"), "body contains a NUL character")
      .refine((value) => Buffer.byteLength(value, "utf8") <= 30_000, "body exceeds 30000 UTF-8 bytes")
      .optional(),
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
    draft: z.boolean().default(true),
  })
  .strict();
export type DeveloperPullRequestRequest = z.infer<typeof DeveloperPullRequestRequestSchema>;

export const DeveloperTaskEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["status", "progress", "tool", "message", "error"]),
  text: z.string().max(DEVELOPER_EVENT_TEXT_MAX),
});
export type DeveloperTaskEvent = z.infer<typeof DeveloperTaskEventSchema>;

const PullRequestSummarySchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["open", "closed", "merged"]),
});

export const DeveloperTaskViewSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  project: z.string(),
  status: DeveloperTaskStatusSchema,
  failure: z.object({ category: DeveloperTaskFailureCategorySchema, message: z.string().max(DEVELOPER_FAILURE_MESSAGE_MAX) }).optional(),
  startingRevision: z.number().int().positive(),
  client: z.string(),
  shared: z.boolean(),
  closing: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  events: z.array(DeveloperTaskEventSchema).max(DEVELOPER_EVENTS_MAX),
  summary: z.string().max(DEVELOPER_TASK_SUMMARY_MAX).optional(),
  changedFiles: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative().optional() })).optional(),
  pullRequests: z.array(PullRequestSummarySchema).optional(),
  /** R22: what the latest close preflight found, when it refused to close. */
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
});
export type DeveloperTaskView = z.infer<typeof DeveloperTaskViewSchema>;

export const DeveloperTaskListItemSchema = DeveloperTaskViewSchema.pick({ taskId: true, title: true, project: true, status: true, shared: true, createdAt: true, updatedAt: true });
export type DeveloperTaskListItem = z.infer<typeof DeveloperTaskListItemSchema>;
export const DeveloperTaskListResponseSchema = z.object({ tasks: z.array(DeveloperTaskListItemSchema) });
export const DeveloperTaskResponseSchema = z.object({ task: DeveloperTaskViewSchema });
export const DeveloperCloseResponseSchema = z.object({
  task: DeveloperTaskViewSchema,
  closed: z.boolean(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
});
export type DeveloperCloseResponse = z.infer<typeof DeveloperCloseResponseSchema>;
export const DeveloperPullRequestResponseSchema = z.object({
  task: DeveloperTaskViewSchema,
  operationId: z.string().uuid(),
  operationStatus: OperationStatusSchema,
  pullRequest: PullRequestSummarySchema.optional(),
});
export type DeveloperPullRequestResponse = z.infer<typeof DeveloperPullRequestResponseSchema>;
export const DeveloperTaskEventsResponseSchema = z.object({ events: z.array(DeveloperTaskEventSchema) });

const KNOWN_CLIENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude[-_ ]?code\b/i, "Claude Code"],
  [/codex/i, "Codex"],
  [/cursor/i, "Cursor"],
];

/**
 * FR-033: the MCP client's clientInfo.name, cleaned like a Slack display name, then mapped to
 * "Claude Code", "Codex" or "Cursor", and otherwise "an AI tool". Only these four strings ever
 * reach a PR footer or a turn record, so a client cannot choose that text (R25).
 */
export function cleanClientName(value: string | undefined): string {
  const cleaned = value === undefined ? undefined : cleanDisplayName(value);
  if (cleaned === undefined) return UNKNOWN_CLIENT_NAME;
  const known = KNOWN_CLIENTS.find(([pattern]) => pattern.test(cleaned))?.[1] ?? UNKNOWN_CLIENT_NAME;
  return known.slice(0, DEVELOPER_CLIENT_NAME_MAX);
}

// Control, format and separator characters that must not reach a title.
// eslint-disable-next-line no-control-regex
const TITLE_NOISE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/gu;

/** FR-030: the given title, else the first non-empty line of the instructions, at most 120 characters. */
export function taskTitle(instructions: string, title?: string): string {
  const firstLine = instructions.split(/\r\n|\r|\n/).find((line) => line.trim() !== "") ?? "";
  const source = title !== undefined && title.trim() !== "" ? title : firstLine;
  const clean = source.replace(TITLE_NOISE, " ").replace(/\s+/g, " ").trim();
  const cut = Array.from(clean).slice(0, DEVELOPER_TASK_TITLE_MAX).join("").trimEnd();
  return cut === "" ? "Untitled task" : cut;
}

/** The text of the last assistant message among a worker's events (pi's message_end), without thinking blocks. */
export function lastAssistantResponse(events: ReadonlyArray<{ payload: unknown }>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (!payload || typeof payload !== "object") continue;
    const event = payload as Record<string, unknown>;
    if (event.type !== "message_end" || !event.message || typeof event.message !== "object") continue;
    const message = event.message as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const content = block as Record<string, unknown>;
        return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
      })
      .join("\n")
      .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, "")
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

export interface ChangedFile { repository: string; path: string; added: number; removed: number }

/**
 * Changed files from the worker's workspace.diff artifact: per repository a "## <name>" section
 * with "### status" (git status --short) and "### diff" (git diff HEAD). Lines are counted only
 * inside hunks, so a removed line that starts with "--" is not taken for a file header.
 * Untracked files (status "??") are listed with no line counts, since git diff HEAD omits them.
 */
export function diffStat(diff: string, limit = 200): ChangedFile[] {
  const files: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];
  let repository = "";
  let section: "none" | "status" | "diff" = "none";
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const heading = /^## (\S+)$/.exec(line);
    if (heading) {
      repository = heading[1]!;
      section = "none";
      current = undefined;
      inHunk = false;
      continue;
    }
    if (line === "### status") { section = "status"; continue; }
    if (line === "### diff") { section = "diff"; continue; }
    if (section === "status") {
      const entry = /^\?\? (.+)$/.exec(line);
      if (entry) untracked.push({ repository, path: entry[1]!, added: 0, removed: 0 });
      continue;
    }
    if (section !== "diff") continue;
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      current = { repository, path: header[1]!, added: 0, removed: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  const byRepository = new Map<string, ChangedFile[]>();
  for (const file of [...files, ...untracked.filter((entry) => !files.some((file) => file.repository === entry.repository && file.path === entry.path))]) {
    byRepository.set(file.repository, [...(byRepository.get(file.repository) ?? []), file]);
  }
  return [...byRepository.values()].flat().slice(0, limit);
}
