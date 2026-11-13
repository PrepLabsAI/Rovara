// What a setup run's model costs per million tokens (sh-setup-wire, SH14 fix round, F3). The governor stops the run before a turn could cross the budget, so it needs the model's real prices, not a guess.
// They come from the catalog the product already holds for models (`E2E_AGENT_ELIGIBLE_MODELS`: dollars per million input and output tokens), matched by the model's canonical name; when several entries
// match (regional profiles of one model) the dearest wins. A model with no entry has NO price, and a setup run does not start for it: money is never estimated from a guess.
import { E2E_AGENT_ELIGIBLE_MODELS, canonicalModelName } from "@rovara-code/contracts";

export interface ModelPrice { inputPerMTok: number; outputPerMTok: number }

export function setupModelPrice(model: { provider: string; modelId: string }): ModelPrice | undefined {
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
