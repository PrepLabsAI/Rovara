// Chains (Plan 4): a design of agent steps and gates joined by edges, the result a step leaves behind, the
// states of a run, who started it, and the ids and limits that bound all of it. Every schema is strict, so a
// design cannot carry a field that reaches the safety layer (tools, prompts, models); each agent step uses only
// its own pinned agent's permissions. The keys these records live under are in org-scoped-keys.ts.
import { z } from "zod";
import { AgentIdSchema } from "./agent.js";
import { ChainRunIdSchema, type ChainRunId } from "./browser-ids.js";
import { AGENT_REPORT_MAX_BYTES, RUN_INPUT_BODY_MAX_BYTES, RUN_INPUT_CONTEXT_MAX, RUN_INPUT_TITLE_MAX } from "./agent-run.js";
import { APPROVAL_PROMPT_MAX, STEP_NAME_MAX, StepIdSchema } from "./agent-recipe.js";
import { MAX_RUN_LIMIT_USD } from "./run-estimate.js";

// ---- ids

export const ChainIdSchema = z.string().regex(/^chn_[0-9a-z]{20}$/);
export { ChainRunIdSchema, type ChainRunId }; // defined in browser-ids.ts, which browser-safe contracts import
/** A trigger's id. Triggers themselves are Plan 4 Task 18; a run records the trigger that started it. */
export const TriggerIdSchema = z.string().regex(/^ctr_[0-9a-z]{20}$/);
/** Plan 3's step id (`ResultContract` branch ids use it too): a lower-case letter, then at most 23 of `a-z0-9_`. `"$end"` is not one. */
export const ChainStepIdSchema = StepIdSchema;
export const BranchIdSchema = StepIdSchema;

export type ChainId = z.infer<typeof ChainIdSchema>;
export type TriggerId = z.infer<typeof TriggerIdSchema>;
export type ChainStepId = z.infer<typeof ChainStepIdSchema>;
export type BranchId = z.infer<typeof BranchIdSchema>;

// ---- limits (the exact names the plan uses; trigger and hook limits are in triggers.ts)

export const CHAIN_MAX_STEPS = 20;
export const CHAIN_MAX_BRANCHES = 6;
export const CHAIN_MAX_TRAVERSALS = 5;
export const CHAIN_MAX_STEP_RUNS = 30;
export const STEP_INSTRUCTIONS_MAX_BYTES = 4096;
export const CHAIN_START_INPUT_MAX = 8000;
/** A hand-off is Plan 3's `RunInput.context`: at most 10 items of at most 16,384 bytes each. */
export const HANDOFF_MAX_ITEMS = RUN_INPUT_CONTEXT_MAX;
export const HANDOFF_ITEM_MAX_BYTES = RUN_INPUT_BODY_MAX_BYTES;
export const HANDOFF_MAX_BYTES = 65_536;
/** A step's report is Plan 3's report size. */
export const REPORT_MAX_BYTES = AGENT_REPORT_MAX_BYTES;
export const STEP_LINKS_MAX = 20;
export const GATE_DEFAULT_TIMEOUT_HOURS = 72;
export const GATE_MAX_TIMEOUT_HOURS = 336;
export const STEP_RETRIES_MAX = 2;
export const STEP_DEFAULT_TIMEOUT_MINUTES = 120;
export const STEP_MIN_TIMEOUT_MINUTES = 5;
export const STEP_MAX_TIMEOUT_MINUTES = 1440;
export const CHAIN_RUN_MAX_HOURS = 168;
export const CHAIN_MAX_CONCURRENT_RUNS = 5;
export const DEFAULT_PERSON_CHAIN_RUN_LIMIT_USD = 20;
export const MIN_CHAIN_RUN_LIMIT_USD = 0.5;
/** Plan 3's `RunInput` context title limit. */
export const CONTEXT_TITLE_MAX = RUN_INPUT_TITLE_MAX;
export const BRANCH_DESCRIPTION_MAX = 200;
export const STEP_LINK_LABEL_MAX = 80;
export const STEP_LINK_URL_MAX = 2048;
export const GATE_MAX_APPROVER_RULES = 3;
export const GATE_MAX_MEMBER_APPROVERS = 10;
export const RUN_START_TITLE_MAX = 300;
export const RUN_EVENT_KEY_MAX = 200;

/** The default of an agent step with no `handoff`: only the step before it. */
export const DEFAULT_HANDOFF = "previous";

// ---- text helpers

const utf8 = new TextEncoder();
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
/** What one line of text a person reads may not hold: any control, format, private-use, unassigned or surrogate character, and the line and paragraph separators. */
const NOT_LINE_TEXT = /[\p{C}\p{Zl}\p{Zp}]/u;

/** One line of text of 1 to `max` code points, with no control or invisible characters (a name, a prompt or a label a person reads). */
function line(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((text) => [...text].length <= max, `must be at most ${max} characters`)
    .refine((text) => !NOT_LINE_TEXT.test(text), "must not contain control or invisible characters");
}

