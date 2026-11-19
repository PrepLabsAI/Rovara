// The model ranking and the allowed-model filter shared by the second review's picker and the plan check: how strong a model is taken to be, the order a stage prefers, and which models a project's limits allow.
// There is ONE copy of this order: the plan check imports it from here.
import { canonicalModelName, forbiddenModelMatcher, modelCompany, type ModelIdentifier } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { isBatchVariant } from "./model-variants.js";

export const sameModel = (left: ModelIdentifier, right: ModelIdentifier): boolean => canonicalModelName(left) === canonicalModelName(right);

/** The first model of each name, in order: the same model offered by two sources is one model. */
export function distinct(models: readonly ModelIdentifier[]): ModelIdentifier[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const name = canonicalModelName(model);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/**
 * How strong a model is taken to be, for choosing a critic on purpose (never by the order a catalog lists its models). Strongest tier first; a model is in the first tier whose pattern its
 * canonical name matches, and a model no tier names is last. The one place this order lives: change it here.
 *
 * Hand-made until the replay eval ranks models; no vendor is ranked above another. So the top tier is ONE "frontier" tier (Fable, Opus, GPT-5 that is not a mini or nano, Gemini Pro) with no order
 * inside it by vendor or by name; below it Sonnet, then the small models (Haiku, mini, nano, flash), then models no tier names. Among frontier models a stage prefers (1) a different company from the
 * step it checks, then (2) the cheaper model by the catalog's list price (a model with no price counts as the middle price of the frontier models that have one, see `neutralCost`), then
 * (3) the newer version. Sonnet and below keep "newer version first".
 */
export const CRITIC_CAPABILITY_TIERS: ReadonlyArray<RegExp> = [
  /(^|-)fable(-|$)|(^|-)opus(-|$)|^gpt-5(?!.*(mini|nano))|(^|-)gemini-.*pro/u,
  /(^|-)sonnet(-|$)/u,
  /(^|-)(haiku|mini|nano|flash)(-|$)/u,
];
/** The frontier tier: the one whose models are ordered by company, then cost, then version. */
const FRONTIER_TIER = 0;

/**
 * The order before the one frontier tier (tasks already running keep the review model they started with): Fable, then Opus, then GPT-5, then Gemini Pro, then Sonnet, then the
 * small models, newest version first inside each. A task pinned (or started) before the frontier tier existed ranks by this, so its next review or plan check cannot switch model because the order changed.
 * Only reached with `legacyRanking`; delete it with that flag once no such task is left.
 */
const LEGACY_CRITIC_CAPABILITY_TIERS: ReadonlyArray<RegExp> = [
  /(^|-)fable(-|$)/u,
  /(^|-)opus(-|$)/u,
  /^gpt-5(?!.*(mini|nano))/u,
  /(^|-)gemini-.*pro/u,
  /(^|-)sonnet(-|$)/u,
  /(^|-)(haiku|mini|nano|flash)(-|$)/u,
];

/** The numbers in a canonical name, as its version (`claude-opus-5-5` is [5, 5]): a longer version with the same start is newer. */
const versionOf = (model: ModelIdentifier): number[] => (canonicalModelName(model).match(/\d+/gu) ?? []).map(Number);

/** The tier of a model (0 is strongest; a model no tier names is last). */
export function criticCapabilityTier(model: ModelIdentifier): number {
  return tierIn(CRITIC_CAPABILITY_TIERS, model);
}

/** The tier of a model by the order before the frontier tier (see `LEGACY_CRITIC_CAPABILITY_TIERS`). A separate function, not a flag, so `models.map(criticCapabilityTier)` stays safe. */
export function legacyCriticCapabilityTier(model: ModelIdentifier): number {
  return tierIn(LEGACY_CRITIC_CAPABILITY_TIERS, model);
}

function tierIn(tiers: ReadonlyArray<RegExp>, model: ModelIdentifier): number {
  const name = canonicalModelName(model);
  const found = tiers.findIndex((tier) => tier.test(name));
  return found < 0 ? tiers.length : found;
}

/** Whether `model` is from a known company other than `reference`'s (a model of an unrecognised company is never shown to differ). */
const fromOtherCompany = (model: ModelIdentifier, reference: ModelIdentifier): boolean => modelCompany(model) !== "other" && modelCompany(reference) !== "other" && modelCompany(model) !== modelCompany(reference);

/** What one review costs at the catalog's list price: one million tokens in plus one million out, in dollars; undefined when the catalog has no price for the model. Only used to break a tie inside the frontier tier. */
function listCost(model: ModelIdentifier): number | undefined {
  const price = listPricesPerMillion(model);
  return price === undefined ? undefined : price.input + price.output;
}

/**
 * The cost a model with no catalog price counts as: the middle of the frontier models that do have one, so a missing price neither ranks a model first nor last (no vendor is favoured or penalised by what the
 * catalog happens to list). It ties on cost with the model at that middle price, and the order then falls to the newer version and the name. It is a number, not a "ties with everyone" rule, so the order stays
 * consistent (a tie with every model would put A before B by price, B before the unpriced model by version and the unpriced model before A by version: a cycle). With no priced frontier model they all tie.
 */
function neutralCost(models: readonly ModelIdentifier[]): number {
  const costs = models.filter((model) => criticCapabilityTier(model) === FRONTIER_TIER).flatMap((model) => listCost(model) ?? []).sort((left, right) => left - right);
  if (costs.length === 0) return 0;
  const middle = Math.floor(costs.length / 2);
  return costs.length % 2 === 1 ? costs[middle]! : (costs[middle - 1]! + costs[middle]!) / 2;
}

/**
 * Models strongest first: by tier, then (inside the frontier tier only) a company different from `reference`'s first, then cheaper, then newest version, then canonical name; models that rank the same
 * otherwise keep the order they came in.
 */
export function rankCriticModels(models: readonly ModelIdentifier[], reference?: ModelIdentifier, legacyRanking = false): ModelIdentifier[] {
  const neutral = legacyRanking ? 0 : neutralCost(models);
  const costOf = (model: ModelIdentifier): number => listCost(model) ?? neutral;
  return models.map((model, index) => ({ model, index })).sort((left, right) => {
    const tierOf = legacyRanking ? legacyCriticCapabilityTier : criticCapabilityTier;
    const tier = tierOf(left.model) - tierOf(right.model);
    if (tier !== 0) return tier;
    const frontier = !legacyRanking && criticCapabilityTier(left.model) === FRONTIER_TIER;
    if (frontier) {
      if (reference !== undefined) {
        const other = Number(fromOtherCompany(right.model, reference)) - Number(fromOtherCompany(left.model, reference));
        if (other !== 0) return other;
      }
      const dearer = costOf(left.model), cheaper = costOf(right.model);
      if (dearer !== cheaper) return dearer < cheaper ? -1 : 1;
    }
    const a = versionOf(left.model);
    const b = versionOf(right.model);
    for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
      const difference = (b[at] ?? -1) - (a[at] ?? -1);
      if (difference !== 0) return difference;
    }
    if (frontier) {
      const name = canonicalModelName(left.model).localeCompare(canonicalModelName(right.model));
      if (name !== 0) return name;
    }
    return left.index - right.index;
  }).map((entry) => entry.model);
}

