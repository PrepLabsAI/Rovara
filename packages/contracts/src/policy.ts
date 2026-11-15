import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";
import { matchPolicyGlob, validPolicyPath, POLICY_PATTERN_MAX, POLICY_PATH_MAX } from "./policy-glob.js";
import { POLICY_PRESETS } from "./presets.js";
import { CI_FIX_ROUNDS_MAX } from "./rovara-code.js";
import { TEST_ENV_ROUND_BUDGET_MIN } from "./test-environment.js";

export type PolicyValue = string | number | boolean | null;
export interface PolicyField {
  readonly id: string; readonly kind: "ordered_enum" | "number" | "boolean"; readonly order?: readonly string[];
  readonly stricter: "higher" | "lower"; readonly raisable: boolean; readonly measured: boolean;
  readonly lockable: boolean; readonly ceilinged: boolean; readonly today: PolicyValue; readonly compatibility?: boolean;
}
const field = (row: PolicyField): PolicyField => Object.freeze(row.order === undefined ? row : { ...row, order: Object.freeze([...row.order]) });
/** Stable display order. Numeric budget rule strictness is LOWER; a company lock is still a numeric FLOOR.
 * These are distinct comparisons: task raises increase budget allowances, only up to the ceiling.
 */
export const POLICY_FIELDS: readonly PolicyField[] = Object.freeze([
  // Q1 compatibility: no current setting; feature not built yet. null means no preset, not Balanced.
  field({ id: "preset_level", kind: "ordered_enum", order: ["lightweight", "balanced", "careful"], stricter: "higher", raisable: false, measured: false, lockable: true, ceilinged: false, today: null, compatibility: true }),
  // broker/src/core/ci-fix/ci-fix.ts:44–49: existing CI-fix behavior (still subject to autonomy).
  field({ id: "real_check", kind: "ordered_enum", order: ["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"], stricter: "higher", raisable: true, measured: true, lockable: true, ceilinged: false, today: "their_ci_fix" }),
  // contracts/src/rovara-code.ts:40: CI_FIX_ROUNDS_MAX = 3.
  // More automatic repair attempts are not stronger verification. Conservatively, fewer rounds win
  // between rules; company numeric locks remain minimums (separate from rule strictness).
  field({ id: "ci_fix_rounds", kind: "number", stricter: "lower", raisable: false, measured: false, lockable: true, ceilinged: false, today: CI_FIX_ROUNDS_MAX }),
  // contracts/src/test-environment.ts:42; worker/src/verification/selection.ts:276: 30 minutes.
  field({ id: "round_time_minutes", kind: "number", stricter: "higher", raisable: false, measured: true, lockable: true, ceilinged: false, today: 30 }),
  // broker/src/core/cost/limits.ts:6,16–20: dynamic QUICK/FULL planning + task estimate, no universal scalar.
  // null delegates to that existing calculation; it does NOT switch off the existing money guard.
  field({ id: "model_budget_usd", kind: "number", stricter: "lower", raisable: true, measured: true, lockable: true, ceilinged: true, today: null }),
  // Q1 compatibility: no current setting; feature not built yet. null means no per-task machine cap.
  field({ id: "machine_budget_minutes", kind: "number", stricter: "lower", raisable: true, measured: true, lockable: true, ceilinged: true, today: null, compatibility: true }),
  // contracts/src/second-review.ts:72–74: default mode off; this additive boolean does not replace shadow mode.
  field({ id: "extra_review", kind: "boolean", stricter: "higher", raisable: true, measured: false, lockable: true, ceilinged: false, today: false }),
  // Q1 compatibility: no current setting; feature not built yet (how-we-work-track-record.ts:54).
  field({ id: "after_merge_revert", kind: "ordered_enum", order: ["off", "report_only", "offer_revert"], stricter: "higher", raisable: false, measured: false, lockable: true, ceilinged: false, today: "off", compatibility: true }),
  // Q1 compatibility: no current setting; feature not built yet (TE-B11).
  field({ id: "mutation_spot_check", kind: "ordered_enum", order: ["off", "on"], stricter: "higher", raisable: false, measured: false, lockable: true, ceilinged: false, today: "off", compatibility: true }),
  // Q1 compatibility: no current setting; feature not built yet (TE-F10).
  field({ id: "prompt_side_by_side", kind: "ordered_enum", order: ["off", "on"], stricter: "higher", raisable: false, measured: false, lockable: true, ceilinged: false, today: "off", compatibility: true }),
]);

