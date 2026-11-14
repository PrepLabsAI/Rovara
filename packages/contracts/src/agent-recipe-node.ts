import type { z } from "zod";
import type { StepIdSchema, AGENT_STEP_KINDS, StepSettingsSchema, InstructionLayerSchema, StepSpecSchema, ResolvedStepSchema, ConnectorSelectorSchema, ToolGrantSchema, ApprovalRulesSchema, TriggerSpecSchema, SkillRefSchema, RecipeOverlaySchema, ResolvedRecipeSchema} from "./agent-recipe.js";
import { CODING_STEP_KINDS, AgentConnectorTypeSchema, RESOLVED_RECIPE_SCHEMA_VERSION, STEP_TOOLS, PI_TOOL_NAMES } from "./agent-recipe.js";
import { type WorkflowProgram } from "./task-workflow-node.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export type StepId = z.infer<typeof StepIdSchema>;

export type CodingStepKind = (typeof CODING_STEP_KINDS)[number];

export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export type StepSettings = z.infer<typeof StepSettingsSchema>;

export type InstructionLayer = z.infer<typeof InstructionLayerSchema>;

export type StepSpec = z.infer<typeof StepSpecSchema>;

export type ResolvedStep = z.infer<typeof ResolvedStepSchema>;

export type AgentConnectorType = z.infer<typeof AgentConnectorTypeSchema>;

export type ConnectorSelector = z.infer<typeof ConnectorSelectorSchema>;

export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export type ApprovalRules = z.infer<typeof ApprovalRulesSchema>;

/**
 * The ways a run can start. In a custom agent's recipe they say how the agent may be started (G10); on a trigger record (triggers.ts) an `event` or `schedule` spec is the
 * live one. A built-in recipe lists `person` alone: its suggested triggers are Plan 4 data (builtin-triggers.ts), never recipe content.
 */
export const TRIGGER_KINDS_AT_LAUNCH = ["person", "event", "schedule"] as const;

export type TriggerSpec = z.infer<typeof TriggerSpecSchema>;

export type SkillRef = z.infer<typeof SkillRefSchema>;

export type RecipeOverlay = z.infer<typeof RecipeOverlaySchema>;

export type ResolvedRecipe = z.infer<typeof ResolvedRecipeSchema>;

/** A recipe with nothing in it: what an agent built from scratch starts from. */
export const EMPTY_RECIPE: ResolvedRecipe = {
  schemaVersion: RESOLVED_RECIPE_SCHEMA_VERSION,
  chain: [],
  instructions: [],
  steps: [],
  tools: [],
  approvals: { alwaysAsk: [] },
  triggers: [{ kind: "person" }],
  skills: [],
  autonomy: "prepare",
  allowMentions: false,
};

export type RecipeLayer = ResolvedRecipe["chain"][number];

export type ResolvedSkill = ResolvedRecipe["skills"][number];

/** A problem with where it is (`path`, dotted) and what is wrong (`message`, which does not repeat the path). */
export interface RecipeProblem { path: string; message: string }

/** The problem as one line: `<path>: <message>`. */
export function formatRecipeProblem(problem: RecipeProblem): string {
  return `${problem.path}: ${problem.message}`;
}

function isCodingKind(kind: string): kind is CodingStepKind {
  return (CODING_STEP_KINDS as readonly string[]).includes(kind);
}

/** The runner a recipe needs: Rovara Code's workflow engine for coding steps, the agent-step runner otherwise. */
export function recipeRunner(recipe: ResolvedRecipe): "coding" | "agent_steps" {
  return recipe.steps.some((step) => isCodingKind(step.kind)) ? "coding" : "agent_steps";
}

type LooseSettings = Record<string, unknown> & { instructions: InstructionLayer[] };

/**
 * Applies one layer's settings patch to a step's inherited settings: a value replaces, `null` clears, instructions
 * add a layer, and a coding step's tools can only narrow what the base step already allowed.
 */
