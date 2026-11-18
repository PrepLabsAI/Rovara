// Unit history is separate from RUN_COST and never feeds the displayed estimate.
import { companyScoped, when, INDEX_EXPIRY_ATTRIBUTE, ROVARA_CODE_AGENT_ID, type DocumentStore, type JsonValue } from "@agentx/contracts";
import { RateQuoteV1Schema, RunUsageSampleV1Schema, RunUsageCallSchema, RunStartQuoteSchema, type LearningField, type RateQuoteV1, type RunUsageCallV1, type RunUsageSampleV1, type RunStartQuote } from "@agentx/contracts";
import { estimatePathOf, estimateRun } from "./estimate.js";
import { workspaceOperations } from "../task-flow/reads.js";
import { costPartition } from "./ledger.js";
const available = <T>(value: T): LearningField<T> => ({ state: "available", value });
const unknown = { state: "unavailable", reason: "legacy_data" } as const;
const unreadable = { state: "unavailable", reason: "unreadable" } as const;
export const runUsageKey = (companyId: string, project: string, taskId: string) => ({ pk: companyScoped(companyId, `RUN_USAGE#${project}`), sk: taskId });

/** Today's compatible rates re-value units; booked money and original price refs are untouched. */
export function repriceSample(sample: RunUsageSampleV1, quote: RateQuoteV1, asOf: string): LearningField<number> {
  if (!RunUsageSampleV1Schema.safeParse(sample).success || !RateQuoteV1Schema.safeParse(quote).success || !Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) < Date.parse(quote.asOf) || Date.parse(asOf) >= Date.parse(quote.expiresAt)) return unreadable;
  if (sample.outcome !== "completed" || sample.completionCoverage !== "complete" || sample.priceCoverage !== "complete" || sample.callCount.state !== "available") return unknown;
  let total = 0n;
  for (const c of sample.calls) {
    if (c.granularity !== "call" || c.status !== "final" || c.usage.state !== "available" || c.model.state !== "available" || c.source.state !== "available" || c.price.state !== "available" || c.settledMicros.state !== "available") return unknown;
    if (c.model.value.provider !== quote.model.provider || c.model.value.modelId !== quote.model.modelId || c.source.value.id !== quote.source.id || c.source.value.kind !== quote.source.kind || c.source.value.provider !== quote.source.provider || c.source.value.connectionRevision !== quote.source.connectionRevision || c.price.value.authority !== quote.ref.authority) return unknown;
    const u = c.usage.value;
    const input = BigInt(u.input) + BigInt(u.cacheRead) + BigInt(u.cacheWrite5m) + BigInt(u.cacheWrite1h) + BigInt(u.cacheWriteUnknown);
    let r = quote.base;
    for (const band of quote.longContext) if (input > BigInt(band.aboveInputTokens)) r = band.rates;
    const product = BigInt(u.input) * BigInt(r.input) + BigInt(u.output) * BigInt(r.output) + BigInt(u.cacheRead) * BigInt(r.cacheRead) + BigInt(u.cacheWrite5m) * BigInt(r.cacheWrite5m) + BigInt(u.cacheWrite1h) * BigInt(r.cacheWrite1h) + BigInt(u.cacheWriteUnknown) * BigInt(Math.max(r.cacheWrite5m, r.cacheWrite1h));
    total += (product + 999_999n) / 1_000_000n;
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) return unreadable;
  }
  return available(Number(total));
}

/** One stable company/project/task row. A correction replaces its revision, never adds another training sample. */
export async function recordRunUsage(deps: { store: Pick<DocumentStore, "get" | "transact"> }, value: RunUsageSampleV1): Promise<"applied" | "older" | "duplicate"> {
  const sample = RunUsageSampleV1Schema.parse(value);
  const taskKey = { pk: `DEVTASK#${sample.taskId}`, sk: "META" };
  const task = await deps.store.get(taskKey);
  if (task?.["companyId"] !== sample.companyId || task["project"] !== sample.project) throw new Error("run usage task is unavailable");
  const key = runUsageKey(sample.companyId, sample.project, sample.taskId);
  const previous = await deps.store.get(key);
  if (typeof previous?.["revision"] === "number" && previous["revision"] >= sample.revision) return previous["revision"] > sample.revision ? "older" : "duplicate";
  const result = await deps.store.transact([
    { kind: "check", key: taskKey, condition: when.and(when.eq("companyId", sample.companyId), when.eq("project", sample.project)) },
    { kind: "put", item: { ...key, entityType: "RUN_USAGE_SAMPLE", companyId: sample.companyId, project: sample.project, revision: sample.revision, sample: JSON.parse(JSON.stringify(sample)) as JsonValue, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(sample.endedAt) / 1000) + 365 * 86_400 }, condition: previous === undefined ? when.absent() : when.eq("revision", previous["revision"]!) },
  ]);
  if (!result.applied) throw new Error("run usage changed while recording");
  return "applied";
}

