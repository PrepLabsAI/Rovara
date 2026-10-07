// Spec 025 phase 25b: the developer task API's names and wire shapes. Requests are strict; the MCP
// server parses responses with the non-strict schemas here, so a newer control plane can add fields.
import { Buffer } from "node:buffer";
import { z } from "zod";
import { cleanDisplayName } from "./display-name.js";
import { OperationStatusSchema } from "./operation.js";
import { DeveloperShareModeSchema } from "./project.js";
import { sharedNoticeKey, slackThreadSubject, type SlackThread } from "./slack.js";
import { WORKFLOW_PLAN_MAX_BYTES, WorkflowSnapshotSchema } from "./task-workflow.js";
import { WorkflowPathSchema } from "./task-workflow.js";

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

/** Spec 025 phase 25c: sharing a task to its Slack channel (FR-031 to FR-035, FR-054). */
export const DEVELOPER_SHARE_SUMMARY_MAX = 1_500;
export const SHARED_THREAD_NOTICE_INTERVAL_SECONDS = 3_600;
export const CHANNEL_TURN_WAIT_MS = 30 * 60_000;
export const SHARE_DELIVERY_WINDOW_MS = 60 * 60_000;
export const CHANNEL_TURNS_MAX = 20;
export const CHANNEL_TURN_REQUEST_MAX = 300;
/** FR-031: the reasons a result gives when the project's policy changed what was asked. */
export const SHARED_BY_POLICY = "required by project";
export const VIEW_ONLY_BY_POLICY = "continue not allowed by project";
/**
 * Q10 and its fail-closed rule: the two share refusals whose next step is their own, not their
 * code's generic one (final review M6). The broker sends the message; the MCP server matches it.
 */
export const PRIVATE_CHANNEL_NOT_A_MEMBER = "you are not a member of that private channel; join it first, or share to one of the project's public channels";
export const PRIVATE_CHANNEL_NOT_A_MEMBER_STEP = "join that private channel in Slack, or send channel with one of the project's public channels";
export const CHANNEL_PRIVACY_NOT_SET_UP = "AgentX cannot tell whether that channel is private; ask your AgentX admin to finish the Slack setup, or share to a channel you are a member of";
export const CHANNEL_PRIVACY_NOT_SET_UP_STEP = "ask your AgentX admin to finish the Slack setup, or send channel with a channel you are a member of";
/** FR-035 and US3 scenario 4: the fixed notices in a shared thread (Q1, Q3). */
export const VIEW_ONLY_NOTICE =
  "This thread follows a task that a developer is driving from their AI tool, so I don't act on messages here. To ask AgentX for something, post a new message in the channel; it starts its own thread workspace.";
export const CLOSED_SHARED_NOTICE =
  "The task this thread followed is closed, so I don't act on messages here. To ask AgentX for something, post a new message in the channel; it starts its own thread workspace.";

/** Which fixed notice a claim is for: the view-only one, or a closed task's (Q3). */
export type SharedNoticeKind = "view" | "closed";

/**
 * C10, F13: the conditional Update that claims a shared thread's hourly notice. The Slack ingress
 * and the Slack service both send it, so "one notice an hour" is the same claim in both. It succeeds
 * for at most one caller per thread per interval and notice kind; a later caller gets
 * ConditionalCheckFailedException. Each kind has its own time on the one item (the live check found
 * a closed notice swallowed by a view-only one sent 18 minutes before), so a thread whose task
 * closes still hears so once. A marker from before the kinds holds `noticedAt` only, which is the
 * view-only time. A closed claim, however old, refuses every later view-only claim (closed wins).
 * The marker expires after two intervals.
 */
export function sharedNoticeClaim(subject: string, nowSeconds: number, kind: SharedNoticeKind): {
  Key: { pk: string; sk: "SHARED_NOTICE" };
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeValues: { ":now": number; ":expires": number; ":cutoff": number };
} {
  const at = kind === "closed" ? "closedNoticedAt" : "noticedAt";
  return {
    Key: sharedNoticeKey(subject),
    UpdateExpression: `SET ${at} = :now, expiresAt = :expires`,
    // Closed wins: once a closed notice was claimed, the view-only notice is never claimed again.
    ConditionExpression: kind === "closed"
      ? "attribute_not_exists(closedNoticedAt) OR closedNoticedAt <= :cutoff"
      : "attribute_not_exists(closedNoticedAt) AND (attribute_not_exists(noticedAt) OR noticedAt <= :cutoff)",
    ExpressionAttributeValues: {
      ":now": nowSeconds,
      ":expires": nowSeconds + 2 * SHARED_THREAD_NOTICE_INTERVAL_SECONDS,
      ":cutoff": nowSeconds - SHARED_THREAD_NOTICE_INTERVAL_SECONDS,
    },
  };
}

