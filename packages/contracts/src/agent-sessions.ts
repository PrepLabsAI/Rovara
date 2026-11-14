import { z } from "zod";
import { TriggerIdSchema } from "./chains.js";
import { ChainRunIdSchema, SessionIdSchema, SESSION_ID_PATTERN, type SessionId } from "./browser-ids.js";
import { AgentIdSchema } from "./agent.js";
import { TaskStatusSchema } from "./task-status.js";

/**
 * The version of the shapes clients read (`SessionViewSchema`, `SessionTileSchema`, `SessionEventSchema`). Removing or renaming a key
 * there bumps it and needs Plans 5, 7 and 8; adding an optional key or a new enum value stays under the same version.
 */
export const AGENT_SESSION_CONTRACT_VERSION = 1;

// ---- limits

export const SESSION_TITLE_MAX = 200;

export const SESSION_PEEK_MAX_CHARS = 280;

export const SESSION_EVENT_TEXT_MAX = 500;

export const SESSION_EVENTS_PAGE_MAX = 200;

/** The same limit as a task page comment (`COMMENT_TEXT_MAX_CHARS`). */
export const SESSION_MESSAGE_MAX_CHARS = 2000;

/** New messages in one page of `GET …/messages`; a page with a cursor also repeats up to this many just before it (see `SessionMessagePageSchema`). */
export const SESSION_MESSAGES_PAGE_MAX = 100;

export const SESSION_LEGS_MAX = 20;

export const SESSION_NEEDS_PEOPLE_MAX = 50;

export const SESSION_SHARES_MAX = 50;

export const PRESENCE_HEARTBEAT_SECONDS = 30;

export const LIVE_PAGE_MAX = 100;

/** The people a Live tile names as looking at a session; `viewingNowCount` counts them all. */
export const LIVE_VIEWING_MAX = 5;

/** The filters of `GET /v1/app/live`. */
export const LIVE_FILTERS = ["all", "mine", "team", "needs_me", "failed"] as const;

export const HOME_CARDS_MAX = 10;

export const HOME_CARD_BUTTONS_MAX = 3;

export const DEVICE_LABEL_MAX = 60;

export const NAME_MAX_CHARS = 80;

export const DIGEST_MAX = 128;

export const NEEDS_PERSON_MAX_CHARS = 200;

export const DELIVERY_REASON_MAX_CHARS = 200;

export function lineText(max: number) {
  return z
    .string()
    .min(1)
    .refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");
}

export function blockText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
    .refine((value) => !/(?![\n\t\r])\p{Cc}/u.test(value), "must not contain control characters");
}

export const InstantSchema = z.string().datetime();

export const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const NAME_UNSAFE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;

export const PersonNameSchema = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= NAME_MAX_CHARS, `must be at most ${String(NAME_MAX_CHARS)} characters`)
  .refine((value) => !NAME_UNSAFE.test(value), "must not contain control characters");

export const CountSchema = z.number().int().min(0);

// SessionIdSchema and SESSION_ID_PATTERN are defined in browser-ids.ts (browser-safe contracts import them there) and re-exported here.
export { SessionIdSchema, SESSION_ID_PATTERN };

export const DeviceIdSchema = z.string().regex(/^dvc_[0-9a-z]{20}$/);

export const SessionMessageIdSchema = z.string().regex(/^msg_[0-9a-z]{20}$/);

export const SessionEventIdSchema = z.string().regex(/^evt_[0-9a-f]{24}$/);

export type { SessionId };

// ---- kinds, statuses, modes, tools, levels

export const SESSION_KINDS = ["task", "chain", "local"] as const;

export const SESSION_STATUSES = ["starting", "running", "needs_person", "paused", "waiting", "stopped", "succeeded", "failed", "cancelled"] as const;

/** What each status that isn't plain says to a person (a stopped or between-turn session stays open: owner answer 3). */
export const STATUS_WORDS = { waiting: "Waiting for you", stopped: "Stopped", paused: "Paused for budget", needs_person: "Needs a person" } as const;

/** Ask and Pair are later plans (owner answer 10); every session Plan 5 creates is `delegate`. */
export const SESSION_MODES = ["delegate"] as const;

