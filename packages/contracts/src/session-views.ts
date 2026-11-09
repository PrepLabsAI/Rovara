import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AGENT_SESSION_CONTRACT_VERSION, SessionIdSchema, SESSION_KINDS, SESSION_MODES, SessionAgentSchema, SessionOwnerSchema, SessionStartedBySchema, SessionSummarySchema, SESSION_LEVELS, SessionActionSchema, SESSION_ACTIONS, SessionLegSchema, SESSION_LEGS_MAX, SessionAnchorRefSchema, SESSION_ANCHORS_MAX, LocalToolSchema, SESSION_SHARES_MAX, SessionWhereSchema, LIVE_FILTERS, LIVE_VIEWING_MAX, LIVE_PAGE_MAX, SessionEventSchema, SessionMessageSchema, SESSION_EVENTS_PAGE_MAX, SESSION_MESSAGES_PAGE_MAX } from "./agent-sessions.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";
import { ChainRunViewSchema } from "./chain-session.js";
import { forwardReader } from "./forward-reader.js";
import { TaskStatusSchema } from "./task-status.js";
import { ErrorRefSchema } from "./live-interaction.js";
import { AgentPrincipalSchema, AgentIdSchema } from "./agent.js";
import { ProjectStatusSchema, ProjectSetupStatusSchema, ProjectRoleSchema } from "./app-projects.js";

export const InstantSchema = z.string().datetime();

/** The most people `viewingNow` names. */
export const PRESENCE_VIEWERS_MAX = 20;

export const URL_MAX = 2048;

export const LinkSchema = z.string().url().max(URL_MAX);

export const CountSchema = z.number().int().min(0);

/** Where a session runs as a person is told: the cloud, or a Mac by its label (never its device id) and whether it is offline. */
export const SessionWhereViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud") }).strict(),
  z.object({ kind: z.literal("mac"), label: z.string().min(1).max(200), offline: z.boolean() }).strict(),
]);

export const PayerNameSchema = z.object({ kind: z.enum(["member", "project", "agent", "chain"]), name: z.string().min(1).max(200) }).strict();

/**
 * One person's reading of one session: the header, its cost, what they may do, and the work itself (`body`). A session on a Mac (`kind: "local"`) always costs 0 and has no payer: it runs on the
 * person's own machine and credentials, and a Mac can never report `paused` (a pause for budget is Rovara's, for cloud work). `approvals` are the caller's own
 * pending decisions on this session and `cost.paused.confirmUrl` is the link of a budget request they may decide: bare `/v1/app/approve/<id>`
 * links, never present for a person who may not decide, and never holding what is being approved (the confirmation page shows that).
 */
export const SessionViewSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    mode: z.enum(SESSION_MODES),
    title: z.string().min(1),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    agent: SessionAgentSchema.optional(),
    owner: SessionOwnerSchema,
    startedBy: SessionStartedBySchema,
    where: SessionWhereViewSchema,
    status: SessionSummarySchema.shape.status,
    step: SessionSummarySchema.shape.step,
    peek: SessionSummarySchema.shape.peek,
    lastRunFailed: SessionSummarySchema.shape.lastRunFailed,
    /** UX2 slice 2: where the work stands in the one status model, for this reader (a task's own `statusView`, a budget pause's next step says who can raise it). Absent from older servers. */
    display: TaskStatusSchema.optional(),
    /** Live interaction F1: what "Fix with agent" is about for this session (the task's error, when it shows one). Fixed codes and ids only. */
    errorRef: ErrorRefSchema.optional(),
    cost: z
      .object({
        spentUsd: z.number().min(0),
        runLimitUsd: z.number().min(0).optional(),
        stopAtUsd: z.number().min(0).optional(),
        payer: PayerNameSchema,
        paused: z.object({ scope: z.string().min(1).max(100), spendRequestId: z.string().min(1).max(100).optional(), confirmUrl: LinkSchema.optional() }).strict().optional(),
      })
      .strict(),
    approvals: z.array(z.object({ approvalId: z.string().min(1).max(100), title: z.string().min(1).max(300), confirmUrl: LinkSchema }).strict()).max(50),
    followers: CountSchema,
    viewingNow: z.array(SessionOwnerSchema).max(PRESENCE_VIEWERS_MAX),
    // `mayMerge`: set (true) only where the level alone would hide Merge from someone the server lets press it: a task's effective project maintainer or an org admin who reads it at `view`.
    you: z.object({ level: z.enum(SESSION_LEVELS), owner: z.boolean(), following: z.boolean(), actions: z.array(SessionActionSchema).max(SESSION_ACTIONS.length), mayMerge: z.literal(true).optional(),
      /** Live buttons: `ask` / `fix` are present (true) only when the install's switch is on AND the reader may use the feature on this session (the routes' own gate). Both absent: the key is left out. */
      live: z.object({ ask: z.literal(true).optional(), fix: z.literal(true).optional() }).strict().optional() }).strict(),
    link: LinkSchema,
    bindings: z.array(z.object({ kind: z.enum(["slack_thread", "linear_issue", "tracker_item"]), url: LinkSchema }).strict()).max(3),
    legs: z.array(SessionLegSchema).max(SESSION_LEGS_MAX),
    retryOf: SessionIdSchema.optional(),
    /** Task 10b: the parts of the work a comment can be pinned to (a paragraph of the plan, a step, a changed file) with the revision of each now. Absent when there are none. */
    anchors: z.array(SessionAnchorRefSchema).max(SESSION_ANCHORS_MAX).optional(),
    /** The session's revision: what a change to it (a take-over, a share) is asked against. */
    revision: CountSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("task"), task: DeveloperTaskViewSchema }).strict(),
      // Plan 4's run view. A gate's `confirmUrl` is optional in it: it is there for a person who may decide the gate and left out for anyone else.
      z.object({ kind: z.literal("chain"), chain: ChainRunViewSchema }).strict(),
      z.object({ kind: z.literal("local"), tool: LocalToolSchema }).strict(),
    ]),
  })
  .strict();

