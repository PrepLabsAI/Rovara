// Private release tariff, populated ONLY from a passed, reviewed live qualification.
import { createHash } from "node:crypto";
import { record, whole } from "./model-gateway-token.js";
export const OPENROUTER_PRICE_KEYS = ["prompt", "completion", "internal_reasoning", "request", "input_cache_read", "input_cache_write"] as const;
export const OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION = "openrouter-no-cache-write-v1";
export type OpenRouterPrices = Record<typeof OPENROUTER_PRICE_KEYS[number], string>;
export interface OpenRouterTariff {
 model: string; route: string; pricing: OpenRouterPrices;
 max_completion_tokens: number;
 reasoning: { mode: "disabled" } | { mode: "bounded"; max_tokens: number };
 verifiedAt: number; expiresAt: number; evidence: string;
 cacheWriteBasis?: "never_requested_enforced"; cacheWriteEnforcementVersion?: string;
}
export interface OpenRouterPolicy extends OpenRouterTariff { hash: string }
/** Reviewed release tariff: the 64 installable rows of the OpenRouter v3 owner run 2 (2026-11-24), installed as-is (one row per model, sorted by model).
 * Each row expires within 24 h of verifiedAt (the first, openai/gpt-oss-20b, at 2026-11-25 01:57Z); an expired row is refused and the model is switched off.
 */
