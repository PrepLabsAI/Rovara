// Agents can pick the models Rovara's AI serves (DEC 243c, DEC 236j). Cloud's model gateway names every model it serves a company's agents
// exactly by the id it calls: an engine model name for Claude (`claude-sonnet-5-5`) and the Bedrock model or profile id for every other model
// (`qwen.qwen3-coder-480b-a35b-v1:0`, `us.amazon.nova-2-lite-v1:0`). The gateway publishes the list it offers one company as OfferedAgentModels;
// Code reads it, offers exactly those models on the company's page, and refuses any model that is not on it.
//
// No gateway API publishes this yet: Code defines the shape here and reads it through the `OfferedModelsReader` port (docs/architecture/agent-model-choice.md
// says what Cloud's side must answer).
import { z } from "zod";
import { GatewayModelIdentitySchema } from "./gateway-model-identity.js";
import { ModelSelectionStateSchema } from "./app-model-selection.js";
import { OrgIdSchema } from "./company-scope.js";
import type { ModelIdentifier } from "./models-node.js";

/** A gateway model name: legacy Claude/Bedrock names or an exact OpenRouter vendor/model ID. No URL, spaces or separators. */
export const AGENT_MODEL_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62})$/u;
/** The most models one company's list may hold. */
export const OFFERED_AGENT_MODELS_MAX = 64;

/** The most a model's list price may be, in US dollars per million tokens. */
export const OFFERED_PRICE_USD_MAX = 10_000;
const UsdPerMillion = z.number().finite().min(0).max(OFFERED_PRICE_USD_MAX);
/**
 * DEC 254zzz96 (2): the gateway may say a model's list price (US dollars per million input and output tokens), for display on the company's
 * step models card only. Optional: a gateway that does not publish prices answers exactly as before. Nothing in the engine chooses or limits by it,
 * and the broker never stores it (stored-agent-model-choice.ts keeps the names only).
 */
export const OfferedModelPriceSchema = z.object({ inputUsdPerMillion: UsdPerMillion, outputUsdPerMillion: UsdPerMillion }).strict();
export const OfferedAgentModelSchema = z.object({ model: z.string().regex(AGENT_MODEL_NAME), price: OfferedModelPriceSchema.optional(), identity: GatewayModelIdentitySchema.optional() }).strict().superRefine((entry, context) => {
  if (entry.model.includes("/") ? entry.identity === undefined || entry.identity.modelId !== entry.model : entry.identity !== undefined) context.addIssue({ code: "custom", path: ["identity"], message: "a routed model requires its exact connected identity" });
});
export type OfferedAgentModel = z.infer<typeof OfferedAgentModelSchema>;

/** What the gateway offers one company's agents. Never empty (a gateway that offers none answers a refusal instead), and a model is listed once. */
export const OfferedAgentModelsSchema = z.object({
  version: z.literal(1),
  models: z.array(OfferedAgentModelSchema).min(1).max(OFFERED_AGENT_MODELS_MAX),
  /** Gateway attestation from this company's connected providers and existing company budget. Absent: no hosted reviewer authority. */
  reviewerAccess: z.object({
    companyId: OrgIdSchema,
    companyLimitUsd: z.number().finite().min(0).max(1_000_000),
    models: z.array(z.object({ model: z.string().regex(AGENT_MODEL_NAME), provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u) }).strict()).max(OFFERED_AGENT_MODELS_MAX),
  }).strict().optional(),
}).strict().superRefine((list, context) => {
  if (new Set(list.models.map((entry) => entry.model)).size !== list.models.length) context.addIssue({ code: "custom", path: ["models"], message: "a model is listed once" });
  if (list.reviewerAccess !== undefined && (new Set(list.reviewerAccess.models.map((entry) => entry.model)).size !== list.reviewerAccess.models.length || list.reviewerAccess.models.some((entry) => !list.models.some((offered) => offered.model === entry.model)))) context.addIssue({ code: "custom", path: ["reviewerAccess"], message: "connected models must be distinct offered models" });
});
export type OfferedAgentModels = z.infer<typeof OfferedAgentModelsSchema>;

/** Claude uses its engine name; slash IDs are OpenRouter; OpenAI's own names are a company's OpenAI key; the remaining legacy names are Bedrock IDs. */
export const isClaudeAgentModel = (name: string): boolean => name.startsWith("claude-");
/**
 * #1389: an OpenAI model by OpenAI's own name (`gpt-5`, `gpt-5.4-mini`, `o4-mini`), which the gateway serves only on a company's own OpenAI key
 * (its `openai_key` source, through Chat Completions). A Bedrock id is never one: Bedrock names a vendor first (`openai.gpt-oss-120b-1:0`).
 */
export const isOpenAiAgentModel = (name: string): boolean => /^(?:gpt-[0-9]|o[1-9])[a-z0-9.-]*$/u.test(name);

/** The model identity Code's model catalog and per-step rule know a gateway name by. */
export function agentModelIdentity(name: string): ModelIdentifier {
  if (name.includes("/")) return { provider: "openrouter", modelId: name };
  if (isClaudeAgentModel(name)) return { provider: "anthropic", modelId: name };
  return isOpenAiAgentModel(name) ? { provider: "openai", modelId: name } : { provider: "amazon-bedrock", modelId: name };
}

/** The gateway name of a model identity, or undefined when the identity is not one the gateway names (another provider, or a name that is not valid). */
export function agentModelName(model: ModelIdentifier): string | undefined {
  if (!AGENT_MODEL_NAME.test(model.modelId)) return undefined;
  // The providers are told apart by the name alone, so one name is one model: a Claude name under Bedrock (or a Bedrock id under Anthropic, or any other provider's model) is not on the list.
  return agentModelIdentity(model.modelId).provider === model.provider ? model.modelId : undefined;
}

/** What the company's page reads: its per-step model setting, and every model the gateway offers it now (the picker's whole list). */
export const AgentModelPageSchema = z.object({ state: ModelSelectionStateSchema, offered: OfferedAgentModelsSchema }).strict();
export type AgentModelPage = z.infer<typeof AgentModelPageSchema>;