/** What limits the models a plan check may run on: the project's approved list (absent: it lists none) and the models the company forbids. */
export interface CriticModelLimits {
  approved?: readonly ModelIdentifier[] | undefined;
  forbidden?: readonly ModelIdentifier[] | undefined;
  /** Models this task's earlier plan checks already tried and the account could not use (a provider answered 403 for a model the account had not enabled): each is left out, by canonical name. */
  unusable?: readonly ModelIdentifier[] | undefined;
  /** The model of the step this one checks: among frontier models a different company's is preferred (see `CRITIC_CAPABILITY_TIERS`). Undefined: no company is preferred. */
  reference?: ModelIdentifier | undefined;
  /** The task started before the frontier tier: rank by the order it started with (`LEGACY_CRITIC_CAPABILITY_TIERS`), a failed tier is any model of that tier, and no company is preferred. */
  legacyRanking?: boolean | undefined;
}

/** Whether `model` is one the limits allow: not forbidden (by canonical name, so another route to a forbidden model is forbidden too) and, when the project lists models, one of them. */
export function allowed(limits: CriticModelLimits, model: ModelIdentifier): boolean {
  return !forbiddenModelMatcher(limits.forbidden ?? [])(model) && (limits.approved === undefined || limits.approved.some((other) => sameModel(other, model)));
}

/** Whether an earlier plan check already found `model` unusable for this account. */
export const triedAndFailed = (limits: CriticModelLimits, model: ModelIdentifier): boolean => (limits.unusable ?? []).some((other) => sameModel(other, model));


/**
 * The models a plan check could run on, strongest first (`sources` already holds only what the project's sources serve for this org, and the order they list them in decides nothing): those the
 * limits allow and no earlier check found unusable. When no source list is known (an install with no model proxy) the project's approved models, in their order, stand in for it.
 */
export function candidatesOf(limits: CriticModelLimits, sources: readonly ModelIdentifier[]): ModelIdentifier[] {
  const pool = sources.length > 0 ? sources : limits.approved ?? [];
  // LP-11: an OpenRouter `:batch` variant is the Batch API's id (answered within a day), never a model for a review or a plan check, whoever lists it. Dropped BEFORE `distinct`, so it cannot take the place of the plain model
  // (the two share a canonical name).
  const ranked = rankCriticModels(distinct(pool.filter((model) => !isBatchVariant(model) && allowed(limits, model) && !triedAndFailed(limits, model))), limits.reference, limits.legacyRanking === true);
  return failedTiersLast(limits, ranked);
}

/**
 * A model the account could not use says its capability tier is likely out of reach (an account enables models by generation, so several in a row may be refused),
 * so after a failure the next try is a tier that has not failed yet, strongest first. A tier that failed once gets another model only when every other tier has also failed. Nothing failed: unchanged.
 */
function failedTiersLast(limits: CriticModelLimits, ranked: readonly ModelIdentifier[]): ModelIdentifier[] {
  // A tier is "failed" for one company at a time: the frontier tier holds several companies, and one company's refusal (GPT-5 with no quota) says nothing about another's (Opus).
  const legacy = limits.legacyRanking === true;
  const kind = (model: ModelIdentifier): string => legacy ? String(legacyCriticCapabilityTier(model)) : `${modelCompany(model) === "other" ? `other:${model.provider}` : modelCompany(model)}/${String(criticCapabilityTier(model))}`;
  const failedTiers = new Set((limits.unusable ?? []).map(kind));
  if (failedTiers.size === 0) return [...ranked];
  return [...ranked.filter((model) => !failedTiers.has(kind(model))), ...ranked.filter((model) => failedTiers.has(kind(model)))];
}


/** Whether `left` is from a known AI company other than `right`'s. A model of an unrecognised company can never be shown to differ. */
export function differentCompany(left: ModelIdentifier | undefined, right: ModelIdentifier | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const a = modelCompany(left);
  const b = modelCompany(right);
  return a !== "other" && b !== "other" && a !== b;
}
