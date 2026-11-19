/** Negotiated advisory quote. No reservation or spending authority is conveyed. */
export type QuoteField<T> = { state: "available"; value: T } | { state: "unavailable"; reason: "not_measured" | "missing_price" | "unreadable" | "restricted" | "legacy_data" | "not_applicable" };
export interface PreviewRequestV2 { requestId?: string; quoteVersion: 2; inputText?: string; options?: { designReview?: boolean; secondReview?: boolean; eval?: boolean } }
export interface QuoteRange { lowMicros: number; highMicros: number }
export interface QuoteModel { provider: string; modelId: string }
export interface QuoteSource { kind: "rovara_ai" | "company_key"; id: string; name: string; provider: string; connectionRevision: string }
export interface QuotePrice { authority: "gateway" | "local_provider"; version: string; hash: string; fetchedAt: string }
export type QuoteLimitScope = "engine_task" | "project_task" | "engine_day" | "gateway_task" | "project_month" | "person_month" | "company_month" | "purpose_month";
export interface QuoteLimit { scope: QuoteLimitScope; maximumMicros: QuoteField<number>; availableMicros: QuoteField<number>; heldMicros: QuoteField<number>; resetAt: QuoteField<string> }
export interface EstimateBasis { kind: "default" | "history" | "blended"; defaultVersion: QuoteField<string>; samples: number; effectiveSamples: number; newestSampleAt: QuoteField<string>; modelPriced: boolean; confidence: "low" | "medium" | "high"; interval: QuoteField<{ lowQuantile: number; highQuantile: number; targetCoverage: number; observedCoverage: QuoteField<number>; validationSamples: number }> }
export interface StageQuote { stage: string; optional: boolean; included: boolean; range: QuoteField<QuoteRange>; basis: EstimateBasis; model: QuoteField<QuoteModel>; source: QuoteField<QuoteSource>; price: QuoteField<QuotePrice> }
export interface RestrictedQuoteBinding { scope: "RESTRICTED"; blocked: boolean | null; bindingScope?: QuoteLimitScope }
export interface PathQuote { path: "QUICK" | "FULL"; scope: "whole_task"; range: QuoteField<QuoteRange>; basis: EstimateBasis; stages: StageQuote[]; planningAllowanceMicros: QuoteField<number>; initialHoldMicros: QuoteField<number>; limits: QuoteLimit[]; limitCoverage: "complete" | "partial"; firstBindingLimit: QuoteField<RestrictedQuoteBinding | { scope: QuoteLimitScope; appliesAt: "start" | "next_call" | "task_total"; requiredMicros: QuoteField<number>; availableMicros: number; blocked: boolean | null; reason: "tightest_known" | "held" | "exhausted" | "overrun" } | null>; notices: Array<"path_may_escalate" | "legacy_dollar_default" | "optional_cost_unavailable" | "compute_excluded" | "limits_partial"> }
export interface RestrictedPathQuote { path: "QUICK" | "FULL"; scope: "whole_task"; range: QuoteField<QuoteRange>; taskMaximumMicros: QuoteField<number>; limitCoverage: "complete" | "partial"; firstBindingLimit: QuoteField<RestrictedQuoteBinding>; notices: PathQuote["notices"] }
export interface PreviewV2 { quoteVersion: 2; kind: "comparison"; orgId: string; project: string; quoteId: string; asOf: string; expiresAt: string; inputsDigest: string; policyRevision: string; currency: "USD"; options: [(PathQuote | RestrictedPathQuote) & { path: "QUICK" }, (PathQuote | RestrictedPathQuote) & { path: "FULL" }] }
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype ? v as Record<string, unknown> : undefined;
const exact = (v: Record<string, unknown>, keys: string): boolean => Object.keys(v).sort().join(" ") === keys.split(" ").sort().join(" ");
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048;
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const word = (v: unknown, words: string): boolean => words.split(" ").includes(v as string);
const scope = (v: unknown): boolean => word(v, "engine_task project_task engine_day gateway_task project_month person_month company_month purpose_month");
const field = (v: unknown, valid: (v: unknown) => boolean): boolean => { const f = record(v); return f !== undefined && (f.state === "available" ? exact(f, "state value") && valid(f.value) : exact(f, "state reason") && f.state === "unavailable" && word(f.reason, "not_measured missing_price unreadable restricted legacy_data not_applicable")); };
const shape = (v: unknown, keys: string, valid: (r: Record<string, unknown>) => boolean): boolean => { const r = record(v); return r !== undefined && exact(r, keys) && valid(r); };
const range = (v: unknown): boolean => shape(v, "lowMicros highMicros", r => natural(r.lowMicros) && natural(r.highMicros) && r.lowMicros <= r.highMicros);
const fraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const basis = (v: unknown): boolean => shape(v, "kind defaultVersion samples effectiveSamples newestSampleAt modelPriced confidence interval", b => word(b.kind, "default history blended") && field(b.defaultVersion, text) && natural(b.samples) && typeof b.effectiveSamples === "number" && Number.isFinite(b.effectiveSamples) && b.effectiveSamples >= 0 && b.effectiveSamples <= b.samples && field(b.newestSampleAt, time) && typeof b.modelPriced === "boolean" && word(b.confidence, "low medium high") && field(b.interval, x => shape(x, "lowQuantile highQuantile targetCoverage observedCoverage validationSamples", i => fraction(i.lowQuantile) && fraction(i.highQuantile) && i.lowQuantile < i.highQuantile && fraction(i.targetCoverage) && field(i.observedCoverage, fraction) && natural(i.validationSamples))));
const model = (v: unknown): boolean => shape(v, "provider modelId", r => text(r.provider) && text(r.modelId));
const source = (v: unknown): boolean => shape(v, "kind id name provider connectionRevision", r => word(r.kind, "rovara_ai company_key") && [r.id, r.name, r.provider, r.connectionRevision].every(text));
const price = (v: unknown): boolean => shape(v, "authority version hash fetchedAt", r => word(r.authority, "gateway local_provider") && text(r.version) && text(r.hash) && time(r.fetchedAt));
const stage = (v: unknown): boolean => shape(v, "stage optional included range basis model source price", s => text(s.stage) && typeof s.optional === "boolean" && typeof s.included === "boolean" && field(s.range, range) && basis(s.basis) && field(s.model, model) && field(s.source, source) && field(s.price, price));
const limit = (v: unknown): boolean => shape(v, "scope maximumMicros availableMicros heldMicros resetAt", l => scope(l.scope) && [l.maximumMicros, l.availableMicros, l.heldMicros].every(f => field(f, natural)) && field(l.resetAt, time));
const binding = (v: unknown): boolean => v === null || shape(v, record(v)?.bindingScope === undefined ? "scope blocked" : "scope blocked bindingScope", b => b.scope === "RESTRICTED" && (b.bindingScope === undefined || scope(b.bindingScope)) && (typeof b.blocked === "boolean" || b.blocked === null)) || shape(v, "scope appliesAt requiredMicros availableMicros blocked reason", b => scope(b.scope) && word(b.appliesAt, "start next_call task_total") && field(b.requiredMicros, natural) && natural(b.availableMicros) && (typeof b.blocked === "boolean" || b.blocked === null) && word(b.reason, "tightest_known held exhausted overrun") && (b.appliesAt !== "next_call" || (record(b.requiredMicros)?.state === "unavailable" && b.blocked === null)));
function pathQuote(v: unknown): boolean {
 const raw = record(v);
 const bound = record(record(raw?.firstBindingLimit)?.value);
 if (bound?.scope === "RESTRICTED") {
  return shape(v, "path scope range taskMaximumMicros limitCoverage firstBindingLimit notices", q => word(q.path, "QUICK FULL") && q.scope === "whole_task" && field(q.range, range) && field(q.taskMaximumMicros, natural) && word(q.limitCoverage, "complete partial") && field(q.firstBindingLimit, b => record(b)?.scope === "RESTRICTED" && binding(b)) && Array.isArray(q.notices) && q.notices.length <= 5 && q.notices.every(n => word(n, "path_may_escalate legacy_dollar_default optional_cost_unavailable compute_excluded limits_partial")) && (q.limitCoverage !== "partial" || q.notices.includes("limits_partial")));
 }
 if (!shape(v, "path scope range basis stages planningAllowanceMicros initialHoldMicros limits limitCoverage firstBindingLimit notices", q => word(q.path, "QUICK FULL") && q.scope === "whole_task" && field(q.range, range) && basis(q.basis) && Array.isArray(q.stages) && q.stages.length > 0 && q.stages.length <= 32 && q.stages.every(stage) && field(q.planningAllowanceMicros, natural) && field(q.initialHoldMicros, natural) && Array.isArray(q.limits) && q.limits.length <= 8 && q.limits.every(limit) && word(q.limitCoverage, "complete partial") && field(q.firstBindingLimit, binding) && Array.isArray(q.notices) && q.notices.length <= 5 && q.notices.every(n => word(n, "path_may_escalate legacy_dollar_default optional_cost_unavailable compute_excluded limits_partial")))) return false;
 const q = v as PathQuote;
 if (new Set(q.limits.map(l => l.scope)).size !== q.limits.length || new Set(q.stages.map(s => s.stage)).size !== q.stages.length) return false;
 if (q.limitCoverage === "partial" && (q.firstBindingLimit.state === "available" && q.firstBindingLimit.value === null || !q.notices.includes("limits_partial"))) return false;
 const fullBound = q.firstBindingLimit.state === "available" ? q.firstBindingLimit.value : undefined;
 if (fullBound != null && (fullBound.scope === "RESTRICTED" || !q.limits.some(l => l.scope === fullBound.scope))) return false;
 if (q.initialHoldMicros.state === "available" && q.planningAllowanceMicros.state === "available" && q.initialHoldMicros.value > q.planningAllowanceMicros.value) return false;
 if (q.range.state === "available") {
  const included = q.stages.filter(s => s.included);
  if (included.some(s => s.range.state !== "available")) return false;
  const sum = (key: keyof QuoteRange) => included.reduce((n, s) => n + (s.range.state === "available" ? s.range.value[key] : 0), 0);
  if (sum("lowMicros") !== q.range.value.lowMicros || sum("highMicros") !== q.range.value.highMicros) return false;
 }
 return true;
}
export function parsePreviewRequestV2(raw: unknown): PreviewRequestV2 | undefined {
 const r = record(raw); if (r === undefined || r.quoteVersion !== 2 || Object.keys(r).some(k => !["requestId", "quoteVersion", "inputText", "options"].includes(k))) return undefined;
 if (r.requestId !== undefined && !(typeof r.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(r.requestId))) return undefined;
 if (r.inputText !== undefined && !(typeof r.inputText === "string" && r.inputText.length <= 4000)) return undefined;
 if (r.options !== undefined) { const o = record(r.options); if (o === undefined || Object.keys(o).some(k => !["designReview", "secondReview", "eval"].includes(k) || typeof o[k] !== "boolean")) return undefined; }
 return structuredClone(r) as unknown as PreviewRequestV2;
}
export function parsePreviewV2(raw: unknown): PreviewV2 | undefined {
 if (!shape(raw, "quoteVersion kind orgId project quoteId asOf expiresAt inputsDigest policyRevision currency options", q => q.quoteVersion === 2 && q.kind === "comparison" && typeof q.orgId === "string" && /^org_[0-9a-z]{20}$/u.test(q.orgId) && typeof q.project === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(q.project) && text(q.quoteId) && time(q.asOf) && time(q.expiresAt) && Date.parse(q.expiresAt as string) > Date.parse(q.asOf as string) && typeof q.inputsDigest === "string" && /^[0-9a-f]{64}$/u.test(q.inputsDigest) && text(q.policyRevision) && q.currency === "USD" && Array.isArray(q.options) && q.options.length === 2 && q.options.every(pathQuote) && record(q.options[0])?.path === "QUICK" && record(q.options[1])?.path === "FULL")) return undefined;
 return structuredClone(raw) as PreviewV2;
}


