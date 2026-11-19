import { previewOptionsVersion, startUsageHistory, usageHistoryEstimate } from "./start-estimate-history.js";
import { createHash } from "node:crypto";
import { DEFAULT_PLANNING_LIMIT_USD, ROVARA_CODE_AGENT_ID, type DocumentStore, type OrgId } from "@agentx/contracts";
import { parsePreviewV2, type EstimateBasis, type PathQuote, type PreviewRequestV2, type PreviewV2, type QuoteField, type QuoteLimit, type StageQuote } from "@agentx/contracts";
import { estimateRun } from "./estimate.js";
const av = <T>(value: T): QuoteField<T> => ({ state: "available", value });
const un = { state: "unavailable", reason: "not_measured" } as const;
const unreadable = { state: "unavailable", reason: "unreadable" } as const;
export interface PreviewContext { expiresAt?: string; workflowVersion?: string; policyRevision: string; stages: Record<string, Pick<StageQuote, "model" | "source" | "price">>; limits: QuoteLimit[]; initialHoldCeilingMicros?: number }
const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Read-only capabilities by construction: no admission, writable store or model transport. */
export async function startEstimates(deps: { store: Pick<DocumentStore, "query"> }, input: { orgId: OrgId; project: string; request: PreviewRequestV2; asOf: string; context: PreviewContext }): Promise<PreviewV2> {
 const { orgId, project, request, asOf, context } = input;
 const options: PathQuote[] = [];
 let usage: Awaited<ReturnType<typeof startUsageHistory>> = [];
 let usageReadable = true;
 try { usage = await startUsageHistory(deps.store, orgId, project); } catch { usageReadable = false; }
 for (const path of ["QUICK", "FULL"] as const) {
  let range: PathQuote["range"] = unreadable;
  let basis: EstimateBasis = { kind: "default", defaultVersion: av("legacy-dollar-v1"), samples: 0, effectiveSamples: 0, newestSampleAt: un, modelPriced: false, confidence: "low", interval: un };
  try {
   if (!usageReadable) throw new Error("usage history unreadable");
   const e = await estimateRun(deps, { orgId, project, agentId: ROVARA_CODE_AGENT_ID, path });
   range = av({ lowMicros: Math.ceil(e.lowUsd * 1_000_000), highMicros: Math.ceil(e.highUsd * 1_000_000) });
   basis = { ...basis, kind: e.basis, samples: e.samples, effectiveSamples: e.basis === "history" ? e.samples : 0, defaultVersion: e.basis === "default" ? av("legacy-dollar-v1") : { state: "unavailable", reason: "not_applicable" } };
   const normalized = usageHistoryEstimate(usage, path, previewOptionsVersion(request.options), context, asOf);
   if (normalized !== undefined) { range = av(normalized.range); basis = normalized.basis; }
  } catch { /* A failed history read is unavailable, never an invented default. */ }
  const knownStages = Object.entries(context.stages).filter(([stage]) => !["designReview", "secondReview", "eval"].includes(stage)).map(([, value]) => value);
  const common = <T>(values: readonly QuoteField<T>[]): QuoteField<T> => {
   return values.length > 0 && values.every(v => v.state === "available" && JSON.stringify(v) === JSON.stringify(values[0])) ? values[0]! : un;
  };
  const stages: StageQuote[] = [{ stage: "legacy_aggregate", optional: false, included: true, range, basis, model: common(knownStages.map(s => s.model)), source: common(knownStages.map(s => s.source)), price: common(knownStages.map(s => s.price)) }];
  const mixture = new Set(knownStages.filter(s => s.model.state === "available").map(s => JSON.stringify(s.model))).size > 1;
  if (mixture) {
   for (const [stage, identity] of Object.entries(context.stages)) if (!["designReview", "secondReview", "eval"].includes(stage)) stages.push({ stage, optional: false, included: true, range: un, basis, ...identity });
   range = un;
  }
  // Legacy history cannot prove the incremental price or inclusion of optional work.
  for (const stage of ["designReview", "secondReview", "eval"] as const) stages.push({ stage, optional: true, included: request.options?.[stage] === true, range: un, basis, model: context.stages[stage]?.model ?? un, source: context.stages[stage]?.source ?? un, price: context.stages[stage]?.price ?? un });
  if (stages.some(s => s.optional && s.included && s.range.state === "unavailable")) range = { state: "unavailable", reason: "not_measured" };
  const allowance = DEFAULT_PLANNING_LIMIT_USD[path] * 1_000_000;
  const initialHoldMicros = context.initialHoldCeilingMicros === undefined ? un : av(Math.min(allowance, context.initialHoldCeilingMicros));
  const limits = structuredClone(context.limits);
  const candidates = limits.filter(l => l.availableMicros.state === "available");
  const required = (l: QuoteLimit): QuoteField<number> => l.scope === "engine_task" || l.scope === "project_task" || l.scope === "engine_day" ? initialHoldMicros : un;
  // Enforcement order is supplied by the admission reader; first blocker wins, else tightest room.
  const blocks = (l: QuoteLimit): boolean => l.availableMicros.state === "available" && ((l.scope === "engine_task" || l.scope === "project_task") && l.availableMicros.value === 0 || required(l).state === "available" && (required(l) as { value: number }).value > l.availableMicros.value);
  const blocked = candidates.find(blocks);
  const tightest = blocked ?? candidates.reduce<QuoteLimit | undefined>((a, b) => a === undefined || (b.availableMicros as { value: number }).value < (a.availableMicros as { value: number }).value ? b : a, undefined);
  const firstBindingLimit: PathQuote["firstBindingLimit"] = tightest === undefined ? un : av({ scope: tightest.scope, appliesAt: required(tightest).state === "available" ? "start" : "next_call", requiredMicros: required(tightest), availableMicros: (tightest.availableMicros as { value: number }).value, blocked: required(tightest).state === "available" ? blocks(tightest) : null, reason: blocked !== undefined ? ((tightest.availableMicros as { value: number }).value === 0 ? "exhausted" : tightest.heldMicros.state === "available" && tightest.heldMicros.value > 0 ? "held" : "overrun") : "tightest_known" });
  options.push({ path, scope: "whole_task", range, basis, stages, planningAllowanceMicros: av(allowance), initialHoldMicros, limits, limitCoverage: "partial", firstBindingLimit, notices: ["path_may_escalate", ...(basis.kind === "default" ? ["legacy_dollar_default" as const] : []), "optional_cost_unavailable", "compute_excluded", "limits_partial"] });
 }
 const { expiresAt: rateExpiresAt, ...identityContext } = context;
 const inputsDigest = digest({ orgId, project, inputText: request.inputText ?? "", options: { designReview: request.options?.designReview ?? false, secondReview: request.options?.secondReview ?? false, eval: request.options?.eval ?? false }, context: identityContext, paths: ["QUICK", "FULL"] });
 const quote = parsePreviewV2({ quoteVersion: 2, kind: "comparison", orgId, project, quoteId: digest({ inputsDigest, asOf, options }), asOf, expiresAt: new Date(Math.min(Date.parse(asOf) + 60_000, rateExpiresAt === undefined ? Infinity : Date.parse(rateExpiresAt))).toISOString(), inputsDigest, policyRevision: context.policyRevision, currency: "USD", options });
 if (quote === undefined) throw new Error("start estimate could not be read");
 return quote;
}
