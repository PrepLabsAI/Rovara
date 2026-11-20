// What a setup run's model costs per million tokens (sh-setup-wire, SH14 fix round, F3). The governor stops the run before a turn could cross the budget, so it needs the model's real prices, not a guess.
// They come from the catalog the product already holds for models (`E2E_AGENT_ELIGIBLE_MODELS`: dollars per million input and output tokens), matched by the model's canonical name; when several entries
// match (regional profiles of one model) the dearest wins. A model with no entry has NO price, and a setup run does not start for it: money is never estimated from a guess.
import { E2E_AGENT_ELIGIBLE_MODELS, canonicalModelName, type InvocationModelRoute } from "@agentx/contracts";
import { ROUTE_PROVIDER, routeUsageIdentity } from "@agentx/model-runtime";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";

/**
 * Hotfix 0.5.33 (DEC 254zzz207): whether this run's model spend is metered by the broker. On a laptop that is the boot-time model proxy (`AGENTX_MODEL_PROXY_URL`); on a hosted worker
 * (EC2) there is no such variable, and the broker hands the invocation its own `modelRoute`, which the worker calls through the control plane's model-access route (task-model.ts, design-review-sessions.ts
 * `operationModelProxy`). Either one meters the spend on the broker's ledger. Neither means the run does not start: no other way in.
 */
export function modelSpendIsMetered(environment: NodeJS.ProcessEnv, payload: { modelRoute?: unknown }): boolean {
  const proxy = environment["AGENTX_MODEL_PROXY_URL"];
  return (proxy !== undefined && proxy !== "") || payload.modelRoute !== undefined;
}

export interface ModelPrice { inputPerMTok: number; outputPerMTok: number }

/**
 * Hotfix 0.5.33: what the broker's LEDGER charges a routed (hosted) run. The hosted meter (broker core-host/hosted-modules.ts `createHostedMetering`, `prices.findCap`) prices a usage under the identity the worker
 * reports for a route, `routeUsageIdentity(route)` (worker pi-session.ts `reportedModel`), at the model runtime's catalog list price (`listPricesPerMillion`, hosted-modules.ts `createModelPrices({ catalog })`;
 * price-table.ts `catalogPriceOf`: both figures known and above zero, else no price). Setup prices a route by that SAME chain, so the governor's price is the ledger's price and never lower (staging `zai.glm-5` is
 * Bedrock's $1.00/$3.20, where the OpenRouter `z-ai/glm-5` entry of the e2e list says $0.60/$1.90). No price in that chain: undefined, and the run does not start (the ledger would charge its cautious fixed price; setup never guesses).
 */
function routedModelPrice(route: InvocationModelRoute): ModelPrice | undefined {
  const listed = listPricesPerMillion(routeUsageIdentity(route));
  if (listed === undefined) return undefined;
  const known = (value: number): boolean => Number.isFinite(value) && value > 0 && Math.round(value * 1_000_000) > 0;
  return known(listed.input) && known(listed.output) ? { inputPerMTok: listed.input, outputPerMTok: listed.output } : undefined;
}

export function setupModelPrice(model: { provider: string; modelId: string }, route?: InvocationModelRoute): ModelPrice | undefined {
  // A routed run (hosted: the task model is `rovara-route` + the route's alias) is priced as the ledger prices it; a laptop run (no route) is priced from the e2e list below, unchanged.
  if (route !== undefined && model.provider === ROUTE_PROVIDER) return routedModelPrice(route);
  const wanted = canonicalModelName(model);
  let found: ModelPrice | undefined;
  for (const entry of E2E_AGENT_ELIGIBLE_MODELS) {
    if (canonicalModelName({ provider: entry.provider, modelId: entry.modelId }) !== wanted) continue;
    if (!Number.isFinite(entry.inputUsdPerMTok) || !Number.isFinite(entry.outputUsdPerMTok) || entry.inputUsdPerMTok < 0 || entry.outputUsdPerMTok < 0) continue;
    found = found === undefined ? { inputPerMTok: entry.inputUsdPerMTok, outputPerMTok: entry.outputUsdPerMTok }
      : { inputPerMTok: Math.max(found.inputPerMTok, entry.inputUsdPerMTok), outputPerMTok: Math.max(found.outputPerMTok, entry.outputUsdPerMTok) };
  }
  return found;
}

/** The tokens one more turn may add on top of the last turn's input and output: a command's output and the model's next words, in a bound (4 KiB of text is about 1,024 tokens). */
export const SETUP_NEXT_TURN_MARGIN_TOKENS = 1_024;

/** A cache write costs 1.25 times the input price: the extra quarter, on top of the input price already counted for it. */
export const SETUP_CACHE_WRITE_EXTRA = 0.25;
