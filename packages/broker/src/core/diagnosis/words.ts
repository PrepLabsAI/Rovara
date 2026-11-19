// Fix with agent on a laptop: the fixed words a person reads. The shared contract's sentences (`DIAGNOSIS_REFUSALS`, `DIAGNOSIS_FAILURE_WORDS`) point at a hosted product's Settings and Admin screens, which do not exist here, so
// the sentences a laptop says are these. Fixed text only: no refusal repeats anything of the error, the task or the model's answer.
import { DIAGNOSIS_REFUSALS, agentXError, type DiagnosisFailureReason } from "@agentx/contracts";

export const DIAGNOSIS_LAPTOP_REFUSALS = {
  ...DIAGNOSIS_REFUSALS,
  /** No model key on this computer: a diagnosis runs on the owner's own key, never on one Rovara pays for. */
  noProvider: "Fix with agent runs on your own model key, and none is set up on this computer. Run `rovara up --check` to see how to set one.",
  /** The chosen model has no known price, so a diagnosis cannot be held to its spending limit and is not run (a model with no price is refused, never guessed). */
  notPriced: "Fix with agent can't run on this model: its price isn't known, so Rovara can't hold the call to its spending limit. Choose a model with a known price in your config.",
  /** The most the call could cost, for this much error data on this model, is over the diagnosis's spending limit, so it could only be refused: it is not offered. */
  tooDear: "Fix with agent can't run on this model for an error with this much data: the most the call could cost is over its spending limit. Choose a model that costs less in your config.",
  notAvailableHere: "That is not on this install yet: Rovara on this computer does not do it. It comes with a later release.",
  startOnThePage: "Fix with agent is started on the task's page, by you. Run `rovara open <task>` and press \"Fix with agent\"; an assistant cannot spend your model key for you.",
  couldNot: "Couldn't diagnose this now.",
} as const;

/** What a person reads when a light diagnosis could not run, by reason. At most 200 characters (the status's `failure`). */
export const DIAGNOSIS_LAPTOP_FAILURE_WORDS: Record<DiagnosisFailureReason, string> = {
  model_rejected: "Your AI provider refused the model Rovara used. Choose another model in your config, then try again.",
  key_invalid: "Your AI provider did not accept the key on this computer. Check it with `rovara up --check`, then try again.",
  limit_reached: "The diagnosis reached its spending limit or your provider's limit. Try again, or choose a model that costs less in your config.",
  provider_unavailable: "Your AI provider didn't answer. Try again in a few minutes.",
};

/** The rules of a laptop's answer turn are the shared ones; its role line is fixed so nothing a person or a repository wrote is ever the instructions. */
export const DIAGNOSIS_LAPTOP_INSTRUCTIONS = "You diagnose one error for the person who runs a software project. Answer only from the data you are given.";

/** The most output one diagnosis may ask for (its answer is at most 12,000 characters). */
export const DIAGNOSIS_MAX_OUTPUT_TOKENS = 4_000;

/** The refusals a diagnosis can say, one sentence each (the keys of the shared contract's, plus the laptop's own). */
export type DiagnosisRefusalWords = { readonly [Name in keyof typeof DIAGNOSIS_LAPTOP_REFUSALS]: string };

/**
 * Every sentence a diagnosis says to a person: its refusals and, for a light diagnosis that could not run, why. A host (a laptop, or a cloud worker with its own screens) passes its own whole set to `createDiagnosis`, so no
 * next step in the words (a command, a screen) is one the host does not have. The words are complete on purpose: a missing sentence would fall back to another host's, so `diagnosisWordsChecked` refuses a set with a gap.
 */
export interface DiagnosisWords {
  refusals: DiagnosisRefusalWords;
  failure: Readonly<Record<DiagnosisFailureReason, string>>;
}

/** What a laptop says (`rovara up`): the default of `createDiagnosis`. */
export const DIAGNOSIS_LAPTOP_WORDS: DiagnosisWords = { refusals: DIAGNOSIS_LAPTOP_REFUSALS, failure: DIAGNOSIS_LAPTOP_FAILURE_WORDS };

/** The longest a failure sentence may be (the status's `failure`). */
const FAILURE_WORDS_MAX = 200;

/** The words as given, once each sentence is known to be there (text, not empty; a failure sentence within its limit); otherwise a CONFIG_INVALID naming the first gap, so the host finds it when it starts and a person never reads a missing sentence. */
export function diagnosisWordsChecked(words: DiagnosisWords): DiagnosisWords {
  const gap = (group: string, name: string) => agentXError("CONFIG_INVALID", `the diagnosis words have no usable ${group} sentence ${name}`);
  for (const name of Object.keys(DIAGNOSIS_LAPTOP_REFUSALS)) {
    const sentence = (words.refusals as Record<string, unknown> | undefined)?.[name];
    if (typeof sentence !== "string" || sentence.trim() === "") throw gap("refusal", name);
  }
  for (const name of Object.keys(DIAGNOSIS_LAPTOP_FAILURE_WORDS)) {
    const sentence = (words.failure as Record<string, unknown> | undefined)?.[name];
    if (typeof sentence !== "string" || sentence.trim() === "" || sentence.length > FAILURE_WORDS_MAX) throw gap("failure", name);
  }
  return words;
}