/** default is Q1's explicit compatibility origin; company_ceiling/install_off are §3.2 steps 7/8 additions. */
export const POLICY_ORIGINS = Object.freeze(["rovara_default", "default", "preset", "measured", "changed_here", "changed_for_branch", "branch_rule", "path_rule", "task_raise", "company_lock", "company_ceiling", "install_off"] as const);
export type PolicyOrigin = typeof POLICY_ORIGINS[number];
export type PolicyValues = Readonly<Record<string, PolicyValue>>;
export interface ResolvedPolicyValue { value: PolicyValue; origin: PolicyOrigin; branch?: string; rule?: string; clampedBy?: "company_lock" | "company_ceiling" }
export type PolicyIssue = "invalid_input" | "invalid_pattern" | "not_measured" | "not_ceilinged" | "not_raisable" | "not_upward" | "no_ceiling" | "conflicting_bounds" | "work_limit";
/** Refused results have no values; disabled results have only nulls. Check status before acting. */
export interface ResolvedPolicy { status: "resolved" | "disabled" | "refused"; values: Record<string, ResolvedPolicyValue>; issues: PolicyIssue[] }
const map = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Reject accessors, inherited data and symbol keys before zod reads a value. Strict schemas reject all unknown keys, including pollution keys. */
export function policyDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
const plain = z.unknown().refine(policyDataObject);
function boundedArray<T extends z.ZodType>(item: T, maximum: number) {
  return z.unknown().refine((value) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).every((key) => typeof key === "string" && (key === "length" || /^(0|[1-9][0-9]*)$/u.test(key))
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined))
    .pipe(z.array(item).max(maximum));
}
const shape = Object.fromEntries(POLICY_FIELDS.map((row) => {
  let schema: z.ZodType = row.kind === "boolean" ? z.boolean() : row.kind === "number" ? z.number().finite().nonnegative() : z.enum(row.order as [string, ...string[]]);
  if (row.id === "ci_fix_rounds") schema = z.number().int().min(0).max(CI_FIX_ROUNDS_MAX);
  if (row.id === "round_time_minutes") schema = z.number().int().min(TEST_ENV_ROUND_BUDGET_MIN.min).max(TEST_ENV_ROUND_BUDGET_MIN.max);
  if (row.today === null) schema = schema.nullable();
  return [row.id, schema.optional()];
}));
const valuesSchema = plain.pipe(z.object(shape).strict());
const RULES_MAX = 100;
const CHANGED_PATHS_MAX = 2000;
// Allow one linear pattern+path pass for every permitted pair. Ambiguous NFAs can consume more;
// refuse that aggregate work rather than silently skipping a potentially tightening rule.
const MATCH_WORK_MAX = RULES_MAX * CHANGED_PATHS_MAX * (POLICY_PATTERN_MAX + POLICY_PATH_MAX + 1);
const pathSchema = z.string().max(POLICY_PATH_MAX).refine((value) => validPolicyPath(value));
const ruleSchema = plain.pipe(z.object({ pattern: z.string(), values: valuesSchema }).strict());
const branchOverrideSchema = plain.pipe(z.object({ branch: pathSchema, values: valuesSchema }).strict());
const rowsShape = {
  preset: z.enum(["lightweight", "balanced", "careful"]).optional(), measured: valuesSchema.optional(), project: valuesSchema.optional(),
  branchOverrides: boundedArray(branchOverrideSchema, RULES_MAX).optional(), branchRules: boundedArray(ruleSchema, RULES_MAX).optional(), pathRules: boundedArray(ruleSchema, RULES_MAX).optional(),
  companyLocks: valuesSchema.optional(), companyCeilings: valuesSchema.optional(),
};
const requestShape = { branch: pathSchema.optional(), changedPaths: boundedArray(pathSchema, CHANGED_PATHS_MAX).optional(), taskRaises: valuesSchema.optional() };
export const PolicyRowsSchema = plain.pipe(z.object(rowsShape).strict());
export const PolicyResolveRequestSchema = plain.pipe(z.object(requestShape).strict());
const inputSchema = plain.pipe(z.object({ ...rowsShape, ...requestShape }).strict());
const operatorSchema = plain.pipe(z.object({ installOff: z.boolean().optional() }).strict());
/** Trusted installation configuration, supplied separately from customer rows and task requests. */
export type PolicyOperatorOptions = z.infer<typeof operatorSchema>;
export type PolicyRows = z.infer<typeof PolicyRowsSchema>;
export type PolicyResolveRequest = z.infer<typeof PolicyResolveRequestSchema>;
export type PolicyResolveInput = z.infer<typeof inputSchema>;
const upward = (row: PolicyField, a: PolicyValue, b: PolicyValue): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return row.order === undefined ? Number(a) - Number(b) : row.order.indexOf(String(a)) - row.order.indexOf(String(b));
};
const stricter = (row: PolicyField, a: PolicyValue, b: PolicyValue): boolean => {
  if (a === null) return false;
  if (b === null) return true;
  return row.stricter === "lower" ? upward(row, a, b) < 0 : upward(row, a, b) > 0;
};
const asValues = (value: unknown): PolicyValues => value as PolicyValues;
function expand(values: PolicyValues, floors = false): PolicyValues {
  const level = values["preset_level"];
  if (typeof level !== "string" || !Object.hasOwn(POLICY_PRESETS, level)) return values;
  const expanded = Object.assign(map<PolicyValue>(), POLICY_PRESETS[level as keyof typeof POLICY_PRESETS]);
  for (const row of POLICY_FIELDS) {
    const explicit = values[row.id];
    // Floors use the field's upward order, including numeric minimums. An explicit lock cannot
    // weaken the company's preset minimum; ordinary project patches may override their preset.
    if (explicit !== undefined && (!floors || upward(row, explicit, expanded[row.id]!) > 0)) expanded[row.id] = explicit;
  }
  return expanded;
}
const refuse = (issue: PolicyIssue): ResolvedPolicy => ({ status: "refused", values: map(), issues: [issue] });