export type SessionView = z.infer<typeof SessionViewSchema>;

export const SessionViewReaderSchema = forwardReader(SessionViewSchema);

/** `GET /v1/app/sessions/{id}`. */
export const SessionResponseSchema = z.object({
  session: SessionViewSchema,
  /** Only on a Stop's answer: `NOTHING_RUNNING` when the stop found nothing to stop, so the page does not say "Stop requested". */
  stop: z.literal("NOTHING_RUNNING").optional(),
  /** With `stop`: why nothing was stopped, when the page should say more than "Nothing was running" (a blocked task is ended by Close task, not Stop). */
  message: z.string().max(500).optional(),
}).strict();

export const SessionResponseReaderSchema = forwardReader(SessionResponseSchema);

/**
 * What a not-closed close answer's `message` says in the cases the page acts on (the broker writes them, the web page compares with them, so a change of wording moves both): `checking` while the worker looks
 * for unpublished work, `computePending` once it found none and only the workspace's release is left, `discardPending` the same after a discard was asked for, and `checkFailed` / `stillOpen` when the check
 * ended without closing the task and only a NEW request id starts it again (the old id keeps answering with the old, ended check).
 */
export const CLOSE_MESSAGES = {
  checking: "AgentX is checking the task's workspace for unpublished work before closing it; check back with agentx_get_task",
  computePending: "the workspace has no unpublished work, but its compute is not removed yet; try agentx_close_task again shortly",
  discardPending: "AgentX recorded your request to discard unpublished work, but could not finish releasing the workspace; try agentx_close_task again shortly",
  checkFailed: "the check for unpublished work did not finish; try agentx_close_task again with a new request_id",
  stillOpen: "the task is still open; try agentx_close_task again with a new request_id",
} as const;

/**
 * `POST /v1/app/sessions/{id}/close`: the task's own close (the one the Slack button and the AI-tool close run), as the page needs it. `closed: false` with `unpublished` means the workspace holds work that
 * was never published and a close that discards it must be asked for again (`discardUnpublished: true`); `message` says why a task is not closed yet and what to do next.
 */
export const SessionCloseResponseSchema = z.object({
  session: SessionViewSchema,
  closed: z.boolean(),
  discardedUnpublished: z.boolean().optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) }).strict()).optional(),
  message: z.string().optional(),
}).strict();

export const SessionCloseResponseReaderSchema = forwardReader(SessionCloseResponseSchema);

/** `GET /v1/app/sessions/{id}/sections/{seq}/task`: a chain step's task, as the task view shows it. */
export const SessionStepTaskResponseSchema = z.object({ task: DeveloperTaskViewSchema }).strict();

export const SessionStepTaskResponseReaderSchema = forwardReader(SessionStepTaskResponseSchema);