export const REVIEWED_OPENROUTER_POLICIES: readonly OpenRouterTariff[] = Object.freeze([
 {
  "model": "aion-labs/aion-2.0",
  "route": "aion-labs",
  "pricing": {
   "prompt": "0.0000008",
   "completion": "0.0000016",
   "internal_reasoning": "0.0000016",
   "request": "0",
   "input_cache_read": "0.0000002",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795502000015,
  "expiresAt": 1795588400015,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "aion-labs/aion-3.0-mini",
  "route": "aion-labs",
  "pricing": {
   "prompt": "0.0000007",
   "completion": "0.0000014",
   "internal_reasoning": "0.0000014",
   "request": "0",
   "input_cache_read": "0.00000018",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795500179048,
  "expiresAt": 1795586579048,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "anthropic/claude-haiku-5.5",
  "route": "amazon-bedrock",
  "pricing": {
   "prompt": "0.0000005",
   "completion": "0.0000025",
   "internal_reasoning": "0.0000025",
   "request": "0",
   "input_cache_read": "0.00000005",
   "input_cache_write": "0.000000625"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795506237674,
  "expiresAt": 1795592637674,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "deepseek/deepseek-chat-v3.1",
  "route": "deepinfra/fp4",
  "pricing": {
   "prompt": "0.00000025",
   "completion": "0.00000095",
   "internal_reasoning": "0.00000095",
   "request": "0",
   "input_cache_read": "0.00000013",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795498149690,
  "expiresAt": 1795584549690,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "deepseek/deepseek-v4-flash",
  "route": "relace/fp4",
  "pricing": {
   "prompt": "0.00000005",
   "completion": "0.00000045",
   "internal_reasoning": "0.00000045",
   "request": "0",
   "input_cache_read": "0.00000005",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795488875418,
  "expiresAt": 1795575275418,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "deepseek/deepseek-v4-pro",
  "route": "siliconflow/fp8",
  "pricing": {
   "prompt": "0.0000009",
   "completion": "0.0000017",
   "internal_reasoning": "0.0000017",
   "request": "0",
   "input_cache_read": "0.00000008",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795501149780,
  "expiresAt": 1795587549780,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "elorian/glimpse",
  "route": "together",
  "pricing": {
   "prompt": "0.0000006",
   "completion": "0.000003",
   "internal_reasoning": "0.000003",
   "request": "0",
   "input_cache_read": "0.00000006",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795506914973,
  "expiresAt": 1795593314973,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "google/gemini-3-flash-preview",
  "route": "google-ai-studio/priority",
  "pricing": {
   "prompt": "0.0000009",
   "completion": "0.0000054",
   "internal_reasoning": "0.0000054",
   "request": "0",
   "input_cache_read": "0.00000009",
   "input_cache_write": "0.00000015"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795501048127,
  "expiresAt": 1795587448127,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemini-3.1-flash-lite",
  "route": "google-ai-studio/priority",
  "pricing": {
   "prompt": "0.00000045",
   "completion": "0.0000027",
   "internal_reasoning": "0.0000027",
   "request": "0",
   "input_cache_read": "0.000000045",
   "input_cache_write": "0.00000015"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795496918842,
  "expiresAt": 1795583318842,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemini-3.1-flash-lite-preview",
  "route": "google-ai-studio/priority",
  "pricing": {
   "prompt": "0.00000045",
   "completion": "0.0000027",
   "internal_reasoning": "0.0000027",
   "request": "0",
   "input_cache_read": "0.000000045",
   "input_cache_write": "0.00000015"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795496962116,
  "expiresAt": 1795583362116,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemini-3.5-flash",
  "route": "google-ai-studio/priority",
  "pricing": {
   "prompt": "0.0000027",
   "completion": "0.0000162",
   "internal_reasoning": "0.0000162",
   "request": "0",
   "input_cache_read": "0.00000027",
   "input_cache_write": "0.00000015"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795508724688,
  "expiresAt": 1795595124688,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemini-3.5-flash-lite",
  "route": "google-vertex/global/priority",
  "pricing": {
   "prompt": "0.00000054",
   "completion": "0.0000045",
   "internal_reasoning": "0.0000045",
   "request": "0",
   "input_cache_read": "0.000000054",
   "input_cache_write": "0.00000015"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795499253932,
  "expiresAt": 1795585653932,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemini-3.6-flash",
  "route": "google-ai-studio/priority",
  "pricing": {
   "prompt": "0.00000135",
   "completion": "0.00000675",
   "internal_reasoning": "0.00000675",
   "request": "0",
   "input_cache_read": "0.000000135",
   "input_cache_write": "0.000000075"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795503391969,
  "expiresAt": 1795589791969,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemini-4-hydrogen",
  "route": "google-ai-studio/priority",
  "pricing": {
   "prompt": "0.0000027",
   "completion": "0.0000135",
   "internal_reasoning": "0.0000135",
   "request": "0",
   "input_cache_read": "0.000000135",
   "input_cache_write": "0.00000015"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795507460951,
  "expiresAt": 1795593860951,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "google/gemma-4-31b-it",
  "route": "coreweave/fp4",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.00000034",
   "internal_reasoning": "0.00000034",
   "request": "0",
   "input_cache_read": "0.0000001",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795492457075,
  "expiresAt": 1795578857075,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "ibm-granite/granite-4.2-8b",
  "route": "coreweave/bf16",
  "pricing": {
   "prompt": "0.00000006",
   "completion": "0.00000015",
   "internal_reasoning": "0.00000015",
   "request": "0",
   "input_cache_read": "0.000000015",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795489713904,
  "expiresAt": 1795576113904,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "kt/midm-k-3.0-pro",
  "route": "kt",
  "pricing": {
   "prompt": "0.0000002",
   "completion": "0.0000008",
   "internal_reasoning": "0.0000008",
   "request": "0",
   "input_cache_read": "0.00000004",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795497281635,
  "expiresAt": 1795583681635,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "liquid/lfm-2.5-24b-a2b",
  "route": "liquid",
  "pricing": {
   "prompt": "0.00000005",
   "completion": "0.0000007",
   "internal_reasoning": "0.0000007",
   "request": "0",
   "input_cache_read": "0.000000025",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795496459686,
  "expiresAt": 1795582859686,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "meta/muse-ember",
  "route": "google-vertex/global",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.0000005",
   "internal_reasoning": "0.0000005",
   "request": "0",
   "input_cache_read": "0.000000004",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795495980614,
  "expiresAt": 1795582380614,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "meta/muse-glimmer-30b",
  "route": "deepinfra/bf16",
  "pricing": {
   "prompt": "0.0000003",
   "completion": "0.0000012",
   "internal_reasoning": "0.0000012",
   "request": "0",
   "input_cache_read": "0.00000004",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795498956124,
  "expiresAt": 1795585356124,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "minimax/minimax-m2.5",
  "route": "digitalocean",
  "pricing": {
   "prompt": "0.0000003",
   "completion": "0.0000012",
   "internal_reasoning": "0.0000012",
   "request": "0",
   "input_cache_read": "0.00000006",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795498377067,
  "expiresAt": 1795584777067,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "minimax/minimax-m3",
  "route": "coreweave/fp4",
  "pricing": {
   "prompt": "0.00000023",
   "completion": "0.00000096",
   "internal_reasoning": "0.00000096",
   "request": "0",
   "input_cache_read": "0.00000005",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795497717168,
  "expiresAt": 1795584117168,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "minimax/minimax-m3.1-flash",
  "route": "makora/fp4",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.0000004",
   "internal_reasoning": "0.0000004",
   "request": "0",
   "input_cache_read": "0.000000025",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795494052515,
  "expiresAt": 1795580452515,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "mistralai/mistral-large-4-0",
  "route": "mistral/zdr",
  "pricing": {
   "prompt": "0.0000007",
   "completion": "0.0000021",
   "internal_reasoning": "0.0000021",
   "request": "0",
   "input_cache_read": "0.00000007",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795504782923,
  "expiresAt": 1795591182923,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "motif-technologies/motif-3",
  "route": "kt",
  "pricing": {
   "prompt": "0.0000003",
   "completion": "0.0000012",
   "internal_reasoning": "0.0000012",
   "request": "0",
   "input_cache_read": "0.00000006",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795499085744,
  "expiresAt": 1795585485744,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "nex-agi/nex-n2.5-pro",
  "route": "nex-agi/fp8",
  "pricing": {
   "prompt": "0.000000075",
   "completion": "0.00000025",
   "internal_reasoning": "0.00000025",
   "request": "0",
   "input_cache_read": "0.000000015",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795491560736,
  "expiresAt": 1795577960736,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "nvidia/nemotron-3-ultra-550b-a55b",
  "route": "deepinfra/fp4/flex",
  "pricing": {
   "prompt": "0.0000004",
   "completion": "0.00000176",
   "internal_reasoning": "0.00000176",
   "request": "0",
   "input_cache_read": "0.00000008",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795502303975,
  "expiresAt": 1795588703975,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "nvidia/nemotron-3.5-lightning",
  "route": "darkbloom/int4",
  "pricing": {
   "prompt": "0.00000002",
   "completion": "0.000000096",
   "internal_reasoning": "0.000000096",
   "request": "0",
   "input_cache_read": "0.00000001",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795487850342,
  "expiresAt": 1795574250342,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "nvidia/nemotron-3.5-super-vl",
  "route": "darkbloom/nvfp4",
  "pricing": {
   "prompt": "0.00000006",
   "completion": "0.00000035",
   "internal_reasoning": "0.00000035",
   "request": "0",
   "input_cache_read": "0.00000001",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795493179476,
  "expiresAt": 1795579579476,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "openai/gpt-5-mini",
  "route": "openai/flex",
  "pricing": {
   "prompt": "0.000000125",
   "completion": "0.000001",
   "internal_reasoning": "0.000001",
   "request": "0",
   "input_cache_read": "0.0000000125",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795498512842,
  "expiresAt": 1795584912842,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "openai/gpt-5.1-codex-mini",
  "route": "azure",
  "pricing": {
   "prompt": "0.00000025",
   "completion": "0.000002",
   "internal_reasoning": "0.000002",
   "request": "0",
   "input_cache_read": "0.00000003",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795503768453,
  "expiresAt": 1795590168453,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "openai/gpt-5.4-mini",
  "route": "openai/flex",
  "pricing": {
   "prompt": "0.000000375",
   "completion": "0.00000225",
   "internal_reasoning": "0.00000225",
   "request": "0",
   "input_cache_read": "0.0000000375",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795505393110,
  "expiresAt": 1795591793110,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "openai/gpt-5.4-nano",
  "route": "openai/flex",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.000000625",
   "internal_reasoning": "0.000000625",
   "request": "0",
   "input_cache_read": "0.00000001",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795496317784,
  "expiresAt": 1795582717784,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "openai/gpt-5.6-luna",
  "route": "openai/flex",
  "pricing": {
   "prompt": "0.0000002",
   "completion": "0.0000009",
   "internal_reasoning": "0.0000009",
   "request": "0",
   "input_cache_read": "0.00000002",
   "input_cache_write": "0.00000025"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795497887216,
  "expiresAt": 1795584287216,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "openai/gpt-6-luna",
  "route": "openai/flex",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.000000375",
   "internal_reasoning": "0.000000375",
   "request": "0",
   "input_cache_read": "0.00000001",
   "input_cache_write": "0.000000125"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795493622723,
  "expiresAt": 1795580022723,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "openai/gpt-oss-20b",
  "route": "akashml/fp4",
  "pricing": {
   "prompt": "0.000000018",
   "completion": "0.00000009",
   "internal_reasoning": "0.00000009",
   "request": "0",
   "input_cache_read": "0.000000009",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795485448153,
  "expiresAt": 1795571848153,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "particle-ai/particle-1",
  "route": "particle-ai/us/flex",
  "pricing": {
   "prompt": "0.000000035",
   "completion": "0.00000025",
   "internal_reasoning": "0.00000025",
   "request": "0",
   "input_cache_read": "0.000000015",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795491611782,
  "expiresAt": 1795578011782,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "prism-ml/ternary-bonsai-2-27b",
  "route": "darkbloom/int4",
  "pricing": {
   "prompt": "0.000000075",
   "completion": "0.0000005",
   "internal_reasoning": "0.0000005",
   "request": "0",
   "input_cache_read": "0.0000000375",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795496076919,
  "expiresAt": 1795582476919,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "qwen/qwen3.6-27b",
  "route": "reka",
  "pricing": {
   "prompt": "0.0000006",
   "completion": "0.000006",
   "internal_reasoning": "0.000006",
   "request": "0",
   "input_cache_read": "0.0000005",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795504258671,
  "expiresAt": 1795590658671,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "qwen/qwen3.7-flash",
  "route": "alibaba",
  "pricing": {
   "prompt": "0.0000002",
   "completion": "0.0000008",
   "internal_reasoning": "0.0000008",
   "request": "0",
   "input_cache_read": "0.00000004",
   "input_cache_write": "0.00000025"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795497318773,
  "expiresAt": 1795583718773,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "qwen/qwen3.7-max",
  "route": "alibaba",
  "pricing": {
   "prompt": "0.000001475",
   "completion": "0.000004425",
   "internal_reasoning": "0.000004425",
   "request": "0",
   "input_cache_read": "0.000000295",
   "input_cache_write": "0.00000184375"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795508618739,
  "expiresAt": 1795595018739,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "qwen/qwen3.7-plus",
  "route": "alibaba",
  "pricing": {
   "prompt": "0.00000096",
   "completion": "0.00000384",
   "internal_reasoning": "0.00000384",
   "request": "0",
   "input_cache_read": "0.000000192",
   "input_cache_write": "0.0000012"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795507815542,
  "expiresAt": 1795594215542,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model"
 },
 {
  "model": "qwen/qwen3.8-27b",
  "route": "chutes/fp8",
  "pricing": {
   "prompt": "0.000000039",
   "completion": "0.00000125",
   "internal_reasoning": "0.00000125",
   "request": "0",
   "input_cache_read": "0.0000000039",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795499387884,
  "expiresAt": 1795585787884,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "qwen/qwen3.8-flash",
  "route": "alibaba/us-east-1",
  "pricing": {
   "prompt": "0.00000015",
   "completion": "0.00000047",
   "internal_reasoning": "0.00000047",
   "request": "0",
   "input_cache_read": "0.000000016",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795494626437,
  "expiresAt": 1795581026437,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "qwen/qwen3.8-omni-flash",
  "route": "alibaba",
  "pricing": {
   "prompt": "0.00000015",
   "completion": "0.00000047",
   "internal_reasoning": "0.00000047",
   "request": "0",
   "input_cache_read": "0.000000016",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795494774253,
  "expiresAt": 1795581174253,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "reflection/beam-1.0-501b-a23b",
  "route": "nebius/fp4",
  "pricing": {
   "prompt": "0.00000025",
   "completion": "0.000001",
   "internal_reasoning": "0.000001",
   "request": "0",
   "input_cache_read": "0.00000005",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795498688648,
  "expiresAt": 1795585088648,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "ricursiveai/ripple-65b-preview",
  "route": "primeintellect/bf16",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.0000003",
   "internal_reasoning": "0.0000003",
   "request": "0",
   "input_cache_read": "0.000000025",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795492371502,
  "expiresAt": 1795578771502,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "tencent/hy3",
  "route": "tencent/fp8",
  "pricing": {
   "prompt": "0.000000132",
   "completion": "0.000000528",
   "internal_reasoning": "0.000000528",
   "request": "0",
   "input_cache_read": "0.000000033",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795496142286,
  "expiresAt": 1795582542286,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "tencent/hy4",
  "route": "together",
  "pricing": {
   "prompt": "0.000000834",
   "completion": "0.000002501",
   "internal_reasoning": "0.000002501",
   "request": "0",
   "input_cache_read": "0.000000042",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795506373662,
  "expiresAt": 1795592773662,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "tencent/hy4-flash",
  "route": "primalabs/fp8",
  "pricing": {
   "prompt": "0.00000007",
   "completion": "0.000000281",
   "internal_reasoning": "0.000000281",
   "request": "0",
   "input_cache_read": "0.000000003",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795492325373,
  "expiresAt": 1795578725373,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "tencent/hy4-preview",
  "route": "deepinfra/fp4",
  "pricing": {
   "prompt": "0.000000834",
   "completion": "0.000002501",
   "internal_reasoning": "0.000002501",
   "request": "0",
   "input_cache_read": "0.000000042",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795506427310,
  "expiresAt": 1795592827310,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "thinkingmachines/inkling",
  "route": "together",
  "pricing": {
   "prompt": "0.000001",
   "completion": "0.00000405",
   "internal_reasoning": "0.00000405",
   "request": "0",
   "input_cache_read": "0.00000017",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795508157122,
  "expiresAt": 1795594557122,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "thinkingmachines/inkling-2-mini",
  "route": "primeintellect/fp4",
  "pricing": {
   "prompt": "0.000000075",
   "completion": "0.0000003",
   "internal_reasoning": "0.0000003",
   "request": "0",
   "input_cache_read": "0.000000015",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795490398740,
  "expiresAt": 1795576798740,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "thinkingmachines/inkling-2-small",
  "route": "primeintellect/flex",
  "pricing": {
   "prompt": "0.000000075",
   "completion": "0.00000025",
   "internal_reasoning": "0.00000025",
   "request": "0",
   "input_cache_read": "0.000000015",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795491689104,
  "expiresAt": 1795578089104,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "thinkingmachines/inkling-small",
  "route": "deepinfra/fp4",
  "pricing": {
   "prompt": "0.00000045",
   "completion": "0.0000012",
   "internal_reasoning": "0.0000012",
   "request": "0",
   "input_cache_read": "0.0000001",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795499122561,
  "expiresAt": 1795585522561,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "xiaomi/mimo-v2.5",
  "route": "venice/fp8",
  "pricing": {
   "prompt": "0.0000004",
   "completion": "0.000002",
   "internal_reasoning": "0.000002",
   "request": "0",
   "input_cache_read": "0.00000008",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795504315601,
  "expiresAt": 1795590715601,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "xiaomi/mimo-v2.6-flash",
  "route": "darkbloom/fp4",
  "pricing": {
   "prompt": "0.0000001",
   "completion": "0.00000028",
   "internal_reasoning": "0.00000028",
   "request": "0",
   "input_cache_read": "0.0000000028",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795491969131,
  "expiresAt": 1795578369131,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "xiaomi/mimo-v2.6-pro",
  "route": "streamlake",
  "pricing": {
   "prompt": "0.000000435",
   "completion": "0.00000087",
   "internal_reasoning": "0.00000087",
   "request": "0",
   "input_cache_read": "0.0000000036",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795497557443,
  "expiresAt": 1795583957443,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "z-ai/glm-4.5",
  "route": "z-ai/fp8",
  "pricing": {
   "prompt": "0.0000006",
   "completion": "0.0000022",
   "internal_reasoning": "0.0000022",
   "request": "0",
   "input_cache_read": "0.00000011",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795504994088,
  "expiresAt": 1795591394088,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "z-ai/glm-4.5v",
  "route": "novita/fp8",
  "pricing": {
   "prompt": "0.0000006",
   "completion": "0.0000018",
   "internal_reasoning": "0.0000018",
   "request": "0",
   "input_cache_read": "0.00000011",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795503234724,
  "expiresAt": 1795589634724,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "z-ai/glm-4.6",
  "route": "z-ai/fp4",
  "pricing": {
   "prompt": "0.0000006",
   "completion": "0.0000022",
   "internal_reasoning": "0.0000022",
   "request": "0",
   "input_cache_read": "0.00000011",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795502258426,
  "expiresAt": 1795588658426,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "z-ai/glm-4.7",
  "route": "novita/fp8",
  "pricing": {
   "prompt": "0.0000006",
   "completion": "0.0000022",
   "internal_reasoning": "0.0000022",
   "request": "0",
   "input_cache_read": "0.00000011",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795500463841,
  "expiresAt": 1795586863841,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "z-ai/glm-5",
  "route": "siliconflow/fp8",
  "pricing": {
   "prompt": "0.00000095",
   "completion": "0.00000255",
   "internal_reasoning": "0.00000255",
   "request": "0",
   "input_cache_read": "0.0000002",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795505119593,
  "expiresAt": 1795591519593,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 },
 {
  "model": "z-ai/glm-5.3-flash",
  "route": "open-inference/fp4",
  "pricing": {
   "prompt": "0.00000005",
   "completion": "0.00000045",
   "internal_reasoning": "0.00000045",
   "request": "0",
   "input_cache_read": "0.000000025",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 2048,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795486040298,
  "expiresAt": 1795572440298,
  "evidence": "Opus tariff review TARIFFS PASS 64 (OpenRouter v3 owner paid run 2 2026-11-24); briefs/codex/openrouter-harness-v3/REVIEW-OPUS-TARIFFS-2.md and OPENROUTER-V3-REPORT-2.json; installed as-is, one row per model",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1"
 }
]);
/** Review queue in the private tariff source, never an installed/default price list.
 * Promotion is a reviewed source edit: remove the candidate label and place the approved,
 * still-fresh row in REVIEWED_OPENROUTER_POLICIES. Never import qualification output automatically.
 */
export const CANDIDATE_OPENROUTER_POLICIES: readonly (OpenRouterTariff & { status: "CANDIDATE" })[] = Object.freeze([
 {
  "model": "openai/gpt-5-mini",
  "route": "openai",
  "pricing": {
   "prompt": "0.00000025",
   "completion": "0.000002",
   "internal_reasoning": "0",
   "request": "0",
   "input_cache_read": "0.000000025",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 4096,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795308743993,
  "expiresAt": 1795395143993,
  "evidence": "CANDIDATE ONLY: briefs/codex/providers-fast/M2-LIVE-REPORT-run8.json; owner run 8 on ef670ae9b; reviewed promotion and installed staging proof required",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1",
  "status": "CANDIDATE"
 },
 {
  "model": "openai/gpt-5-nano",
  "route": "openai",
  "pricing": {
   "prompt": "0.00000005",
   "completion": "0.0000004",
   "internal_reasoning": "0",
   "request": "0",
   "input_cache_read": "0.000000005",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 4096,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795308801625,
  "expiresAt": 1795395201625,
  "evidence": "CANDIDATE ONLY: briefs/codex/providers-fast/M2-LIVE-REPORT-run8.json; owner run 8 on ef670ae9b; reviewed promotion and installed staging proof required",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1",
  "status": "CANDIDATE"
 }
]);

/** Reviewed exception scope, NOT installed tariffs or live qualification. Exact IDs only.
 * Evidence/limits: docs/model-gateway-spend-limits.md#openrouter-tariff-exceptions. Never infer
 * absent-price semantics or opt-in-only search for another model/provider.
 */
export const OPENROUTER_RELAXED_TARIFF_MODELS = Object.freeze({
 "openai/gpt-5-mini": "Search requires a refused explicit tool/plugin. Absent write prices require versioned request enforcement and refusal of reported writes.",
 "openai/gpt-5-nano": "Search requires a refused explicit tool/plugin. Absent write prices require versioned request enforcement and refusal of reported writes.",
});
const SCALE = 10n ** 18n;
/** USD at 18 decimal places, no binary floating arithmetic. Refuse excess precision. */
export function openRouterDecimal(value: string): bigint {
 const m = /^(\d{1,24})(?:\.(\d{1,24}))?(?:e([+-]?\d{1,2}))?$/iu.exec(value);
 if (!m) throw new Error("unbounded tariff");
 const digits = BigInt(m[1]! + (m[2] ?? ""));
 const power = 18 + Number(m[3] ?? 0) - (m[2]?.length ?? 0);
 if (Math.abs(power) > 60) throw new Error("unbounded tariff");
 if (power < 0 && digits % (10n ** BigInt(-power)) !== 0n) throw new Error("unbounded tariff");
 return power < 0 ? digits / (10n ** BigInt(-power)) : digits * 10n ** BigInt(power);
}
function decimalText(value: bigint, places: number): string {
 const s = value.toString().padStart(places + 1, "0");
 return places === 0 ? s : `${s.slice(0, -places)}.${s.slice(-places)}`.replace(/\.?0+$/u, "");
}
/** Models pricing is USD/token; provider.max_price is USD/M tokens. */
export function perMillionPrice(value: string): string { return decimalText(openRouterDecimal(value), 12); }
function wireNumber(value: string): number {
 const n = Number(value);
 // JSON's shortest number spelling must describe exactly the intended decimal.
 if (!Number.isFinite(n) || openRouterDecimal(String(n)) !== openRouterDecimal(value)) throw new Error("unrepresentable price cap");
 return n;
}
export function openRouterPolicy(model: string, now: number, rows: readonly OpenRouterTariff[] = REVIEWED_OPENROUTER_POLICIES): OpenRouterPolicy | undefined {
 const matches = rows.filter(r => r.model === model);
 if (matches.length !== 1) return undefined;
 const r = matches[0]!;
 // Even explicit injection cannot promote a labelled review candidate into active pricing.
 if (record(r)?.status !== undefined) return undefined;
 if (r.model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(r.model) || r.model.startsWith("openrouter/") ||
     !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(r.route) ||
     !whole(now) || !whole(r.verifiedAt) || !whole(r.expiresAt) || r.verifiedAt > now || r.expiresAt <= now || r.expiresAt - r.verifiedAt > 86_400_000 ||
     !whole(r.max_completion_tokens) || r.max_completion_tokens < 1 || r.max_completion_tokens > 1_000_000 || !r.evidence ||
     record(r.reasoning) === undefined || (r.reasoning.mode !== "disabled" && r.reasoning.mode !== "bounded") ||
     (r.reasoning.mode === "bounded" && (!whole(r.reasoning.max_tokens) || r.reasoning.max_tokens < 1024 || r.reasoning.max_tokens >= r.max_completion_tokens))) return undefined;
 // Owner rule (2026-11-23): an ABSENT cache-write price is allowed for ANY reviewed route, as a row with the versioned basis and an explicit "0" write price.
 // The basis is a RUNTIME promise, not a price: the gateway never sends cache hints, and a reported write stops the call and settles safely (server.ts cacheWritesForbidden,
 // openRouterRates' write rate, source-stop.ts). An EXPLICIT zero write price carries no basis and the harness never proves it (it stays refused there).
 const noWrite = r.cacheWriteBasis === "never_requested_enforced" && r.cacheWriteEnforcementVersion === OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION;
 if ((r.cacheWriteBasis !== undefined || r.cacheWriteEnforcementVersion !== undefined) && !noWrite) return undefined;
 const pricing = {} as OpenRouterPrices;
 try {
  const p = record(r.pricing);
  if (p === undefined || Object.keys(p).some(k => !OPENROUTER_PRICE_KEYS.some(key => key === k))) return undefined;
  for (const k of OPENROUTER_PRICE_KEYS) {
   // Only reviewed models may default optional prices; absent write pricing also requires current enforced proof.
   // Explicit undefined/null/malformed values still refuse, including on the allowlist.
   const value = Object.hasOwn(OPENROUTER_RELAXED_TARIFF_MODELS, model) && !Object.hasOwn(p, k) && k !== "prompt" && k !== "completion" && (k !== "input_cache_write" || noWrite) ? "0" : p[k];
   if (typeof value !== "string") return undefined;
   pricing[k] = value;
   const amount = openRouterDecimal(value);
   // Token rates must also fit the existing integer micro-USD/M ceiling contract exactly.
   if (k !== "request" && (amount % 1_000_000n !== 0n || amount / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER))) return undefined;
   wireNumber(k === "request" ? value : perMillionPrice(value));
  }
  if (noWrite && openRouterDecimal(pricing.input_cache_write) !== 0n) return undefined;
  if (openRouterDecimal(pricing.prompt) <= 0n || openRouterDecimal(pricing.completion) <= 0n) return undefined;
 } catch { return undefined; }
 const value: OpenRouterTariff = { ...(noWrite ? { cacheWriteBasis: "never_requested_enforced" as const, cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } : {}), model: r.model, route: r.route, pricing, max_completion_tokens: r.max_completion_tokens, reasoning: { ...r.reasoning }, verifiedAt: r.verifiedAt, expiresAt: r.expiresAt, evidence: r.evidence };
 return { ...value, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}
/** No explicit cache directives may reach OpenRouter, including inside messages/tools.
 * Anthropic cache_control markers are stripped by the translator before this boundary.
 */
function hasCachingHint(value: unknown): boolean {
 if (Array.isArray(value)) return value.some(hasCachingHint);
 const object = record(value);
 return object !== undefined && Object.entries(object).some(([key, v]) =>
  ["cache_control", "caching", "cache", "prompt_cache_key", "prompt_cache_retention", "prompt_caching"].includes(key) || hasCachingHint(v));
}
export function openRouterRequest(body: Record<string, unknown>, policy: OpenRouterPolicy): Record<string, unknown> | undefined {
 const allowed = ["model", "messages", "max_tokens", "stream", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "stream_options", "usage"];
 // Only client function tools are supported: no provider search tools (including future variants).
 if (hasCachingHint(body) || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(t => record(t)?.type !== "function"))) ||
     typeof body.model !== "string" || body.model.includes(":") || body.model !== policy.model || Object.keys(body).some(k => !allowed.includes(k)) || !whole(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > policy.max_completion_tokens ||
     (policy.reasoning.mode === "bounded" && body.max_tokens <= policy.reasoning.max_tokens) ||
     !Array.isArray(body.messages) || body.messages.some(v => { const m = record(v); return m === undefined || !(typeof m.content === "string" || (m.role === "assistant" && m.content === null)); })) return undefined;
 const output = openRouterDecimal(policy.pricing.completion) >= openRouterDecimal(policy.pricing.internal_reasoning) ? policy.pricing.completion : policy.pricing.internal_reasoning;
 return { ...body, usage: { include: true }, reasoning: policy.reasoning.mode === "disabled" ? { enabled: false } : { enabled: true, max_tokens: policy.reasoning.max_tokens },
  provider: { order: [policy.route], only: [policy.route], allow_fallbacks: false, require_parameters: true,
   max_price: { prompt: wireNumber(perMillionPrice(policy.pricing.prompt)), completion: wireNumber(perMillionPrice(output)), request: wireNumber(policy.pricing.request) } } };
}
/** Every prompt token may be a priced cache write; cache reads never make the hold smaller.
 * An absent write fee is zero only with versioned no-write enforcement; unexpected
 * reported writes retain the hold/debit provisionally and stop the source.
 * OpenRouter bills reasoning as output: the full combined output limit uses the dearer
 * completion/reasoning rate even when the separate reasoning field is absent (zero).
 * No extra reasoning budget is added outside maxTokens; live qualification proves that limit.
 */
export function openRouterHold(policy: OpenRouterPolicy, maxPromptTokens: number, maxTokens: number): number {
 if (!whole(maxPromptTokens) || !whole(maxTokens) || maxTokens < 1 || maxTokens > policy.max_completion_tokens) throw new Error("request not allowed");
 const p = policy.pricing; const max = (a: string, b: string) => openRouterDecimal(a) > openRouterDecimal(b) ? openRouterDecimal(a) : openRouterDecimal(b);
 const usd = BigInt(maxPromptTokens) * (max(p.prompt, p.input_cache_read) + openRouterDecimal(p.input_cache_write)) + BigInt(maxTokens) * max(p.completion, p.internal_reasoning) + openRouterDecimal(p.request);
 const micros = (usd * 1_000_000n + SCALE - 1n) / SCALE;
 if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("request not allowed");
 return Number(micros);
}
/** DEC 254zzz419: when more than the offered-list cap of models could be installed or offered, the best-known families come first, in this order
 * (by OpenRouter id prefix); every other model ranks after them.
 */
export const OPENROUTER_FAMILY_PREFIXES = Object.freeze(["openai/", "anthropic/", "google/", "mistralai/", "meta-llama/", "deepseek/", "qwen/"] as const);
/** The reference prompt size of the install tie-break and the cross-model cap order (the harness exports the same number and a test pins it). */
export const OPENROUTER_REFERENCE_PROMPT_TOKENS = 100_000;
export function openRouterFamilyRank(model: string): number {
 const index = OPENROUTER_FAMILY_PREFIXES.findIndex(prefix => model.startsWith(prefix));
 return index === -1 ? OPENROUTER_FAMILY_PREFIXES.length : index;
}
/** The one cap order, shared by the harness' install selection and the offered list (so the report, the tariff and the list stay identical). Pure and deterministic.
 * Ascending by: (1) family rank, (2) the gateway hold at OPENROUTER_REFERENCE_PROMPT_TOKENS and ONE common output size (the smallest ceiling among the given
 * policies; price, not ceiling), (3) the dearer of completion / internal_reasoning price, (4) prompt price, (5) lower max_completion_tokens, (6) route and
 * (7) model by code-point order. `max` is the cap; the rest are `dropped`, also in order. At or under `max` the order is NOT changed (nothing is dropped).
 */
export function openRouterCapOrder<T extends OpenRouterPolicy>(policies: readonly T[], max: number): { kept: T[]; dropped: T[] } {
 if (policies.length <= max) return { kept: [...policies], dropped: [] };
 const size = Math.min(...policies.map(p => p.max_completion_tokens));
 const dearer = (p: OpenRouterPolicy) => { const a = openRouterDecimal(p.pricing.completion); const b = openRouterDecimal(p.pricing.internal_reasoning); return a > b ? a : b; };
 const keyed = policies.map(policy => ({ policy, key: [openRouterFamilyRank(policy.model), BigInt(openRouterHold(policy, OPENROUTER_REFERENCE_PROMPT_TOKENS, size)), dearer(policy), openRouterDecimal(policy.pricing.prompt), BigInt(policy.max_completion_tokens), policy.route, policy.model] as const }));
 keyed.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i]! !== b.key[i]!) return a.key[i]! < b.key[i]! ? -1 : 1; return 0; });
 const ordered = keyed.map(k => k.policy);
 return { kept: ordered.slice(0, max), dropped: ordered.slice(max) };
}
export function openRouterRates(policy: OpenRouterPolicy) {
 const rate = (s: string) => Number(openRouterDecimal(s) / 1_000_000n);
 // A row with the no-write basis lists NO write price. If a write is ever reported anyway, its tokens are rated at the HIGHEST listed per-token price
 // (never the zero the row stores), so the settle floor max(hold, reported cost, token cost) cannot undercut the true bill.
 const noWrite = policy.cacheWriteBasis === "never_requested_enforced";
 const write = noWrite ? Math.max(rate(policy.pricing.prompt), rate(policy.pricing.completion), rate(policy.pricing.internal_reasoning), rate(policy.pricing.input_cache_read))
  : Math.max(rate(policy.pricing.prompt), rate(policy.pricing.input_cache_write));
 return { inputMicrosPerMTok: rate(policy.pricing.prompt), outputMicrosPerMTok: Math.max(rate(policy.pricing.completion), rate(policy.pricing.internal_reasoning)),
  cacheReadMicrosPerMTok: rate(policy.pricing.input_cache_read), cacheWrite5mMicrosPerMTok: write, cacheWrite1hMicrosPerMTok: write,
  estimated: false, priceVersion: 1 };
}
