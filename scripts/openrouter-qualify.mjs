#!/usr/bin/env node
// Release-test principal only. Credentials are read solely from OPENROUTER_API_KEY.
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { setTimeout as sleepFor } from "node:timers/promises";
const { AbortSignal } = globalThis;
import { pathToFileURL } from "node:url";
import { openRouterCapOrder, openRouterDecimal, openRouterHold, openRouterPolicy, openRouterRequest, perMillionPrice, OPENROUTER_PRICE_KEYS, OPENROUTER_RELAXED_TARIFF_MODELS, OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION, OPENROUTER_REFERENCE_PROMPT_TOKENS } from "../packages/model-gateway/dist/openrouter-policy.js";
import { OFFERED_MODEL_NAME, OFFERED_MODELS_MAX } from "../packages/model-gateway/dist/offered-models.js";
// Ruling (a): the harness proves exactly what the gateway's validator (openRouterPolicy) installs. The row bounds are the runtime's:
// bounded reasoning needs reasoning.max_tokens >= 1024 and strictly below max_completion_tokens (openrouter-policy.ts:111), and a request
// must ask for more than the reasoning budget (:149). One rung: every control and probe is sent at the row's OWN ceiling.
const HARNESS_MAX_COMPLETION_TOKENS = 2048;
const HARNESS_REASONING_TOKENS = 1024;
/** The gateway's versioned no-cache-write enforcement basis (openrouter-policy.ts noWrite), recorded on ANY row whose catalogue write price is ABSENT (owner rule 2026-11-23). */
const applyNoWriteBasis = tariff => { tariff.cacheWriteBasis = "never_requested_enforced"; tariff.cacheWriteEnforcementVersion = OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION; };
const CEILING_FLOOR_REASON = `max_completion_tokens <= ${HARNESS_REASONING_TOKENS}: below the runtime bounded-reasoning floor`;
/** Reference prompt size of the install tie-break (ruling (c)); a change is a visible diff and a pinned test. */
export const REFERENCE_PROMPT_TOKENS = OPENROUTER_REFERENCE_PROMPT_TOKENS;
// Exceptions use only locally constructed diagnostics; refusal bodies are separately sanitized.
class EvidenceError extends Error {}
const evidenceReason = error => error instanceof EvidenceError ? error.message : "HTTP evidence unavailable";
const recordCheck = (target, name, ok, reason) => {
 target.checks[name] = ok ? "PASS" : "FAIL";
 if (!ok) target.reasons[name] = reason;
};
const MICRO = 1_000_000_000_000n;
// Qualification accepts finite decimals beyond the installed tariff's precision.
// Keep numerator/denominator exact until the TOTAL token charge becomes micros.
const rationalPrice = value => {
 if (typeof value !== "string") throw new Error("unbounded tariff");
 const match = /^(\d{1,40})(?:\.(\d{1,80}))?(?:e([+-]?\d{1,2}))?$/iu.exec(value);
 if (!match) throw new Error("unbounded tariff");
 const exponent = BigInt(match[3] ?? "0") - BigInt(match[2]?.length ?? 0);
 const numerator = BigInt(match[1] + (match[2] ?? ""));
 return exponent >= 0n ? { n: numerator * 10n ** exponent, d: 1n } : { n: numerator, d: 10n ** -exponent };
};
const addPrice = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const comparePrice = (a, b) => a.n * b.d - b.n * a.d;
const maxPrice = (a, b) => comparePrice(rationalPrice(a), rationalPrice(b)) >= 0n ? a : b;
const ceilRatio = (n, d) => (n + d - 1n) / d;
const priceSum = components => components.reduce((sum, [tokens, price]) => {
 if (!count(tokens)) throw new Error("invalid token count");
 const rate = rationalPrice(price);
 return addPrice(sum, { n: BigInt(tokens) * rate.n, d: rate.d });
}, { n: 0n, d: 1n });
// Harness-local arithmetic shared by reservations and the receipt backstop.
export const qualificationCostMicros = components => {
 const sum = priceSum(components);
 const units = ceilRatio(sum.n * 1_000_000n, sum.d);
 if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unbounded hold");
 return Number(units);
};
const decimalUnits = (units, places) => {
 const text = units.toString().padStart(places + 1, "0");
 return `${text.slice(0, -places)}.${text.slice(-places)}`;
};
// JSON max_price is numeric. Round that WIRE CAP upward; never alter a token rate.
const qualificationWireCap = (price, perMillion) => {
 const exact = rationalPrice(price);
 const amount = { n: exact.n * (perMillion ? 1_000_000n : 1n), d: exact.d };
 let units = ceilRatio(amount.n * 1_000_000_000_000n, amount.d);
 for (let attempt = 0; attempt < 2; attempt++, units++) {
  const cap = Number(decimalUnits(units, 12));
  if (Number.isFinite(cap) && comparePrice(rationalPrice(String(cap)), amount) >= 0n) return cap;
 }
 throw new Error("unrepresentable price cap");
};
const validationPrices = Object.fromEntries(OPENROUTER_PRICE_KEYS.map(key => [key, key === "prompt" || key === "completion" ? "0.000001" : "0"]));
const UNUSED_PRICE_KEYS = ["web_search", "image", "audio", "input_audio", "output_audio", "input_audio_cache", "input_cache_write_1h"];
const OVERRIDE_CONDITIONS = ["context_length", "min_prompt_tokens", "utc_start", "utc_end", "utc_days"];
const validOverrideCondition = (key, value) => {
 if (key === "utc_days") return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(day => ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(day));
 if (!Number.isSafeInteger(value)) return false;
 if (key === "utc_start" || key === "utc_end") return value >= 0 && value <= 2359 && value % 100 < 60;
 return key === "context_length" ? value > 0 : value >= 0;
};
const INFERENCE_BREAKDOWN_KEYS = ["upstream_inference_prompt_cost", "upstream_inference_completions_cost"];
const INFERENCE_DETAIL_KEYS = ["upstream_inference_cost", ...INFERENCE_BREAKDOWN_KEYS];
// Only exact IDs or calendar-date suffixes: -YYYY-MM-DD (OpenRouter's real form, e.g.
// openai/gpt-5-mini-2025-08-07), -20YYMMDD, or -MMDD. Every date is calendar-checked.
// A short date takes the run's UTC year, or the year before when that would be a future
// date (a -1231 id seen on 1 January is last December).
const utcDay = (year, month, day) => {
 const parsed = new Date(Date.UTC(year, month - 1, day));
 return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? parsed.getTime() : undefined;
};
const observedModel = (requested, actual, at) => {
 if (typeof actual !== "string") return undefined;
 if (actual === requested) return actual;
 if (!actual.startsWith(`${requested}-`)) return undefined;
 const suffix = actual.slice(requested.length + 1);
 const dashed = /^(20\d{2})-(\d{2})-(\d{2})$/u.exec(suffix);
 const compact = /^(20\d{2})(\d{2})(\d{2})$/u.exec(suffix);
 const short = /^(\d{2})(\d{2})$/u.exec(suffix);
 if (dashed) return utcDay(Number(dashed[1]), Number(dashed[2]), Number(dashed[3])) === undefined ? undefined : actual;
 if (compact) return utcDay(Number(compact[1]), Number(compact[2]), Number(compact[3])) === undefined ? undefined : actual;
 if (!short) return undefined;
 const today = new Date(at); const year = today.getUTCFullYear();
 const month = Number(short[1]), day = Number(short[2]);
 const thisYear = utcDay(year, month, day);
 // An invalid this-year date (0229 off a leap year) compares false and is refused below.
 const date = thisYear > Date.UTC(year, today.getUTCMonth(), today.getUTCDate()) ? year - 1 : year;
 return utcDay(date, month, day) === undefined ? undefined : `${requested}-${date}${short[1]}${short[2]}`;
};
const unrequestedSearchNull = (name, value, searchNotRequested) => searchNotRequested && ["generation.num_search_results", "generation.web_search_engine"].includes(name) && value === null;
/** Optional prompt/completions breakdown: both must be readable nonnegative USD,
 * and their sum must match the aggregate within 1 micro-dollar ($0.000001), inclusive.
 * This rounding tolerance applies ONLY to the breakdown, never aggregate/total-cost checks.
 */
const consistentInferenceBreakdown = details => {
 if (!INFERENCE_BREAKDOWN_KEYS.some(key => Object.hasOwn(details, key))) return true;
 try {
  const values = INFERENCE_DETAIL_KEYS.map(key => {
   // Exactly zero is valid for either part (and the aggregate); negatives/unreadable refuse.
   if (!nonnegativeMoney(details[key])) throw new Error();
   return openRouterDecimal(String(details[key]));
  });
  const delta = values[1] + values[2] - values[0];
  return delta >= -MICRO && delta <= MICRO;
 } catch { return false; }
};
const micros = value => Number((openRouterDecimal(String(value)) + MICRO - 1n) / MICRO);
const safeCount = n => count(n) ? n : null;
const safeMoney = n => nonnegativeMoney(n) ? n : null;
const count = n => Number.isSafeInteger(n) && n >= 0;
const equalMoney = (a, b) => {
 try { return openRouterDecimal(String(a)) === openRouterDecimal(String(b)); } catch { return false; }
};
/** True when text contains the credential or any 16-character piece of it (a provider echo must never leave this process). */
export const containsCredential = (text, key) => {
 if (typeof key !== "string" || key.length === 0 || typeof text !== "string") return false;
 if (text.includes(key)) return true;
 for (let i = 0; i + 16 <= key.length; i++) if (text.includes(key.slice(i, i + 16))) return true;
 return false;
};
const nonnegativeMoney = v => (typeof v === "number" && Number.isFinite(v) && v >= 0) || (typeof v === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(v));
/** Refuse positive or unreadable auxiliary billing evidence anywhere in usage/generation.
 * Only the aggregate/inference totals and separately validated breakdown are exempt; never echo untrusted keys/values.
 */
export const noAuxiliaryEvidence = (value, path = "", searchNotRequested = false) => {
 if (value === null || typeof value !== "object") return true;
 return Object.entries(value).every(([key, child]) => {
  const name = path ? `${path}.${key}` : key;
  if (["usage.cost", "usage.cost_details.upstream_inference_cost", ...INFERENCE_BREAKDOWN_KEYS.map(key => `usage.cost_details.${key}`), "generation.total_cost"].includes(name)) return true;
  if (name === "generation.web_search_engine") return unrequestedSearchNull(name, child, searchNotRequested);
  if (unrequestedSearchNull(name, child, searchNotRequested)) return true;
  if (/(?:cost|fee|search|cache_write|cache_creation)/iu.test(key) && key !== "cost_details") return equalMoney(child, "0");
  return noAuxiliaryEvidence(child, name, searchNotRequested);
 });
};
/** OpenRouter's counters need not agree across endpoints. Bound each readable receipt
 * at the dearer output interpretation (reasoning outside completion), then retain
 * the larger bound. Aggregate costs must still agree exactly, be positive and fit
 * the rounded-UP micro bound AND the original reservation in all-models mode. No inference of zero fees.
 */
