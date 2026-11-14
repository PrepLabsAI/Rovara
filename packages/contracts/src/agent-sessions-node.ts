import { emailSafeName } from "./display-name.js";
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { TriggerIdSchema } from "./chains.js";
import type { DeviceIdSchema, SessionMessageIdSchema, SessionEventIdSchema, SessionActionSchema, SessionStatusSchema, LocalToolSchema, SessionEventSchema, SessionAnchorSchema, SessionGoneAnchorSchema, SessionMessageSchema, AgentOriginViewSchema, SessionMakeAgentCopiedSchema, SessionMakeAgentBodySchema} from "./agent-sessions.js";
import { type SessionId, SESSION_KINDS, SESSION_MODES, SESSION_LEVELS, SessionSubjectSchema, SessionWhereSchema, SessionLegSchema, SessionSummarySchema, SessionOwnerSchema, SessionAgentSchema, SessionStartedBySchema, SessionIdSchema, SESSION_LEGS_MAX, lineText, SESSION_TITLE_MAX, CountSchema, InstantSchema, DeveloperIdSchema, LEVEL_WORDS } from "./agent-sessions.js";
import { createHash } from "node:crypto";
import { OrgIdSchema } from "./company-scope.js";
import { WorkOriginSchema, PayerSchema } from "./agent-run-node.js";
import { ApprovalIdSchema } from "./agent.js";
import { SessionBindingSchema, type SessionBinding } from "./browser-ids.js";

export const SESSION_MESSAGES_MAX = 1000;

export const STEER_RATE = { perPersonPerHour: 20, perSessionPerHour: 60 } as const;

export const LOCAL_REGISTER_SHARES_MAX = 10;

export const SESSION_FOLLOWERS_MAX = 200;

export const PRESENCE_TTL_SECONDS = 90;

export const LIVE_ENDED_KEEP_HOURS = 24;

/** The most Slack channel bindings of an org the project page reads to find a project's channels (a longer list is cut, and the cut is logged). */
export const SESSION_PROJECT_BINDINGS_MAX = 2000;

/** The most entries of a project's roster that a list of its agents reads (a longer roster is cut, and the cut is logged). */
export const PROJECT_ROSTER_LIST_MAX = 200;

export const LIVE_INDEX_SCAN_MAX = 1000;

export const HOME_FAILURE_DAYS = 7;

/** How long a session's own records stay (owner answer 8, 2026-10-22; a placeholder constant). */
export const SESSION_RETENTION_DAYS = 365;

export const CHANGES_FEED_DAYS = 7;

/**
 * How long the changes feed holds its cursor back (milliseconds). A feed item is stamped with the summary's `computedAt`, which is taken before the follower checks and the
 * write, and two writers (the broker and the outbox publisher) write it, so an item can land after a newer one was already read. `GET /v1/app/changes` therefore never
 * hands out a cursor newer than this far behind now: items inside the window come again on the next read.
 */
export const CHANGES_SETTLE_MS = 30_000;

export const CHANGES_PAGE_MAX = 500;

export const SESSION_SWEEP_PAGE = 100;

export const SESSION_SWEEP_BUDGET_MS = 20_000;

export const PROJECTOR_SESSIONS_PER_BATCH_MAX = 100;

export const PROJECTOR_CONCURRENCY = 8;

export const REALTIME_EVENTS_PER_PUBLISH = 5;

export const REALTIME_PUBLISH_DEADLINE_MS = 1000;

export const REALTIME_TOKEN_SECONDS = 900;

export const LOCAL_HEARTBEAT_SECONDS = 60;

export const LOCAL_OFFLINE_MINUTES = 10;

/** A Mac that has said nothing for this long has gone for good: its session ends `cancelled` (the session sweep finds it). */
export const LOCAL_ABANDONED_HOURS = 24;

/** The most turns in one update from a Mac: each is a `TURN#` item and a `local_turn` event, so 40 turns, the state, the device and the request stay under DynamoDB's 100 items in ONE transaction. */
export const LOCAL_UPDATE_TURNS_MAX = 40;

export const LOCAL_TURN_MAX_CHARS = 4000;

export const LOCAL_TURNS_MAX = 2000;

export const DEVICES_PER_MEMBER_MAX = 10;

export const HANDOFF_SUMMARY_MAX_BYTES = 8192;



/**
 * A person's or an agent's name as a session keeps it: control characters become spaces, every format character other than ZWNJ and ZWJ (bidi
 * controls, tag characters, soft hyphens, zero-width spaces) is dropped, and the rest is cleaned and cut to 80 characters between whole character
 * clusters. A ZWJ emoji, a Persian name with ZWNJ and a flag keep their meaning. `undefined` when nothing is left. The session schemas accept exactly
 * what this leaves alone, so a start that builds a record with this never fails on a name. An email address is never part of a name (release 0.4.16): a name
 * that is one is `undefined` (callers say "Someone" or "a member"), and one that holds one keeps the rest.
 */