type UsageTask = { companyId: string; project: string; taskId: string; workspaceId?: string; agentId?: string; purpose?: string; workflow?: { path?: string; stage?: string; state?: string; definitionVersion?: string; blockReason?: string | undefined }; usageStartQuote?: RunStartQuote };
export async function captureStartQuote(deps: { store: Pick<DocumentStore, "query"> }, task: UsageTask, asOf: string): Promise<RunStartQuote> {
  const path = estimatePathOf(task);
  const inputs = { model: unknown, source: unknown, price: unknown, optionsVersion: unknown };
  try {
    const estimate = await estimateRun(deps, { orgId: task.companyId, project: task.project, agentId: task.agentId ?? ROVARA_CODE_AGENT_ID, path });
    const parsed = RunStartQuoteSchema.safeParse({ asOf, path, range: available({ lowMicros: Math.ceil(estimate.lowUsd * 1_000_000), highMicros: Math.ceil(estimate.highUsd * 1_000_000) }), basis: estimate.basis, modelPriced: false, inputs });
    if (parsed.success) return parsed.data;
  } catch { /* A history outage remains explicit and never prevents execution. */ }
  return RunStartQuoteSchema.parse({ asOf, path, range: unreadable, basis: "unavailable", modelPriced: false, inputs });
}