export const DeveloperTaskShareSchema = z.object({
  mode: DeveloperShareModeSchema,
  channelId: z.string(),
  /** A public channel's name only (R10). */
  channelName: z.string().optional(),
  sharedReason: z.enum(["requested", "required"]),
  modeReason: z.literal("continue_not_allowed").optional(),
  /** Absent while the notifier has not posted the start message yet (C6). */
  threadUrl: z.string().url().optional(),
  /** The start message could not be posted within an hour (C9). */
  postFailed: z.boolean().optional(),
});
export type DeveloperTaskShare = z.infer<typeof DeveloperTaskShareSchema>;

/** C15: one Slack turn a teammate ran on the task in its shared thread. */
export const ChannelTurnSchema = z.object({
  author: z.object({ slackUserId: z.string(), name: z.string().optional() }),
  at: z.string().datetime(),
  request: z.string().max(CHANNEL_TURN_REQUEST_MAX),
  outcome: z.string(),
});
export type ChannelTurn = z.infer<typeof ChannelTurnSchema>;

export const ShareDeveloperTaskRequestSchema = z
  .object({ requestId: z.string().uuid(), shareMode: DeveloperShareModeSchema.optional(), channel: z.string().min(1).max(80).optional() })
  .strict();
export type ShareDeveloperTaskRequest = z.infer<typeof ShareDeveloperTaskRequestSchema>;

/** C25: an AgentX admin switches a shared task's mode; no channel, no first share. */
export const AdminShareModeRequestSchema = z.object({ requestId: z.string().uuid(), shareMode: DeveloperShareModeSchema }).strict();
export type AdminShareModeRequest = z.infer<typeof AdminShareModeRequestSchema>;

/** C2: the shared thread record, read by the Slack ingress and the broker's service identity. */
export function sharedTaskKey(thread: SlackThread): { pk: string; sk: "META" } {
  return { pk: `SHARED_TASK#${slackThreadSubject(thread)}`, sk: "META" };
}
export const SharedTaskRecordSchema = z.object({
  taskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  developerId: z.string().regex(/^[a-f0-9]{64}$/),
  developerName: z.string().min(1).max(200),
  project: z.string().min(1).max(63),
  mode: DeveloperShareModeSchema,
  sharedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});
export type SharedTaskRecord = z.infer<typeof SharedTaskRecordSchema>;

export const DeveloperTaskStatusSchema = z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);
export type DeveloperTaskStatus = z.infer<typeof DeveloperTaskStatusSchema>;
export const ENDED_TASK_STATUSES: ReadonlySet<DeveloperTaskStatus> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);

export const DeveloperTaskFailureCategorySchema = z.enum(["setup_failed", "worker_unavailable", "task_failed", "timed_out", "interrupted", "publication_failed"]);
export type DeveloperTaskFailureCategory = z.infer<typeof DeveloperTaskFailureCategorySchema>;
/** #154: where a failure happened. "setup" means the workspace was never set up, so the task
 * cannot be continued. Optional (a control plane that predates it sends none), and a stage this
 * release does not know is dropped rather than refusing the view. */
