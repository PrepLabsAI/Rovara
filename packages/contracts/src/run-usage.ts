import { z } from "zod";

const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(512);
const instant = z.iso.datetime();
export const LearningField = <T extends z.ZodType>(value: T) => z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), value }).strict(),
  z.object({ state: z.literal("unavailable"), reason: z.enum(["not_measured", "missing_price", "unreadable", "restricted", "legacy_data", "not_applicable"]) }).strict(),
]);
export type LearningField<T> = { state: "available"; value: T } | { state: "unavailable"; reason: "not_measured" | "missing_price" | "unreadable" | "restricted" | "legacy_data" | "not_applicable" };
export const LearningSourceSchema = z.object({ kind: z.enum(["rovara_ai", "company_key"]), id: text, name: text, provider: text, connectionRevision: text }).strict();
export const LearningModelSchema = z.object({ provider: text, modelId: text }).strict();
export const LearningPriceRefSchema = z.object({ authority: z.enum(["gateway", "local_provider"]), version: text, hash: z.string().regex(/^[a-f0-9]{64}$/u), fetchedAt: instant }).strict();
export const LearningUsageSchema = z.object({ input: natural, output: natural, cacheRead: natural, cacheWrite5m: natural, cacheWrite1h: natural, cacheWriteUnknown: natural }).strict();
const rates = z.object({ input: natural, output: natural, cacheRead: natural, cacheWrite5m: natural, cacheWrite1h: natural }).strict();
const components = z.enum(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"]);
export const RateQuoteV1Schema = z.object({
  version: z.literal(1), currency: z.literal("USD"), unit: z.literal("micros_per_million_tokens"), ref: LearningPriceRefSchema,
  source: LearningSourceSchema, model: LearningModelSchema, region: text, asOf: instant, expiresAt: instant,
  base: rates,
  longContext: z.array(z.object({ aboveInputTokens: natural.positive(), rates }).strict()).max(16),
  derived: z.array(z.object({ aboveInputTokens: natural, components: z.array(components).max(5).refine((v) => new Set(v).size === v.length) }).strict()).max(17),
}).strict().refine((q) => q.longContext.every((b, i, all) => i === 0 || all[i - 1]!.aboveInputTokens < b.aboveInputTokens) && q.derived.every((b, i, all) => (i === 0 || all[i - 1]!.aboveInputTokens < b.aboveInputTokens) && (b.aboveInputTokens === 0 || q.longContext.some((t) => t.aboveInputTokens === b.aboveInputTokens))) && Date.parse(q.expiresAt) > Date.parse(q.asOf) && Date.parse(q.ref.fetchedAt) <= Date.parse(q.asOf));
export type RateQuoteV1 = z.infer<typeof RateQuoteV1Schema>;
const range = z.object({ lowMicros: natural, highMicros: natural }).strict().refine((r) => r.lowMicros <= r.highMicros);
export const RunStartQuoteSchema = z.object({
  asOf: instant, path: z.enum(["QUICK", "FULL", "TASK", "AGENT"]), range: LearningField(range),
  basis: z.enum(["default", "history", "unavailable"]), modelPriced: z.literal(false),
  inputs: z.object({ model: LearningField(LearningModelSchema), source: LearningField(LearningSourceSchema), price: LearningField(LearningPriceRefSchema), optionsVersion: LearningField(text) }).strict(),
}).strict();
export type RunStartQuote = z.infer<typeof RunStartQuoteSchema>;
export const RunUsageCallSchema = z.object({
  callId: text, stage: text, granularity: z.enum(["call", "session"]), model: LearningField(LearningModelSchema), source: LearningField(LearningSourceSchema),
  usage: LearningField(LearningUsageSchema), price: LearningField(LearningPriceRefSchema), settledMicros: LearningField(natural), status: z.enum(["final", "estimated", "awaiting_usage"]),
}).strict();
export type RunUsageCallV1 = z.infer<typeof RunUsageCallSchema>;
export const RunUsageSampleV1Schema = z.object({
  version: z.literal(1), companyId: z.string().regex(/^org_[0-9a-z]{20}$/u), project: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u), taskId: text,
  purpose: LearningField(text), agentId: text, path: z.enum(["QUICK", "FULL", "TASK", "AGENT"]), outcome: z.enum(["completed", "failed", "cancelled", "cap_stopped"]),
  settledAmounts: z.array(z.object({ entryId: text, amountMicros: LearningField(natural) }).strict()).max(2000).optional(),
  workflowVersion: LearningField(text), optionsVersion: LearningField(text), calls: z.array(RunUsageCallSchema).max(2000), callCount: LearningField(natural),
  completionCoverage: z.enum(["complete", "partial"]), priceCoverage: z.enum(["complete", "partial"]), endedAt: instant, revision: natural.positive(), startQuote: LearningField(RunStartQuoteSchema),
}).strict().refine((s) => new Set(s.calls.map((c) => c.callId)).size === s.calls.length && (s.callCount.state !== "available" || (s.callCount.value === s.calls.length && s.calls.every((c) => c.granularity === "call"))));
export type RunUsageSampleV1 = z.infer<typeof RunUsageSampleV1Schema>;
