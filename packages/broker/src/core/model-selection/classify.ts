// The single model-safety classifier; process/company/guardrail writers delegate here.
import { EMPTY_RECIPE, ResolvedRecipeSchema, canonicalModelName, modelCompany, type ModelIdentifier, type ResolvedRecipe, type ResolvedStep, type StageId, type CompanyStageModelOverrideSchema } from "@agentx/contracts";
import type { z } from "zod";
import { criticCapabilityTier } from "../second-review/model-ranking.js";
type CompanyOverrides = Partial<Record<StageId, z.infer<typeof CompanyStageModelOverrideSchema>>>;
/** The two company rules about models the classifier reads (the hosted product's guardrails carry more; Code has none, so the rule is stated here by its shape). */
type GuardrailModels = { forbiddenModels: readonly ModelIdentifier[]; requireCrossCompanyReview: boolean };
export type StageChoiceChange =
 | {kind:"process";before:ResolvedRecipe|undefined;after:ResolvedRecipe;firstPublish:boolean}
 | {kind:"guardrails";before:GuardrailModels;after:GuardrailModels}
 | {kind:"company";before:CompanyOverrides;after:CompanyOverrides}
 | {kind:"selection";before:Partial<Record<StageId,ModelIdentifier>>;after:Partial<Record<StageId,ModelIdentifier>>};
type StepModels = { model?: ModelIdentifier | null; fallbackModel?: ModelIdentifier | null; differentCompanyFrom?: string | null; instructions?: ReadonlyArray<{ text: string }> };
const settingsOf = (step: ResolvedStep): StepModels => step.settings as StepModels;

/** The models a step names, its own and its fallback; none when it runs on the project's default. */
const modelsOf = (step: ResolvedStep): ModelIdentifier[] => [settingsOf(step).model, settingsOf(step).fallbackModel].filter((model): model is ModelIdentifier => model !== undefined && model !== null);
const primaryOf = (step: ResolvedStep): ModelIdentifier | undefined => settingsOf(step).model ?? undefined;
const checks = (step: ResolvedStep): boolean => step.kind === "plan_critic" || step.kind === "review";
const sameStep = (left: ResolvedStep, right: ResolvedStep): boolean => left.id === right.id && left.kind === right.kind;
const sameModel = (left: ModelIdentifier, right: ModelIdentifier): boolean => canonicalModelName(left) === canonicalModelName(right);
const labelOf = (step: ResolvedStep): string => (step.kind === "plan_critic" ? "plan check" : "review step");
const namedDifference = (step: ResolvedStep): string | undefined => {
  const named = settingsOf(step).differentCompanyFrom;
  return typeof named === "string" ? named : undefined;
};

/** The steps a checking step is independent of: the plan step for a plan check, every build step for a review. */
const referencesFor = (recipe: ResolvedRecipe, step: ResolvedStep): ResolvedStep[] => recipe.steps.filter((candidate) => candidate.kind === (step.kind === "plan_critic" ? "plan" : "build"));

/** The model that wrote what `step` checks, for the wording. */
const referenceLabel = (recipe: ResolvedRecipe, step: ResolvedStep): string => {
  const [first] = referencesFor(recipe, step);
  return first === undefined ? (step.kind === "plan_critic" ? "the plan step" : "the build step") : `the ${first.kind === "plan" ? "plan" : "build"} step "${first.name}"`;
};

/** Whether the checking step is known to use the same model as a step it checks (every model compared must be set). */
function usesSameModel(recipe: ResolvedRecipe, step: ResolvedStep): boolean {
  const own = primaryOf(step);
  return own !== undefined && referencesFor(recipe, step).some((other) => {
    const theirs = primaryOf(other);
    return theirs !== undefined && sameModel(own, theirs);
  });
}

/** Whether the checking step is known to be independent: it must come from another company than a step, or its model is set and differs from every model of the steps it checks (and one is set). */
function independent(recipe: ResolvedRecipe, step: ResolvedStep): boolean {
  if (namedDifference(step) !== undefined) return true;
  const own = primaryOf(step);
  if (own === undefined) return false;
  const theirs = referencesFor(recipe, step).map(primaryOf).filter((model): model is ModelIdentifier => model !== undefined);
  return theirs.length > 0 && theirs.every((model) => !sameModel(own, model));
}

/** The weakest tier among the models a step names (higher is weaker), or undefined when it names none. */
const weakestTier = (step: ResolvedStep): number | undefined => {
  const tiers = modelsOf(step).map(criticCapabilityTier);
  return tiers.length === 0 ? undefined : Math.max(...tiers);
};

/** A company key: the recognised company's name, or the route's provider for one Rovara does not recognise (two different unknown providers are never treated as the same). */
const companyKey = (model: ModelIdentifier): string => {
  const company = modelCompany(model);
  return company === "other" ? `other:${model.provider}` : company;
};
const companyWords = (key: string): string => (key.startsWith("other:") ? "one Rovara does not recognise" : key);


