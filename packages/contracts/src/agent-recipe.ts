import { z } from "zod";
import { ModelSelectionSchema } from "./models.js";
import { ToolPatternSchema } from "./action-policy.js";
import { AGENT_NAME_MAX, SkillIdSchema, AutonomySchema, AgentIdSchema } from "./agent.js";
import { ConnectorNameSchema } from "./connectors.js";
import { EventTriggerSpecSchema, ScheduleTriggerSpecSchema } from "./trigger-specs.js";

export const INSTRUCTIONS_MAX_BYTES = 8192;

export const STEP_NAME_MAX = 40;

export const APPROVAL_PROMPT_MAX = 300;

export const MAX_RECIPE_STEPS = 12;

export const MAX_RECIPE_TOOL_GRANTS = 16;

export const MAX_ALWAYS_ASK_RULES = 32;

export const MAX_RECIPE_TRIGGERS = 8;

export const MAX_RESOLVED_SKILLS = 20;

export const utf8 = new TextEncoder();

export const InstructionTextSchema = z.string().refine((text) => utf8.encode(text).length <= INSTRUCTIONS_MAX_BYTES, `must be at most ${INSTRUCTIONS_MAX_BYTES} bytes`);

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const StepIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

/**
 * `plan_critic` (Rovara Code version 2) is an ordinary step that checks the plan with a second model; it comes only directly after `plan`, at most once.
 * Nothing about it asks for a different AI company: the company chooses its model through an overlay like any step's (question 10).
 */
export const CODING_STEP_KINDS = ["plan", "plan_critic", "build", "check", "review", "pull_request"] as const;

export const AGENT_STEP_KINDS = ["agent", "approval"] as const;

export const PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export const PiToolNameSchema = z.enum(PI_TOOL_NAMES);

export type PiToolName = z.infer<typeof PiToolNameSchema>;

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const satisfies readonly PiToolName[];

/**
 * The most tools a step of that kind can be given. An `agent` step gets them only with `workspace: "read"`; with
 * `workspace: "none"` it has none. `check` and `pull_request` run fixed commands and take no tools.
 */
export const STEP_TOOLS = {
  build: PI_TOOL_NAMES,
  plan: READ_ONLY_TOOLS,
  plan_critic: READ_ONLY_TOOLS,
  review: READ_ONLY_TOOLS,
  agent: READ_ONLY_TOOLS,
} as const satisfies Record<"build" | "plan" | "plan_critic" | "review" | "agent", readonly PiToolName[]>;

export const StepThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high"]);

/** `null` clears a setting an agent inherits; absent leaves it as it is. */
export const StepSettingsSchema = z.object({
  model: ModelSelectionSchema.nullable().optional(),
  fallbackModel: ModelSelectionSchema.nullable().optional(),
  thinkingLevel: StepThinkingLevelSchema.nullable().optional(),
  instructions: InstructionTextSchema.optional(),
  /** Pi tool names for a coding step, tool patterns over the upstream tool names for an agent step. */
  tools: z.array(ToolPatternSchema).min(1).max(40).refine((tools) => new Set(tools).size === tools.length, "tools must be unique").optional(),
  stepBudgetUsd: z.number().min(0.1).max(100).nullable().optional(),
  timeoutMinutes: z.number().int().min(5).max(240).nullable().optional(),
  /** This step's model must come from a different company than the named earlier step's. */
  differentCompanyFrom: StepIdSchema.nullable().optional(),
}).strict();

export const CheckStepSettingsSchema = StepSettingsSchema.pick({ timeoutMinutes: true }).strict();

/** One layer of instructions, written by the agent named. Layers resolve in chain order, base first. */
export const InstructionLayerSchema = z.object({
  agentName: z.string().min(1).max(AGENT_NAME_MAX),
  text: InstructionTextSchema,
}).strict();

export const ResolvedStepSettingsSchema = StepSettingsSchema.omit({ instructions: true }).extend({ instructions: z.array(InstructionLayerSchema) }).strict();

export const ResolvedCheckStepSettingsSchema = CheckStepSettingsSchema.extend({ instructions: z.array(InstructionLayerSchema) }).strict();

export const StepNameSchema = z.string().trim().min(1).max(STEP_NAME_MAX);

export const ReviewerSchema = z.enum(["code", "security"]);

export const OnFindingsSchema = z.object({ backTo: StepIdSchema, maxRounds: z.number().int().min(1).max(5) }).strict();