export function cleanSessionName(name: string): string | undefined {
  return emailSafeName(name.replace(/\p{Cc}+/gu, " ").replace(/(?![\u200C\u200D])\p{Cf}/gu, ""));
}

const ProjectNameSchema = z.string().regex(AGENTX_NAME_PATTERN);

/** What started a run no person started (Plan 4's trigger dispatch passes it; Plan 5 records it on the session). */
export const SessionTriggerSchema = z.object({ kind: z.enum(["event", "schedule"]), triggerId: TriggerIdSchema }).strict();

export type SessionTrigger = z.infer<typeof SessionTriggerSchema>;

export type DeviceId = z.infer<typeof DeviceIdSchema>;

export type SessionMessageId = z.infer<typeof SessionMessageIdSchema>;

export type SessionEventId = z.infer<typeof SessionEventIdSchema>;

/**
 * The id of one event, the same every time the same occurrence is recorded: `"evt_" + sha256Hex(kind + "\n" + occurrence).slice(0, 24)`.
 * `occurrence` names what happened (a message id, an approval id, a source record and its time), so a retry writes the same key.
 */
export function sessionEventId(kind: string, occurrence: string): string {
  return `evt_${createHash("sha256").update(`${kind}\n${occurrence}`, "utf8").digest("hex").slice(0, 24)}`;
}

/** The link to a session: `<origin>/app/sessions/<sessionId>`, the one task address (UX2 slice 2; `/s/<id>` redirects there). */
export function sessionLink(origin: string, sessionId: SessionId): string {
  return `${origin.replace(/\/+$/u, "")}/app/sessions/${sessionId}`;
}

export const ENDED_SESSION_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export type SessionAction = z.infer<typeof SessionActionSchema>;

export const SessionKindSchema = z.enum(SESSION_KINDS);

export const SessionModeSchema = z.enum(SESSION_MODES);

export const SessionLevelSchema = z.enum(SESSION_LEVELS);

export type SessionKind = z.infer<typeof SessionKindSchema>;

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export type SessionMode = z.infer<typeof SessionModeSchema>;

export type LocalTool = z.infer<typeof LocalToolSchema>;

export type SessionLevel = (typeof SESSION_LEVELS)[number];

export type SessionSubject = z.infer<typeof SessionSubjectSchema>;

export type SessionWhere = z.infer<typeof SessionWhereSchema>;

export type SessionLeg = z.infer<typeof SessionLegSchema>;

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export type SessionOwner = z.infer<typeof SessionOwnerSchema>;

export type SessionAgent = z.infer<typeof SessionAgentSchema>;

export type SessionStartedBy = z.infer<typeof SessionStartedBySchema>;