export function classifyStageChoiceChange(input: StageChoiceChange): string[] {
 if(input.kind==="selection") {
  const recipe=(models:Partial<Record<StageId,ModelIdentifier>>)=>ResolvedRecipeSchema.parse({...EMPTY_RECIPE,steps:Object.entries(models).flatMap(([stage,model])=>model===undefined?[]:[{id:stage,name:stage,...(stage==="code_review"||stage==="security_review"?{reviewers:[stage==="code_review"?"code":"security"]}:{}),kind:stage==="plan_check"?"plan_critic":stage==="code_review"||stage==="security_review"?"review":stage==="understand"?"plan":stage,settings:{instructions:[],model}}])});
  return classifyStageChoiceChange({kind:"process",before:recipe(input.before),after:recipe(input.after),firstPublish:false});
 }
 const found: string[] = [];
 if(input.kind === "guardrails") {
  const stillForbidden = new Set(input.after.forbiddenModels.map(canonicalModelName));
  for(const model of input.before.forbiddenModels) if(!stillForbidden.has(canonicalModelName(model))) found.push(`Allows the model ${model.provider}/${model.modelId} again`);
  if(input.before.requireCrossCompanyReview && !input.after.requireCrossCompanyReview) found.push("Turns off the rule that a review step uses a model from a different AI company");
  return found;
 }
 if(input.kind === "company") {
  for(const stage of ["understand","plan","plan_check","build","code_review","security_review","pull_request"] as const) {
   const before=input.before[stage],after=input.after[stage];
   if(before?.locked === true && after?.locked !== true) found.push(`Removes the company model lock for ${stage}`);
   const prior=before?.model, next=after?.model;
   if(before?.locked === true && after?.locked === true && JSON.stringify(before)!==JSON.stringify(after)) found.push(`Changes the company model lock for ${stage}`);
   if(next!==undefined && prior!==undefined && (stage === "plan_check" || stage === "code_review" || stage === "security_review") && criticCapabilityTier(next)>criticCapabilityTier(prior)) found.push(`Moves the company ${stage} default to a weaker model`);
   if(next!==undefined && prior!==undefined && (next.provider!==prior.provider || companyKey(next)!==companyKey(prior))) found.push(`Uses a new AI provider for the company ${stage} default`);
   if(before?.differentFrom!==undefined && JSON.stringify(before.differentFrom)!==JSON.stringify(after?.differentFrom)) found.push(`Changes the company different-model rule for ${stage}`);
   if(stage === "plan_check" || stage === "code_review" || stage === "security_review") {
    const reference=input.after[stage === "plan_check" ? "plan" : "build"]?.model;
    const priorReference=input.before[stage === "plan_check" ? "plan" : "build"]?.model;
    if(next!==undefined && reference!==undefined && sameModel(next,reference) && (prior===undefined || priorReference===undefined || !sameModel(prior,priorReference))) found.push(`Makes the company ${stage} default use the same model as the stage it checks`);
   }
  }
  return [...new Set(found)];
 }
 const before=input.before??EMPTY_RECIPE, next=input.after, context={firstPublish:input.firstPublish};
  for (const step of next.steps) {
    const was = before.steps.find((candidate) => sameStep(candidate, step));
    if (was === undefined || !checks(step)) continue;
    if (independent(before, was)) {
      if (usesSameModel(next, step)) found.push(`Makes the ${labelOf(step)} "${step.name}" use the same model as ${referenceLabel(next, step)}`);
      const named = namedDifference(was);
      if (named !== undefined && namedDifference(step) !== named) found.push(`Stops the ${labelOf(step)} "${step.name}" needing a different AI company from the step it checks`);
    }
    const tierBefore = weakestTier(was);
    const tierAfter = weakestTier(step);
    if (tierBefore !== undefined && tierAfter !== undefined && tierAfter > tierBefore) found.push(`Moves the ${labelOf(step)} "${step.name}" to a weaker model`);
  }
  const used = new Set(before.steps.flatMap((step) => modelsOf(step).map(companyKey)));
  const usedProviders = new Set(before.steps.flatMap((step) => modelsOf(step).map((model) => model.provider)));
  for (const step of next.steps) {
    for (const model of modelsOf(step)) {
      if (used.has(companyKey(model)) && !usedProviders.has(model.provider)) found.push(`Lets the step "${step.name}" send data through a new model provider (${model.provider})`);
    }
    for (const key of new Set(modelsOf(step).map(companyKey))) {
      if (used.has(key)) continue;
      found.push(context.firstPublish
        ? `Lets the step "${step.name}" send data to an AI company (${companyWords(key)}) that the process it builds on does not use`
        : `Lets the step "${step.name}" send data to a new AI company (${companyWords(key)})`);
    }
  }
  return [...new Set(found)];
}