function patchSettings(inherited: LooseSettings, patch: StepSettings | undefined, kind: string, agentName: string): LooseSettings {
  const next: LooseSettings = { ...inherited, instructions: [...inherited.instructions] };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (key === "instructions") {
      if (typeof value === "string" && value.length > 0) next.instructions.push({ agentName, text: value });
    } else if (key === "tools") {
      const tools = value as string[];
      const inheritedTools = inherited["tools"] as string[] | undefined;
      next["tools"] = isCodingKind(kind) && inheritedTools ? inheritedTools.filter((tool) => tools.includes(tool)) : tools;
    } else if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * The recipe after one more layer. The base is not changed. A `steps` patch for an id no step has is left out here;
 * `overlayProblems` reports it. Added skills need `resolveSkill` (the registry knows their names and digests).
 */
export function applyOverlay(base: ResolvedRecipe, overlay: RecipeOverlay, layer: RecipeLayer, resolveSkill?: (ref: SkillRef) => ResolvedSkill): ResolvedRecipe {
  const recipe = structuredClone(base);
  if (overlay.instructions) recipe.instructions.push({ agentName: layer.name, text: overlay.instructions });
  if (overlay.sequence) {
    const baseSteps = new Map(recipe.steps.map((step) => [step.id, step]));
    recipe.steps = overlay.sequence.map((spec) => {
      const baseStep = baseSteps.get(spec.id);
      const inherited = baseStep?.kind === spec.kind ? baseStep.settings : { instructions: [] };
      return { ...spec, settings: patchSettings(inherited, spec.settings, spec.kind, layer.name) };
    });
  }
  for (const [id, patch] of Object.entries(overlay.steps ?? {})) {
    const index = recipe.steps.findIndex((step) => step.id === id);
    const step = recipe.steps[index];
    if (step) recipe.steps[index] = { ...step, settings: patchSettings(step.settings, patch, step.kind, layer.name) };
  }
  if (overlay.tools) recipe.tools = overlay.tools;
  if (overlay.triggers) recipe.triggers = overlay.triggers;
  if (overlay.approvals?.alwaysAsk) recipe.approvals = { alwaysAsk: [...new Set([...recipe.approvals.alwaysAsk, ...overlay.approvals.alwaysAsk])] };
  if (overlay.skills) {
    const removed = new Set(overlay.skills.remove ?? []);
    const added = overlay.skills.add ?? [];
    if (added.length > 0 && !resolveSkill) throw new TypeError("applyOverlay needs resolveSkill to add a skill");
    const addedIds = new Set(added.map((ref) => ref.skillId));
    const kept = recipe.skills.filter((skill) => !removed.has(skill.skillId) && !addedIds.has(skill.skillId));
    const adds = new Map(added.map((ref) => [ref.skillId, resolveSkill!(ref)]));
    recipe.skills = [...kept, ...adds.values()];
  }
  if (overlay.autonomy !== undefined) recipe.autonomy = overlay.autonomy;
  if (overlay.allowMentions !== undefined) recipe.allowMentions = overlay.allowMentions;
  recipe.chain.push({ ...layer });
  return recipe;
}

/** Patches in an overlay's `steps` that name no step of the recipe it applies to (after its own `sequence`). */
export function overlayProblems(base: ResolvedRecipe, overlay: RecipeOverlay): RecipeProblem[] {
  const ids = new Set((overlay.sequence ?? base.steps).map((step) => step.id));
  return Object.keys(overlay.steps ?? {}).filter((id) => !ids.has(id)).map((id) => ({ path: `steps.${id}`, message: `no step has that id` }));
}

/** The structure a coding recipe must have for the workflow engine to run it. */
function codingStructureProblems(steps: readonly ResolvedStep[], add: (path: string, message: string) => void): void {
  const indexesOf = (kind: CodingStepKind) => steps.flatMap((step, index) => (step.kind === kind ? [index] : []));
  const plans = indexesOf("plan");
  plans.forEach((index, order) => {
    if (order > 0) add(`steps.${index}`, `a recipe can have only one plan step`);
    else if (index !== 0) add(`steps.${index}`, `the plan step must come first`);
  });
  // Rovara Code version 2: the plan check comes directly after the plan, and there is only one.
  indexesOf("plan_critic").forEach((index, order) => {
    if (order > 0) add("steps", "a recipe can have only one plan check step");
    else if (plans.length === 0) add("steps", "a plan check needs a plan step");
    else if (index !== (plans[0] ?? -1) + 1) add("steps", "a plan check must come right after the plan step");
  });
  const builds = indexesOf("build");
  if (builds.length === 0) add("steps", "a coding recipe needs at least one build step");
  const pullRequests = indexesOf("pull_request");
  pullRequests.forEach((index, order) => {
    if (order > 0) add(`steps.${index}`, `a recipe can have only one pull request step`);
    else if (index !== steps.length - 1) add(`steps.${index}`, `the pull request step must come last`);
  });
  if (pullRequests.length > 0) {
    const afterBuild = steps.slice((builds.at(-1) ?? -1) + 1);
    const checked = afterBuild.some((step) => step.kind === "check");
    const reviewed = afterBuild.some((step) => step.kind === "review" && step.reviewers.includes("code") && step.reviewers.includes("security"));
    if (!checked || !reviewed) add("steps", "a pull request step needs a check step and a review step with both reviewers after the last build step");
  }
  steps.forEach((step, index) => {
    if (step.kind !== "review" || !step.onFindings) return;
    const target = steps.findIndex((other) => other.id === step.onFindings?.backTo);
    if (target < 0 || target >= index || steps[target]?.kind !== "build") {
      add(`steps.${index}.onFindings.backTo`, `"${step.onFindings.backTo}" must name an earlier build step`);
    }
  });
}

function toolProblem(step: ResolvedStep, tools: readonly string[]): string | undefined {
  const label = `the "${step.id}" step (${step.kind})`;
  if (!(step.kind in STEP_TOOLS)) return `${label} takes no tools`;
  if (tools.length === 0) return `${label} has no tools left; the layers it builds on narrowed them to nothing`;
  const allowed: readonly string[] = STEP_TOOLS[step.kind as keyof typeof STEP_TOOLS];
  const piNames: readonly string[] = PI_TOOL_NAMES;
  const refused = step.kind === "agent"
    // Other names are connector tool patterns; only a Pi tool name has to be one the step can have.
    ? tools.filter((tool) => piNames.includes(tool) && (!allowed.includes(tool) || step.workspace === "none"))
    : tools.filter((tool) => !allowed.includes(tool));
  if (refused.length === 0) return undefined;
  const can = step.kind === "agent" && step.workspace === "none" ? "no workspace tools (it has no workspace)" : allowed.join(", ");
  return `${label} can't use ${refused.join(", ")}; it can use ${can}`;
}

/**
 * Integrations Rovara knows by name that are not connectors an agent can be given. A recipe that grants a connector called one of these is asking for
 * something no project can give it, so it is refused when it is published rather than matching nothing in silence. (A project's connector may well be
 * called `slack`; then the recipe names it by its type.) At run time a `{ name }` selector matches only a connector whose type is one of
 * `AgentConnectorTypeSchema`, whatever its name.
 */
const NOT_AGENT_CONNECTORS: readonly string[] = ["slack"];

/** Problems with a recipe's tool grants that can be seen without a project: a name selector that no connector an agent can use is called. */
export function toolGrantProblems(tools: readonly ToolGrant[]): RecipeProblem[] {
  const problems: RecipeProblem[] = [];
  tools.forEach((grant, index) => {
    if ("name" in grant.connector && NOT_AGENT_CONNECTORS.includes(grant.connector.name)) {
      problems.push({ path: `tools.${String(index)}.connector`, message: `${grant.connector.name} isn't a connector agents can use; name a connector of the project, or pick a type: ${AgentConnectorTypeSchema.options.slice(0, -1).join(", ")} or ${AgentConnectorTypeSchema.options.at(-1) ?? ""}` });
    }
  });
  return problems;
}

/** Why a recipe can't be published or run, in terms of its structure. Empty when it can. */
export function recipeProblems(recipe: ResolvedRecipe): RecipeProblem[] {
  const problems: RecipeProblem[] = [];
  const add = (path: string, message: string) => { problems.push({ path, message }); };
  problems.push(...toolGrantProblems(recipe.tools));
  const steps = recipe.steps;
  if (steps.length === 0) add("steps", "a recipe needs at least one step");

  const indexById = new Map<string, number>();
  steps.forEach((step, index) => {
    if (indexById.has(step.id)) add(`steps.${index}.id`, `the id "${step.id}" is used by more than one step`);
    else indexById.set(step.id, index);
  });

  const hasCoding = steps.some((step) => isCodingKind(step.kind));
  if (hasCoding && steps.some((step) => !isCodingKind(step.kind))) add("steps", "a recipe can't mix coding steps and agent steps; link the two agents in a chain instead");
  else if (hasCoding) codingStructureProblems(steps, add);

  steps.forEach((step, index) => {
    const settings = step.settings as Record<string, unknown> & { tools?: string[] };
    const at = (key: string) => `steps.${index}.settings.${key}`;
    if (settings.tools) {
      const message = toolProblem(step, settings.tools);
      if (message) add(at("tools"), `${message}`);
    }
    if (step.kind === "check") {
      for (const key of Object.keys(settings)) {
        if (key !== "timeoutMinutes" && key !== "instructions" && key !== "tools") add(at(key), `a check step only takes a timeout`);
      }
    }
    const other = settings["differentCompanyFrom"];
    if (typeof other === "string") {
      if (step.kind !== "review" && step.kind !== "agent") add(at("differentCompanyFrom"), `only a review or agent step can name a step to differ from`);
      else if ((indexById.get(other) ?? index) >= index) add(at("differentCompanyFrom"), `"${other}" must name an earlier step`);
    }
  });

  return problems;
}

/** Rovara Code's built-in version 1: plan, build, check, then a two-reviewer review that sends findings back to build for 3 rounds, then the pull request. */
function isRovaraCodeVersion1(steps: readonly ResolvedStep[]): boolean {
  if (steps.map((step) => step.kind).join() !== "plan,build,check,review,pull_request") return false;
  const review = steps[3];
  if (review?.kind !== "review" || [...review.reviewers].sort().join() !== "code,security") return false;
  return review.onFindings?.maxRounds === 3 && steps.findIndex((step) => step.id === review.onFindings?.backTo) === 1;
}

/**
 * The workflow program a coding recipe's engine follows, or undefined when the engine's own path (Rovara Code's
 * version 1: same step kinds, order and review settings) already is that recipe, or when the recipe isn't a coding one.
 */
export function codingProgram(recipe: ResolvedRecipe): WorkflowProgram | undefined {
  if (recipeRunner(recipe) !== "coding" || isRovaraCodeVersion1(recipe.steps)) return undefined;
  const steps: WorkflowProgram["steps"] = [];
  for (const step of recipe.steps) {
    if (step.kind === "review") steps.push({ id: step.id, kind: step.kind, reviewers: [...step.reviewers], ...(step.onFindings ? { onFindings: { ...step.onFindings } } : {}) });
    else if (isCodingKind(step.kind)) steps.push({ id: step.id, kind: step.kind });
  }
  return { steps };
}

/** SHA-256 of the recipe's canonical JSON (hex): equal recipes have equal digests whatever their key order. */
export function recipeDigest(recipe: ResolvedRecipe): string {
  return createHash("sha256").update(canonicalJson(recipe), "utf8").digest("hex");
}

/** Settings whose value is one unit: a changed model is one change, not one per field of it. */
const WHOLE_VALUE_KEYS = new Set(["model", "fallbackModel"]);

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValues(path: string, before: unknown, after: unknown, found: string[]): void {
  if (before === undefined && after === undefined) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) diffValues(pointer(path, index), before[index], after[index], found);
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (WHOLE_VALUE_KEYS.has(key)) {
        if (canonicalJson(before[key]) !== canonicalJson(after[key])) found.push(pointer(path, key));
      } else {
        diffValues(pointer(path, key), before[key], after[key], found);
      }
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    found.push(path);
  }
}

