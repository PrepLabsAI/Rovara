// Second review on a laptop: the install's answers to the core's seams (`core/second-review/seams.ts`) from what `rovara up` has: the model providers (the `model-provider` plug-ins), the key store, the owner's
// chosen model and the registered projects. The core knows no provider; this is the one place that does.
import { providerFormat, type ModelIdentifier, type ModelKeyStore } from "@agentx/contracts";
import { catalogModelIds, listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { createModelPrices, usdPerMillion, type ModelPrices } from "../../core/cost/price-table.js";
import { SECOND_REVIEW_TYPICAL_REVIEW_TOKENS, estimateSecondReviewUsd, type SecondReviewSeams } from "../../core/second-review/index.js";
import { servableModels } from "./servable-models.js";
import { readyProviders } from "../model-proxy/credentials.js";
import { ASSUMED_MAX_OUTPUT_TOKENS } from "../model-proxy/proxy.js";
import { localRoute } from "../model-proxy/providers.js";
import type { ModelProviderBook } from "../model-proxy/types.js";
import type { LocalModelChoice } from "../model-choice.js";
import type { ProjectSource } from "../../core/task-flow/deps.js";

export interface LocalSecondReviewSeamsOptions {
  companyId: string;
  providers: ModelProviderBook;
  keys: ModelKeyStore;
  /** The install's one chosen model (the owner's `model` setting, else the first provider with a key): every step of a task runs on it. */
  chosen(): Promise<LocalModelChoice | undefined>;
  projects: Pick<ProjectSource, "latest">;
  /** What a model costs (the provider's own table, then the catalog). A model with no price is not used as the second reviewer: its spend could not be capped. */
  prices?: ModelPrices;
  /** For tests: the models a provider could serve (default: the installed catalog). */
  catalog?: (provider: string) => readonly string[];
  /** The models that built and first reviewed a task, from what its operations recorded. Absent: every step ran on the install's one chosen model. */
  taskModels?: SecondReviewSeams["taskModels"];
}

/** What the second reviewer may spend in one operation: ten typical reviews, and never less than three of the most one call can be assumed to cost (so a refusal is the cap, not one big call). */
export const SECOND_REVIEW_CAP_TYPICAL_REVIEWS = 10;
export const SECOND_REVIEW_CAP_WORST_CALLS = 3;
export function capUsdOf(rates: { input: number; output: number }): number {
  const typical = estimateSecondReviewUsd({ inputUsdPerMTok: rates.input, outputUsdPerMTok: rates.output }, { input: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input, maxOutput: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output });
  const worstCall = (WORST_INPUT_TOKENS * rates.input + ASSUMED_MAX_OUTPUT_TOKENS * rates.output) / 1_000_000;
  return Math.max(SECOND_REVIEW_CAP_TYPICAL_REVIEWS * typical, SECOND_REVIEW_CAP_WORST_CALLS * worstCall);
}
/** The largest review request the cap is sized for (tokens): a request bigger than this is refused as over the cap. */
const WORST_INPUT_TOKENS = 300_000;

export function createLocalSecondReviewSeams(options: LocalSecondReviewSeamsOptions): SecondReviewSeams {
  const ready = (): Promise<string[]> => readyProviders(options.providers, options.keys, options.companyId);
  const catalog = options.catalog ?? catalogModelIds;
  // Without the install's lookup, the catalog's list prices alone.
  const prices = options.prices ?? createModelPrices({ providers: () => [], catalog: listPricesPerMillion });
  const identityOf = (choice: LocalModelChoice): ModelIdentifier => ({ provider: choice.provider, modelId: choice.model });
  return {
    async sources() {
      // The model the install runs its steps on is always one it can serve, whatever the catalog lists.
      return servableModels({ companyId: options.companyId, providers: options.providers, keys: options.keys, catalog, installModel: async () => { const chosen = await options.chosen(); return chosen === undefined ? undefined : identityOf(chosen); } });
    },
    async route(model) {
      // The second reviewer is called by the install's own key, through the model proxy and never on a person's own plan; a provider with no sign-in on this computer serves nothing.
      const row = options.providers.get(model.provider);
      if (row === undefined || !(await ready()).includes(model.provider)) return undefined;
      const format = providerFormat(row)?.format;
      if (format === undefined) return undefined;
      // The second reviewer's spend is capped in the model proxy, at the model's rates (its provider's own table, else the catalog's list price); a model with no price cannot be capped, so it is not used.
      const rates = usdPerMillion(prices.findCap(model));
      if (rates === undefined) return undefined;
      const routed = localRoute(model.provider, model.modelId, format);
      return { workerRoute: routed.workerRoute, alias: routed.route.alias, cap: { capUsd: capUsdOf(rates), usdPerMTok: { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite } } };
    },
    async taskModels(task) {
      if (options.taskModels !== undefined) return options.taskModels(task);
      // No per-step record: every step of a task ran on the install's one chosen model, so that is the model that wrote the code and the one the first reviewer ran on.
      const chosen = await options.chosen();
      return chosen === undefined ? { builds: [], firstReviewer: undefined } : { builds: [identityOf(chosen)], firstReviewer: identityOf(chosen) };
    },
    price(model) {
      const found = usdPerMillion(prices.findCap(model));
      return found === undefined ? undefined : { inputUsdPerMTok: found.input, outputUsdPerMTok: found.output };
    },
    async projectExists(project) { return (await options.projects.latest(project)) !== undefined; },
  };
}
