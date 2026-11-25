/**
 * Reviewed Bedrock ids whose name does not fold to the AWS price list's name for the model (BEDROCK-PRICE-ROWS, 2026-11-16): the
 * exact id (lower case, without its Region group) to that name, folded. deepseek.v3-v1:0 is DeepSeek-V3.1 (its name is the provider's
 * version alone); gpt-oss carries a `-1:0` id version. AWS names assumed: "DeepSeek V3.1", "DeepSeek V3.2", "DeepSeek R1",
 * "gpt-oss-120b", "gpt-oss-20b": the first staging fetch (2026-11-17) found no AWS row for any of them, so today they are priced from
 * LiteLLM's rows for the same ids (tests/unit/model-gateway-price-identity.test.ts lists the real AWS rows). Exact ids only, so
 * another version of these models gets no row from here (the cautious price) until it is checked and added.
 */
const BEDROCK_PRICE_NAMES: ReadonlyMap<string, string> = new Map([
  ["deepseek.v3-v1:0", "deepseek-v3-1"],
  ["deepseek.v3.2", "deepseek-v3-2"],
  ["deepseek.r1-v1:0", "deepseek-r1"],
  ["openai.gpt-oss-120b-1:0", "gpt-oss-120b"],
  ["openai.gpt-oss-20b-1:0", "gpt-oss-20b"],
]);
/** An id's own date and version: `-20251001`, `-v1:0`, `@001`. */
const ID_SUFFIX = /(?:-\d{8})?(?:-v\d+(?::\d+)?)?$|@\d+$/u;
const REGION_GROUP = /^(?:us-gov|us|eu|apac|global|jp|au|in|ca)\./u;
/** The provider in front of the name (`moonshotai.`); only before a letter, so a version dot (`kimi-k2.5`) is never taken for one. */
const PROVIDER = /^[a-z0-9-]+\.(?=[a-z])/u;

function foldOnce(model: string): string {
  const whole = model.trim().slice(model.trim().indexOf("/") + 1).toLowerCase().replace(REGION_GROUP, "");
  const named = BEDROCK_PRICE_NAMES.get(whole);
  if (named !== undefined) return named;
  const text = whole.replace(ID_SUFFIX, "").replace(REGION_GROUP, "").replace(PROVIDER, "");
  const folded = text.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  // Nothing left to name a model by: keep the name as given (never empty; it has a character no folded identity has).
  return folded !== "" ? folded : whole !== "" ? whole : model.trim().toLowerCase();
}
/**
 * Bedrock alias folding, with the shared case/whitespace identity policy. One identity for a call's Bedrock id, a LiteLLM Bedrock
 * key and an AWS price list name (fetchAWS folds those to lower case with dashes): the Region group, the provider and the id's own
 * date and version are dropped, then every run of other characters becomes one dash, exactly as fetchAWS folds AWS names. So
 * `moonshotai.kimi-k2.5` and the price list's "Kimi K2.5" are both `kimi-k2-5`. Two names that differ only in punctuation fold to
 * one identity: the price pool then holds the dearer of their rows. Idempotent (validSnapshot requires a stored identity to fold to
 * itself): folding repeats until nothing changes.
 */
export function normalizeBedrockModel(model: string): string {
  let text = foldOnce(model);
  // A pass never makes the text longer and only a shorter (or lower-cased) text differs; the cap is a backstop, never reached.
  for (let i = 0, next = foldOnce(text); next !== text && i <= model.length; i++, next = foldOnce(text)) text = next;
  return text;
}
export function normalizedModel(provider: string, model: string): string {
  const text = model.trim().toLowerCase();
  return provider === "bedrock" ? normalizeBedrockModel(text) : provider === "gemini" ? text.replace(/^gemini\//u, "") : text;
}
export const identityKey = (provider: string, model: string): string => JSON.stringify([provider, normalizedModel(provider, model)]);
