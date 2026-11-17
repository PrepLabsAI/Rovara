// Vendor families of models, and whether a model name belongs to one (moved unchanged out of side-by-side-judge-pin.ts, owner 2026-11-16 option B, so callers outside that lane need not import it). Pure.

/** The closed list of vendor families. An API format (`anthropic_messages`, `openai_compatible`, `vertex`, `bedrock`) is NOT a vendor family and is never accepted as one. */
export const VENDOR_FAMILIES = ["anthropic", "google", "openai", "cohere", "meta", "mistral", "amazon", "xai", "deepseek"] as const;
export type VendorFamily = (typeof VENDOR_FAMILIES)[number];
/** The words that name a vendor family; `claude` and `anthropic` are one family. */
const FAMILY_WORDS: Readonly<Record<string, VendorFamily>> = Object.freeze({
  anthropic: "anthropic", claude: "anthropic", google: "google", gemini: "google", gemma: "google", openai: "openai", gpt: "openai", cohere: "cohere", command: "cohere", meta: "meta", llama: "meta", mistral: "mistral", mixtral: "mistral",
  amazon: "amazon", nova: "amazon", titan: "amazon", xai: "xai", grok: "xai", deepseek: "deepseek",
});
/** The model-name stems of each family: the stem is at the start of the name or after a `.`, `/` or `:` (a vendor or Bedrock prefix). */
const FAMILY_MODELS: Readonly<Record<VendorFamily, RegExp>> = {
  anthropic: /(?:^|[./:])claude/iu, google: /(?:^|[./:])(?:gemini|gemma)/iu, openai: /(?:^|[./:])(?:gpt|chatgpt|o\d)/iu, cohere: /(?:^|[./:])(?:command|c4ai)/iu, meta: /(?:^|[./:])(?:llama|meta-llama)/iu,
  mistral: /(?:^|[./:])(?:mistral|mixtral|codestral|ministral)/iu, amazon: /(?:^|[./:])(?:nova|titan|amazon)/iu, xai: /(?:^|[./:])grok/iu, deepseek: /(?:^|[./:])deepseek/iu,
};

/** The vendor family a word names, or undefined for anything not on the list. */
export function vendorFamilyOf(value: unknown): VendorFamily | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const word = value.trim().toLowerCase();
  return Object.hasOwn(FAMILY_WORDS, word) ? FAMILY_WORDS[word] : undefined;
}
/** Whether a model name belongs to the family it is said to be from. */
export function modelBelongsToFamily(model: unknown, family: VendorFamily): boolean {
  return typeof model === "string" && model.length <= 128 && FAMILY_MODELS[family].test(model);
}