export const LOCAL_TOOLS = ["rovara", "claude-code", "codex", "gemini-cli", "cursor-cli"] as const;

/** What a person may do on a session; compared with `atLeast` from agent.ts (view < use < edit). */
export const SESSION_LEVELS = ["view", "use", "edit"] as const;

/** What a status says in one or two words on a tile, with no colour or icon to carry it: the fixed words of `STATUS_WORDS` where there are some, else the status plainly. */
export const SESSION_STATUS_WORDS: Record<(typeof SESSION_STATUSES)[number], string> = {
  starting: "Starting", running: "Running", needs_person: STATUS_WORDS.needs_person, paused: STATUS_WORDS.paused, waiting: STATUS_WORDS.waiting, stopped: STATUS_WORDS.stopped,
  succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};

export const LEVEL_WORDS = { view: "can view", use: "can use", edit: "can edit" } as const;

/** What a person may do on a session (`sessionActionsFor` in the broker decides who gets which; `make_agent` is added when the person may create agents in the session's project, checked live as the route checks it; `close` is the task owner's, on a task session that is still open). */
export const SESSION_ACTIONS = ["watch", "comment", "steer", "stop", "retry", "take_over", "share", "handoff", "make_agent", "close"] as const;

export const SessionActionSchema = z.enum(SESSION_ACTIONS);

export const SessionStatusSchema = z.enum(SESSION_STATUSES);

export const LocalToolSchema = z.enum(LOCAL_TOOLS);

// ---- the record and its parts

/** What the session is about: a Rovara Code or agent task, a chain run, or a local agent on a Mac. */
export const SessionSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("chain"), chainRunId: ChainRunIdSchema }).strict(),
  z.object({ kind: z.literal("local"), deviceId: DeviceIdSchema, tool: LocalToolSchema }).strict(),
]);

/** Where it runs now. */
export const SessionWhereSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud") }).strict(),
  z.object({ kind: z.literal("mac"), deviceId: DeviceIdSchema, label: lineText(DEVICE_LABEL_MAX) }).strict(),
]);

/** One stretch of a session on one place; a move between a Mac and the cloud starts a new leg (owner answer 11). */
export const SessionLegSchema = z
  .object({
    seq: z.number().int().min(0),
    subject: SessionSubjectSchema,
    where: SessionWhereSchema,
    startedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
    endedBy: z.enum(["handoff", "end"]).optional(),
  })
  .strict();

/** What Live, Home and the header show; recomputed from the source records, redacted, and never moved backwards (Task 7a). */
export const SessionSummarySchema = z
  .object({
    status: SessionStatusSchema,
    step: lineText(SESSION_TITLE_MAX).optional(),
    peek: blockText(SESSION_PEEK_MAX_CHARS).optional(),
    lastRunFailed: z.literal(true).optional(),
    /** The task's workflow is `BLOCKED` (it shows as `needs_person`): the session can be retried through Plan 3's workflow retry. Absent in summaries written before this existed. */
    workflowBlocked: z.literal(true).optional(),
    /** What the session cost Rovara. Always 0 for a session on a Mac: it runs on the person's own machine and credentials, and a Mac can't report `paused`. */
    costUsd: z.number().min(0),
    runLimitUsd: z.number().min(0).optional(),
    stopAtUsd: z.number().min(0).optional(),
    needsPeople: z.array(lineText(NEEDS_PERSON_MAX_CHARS)).max(SESSION_NEEDS_PEOPLE_MAX),
    pendingApprovals: CountSchema,
    offline: z.literal(true).optional(),
    /** UX2 slice 2: where the work stands in the one status model (`task-status.ts`): state, reason and next step. Absent in summaries written before it (readers use `sessionTaskStatus`). */
    display: TaskStatusSchema.optional(),
    digest: z.string().min(1).max(DIGEST_MAX),
    computedAt: InstantSchema,
  })
  .strict();

export const SessionOwnerSchema = z.object({ developerId: DeveloperIdSchema, name: PersonNameSchema }).strict();