const maximumInferenceCost = (policy, usage, generation) => {
 const receipts = [
  [usage?.prompt_tokens, usage?.completion_tokens, usage?.completion_tokens_details?.reasoning_tokens, usage?.prompt_tokens_details?.cached_tokens ?? 0],
  [generation.native_tokens_prompt, generation.native_tokens_completion, generation.native_tokens_reasoning, generation.native_tokens_cached],
 ];
 const p = policy.pricing;
 if (policy.exactPricing) {
  let maximum = 0n;
  for (const [prompt, completion, reasoning, cached] of receipts) {
   if (![prompt, completion, reasoning, cached].every(count) || cached > prompt) return undefined;
   // Separate terms avoid overflowing JS when completion + reasoning is large.
   const cost = BigInt(qualificationCostMicros([[prompt - cached, p.prompt], [cached, p.input_cache_read], [completion, p.completion], [reasoning, p.completion], [1, p.request]])) * MICRO;
   if (cost > maximum) maximum = cost;
  }
  return maximum;
 }
 const rate = key => openRouterDecimal(p[key]);
 let maximum = 0n;
 for (const [prompt, completion, reasoning, cached] of receipts) {
  if (![prompt, completion, reasoning, cached].every(count) || cached > prompt) return undefined;
  // BigInt addition cannot overflow a safe JS integer when provider counts are large.
  const output = BigInt(completion) + BigInt(reasoning);
  const cost = BigInt(prompt - cached) * rate("prompt") + BigInt(cached) * rate("input_cache_read") + output * rate("completion") + rate("request");
  if (cost > maximum) maximum = cost;
 }
 return maximum;
};
/** In-memory HTTP fixtures inject fetch. The CLI always targets the fixed TLS origin. */
async function qualifyModels({ models, provider, providerName = provider, spendCap = "0.50", fetch: request = globalThis.fetch, env = process.env, now = Date.now, sleep = sleepFor, catalogue: suppliedCatalogue, prepareOnly = false, budget, allModels = false }) {
 const report = { status: "FAIL", chargedMicros: 0, preCallHoldsMicros: 0, spendCapMicros: 0, models: [], proposedTariffRows: [], errors: [] };
 let exposure = 0; let modelExposure = 0; let stop = false;
 const expose = amount => {
  exposure += amount; modelExposure += amount;
  if (budget) { budget.exposure += amount; budget.modelExposure += amount; }
 };
 const overCap = () => budget ? budget.exposure > budget.cap || budget.modelExposure > budget.modelCap : exposure > report.spendCapMicros;
 const reserve = (result, hold) => {
  const overall = budget ? budget.exposure : exposure;
  if ((budget ? budget.modelExposure : modelExposure) + hold > (budget ? budget.modelCap : 500000)) {
   recordCheck(result, "per_model_cap", false, "pre-call hold would exceed per-model cap");
   return false;
  }
  if (overall + hold > report.spendCapMicros) {
   recordCheck(result, "spend_cap", false, `exposure ${overall} + hold ${hold} > spend cap ${report.spendCapMicros} micros`);
   stop = true; if (budget) budget.stop = "overall_cap"; return false;
  }
  expose(hold); report.preCallHoldsMicros += hold; return true;
 };
 // Never print exceptions, full response bodies, headers or credentials (even a provider echo).
 try {
  report.spendCapMicros = Number(openRouterDecimal(spendCap) / MICRO);
  if (!Number.isSafeInteger(report.spendCapMicros) || report.spendCapMicros < 1 || !env.OPENROUTER_API_KEY ||
      !Array.isArray(models) || models.length < (suppliedCatalogue ? 1 : 2) || models.length > 3 || new Set(models).size !== models.length ||
      models.some(m => typeof m !== "string" || !validModel(m)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(provider) || typeof providerName !== "string" || providerName.length > 128) throw new Error();
  const json = async (path, body, rejected) => {
   const url = `https://openrouter.ai/api/v1/${path}`;
   if (containsCredential(url, env.OPENROUTER_API_KEY)) { stop = true; if (budget) budget.stop = "credential"; throw new Error(); }
   const res = await request(url, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   if ([401, 403].includes(res.status)) { stop = true; if (budget) budget.stop = "authentication"; }
   const bytes = await res.text(); if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new EvidenceError("body exceeds byte limit");
   // GET errors need no billing body. A delayed 404 may have an empty/non-JSON body.
   if (!res.ok && body === undefined) throw new EvidenceError(`http ${res.status}`);
   let data;
   try { data = JSON.parse(bytes); } catch { throw new EvidenceError("malformed body"); }
   if (!res.ok) { rejected?.(data); throw new EvidenceError(`http ${res.status}`); }
   return data;
  };
  // Retry ONLY unavailable GET evidence, never the paid completion. Five sleeps total 30s.
  const generationLookup = async id => {
   if (typeof id !== "string" || !/^gen-[A-Za-z0-9_-]{1,200}$/u.test(id) || containsCredential(id, env.OPENROUTER_API_KEY)) {
    if (containsCredential(id, env.OPENROUTER_API_KEY)) { stop = true; if (budget) budget.stop = "credential"; }
    throw new EvidenceError("malformed id");
   }
   const delays = [1000, 2000, 4000, 8000, 15000];
   for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await json(`generation?id=${encodeURIComponent(id)}`); }
    catch (error) { if (!(error instanceof EvidenceError) || error.message !== "http 404") throw error; }
    if (response !== undefined) {
     if (response === null || typeof response !== "object" || Array.isArray(response)) throw new EvidenceError("malformed body");
     const data = response.data;
     if (data !== undefined && data !== null) {
      if (typeof data !== "object" || Array.isArray(data)) throw new EvidenceError("malformed body");
      if (Object.keys(data).length > 0) return data;
     }
    }
    if (attempt === delays.length) throw new EvidenceError("not available after 6 tries over 30 s");
    await sleep(delays[attempt]);
   }
  };
  const safeValue = value => {
   const numeric = typeof value === "number" && Number.isFinite(value) || typeof value === "string" && /^-?\d{1,24}(?:\.\d{1,24})?(?:e[+-]?\d{1,2})?$/iu.test(value);
   return (numeric || typeof value === "boolean" || value === null) && !containsCredential(String(value), env.OPENROUTER_API_KEY) ? String(value) : "[invalid]";
  };
  const safeRefusalText = value => {
   if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return "[invalid]";
   const text = String(value);
   const printable = text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
   // Check before truncation/sanitizing too: neither may hide a credential echo.
   if (containsCredential(text, env.OPENROUTER_API_KEY) || containsCredential(printable, env.OPENROUTER_API_KEY)) return "[redacted]";
   return printable.slice(0, 300);
  };
  const tokenReason = (field, value, min, max) => !count(value) ? `${field} ${safeValue(value)} expected nonnegative safe integer` : value < min ? `${field} ${safeValue(value)} < min ${min}` : value > max ? `${field} ${safeValue(value)} > max ${max}` : undefined;
  const catalogue = suppliedCatalogue ?? await json("models");
  if (!Array.isArray(catalogue.data)) throw new Error();
  for (const model of models) {
   const result = { model, status: "FAIL", reasons: {}, checks: {}, calls: [] }; report.models.push(result); modelExposure = 0;
   if (stop) { recordCheck(result, "not_attempted", false, "shared authentication, credential or spend-cap stop"); continue; }
   const matches = catalogue.data.filter(m => m.id === model);
   const entry = matches.length === 1 ? matches[0] : undefined;
   const at = now();
   const tariff = { model, route: provider, pricing: entry?.pricing, max_completion_tokens: Number.isSafeInteger(entry?.top_provider?.max_completion_tokens) ? Math.min(entry.top_provider.max_completion_tokens, HARNESS_MAX_COMPLETION_TOKENS) : undefined,
    reasoning: { mode: "bounded", max_tokens: HARNESS_REASONING_TOKENS }, verifiedAt: at, expiresAt: at + 86_400_000, evidence: "CANDIDATE ONLY: attach reviewed release-test report; never auto-install" };
   // Components the catalogue left ABSENT and the harness normalized to zero (never an explicit price; see tariffEvidence).
   tariff.assumedZero = [];
   // Catalog diagnostics contain only field names and numeric public prices, never arbitrary text.
   const failures = [];
   const safeField = key => /^[a-z][a-z0-9_]{0,63}$/u.test(key) && !containsCredential(key, env.OPENROUTER_API_KEY) ? key : "[invalid field]";
   const fieldValue = (key, value) => {
    const safeKey = safeField(key);
    const numeric = (typeof value === "string" && /^-?\d{1,24}(?:\.\d{1,24})?(?:e[+-]?\d{1,2})?$/iu.test(value)) || (typeof value === "number" && Number.isFinite(value));
    const safe = (numeric || value === null) && !containsCredential(String(value), env.OPENROUTER_API_KEY) ? JSON.stringify(value) : "[invalid]";
    return `pricing.${safeKey}=${safe}`;
   };
   const pricing = {};
   const catalogPrices = entry?.pricing;
   if (matches.length !== 1) failures.push("model missing or duplicate catalog entry");
   if (catalogPrices === null || typeof catalogPrices !== "object" || Array.isArray(catalogPrices)) failures.push("pricing missing or invalid");
   const prices = catalogPrices !== null && typeof catalogPrices === "object" && !Array.isArray(catalogPrices) ? catalogPrices : {};
   const allowlisted = Object.hasOwn(OPENROUTER_RELAXED_TARIFF_MODELS, model);
   // This is qualification-only normalization. Installed policies still require
   // reviewed, complete prices; no new route is activated by discovery.
   let missingReasoning = allModels && entry.reasoningBilledAtCompletion === true;
   let priceSets = [prices];
   if (allModels) {
    const overrides = prices.overrides;
    if (Object.hasOwn(prices, "overrides")) {
     // Flat price patches with known token/context/time conditions. Use EVERY
     // patch regardless of whether its condition applies now: worst-case maxima.
     if (!Array.isArray(overrides) || overrides.some(o => o === null || typeof o !== "object" || Array.isArray(o) ||
      Object.keys(o).some(k => !OVERRIDE_CONDITIONS.includes(k) && !OPENROUTER_PRICE_KEYS.includes(k) && !UNUSED_PRICE_KEYS.includes(k) && k !== "discount") ||
      !Object.keys(o).some(k => OPENROUTER_PRICE_KEYS.includes(k) || UNUSED_PRICE_KEYS.includes(k)) ||
      Object.entries(o).some(([k, v]) => OVERRIDE_CONDITIONS.includes(k) && !validOverrideCondition(k, v)) ||
      (Object.hasOwn(o, "utc_start") !== Object.hasOwn(o, "utc_end")))) {
      const fields = Array.isArray(overrides) ? overrides.flatMap(o => o !== null && typeof o === "object" ? Object.keys(o).map(safeField) : []) : [];
      failures.push(`pricing.overrides unknown shape; fields ${fields.join(", ") || "unavailable"}`);
     } else priceSets = [prices, ...overrides.map(o => ({ ...prices, ...o }))];
    }
   }
   // The no-write basis exists only when the catalogue stated NO write price (an explicit zero never gets it). In all-models mode the per-route entry
   // carries the already-normalized six prices, so the absence is read from its recorded assumedZero (the routes' intersection), not from the prices.
   const writeAbsent = allModels && Array.isArray(entry?.assumedZero) ? entry.assumedZero.includes("input_cache_write") : !Object.hasOwn(prices, "input_cache_write") && (!allModels || priceSets.every(p => !Object.hasOwn(p, "input_cache_write")));
   if (writeAbsent) applyNoWriteBasis(tariff);
   for (const key of OPENROUTER_PRICE_KEYS) {
    const required = key === "prompt" || key === "completion";
    let maximum;
    let allAbsent = true;
    for (const variant of priceSets) {
     const absent = !Object.hasOwn(variant, key);
     allAbsent &&= absent;
     if (absent && (required || (!allModels && !allowlisted))) { failures.push(`pricing.${key} missing required field${!allowlisted && !required ? " (not allowlisted)" : ""}`); continue; }
     // Reasoning is NEVER an assumed zero in all-models qualification.
     const value = absent ? allModels && key === "internal_reasoning" ? variant.completion : "0" : variant[key];
     if (allModels && key === "internal_reasoning" && absent) missingReasoning = true;
     try {
      if (typeof value !== "string") throw new Error();
      if (allModels) {
       const amount = rationalPrice(value);
       // Explicit zero rates stay candidates until component billing is proven.
       qualificationWireCap(value, key !== "request");
       if (maximum === undefined || comparePrice(amount, rationalPrice(maximum)) > 0n) maximum = value;
      } else {
       const amount = openRouterDecimal(value);
       if ((required && amount <= 0n) || (key !== "request" && (amount % 1_000_000n !== 0n || amount / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)))) throw new Error();
       const wire = key === "request" ? value : perMillionPrice(value);
       if (!equalMoney(Number(wire), wire)) throw new Error();
       if (maximum === undefined || amount > openRouterDecimal(maximum)) maximum = value;
      }
     } catch { failures.push(fieldValue(key, value)); }
    }
    pricing[key] = maximum;
    if (allAbsent && !required && (!allModels || key !== "internal_reasoning")) tariff.assumedZero.push(key);
   }
   if (allModels && Array.isArray(entry.assumedZero)) tariff.assumedZero = [...entry.assumedZero];
   if (missingReasoning) tariff.reasoningBilledAtCompletion = true;
   for (const variant of priceSets) for (const [key, value] of Object.entries(variant)) {
    if (OPENROUTER_PRICE_KEYS.includes(key) || (allModels && (key === "overrides" || variant !== prices && OVERRIDE_CONDITIONS.includes(key)))) continue;
    if (allModels && key === "discount") {
     // A negative discount is a surcharge; unreadable values never imply zero.
     let zero = value === 0;
     try { zero ||= typeof value === "string" && rationalPrice(value).n === 0n; } catch { /* Refuse below. */ }
     if (!zero) failures.push(`discount_nonzero:${safeRefusalText(String(value))}`);
     continue;
    }
    // Search/media/cache-write inputs are never sent by all-models qualification.
    // Unused rates need no rounding to the token ceiling's integer units.
    let safe = allModels && UNUSED_PRICE_KEYS.includes(key) && typeof value === "string" && nonnegativeMoney(value);
    try {
     if (!allModels) safe = key === "web_search" ? typeof value === "string" && (allowlisted ? openRouterDecimal(value) >= 0n : openRouterDecimal(value) === 0n) :
      ["image", "audio", "input_audio", "output_audio", "input_cache_write_1h"].includes(key) && equalMoney(value, "0");
    } catch { /* Malformed auxiliary prices refuse. */ }
    if (!safe) failures.push(fieldValue(key, value) + (key === "web_search" && !allowlisted && !allModels ? " (not allowlisted)" : ""));
   }
   if (Number.isSafeInteger(entry?.top_provider?.max_completion_tokens) && entry.top_provider.max_completion_tokens <= HARNESS_REASONING_TOKENS) failures.push(CEILING_FLOOR_REASON);
   else if (!Number.isSafeInteger(entry?.top_provider?.max_completion_tokens)) failures.push("max_completion_tokens missing or invalid");
   tariff.pricing = pricing;
   const policy = failures.length === 0 ? qualificationPolicy(model, at, tariff, allModels) : undefined;
   recordCheck(result, "bounded_tariff", policy !== undefined, failures.length > 0 ? failures.join("; ") : "tariff policy refused");
   if (policy === undefined) { result.boundedTariffErrors = failures.length > 0 ? failures : ["tariff policy refused"]; continue; }
   // Candidate rows always carry all six normalized string fields.
   tariff.pricing = { ...policy.pricing };
   result.candidateTariff = tariff;
   // The absent reasoning price uses completion, including the possible separate
   // reasoning maximum outside max_tokens. Never discount a reservation.
   const qualificationHold = (prompt, output) => {
    if (allModels) {
     const p = policy.pricing;
     const components = [[prompt, maxPrice(p.prompt, p.input_cache_read)], [prompt, p.input_cache_write], [output, maxPrice(p.completion, p.internal_reasoning)], [1, p.request]];
     if (missingReasoning) components.push([policy.reasoning.max_tokens, p.completion]);
     return qualificationCostMicros(components);
    }
    const held = openRouterHold(policy, prompt, output);
    const extra = missingReasoning ? Number((BigInt(policy.reasoning.max_tokens) * openRouterDecimal(policy.pricing.completion) + MICRO - 1n) / MICRO) : 0;
    if (!Number.isSafeInteger(held + extra)) throw new Error();
    return held + extra;
   };
   if (prepareOnly) continue;
   // An all-zero tariff has a hold of 0 and no positive price cap to probe, so it would
   // read as "free, unlimited". Refuse it with a clear verdict before anything is sent.
   if (allModels && OPENROUTER_PRICE_KEYS.every(key => rationalPrice(policy.pricing[key] ?? "0").n === 0n)) {
    recordCheck(result, "priced_model", false, "every advertised rate is zero: no hold or price cap can bound or exercise it; not qualified; nothing sent");
    continue;
   }
   // Ruling (a): the REAL row (real bounds, real prices) must pass the gateway's own validator before anything is sent, so a PASS row is
   // installable as-is: price granularity, zero prompt/completion, id shape, reasoning/ceiling. $0. Extended ids (":" or "~") keep today's
   // harness-only handling (ruling (d)); the install selection refuses them.
   if (!extendedId(model) && runtimePolicyOf(tariffRow(tariff, at)) === undefined) {
    recordCheck(result, "runtime_policy", false, "the gateway's own tariff validator (openRouterPolicy) refuses this row as installed: price granularity, zero prompt/completion, id shape or reasoning/ceiling bounds; nothing sent");
    continue;
   }
   result.reasoningProbe = "probe skipped: generation failed";
   let probeBody; let reasoningOffRefused = false; // once a route refuses `enabled: false`, its remaining controls use the gateway reasoning directly
   for (let n = 0; n < 4; n++) {
    // Keep ordinary qualification easy; exercise reasoning in its own capped, fully held call.
    const reasoningProbe = n === 3;
    let maxTokens; let body; let maxPromptTokens; let hold;
    const messages = [{ role: "user", content: reasoningProbe
     ? "Reasoning probe: Use reasoning to solve this problem before answering briefly: How many three-digit positive integers have strictly increasing digits? Explain your reasoning."
     : `Qualification ${n + 1}: What is 2 + 2? Reply with the answer in one short sentence.` }];
    // ONE rung: the row's own ceiling, so every proof is at the size the gateway will hold. If the hold does not fit the caps,
    // reserve() below refuses and nothing is sent. No paid-call retry.
    maxTokens = policy.max_completion_tokens;
    const gatewayBody = qualificationRequest({ model, messages, max_tokens: maxTokens, stream: false }, policy);
    if (gatewayBody === undefined) throw new Error();
    // Owner rule (2026-11-23): the CONTROL probes (the "2 + 2" checks) send reasoning OFF, so they bill a few tokens instead of up to 1024 reasoning tokens; the reasoning
    // probe (n = 3) keeps the gateway's exact bounded-reasoning request. Only the `reasoning` field differs: provider pin, max_price, ceiling and prompt shape are the gateway's.
    // A route that refuses `enabled: false` (HTTP 400, $0) is retried ONCE at the lowest the gateway allows (its own bounded request): see the catch below.
    body = reasoningProbe || reasoningOffRefused ? gatewayBody : { ...gatewayBody, reasoning: { enabled: false } };
    maxPromptTokens = Buffer.byteLength(JSON.stringify(body));
    hold = qualificationHold(maxPromptTokens, maxTokens);
    const searchNotRequested = !Object.keys(body).some(key => /plugins|web|search|tools/iu.test(key));
    // Byte bound includes all messages and control fields; no tools, plugins, search, media or cache directives.
    if (!reserve(result, hold)) break;
    if (reasoningProbe) { result.reasoningProbe = "FAIL"; result.reasoningProbeReason = "reasoning call failed; see call checks and reasons"; }
    const call = { attempt: n + 1, holdMicros: hold, maxPromptTokens, requestControls: { max_tokens: body.max_tokens, reasoning: body.reasoning, provider: body.provider }, checks: {}, reasons: {} }; result.calls.push(call);
    let charged = 0;
    const retainDebit = data => {
     const u = data?.usage;
     const debit = Math.max(nonnegativeMoney(u?.cost) ? micros(u.cost) : 0, nonnegativeMoney(u?.cost_details?.upstream_inference_cost) ? micros(u.cost_details.upstream_inference_cost) : 0);
     if (!Number.isSafeInteger(debit)) throw new Error();
     report.chargedMicros += debit; expose(Math.max(0, debit - hold)); charged = debit;
     if (overCap()) { stop = true; if (budget && budget.exposure > budget.cap) budget.stop = "overall_cap"; }
    };
    let answer;
    try { answer = await json("chat/completions", body, retainDebit); }
    catch (error) {
     // A refused `enabled: false` is a $0 HTTP 400 (reasoning mandatory on this route): fall back ONCE to the gateway's own request, the lowest reasoning it allows.
     if (body === gatewayBody || stop || !(error instanceof EvidenceError) || error.message !== "http 400") { recordCheck(call, "response", false, evidenceReason(error)); break; }
     reasoningOffRefused = true; body = gatewayBody; maxPromptTokens = Buffer.byteLength(JSON.stringify(body)); hold = qualificationHold(maxPromptTokens, maxTokens);
     if (!reserve(result, hold)) { recordCheck(call, "response", false, "reasoning off refused (HTTP 400); the gateway-reasoning retry hold does not fit the caps"); break; }
     call.holdMicros = hold; call.maxPromptTokens = maxPromptTokens; call.requestControls = { max_tokens: body.max_tokens, reasoning: body.reasoning, provider: body.provider }; call.reasoningOffRefused = true;
     try { answer = await json("chat/completions", body, retainDebit); }
     catch (retryError) { recordCheck(call, "response", false, evidenceReason(retryError)); break; }
    }
    const content = answer.choices?.length === 1 ? answer.choices[0]?.message?.content : undefined;
    recordCheck(call, "visible_text", typeof content === "string" && content.trim().length > 0, "choices[0].message.content expected nonempty text from exactly one choice");
    const u = answer.usage;
    const readable = nonnegativeMoney(u?.cost) && nonnegativeMoney(u?.cost_details?.upstream_inference_cost);
    const detailKeys = u?.cost_details && typeof u.cost_details === "object" && !Array.isArray(u.cost_details) ? Object.keys(u.cost_details) : [];
    const unrecognizedDetailKeys = detailKeys.filter(key => !INFERENCE_DETAIL_KEYS.includes(key));
    const detailsBounded = detailKeys.includes("upstream_inference_cost") && unrecognizedDetailKeys.length === 0 && consistentInferenceBreakdown(u.cost_details);
    // Independently retain every readable debit, even when another field is malformed.
    retainDebit(answer);
    call.responseModel = validModel(answer.model) && !containsCredential(answer.model, env.OPENROUTER_API_KEY) ? answer.model : "[invalid]";
    call.usage = { prompt_tokens: safeCount(u?.prompt_tokens), completion_tokens: safeCount(u?.completion_tokens), reasoning_tokens: safeCount(u?.completion_tokens_details?.reasoning_tokens), cache_write_tokens: safeCount(u?.prompt_tokens_details?.cache_write_tokens), cached_tokens: safeCount(u?.prompt_tokens_details?.cached_tokens), cost: safeMoney(u?.cost), cost_details: { upstream_inference_cost: safeMoney(u?.cost_details?.upstream_inference_cost), ...Object.fromEntries(INFERENCE_BREAKDOWN_KEYS.filter(key => detailKeys.includes(key)).map(key => [key, safeMoney(u.cost_details[key])])), unrecognized_component_count: unrecognizedDetailKeys.length, unrecognized_components: unrecognizedDetailKeys.map(safeField) } };
    let generation;
    try { generation = await generationLookup(answer.id); }
    catch (error) { recordCheck(call, "generation", false, evidenceReason(error)); break; }
    // Keep necessary numeric/bool evidence and a bounded safe model ID, never arbitrary provider text.
    const g = generation ?? {};
    const observed = Math.max(charged, nonnegativeMoney(g.total_cost) ? micros(g.total_cost) : 0);
    if (!Number.isSafeInteger(observed)) throw new Error();
    report.chargedMicros += observed - charged; expose(Math.max(0, observed - Math.max(charged, hold))); charged = observed;
    const safeModel = validModel(g.model) && !containsCredential(g.model, env.OPENROUTER_API_KEY) ? g.model : "[invalid]";
    call.generation = { model: safeModel, native_tokens_prompt: safeCount(g.native_tokens_prompt), native_tokens_completion: safeCount(g.native_tokens_completion), native_tokens_reasoning: safeCount(g.native_tokens_reasoning), native_tokens_cached: safeCount(g.native_tokens_cached), total_cost: safeMoney(g.total_cost), is_byok: typeof g.is_byok === "boolean" ? g.is_byok : null };
    // Retain any readable generation debit BEFORE refusing incomplete evidence.
    const missing = ["native_tokens_prompt", "native_tokens_completion", "native_tokens_reasoning", "native_tokens_cached", "total_cost", "model", "provider_name", "is_byok"].find(field => !Object.hasOwn(g, field));
    if (missing) { recordCheck(call, "generation", false, `missing field ${missing}`); break; }
    const check = (name, ok, reason) => recordCheck(call, name, ok, reason);
    const tokenFailures = (...fields) => fields.map(([field, value, min, max]) => tokenReason(field, value, min, max)).filter(Boolean).join("; ");
    const moneyEvidence = `usage.cost ${safeValue(u?.cost)}, upstream_inference_cost ${safeValue(u?.cost_details?.upstream_inference_cost)}, generation.total_cost ${safeValue(g.total_cost)}`;
    const totalOutput = g.native_tokens_completion;
    check("visible_generation", count(g.native_tokens_completion) && g.native_tokens_completion > 0, tokenReason("native_tokens_completion", g.native_tokens_completion, 1, Number.MAX_SAFE_INTEGER));
    check("completion_plus_reasoning_within_limit", count(totalOutput) && totalOutput <= maxTokens && count(u?.completion_tokens) && u.completion_tokens <= maxTokens, tokenFailures(["native_tokens_completion", totalOutput, 0, maxTokens], ["usage.completion_tokens", u?.completion_tokens, 0, maxTokens]));
    const usageReasoning = u?.completion_tokens_details?.reasoning_tokens;
    check("reasoning_readable", count(g.native_tokens_reasoning) && count(usageReasoning), tokenFailures(["native_tokens_reasoning", g.native_tokens_reasoning, 0, Number.MAX_SAFE_INTEGER], ["usage.completion_tokens_details.reasoning_tokens", usageReasoning, 0, Number.MAX_SAFE_INTEGER]));
    const requestedReasoningCap = body.reasoning.max_tokens ?? policy.reasoning.max_tokens;
    if (count(g.native_tokens_reasoning) && count(usageReasoning) && (g.native_tokens_reasoning > requestedReasoningCap || usageReasoning > requestedReasoningCap)) {
     call.reasoningOverCap = { requestedMaxTokens: requestedReasoningCap, usageTokens: usageReasoning, generationTokens: g.native_tokens_reasoning };
     process.stderr.write(`OpenRouter reasoning above requested cap ${requestedReasoningCap}: usage ${safeValue(usageReasoning)}, generation ${safeValue(g.native_tokens_reasoning)}\n`);
    }
    if (reasoningProbe) check("high_reasoning_exercised", count(g.native_tokens_reasoning) && g.native_tokens_reasoning > 0 && count(usageReasoning) && usageReasoning > 0, tokenFailures(["native_tokens_reasoning", g.native_tokens_reasoning, 1, Number.MAX_SAFE_INTEGER], ["usage.completion_tokens_details.reasoning_tokens", usageReasoning, 1, Number.MAX_SAFE_INTEGER]));
    check("prompt_within_hold", count(g.native_tokens_prompt) && g.native_tokens_prompt <= maxPromptTokens && count(u?.prompt_tokens) && u.prompt_tokens <= maxPromptTokens, tokenFailures(["native_tokens_prompt", g.native_tokens_prompt, 0, maxPromptTokens], ["usage.prompt_tokens", u?.prompt_tokens, 0, maxPromptTokens]));
    check("usage_cost_within_hold", readable && charged <= hold, `${moneyEvidence}; expected readable costs and charged ${charged} <= hold ${hold} micros`);
    check("total_cost_matches_usage_cost", readable && nonnegativeMoney(g.total_cost) && equalMoney(g.total_cost, u.cost), `${moneyEvidence}; expected readable equal total_cost and usage.cost`);
    check("identity_and_non_byok", observedModel(model, answer.model, at) !== undefined && observedModel(model, g.model, at) !== undefined && g.provider_name === providerName && g.is_byok === false, [observedModel(model, answer.model, at) === undefined ? "answer.model expected requested model" : "", observedModel(model, g.model, at) === undefined ? "generation.model expected requested model" : "", g.provider_name !== providerName ? "generation.provider_name expected pinned provider" : "", g.is_byok !== false ? `generation.is_byok ${safeValue(g.is_byok)} expected false` : ""].filter(Boolean).join("; "));
    const auxiliaryClear = noAuxiliaryEvidence(u, "usage", searchNotRequested) && noAuxiliaryEvidence(g, "generation", searchNotRequested);
    const computedMax = maximumInferenceCost(policy, u, g);
    const hiddenCharge = allModels && computedMax !== undefined && [u?.cost, u?.cost_details?.upstream_inference_cost, g.total_cost].some(value => nonnegativeMoney(value) && openRouterDecimal(String(value)) > computedMax);
    if (hiddenCharge) recordCheck(result, "hidden_charge", false, "reported charge exceeds token-computed maximum; hold retained; model stopped");
    if (allModels) check("token_max_within_hold", computedMax !== undefined && computedMax <= BigInt(hold) * MICRO, "token-computed maximum must fit the original hold");
    const tokenEvidence = `usage/native prompt ${safeValue(u?.prompt_tokens)}/${safeValue(g.native_tokens_prompt)}, completion ${safeValue(u?.completion_tokens)}/${safeValue(g.native_tokens_completion)}; native reasoning ${safeValue(g.native_tokens_reasoning)}, usage reasoning ${safeValue(u?.completion_tokens_details?.reasoning_tokens)}, cached ${safeValue(u?.prompt_tokens_details?.cached_tokens ?? 0)}/${safeValue(g.native_tokens_cached)}`;
    const expectedCost = computedMax === undefined ? "unavailable: invalid token counts" : `${computedMax / (10n ** 18n)}.${(computedMax % (10n ** 18n)).toString().padStart(18, "0")} USD`;
    const boundedReason = `${moneyEvidence}; expected equal positive aggregate/usage/generation costs <= computed maximum ${expectedCost}; ${tokenEvidence}`;
    const auxiliaryReason = (value, path) => {
     if (value === null || typeof value !== "object") return undefined;
     for (const [key, child] of Object.entries(value)) {
      const name = `${path}.${key}`;
      if (["usage.cost", "usage.cost_details.upstream_inference_cost", ...INFERENCE_BREAKDOWN_KEYS.map(key => `usage.cost_details.${key}`), "generation.total_cost"].includes(name)) continue;
      if (name === "generation.web_search_engine" && !unrequestedSearchNull(name, child, searchNotRequested)) return "generation.web_search_engine expected null on a search-free request";
      if (unrequestedSearchNull(name, child, searchNotRequested)) continue;
      if (/(?:cost|fee|search|cache_write|cache_creation)/iu.test(key) && key !== "cost_details") {
       if (!equalMoney(child, "0")) return `${path.split(".").map(safeField).join(".")}.${safeField(key)} ${safeValue(child)} expected readable zero`;
      } else {
       const reason = auxiliaryReason(child, name);
       if (reason) return reason;
      }
     }
    };
    const auxiliaryFailure = auxiliaryClear ? "no reported auxiliary charge" : auxiliaryReason(u, "usage") ?? auxiliaryReason(g, "generation");
    const detailReason = !detailsBounded ? `usage.cost_details ${INFERENCE_DETAIL_KEYS.map(key => `${key} ${safeValue(u?.cost_details?.[key])}`).join(", ")}; expected readable nonnegative breakdown parts summing to aggregate within 0.000001 USD; unknown fields ${unrecognizedDetailKeys.map(safeField).join(", ") || "none"}` : !auxiliaryClear ? auxiliaryFailure : boundedReason;
    const reconciled = readable && computedMax !== undefined && nonnegativeMoney(g.total_cost) && equalMoney(u.cost, u.cost_details.upstream_inference_cost) && equalMoney(u.cost, g.total_cost) && openRouterDecimal(String(u.cost)) > 0n && openRouterDecimal(String(u.cost)) <= computedMax;
    check("cost_details_covered", detailsBounded && auxiliaryClear && reconciled, detailReason);
    check("bounded_inference_cost", reconciled, boundedReason);
    check("no_reported_auxiliary_charge", auxiliaryClear, auxiliaryFailure);
    const providerBound = reconciled && g.provider_name === providerName;
    check("observed_cost_within_caps", providerBound, `${boundedReason}; generation.provider_name expected pinned provider`);
    // No REPORTED auxiliary charge, bounded inference money and the original hold.
    // This is evidence for these calls, not a promise about future route billing.
    check("no_web_search_cost", detailsBounded && auxiliaryClear && reconciled && providerBound && charged <= hold, `${detailReason}; charged ${charged} expected within computed maximum and hold ${hold} micros`);
    const totalExposure = budget ? budget.exposure : exposure;
    check("spend_cap", totalExposure <= report.spendCapMicros, `exposure ${totalExposure} > spend cap ${report.spendCapMicros} micros`);
    if (budget) check("per_model_cap", budget.modelExposure <= budget.modelCap, `model exposure ${budget.modelExposure} > per-model cap ${budget.modelCap} micros`);
    if (reasoningProbe && Object.values(call.checks).every(v => v === "PASS")) { result.reasoningProbe = "PASS"; delete result.reasoningProbeReason; }
    if (Object.values(call.checks).some(v => v !== "PASS")) {
     // A model-local failure must not hide the next model. Unknown calls retain
     // their full hold in exposure; only a shared auth/credential/cap failure stops all.
     if (overCap()) { stop = true; if (budget && budget.exposure > budget.cap) budget.stop = "overall_cap"; }
     break;
    }
    // Retain only a fully successful same-run control, including its exact routing.
    probeBody ??= body;
   }
   if (result.calls.length < 4 && result.checks.spend_cap === "FAIL") result.reasoningProbe = "probe skipped: spend cap exceeded";
   if (probeBody !== undefined && result.calls.length === 4 && Object.values(result.checks).every(v => v === "PASS") && result.calls.every(c => Object.values(c.checks).every(v => v === "PASS"))) {
    // Controlled refusal probes: only the selected positive price cap changes to zero.
    // Every attempted probe reserves its full original hold, even an expected refusal.
    result.priceCapProbes = [];
    for (const [component, cap] of Object.entries(probeBody.provider.max_price)) {
     if (stop) break;
     if (!(cap > 0)) continue;
     const hold = qualificationHold(Buffer.byteLength(JSON.stringify(probeBody)), probeBody.max_tokens);
     if (!reserve(result, hold)) break;
     const probe = { component, holdMicros: hold, status: "FAIL", reason: "price-cap probe evidence unavailable" }; result.priceCapProbes.push(probe);
     try {
      const body = { ...probeBody, provider: { ...probeBody.provider, max_price: { ...probeBody.provider.max_price, [component]: 0 } } };
      const response = await request("https://openrouter.ai/api/v1/chat/completions", { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      probe.httpStatus = response.status;
      if ([401, 403].includes(response.status)) { stop = true; if (budget) budget.stop = "authentication"; }
      const raw = await response.text(); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
      const data = JSON.parse(raw);
      if (data?.error !== null && typeof data?.error === "object") probe.error = Object.fromEntries(["code", "message"].filter(key => Object.hasOwn(data.error, key)).map(key => [key, safeRefusalText(data.error[key])]));
      const debit = Math.max(nonnegativeMoney(data?.usage?.cost) ? micros(data.usage.cost) : 0, nonnegativeMoney(data?.usage?.cost_details?.upstream_inference_cost) ? micros(data.usage.cost_details.upstream_inference_cost) : 0);
      if (!Number.isSafeInteger(debit)) throw new Error();
      report.chargedMicros += debit; expose(Math.max(0, debit - hold));
      probe.chargedMicros = debit;
      if (data.id !== undefined) {
       const generation = await generationLookup(data.id);
       if (nonnegativeMoney(generation?.total_cost)) {
        const actual = Math.max(debit, micros(generation.total_cost));
        report.chargedMicros += actual - debit; expose(Math.max(0, actual - Math.max(debit, hold))); probe.chargedMicros = actual;
       }
       if (allModels) {
        const maximum = maximumInferenceCost(policy, data.usage, generation);
        if (maximum !== undefined && [data.usage?.cost, data.usage?.cost_details?.upstream_inference_cost, generation.total_cost].some(value => nonnegativeMoney(value) && openRouterDecimal(String(value)) > maximum)) {
         recordCheck(result, "hidden_charge", false, "reported probe charge exceeds token-computed maximum; hold retained; model stopped");
        }
        if (maximum === undefined || maximum > BigInt(hold) * MICRO) recordCheck(result, "token_max_within_hold", false, "probe token maximum must fit original hold");
       }
      }
      const priceRefusal = typeof data?.error?.message === "string" && /^\s*No endpoints found that satisfy the max price for this request\.?\s*$/iu.test(data.error.message);
      if (!response.ok && [400, 404, 422].includes(response.status) && priceRefusal && data.id === undefined && data.usage === undefined && debit === 0) { probe.status = "PASS"; probe.reason = "recognized price-cap refusal against successful same-run control; no id/usage and zero debit"; }
      else probe.reason = `http ${response.status}; expected price-cap refusal (400/404/422), recognized refusal message, no id/usage and zero debit; observed debit ${probe.chargedMicros} micros`;
     } catch (error) { probe.reason = evidenceReason(error); }
     if (overCap()) { stop = true; if (budget && budget.exposure > budget.cap) budget.stop = "overall_cap"; }
     if (result.checks.hidden_charge === "FAIL") break;
    }
    recordCheck(result, "provider_honoured_max_price", !stop && result.priceCapProbes.length >= 2 && result.priceCapProbes.every(p => p.status === "PASS"), "expected at least two passing price-cap refusal probes and no shared stop; see priceCapProbes reasons");
    if (result.checks.provider_honoured_max_price === "PASS" && Object.values(result.checks).every(v => v === "PASS")) { result.status = "PASS"; result.candidateTariff = tariffEvidence(tariff, result); report.proposedTariffRows.push(result.candidateTariff); }
   }
  }
  if (report.models.length === models.length && report.models.every(m => m.status === "PASS")) report.status = "PASS";
 } catch { report.errors.push("Qualification refused or HTTP evidence unavailable; no tariff may be installed."); }
 report.exposureMicros = exposure;
 return report;
}
// The exact harness, policy and token validation form the resume version. Any guard change
// invalidates old passes; no owner-supplied version can bypass requalification.
const harnessVersion = () => createHash("sha256")
 .update(readFileSync(new URL(import.meta.url)))
 .update(readFileSync(new URL("../packages/model-gateway/dist/openrouter-policy.js", import.meta.url)))
 .update(readFileSync(new URL("../packages/model-gateway/dist/offered-models.js", import.meta.url)))
 .update(readFileSync(new URL("../packages/model-gateway/dist/model-gateway-token.js", import.meta.url))).digest("hex");
const validModel = model => typeof model === "string" && model.length <= 128 && /^[A-Za-z0-9~][A-Za-z0-9._~-]*\/[A-Za-z0-9~][A-Za-z0-9._~-]*(?::thinking)?$/u.test(model) && !model.startsWith("openrouter/");
// Harness-only ID validation. The exact catalogue match above remains mandatory.
// For extended IDs, reuse the gateway's tariff/body guards with a local placeholder
// that is outside its relaxed-price allowlist. Restore the exact ID before hashing,
// reporting or sending; the placeholder never leaves this validation boundary.
const qualificationModel = model => /[~:]/u.test(model) ? "qualification/catalogue-model" : model;
const extendedId = model => /[~:]/u.test(model);
const STRIPPED_ROW_FIELDS = ["model", "route", "pricing", "max_completion_tokens", "reasoning", "verifiedAt", "expiresAt", "evidence", "cacheWriteBasis", "cacheWriteEnforcementVersion"];
/** The row exactly as the gateway's tariff source would hold it (no harness-only evidence fields). */
const strippedRow = row => Object.fromEntries(STRIPPED_ROW_FIELDS.filter(key => Object.hasOwn(row, key) && row[key] !== undefined).map(key => [key, key === "pricing" || key === "reasoning" ? { ...row[key] } : row[key]]));
/** The gateway's OWN validator over the real row at the instant just after it was verified. */
const runtimePolicyOf = row => { try { return openRouterPolicy(row.model, row.verifiedAt + 1, [strippedRow(row)]); } catch { return undefined; } };
const tariffRow = (tariff, at) => ({ ...tariff, verifiedAt: at, expiresAt: at + 86_400_000 });
const qualificationPolicy = (model, now, tariff, exactPricing = false) => {
 if (!validModel(model) || tariff.model !== model) return undefined;
 // Real bounds always (no placeholder bounds). Placeholders remain only for finer-than-micro rationals (exactPricing, harness-only qualification
 // arithmetic) and for extended ids; a non-extended row is separately proven installable by the runtime_policy check.
 const checked = openRouterPolicy(qualificationModel(model), now, [{ ...tariff, model: qualificationModel(model), ...(exactPricing ? { pricing: validationPrices } : {}) }]);
 if (!checked) return undefined;
 const value = { ...checked, model, max_completion_tokens: tariff.max_completion_tokens, reasoning: tariff.reasoning, ...(exactPricing ? { pricing: { ...tariff.pricing }, exactPricing: true } : {}) };
 delete value.hash;
 return { ...value, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
};
const qualificationRequest = (body, policy) => {
 if (!validModel(body.model) || body.model !== policy.model) return undefined;
 // A non-extended id is sent EXACTLY as the gateway sends it: the runtime's own request builder, real prices and real max_price.
 if (!extendedId(body.model)) return openRouterRequest(body, policy);
 const model = qualificationModel(body.model);
 const checked = openRouterRequest({ ...body, model }, { ...policy, model, ...(policy.exactPricing ? { pricing: validationPrices } : {}) });
 if (!checked) return undefined;
 const provider = { ...checked.provider };
 if (policy.exactPricing) {
  const p = policy.pricing;
  provider.max_price = { prompt: qualificationWireCap(p.prompt, true), completion: qualificationWireCap(maxPrice(p.completion, p.internal_reasoning), true), request: qualificationWireCap(p.request, false) };
 }
 return { ...checked, model: body.model, provider };
};
const validRoute = route => typeof route === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(route);
const capMicros = value => {
 const amount = openRouterDecimal(value);
 if (amount < MICRO || amount % MICRO !== 0n || amount / MICRO > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
 return Number(amount / MICRO);
};
// Proof uses an isolated, exercised component in a real successful bill. A zero catalogue rate or an unused
// component alone is never proof, and a component the catalogue left ABSENT (assumedZero) is never an explicit
// price, so it is never proven here (ruling (e)). Prompt/completion zero is unreachable: the gateway's validator
// refuses a zero prompt or completion rate, so such a row never passes the runtime_policy check.
/** A cost part named for a cache write (the gateway's cacheWriteCostReported uses the same pattern): recorded per call as an unrecognized cost component. */
const CACHE_WRITE_NAME = /cache[_-]?(write|creat)/iu;
const cacheWriteCostParts = usage => Array.isArray(usage?.cost_details?.unrecognized_components) ? usage.cost_details.unrecognized_components.filter(name => typeof name === "string" && CACHE_WRITE_NAME.test(name)).length : 0;
/** THE ONE PLACE the zero-proof exceptions live (widen the rule here, nowhere else). */
export const ZERO_PROOF_RULES = {
 // Absent-from-the-catalogue components that the billed-bill proof below may still prove. ONLY `request` (controller ruling Q-B): an absent
 // request price counts as zero because EVERY gateway call sends max_price.request = 0 together with the pinned order + only and allow_fallbacks
 // false (openRouterRequest), so an endpoint with a request fee cannot be used; the proof below also requires that pin on every recorded call.
 // Never widen this to a component the gateway does not cap on the wire.
 assumedMayBeProven: ["request"],
 // Runtime no-cache-write enforcement counts as the input_cache_write proof for ANY model (owner rule 2026-11-23), with the current
 // enforcement version, an ABSENT catalogue write price (the only case the harness sets the basis) and ZERO reported writes on every call:
 // no cache-write tokens AND no cost part named for a write. The gateway never sends cache hints (hasCachingHint); on any reported write it stops the
 // call, settles at max(hold, reported cost, token cost with the write rated at the highest listed price) and latches the source stop (cacheWritesForbidden,
 // openRouterRates, source-stop.ts). An EXPLICIT zero write price has no basis and no assumedZero entry, so it is never proven. A missing READ price stays refused.
 cacheWriteRuntimeEnforced: (tariff, calls) => tariff.cacheWriteBasis === "never_requested_enforced" && tariff.cacheWriteEnforcementVersion === OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION &&
  (tariff.assumedZero ?? []).includes("input_cache_write") && calls.length > 0 && calls.every(call => call.usage?.cache_write_tokens === 0 && cacheWriteCostParts(call.usage) === 0),
};
/** The request the harness sent (the gateway's own) pinned the proven endpoint with no fallback and capped the request fee at zero on the wire. */
const requestWirePinned = call => {
 const provider = call.requestControls?.provider;
 return provider?.max_price?.request === 0 && Array.isArray(provider.order) && provider.order.length === 1 && Array.isArray(provider.only) && provider.only.length === 1 &&
  provider.order[0] === provider.only[0] && provider.allow_fallbacks === false;
};
const exactDecimal = value => { try { return openRouterDecimal(String(value)); } catch { return undefined; } };
/** The bill reconstructs EXACTLY (zero tolerance): total == upstream == generation == prompt part + completions part, so no request fee (or any
 * other component) was billed. The +-1 micro tolerance of consistentInferenceBreakdown is deliberately NOT used here. */
const zeroResidualBill = call => {
 const u = call.usage, g = call.generation, d = u?.cost_details;
 if (!d || d.unrecognized_component_count !== 0) return false;
 const [cost, upstream, prompt, completions, total] = [u.cost, d.upstream_inference_cost, d.upstream_inference_prompt_cost, d.upstream_inference_completions_cost, g?.total_cost].map(value => value === null || value === undefined ? undefined : exactDecimal(value));
 return [cost, upstream, prompt, completions, total].every(value => value !== undefined) && cost === upstream && cost === total && cost === prompt + completions;
};
const tariffEvidence = (tariff, result) => {
 const zeroPriceProof = {};
 const observedModelIds = new Set();
 const assumed = (tariff.assumedZero ?? []).filter(key => !ZERO_PROOF_RULES.assumedMayBeProven.includes(key));
 // Both callers publish evidence only after every call/check passes.
 for (const call of result.calls) {
  for (const actual of [call.responseModel, call.generation?.model]) {
   const id = observedModel(tariff.model, actual, tariff.verifiedAt);
   if (id !== undefined) observedModelIds.add(id);
  }
  const u = call.usage, g = call.generation;
  const details = u?.cost_details;
  if (!details || details.unrecognized_component_count !== 0 || !consistentInferenceBreakdown(details)) continue;
  const proof = (component, source, exercised, billed) => {
   if (assumed.includes(component) || rationalPrice(tariff.pricing[component]).n !== 0n || !exercised || !nonnegativeMoney(billed) || !equalMoney(billed, "0")) return;
   zeroPriceProof[component] ??= { attempt: call.attempt, source, billed, model: g.model, totalCost: g.total_cost };
  };
  const prompt = u.prompt_tokens, cached = u.cached_tokens;
  const output = u.completion_tokens, reasoning = u.reasoning_tokens;
  proof("input_cache_read", "usage.cost_details.upstream_inference_prompt_cost", cached > 0 && cached === prompt && g.native_tokens_cached === cached && g.native_tokens_prompt === prompt, details.upstream_inference_prompt_cost);
  proof("internal_reasoning", "usage.cost_details.upstream_inference_completions_cost", reasoning > 0 && reasoning === output && g.native_tokens_completion === output && g.native_tokens_reasoning === reasoning, details.upstream_inference_completions_cost);
 }
 const first = result.calls[0];
 // request: explicit zero, proven only when EVERY call's bill reconstructs with zero residual.
 if (rationalPrice(tariff.pricing.request).n === 0n && !assumed.includes("request") && result.calls.length > 0 && result.calls.every(call => zeroResidualBill(call) && requestWirePinned(call))) {
  zeroPriceProof.request = { attempt: first.attempt, source: "usage.cost == upstream_inference_cost == generation.total_cost == prompt part + completions part on every call (zero residual)", billed: "0", model: first.generation.model, totalCost: first.generation.total_cost };
 }
 // input_cache_write: never exercised by this harness; only the ONE runtime-enforcement rule above can stand in for it.
 if (rationalPrice(tariff.pricing.input_cache_write).n === 0n && ZERO_PROOF_RULES.cacheWriteRuntimeEnforced(tariff, result.calls)) {
  zeroPriceProof.input_cache_write = { attempt: first.attempt, source: `runtime_enforced:${OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION}`, billed: "0", model: first.generation.model, totalCost: first.generation.total_cost };
 }
 const zeroes = OPENROUTER_PRICE_KEYS.filter(key => rationalPrice(tariff.pricing[key]).n === 0n);
 // PROVEN describes billing evidence only. Installation still requires review.
 const status = zeroes.every(key => Object.hasOwn(zeroPriceProof, key)) ? "PROVEN" : "CANDIDATE";
 return { ...tariff, status, observedModelIds: [...observedModelIds].sort(), zeroPriceProof };
};
const tariffKey = tariff => {
 return Object.fromEntries(Object.entries(tariff).filter(([key]) => !["verifiedAt", "expiresAt", "evidence", "status", "observedModelIds", "zeroPriceProof"].includes(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
};
const signature = rows => createHash("sha256").update(JSON.stringify(rows.map(tariffKey))).digest("hex");
// A ceiling at or below the bounded-reasoning floor is its own cause; any other tariff problem stays unpriced_component.
const tariffCause = text => typeof text === "string" && text.length > 0 && text.split("; ").every(part => part === CEILING_FLOOR_REASON) ? "ceiling_below_runtime_floor" : "unpriced_component";
const failureCause = result => {
 if (result.checks.hidden_charge === "FAIL") return "hidden_charge";
 if (result.checks.spend_cap === "FAIL") return "overall_cap";
 if (result.checks.per_model_cap === "FAIL") return "per_model_cap";
 if (result.checks.bounded_tariff === "FAIL") return tariffCause(result.reasons.bounded_tariff);
 if (result.checks.priced_model === "FAIL") return "zero_priced";
 if (result.checks.runtime_policy === "FAIL") return "runtime_policy_refused";
 if (result.calls.some(call => call.checks.identity_and_non_byok === "FAIL")) return "identity_mismatch";
 if (result.calls.some(call => call.checks.generation === "FAIL")) return "generation_lookup";
 if (result.checks.provider_honoured_max_price === "FAIL") return "price_cap_refusal";
 return "qualification_checks";
};
/** Install selection (rulings (c), (d), (e); pure, no network or env; data only, nothing is installed). The first failing reason wins per row:
 * extended_id (":" or "~": refused, unchanged), offer_name (the id cannot be offered: OFFERED_MODEL_NAME), unproven_zero:<keys> (a zero component
 * without proof: only PROVEN rows), runtime_policy_refused (the gateway's own validator refuses the stripped row). A model with two or more
 * surviving routes is NEVER refused: the route is chosen DETERMINISTICALLY by the first difference in this ascending key
 *   (1) openRouterHold at REFERENCE_PROMPT_TOKENS and ONE common output size = the smallest ceiling among the surviving routes (price, not ceiling),
 *   (2) the dearer of completion / internal_reasoning price, (3) prompt price, (4) lower max_completion_tokens (stricter), (5) route tag by code-point order.
 * Then, over OFFERED_MODELS_MAX (64) chosen rows: openRouterCapOrder (family rank openai, anthropic, google, mistralai, meta-llama, deepseek, qwen, then the rest; then the cheapest
 * hold; then the same keys) keeps the first 64 in that order and refuses the others `over_cap`.
 */
const installRefusal = row => {
 if (row === null || typeof row !== "object" || typeof row.model !== "string" || typeof row.route !== "string") return "runtime_policy_refused";
 if (extendedId(row.model)) return "extended_id";
 if (!OFFERED_MODEL_NAME.test(row.model)) return "offer_name";
 const unproven = OPENROUTER_PRICE_KEYS.filter(key => { try { return rationalPrice(row.pricing?.[key]).n === 0n && !Object.hasOwn(row.zeroPriceProof ?? {}, key); } catch { return true; } });
 if (row.status !== "PROVEN" || unproven.length > 0) return `unproven_zero:${unproven.join(",")}`;
 if (runtimePolicyOf(row) === undefined) return "runtime_policy_refused";
 return undefined;
};
export const selectInstallRows = rows => {
 const installable = []; const refused = []; const surviving = new Map();
 for (const row of Array.isArray(rows) ? rows : []) {
  const reason = installRefusal(row);
  if (reason !== undefined) { refused.push({ model: row?.model, route: row?.route, reason }); continue; }
  if (!surviving.has(row.model)) surviving.set(row.model, []);
  surviving.get(row.model).push(row);
 }
 for (const [model, group] of surviving) {
  const size = Math.min(...group.map(row => row.max_completion_tokens));
  const keyOf = row => {
   const policy = runtimePolicyOf(row);
   return [BigInt(openRouterHold(policy, REFERENCE_PROMPT_TOKENS, size)), openRouterDecimal(maxPrice(policy.pricing.completion, policy.pricing.internal_reasoning)), openRouterDecimal(policy.pricing.prompt), BigInt(row.max_completion_tokens), row.route];
  };
  const keyed = group.map(row => ({ row, key: keyOf(row) }));
  keyed.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1; return 0; });
  installable.push(strippedRow(keyed[0].row));
  for (const { row } of keyed.slice(1)) refused.push({ model, route: row.route, reason: "route_not_chosen" });
 }
 installable.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
 // DEC 254zzz419: never more than OFFERED_MODELS_MAX rows. Over it: the best-known families first, then the cheapest hold (the gateway's openRouterCapOrder, the
 // same order the offered list uses); the kept rows stay in that order, the rest are refused `over_cap`. At or under the cap nothing changes.
 if (installable.length > OFFERED_MODELS_MAX) {
  const byModel = new Map(installable.map(row => [row.model, row]));
  const { kept, dropped } = openRouterCapOrder(installable.map(runtimePolicyOf), OFFERED_MODELS_MAX);
  for (const policy of dropped) refused.push({ model: policy.model, route: policy.route, reason: "over_cap" });
  return { installable: kept.map(policy => byModel.get(policy.model)), refused };
 }
 return { installable, refused };
};
/** Catalogue-wide orchestration shares the existing checks, holds and debit handling.
 * No remote catalogue URL or credential source is accepted from the command line.
 */
async function qualifyAll(options, capturedCatalogue) {
 const { fetch: request = globalThis.fetch, env = process.env } = options;
 const report = { status: "FAIL", harnessVersion: harnessVersion(), chargedMicros: 0, preCallHoldsMicros: 0, exposureMicros: 0, spendCapMicros: 0, perModelCapMicros: 0, models: [], notReached: [], failuresByCause: {}, proposedTariffRows: [], installSelection: { installable: [], refused: [] }, errors: [] };
 const budget = { exposure: 0, modelExposure: 0, cap: 0, modelCap: 0, stop: undefined };
 let entries = [];
 const plans = []; // models that can reach a paid call, spent on cheapest first
 let inFlight; // the plan being spent on in phase 2 (an unexpected error marks it and every later plan not reached)
 const key = env.OPENROUTER_API_KEY;
 const safe = value => typeof value === "string" && !containsCredential(value, key);
 const fail = (model, cause, reason) => {
  model.causes ??= [];
  if (!model.causes.includes(cause)) model.causes.push(cause);
  model.reason = model.reason ? `${model.reason}; ${reason}` : reason;
 };
 const get = async path => {
  // Supplied discovery snapshots replace catalogue lookups; missing evidence
  // refuses locally rather than silently fetching a newer catalogue.
  if (options.catalogue !== undefined) {
   const supplied = options.catalogue;
   const id = path.slice("models/".length, -"/endpoints".length);
   const body = path === "models" ? supplied?.models : Object.hasOwn(supplied?.endpoints ?? {}, id) ? supplied.endpoints[id] : undefined;
   const status = supplied?.statuses?.[path] ?? 200;
   if ([401, 403].includes(status)) budget.stop = "authentication";
   if (body === undefined || status < 200 || status >= 300) throw new Error();
   return body;
  }
  const url = `https://openrouter.ai/api/v1/${path}`;
  if (!safe(url)) { budget.stop = "credential"; throw new Error(); }
  const response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
  if ([401, 403].includes(response.status)) budget.stop = "authentication";
  const bytes = await response.text();
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error();
  const body = JSON.parse(bytes);
  if (capturedCatalogue) {
   // Only response JSON enters the snapshot, never Request/init/headers.
   if (path === "models") capturedCatalogue.models = body;
   else capturedCatalogue.endpoints[path.slice("models/".length, -"/endpoints".length)] = body;
   if (!response.ok) { capturedCatalogue.statuses ??= {}; capturedCatalogue.statuses[path] = response.status; }
  }
  if (!response.ok) throw new Error();
  return body;
 };
 const prepare = async (entry, route, name) => {
  const prepared = await qualifyModels({ ...options, models: [entry.id], provider: route, providerName: name, catalogue: { data: [entry] }, prepareOnly: true, spendCap: options.spendCap ?? "15.00" });
  return prepared.models[0];
 };
 try {
  if (!key || options.models?.length || options.provider !== undefined || options.providerName !== undefined) throw new Error();
  budget.cap = report.spendCapMicros = capMicros(options.spendCap ?? "15.00");
  budget.modelCap = report.perModelCapMicros = Math.min(500000, capMicros(options.perModelCap ?? "0.50"));
  const prior = options.resumeReport;
  if (prior !== undefined && (prior === null || typeof prior !== "object" || !Array.isArray(prior.models) || Buffer.byteLength(JSON.stringify(prior)) > 8 * 1024 * 1024 || !safe(JSON.stringify(prior)))) throw new Error();
  const catalogue = await get("models");
  if (!Array.isArray(catalogue?.data)) throw new Error();
  entries = catalogue.data;
  // Phase 1 (free GETs and local checks only, catalogue order): every model that can reach a paid call becomes a plan. Phase 2 (below) spends, CHEAPEST FIRST.
  for (const entry of entries) {
   const id = entry?.id;
   const model = { model: safe(id) ? id : "[invalid model]", status: "FAIL", reason: "", causes: [], providers: [] };
   report.models.push(model);
   if (!safe(id) || entries.filter(e => e?.id === id).length !== 1) { fail(model, "invalid_id", "invalid or duplicate model identifier"); continue; }
   if (id.startsWith("openrouter/") && validModel(id.replace(/^openrouter\//u, "router/"))) { fail(model, "router_alias", "router_alias excluded"); continue; }
   if (!validModel(id.replace(/:(?:batch|free|online)$/u, ""))) { fail(model, "invalid_id", "invalid model identifier"); continue; }
   const variant = id.endsWith(":batch") ? "batch_variant" : id.endsWith(":free") ? "free_variant" : id.startsWith("~") ? "router_alias" : undefined;
   if (variant) { fail(model, variant, variant === "free_variant" ? "free variant excluded: different data policy" : `${variant} excluded`); continue; }
   if (!validModel(id)) { fail(model, "invalid_id", id.endsWith(":online") ? "online variant excluded: search is never requested" : "invalid model identifier"); continue; }
   if (budget.stop) { fail(model, budget.stop, `not reached: ${budget.stop}`); report.notReached.push(id); continue; }
   if (!Array.isArray(entry.supported_parameters) || !entry.supported_parameters.includes("tools")) { fail(model, "no_tools_support", "catalogue does not declare tool/function calling"); continue; }
   // Validate catalogue and endpoint prices independently before any paid request.
   // Absent component assumptions and override maxima are retained on candidates.
   if (entry.estimated === true || entry.is_estimated === true) { fail(model, "unpriced_component", "catalogue tariff is estimated"); continue; }
   const catalogueTariff = await prepare(entry, "catalogue", "catalogue");
   if (!catalogueTariff?.candidateTariff) { fail(model, tariffCause(catalogueTariff?.reasons.bounded_tariff), "catalogue tariff unbounded: " + (catalogueTariff?.reasons.bounded_tariff ?? "invalid tariff")); continue; }
   let endpoints;
   try { const response = await get(`models/${id}/endpoints`); endpoints = response?.data?.endpoints; }
   catch { fail(model, budget.stop ?? "provider_routing", "provider endpoint evidence unavailable"); if (budget.stop) report.notReached.push(id); continue; }
   if (!Array.isArray(endpoints) || endpoints.length === 0) { fail(model, "provider_routing", "no provider endpoints available"); continue; }
   const eligible = [];
   // Exact tags are pinned in both order and only, with fallbacks disabled.
   // Duplicate tags still route to every matching endpoint: bound ALL of them.
   const routes = new Map();
   for (const endpoint of endpoints) {
    const route = endpoint?.tag;
    if (!validRoute(route) || !safe(route)) {
     model.providers.push({ status: "FAIL", cause: "provider_routing", reasons: { provider_routing: "missing pinned endpoint tag" } }); continue;
    }
    if (!routes.has(route)) routes.set(route, []);
    routes.get(route).push(endpoint);
   }
   for (const [route, group] of routes) {
    const name = group[0].provider_name;
    if (!safe(name) || name.length < 1 || name.length > 128 || /[\p{Cc}\p{Cf}]/u.test(name) || group.some(e => e.provider_name !== name)) {
     model.providers.push({ route, status: "FAIL", cause: "provider_routing", reasons: { provider_routing: "missing or ambiguous pinned provider name" } }); continue;
    }
    if (group.some(e => !Array.isArray(e.supported_parameters) || !e.supported_parameters.includes("tools"))) {
     model.providers.push({ route, status: "FAIL", cause: "no_tools_support", reasons: { no_tools_support: "routable endpoint does not declare tool/function calling" } }); continue;
    }
    const tariffs = []; const failures = [];
    for (const endpoint of group) {
     if (endpoint.estimated === true || endpoint.is_estimated === true) { failures.push("endpoint tariff is estimated"); continue; }
     // Never substitute aggregate catalogue prices for an unpriced endpoint.
     const prepared = await prepare({ ...entry, pricing: endpoint.pricing, top_provider: { max_completion_tokens: endpoint.max_completion_tokens } }, route, name);
     if (!prepared?.candidateTariff) failures.push(prepared?.reasons.bounded_tariff ?? "endpoint tariff unbounded");
     else tariffs.push(prepared.candidateTariff);
    }
    if (failures.length > 0) {
     model.providers.push({ route, status: "FAIL", cause: tariffCause(failures.join("; ")), reasons: { unpriced_component: failures.join("; ") } }); continue;
    }
    const pricing = Object.fromEntries(OPENROUTER_PRICE_KEYS.map(key => [key, tariffs.map(t => t.pricing[key]).reduce(maxPrice)]));
    const reasoningBilledAtCompletion = tariffs.some(t => t.reasoningBilledAtCompletion);
    const routedEntry = { ...entry, pricing, reasoningBilledAtCompletion, top_provider: { max_completion_tokens: Math.min(...group.map(e => e.max_completion_tokens)) } };
    // Keep singleton absence provenance; duplicate tags retain only shared absences.
    const prepared = await prepare(routedEntry, route, name);
    const tariff = prepared.candidateTariff;
    tariff.assumedZero = OPENROUTER_PRICE_KEYS.filter(key => tariffs.every(t => t.assumedZero.includes(key)));
    if (tariff.assumedZero.includes("input_cache_write")) applyNoWriteBasis(tariff);
    eligible.push({ route, name, entry: { ...routedEntry, assumedZero: tariff.assumedZero }, tariff });
   }
   model.tariffSignature = signature(eligible.map(e => ({ ...e.tariff, providerName: e.name })).sort((a, b) => a.route.localeCompare(b.route)));
   plans.push({ id, model, eligible });
  }
  // Owner rule (2026-11-23): CHEAPEST FIRST, so the shared hold cap reaches more models. A model's key is its cheapest route's MAX LISTED PRICE (the highest of that route's
  // listed per-token prices: prompt, completion, reasoning, cache read, cache write; override tiers already folded in by the worst-case maxima). Models with no eligible route
  // (they spend nothing) go last; ties by model id in code-point order. Report rows stay in catalogue order; only the spending order changes.
  const routeMaxPrice = item => OPENROUTER_PRICE_KEYS.filter(k => k !== "request").map(k => item.tariff.pricing[k]).reduce(maxPrice);
  const planKey = plan => plan.eligible.length === 0 ? undefined : plan.eligible.map(routeMaxPrice).reduce((a, b) => comparePrice(rationalPrice(a), rationalPrice(b)) <= 0n ? a : b);
  plans.sort((a, b) => {
   const [ka, kb] = [planKey(a), planKey(b)];
   if (ka !== undefined && kb !== undefined) { const c = comparePrice(rationalPrice(ka), rationalPrice(kb)); if (c !== 0n) return c < 0n ? -1 : 1; }
   else if (ka !== kb) return ka === undefined ? 1 : -1;
   return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const plan of plans) {
   const { id, model, eligible } = plan; inFlight = plan; budget.modelExposure = 0;
   if (budget.stop) { fail(model, budget.stop, `not reached: ${budget.stop}`); report.notReached.push(id); continue; }
   const matches = prior?.harnessVersion === report.harnessVersion ? prior.models.filter(m => m?.model === id) : [];
   const old = matches.length === 1 ? matches[0] : undefined;
   // Carry only a complete prior PASS matching ALL currently eligible route tariffs.
   // Excluded routes remain visible separately and do not become tariff candidates.
   if (eligible.length > 0 && old?.status === "PASS" && old.tariffSignature === model.tariffSignature && Array.isArray(old.providers)) {
    const retained = old.providers.filter(p => eligible.some(e => p.route === e.route));
    const passes = retained.filter(p => p.status === "PASS");
    const candidates = prior.proposedTariffRows;
    const evidenceValid = retained.length === eligible.length && eligible.every(e => retained.filter(p => p.route === e.route).length === 1) && passes.length > 0 && Array.isArray(candidates) && passes.every(result => {
     const current = eligible.find(e => e.route === result.route);
     const rows = candidates.filter(t => t?.model === id && t.route === result.route);
     const expected = tariffEvidence({ ...current.tariff, verifiedAt: result.candidateTariff?.verifiedAt }, result);
     const sameEvidence = row => row?.status === expected.status && JSON.stringify(row.observedModelIds) === JSON.stringify(expected.observedModelIds) && JSON.stringify(row.zeroPriceProof) === JSON.stringify(expected.zeroPriceProof);
     return result.candidateTariff && rows.length === 1 &&
      sameEvidence(rows[0]) && sameEvidence(result.candidateTariff) &&
      signature([rows[0]]) === signature([current.tariff]) && signature([result.candidateTariff]) === signature([current.tariff]) &&
      result.calls?.length === 4 && result.calls.every(c => Object.values(c.checks ?? {}).length > 0 && Object.values(c.checks).every(v => v === "PASS")) &&
      Object.values(result.checks ?? {}).every(v => v === "PASS") && result.checks?.provider_honoured_max_price === "PASS";
    });
    if (evidenceValid) {
     model.providers.push(...globalThis.structuredClone(retained)); model.resumed = true; model.status = "PASS"; model.reason = "carried PASS: same harness, provider identities and tariffs";
     report.proposedTariffRows.push(...globalThis.structuredClone(candidates.filter(t => t.model === id && passes.some(p => p.route === t.route)))); continue;
    }
   }
   let modelStopped;
   for (const item of eligible) {
    if (budget.stop || modelStopped || budget.modelExposure >= budget.modelCap) {
     model.providers.push({ route: item.route, status: "FAIL", cause: budget.stop ?? modelStopped ?? "per_model_cap", reasons: { not_attempted: "provider not reached after model or shared stop" } }); continue;
    }
    const qualified = await qualifyModels({ ...options, models: [id], provider: item.route, providerName: item.name, catalogue: { data: [item.entry] }, spendCap: options.spendCap ?? "15.00", budget });
    report.chargedMicros += qualified.chargedMicros; report.preCallHoldsMicros += qualified.preCallHoldsMicros;
    const result = qualified.models[0];
    if (!result) { model.providers.push({ route: item.route, status: "FAIL", cause: "qualification_checks", reasons: { qualification_checks: "qualification evidence unavailable" } }); continue; }
    result.route = item.route;
    if (budget.modelExposure > budget.modelCap) {
     recordCheck(result, "per_model_cap", false, `model exposure ${budget.modelExposure} > per-model cap ${budget.modelCap} micros`);
     fail(model, "per_model_cap", result.reasons.per_model_cap);
    }
    if (result.status !== "PASS") { result.cause = failureCause(result); delete result.candidateTariff; }
    model.providers.push(result);
    if (budget.exposure > budget.cap) budget.stop = "overall_cap";
    if (result.checks.hidden_charge === "FAIL") fail(model, "hidden_charge", result.reasons.hidden_charge);
    if (result.checks.hidden_charge === "FAIL" || result.checks.per_model_cap === "FAIL" || budget.modelExposure > budget.modelCap) modelStopped = result.checks.hidden_charge === "FAIL" ? "hidden_charge" : "per_model_cap";
   }
   // Candidate rows may be retained for passing routes even if another provider failed;
   // a model passes if at least one route passed. Never install any of these rows.
   const passes = model.providers.filter(p => p.status === "PASS");
   if (passes.length > 0 && !budget.stop && !modelStopped && !model.providers.some(p => p.cause === "per_model_cap") && budget.modelExposure <= budget.modelCap) {
    model.status = "PASS"; model.reason = "qualified provider routes; candidate tariffs require review";
    report.proposedTariffRows.push(...passes.map(p => ({ ...p.candidateTariff })));
   } else {
    for (const provider of model.providers.filter(p => p.status !== "PASS")) fail(model, provider.cause ?? "qualification_checks", [...Object.values(provider.reasons), ...(provider.calls ?? []).flatMap(c => Object.values(c.reasons))].join("; ") || "provider checks failed");
    if (budget.stop) fail(model, budget.stop, `shared stop: ${budget.stop}`);
    if (budget.modelExposure >= budget.modelCap && model.causes.length === 0) fail(model, "per_model_cap", "per-model cap reached");
    if (model.causes.length === 0) fail(model, "provider_routing", "no eligible provider passed");
   }
   if (model.status === "FAIL" && model.causes.some(c => ["overall_cap", "per_model_cap", "authentication", "credential"].includes(c)) && !model.providers.some(p => p.calls?.length > 0)) report.notReached.push(id);
   model.exposureMicros = budget.modelExposure;
  }
  if (report.models.length > 0 && report.models.every(m => m.status === "PASS")) report.status = "PASS";
 } catch {
  report.errors.push("Catalogue qualification refused or HTTP evidence unavailable; no automatic tariff installation.");
  const current = report.models.at(-1);
  const remaining = entries.slice(report.models.length).map(entry => entry?.id);
  if (inFlight === undefined && current && !current.providers.some(provider => provider.calls?.length > 0)) remaining.unshift(current.model);
  // Phase 2 not reached yet (or interrupted): every plan from the in-flight one on (all of them if phase 1 itself failed) spent nothing yet.
  for (const plan of plans.slice(inFlight === undefined ? 0 : plans.indexOf(inFlight))) if (!plan.model.providers.some(provider => provider.calls?.length > 0)) remaining.push(plan.id);
  for (const id of remaining) if (validModel(id) && safe(id) && !report.notReached.includes(id)) report.notReached.push(id);
 }
 report.exposureMicros = budget.exposure;
 report.installSelection = selectInstallRows(report.proposedTariffRows);
 for (const model of report.models.filter(m => m.status === "FAIL")) {
  for (const cause of model.causes) report.failuresByCause[cause] = (report.failuresByCause[cause] ?? 0) + 1;
 }
 return report;
}
export async function qualify(options) {
 if (options.allModels === true) return qualifyAll(options);
 if (options.perModelCap !== undefined || options.resumeReport !== undefined || options.resume !== undefined) return { status: "FAIL", errors: ["All-models options require --all-models"] };
 return qualifyModels(options);
}

// Probe directories without creating/truncating outputs or changing resume evidence.
const preflightPaths = paths => {
 for (const path of paths) {
  try {
   const existing = statSync(path, { throwIfNoEntry: false });
   if (existing) {
    if (!existing.isFile()) throw new Error();
    accessSync(path, constants.W_OK);
   }
   const probe = join(dirname(path), `.openrouter-preflight-${randomUUID()}`);
   try { writeFileSync(probe, "", { flag: "wx" }); }
   finally { rmSync(probe, { force: true }); }
  } catch {
   process.stderr.write(`Qualification preflight failed for ${JSON.stringify(path)}; path must be writable before discovery or paid requests.\n`);
   return false;
  }
 }
 return true;
};

export async function main(argv = process.argv.slice(2), env = process.env) {
 const options = { models: [], env };
 try {
  for (let i = 0; i < argv.length; i++) {
   const flag = argv[i];
   if (flag === "--all-models") options.allModels = true;
   else if (flag === "--models") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) options.models.push(argv[++i]); }
   else if (["--provider", "--provider-name", "--spend-cap", "--per-model-cap", "--resume", "--report"].includes(flag) && argv[i + 1]) options[({ "--provider": "provider", "--provider-name": "providerName", "--spend-cap": "spendCap", "--per-model-cap": "perModelCap", "--resume": "resume", "--report": "reportPath" })[flag]] = argv[++i];
   else throw new Error();
  }
  if (options.reportPath !== undefined && !options.allModels) throw new Error();
  const reportPath = options.reportPath ?? "report.json";
  const cataloguePath = `${reportPath.replace(/\.json$/iu, "")}-catalogue.json`;
  const paths = [...(options.allModels ? [reportPath, cataloguePath] : []), ...(options.resume ? [options.resume] : [])];
  if (!preflightPaths(paths)) return 1;
  if (options.resume) {
   const bytes = readFileSync(options.resume);
   if (bytes.length > 8 * 1024 * 1024) throw new Error();
   options.resumeReport = JSON.parse(bytes.toString("utf8"));
  }
  const catalogue = { models: null, endpoints: Object.create(null) };
  const result = options.allModels ? await qualifyAll(options, catalogue) : await qualify(options);
  const text = JSON.stringify(result, null, 2);
  const catalogueText = JSON.stringify(catalogue, null, 2);
  if (options.allModels && (containsCredential(catalogueText, env.OPENROUTER_API_KEY) || /"authorization"\s*:/iu.test(catalogueText))) { process.stdout.write('{"status":"FAIL","errors":["Catalogue withheld"]}\n'); return 1; }
  if (containsCredential(text, (options.env ?? process.env).OPENROUTER_API_KEY)) { process.stdout.write('{"status":"FAIL","errors":["Report withheld"]}\n'); return 1; }
  process.stdout.write(`${text}\n`);
  if (options.allModels) {
   for (const [path, contents] of [[reportPath, text], [cataloguePath, catalogueText]]) {
    try { writeFileSync(path, `${contents}\n`); }
    catch {
     process.stderr.write(`Failed to write qualification output ${JSON.stringify(path)}; full report printed to stdout.\n`);
     return 1;
    }
   }
  }
  return result.status === "PASS" ? 0 : 1;
 } catch { process.stdout.write('{"status":"FAIL","errors":["Invalid qualification arguments"]}\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