/** The versions of the agents a recipe builds on: the chain without the agent's own layer (a built-in is always a base). */
function baseVersions(recipe: ResolvedRecipe): Array<RecipeLayer["version"]> {
  return recipe.chain.filter((layer, index) => layer.builtin || index < recipe.chain.length - 1).map((layer) => layer.version);
}

/**
 * JSON-pointer paths (`/steps/1/settings/model`) of what differs between two recipes. The chain is left out but for
 * the versions of what the recipe builds on, reported as `/base/version`; `/allowMentions` shows like any other field.
 */
export function diffRecipes(before: ResolvedRecipe, after: ResolvedRecipe): string[] {
  const found: string[] = [];
  const withoutChain = (recipe: ResolvedRecipe) => Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== "chain"));
  diffValues("", withoutChain(before), withoutChain(after), found);
  if (canonicalJson(baseVersions(before)) !== canonicalJson(baseVersions(after))) found.push("/base/version");
  return found;
}

/** JSON-pointer paths of what an overlay sets, down to each setting of a step (`/steps/build/model`). */
export function overlayPaths(overlay: RecipeOverlay): string[] {
  const paths: string[] = [];
  const setKeys = (value: object) => Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key]) => key);
  const nested = (parent: string, value: object) => {
    const keys = setKeys(value);
    if (keys.length === 0) paths.push(parent);
    for (const key of keys) paths.push(pointer(parent, key));
  };
  for (const key of setKeys(overlay)) {
    const value = overlay[key as keyof RecipeOverlay];
    if (key === "steps") for (const [id, settings] of Object.entries(overlay.steps ?? {})) nested(pointer("/steps", id), settings);
    else if (key === "approvals" || key === "skills") nested(pointer("", key), value as object);
    else paths.push(pointer("", key));
  }
  return paths;
}