export const SessionAgentSchema = z
  .object({ agentId: AgentIdSchema, name: PersonNameSchema, version: z.union([z.number().int().min(1), z.literal("draft")]) })
  .strict();

export const SessionStartedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), developerId: DeveloperIdSchema }).strict(),
  z.object({ kind: z.literal("event"), triggerId: TriggerIdSchema }).strict(),
  z.object({ kind: z.literal("schedule"), triggerId: TriggerIdSchema }).strict(),
  z.object({ kind: z.literal("local") }).strict(),
]);

// ---- events and messages

export const SESSION_EVENT_TYPES = [
  "started", "status", "step", "comment", "steer", "steer_delivered", "steer_not_delivered", "take_over", "stopped", "retried", "shared", "handoff", "local_turn", "ended",
] as const;

export const SESSION_EVENT_SOURCES = ["app", "slack", "linear", "mac", "page"] as const;

/**
 * One line of a session's timeline, at `EVENT#<at>#<eventId>`. Events are ordered by `at`, then `eventId`; a page's cursor is the last item's
 * sort key. Once early events expire, the first readable event may come after `started` (owner answer 8).
 */
export const SessionEventSchema = z
  .object({
    eventId: SessionEventIdSchema,
    at: InstantSchema,
    type: z.enum(SESSION_EVENT_TYPES),
    actor: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("member"), developerId: DeveloperIdSchema, name: PersonNameSchema }).strict(),
        z.object({ kind: z.literal("agent") }).strict(),
        z.object({ kind: z.literal("system") }).strict(),
      ])
      .optional(),
    source: z.enum(SESSION_EVENT_SOURCES).optional(),
    messageId: SessionMessageIdSchema.optional(),
    text: blockText(SESSION_EVENT_TEXT_MAX),
  })
  .strict();

// ---- comments pinned to a part of the session (Plan 5 Task 10b)

/** The parts of a session a comment can be pinned to, each with a stable id in the session view: a paragraph of the plan (`p1`, `p2`, ...), a step of an agent run, a file in the changes. */
export const SESSION_ANCHOR_TARGETS = ["plan_block", "step", "change_file"] as const;

/** What a pinned comment says about its part now: `current` (the part is as the person saw it), `outdated` (it changed) or `gone` (it is not in the reader's view). */
export const SESSION_ANCHOR_STATES = ["current", "outdated", "gone"] as const;

export const SESSION_ANCHOR_EXCERPT_MAX = 200;

/** The most parts a session view lists for pinning: 200 plan paragraphs, 100 steps and 300 changed files. */
export const SESSION_ANCHORS_MAX = 600;

export const ANCHOR_ID_MAX_CHARS = 300;

export const ANCHOR_REVISION_MAX_CHARS = 64;

/** A part of the session and the revision of it now, as the session view lists it (`plan_block`: `v<plan version>`; `step`: the step's status; `change_file`: `+<added>-<removed>`). */
export const SessionAnchorRefSchema = z
  .object({ target: z.enum(SESSION_ANCHOR_TARGETS), targetId: lineText(ANCHOR_ID_MAX_CHARS), revision: lineText(ANCHOR_REVISION_MAX_CHARS) })
  .strict();

export type SessionAnchorRef = z.infer<typeof SessionAnchorRefSchema>;

/** A pinned comment's anchor as it is stored and read: the part, the revision the person was looking at, and the excerpt they quoted (display only; redacted when stored). */
export const SessionAnchorSchema = z
  .object({ target: z.enum(SESSION_ANCHOR_TARGETS), targetId: lineText(ANCHOR_ID_MAX_CHARS), revision: lineText(ANCHOR_REVISION_MAX_CHARS), excerpt: lineText(SESSION_ANCHOR_EXCERPT_MAX).optional() })
  .strict();

/** A pinned comment's anchor for a reader who can't see the part now (`anchorState: "gone"`): only the kind of part. No id (a changed file's id is its path), no revision and no excerpt. */
export const SessionGoneAnchorSchema = z.object({ target: z.enum(SESSION_ANCHOR_TARGETS) }).strict();

