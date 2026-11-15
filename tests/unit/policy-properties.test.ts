import { expect, it } from "vitest";
import { POLICY_FIELDS, resolvePolicy, type PolicyField, type PolicyValue } from "../../packages/contracts/src/policy.js";

const SEED = 0xd1002026;
function generator(seed: number): () => number { let state = seed; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; }
const draw = (field: PolicyField, next: () => number): PolicyValue => field.order?.[next() % field.order.length] ?? (field.kind === "boolean" ? next() % 2 === 0 : field.id === "ci_fix_rounds" ? next() % 4 : field.id === "round_time_minutes" ? 30 + next() % 91 : next() % 100);
const rank = (field: PolicyField, value: PolicyValue): number => value === null ? -1 : field.order?.indexOf(String(value)) ?? Number(value);

it(`floor property: every field survives all lower layers; seed=${SEED}; cases=10000`, () => {
  const next = generator(SEED);
  for (let i = 0; i < 10_000; i += 1) {
    const field = POLICY_FIELDS[i % POLICY_FIELDS.length]!;
    const lock = draw(field, next); const candidate = draw(field, next);
    const input = { project: { [field.id]: candidate }, branch: "release/a", changedPaths: ["pay/a"],
      branchOverrides: [{ branch: "release/a", values: { [field.id]: draw(field, next) } }],
      branchRules: [{ pattern: "**", values: { [field.id]: draw(field, next) } }], pathRules: [{ pattern: "**", values: { [field.id]: draw(field, next) } }],
      taskRaises: { [field.id]: draw(field, next) }, companyLocks: { [field.id]: lock }, ...(field.measured ? { measured: { [field.id]: draw(field, next) } } : {}) };
    const got = resolvePolicy(input);
    expect(got.status, `seed=${SEED}, case=${i}`).toBe("resolved");
    expect(rank(field, got.values[field.id]!.value), `seed=${SEED}, case=${i}, field=${field.id}`).toBeGreaterThanOrEqual(rank(field, lock));
  }
});

it(`shuffled-rule property: fieldwise strictest; seed=${SEED + 1}; cases=10000`, () => {
  const next = generator(SEED + 1);
  for (let i = 0; i < 10_000; i += 1) {
    const field = POLICY_FIELDS[i % POLICY_FIELDS.length]!;
    const rules = Array.from({ length: 3 }, (_, j) => ({ pattern: ["**", "release/*", "release/a"][j]!, values: { [field.id]: draw(field, next) } }));
    const got = resolvePolicy({ branch: "release/a", branchRules: rules });
    const shuffled = [...rules];
    for (let j = shuffled.length - 1; j > 0; j -= 1) { const k = next() % (j + 1); [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!]; }
    expect(got, `seed=${SEED + 1}, case=${i}`).toEqual(resolvePolicy({ branch: "release/a", branchRules: shuffled }));
    const ranks = rules.map((rule) => rank(field, rule.values[field.id]!));
    const rankGot = rank(field, got.values[field.id]!.value);
    if (field.stricter === "lower") expect(rankGot).toBeLessThanOrEqual(Math.min(...ranks));
    else expect(rankGot).toBeGreaterThanOrEqual(Math.max(...ranks));
  }
});

it(`task bounds property: upward and within ceiling; seed=${SEED + 2}; cases=10000`, () => {
  const next = generator(SEED + 2);
  for (let i = 0; i < 10_000; i += 1) {
    const initial = next() % 100; const raise = next() % 150; const ceiling = initial + next() % 100;
    const got = resolvePolicy({ project: { model_budget_usd: initial }, taskRaises: { model_budget_usd: raise }, companyCeilings: { model_budget_usd: ceiling } });
    expect(got.values["model_budget_usd"]?.value, `seed=${SEED + 2}, case=${i}`).toBe(Math.min(Math.max(initial, raise), ceiling));
  }
});

it(`preset and multifield floor property with ceilings and operator off; seed=${SEED + 3}; cases=10000`, () => {
  const next = generator(SEED + 3);
  for (let i = 0; i < 10_000; i += 1) {
    const careful = i % 2 === 0;
    // Independent minima, not computed by the production preset expansion/comparator.
    const floor: Record<string, PolicyValue> = { preset_level: careful ? "careful" : "balanced", real_check: careful ? "rovara_real_run" : "their_ci_fix", ci_fix_rounds: 3,
      round_time_minutes: 30 + next() % 91, extra_review: true, after_merge_revert: "offer_revert", mutation_spot_check: careful ? "on" : "off", prompt_side_by_side: careful ? "on" : "off",
      model_budget_usd: next() % 100, machine_budget_minutes: next() % 100 };
    const patch = () => Object.fromEntries(POLICY_FIELDS.map((field) => [field.id, draw(field, next)]));
    const ceiling = Number(floor["model_budget_usd"]) + next() % 100;
    const off = i % 7 === 0;
    const got = resolvePolicy({ project: patch(), branch: "release/a", changedPaths: ["pay/a"], branchOverrides: [{ branch: "release/a", values: patch() }],
      measured: Object.fromEntries(POLICY_FIELDS.filter((field) => field.measured).map((field) => [field.id, draw(field, next)])),
      branchRules: [{ pattern: "**", values: patch() }], pathRules: [{ pattern: "**", values: patch() }], taskRaises: patch(),
      companyLocks: { ...floor, real_check: "sandbox_only", extra_review: false, ci_fix_rounds: 0, mutation_spot_check: "off", prompt_side_by_side: "off" },
      companyCeilings: { model_budget_usd: ceiling, machine_budget_minutes: Number(floor["machine_budget_minutes"]) + next() % 100 } }, { installOff: off });
    expect(got.status, `seed=${SEED + 3}, case=${i}`).toBe(off ? "disabled" : "resolved");
    for (const field of POLICY_FIELDS) {
      const result = got.values[field.id]!;
      if (off) expect(result, `seed=${SEED + 3}, case=${i}, field=${field.id}`).toEqual({ value: null, origin: "install_off" });
      else expect(rank(field, result.value), `seed=${SEED + 3}, case=${i}, field=${field.id}`).toBeGreaterThanOrEqual(rank(field, floor[field.id]!));
    }
    if (!off) expect(got.values["model_budget_usd"]!.value).toBeLessThanOrEqual(ceiling);
  }
});