/** Member view: only this task's range and per-task maximum carry figures.
 * Remaining amounts, holds, history and planning exposure never leave this boundary.
 * Idempotent so Cloud can restrict full and already-restricted Code quotes alike.
 */
export function restrictPreviewV2(quote: PreviewV2): PreviewV2 {
 const options = quote.options.map((q): RestrictedPathQuote => {
  const binding = q.firstBindingLimit.state === "available" ? q.firstBindingLimit.value : undefined;
  const maxima = "limits" in q ? q.limits.filter(l => ["engine_task", "project_task", "gateway_task"].includes(l.scope)).flatMap(l => l.maximumMicros.state === "available" ? [l.maximumMicros.value] : []) : [];
  return {
   path: q.path, scope: q.scope, range: structuredClone(q.range),
   taskMaximumMicros: "taskMaximumMicros" in q ? structuredClone(q.taskMaximumMicros) : maxima.length > 0 ? { state: "available", value: Math.min(...maxima) } : { state: "unavailable", reason: "not_applicable" },
   limitCoverage: q.limitCoverage,
   firstBindingLimit: { state: "available", value: { scope: "RESTRICTED", blocked: binding === null && q.limitCoverage === "complete" ? false : binding?.blocked ?? null, ...(binding == null ? {} : binding.scope === "RESTRICTED" ? (binding.bindingScope === undefined ? {} : { bindingScope: binding.bindingScope }) : { bindingScope: binding.scope }) } },
   notices: [...q.notices],
  };
 });
 return { ...structuredClone(quote), options: options as PreviewV2["options"] };
}