/** Legacy session reports retain their units and booked amounts, but cannot invent call boundaries, source or finality. */
export async function recordClosedRunUsage(deps: { store: DocumentStore }, task: UsageTask, endedAt: string): Promise<void> {
  const owned = await deps.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
  if (owned?.["companyId"] !== task.companyId || owned["project"] !== task.project) throw new Error("run usage task is unavailable");
  const operations = task.workspaceId === undefined ? [] : await workspaceOperations({ store: deps.store, companyId: task.companyId }, task.workspaceId);
  const stages = new Map(operations.map((op) => [op.id, op.workflowMode ?? op.kind]));
  const calls: RunUsageCallV1[] = []; const settledAmounts: NonNullable<RunUsageSampleV1["settledAmounts"]> = []; let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await deps.store.query({ pk: costPartition(task.companyId, task.taskId), sk: { op: "beginsWith", prefix: "ENTRY#" }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of result.items) {
      const amount = row["currency"] === "USD" && typeof row["micros"] === "number" && Number.isSafeInteger(row["micros"]) && row["micros"] >= 0 ? available(row["micros"]) : unknown;
      settledAmounts.push({ entryId: row.sk.slice(6), amountMicros: amount });
      const raw = row["runUsageCalls"];
      if (Array.isArray(raw) && raw.length > 0) {
        for (const value of raw) {
          const call = RunUsageCallSchema.parse(value);
          // Worker claims provide units only. Source, price and settled money need the server's receipt (lane C).
          const operation = row.sk.replace(/^ENTRY#(?:usage(?:-checkpoint)?:)?/u, "").split(":")[0]!;
          calls.push({ ...call, callId: `${operation}:${call.callId}`, stage: stages.get(operation) ?? "unknown", source: unknown, price: unknown, settledMicros: unknown, status: call.usage.state === "available" ? "estimated" : "awaiting_usage" });
        }
        continue;
      }
      const explicit = RunUsageCallSchema.safeParse(row["runUsage"]);
      if (explicit.success) { calls.push(explicit.data); continue; }
      const n = (key: string) => typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] >= 0 ? row[key] : undefined;
      const tokens = ["tokensInput", "tokensOutput", "tokensCacheRead", "tokensCacheWrite"].map(n);
      calls.push({ callId: row.sk.slice(6), stage: stages.get(row.sk.replace(/^ENTRY#(?:usage(?:-checkpoint)?:)?/u, "").split(":")[0]!) ?? "unknown", granularity: row["usageGranularity"] === "call" ? "call" : "session", model: typeof row["provider"] === "string" && typeof row["modelId"] === "string" ? available({ provider: row["provider"], modelId: row["modelId"] }) : unknown, source: unknown, usage: tokens.every((n) => n !== undefined) ? available({ input: tokens[0]!, output: tokens[1]!, cacheRead: tokens[2]!, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: tokens[3]! }) : unreadable, price: unknown, settledMicros: row["currency"] === "USD" && n("micros") !== undefined ? available(n("micros")!) : unknown, status: "estimated" });
    }
    cursor = result.cursor;
    if (cursor === undefined) break;
  }
  if (cursor !== undefined) throw new Error("run usage exceeds read bound");
  const prior = await deps.store.get(runUsageKey(task.companyId, task.project, task.taskId));
  const old = RunUsageSampleV1Schema.safeParse(prior?.["sample"]);
  const complete = calls.every((c) => c.granularity === "call" && c.status === "final" && c.usage.state === "available" && c.source.state === "available" && c.price.state === "available");
  const sample: RunUsageSampleV1 = {
    version: 1, companyId: task.companyId, project: task.project, taskId: task.taskId, purpose: task.purpose === undefined ? { state: "unavailable", reason: "not_applicable" } : available(task.purpose), agentId: task.agentId ?? ROVARA_CODE_AGENT_ID,
    path: estimatePathOf(task), outcome: operations.some((op) => op.stopReason !== undefined) || /cap|budget|spend|money/iu.test(task.workflow?.blockReason ?? "") ? "cap_stopped" : task.workflow?.stage === "MERGED" ? "completed" : operations.some((op) => op.status === "FAILED") ? "failed" : "cancelled",
    workflowVersion: task.workflow?.definitionVersion === undefined ? unknown : available(task.workflow.definitionVersion), optionsVersion: unknown,
    settledAmounts, calls: [...new Map(calls.map((call) => [call.callId, call])).values()], callCount: calls.length > 0 && calls.every((c) => c.granularity === "call") ? available(new Set(calls.map((call) => call.callId)).size) : unknown,
    // No expected-call/forwarding proof yet: even a fully reported ledger cannot prove no call is missing.
    completionCoverage: "partial", priceCoverage: complete && calls.length > 0 ? "complete" : "partial", endedAt: old.success ? old.data.endedAt : endedAt, revision: old.success ? old.data.revision + 1 : 1,
    startQuote: task.usageStartQuote === undefined ? unknown : available(task.usageStartQuote),
  };
  const parsed = RunUsageSampleV1Schema.parse(sample);
  if (old.success && JSON.stringify({ ...old.data, revision: 0 }) === JSON.stringify({ ...parsed, revision: 0 })) return;
  await recordRunUsage(deps, parsed);
}

export function accuracyByPath(samples: readonly RunUsageSampleV1[]): Record<string, { samples: number; quoted: number; validated: number; covered: number; exceeded: number; coverage: LearningField<number>; meanErrorMicros: LearningField<number> }> {
  const latest = new Map<string, RunUsageSampleV1>();
  for (const value of samples) {
    const parsed = RunUsageSampleV1Schema.safeParse(value); if (!parsed.success) continue;
    const s = parsed.data; const key = JSON.stringify([s.companyId, s.project, s.taskId]);
    if ((latest.get(key)?.revision ?? 0) < s.revision) latest.set(key, s);
  }
  const result: ReturnType<typeof accuracyByPath> = {}; const errors = new Map<string, bigint>();
  for (const s of latest.values()) {
    if (s.outcome !== "completed") continue;
    const r = result[s.path] ??= { samples: 0, quoted: 0, validated: 0, covered: 0, exceeded: 0, coverage: unknown, meanErrorMicros: unknown };
    r.samples++;
    if (s.startQuote.state !== "available" || s.startQuote.value.range.state !== "available") continue;
    r.quoted++;
    if (s.completionCoverage !== "complete" || s.priceCoverage !== "complete" || s.startQuote.value.path !== s.path || Date.parse(s.startQuote.value.asOf) > Date.parse(s.endedAt) || s.calls.some((c) => c.status !== "final" || c.settledMicros.state !== "available")) continue;
    const actual = s.calls.reduce((n, c) => n + BigInt(c.settledMicros.state === "available" ? c.settledMicros.value : 0), 0n);
    if (actual > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const range = s.startQuote.value.range.value;
    r.validated++; if (actual >= BigInt(range.lowMicros) && actual <= BigInt(range.highMicros)) r.covered++; if (actual > BigInt(range.highMicros)) r.exceeded++;
    errors.set(s.path, (errors.get(s.path) ?? 0n) + actual - (BigInt(range.lowMicros) + BigInt(range.highMicros)) / 2n);
    r.coverage = available(r.covered / r.validated); r.meanErrorMicros = available(Number(errors.get(s.path)! / BigInt(r.validated)));
  }
  return result;
}