export { INSTRUCTIONS_MAX_BYTES, STEP_NAME_MAX, APPROVAL_PROMPT_MAX, MAX_RECIPE_STEPS, MAX_RECIPE_TOOL_GRANTS, MAX_ALWAYS_ASK_RULES, MAX_RECIPE_TRIGGERS, MAX_RESOLVED_SKILLS, utf8, InstructionTextSchema, Sha256HexSchema, StepIdSchema, CODING_STEP_KINDS, AGENT_STEP_KINDS, PI_TOOL_NAMES, PiToolNameSchema, type PiToolName, READ_ONLY_TOOLS, STEP_TOOLS, StepThinkingLevelSchema, StepSettingsSchema, CheckStepSettingsSchema, InstructionLayerSchema, ResolvedStepSettingsSchema, ResolvedCheckStepSettingsSchema, StepNameSchema, ReviewerSchema, OnFindingsSchema, stepVariants, StepSpecSchema, ResolvedStepSchema, AgentConnectorTypeSchema, ConnectorSelectorSchema, ToolGrantSchema, AlwaysAskSchema, ApprovalRulesSchema, TriggerSpecSchema, SkillRefSchema, RecipeOverlaySchema, RESOLVED_RECIPE_SCHEMA_VERSION, ResolvedRecipeSchema } from "./agent-recipe.js";
