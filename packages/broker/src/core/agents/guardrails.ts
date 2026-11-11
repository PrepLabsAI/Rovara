// The company's agent guardrails as the core uses them: the document and its revision on the document store (one row, `AGENT_GUARDRAILS`), and the check of a recipe against it. A document that cannot be read is an
// error, never the defaults: the defaults forbid nothing, so falling back to them would quietly undo what the owner set. Changing the guardrails is the owner's act on the local page; nothing here reads who is asking.
import {
  AgentGuardrailsSchema, AgentGuardrailsWriteSchema, AutonomySchema, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentXError, canonicalModelName, change, forbiddenModelMatcher, modelCompany, recipeProblems, when,
  type AgentGuardrails, type ModelCompany, type ModelIdentifier, type OrgId, type RecipeProblem, type ResolvedRecipe, type ResolvedStep,
} from "@agentx/contracts";
import { coded, iso, type Table } from "../automation/kit.js";

/** The models some source the install can use serves; the same model on another route counts as the same model. Absent: the guardrail check cannot tell a model is unservable, so it checks only what it can. */
export type ServableModels = (orgId: OrgId) => Promise<ModelIdentifier[]>;

export interface StoredGuardrails { guardrails: AgentGuardrails; revision: number }

const AUTONOMY_ORDER = AutonomySchema.options;
const modelLabel = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;

/** The guardrails and their revision (0 while the owner has never changed them). */
export async function readGuardrailsWithRevision(table: Table, orgId: OrgId): Promise<StoredGuardrails> {
  const item = await table.store.get(agentGuardrailsKey(orgId));
  if (item === undefined) return { guardrails: structuredClone(DEFAULT_AGENT_GUARDRAILS), revision: 0 };
  const parsed = AgentGuardrailsSchema.safeParse(item["guardrails"]);
  const revision = item["revision"];
  if (!parsed.success || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw agentXError("CONFIG_INVALID", "the agent guardrails can't be read; look at them on the guardrails page");
  }
  return { guardrails: parsed.data, revision };
}

export async function readGuardrails(table: Table, orgId: OrgId): Promise<AgentGuardrails> {
  return (await readGuardrailsWithRevision(table, orgId)).guardrails;
}

