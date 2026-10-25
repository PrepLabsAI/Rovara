// Writes packages/contracts/src/e2e-agent-models.generated.ts: the models the AI browser-test agent's route may be pinned to (M1.4 Task 4.10, D-1), from the pinned pi catalog.
//
//   npx tsx scripts/generate-e2e-agent-models.ts
//
// The broker never loads pi-ai, so eligibility is computed here, at build time. A unit test (tests/unit/e2e-agent-models.test.ts) regenerates the table in memory and requires it
// to equal the committed file, so a pi upgrade that changes eligibility fails CI until this has been run again.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { bedrockProfileGeography, type EligibleE2EAgentModel } from "../packages/contracts/src/e2e-agent-models.js";
import type { ModelProvider } from "../packages/contracts/src/model-providers.js";

/** The fields of a pi catalog entry that eligibility reads. */
export interface CatalogEntry {
  id: string;
  name: string;
  api: string;
  type: string;
  input: readonly string[];
  cost: { input: number; output: number };
  contextWindow: number;
  maxTokens?: number | undefined;
  thinkingLevelMap?: Record<string, unknown> | undefined;
  compat?: { requiresReasoningContentOnAssistantMessages?: boolean | undefined } | undefined;
}

/** The pi `api` the e2e invoke can reach each provider's models through. OpenRouter is always called through its OpenAI-compatible endpoint (`TRANSPORTS`), and lists some Claude models as `anthropic-messages`. */
const APIS: Readonly<Record<ModelProvider, readonly string[]>> = {
  "amazon-bedrock": ["bedrock-converse-stream"],
  anthropic: ["anthropic-messages"],
  openai: ["openai-responses"],
  openrouter: ["openai-completions", "anthropic-messages"],
};

/** The route's per-call input bound (32,000) plus its output cap (1,024). */
export const MIN_CONTEXT_WINDOW = 33_024;
export const MIN_MAX_TOKENS = 1_024;

const hasLowEffort = (entry: CatalogEntry): boolean => entry.thinkingLevelMap !== undefined && Object.hasOwn(entry.thinkingLevelMap, "low") && entry.thinkingLevelMap["low"] !== null;

/** The Claude effort the route sends beside disabled thinking, read from the entry's metadata; only where the payload carries one (Anthropic, OpenRouter's Claude models, Bedrock Claude). */
function effortOf(provider: ModelProvider, entry: CatalogEntry): "low" | null {
  switch (provider) {
    case "openai": return null;
    case "anthropic": return hasLowEffort(entry) ? "low" : null;
    case "openrouter": return entry.id.startsWith("anthropic/") && hasLowEffort(entry) ? "low" : null;
    case "amazon-bedrock": return /(?:^|\.)anthropic\.claude/.test(entry.id) && entry.thinkingLevelMap !== undefined ? "low" : null;
  }
}

/** The table row for a catalog entry on `provider`, or null when the entry is not eligible (D-1, rules 1 to 6). Tool calling is not a rule: the driving test proves it. */
export function eligibilityRow(provider: ModelProvider, entry: CatalogEntry): EligibleE2EAgentModel | null {
  if (entry.type !== "chat" || !entry.input.includes("text")) return null;
  if (!APIS[provider].includes(entry.api)) return null;
  if (!(entry.contextWindow >= MIN_CONTEXT_WINDOW)) return null;
  if (entry.maxTokens !== undefined && !(entry.maxTokens >= MIN_MAX_TOKENS)) return null;
  if (entry.compat?.requiresReasoningContentOnAssistantMessages === true) return null;
  if (entry.id.startsWith("~") || entry.id.startsWith("openrouter/") || entry.id.endsWith(":batch")) return null;
  if (!Number.isFinite(entry.cost.input) || !Number.isFinite(entry.cost.output)) return null;
  let scope: EligibleE2EAgentModel["scope"] = null;
  if (provider === "amazon-bedrock") {
    const geography = bedrockProfileGeography(entry.id);
    if (geography === undefined) return null;
    scope = geography === "global" ? "global" : "geographic";
  }
  return {
    provider, modelId: entry.id, label: entry.name, inputUsdPerMTok: entry.cost.input, outputUsdPerMTok: entry.cost.output,
    contextWindow: entry.contextWindow, maxTokens: entry.maxTokens ?? null, effort: effortOf(provider, entry), scope,
  };
}

/** Every eligible row of the installed pi catalog, sorted by provider then model id. */
export function catalogEligibilityRows(): EligibleE2EAgentModel[] {
  const catalogs: Array<[ModelProvider, readonly CatalogEntry[]]> = [
    ["amazon-bedrock", amazonBedrockProvider().getModels() as unknown as CatalogEntry[]],
    ["anthropic", anthropicProvider().getModels() as unknown as CatalogEntry[]],
    ["openai", openaiProvider().getModels() as unknown as CatalogEntry[]],
    ["openrouter", openrouterProvider().getModels() as unknown as CatalogEntry[]],
  ];
  const rows = catalogs.flatMap(([provider, entries]) => entries.flatMap((entry) => { const row = eligibilityRow(provider, entry); return row === null ? [] : [row]; }));
  const key = (row: EligibleE2EAgentModel) => `${row.provider}\u0000${row.modelId}`;
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function renderEligibleModelsSource(rows: readonly EligibleE2EAgentModel[]): string {
  return [
    "// Generated by scripts/generate-e2e-agent-models.ts from the pinned pi catalog. Do not edit: run `npx tsx scripts/generate-e2e-agent-models.ts`.",
    "// A unit test regenerates this table and requires it to equal this file.",
    "import type { EligibleE2EAgentModel } from \"./e2e-agent-models.js\";",
    "export const E2E_AGENT_ELIGIBLE_MODELS: readonly EligibleE2EAgentModel[] = [",
    ...rows.map((row) => `  ${JSON.stringify(row)},`),
    "];",
    "",
  ].join("\n");
}

export const GENERATED_FILE = new URL("../packages/contracts/src/e2e-agent-models.generated.ts", import.meta.url);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = catalogEligibilityRows();
  writeFileSync(GENERATED_FILE, renderEligibleModelsSource(rows));
  console.log(`wrote ${rows.length} eligible models to packages/contracts/src/e2e-agent-models.generated.ts`);
}
