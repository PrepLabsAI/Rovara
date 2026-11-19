/** TaskMoneyV1: contracts/shared/task-money.v1.json is canonical in Code and Cloud. */
export type MoneyField<T> = { state: "available"; value: T } | { state: "unavailable"; reason: "not_measured" | "missing_price" | "unreadable" | "restricted" | "legacy_data" | "not_applicable" };
export type MoneyPayer = { kind: "member" | "project" | "agent" | "chain"; id: string; name: string } | { kind: "mixed"; name: string };
export type MoneyLimitScope = "engine_task" | "project_task" | "engine_day" | "gateway_task" | "project_month" | "person_month" | "company_month" | "purpose_month";
export interface TaskMoneyV1 {
  version: 1; taskId: string; currency: "USD"; revision: number; asOf: string; state: "current" | "partial" | "unavailable";
  spentMicros: MoneyField<number>; finalMicros: MoneyField<number>; estimatedMicros: MoneyField<number>; heldMicros: MoneyField<number>;
  unpricedCalls: MoneyField<number>; awaitingUsageCalls: MoneyField<number>; awaitingUsageMicros: MoneyField<number>; payer: MoneyField<MoneyPayer>;
  allocations: Array<{ payer: MoneyField<MoneyPayer>; usageValueMicros: MoneyField<number>; rovaraChargeMicros: MoneyField<number>; billing: "customer" | "exempt" | "external_provider" | "unavailable" }>;
  coverage: { expectedCalls: MoneyField<number>; finalCalls: number; estimatedCalls: number; awaitingUsageCalls: number; incompatibleCurrencyCalls: number };
  stop: { taskMaximumMicros: MoneyField<number>; nextCallAvailableMicros: MoneyField<number>; limits: Array<{ scope: MoneyLimitScope; maximumMicros: MoneyField<number>; availableMicros: MoneyField<number>; heldMicros: MoneyField<number>; resetAt: MoneyField<string> }>; coverage: "complete" | "partial"; bindingScope: MoneyField<MoneyLimitScope | null> };
  terminal: boolean; finality: "final" | "provisional" | "unavailable";
}
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const keys = (v: Record<string, unknown>, names: string): boolean => Object.keys(v).sort().join(",") === names.split(" ").sort().join(",");
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048;
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const iso = (v: unknown): v is string => text(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const scope = (v: unknown): boolean => ["engine_task", "project_task", "engine_day", "gateway_task", "project_month", "person_month", "company_month", "purpose_month"].includes(v as string);
const field = (v: unknown, valid: (v: unknown) => boolean): boolean => {
  const f = object(v); if (f === undefined) return false;
  return f.state === "available" ? keys(f, "state value") && valid(f.value) : keys(f, "state reason") && f.state === "unavailable" && ["not_measured", "missing_price", "unreadable", "restricted", "legacy_data", "not_applicable"].includes(f.reason as string);
};
const payer = (v: unknown): boolean => { const p = object(v); return p !== undefined && text(p.name) && (p.kind === "mixed" ? keys(p, "kind name") : keys(p, "kind id name") && ["member", "project", "agent", "chain"].includes(p.kind as string) && text(p.id)); };
export const taskMoneyValue = <T>(f: MoneyField<T>): T | undefined => f.state === "available" ? f.value : undefined;
/** Strict even inside forward-compatible envelopes: unknown money cannot become exact money. */
export function parseTaskMoneyV1(raw: unknown): TaskMoneyV1 | undefined {
  const m = object(raw);
  if (m === undefined || !keys(m, "version taskId currency revision asOf state spentMicros finalMicros estimatedMicros heldMicros unpricedCalls awaitingUsageCalls awaitingUsageMicros payer allocations coverage stop terminal finality")) return undefined;
  if (m.version !== 1 || m.currency !== "USD" || !text(m.taskId) || !natural(m.revision) || !iso(m.asOf) || !["current", "partial", "unavailable"].includes(m.state as string) || !["final", "provisional", "unavailable"].includes(m.finality as string) || typeof m.terminal !== "boolean") return undefined;
  if (!["spentMicros", "finalMicros", "estimatedMicros", "heldMicros", "unpricedCalls", "awaitingUsageCalls", "awaitingUsageMicros"].every(k => field(m[k], natural)) || !field(m.payer, payer)) return undefined;
  if (!Array.isArray(m.allocations) || m.allocations.length > 100 || !m.allocations.every(v => { const a = object(v); return a !== undefined && keys(a, "payer usageValueMicros rovaraChargeMicros billing") && field(a.payer, payer) && field(a.usageValueMicros, natural) && field(a.rovaraChargeMicros, natural) && ["customer", "exempt", "external_provider", "unavailable"].includes(a.billing as string); })) return undefined;
  const c = object(m.coverage), s = object(m.stop);
  if (c === undefined || !keys(c, "expectedCalls finalCalls estimatedCalls awaitingUsageCalls incompatibleCurrencyCalls") || !field(c.expectedCalls, natural) || ![c.finalCalls, c.estimatedCalls, c.awaitingUsageCalls, c.incompatibleCurrencyCalls].every(natural)) return undefined;
  if (s === undefined || !keys(s, "taskMaximumMicros nextCallAvailableMicros limits coverage bindingScope") || !["taskMaximumMicros", "nextCallAvailableMicros"].every(k => field(s[k], natural)) || !["complete", "partial"].includes(s.coverage as string) || !field(s.bindingScope, v => v === null || scope(v))) return undefined;
  if (!Array.isArray(s.limits) || s.limits.length > 8 || !s.limits.every(v => { const l = object(v); return l !== undefined && keys(l, "scope maximumMicros availableMicros heldMicros resetAt") && scope(l.scope) && ["maximumMicros", "availableMicros", "heldMicros"].every(k => field(l[k], natural)) && field(l.resetAt, iso); }) || new Set(s.limits.map(v => (v as Record<string, unknown>).scope)).size !== s.limits.length) return undefined;
  const money = m as unknown as TaskMoneyV1, value = taskMoneyValue;
  const spent = value(money.spentMicros), final = value(money.finalMicros), estimated = value(money.estimatedMicros), awaiting = value(money.awaitingUsageMicros);
  const count = money.coverage.finalCalls + money.coverage.estimatedCalls, expected = value(money.coverage.expectedCalls);
  if (spent !== undefined && (final === undefined || estimated === undefined || !Number.isSafeInteger(final + estimated) || spent !== final + estimated)
    || awaiting !== undefined && (estimated === undefined || awaiting > estimated)
    || money.coverage.awaitingUsageCalls > money.coverage.estimatedCalls
    || value(money.awaitingUsageCalls) !== undefined && value(money.awaitingUsageCalls) !== money.coverage.awaitingUsageCalls
    || !Number.isSafeInteger(count) || expected !== undefined && count > expected
    || money.state === "current" && (spent === undefined || expected === undefined || count !== expected || value(money.unpricedCalls) !== 0 || money.coverage.incompatibleCurrencyCalls !== 0 || value(money.heldMicros) === undefined)
    || money.state === "unavailable" && spent !== undefined || money.finality === "unavailable" && spent !== undefined
    || money.finality === "final" && (money.state !== "current" || !money.terminal || money.coverage.estimatedCalls !== 0 || value(money.heldMicros) !== 0 || money.stop.coverage !== "complete")) return undefined;
  return structuredClone(money);
}
/** Financial revision wins independently of workflow timestamps. Absence stays unavailable. */
export function mergeTaskMoney(previous: TaskMoneyV1 | undefined, next: TaskMoneyV1 | undefined): TaskMoneyV1 | undefined {
  if (next === undefined) return undefined;
  return previous?.taskId === next.taskId && previous.revision > next.revision ? previous : next;
}
/** One formatter for task lists, sessions and receipts. Unknown spend never becomes zero. */
export function taskMoneyWords(money: TaskMoneyV1 | undefined): string {
  if (money !== undefined && !money.terminal && money.revision === 0 && money.state === "unavailable" && money.spentMicros.state === "unavailable" && money.spentMicros.reason === "not_measured" && money.coverage.finalCalls === 0 && money.coverage.estimatedCalls === 0 && money.coverage.awaitingUsageCalls === 0 && money.coverage.incompatibleCurrencyCalls === 0) return "No spend yet";
  if (money === undefined || money.state === "unavailable" || money.spentMicros.state === "unavailable") return "Cost unavailable";
  const micros = money.spentMicros.value;
  if (micros === 0 && money.coverage.awaitingUsageCalls === 0 && taskMoneyValue(money.unpricedCalls) === 0) return "No spend yet";
  if (micros === 0) return "Cost unavailable";
  const dollars = micros < 10_000 ? "under $0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(micros / 1_000_000);
  if (money.terminal && money.finality === "final") return dollars;
  return `${micros < 10_000 ? "" : "About "}${dollars}${money.terminal ? " (not yet confirmed)" : " so far"}`;
}