/** One share on a session, as `GET .../shares` lists it. */
export const SessionShareSchema = z
  .object({
    principal: AgentPrincipalSchema,
    level: z.enum(SESSION_LEVELS),
    sharedBy: z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1) }).strict(),
    sharedAt: InstantSchema,
  })
  .strict();

export type SessionShare = z.infer<typeof SessionShareSchema>;

export const SessionShareReaderSchema = forwardReader(SessionShareSchema);

/** `GET /v1/app/sessions/{id}/shares`. */
export const SessionSharesResponseSchema = z.object({ shares: z.array(SessionShareSchema).max(SESSION_SHARES_MAX) }).strict();

export const SessionSharesResponseReaderSchema = forwardReader(SessionSharesResponseSchema);

/** `PUT /v1/app/sessions/{id}/shares` when it applies at once (a person or a project); a company-wide share answers `NeedsConfirmationSchema` with 202. */
export const SessionSharePutResponseSchema = z.object({ share: SessionShareSchema }).strict();

export const SessionSharePutResponseReaderSchema = forwardReader(SessionSharePutResponseSchema);

/** `DELETE /v1/app/sessions/{id}/shares/{principalKey}`. */
export const SessionShareDeleteResponseSchema = z.object({ removed: z.boolean() }).strict();

export const SessionShareDeleteResponseReaderSchema = forwardReader(SessionShareDeleteResponseSchema);

/** `POST` and `DELETE /v1/app/sessions/{id}/follow`: whether the caller follows now (the session's owner always does, with no item). */
export const SessionFollowResponseSchema = z.object({ following: z.boolean() }).strict();

export const SessionFollowResponseReaderSchema = forwardReader(SessionFollowResponseSchema);

/** `POST /v1/app/sessions/{id}/presence`: who is looking at the session now, counting this heartbeat. */
export const SessionPresenceResponseSchema = z.object({ viewingNow: z.array(SessionOwnerSchema).max(PRESENCE_VIEWERS_MAX) }).strict();

export const SessionPresenceResponseReaderSchema = forwardReader(SessionPresenceResponseSchema);

/** One session on the Live wall, a project page or a Home card: the header's short form. */
export const SessionTileSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    title: z.string().min(1),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    agent: SessionAgentSchema.optional(),
    owner: SessionOwnerSchema,
    where: SessionWhereSchema,
    level: z.enum(SESSION_LEVELS),
    revision: z.number().int().min(0),
    summary: SessionSummarySchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
  })
  .strict();

export type SessionTile = z.infer<typeof SessionTileSchema>;

export const SessionTileReaderSchema = forwardReader(SessionTileSchema);

// ---- the Live wall (Plan 5 Task 14)

/** The filter of `GET /v1/app/live`. */
export const LiveFilterSchema = z.enum(LIVE_FILTERS);

/**
 * One session on the Live wall, as one person sees it. Everything on it is read for that person now: `actions` is what they may do (the session view's `you.actions` without
 * `make_agent`), `approvalUrl` is the bare confirmation link of the first pending decision they may make (never present for anyone who may not decide, and never with a ticket),
 * `needsYou` says a decision or a plan waits on them, `following` that they follow it (the owner always does), and `viewingNow` names at most `LIVE_VIEWING_MAX` of the people
 * looking at it now, of whom there are `viewingNowCount`. `status`, `step`, `peek`, `lastRunFailed`, `costUsd` and `updatedAt` are the session summary's; a client keeps the tile
 * with the newer `updatedAt` when two answers cross.
 */
export const LiveTileSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    title: z.string().min(1),
    agent: SessionAgentSchema.optional(),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    owner: SessionOwnerSchema,
    where: SessionWhereViewSchema,
    status: SessionSummarySchema.shape.status,
    statusWords: z.string().min(1),
    step: SessionSummarySchema.shape.step,
    peek: SessionSummarySchema.shape.peek,
    lastRunFailed: SessionSummarySchema.shape.lastRunFailed,
    costUsd: SessionSummarySchema.shape.costUsd,
    viewingNow: z.array(SessionOwnerSchema).max(LIVE_VIEWING_MAX),
    viewingNowCount: CountSchema,
    needsYou: z.boolean(),
    following: z.boolean(),
    actions: z.array(SessionActionSchema).max(SESSION_ACTIONS.length),
    approvalUrl: LinkSchema.optional(),
    updatedAt: InstantSchema,
  })
  .strict();

export const LiveTileReaderSchema = forwardReader(LiveTileSchema);

