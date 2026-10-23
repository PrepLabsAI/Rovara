import { E2E_AGENT_ELIGIBLE_MODELS } from "./e2e-agent-models.generated.js";
import type { ModelProvider } from "./model-providers.js";

/**
 * The models the AI browser-test agent's route may be pinned to (M1.4 Task 4.10), and the one Rovara recommends on each provider.
 *
 * Eligibility is computed at build time from the pinned pi catalog into `e2e-agent-models.generated.ts` (`scripts/generate-e2e-agent-models.ts`), because the broker never
 * loads pi-ai: it imports contracts only. A unit test regenerates the table in memory and requires byte equality, so a pi upgrade that changes eligibility fails CI until the
 * table is regenerated. Tool calling is not in the catalog; the on-account driving test (Task 4.10C) is the proof of it, and the gate.
 */
export interface EligibleE2EAgentModel {
  provider: ModelProvider;
  modelId: string;
  label: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  contextWindow: number;
  maxTokens: number | null;
  /** The Claude effort level the route sends beside disabled thinking; null where the model's metadata gives none (the route then sends none). */
  effort: "low" | null;
  /** A Bedrock system inference profile's routing scope: `geographic` (`us.`, `eu.`, ...) or `global`; null for every other provider. */
  scope: "geographic" | "global" | null;
}

export { E2E_AGENT_ELIGIBLE_MODELS };

/**
 * The Rovara-tested model on each provider: what an installation uses unless an administrator chooses another. Its values are the ones every route has pinned since Task 4.1, so
 * the digests of default installations do not move. Bedrock's is the US-only profile (owner decision Q6: US-only is the default, Global an explicit choice).
 */
export const E2E_AGENT_RECOMMENDED_MODELS = {
  "amazon-bedrock": "us.anthropic.claude-haiku-5-5",
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5.4-mini",
  openrouter: "anthropic/claude-haiku-5.5",
} as const satisfies Record<ModelProvider, string>;

/**
 * The Bedrock "tokens per minute" quota codes that are known by model, keyed by the foundation model's id (the profile id without its geography prefix): the cross-region
 * (geographic) quota and the global one. A model that is not listed is matched by quota name when a quota is looked up.
 */
export const E2E_AGENT_BEDROCK_QUOTA_CODES: Readonly<Record<string, { geographic: string | null; global: string | null }>> = {
  "anthropic.claude-haiku-5-5": { geographic: "L-47520EB7", global: "L-F26CA8D1" },
};

/**
 * A Bedrock system inference profile's id starts with its geography; the profile can be called from the regions of that geography only, except `global.`, which can be called from
 * any region. The route pins the profile id, so the geography is the model's routing scope.
 */
export const E2E_BEDROCK_PROFILE_GEOGRAPHIES: Readonly<Record<string, RegExp | null>> = {
  us: /^us-(?:east|west)-\d+$/,
  "us-gov": /^us-gov-[a-z]+-\d+$/,
  eu: /^eu-[a-z]+-\d+$/,
  apac: /^ap-[a-z]+(?:-[a-z]+)?-\d+$/,
  jp: /^ap-northeast-(?:1|3)$/,
  au: /^ap-southeast-(?:2|4)$/,
  in: /^ap-south-\d+$/,
  ca: /^ca-[a-z]+-\d+$/,
  global: null,
};

const PROFILE_PREFIX = /^([a-z]+(?:-[a-z]+)?)\./;

/** The geography prefix of a Bedrock profile id (`us`, `global`, ...), or undefined for a bare foundation id or anything else. */
export function bedrockProfileGeography(modelId: string): string | undefined {
  const prefix = PROFILE_PREFIX.exec(modelId)?.[1];
  return prefix !== undefined && Object.hasOwn(E2E_BEDROCK_PROFILE_GEOGRAPHIES, prefix) ? prefix : undefined;
}

function regionAllows(row: EligibleE2EAgentModel, region: string | null): boolean {
  if (row.provider !== "amazon-bedrock") return true;
  const geography = bedrockProfileGeography(row.modelId);
  if (geography === undefined) return false;
  const allowed = E2E_BEDROCK_PROFILE_GEOGRAPHIES[geography];
  if (allowed === null || allowed === undefined) return true;
  return region !== null && allowed.test(region);
}

/** Every model eligible on `provider` in `region` (the Bedrock region; ignored for keyed providers), in table order. */
export function e2eAgentModelsFor(provider: ModelProvider, region: string | null): readonly EligibleE2EAgentModel[] {
  return E2E_AGENT_ELIGIBLE_MODELS.filter((row) => row.provider === provider && regionAllows(row, region));
}

/** The table's row for this provider, model id and region, or null when the model is not one the route may use there. */
export function eligibleE2EAgentModel(provider: ModelProvider, modelId: string | undefined, region: string | null): EligibleE2EAgentModel | null {
  if (modelId === undefined || modelId === "") return null;
  const row = E2E_AGENT_ELIGIBLE_MODELS.find((candidate) => candidate.provider === provider && candidate.modelId === modelId);
  return row !== undefined && regionAllows(row, region) ? row : null;
}

const SCOPE_SENTENCES = {
  geographic: "Your app's pages are processed by the AI in US data centers.",
  global: "Slightly cheaper and less likely to hit limits; your app's pages may be processed by the AI outside the US.",
} as const;

/** The owner-approved sentence for a Bedrock model id's routing scope: `us.` and `global.` have one; every other id (a keyed provider's, another geography) has none. */
export function e2eAgentScopeSentence(modelId: string): string | null {
  if (modelId.startsWith("us.")) return SCOPE_SENTENCES.geographic;
  if (modelId.startsWith("global.")) return SCOPE_SENTENCES.global;
  return null;
}
