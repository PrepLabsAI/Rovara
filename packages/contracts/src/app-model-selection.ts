// The model each step uses: what the local page, the CLI and the MCP tool read of the owner's per-step model setting (`GET /v1/dev/model-selection`). A strict shape for what the page sends, a forward-compatible
// reader for what a tool reads. Words, ids, counts and prices; never a model's output. The setting itself is written on the local page only (a tool with the API token reads it and cannot change it).
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { ModelIdentifierSchema, ThinkingLevelSchema } from "./models.js";
import { StageIdSchema, ModelFallbackSchema, STAGE_MODEL_REFUSAL_CODES } from "./stage-model-shared.js";
import { StageModelChoiceSchema } from "./stage-models.js";

const Line = z.string().min(1).max(400);

/** What decided the model a step uses (the hosted product's reasons, plus the install's own default). */
export const MODEL_STEP_REASONS = ["COMPANY_LOCK", "PROJECT_CHOICE", "COMPANY_DEFAULT", "PROJECT_SELECTION", "PROJECT_DEFAULT", "BUILTIN_DEFAULT", "PERSONAL_PLAN_DEFAULT", "RECIPE_DEFAULT", "APPROVED_SAME_MODEL", "DEFAULT_DIFFERENT_COMPANY", "INSTALL_MODEL"] as const;

export const ModelStepViewSchema = z.object({
  stage: StageIdSchema,
  /** What the owner set for this step (and, for a group of steps that share one setting, for the group); null when nothing is set. */
  setting: StageModelChoiceSchema.nullable(),
  /** The model the step would run on now. Absent when none can be chosen (`refusal` says why). */
  effective: z.object({
    model: ModelIdentifierSchema,
    thinkingLevel: ThinkingLevelSchema.nullable(),
    reason: z.enum(MODEL_STEP_REASONS),
    /** A checking step that runs on the same model as the step it checks (the install has one model, or nothing else was usable). */
    sameModelAsChecked: z.boolean(),
    /** A fallback was used: the model that was asked for was not usable (the words are Rovara's). */
    fallback: ModelFallbackSchema.optional(),
    /** The step's price per million tokens in US dollars, when it has one. */
    priceUsdPerMillion: z.object({ input: z.number().min(0), output: z.number().min(0), source: z.enum(["provider", "catalog", "built-in"]) }).strict().optional(),
  }).strict().optional(),
  refusal: z.object({ code: z.enum([...STAGE_MODEL_REFUSAL_CODES, "NO_MODEL"]), words: Line }).strict().optional(),
}).strict();
export type ModelStepView = z.infer<typeof ModelStepViewSchema>;

export const ModelChoiceViewSchema = z.object({
  model: ModelIdentifierSchema,
  /** The maker, a fixed word (`anthropic`, `openai`, ...; `other` when unknown). */
  company: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  /** False: no price in the provider's table or the catalog. Where a run limit applies it cannot be used. */
  priced: z.boolean(),
  priceUsdPerMillion: z.object({ input: z.number().min(0), output: z.number().min(0), source: z.enum(["provider", "catalog", "built-in"]) }).strict().optional(),
  /** False: a call to it was refused lately (not enabled for the account, or not priced under a limit); a default choice leaves it out for a while. */
  usable: z.boolean(),
}).strict();
export type ModelChoiceView = z.infer<typeof ModelChoiceViewSchema>;

export const ModelSelectionStateSchema = z.object({
  version: z.literal(1),
  /** The setting's revision (0: nothing was ever set). A change must name the revision it was made against. */
  revision: z.number().int().min(0),
  /** What a checking step nobody set uses: the install's one model, or the strongest model of a different AI company than the step it checks. */
  reviewDefault: z.enum(["install-model", "different-company"]),
  /** Whether a run limit is held (a model with no price cannot then be used). */
  runLimit: z.object({ enforced: z.boolean() }).strict(),
  install: ModelIdentifierSchema.nullable(),
  steps: z.array(ModelStepViewSchema).max(7),
  /** The models a step could be set to: what this install can call now, at most 23. */
  models: z.array(ModelChoiceViewSchema).max(23),
}).strict();
export type ModelSelectionState = z.infer<typeof ModelSelectionStateSchema>;
export const ModelSelectionStateReaderSchema = forwardReader(ModelSelectionStateSchema);

/** What the local page sends. The server decides whether it may apply; a refusal comes back in its own words. */
export const ModelSelectionBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), stage: StageIdSchema, choice: StageModelChoiceSchema, expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ action: z.literal("clear"), stage: StageIdSchema, expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ action: z.literal("review-default"), value: z.enum(["install-model", "different-company"]), expectedRevision: z.number().int().min(0) }).strict(),
]);
export type ModelSelectionBody = z.infer<typeof ModelSelectionBodySchema>;