/** `GET /v1/app/live?filter=&project=&cursor=`: one page of tiles, newest session first; `next` is opaque, passed back as `cursor`. */
export const LiveResponseSchema = z.object({ tiles: z.array(LiveTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();

export const LiveResponseReaderSchema = forwardReader(LiveResponseSchema);

/** `GET /v1/app/sessions`: one page of sessions, newest first; `next` is opaque, passed back as `cursor`. */
export const SessionListSchema = z.object({ sessions: z.array(SessionTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();

export type SessionList = z.infer<typeof SessionListSchema>;

export const SessionListReaderSchema = forwardReader(SessionListSchema);

export const DeveloperTaskViewReaderSchema = forwardReader(DeveloperTaskViewSchema);

export const SessionEventReaderSchema = forwardReader(SessionEventSchema);

export const SessionMessageReaderSchema = forwardReader(SessionMessageSchema);

/** A page of a session's timeline, oldest first. `next` is the last event's sort key (`<at>#<eventId>`); readers re-read a little before it and de-duplicate by `eventId`. */
export const SessionEventPageSchema = z
  .object({ events: z.array(SessionEventSchema).max(SESSION_EVENTS_PAGE_MAX), next: z.string().min(1).optional() })
  .strict();

export type SessionEventPage = z.infer<typeof SessionEventPageSchema>;

export const SessionEventPageReaderSchema = forwardReader(SessionEventPageSchema);

/**
 * A page of a session's conversation, oldest first: its own comments and, for a task session, the task page's (`source: "page"`). `next` is the cursor for the following read: the last
 * new message's `<createdAt>#<messageId>`. A read with a cursor starts with the few seconds of messages before it (at most `SESSION_MESSAGES_PAGE_MAX`), so one committed late is still
 * found: readers de-duplicate by `messageId`. An edit or a deletion shows on a read that reaches the message again (a reload); a cursor read gives it only while it is that recent.
 */
export const SessionMessagePageSchema = z
  .object({ messages: z.array(SessionMessageSchema).max(2 * SESSION_MESSAGES_PAGE_MAX), next: z.string().min(1).optional() })
  .strict();

export const SessionMessagePageReaderSchema = forwardReader(SessionMessagePageSchema);

// ---- the project page (Plan 5 Task 16; Home's shapes are in home.ts)

/** The most repositories, channels and agents a project page lists. */
export const PROJECT_OVERVIEW_REPOSITORIES_MAX = 50;

export const PROJECT_OVERVIEW_CHANNELS_MAX = 20;

export const PROJECT_OVERVIEW_AGENTS_MAX = 100;

/** The project's card: what it is, where its code is, how ready it is, and the Slack channels that reach it. */
export const ProjectOverviewProjectSchema = z
  .object({
    name: z.string().regex(AGENTX_NAME_PATTERN),
    description: z.string().max(2000).optional(),
    status: ProjectStatusSchema,
    latestRevision: z.number().int().positive().optional(),
    repositories: z.array(z.object({ fullName: z.string().min(1).max(200), defaultBranch: z.string().min(1).max(200) }).strict()).max(PROJECT_OVERVIEW_REPOSITORIES_MAX),
    setup: z
      .object({ status: ProjectSetupStatusSchema, checkedRevision: z.number().int().positive().optional(), checkedAt: InstantSchema.optional(), failedStep: z.string().max(300).optional() })
      .strict(),
    channels: z.array(z.string().min(1).max(40)).max(PROJECT_OVERVIEW_CHANNELS_MAX),
  })
  .strict();

/** What the reader may do on the project, from their role now: a flag is true only when the action is allowed. */
export const ProjectOverviewYouSchema = z
  .object({ role: ProjectRoleSchema, canStartWork: z.boolean(), canEditSettings: z.boolean(), canViewSpend: z.boolean() })
  .strict();

/** An agent on the project, with how many of the sessions the reader can see it is running now. */
export const ProjectOverviewAgentSchema = z
  .object({ agentId: AgentIdSchema, name: z.string().min(1).max(200), description: z.string().max(2000), running: z.number().int().min(0) })
  .strict();

/** The month's money on the project. Present only for a reader who may see the project's spend. `costPerMergedPullRequestUsd` is absent until a pull request has merged this month. */
export const ProjectOverviewBudgetSchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
    spentUsd: z.number().min(0),
    limitUsd: z.number().min(0).optional(),
    mergedPullRequests: z.number().int().min(0),
    costPerMergedPullRequestUsd: z.number().min(0).optional(),
  })
  .strict();

/**
 * The learning loop's block on a maintainer's project page (design 6.2, 6.4): this month's member corrections and how many of them repeated an earlier one, last month's share when it had enough
 * corrections, and the repeats of each rule that is still active ("same correction given twice, after a rule"). Counts and ids only; never a correction's or a rule's words.
 */
export const ProjectOverviewLearningSchema = z
  .object({
    thisMonth: z.object({ repeats: z.number().int().min(0), corrections: z.number().int().min(0), enoughData: z.boolean() }).strict(),
    lastMonthShare: z.number().min(0).max(1).optional(),
    repeatsAfterRule: z.array(z.object({ ruleId: z.string().min(1).max(100), stage: z.string().min(1).max(100), repeats: z.number().int().min(1) }).strict()).max(50),
    /** Present (as `500+`) only when the month's corrections read to count `repeatsAfterRule` hit the read cap, so those counts are at least what they say. */
    repeatsAfterRuleLabel: z.string().min(1).max(12).optional(),
    /** The company's master "suggestions" switch (optional: an absent field, from an older server, means `on`). `collecting`: corrections are kept, no suggestion is made. */
    suggestions: z.discriminatedUnion("state", [
      z.object({ state: z.literal("on") }).strict(),
      z.object({ state: z.literal("collecting"), corrections: z.number().int().min(0) }).strict(),
    ]).optional(),
  })
  .strict();
export type ProjectOverviewLearning = z.infer<typeof ProjectOverviewLearningSchema>;

/**
 * `GET /v1/app/projects/{name}/overview`: a project's page. Read now for the reader: a person with no role in the project gets `PROJECT_NOT_FOUND`; `budget` is present only for a reader
 * who may see spend; `agents` are the agents the reader may see; `running` is the Live wall's `team` filter for this project (at most one page of `LiveTile`s the reader can view).
 */
export const ProjectOverviewSchema = z
  .object({
    // Optional during rollout; mutation entry points require a company pin.
    orgId: OrgIdSchema.optional(),
    project: ProjectOverviewProjectSchema,
    you: ProjectOverviewYouSchema,
    agents: z.array(ProjectOverviewAgentSchema).max(PROJECT_OVERVIEW_AGENTS_MAX),
    budget: ProjectOverviewBudgetSchema.optional(),
    /** Present only for a project maintainer (a role that may edit the project's settings). */
    learning: ProjectOverviewLearningSchema.optional(),
    /** KF-1: present only for a project maintainer while the four test results are on (`vx`): how many tests are marked as already failing. The page shows the list (and Undo) only when this is present. */
    knownFailing: z.object({ count: z.number().int().min(0).max(500) }).strict().optional(),
    running: z.array(LiveTileSchema).max(LIVE_PAGE_MAX),
  })
  .strict();

export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>;

export const ProjectOverviewReaderSchema = forwardReader(ProjectOverviewSchema);

// ---- asking for a confirmation

export { SoleOwnerConfirmationSchema, NeedsConfirmationSchema, NeedsConfirmationReaderSchema, NEEDS_CONFIRMATION_CHANGES_MAX, CHANGE_TEXT_MAX, type NeedsConfirmation } from "./needs-confirmation.js";

/** Plan 7 Task 13c: a bounded, redacted page of an authorized session's PR files. */
export const DIFF_FILES_PAGE_MAX = 100;

export const DIFF_PATCH_MAX_BYTES = 65_536;

export const SessionDiffSchema = z.object({
 files: z.array(z.object({
  path: z.string().min(1).max(4096),
  status: z.enum(["added", "removed", "modified", "renamed"]),
  previousPath: z.string().max(4096).optional(),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  patch: z.string().refine(value => new TextEncoder().encode(value).length <= DIFF_PATCH_MAX_BYTES).optional(),
  patchOmitted: z.enum(["too_large", "binary"]).optional(),
 }).strict()).max(DIFF_FILES_PAGE_MAX),
 nextPage: z.number().int().positive().optional(),
 pullRequest: z.object({ repository: z.string(), number: z.number().int().positive(), url: z.string().url() }).strict(),
}).strict();

export type SessionDiff = z.infer<typeof SessionDiffSchema>;

export const SessionDiffReaderSchema = forwardReader(SessionDiffSchema);

export { forwardReader, type ForwardReader } from "./forward-reader.js";