export const DeveloperTaskFailureStageSchema = z.enum(["setup"]);
export type DeveloperTaskFailureStage = z.infer<typeof DeveloperTaskFailureStageSchema>;
export const DeveloperTaskFailureSchema = z.object({
  category: DeveloperTaskFailureCategorySchema,
  stage: DeveloperTaskFailureStageSchema.optional().catch(undefined),
  message: z.string().max(DEVELOPER_FAILURE_MESSAGE_MAX),
});
export type DeveloperTaskFailure = z.infer<typeof DeveloperTaskFailureSchema>;

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
    // FR-031: sharing. share_to_channel, or a project whose share is required, shares the task.
    shareToChannel: z.boolean().optional(),
    shareMode: DeveloperShareModeSchema.optional(),
    channel: z.string().min(1).max(80).optional(),
    /** Opts this task into the native human-gated task-to-PR workflow. */
    workflow: z.literal(true).optional(),
    /** Selects the required approval sequence for a native workflow. */
    workflowPath: WorkflowPathSchema.optional(),
  })
  .strict().superRefine((request, context) => {
    if (request.workflowPath !== undefined && request.workflow !== true) context.addIssue({ code: "custom", path: ["workflowPath"], message: "workflowPath requires workflow: true" });
    if (request.workflow === true && request.workflowPath === undefined) context.addIssue({ code: "custom", path: ["workflowPath"], message: "workflow requests require an explicit Quick or Full path" });
  });
export type StartDeveloperTaskRequest = z.infer<typeof StartDeveloperTaskRequestSchema>;

export const ContinueDeveloperTaskRequestSchema = z.object({
  requestId: RequestIdSchema,
  instructions: DeveloperInstructionsSchema,
  /** Optional revision fence for a retry initiated from a staleable UI action. */
  expectedRevision: z.number().int().positive().optional(),
  /** Owner-selected, project-approved optional checks for a blocked verification retry. */
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20).optional(),
}).strict().superRefine((request, context) => {
  if (request.selectedOptionalCheckIds !== undefined && new Set(request.selectedOptionalCheckIds).size !== request.selectedOptionalCheckIds.length) {
    context.addIssue({ code: "custom", path: ["selectedOptionalCheckIds"], message: "selected optional checks must be unique" });
  }
});
export type ContinueDeveloperTaskRequest = z.infer<typeof ContinueDeveloperTaskRequestSchema>;

export const DeveloperTaskActionRequestSchema = z.object({ requestId: RequestIdSchema }).strict();
export type DeveloperTaskActionRequest = z.infer<typeof DeveloperTaskActionRequestSchema>;
export const DeveloperTaskCloseRequestSchema = z.object({ requestId: RequestIdSchema, discard_unpublished: z.boolean().optional() }).strict();
export type DeveloperTaskCloseRequest = z.infer<typeof DeveloperTaskCloseRequestSchema>;

export const CanvasCloseoutRetryRequestSchema = z.object({ requestId: RequestIdSchema, workflowRevision: z.number().int().positive(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type CanvasCloseoutRetryRequest = z.infer<typeof CanvasCloseoutRetryRequestSchema>;

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
  workflow: WorkflowSnapshotSchema.extend({ planContent: z.string().max(WORKFLOW_PLAN_MAX_BYTES).optional() }).optional(),
  failure: DeveloperTaskFailureSchema.optional(),
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
  /** C1: how the task is shared; absent for a private task. */
  share: DeveloperTaskShareSchema.optional(),
  /** C15: the shared thread's channel turns on this task, newest first. */
  channelTurns: z.array(ChannelTurnSchema).max(CHANNEL_TURNS_MAX).optional(),
});
export type DeveloperTaskView = z.infer<typeof DeveloperTaskViewSchema>;

export const DeveloperTaskListItemSchema = DeveloperTaskViewSchema.pick({ taskId: true, title: true, project: true, status: true, shared: true, createdAt: true, updatedAt: true });
export type DeveloperTaskListItem = z.infer<typeof DeveloperTaskListItemSchema>;
/** `nextCursor` is opaque: pass it back as `cursor` for the next page; it is absent on the last page. */
export const DeveloperTaskListResponseSchema = z.object({ tasks: z.array(DeveloperTaskListItemSchema), nextCursor: z.string().optional() });
export const DeveloperTaskResponseSchema = z.object({ task: DeveloperTaskViewSchema });
export const DeveloperCloseResponseSchema = z.object({
  task: DeveloperTaskViewSchema,
  closed: z.boolean(),
  discardedUnpublished: z.boolean().optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  /** Present whenever `closed` is false: why the task is not closed yet, and what to do next. */
  message: z.string().optional(),
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
 * with "### status" (git status --short) and "### diff" (git diff against the commit the workspace
 * was prepared at, or HEAD with a note when that commit is gone, #208). Lines are counted only
 * inside hunks, so a removed line that starts with "--" is not taken for a file header.
 * Untracked files (status "??") are listed with no line counts, since git diff omits them.
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