/** The anchor a client sends: the same, with an excerpt of any characters (at most 200), which the server cleans, redacts and flattens to one line before it stores it. */
export const SessionAnchorInputSchema = z
  .object({
    target: z.enum(SESSION_ANCHOR_TARGETS),
    targetId: lineText(ANCHOR_ID_MAX_CHARS),
    revision: lineText(ANCHOR_REVISION_MAX_CHARS),
    excerpt: z.string().refine((value) => [...value].length <= SESSION_ANCHOR_EXCERPT_MAX, `must be at most ${String(SESSION_ANCHOR_EXCERPT_MAX)} characters`).optional(),
  })
  .strict();

export type SessionAnchorInput = z.infer<typeof SessionAnchorInputSchema>;

/** A comment (for people only) or a message to the agent (needs "can use"), at `MESSAGE#<messageId>`. */
export const SessionMessageSchema = z
  .object({
    messageId: SessionMessageIdSchema,
    sessionId: SessionIdSchema,
    kind: z.enum(["comment", "steer"]),
    source: z.enum(["app", "slack", "linear", "page"]),
    author: z.object({ developerId: DeveloperIdSchema, name: PersonNameSchema }).strict(),
    text: blockText(SESSION_MESSAGE_MAX_CHARS, 1),
    createdAt: InstantSchema,
    editedAt: InstantSchema.optional(),
    deletedAt: InstantSchema.optional(),
    rev: CountSchema,
    delivery: z
      .object({ state: z.enum(["queued", "delivered", "not_delivered"]), at: InstantSchema, reason: lineText(DELIVERY_REASON_MAX_CHARS).optional() })
      .strict()
      .optional(),
    /** Task 10b, comments only: the part of the session the comment is pinned to. A reply holds its thread's anchor (without the excerpt). A reader who can't see the part reads only `{ target }` (`anchorState: "gone"`). */
    anchor: z.union([SessionAnchorSchema, SessionGoneAnchorSchema]).optional(),
    /** Task 10b, on a read only (never stored): what the part is now, for the reader. */
    anchorState: z.enum(SESSION_ANCHOR_STATES).optional(),
    /** Task 10b, comments only: a reply holds the id of the first message of its thread. */
    threadId: SessionMessageIdSchema.optional(),
  })
  .strict()
  .refine((message) => message.kind === "comment" || (message.anchor === undefined && message.anchorState === undefined && message.threadId === undefined), { message: "only a comment can be pinned or threaded", path: ["kind"] });

/**
 * An origin as a person reads it on a draft or a version, worked out live for them: with the session (its title and link) when they may read that session now; otherwise only `{ kind: "session", visible: false }`,
 * with no id, no title, no person and no time, and the same once the session is deleted or past its retention.
 */
export const AgentOriginViewSchema = z.union([
  z
    .object({ kind: z.literal("session"), visible: z.literal(true), sessionId: SessionIdSchema, taskId: z.string().uuid().optional(), title: lineText(SESSION_TITLE_MAX), link: z.string().url().max(2048), createdBy: DeveloperIdSchema, createdAt: InstantSchema })
    .strict(),
  z.object({ kind: z.literal("session"), visible: z.literal(false) }).strict(),
]);

/** The fixed reason `POST /v1/app/sessions/{id}/agent` gives with `copied: false`: the caller can't use the session's agent now (not shared with them, not published, archived or turned off), so the draft is built from nothing. Never the agent's id or name. */
export const MAKE_AGENT_NOT_COPIED_REASON = "AGENT_NOT_USABLE" as const;

/** What the 201 says about the session's agent: `copied: true`, or `copied: false` with the reason. */
export const SessionMakeAgentCopiedSchema = z.union([z.object({ copied: z.literal(true) }).strict(), z.object({ copied: z.literal(false), reason: z.literal(MAKE_AGENT_NOT_COPIED_REASON) }).strict()]);

/** `POST /v1/app/sessions/{id}/agent`: the name is the session's title when left out. The project, the agent kind and the goal come from the session; nothing else is taken from the body. */
export const SessionMakeAgentBodySchema = z.object({ requestId: z.string().uuid(), name: z.string().optional() }).strict();