/** Text of at most `max` UTF-8 bytes (`.max` would count UTF-16 units), with no control or invisible characters besides line breaks and tabs. */
function bytes(max: number) {
  return z
    .string()
    .refine((text) => utf8.encode(text).length <= max, `must be at most ${max} bytes`)
    .refine((text) => !hasInvisible(text), "must not contain control or invisible characters");
}

function hasInvisible(text: string): boolean {
  return NOT_LINE_TEXT.test(text.replace(/[\n\r\t]/gu, ""));
}

const NameSchema = line(STEP_NAME_MAX);

/** An event's de-duplication key, kept exactly as the dispatcher built it (a run's identity is a hash of it), so it is never trimmed. */
function eventKey() {
  return z
    .string()
    .min(1)
    .refine((text) => [...text].length <= RUN_EVENT_KEY_MAX, `must be at most ${RUN_EVENT_KEY_MAX} characters`)
    .refine((text) => !CONTROL_OR_FORMAT.test(text), "must not contain control or invisible characters");
}

/** An https link with no credentials, at most 2,048 characters and no whitespace or control characters. */
const HttpsUrlSchema = z
  .string()
  .max(STEP_LINK_URL_MAX)
  .refine((value) => !/[\s\p{Cc}\p{Cf}]/u.test(value), "must not contain spaces or control characters")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "must be an https link without a user name or password");

const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

// ---- edges and what follows a step

/** Where a step sends the run next: a step of the design, or `"$end"`. */
export const StepTargetSchema = z.union([ChainStepIdSchema, z.literal("$end")]);
export type StepTarget = z.infer<typeof StepTargetSchema>;

const EdgeFields = {
  to: StepTargetSchema,
  /** How often the run may take this edge; a design with a cycle needs one on an edge of it. At most 5. */
  maxTraversals: z.number().int().min(1).max(CHAIN_MAX_TRAVERSALS).optional(),
};

export const EdgeSchema = z.object(EdgeFields).strict();
export type Edge = z.infer<typeof EdgeSchema>;

const GoSchema = z.object({ kind: z.literal("go"), ...EdgeFields }).strict();
const BranchSchema = z
  .object({
    kind: z.literal("branch"),
    /** The agent picks one of these ids; it cannot name anything else. */
    choices: z
      .array(z.object({ id: BranchIdSchema, description: line(BRANCH_DESCRIPTION_MAX), ...EdgeFields }).strict())
      .min(2)
      .max(CHAIN_MAX_BRANCHES),
    /** The choice taken when the agent picks none. */
    default: BranchIdSchema.optional(),
  })
  .strict();
const EndSchema = z.object({ kind: z.literal("end") }).strict();

export const NextSchema = z.discriminatedUnion("kind", [GoSchema, BranchSchema, EndSchema]);
export type Next = z.infer<typeof NextSchema>;

// ---- steps

/** Who may decide a gate. Who they are is read when someone decides, not when the chain is saved. */
export const ApproverRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starter") }).strict(),
  z.object({ kind: z.literal("project_maintainers") }).strict(),
  z.object({ kind: z.literal("chain_owner") }).strict(),
  z
    .object({
      kind: z.literal("members"),
      developerIds: z
        .array(DeveloperIdSchema)
        .min(1)
        .max(GATE_MAX_MEMBER_APPROVERS)
        .refine((ids) => new Set(ids).size === ids.length, "must not repeat a person"),
    })
    .strict(),
]);
export type ApproverRule = z.infer<typeof ApproverRuleSchema>;

export const HANDOFF_MODES = ["previous", "all"] as const;
export const HandoffModeSchema = z.enum(HANDOFF_MODES);
export type HandoffMode = z.infer<typeof HandoffModeSchema>;

function agentStepSchema<V extends z.ZodType>(version: V) {
  return z
    .object({
      kind: z.literal("agent"),
      id: ChainStepIdSchema,
      name: NameSchema,
      /** The agent and the version it runs: a number, or `"current"` in a draft (publishing pins it). */
      agent: z.object({ agentId: AgentIdSchema, version }).strict(),
      instructions: bytes(STEP_INSTRUCTIONS_MAX_BYTES).optional(),
      /** What the step receives of the steps before it. Absent means `DEFAULT_HANDOFF`. */
      handoff: HandoffModeSchema.optional(),
      timeoutMinutes: z.number().int().min(STEP_MIN_TIMEOUT_MINUTES).max(STEP_MAX_TIMEOUT_MINUTES).optional(),
      retries: z.number().int().min(0).max(STEP_RETRIES_MAX).optional(),
      next: NextSchema,
    })
    .strict();
}

const DraftVersionSchema = z.union([z.number().int().min(1), z.literal("current")]);
const PinnedVersionSchema = z.number().int().min(1);