/** Makes `value` the guardrails, only while the document is at `expectedRevision` (by default the revision read now). The caller has proved it is the owner. */
export async function writeGuardrails(table: Table, orgId: OrgId, value: AgentGuardrails, by: string, options: { expectedRevision?: number } = {}): Promise<StoredGuardrails> {
  const parsed = AgentGuardrailsWriteSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "guardrails"}: ${parsed.error.issues[0]?.message ?? "is not valid"}`);
  const expected = options.expectedRevision ?? (await readGuardrailsWithRevision(table, orgId)).revision;
  const next = expected + 1;
  const key = agentGuardrailsKey(orgId);
  const fields = { entityType: "AGENT_GUARDRAILS", orgId, guardrails: parsed.data, revision: next, updatedBy: by, updatedAt: iso(table) } as const;
  const result = expected === 0
    ? await table.store.put({ item: { ...key, ...fields } as never, condition: when.absent() })
    : await table.store.update({ key, ops: Object.entries(fields).map(([name, v]) => change.set([name], v as never)), condition: when.eq("revision", expected) });
  if (!result.applied) throw coded("CHANGE_STALE", "the guardrails changed while you were editing them; reload and make your change again");
  return { guardrails: parsed.data, revision: next };
}

// ---- checking a recipe

type StepModels = { model?: ModelIdentifier | null; fallbackModel?: ModelIdentifier | null; stepBudgetUsd?: number | null; differentCompanyFrom?: string | null };

function modelsOf(step: ResolvedStep): ModelIdentifier[] {
  const { model, fallbackModel } = step.settings as StepModels;
  return [model, fallbackModel].filter((entry): entry is ModelIdentifier => entry !== undefined && entry !== null);
}

/** Whether `step`'s models are all from companies other than every model of `other`. A step with no model of its own runs on the default, whose company is not known here, so it does not pass. */
function differsFrom(step: ResolvedStep, other: ResolvedStep): boolean {
  const mine = modelsOf(step).map(modelCompany);
  const theirs = new Set<ModelCompany>(modelsOf(other).map(modelCompany));
  return mine.length > 0 && theirs.size > 0 && !theirs.has("other") && mine.every((company) => company !== "other" && !theirs.has(company));
}

/**
 * Why a recipe can't be published or run on this install: the recipe's own problems (`recipeProblems`), then anything the guardrails forbid: a forbidden model (matched by canonical name, so another route to
 * the same model counts), a model no source serves (when the install can say), a step budget or autonomy above the limits, and, when cross-company review is required, a review step whose models share a
 * company with a build step's. Empty when it can be.
 */
export async function validateRecipeForCompany(table: Table, orgId: OrgId, recipe: ResolvedRecipe, options: { servableModels?: ServableModels | undefined } = {}): Promise<RecipeProblem[]> {
  const problems = recipeProblems(recipe);
  const add = (path: string, message: string) => { if (!problems.some((known) => known.path === path && known.message === message)) problems.push({ path, message }); };
  const guardrails = await readGuardrails(table, orgId);
  const servable = await options.servableModels?.(orgId);
  const servableNames = servable === undefined ? undefined : new Set(servable.map(canonicalModelName));
  const isForbidden = forbiddenModelMatcher(guardrails.forbiddenModels);
  recipe.steps.forEach((step, index) => {
    const found = step.settings as StepModels;
    for (const key of ["model", "fallbackModel"] as const) {
      const model = found[key];
      if (model === undefined || model === null) continue;
      if (isForbidden(model)) add(`steps.${String(index)}.settings.${key}`, `${modelLabel(model)} is forbidden here; pick another model`);
      else if (servableNames !== undefined && !servableNames.has(canonicalModelName(model))) add(`steps.${String(index)}.settings.${key}`, `${modelLabel(model)} isn't served by any model provider this install can use; pick a model one of them serves`);
    }
    if (typeof found.stepBudgetUsd === "number" && guardrails.maxStepBudgetUsd !== undefined && found.stepBudgetUsd > guardrails.maxStepBudgetUsd) {
      add(`steps.${String(index)}.settings.stepBudgetUsd`, `$${String(found.stepBudgetUsd)} is more than the guardrails allow for one step ($${String(guardrails.maxStepBudgetUsd)})`);
    }
  });
  if (AUTONOMY_ORDER.indexOf(recipe.autonomy) > AUTONOMY_ORDER.indexOf(guardrails.maxAutonomy)) add("autonomy", `${recipe.autonomy} is more than the guardrails allow (${guardrails.maxAutonomy})`);
  if (guardrails.requireCrossCompanyReview) {
    const usable = new Set<ModelCompany>((servable ?? []).filter((model) => !isForbidden(model)).map(modelCompany));
    usable.delete("other");
    const secondCompany = usable.size >= 2;
    const requireDifferent = (path: string, step: ResolvedStep, other: ResolvedStep) => {
      if (differsFrom(step, other)) return;
      if (modelsOf(other).length === 0) add(path, `set the ${other.id} step to a model, so a different AI company can be checked for the ${step.id} step`);
      else if (!secondCompany) add(path, "this install has no model provider from a second AI company, so cross-company review can't be met");
      else add(path, `set the ${step.id} step to a model from a different AI company than the ${other.id} step`);
    };
    recipe.steps.forEach((step, index) => {
      if (step.kind === "review") for (const other of recipe.steps) if (other.kind === "build") requireDifferent(`steps.${String(index)}`, step, other);
      const named = (step.settings as StepModels).differentCompanyFrom;
      const other = typeof named === "string" ? recipe.steps.find((candidate) => candidate.id === named) : undefined;
      if (other !== undefined) requireDifferent(`steps.${String(index)}.settings.differentCompanyFrom`, step, other);
    });
  }
  return problems;
}