export function stepVariants<Settings extends z.ZodType, CheckSettings extends z.ZodType>(settings: Settings, checkSettings: CheckSettings) {
  const common = { id: StepIdSchema, name: StepNameSchema };
  return z.discriminatedUnion("kind", [
    z.object({ ...common, kind: z.literal("plan"), settings }).strict(),
    z.object({ ...common, kind: z.literal("plan_critic"), settings }).strict(),
    z.object({ ...common, kind: z.literal("build"), settings }).strict(),
    z.object({ ...common, kind: z.literal("check"), settings: checkSettings }).strict(),
    z.object({
      ...common,
      kind: z.literal("review"),
      reviewers: z.array(ReviewerSchema).min(1).max(2).refine((reviewers) => new Set(reviewers).size === reviewers.length, "reviewers must be unique"),
      onFindings: OnFindingsSchema.optional(),
      settings,
    }).strict(),
    z.object({ ...common, kind: z.literal("pull_request"), settings }).strict(),
    z.object({
      ...common,
      kind: z.literal("agent"),
      workspace: z.enum(["none", "read"]),
      report: z.object({ slack: z.boolean().optional() }).strict().optional(),
      settings,
    }).strict(),
    z.object({ ...common, kind: z.literal("approval"), prompt: z.string().min(1).max(APPROVAL_PROMPT_MAX), settings }).strict(),
  ]);
}

export const StepSpecSchema = stepVariants(StepSettingsSchema.optional(), CheckStepSettingsSchema.optional());

export const ResolvedStepSchema = stepVariants(ResolvedStepSettingsSchema, ResolvedCheckStepSettingsSchema);

/** Connector types an agent can be granted tools on: the five of Plan 3 and the seven read-only ones of Plan 4 (Task 12). */
export const AgentConnectorTypeSchema = z.enum(["github", "linear", "jira", "asana", "mcp", "sentry", "datadog", "cloudwatch", "github-actions", "grafana", "vercel", "pagerduty"]);

/** A connector by its type (every connection of that type on the project) or by the project's name for it. */
export const ConnectorSelectorSchema = z.union([
  z.object({ type: AgentConnectorTypeSchema }).strict(),
  z.object({ name: ConnectorNameSchema }).strict(),
]);

export const ToolGrantSchema = z.object({
  connector: ConnectorSelectorSchema,
  access: z.enum(["read", "read_write"]),
  tools: z.array(ToolPatternSchema).min(1).max(64).optional(),
}).strict();

export const AlwaysAskSchema = z.array(ToolPatternSchema).max(MAX_ALWAYS_ASK_RULES);

export const ApprovalRulesSchema = z.object({ alwaysAsk: AlwaysAskSchema }).strict();

export const TriggerSpecSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("person") }).strict(), EventTriggerSpecSchema, ScheduleTriggerSpecSchema]);

export const SkillRefSchema = z.object({ skillId: SkillIdSchema, digest: Sha256HexSchema.optional() }).strict();

/** What an agent version stores: its changes to the agent it builds on (or to the empty recipe). */
export const RecipeOverlaySchema = z.object({
  instructions: InstructionTextSchema.nullable().optional(),
  sequence: z.array(StepSpecSchema).min(1).max(MAX_RECIPE_STEPS).optional(),
  steps: z.record(StepIdSchema, StepSettingsSchema).optional(),
  tools: z.array(ToolGrantSchema).max(MAX_RECIPE_TOOL_GRANTS).optional(),
  approvals: z.object({ alwaysAsk: AlwaysAskSchema.optional() }).strict().optional(),
  triggers: z.array(TriggerSpecSchema).min(1).max(MAX_RECIPE_TRIGGERS).optional(),
  skills: z.object({
    add: z.array(SkillRefSchema).max(MAX_RESOLVED_SKILLS).optional(),
    remove: z.array(SkillIdSchema).max(MAX_RESOLVED_SKILLS).optional(),
  }).strict().optional(),
  autonomy: AutonomySchema.optional(),
  /** Opts in to @-mentions in the agent's comments; it can only make comments wait for a person. */
  allowMentions: z.boolean().optional(),
}).strict();

export const RESOLVED_RECIPE_SCHEMA_VERSION = 1;

/** The whole recipe a run follows, after every layer of the chain is applied. It is frozen on the task. */
export const ResolvedRecipeSchema = z.object({
  schemaVersion: z.literal(RESOLVED_RECIPE_SCHEMA_VERSION),
  chain: z.array(z.object({
    agentId: AgentIdSchema,
    name: z.string().min(1).max(AGENT_NAME_MAX),
    version: z.union([z.number().int().min(1), z.literal("draft")]),
    builtin: z.boolean(),
    /** Set on the layer of a project's process ("How we work"); a recipe frozen before it existed has none. */
    process: z.literal(true).optional(),
  }).strict()).max(8),
  instructions: z.array(InstructionLayerSchema),
  steps: z.array(ResolvedStepSchema).max(MAX_RECIPE_STEPS),
  tools: z.array(ToolGrantSchema).max(MAX_RECIPE_TOOL_GRANTS),
  approvals: ApprovalRulesSchema,
  triggers: z.array(TriggerSpecSchema).min(1).max(MAX_RECIPE_TRIGGERS),
  skills: z.array(z.object({
    skillId: SkillIdSchema,
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    // At most 1024 characters (code points), as the registry counts them; `.max` would count UTF-16 units.
    description: z.string().refine((value) => [...value].length <= 1024, "must be at most 1024 characters"),
    digest: Sha256HexSchema,
  }).strict()).max(MAX_RESOLVED_SKILLS),
  autonomy: AutonomySchema,
  allowMentions: z.boolean(),
}).strict();