export const AgentStepSchema = agentStepSchema(DraftVersionSchema);
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const GateStepSchema = z
  .object({
    kind: z.literal("gate"),
    id: ChainStepIdSchema,
    name: NameSchema,
    prompt: line(APPROVAL_PROMPT_MAX),
    approvers: z.array(ApproverRuleSchema).min(1).max(GATE_MAX_APPROVER_RULES),
    timeoutHours: z.number().int().min(1).max(GATE_MAX_TIMEOUT_HOURS).optional(),
    onApprove: EdgeSchema,
    /** Where a rejection (or an expired gate) sends the run. Absent means the end. */
    onReject: EdgeSchema.default({ to: "$end" }),
  })
  .strict();
export type GateStep = z.infer<typeof GateStepSchema>;
export type ChainStep = AgentStep | GateStep;

// ---- the design

function definitionSchema<V extends z.ZodType>(version: V) {
  return z
    .object({
      start: ChainStepIdSchema,
      steps: z
        .array(z.discriminatedUnion("kind", [agentStepSchema(version), GateStepSchema]))
        .min(1)
        .max(CHAIN_MAX_STEPS),
      limits: z
        .object({
          maxRunUsd: z.number().min(MIN_CHAIN_RUN_LIMIT_USD).max(MAX_RUN_LIMIT_USD).optional(),
          maxRunHours: z.number().int().min(1).max(CHAIN_RUN_MAX_HOURS).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((definition, context) => {
      const seen = new Set<string>();
      definition.steps.forEach((step, index) => {
        if (seen.has(step.id)) context.addIssue({ code: "custom", path: ["steps", index, "id"], message: `Step id "${step.id}" is used by more than one step` });
        seen.add(step.id);
      });
    });
}

/**
 * A chain as a person writes it: agent versions are numbers or `"current"`. Checks the shape and the limits of each field and that step ids are
 * unique; whether the edges lead to steps, loops are bounded and the agents can run is `validateChain` (Task 2).
 */
export const ChainDefinitionSchema = definitionSchema(DraftVersionSchema);
/** A published chain: every agent version is a number, so a version of the chain always runs the same agents. */
export const PinnedChainDefinitionSchema = definitionSchema(PinnedVersionSchema);

export type ChainDefinition = z.infer<typeof ChainDefinitionSchema>;
/** What a person may write: `onReject` can be left out of a gate. */
export type ChainDefinitionInput = z.input<typeof ChainDefinitionSchema>;
export type PinnedChainDefinition = z.infer<typeof PinnedChainDefinitionSchema>;

// ---- a step's result

export const StepLinkSchema = z.object({ label: line(STEP_LINK_LABEL_MAX), url: HttpsUrlSchema }).strict();

/**
 * What a step leaves for the steps after it: its report, the branch it chose and the links in the report. The runner builds it from Plan 3's
 * task state (Task 6); it is never parsed from model text, so it has no field a model could use to approve or start something.
 */
export const StepResultSchema = z
  .object({
    report: z.string().refine((text) => utf8.encode(text).length <= REPORT_MAX_BYTES, `must be at most ${REPORT_MAX_BYTES} bytes`),
    branch: BranchIdSchema.optional(),
    links: z.array(StepLinkSchema).max(STEP_LINKS_MAX).optional(),
  })
  .strict();
export type StepResult = z.infer<typeof StepResultSchema>;

// ---- runs

export const CHAIN_RUN_STATUSES = ["running", "waiting", "paused", "succeeded", "failed", "cancelled", "timed_out"] as const;
export const ChainRunStatusSchema = z.enum(CHAIN_RUN_STATUSES);
export type ChainRunStatus = z.infer<typeof ChainRunStatusSchema>;

/** A step attempt has the run statuses, plus `starting`: written before its task is started (Task 6). */
export const STEP_ATTEMPT_STATUSES = [...CHAIN_RUN_STATUSES, "starting"] as const;
export const StepAttemptStatusSchema = z.enum(STEP_ATTEMPT_STATUSES);
export type StepAttemptStatus = z.infer<typeof StepAttemptStatusSchema>;

const EVENT_SOURCE = /^[a-z][a-z0-9_-]{0,23}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,3}$/;

/** Who started a run: a member, an event through a trigger, or a schedule through a trigger. */
export const ChainRunStartedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), developerId: DeveloperIdSchema }).strict(),
  z
    .object({
      kind: z.literal("event"),
      triggerId: TriggerIdSchema,
      eventKey: eventKey(),
      /** The vendor (`sentry`) and the event type (`issue.created`); the lists of both are the trigger contracts' (Task 18). */
      source: z.string().regex(EVENT_SOURCE),
      type: z.string().regex(EVENT_TYPE),
      title: line(RUN_START_TITLE_MAX),
      url: HttpsUrlSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("schedule"), triggerId: TriggerIdSchema, scheduledAt: z.string().datetime() }).strict(),
]);
export type ChainRunStartedBy = z.infer<typeof ChainRunStartedBySchema>;
