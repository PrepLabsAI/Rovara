import { RunUsageSampleV1Schema, type RunUsageSampleV1, ESTIMATE_HISTORY_SIZE, ESTIMATE_MIN_SAMPLES, ROVARA_CODE_AGENT_ID, companyScoped, type DocumentStore, type OrgId, type EstimateBasis, type QuoteRange } from "@agentx/contracts";
import type { PreviewContext } from "./start-estimates.js";
type Sample = RunUsageSampleV1;
const av = <T>(value: T) => ({ state: "available" as const, value });
export const previewOptionsVersion = (options: { designReview?: boolean; secondReview?: boolean; eval?: boolean } | undefined): string => `start-preview-v2:${options?.designReview === true ? 1 : 0}${options?.secondReview === true ? 1 : 0}${options?.eval === true ? 1 : 0}`;
/** A bounded lexical window, never claimed to be newest across the entire company's history. */
export async function startUsageHistory(store: Pick<DocumentStore, "query">, companyId: OrgId, project: string): Promise<Sample[]> {
 const page = await store.query({ pk: companyScoped(companyId, `RUN_USAGE#${project}`), limit: 200 });
 if (page.cursor !== undefined) throw new Error("usage history coverage is partial");
 const latest = new Map<string, Sample>();
 for (const row of page.items) {
  if (row["entityType"] !== "RUN_USAGE_SAMPLE" || row["companyId"] !== companyId || row["project"] !== project) continue;
  const parsed = RunUsageSampleV1Schema.safeParse(row["sample"]);
  if (!parsed.success || parsed.data.companyId !== companyId || parsed.data.project !== project) continue;
  const s = parsed.data, prior = latest.get(s.taskId);
  if (prior === undefined || s.revision > prior.revision) latest.set(s.taskId, s);
 }
 return [...latest.values()];
}
/** Dollar history is compatible only at the same known price/model/source/options. It never claims model re-pricing. */
export function usageHistoryEstimate(samples: readonly Sample[], path: "QUICK" | "FULL", optionsVersion: string, context: PreviewContext, asOf: string): { range: QuoteRange; basis: EstimateBasis } | undefined {
 const costs: Array<{ micros: number; endedAt: string }> = [];
 for (const s of samples) {
  if (s.path !== path || s.agentId !== ROVARA_CODE_AGENT_ID || s.purpose.state !== "unavailable" || s.purpose.reason !== "not_applicable" || s.outcome !== "completed" || s.completionCoverage !== "complete" || s.priceCoverage !== "complete" || s.optionsVersion.state !== "available" || s.optionsVersion.value !== optionsVersion || s.workflowVersion.state !== "available" || s.workflowVersion.value !== (context.workflowVersion ?? "1.1.0") || Date.parse(s.endedAt) > Date.parse(asOf) || s.callCount.state !== "available" || s.callCount.value !== s.calls.length || new Set(s.calls.map(c => c.callId)).size !== s.calls.length) continue;
  let total = 0n, compatible = true;
  for (const call of s.calls) {
   const current = context.stages[call.stage];
   if (call.granularity !== "call" || call.status !== "final" || call.usage.state !== "available" || call.settledMicros.state !== "available" || call.model.state !== "available" || call.source.state !== "available" || call.price.state !== "available" || current?.model.state !== "available" || current.source.state !== "available" || current.price.state !== "available") { compatible = false; break; }
   const m = current.model.value, src = current.source.value, p = current.price.value;
   if (call.model.value.provider !== m.provider || call.model.value.modelId !== m.modelId || call.source.value.kind !== src.kind || call.source.value.id !== src.id || call.source.value.provider !== src.provider || call.source.value.connectionRevision !== src.connectionRevision || call.price.value.authority !== p.authority || call.price.value.version !== p.version || call.price.value.hash !== p.hash) { compatible = false; break; }
   total += BigInt(call.settledMicros.value);
  }
  if (compatible && total <= BigInt(Number.MAX_SAFE_INTEGER)) costs.push({ micros: Number(total), endedAt: s.endedAt });
 }
 const recent = costs.sort((a,b) => b.endedAt.localeCompare(a.endedAt)).slice(0, ESTIMATE_HISTORY_SIZE);
 if (recent.length < ESTIMATE_MIN_SAMPLES) return undefined;
 const sorted = recent.map(c => c.micros).sort((a,b) => a-b);
 return { range: { lowMicros: sorted[Math.ceil(sorted.length * 0.5) - 1]!, highMicros: sorted[Math.ceil(sorted.length * 0.8) - 1]! }, basis: { kind: "history", defaultVersion: { state: "unavailable", reason: "not_applicable" }, samples: recent.length, effectiveSamples: recent.length, newestSampleAt: av(recent[0]!.endedAt), modelPriced: false, confidence: "low", interval: { state: "unavailable", reason: "not_measured" } } };
}
