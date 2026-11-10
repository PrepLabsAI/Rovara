import type { Api, Model } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { BEDROCK_REGION_PREFIXES, canonicalModelName, type ModelIdentifier } from "@agentx/contracts";

/**
 * The provider name a routed model is registered under. Here, not in index.ts: the package root loads the whole coding-agent runtime (which reads `import.meta.url` when it loads and cannot be bundled into a
 * CommonJS Lambda), so the control plane imports this from `@agentx/model-runtime/catalog`.
 */
export const ROUTE_PROVIDER = "rovara-route";

let catalogs: Map<string, ReadonlyMap<string, Model<Api>>> | undefined;

/** A Bedrock cross-region inference profile names its model with a geography prefix the catalog omits. */
const INFERENCE_PROFILE = new RegExp(`^(?:${BEDROCK_REGION_PREFIXES.join("|")})\\.`);

/** The installed Pi catalogs' entry for a model, which the runtime resolves models from; undefined when neither knows it. */
export function catalogModel(model: ModelIdentifier): Model<Api> | undefined {
  return loadCatalogs().get(model.provider)?.get(model.modelId);
}

function loadCatalogs(): Map<string, ReadonlyMap<string, Model<Api>>> {
  catalogs ??= new Map([
    ["openrouter", new Map(openrouterProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["amazon-bedrock", new Map(amazonBedrockProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["anthropic", new Map(anthropicProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["openai", new Map(openaiProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
  ]);
  return catalogs;
}

/** The ids of the models the installed Pi catalog lists for one provider (`anthropic`, `openai`, `openrouter`, `amazon-bedrock`); none for a provider it does not know. For choosing among the models an install could call. */
export function catalogModelIds(provider: string): string[] {
  return [...(loadCatalogs().get(provider)?.keys() ?? [])];
}

/** The provider whose entry names a routed model, first: the model's own maker, then Bedrock's profiles, then the aggregator. */
const ROUTE_CATALOG_ORDER = ["anthropic", "openai", "amazon-bedrock", "openrouter"] as const;
let canonicalIndex: Map<string, { identity: ModelIdentifier; model: Model<Api> }> | undefined;

/**
 * The catalog entry a route's `catalog` names: an entry whose id is exactly that (a Bedrock inference-profile id, say), else
 * the one whose canonical name is (`gpt-5-4` for `gpt-5.4`). Undefined when the installed catalogs do not know the model,
 * as for a company's own model.
 */
export function catalogModelByName(name: string): { identity: ModelIdentifier; model: Model<Api> } | undefined {
  const all = loadCatalogs();
  for (const provider of ROUTE_CATALOG_ORDER) {
    const model = all.get(provider)?.get(name);
    if (model !== undefined) return { identity: { provider, modelId: name }, model };
  }
  if (canonicalIndex === undefined) {
    canonicalIndex = new Map();
    for (const provider of ROUTE_CATALOG_ORDER) {
      for (const [modelId, model] of all.get(provider) ?? []) {
        const key = canonicalModelName({ provider, modelId });
        if (!canonicalIndex.has(key)) canonicalIndex.set(key, { identity: { provider, modelId }, model });
      }
    }
  }
  return canonicalIndex.get(canonicalModelName({ provider: "anthropic", modelId: name }));
}

/** List prices in USD per million tokens, as the catalog records them; undefined for a model it does not know. */
export function listPricesPerMillion(model: ModelIdentifier): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  // A Bedrock inference profile is billed at its model's prices.
  const known = catalogModel(model)
    ?? (model.provider === "amazon-bedrock" ? catalogModel({ provider: model.provider, modelId: model.modelId.replace(INFERENCE_PROFILE, "") }) : undefined);
  if (known === undefined) return undefined;
  const { input, output, cacheRead, cacheWrite } = known.cost;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Claude models Amazon Bedrock serves through a geography's inference profiles (ids like
 * us.anthropic.claude-sonnet-4-6), as the installed Pi catalog names them. The model proxy serves
 * exactly these, because Pi sends the catalog id as the request model.
 */
export function bedrockClaudeModelIds(geography = "us"): string[] {
  const prefix = `${geography}.anthropic.claude-`;
  return amazonBedrockProvider().getModels().map((entry) => entry.id)
    .filter((id) => id.startsWith(prefix) && !RETIRED_BEDROCK_CLAUDE_MODELS.has(id.slice(geography.length + 1))).sort();
}

/**
 * Claude models the installed Pi catalog still names but Amazon Bedrock has retired, so the proxy must not offer them.
 * Found on the 2026-10-20 staging check: the us. profile answered ResourceNotFoundException (end of life).
 */
export const RETIRED_BEDROCK_CLAUDE_MODELS: ReadonlySet<string> = new Set(["anthropic.claude-sonnet-4-20250514-v1:0"]);

/** The Bedrock inference-profile geographies the model proxy can serve (ruling R52). */
export type ProxyGeography = "us" | "eu" | "apac";

/**
 * The geography whose inference profiles an install in this region calls: us-* is "us", eu-* is "eu", ap-* is "apac" (ruling R52).
 * Any other region has no profile the proxy knows, so it is refused here, naming the region.
 */
export function proxyGeographyForRegion(region: string): ProxyGeography {
  if (region.startsWith("us-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  throw new Error(`the model proxy has no Amazon Bedrock inference profile for region ${region}; install in a us-*, eu-* or ap-* region`);
}

/** The geography a Bedrock model id names (us.anthropic.claude-...), or undefined for an id with none the proxy serves. */
export function proxyGeographyOfModelId(modelId: string): ProxyGeography | undefined {
  const prefix = /^(us|eu|apac)\./.exec(modelId)?.[1];
  return prefix === "us" || prefix === "eu" || prefix === "apac" ? prefix : undefined;
}