/** Total over untrusted data, pure and deterministic. No storage, clocks, environment, repo files or network. */
export function resolvePolicy(input: unknown, operator: unknown = {}): ResolvedPolicy {
  try {
    const parsed = inputSchema.safeParse(input);
    const checkedOperator = operatorSchema.safeParse(operator);
    if (!parsed.success || !checkedOperator.success) return refuse("invalid_input");
    return resolveParsed(parsed.data, checkedOperator.data);
  } catch {
    // Also handles revoked proxies and getters supplied by in-process callers; never echo their error.
    return refuse("invalid_input");
  }
}

function resolveParsed(input: PolicyResolveInput, operator: PolicyOperatorOptions): ResolvedPolicy {
  if ((input.branchRules?.length ?? 0) + (input.pathRules?.length ?? 0) > RULES_MAX) return refuse("invalid_input");
  const values = map<ResolvedPolicyValue>(); const issues = new Set<PolicyIssue>();
  for (const row of POLICY_FIELDS) values[row.id] = { value: row.today, origin: row.compatibility ? "default" : "rovara_default" };
  const apply = (raw: unknown, origin: PolicyOrigin, branch?: string): void => {
    if (raw === undefined) return;
    const explicit = asValues(raw);
    const patch = expand(explicit);
    for (const row of POLICY_FIELDS) {
      const next = patch[row.id];
      if (next !== undefined) values[row.id] = { value: next, origin: explicit[row.id] === undefined ? "preset" : origin, ...(branch === undefined ? {} : { branch: inertEvidenceText(branch, 256) }) };
    }
  };
  if (input.preset !== undefined) apply(POLICY_PRESETS[input.preset], "preset");
  for (const row of POLICY_FIELDS) if (input.measured?.[row.id] !== undefined && !row.measured) return refuse("not_measured");
  apply(input.measured, "measured"); apply(input.project, "changed_here");
  // Exact per-branch changes sit alongside project changes in step 4 (TE-C2).
  const branchRows = input.branchOverrides?.filter((entry) => entry.branch === input.branch) ?? [];
  if (branchRows.length > 1) return refuse("invalid_input");
  for (const entry of branchRows) apply(entry.values, "changed_for_branch", entry.branch);

  // Sort by source/pattern for stable origin chips on equal values, independent of caller rule order.
  const rules = [
    ...(input.branchRules ?? []).map((entry) => ({ ...entry, origin: "branch_rule" as const })),
    ...(input.pathRules ?? []).map((entry) => ({ ...entry, origin: "path_rule" as const })),
  ].sort((a, b) => a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0);
  let matchSteps = 0;
  for (const rule of rules) {
    const probe = matchPolicyGlob(rule.pattern, "probe");
    if (probe.reason === "invalid_pattern") { issues.add("invalid_pattern"); continue; }
    const paths = rule.origin === "branch_rule" ? (input.branch === undefined ? [] : [input.branch]) : input.changedPaths ?? [];
    let matched = false;
    for (const path of paths) {
      const result = matchPolicyGlob(rule.pattern, path);
      matchSteps += result.steps;
      // Bound the aggregate rule × changed-path product as well as each individual match.
      if (matchSteps > MATCH_WORK_MAX) return refuse("work_limit");
      if (result.matched) { matched = true; break; }
    }
    if (!matched) continue;
    const patch = expand(asValues(rule.values));
    for (const row of POLICY_FIELDS) {
      const next = patch[row.id];
      if (next !== undefined && stricter(row, next, values[row.id]!.value)) values[row.id] = { value: next, origin: rule.values[row.id] === undefined ? "preset" : rule.origin, rule: inertEvidenceText(rule.pattern, 256) };
    }
  }
  for (const row of POLICY_FIELDS) {
    const next = input.taskRaises?.[row.id] as PolicyValue | undefined;
    if (next === undefined) continue;
    if (!row.raisable) { issues.add("not_raisable"); continue; }
    if (row.ceilinged && typeof input.companyCeilings?.[row.id] !== "number") { issues.add("no_ceiling"); continue; }
    const current = values[row.id]!.value;
    if (next === null || row.ceilinged && current === null || upward(row, next, current) <= 0) { issues.add("not_upward"); continue; }
    values[row.id] = { value: next, origin: "task_raise" };
  }
  const locks = expand(asValues(input.companyLocks ?? {}), true);
  for (const row of POLICY_FIELDS) {
    const floor = locks[row.id]; const ceiling = input.companyCeilings?.[row.id] as PolicyValue | undefined;
    if (ceiling !== undefined && !row.ceilinged) return refuse("not_ceilinged");
    if (typeof floor === "number" && typeof ceiling === "number" && floor > ceiling) return refuse("conflicting_bounds");
    if (row.lockable && floor !== undefined && floor !== null && upward(row, values[row.id]!.value, floor) < 0) values[row.id] = { value: floor, origin: "company_lock", clampedBy: "company_lock" };
    if (typeof ceiling === "number" && (values[row.id]!.value === null || Number(values[row.id]!.value) > ceiling)) values[row.id] = { value: ceiling, origin: "company_ceiling", clampedBy: "company_ceiling" };
  }
  // The install operator's emergency stop alone overrides locks, after all customer layers.
  if (operator.installOff === true) {
    for (const row of POLICY_FIELDS) values[row.id] = { value: null, origin: "install_off" };
  }
  return { status: operator.installOff === true ? "disabled" : "resolved", values, issues: [...issues].sort() };
}