/** The session's header, at `agentSessionKey(orgId, sessionId, "META")`. The work itself stays in the task, run and chain records. */
export const AgentSessionRecordSchema = z
  .object({
    orgId: OrgIdSchema,
    sessionId: SessionIdSchema,
    kind: SessionKindSchema,
    mode: SessionModeSchema,
    subject: SessionSubjectSchema,
    legs: z.array(SessionLegSchema).max(SESSION_LEGS_MAX),
    where: SessionWhereSchema,
    project: ProjectNameSchema.optional(),
    agent: SessionAgentSchema.optional(),
    title: lineText(SESSION_TITLE_MAX),
    owner: SessionOwnerSchema,
    startedBy: SessionStartedBySchema,
    origin: z.union([WorkOriginSchema, z.literal("local")]),
    payer: PayerSchema.optional(),
    retryOf: SessionIdSchema.optional(),
    followerCount: CountSchema,
    summary: SessionSummarySchema,
    summaryRevision: CountSchema,
    revision: CountSchema,
    /** The approval whose take-over last moved the owner (Plan 5 Task 12b): a handler called again for it finds the work done. */
    lastTakeOverApprovalId: ApprovalIdSchema.optional(),
    /** A move to a Mac under way (Task 19): set with the revision moving on, before the cloud task is cancelled, so a take-over decided on the old revision can't land between; gone when the move is done or past `until`. */
    moving: z.object({ requestId: z.string().uuid(), until: InstantSchema }).strict().optional(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
  })
  .strict();

export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;

export type SessionEvent = z.infer<typeof SessionEventSchema>;

export type SessionAnchor = z.infer<typeof SessionAnchorSchema>;

export type SessionGoneAnchor = z.infer<typeof SessionGoneAnchorSchema>;

export type SessionMessage = z.infer<typeof SessionMessageSchema>;

// Defined in browser-ids.ts (browser-safe contracts import it there); re-exported here for everything else.
export { SessionBindingSchema, type SessionBinding };

// ---- an agent remembers the task it was made from (Plan 5 Task 10c)

/**
 * Where an agent came from, as its draft stores it and each version published from the draft copies it: the session it was made from (and that session's task), who made it and when. The create-from-session
 * route sets it once; no other route can, and nothing edits it afterwards. Drafts and versions made before this have none.
 */
export const AgentOriginSchema = z
  .object({ kind: z.literal("session"), sessionId: SessionIdSchema, taskId: z.string().uuid().optional(), createdBy: DeveloperIdSchema, createdAt: InstantSchema })
  .strict();

export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

export type AgentOriginView = z.infer<typeof AgentOriginViewSchema>;

export type SessionMakeAgentCopied = z.infer<typeof SessionMakeAgentCopiedSchema>;

export type SessionMakeAgentBody = z.infer<typeof SessionMakeAgentBodySchema>;

// ---- what a refusal says (the codes are in errors.ts; the texts are exact)

export const SESSION_ENDED_MESSAGE = "This session has ended.";

export const SESSION_REVISION_CONFLICT_MESSAGE = "This session changed since you loaded it. Reload it and try again.";

/** SESSION_LEVEL_REQUIRED, for a person whose share is too low. `action` is a verb phrase such as "stop it". */
export function sessionLevelRequiredMessage(level: SessionLevel, action: string, owner: string): string {
  return `You need "${LEVEL_WORDS[level]}" on this session to ${action}. Ask ${owner} to share it with you.`;
}

/** SESSION_LEVEL_REQUIRED, for a viewer of the session's project. */
export function sessionViewerOnlyMessage(project: string): string {
  return `Viewers of ${project} can only watch its sessions.`;
}

/** SESSION_ON_MAC. */
export function sessionOnMacMessage(owner: string): string {
  return `This session runs on ${owner}'s Mac. Ask ${owner} to move it to the cloud first.`;
}

/** LOCAL_AGENT_NOT_ALLOWED, for a tool the company hasn't allowed. */
export function localToolNotAllowedMessage(tool: string): string {
  return `${tool} isn't allowed in your company. Ask an admin to allow it.`;
}

/** LOCAL_AGENT_NOT_ALLOWED, for a project that doesn't allow local agents. */
export function localAgentsNotAllowedOnProjectMessage(project: string): string {
  return `Local agents aren't allowed on ${project}. Ask an admin to allow them.`;
}

export { AGENT_SESSION_CONTRACT_VERSION, SESSION_TITLE_MAX, SESSION_PEEK_MAX_CHARS, SESSION_EVENT_TEXT_MAX, SESSION_EVENTS_PAGE_MAX, SESSION_MESSAGE_MAX_CHARS, SESSION_MESSAGES_PAGE_MAX, SESSION_LEGS_MAX, SESSION_NEEDS_PEOPLE_MAX, SESSION_SHARES_MAX, PRESENCE_HEARTBEAT_SECONDS, LIVE_PAGE_MAX, LIVE_VIEWING_MAX, LIVE_FILTERS, HOME_CARDS_MAX, HOME_CARD_BUTTONS_MAX, DEVICE_LABEL_MAX, NAME_MAX_CHARS, DIGEST_MAX, NEEDS_PERSON_MAX_CHARS, DELIVERY_REASON_MAX_CHARS, lineText, blockText, InstantSchema, DeveloperIdSchema, NAME_UNSAFE, PersonNameSchema, CountSchema, SESSION_ID_PATTERN, SessionIdSchema, DeviceIdSchema, SessionMessageIdSchema, SessionEventIdSchema, type SessionId, SESSION_KINDS, SESSION_STATUSES, STATUS_WORDS, SESSION_MODES, LOCAL_TOOLS, SESSION_LEVELS, SESSION_STATUS_WORDS, LEVEL_WORDS, SESSION_ACTIONS, SessionActionSchema, SessionStatusSchema, LocalToolSchema, SessionSubjectSchema, SessionWhereSchema, SessionLegSchema, SessionSummarySchema, SessionOwnerSchema, SessionAgentSchema, SessionStartedBySchema, SESSION_EVENT_TYPES, SESSION_EVENT_SOURCES, SessionEventSchema, SESSION_ANCHOR_TARGETS, SESSION_ANCHOR_STATES, SESSION_ANCHOR_EXCERPT_MAX, SESSION_ANCHORS_MAX, SessionAnchorRefSchema, type SessionAnchorRef, SessionAnchorSchema, SessionGoneAnchorSchema, SessionAnchorInputSchema, type SessionAnchorInput, SessionMessageSchema, AgentOriginViewSchema, MAKE_AGENT_NOT_COPIED_REASON, SessionMakeAgentCopiedSchema, SessionMakeAgentBodySchema } from "./agent-sessions.js";
