import { z } from "zod";

export const ModelIdentifierSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256),
}).strict();

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** A model plus the thinking level to run it at, as carried by an invocation or an eval run. */
export const ModelSelectionSchema = ModelIdentifierSchema.extend({
  thinkingLevel: ThinkingLevelSchema.optional(),
}).strict();

/** The AI companies Rovara can name behind a model. `other` is anything it does not recognise, and never counts as different from another company. */
export const MODEL_COMPANIES = ["anthropic", "openai", "google", "amazon", "meta", "mistral", "deepseek", "qwen", "cohere", "other"] as const;
export const ModelCompanySchema = z.enum(MODEL_COMPANIES);
