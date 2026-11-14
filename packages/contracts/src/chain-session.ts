// The one-session view data of a chain run (Plan 4 Task 10): what Plan 5's sessions read of a chain. A chain run is one session: `sessionId` is the run's
// own id. Version 1 is forward-compatible. What the server writes is strict (`…Schema`: it refuses what it does not know), and what a client reads is not
// (`…ReaderSchema`: every object keeps unknown fields and every enum reads a value a newer server added as "unknown"). The reader is derived from the strict
// schema, so the two cannot drift apart. Removing or renaming a key, or changing a type or a meaning, needs Plans 4 and 5 and a new version number; new optional
// fields, new event types and new statuses stay in version 1.
import { z } from "zod";
import { AgentIdSchema } from "./agent.js";
import { ChainIdSchema, ChainRunIdSchema, ChainRunStatusSchema, StepAttemptStatusSchema, StepLinkSchema, TriggerIdSchema } from "./chains.js";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { forwardReader } from "./forward-reader.js";

export const CHAIN_SESSION_CONTRACT_VERSION = 1 as const;

/** The most events one page of a run's event log holds. */
export const CHAIN_RUN_EVENTS_PAGE_MAX = 200;
/** The most runs one page of a list holds. */
export const CHAIN_RUN_LIST_PAGE_MAX = 50;
/** The longest an event's text may be, in characters. */
export const CHAIN_RUN_EVENT_TEXT_MAX = 500;

export const CHAIN_RUN_EVENT_TYPES = ["started", "step_started", "step_ended", "branch", "gate_waiting", "gate_decided", "retrying", "paused", "resumed", "ended"] as const;
export type ChainRunEventType = (typeof CHAIN_RUN_EVENT_TYPES)[number];
export const CHAIN_SECTION_KINDS = ["agent", "gate"] as const;
export const CHAIN_GATE_STATUSES = ["PENDING", "APPROVED", "DECLINED", "EXPIRED"] as const;

const Instant = z.string().datetime();
const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/);
const Name = z.string().min(1);
const ProjectName = z.string().regex(AGENTX_NAME_PATTERN);

// ---- what the server writes

const StartedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), developerId: DeveloperId, name: Name }).strict(),
  z.object({ kind: z.literal("event"), triggerId: TriggerIdSchema, source: z.string().min(1), type: z.string().min(1), title: Name, url: z.string().url().optional() }).strict(),
  z.object({ kind: z.literal("schedule"), triggerId: TriggerIdSchema, scheduledAt: Instant }).strict(),
]);

export const ChainRunSectionSchema = z
  .object({
    /** The attempt's sequence number in the run: sections are ordered by it, one per step attempt, never removed or reordered. */
    seq: z.number().int().min(1),
    stepId: z.string().min(1),
    name: Name,
    kind: z.enum(CHAIN_SECTION_KINDS),
    status: StepAttemptStatusSchema,
    /** Which visit of the step this is: 1 the first time, 2 the second (a loop, or a retry). */
    attempt: z.number().int().min(1),
    startedAt: Instant,
    endedAt: Instant.optional(),
    agent: z.object({ agentId: AgentIdSchema, name: Name, version: z.number().int().min(1) }).strict().optional(),
    /** What the step's task has settled so far. */
    costUsd: z.number().min(0).optional(),
    stopAtUsd: z.number().min(0).optional(),
    report: z.string().optional(),
    links: z.array(StepLinkSchema).optional(),
    pendingApprovals: z.number().int().min(0).optional(),
    branchTaken: z.object({ id: z.string().min(1), description: z.string(), fellBack: z.boolean() }).strict().optional(),
    gate: z
      .object({
        prompt: Name,
        status: z.enum(CHAIN_GATE_STATUSES),
        /** Who may decide, in words. */
        approvers: z.string(),
        /** The bare confirmation page of the gate's approval: never a ticketed link. Left out of what a session viewer is given. */
        confirmUrl: z.string().url().optional(),
        decidedBy: z.object({ developerId: DeveloperId, name: Name }).strict().optional(),
        decidedAt: Instant.optional(),
      })
      .strict()
      .optional(),
    /** The step's task, read through the chain-scoped read of its session data; `rovaraCode` marks the Rovara Code section that Plan 5 renders in full. */
    detail: z.object({ kind: z.literal("task"), taskId: z.string().min(1), rovaraCode: z.boolean() }).strict().optional(),
  })
  .strict();
export type ChainRunSection = z.infer<typeof ChainRunSectionSchema>;

export const ChainRunViewSchema = z
  .object({
    contractVersion: z.literal(CHAIN_SESSION_CONTRACT_VERSION),
    /** The run's own id. */
    sessionId: ChainRunIdSchema,
    kind: z.literal("chain"),
    chain: z.object({ chainId: ChainIdSchema, name: Name, version: z.number().int().min(1) }).strict(),
    project: ProjectName,
    /** Who owns the chain's design. */
    chainOwner: z.object({ kind: z.enum(["member", "project"]), id: Name, name: Name }).strict(),
    /** Who owns this run, and so every step's task. The one owner field of a run. */
    owner: z.object({ developerId: DeveloperId, name: Name }).strict(),
    startedBy: StartedBySchema,
    status: ChainRunStatusSchema,
    currentSeq: z.number().int().min(0),
    createdAt: Instant,
    updatedAt: Instant,
    endedAt: Instant.optional(),
    failure: z.object({ reason: z.string().min(1), message: z.string() }).strict().optional(),
    cost: z.object({ spentUsd: z.number().min(0), runLimitUsd: z.number().min(0) }).strict(),
    sections: z.array(ChainRunSectionSchema),
  })
  .strict();
export type ChainRunView = z.infer<typeof ChainRunViewSchema>;

export const ChainRunEventSchema = z
  .object({
    /** Append-only and gapless: 1, 2, 3. */
    seq: z.number().int().min(1),
    at: Instant,
    type: z.enum(CHAIN_RUN_EVENT_TYPES),
    stepSeq: z.number().int().min(1).optional(),
    text: z.string().refine((text) => [...text].length <= CHAIN_RUN_EVENT_TEXT_MAX, `must be at most ${String(CHAIN_RUN_EVENT_TEXT_MAX)} characters`),
  })
  .strict();
export type ChainRunEvent = z.infer<typeof ChainRunEventSchema>;

/** `GET /v1/app/chain-runs/{id}/events`: a page of the log; `next` is the last `seq` of the page when more follow (pass it back as `after`). */
export const ChainRunEventPageSchema = z.object({ events: z.array(ChainRunEventSchema).max(CHAIN_RUN_EVENTS_PAGE_MAX), next: z.number().int().min(1).optional() }).strict();
export type ChainRunEventPage = z.infer<typeof ChainRunEventPageSchema>;

/** `GET /v1/app/chain-runs/{id}/sections/{seq}/task`: a step's task as Plan 3's task view shows it, read for a reader of the run. */
export const ChainStepTaskViewSchema = z.object({ seq: z.number().int().min(1), taskId: z.string().min(1), rovaraCode: z.boolean(), task: DeveloperTaskViewSchema }).strict();
export type ChainStepTaskView = z.infer<typeof ChainStepTaskViewSchema>;

/** One run in a list: the header of the view, without its sections. */
export const ChainRunSummarySchema = z
  .object({
    contractVersion: z.literal(CHAIN_SESSION_CONTRACT_VERSION),
    sessionId: ChainRunIdSchema,
    kind: z.literal("chain"),
    chain: ChainRunViewSchema.shape.chain,
    project: ProjectName,
    owner: ChainRunViewSchema.shape.owner,
    status: ChainRunStatusSchema,
    currentSeq: z.number().int().min(0),
    createdAt: Instant,
    updatedAt: Instant,
    endedAt: Instant.optional(),
    cost: ChainRunViewSchema.shape.cost,
  })
  .strict();
export type ChainRunSummary = z.infer<typeof ChainRunSummarySchema>;

/** `GET /v1/app/chain-runs`: newest first; `next` is opaque, passed back as `cursor`. */
export const ChainRunListSchema = z.object({ runs: z.array(ChainRunSummarySchema).max(CHAIN_RUN_LIST_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();
export type ChainRunList = z.infer<typeof ChainRunListSchema>;

// ---- what clients read

export const ChainRunViewReaderSchema = forwardReader(ChainRunViewSchema);
export const ChainRunSectionReaderSchema = forwardReader(ChainRunSectionSchema);
export const ChainRunEventReaderSchema = forwardReader(ChainRunEventSchema);
export const ChainRunEventPageReaderSchema = forwardReader(ChainRunEventPageSchema);
export const ChainStepTaskViewReaderSchema = forwardReader(ChainStepTaskViewSchema);
export const ChainRunSummaryReaderSchema = forwardReader(ChainRunSummarySchema);
export const ChainRunListReaderSchema = forwardReader(ChainRunListSchema);
export type ChainRunViewReader = z.output<typeof ChainRunViewReaderSchema>;
