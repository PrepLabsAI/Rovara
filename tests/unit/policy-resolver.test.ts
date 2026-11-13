import { describe, expect, it } from "vitest";
import { POLICY_FIELDS, POLICY_ORIGINS, PolicyRowsSchema, resolvePolicy, type PolicyValues } from "../../packages/contracts/src/policy.js";
import { POLICY_PRESETS } from "../../packages/contracts/src/presets.js";
import { CI_FIX_ROUNDS_MAX } from "../../packages/contracts/src/rovara-code.js";
import { TEST_ENV_ROUND_BUDGET_MIN } from "../../packages/contracts/src/test-environment.js";
import { configuredSecondReviewMode } from "../../packages/contracts/src/second-review.js";
import { inertEvidenceText } from "../../packages/contracts/src/evidence-inert.js";

const value = (input: unknown, field = "real_check") => resolvePolicy(input).values[field];

describe("policy resolver", () => {
  it("ignores budget raises without a configured numeric ceiling", () => {
    for (const id of ["model_budget_usd", "machine_budget_minutes"]) {
      for (const companyCeilings of [undefined, {}, { [id]: null }]) {
        const got = resolvePolicy({ project: { [id]: 2 }, taskRaises: { [id]: 1e300 }, companyCeilings });
        expect(got.status).toBe("resolved");
        expect(got.values[id]).toEqual({ value: 2, origin: "changed_here" });
        expect(got.issues).toEqual(["no_ceiling"]);
      }
    }
  });
  it("company preset minimums expand and cannot be weakened by explicit locks", () => {
    const got = resolvePolicy({ companyLocks: { preset_level: "careful", real_check: "sandbox_only", extra_review: false, mutation_spot_check: "off", round_time_minutes: 60 }, project: { preset_level: "lightweight", extra_review: false, round_time_minutes: 30 } });
    expect(got.status).toBe("resolved");
    for (const [id, expected] of Object.entries({ preset_level: "careful", real_check: "rovara_real_run", extra_review: true, mutation_spot_check: "on", prompt_side_by_side: "on", round_time_minutes: 60 })) {
      expect(got.values[id], id).toEqual({ value: expected, origin: "company_lock", clampedBy: "company_lock" });
    }
  });
  it("Balanced company minimum beats lower project, branch, path and task settings", () => {
    const got = resolvePolicy({ companyLocks: { preset_level: "balanced" }, project: { preset_level: "lightweight", extra_review: false, after_merge_revert: "off", ci_fix_rounds: 0 },
      branch: "release/a", changedPaths: ["pay/a"], branchRules: [{ pattern: "**", values: { preset_level: "lightweight" } }],
      pathRules: [{ pattern: "**", values: { real_check: "sandbox_only" } }], taskRaises: { real_check: "their_ci_watch", extra_review: false } });
    expect(got.status).toBe("resolved");
    for (const [id, expected] of Object.entries({ preset_level: "balanced", real_check: "their_ci_fix", extra_review: true, after_merge_revert: "offer_revert", ci_fix_rounds: 3 })) {
      expect(got.values[id]?.value, id).toBe(expected);
    }
    expect(got.values["real_check"]).toEqual({ value: "their_ci_fix", origin: "company_lock", clampedBy: "company_lock" });
  });
  it("preserves preset origin for expanded fields and source origin for explicit fields", () => {
    expect(resolvePolicy({ project: { preset_level: "careful", extra_review: false } }).values).toMatchObject({
      preset_level: { value: "careful", origin: "changed_here" }, real_check: { value: "rovara_real_run", origin: "preset" }, extra_review: { value: false, origin: "changed_here" },
    });
    for (const layer of ["branchRules", "pathRules"]) {
      const got = resolvePolicy({ branch: "release/a", changedPaths: ["pay/a"], [layer]: [{ pattern: "**", values: { preset_level: "careful", extra_review: true } }] });
      expect(got.values["real_check"]).toEqual({ value: "rovara_real_run", origin: "preset", rule: inertEvidenceText("**", 256) });
      expect(got.values["extra_review"]?.origin).toBe(layer === "branchRules" ? "branch_rule" : "path_rule");
    }
  });
  it("refuses numeric settings outside today's contracts at parse time", () => {
    for (const [id, invalid] of [["ci_fix_rounds", [-1, 0.5, 4, 1e6]], ["round_time_minutes", [0.5, 29, 30.5, 121, 5000]]] as const) {
      for (const number of invalid) {
        for (const layer of ["project", "measured", "companyLocks", "companyCeilings", "taskRaises"]) {
          const input = { [layer]: { [id]: number } };
          expect(resolvePolicy(input)).toMatchObject({ status: "refused", values: {}, issues: ["invalid_input"] });
          if (layer !== "taskRaises") expect(PolicyRowsSchema.safeParse(input).success).toBe(false);
        }
      }
    }
    for (const [id, valid] of [["ci_fix_rounds", [0, 3]], ["round_time_minutes", [30, 120]]] as const) {
      for (const number of valid) expect(value({ project: { [id]: number } }, id)?.value).toBe(number);
    }
  });
  it("treats fewer automatic CI repair rounds as stricter between rules", () => {
    const got = resolvePolicy({ branch: "main", branchRules: [{ pattern: "**", values: { ci_fix_rounds: 1 } }, { pattern: "main", values: { ci_fix_rounds: 2 } }] });
    expect(got.values["ci_fix_rounds"]?.value).toBe(1);
  });
  it("customer rows cannot set the operator emergency switch", () => {
    expect(PolicyRowsSchema.safeParse({ installOff: true }).success).toBe(false);
    expect(resolvePolicy({ installOff: true })).toMatchObject({ status: "refused", values: {}, issues: ["invalid_input"] });
  });
  it("validates the separate operator parameter without throwing or accepting customer fields", () => {
    for (const operator of [null, { installOff: "true" }, { project: {} }, JSON.parse('{"__proto__":{}}') as unknown]) {
      expect(resolvePolicy({}, operator)).toEqual({ status: "refused", values: {}, issues: ["invalid_input"] });
    }
    expect(resolvePolicy({}, { installOff: false }).status).toBe("resolved");
  });
  it("retains the review probes for numeric floors, zero ceilings and absent branch context", () => {
    expect(value({ companyLocks: { model_budget_usd: 10 }, project: { model_budget_usd: 5000 } }, "model_budget_usd")?.value).toBe(5000);
    expect(value({ companyLocks: { model_budget_usd: 10 }, pathRules: [{ pattern: "**", values: { model_budget_usd: 1 } }], changedPaths: ["a"] }, "model_budget_usd")?.value).toBe(10);
    expect(value({ companyCeilings: { model_budget_usd: -0 }, taskRaises: { model_budget_usd: 5 }, project: { model_budget_usd: 1 } }, "model_budget_usd")?.value).toBe(-0);
    expect(value({ companyCeilings: { machine_budget_minutes: 0 }, taskRaises: { machine_budget_minutes: 5 } }, "machine_budget_minutes")?.value).toBe(0);
    expect(value({ branchOverrides: [{ branch: "main", values: { extra_review: true } }] }, "extra_review")?.value).toBe(false);
  });
  it("absent rows preserve every today's value without applying Balanced", () => {
    // rovara-code.ts:40; test-environment.ts:42; second-review.ts:72–74;
    // broker/core/ci-fix/ci-fix.ts:44–49; broker/core/cost/limits.ts:6,16–20.
    // The five compatibility defaults are the approved Q1 answer: no current setting; feature not built yet.
    const today = { preset_level: null, real_check: "their_ci_fix", ci_fix_rounds: CI_FIX_ROUNDS_MAX, round_time_minutes: TEST_ENV_ROUND_BUDGET_MIN.default,
      model_budget_usd: null, machine_budget_minutes: null, extra_review: configuredSecondReviewMode({}) !== "off", after_merge_revert: "off", mutation_spot_check: "off", prompt_side_by_side: "off" };
    const got = resolvePolicy({});
    expect(got.status).toBe("resolved");
    expect(Object.fromEntries(Object.entries(got.values).map(([id, row]) => [id, row.value]))).toEqual(today);
    expect(POLICY_FIELDS.map((field) => field.id)).toEqual(Object.keys(today));
    for (const field of POLICY_FIELDS) expect(got.values[field.id]).toEqual({ value: field.today, origin: field.compatibility ? "default" : "rovara_default" });
    expect(Object.getPrototypeOf(got.values)).toBeNull();
  });

  it("resolves each layer and gives every origin", () => {
    expect(value({ preset: "lightweight" })).toEqual({ value: "their_ci_watch", origin: "preset" });
    expect(value({ measured: { real_check: "sandbox_only" } })).toEqual({ value: "sandbox_only", origin: "measured" });
    expect(value({ project: { real_check: "sandbox_only" } })).toEqual({ value: "sandbox_only", origin: "changed_here" });
    expect(value({ branch: "release/a", branchOverrides: [{ branch: "release/a", values: { real_check: "their_ci_watch" } }] })).toEqual({ value: "their_ci_watch", origin: "changed_for_branch", branch: "release/a" });
    expect(value({ branch: "release/a", branchRules: [{ pattern: "release/*", values: { real_check: "rovara_real_run" } }] })?.origin).toBe("branch_rule");
    expect(value({ changedPaths: ["pay/a.ts"], pathRules: [{ pattern: "pay/**", values: { real_check: "rovara_real_run" } }] })?.origin).toBe("path_rule");
    expect(value({ taskRaises: { real_check: "rovara_real_run" } })?.origin).toBe("task_raise");
    expect(value({ companyLocks: { real_check: "rovara_real_run" } })?.origin).toBe("company_lock");
    expect(value({ project: { model_budget_usd: 9 }, companyCeilings: { model_budget_usd: 5 } }, "model_budget_usd")?.origin).toBe("company_ceiling");
    expect(resolvePolicy({}, { installOff: true }).values["real_check"]?.origin).toBe("install_off");
    expect(new Set(POLICY_ORIGINS).size).toBe(12);
  });

  it("orders measured, project, exact branch, matched rules and raises", () => {
    const input = { preset: "lightweight", measured: { round_time_minutes: 70, real_check: "rovara_real_run" }, project: { round_time_minutes: 50, real_check: "sandbox_only" }, branch: "release/a",
      branchOverrides: [{ branch: "other", values: { round_time_minutes: 95 } }, { branch: "release/a", values: { round_time_minutes: 45 } }],
      branchRules: [{ pattern: "release/*", values: { real_check: "their_ci_watch", round_time_minutes: 60 } }],
      pathRules: [{ pattern: "pay/**", values: { real_check: "their_ci_fix" } }], changedPaths: ["src/a", "pay/b"], taskRaises: { real_check: "rovara_real_run" } };
    expect(value(input)).toMatchObject({ value: "rovara_real_run", origin: "task_raise" });
    expect(value(input, "round_time_minutes")).toMatchObject({ value: 60, origin: "branch_rule" });
  });

  it("floor clamps every field, including numeric budgets", () => {
    for (const field of POLICY_FIELDS) {
      const high = field.order?.at(-1) ?? (field.kind === "boolean" ? true : field.id === "ci_fix_rounds" ? 3 : 80);
      const low = field.order?.[0] ?? (field.kind === "boolean" ? false : field.id === "round_time_minutes" ? 30 : 0);
      const got = value({ project: { [field.id]: low }, companyLocks: { [field.id]: high } }, field.id);
      expect(got, field.id).toMatchObject({ value: high, origin: "company_lock", clampedBy: "company_lock" });
    }
  });

  it("ceiling clamps both budgets, including an absent cap", () => {
    for (const id of ["model_budget_usd", "machine_budget_minutes"]) {
      expect(value({ taskRaises: { [id]: 99 }, project: { [id]: 1 }, companyCeilings: { [id]: 10 } }, id)).toEqual({ value: 10, origin: "company_ceiling", clampedBy: "company_ceiling" });
      expect(value({ companyCeilings: { [id]: 10 } }, id)?.value).toBe(10);
    }
    const conflict = resolvePolicy({ companyLocks: { model_budget_usd: 20 }, companyCeilings: { model_budget_usd: 10 } });
    expect(conflict.status).toBe("refused");
    expect(conflict.values).toEqual({});
    expect(conflict.issues).toContain("conflicting_bounds");
  });

  it("raise direction is upward only; absent budget cannot be raised to infinity", () => {
    expect(value({ taskRaises: { real_check: "sandbox_only" } })?.value).toBe("their_ci_fix");
    expect(resolvePolicy({ taskRaises: { real_check: "sandbox_only" } }).issues).toContain("not_upward");
    expect(value({ companyCeilings: { model_budget_usd: 10 }, project: { model_budget_usd: 5 }, taskRaises: { model_budget_usd: 2 } }, "model_budget_usd")?.value).toBe(5);
    expect(value({ companyCeilings: { model_budget_usd: 10 }, project: { model_budget_usd: 5 }, taskRaises: { model_budget_usd: null } }, "model_budget_usd")?.value).toBe(5);
    expect(value({ companyCeilings: { model_budget_usd: null }, taskRaises: { model_budget_usd: 5 } }, "model_budget_usd")?.value).toBeNull();
  });

  it("absent budget is not a task raise even when a ceiling exists", () => {
    const got = resolvePolicy({ taskRaises: { model_budget_usd: 5 }, companyCeilings: { model_budget_usd: 10 } });
    expect(got.values["model_budget_usd"]).toEqual({ value: 10, origin: "company_ceiling", clampedBy: "company_ceiling" });
    expect(got.issues).toContain("not_upward");
  });

  it("raisable check refuses every non-raisable field", () => {
    for (const field of POLICY_FIELDS.filter((row) => !row.raisable)) {
      const next = field.order?.at(-1) ?? (field.id === "ci_fix_rounds" ? 3 : 99);
      const got = resolvePolicy({ taskRaises: { [field.id]: next } });
      expect(got.values[field.id]?.value).toBe(field.today);
      expect(got.issues).toContain("not_raisable");
    }
    expect(value({ taskRaises: { extra_review: true } }, "extra_review")?.value).toBe(true);
  });

  it("strictest wins independent of matching rule order, budgets use the lower amount", () => {
    const rules = [{ pattern: "**", values: { model_budget_usd: 10, real_check: "their_ci_watch" } }, { pattern: "pay/**", values: { model_budget_usd: 4, real_check: "rovara_real_run" } }];
    const input = { changedPaths: ["pay/a"], project: { model_budget_usd: 20 }, pathRules: rules };
    expect(value(input, "model_budget_usd")?.value).toBe(4);
    expect(value(input)?.value).toBe("rovara_real_run");
    expect(resolvePolicy(input)).toEqual(resolvePolicy({ ...input, pathRules: [...rules].reverse() }));
  });

  it("install off is last and disables every action even under locks", () => {
    const got = resolvePolicy({ preset: "careful", companyLocks: { real_check: "rovara_real_run", extra_review: true }, taskRaises: { real_check: "rovara_real_run" } }, { installOff: true });
    expect(got.status).toBe("disabled");
    for (const row of Object.values(got.values)) expect(row).toEqual({ value: null, origin: "install_off" });
  });

  it("presets are deeply frozen, ordered data; Careful only offers reverts", () => {
    expect(Object.isFrozen(POLICY_PRESETS)).toBe(true);
    for (const preset of Object.values(POLICY_PRESETS)) expect(Object.isFrozen(preset)).toBe(true);
    for (const field of POLICY_FIELDS) {
      expect(Object.isFrozen(field)).toBe(true);
      const order = field.order;
      if (order === undefined) continue;
      const levels = ["lightweight", "balanced", "careful"] as const;
      const ranks = levels.map((level) => order.indexOf(String((POLICY_PRESETS[level] as PolicyValues)[field.id])));
      expect(ranks[0]).toBeLessThanOrEqual(ranks[1]!);
      expect(ranks[1]).toBeLessThanOrEqual(ranks[2]!);
    }
    expect(POLICY_PRESETS.careful.after_merge_revert).toBe("offer_revert");
    expect(value({ branch: "release/a", branchRules: [{ pattern: "release/*", values: { preset_level: "careful" } }] })?.value).toBe("rovara_real_run");
  });

  it("strict parsing drops unknown keys, enum values, numbers and polluted maps with fixed reasons", () => {
    const bad = [null, [], 1, { unknown: true }, { preset: "unknown" }, { changedPaths: Array(2001).fill("x") }, { branchRules: Array(101).fill({ pattern: "*", values: {} }) },
      { branchRules: [{ pattern: "*", values: {}, unknown: true }] }, { branchOverrides: [{ branch: "x", values: {}, unknown: true }] },
      { companyCeilings: { real_check: "sandbox_only" } }, { measured: { extra_review: true } }, JSON.parse('{"__proto__":{"x":true}}') as unknown];
    for (const input of bad) { const got = resolvePolicy(input); expect(got.status).toBe("refused"); expect(got.values).toEqual({}); }
    for (const layer of ["measured", "project", "taskRaises", "companyLocks", "companyCeilings"]) {
      for (const fields of [{ nope: 1 }, { real_check: "unknown" }, { model_budget_usd: Infinity }, { model_budget_usd: NaN }, { model_budget_usd: -1 }, JSON.parse('{"__proto__":{"x":true}}') as unknown]) {
        const got = resolvePolicy({ [layer]: fields }); expect(got.status, `${layer}`).toBe("refused"); expect(got.values).toEqual({});
      }
    }
    for (const field of POLICY_FIELDS.filter((row) => row.order !== undefined)) {
      for (const choice of field.order!) expect(resolvePolicy({ project: { [field.id]: choice } }).status).toBe("resolved");
      expect(resolvePolicy({ project: { [field.id]: "open" } }).status).toBe("refused");
    }
    const getter = Object.defineProperty({}, "project", { get() { throw new Error("must not escape"); }, enumerable: true });
    expect(() => resolvePolicy(getter)).not.toThrow();
    let calls = 0;
    const readableGetter = Object.defineProperty({}, "project", { get() { calls += 1; return {}; }, enumerable: true });
    expect(resolvePolicy(readableGetter).status).toBe("refused"); expect(calls).toBe(0);
    const setter = Object.defineProperty({}, "project", { set(value: unknown) { if (value !== undefined) calls += 1; }, enumerable: true });
    expect(resolvePolicy(setter).status).toBe("refused");
    expect(resolvePolicy(Object.create({ project: { extra_review: true } })).status).toBe("refused");
    expect(resolvePolicy({ [Symbol("unknown")]: true }).status).toBe("refused");
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("opaque"); } });
    expect(() => resolvePolicy(proxy)).not.toThrow();
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("origin labels use shared inert text for untrusted branches and rule patterns", () => {
    for (const raw of ["![a[b]c](url)", "[x[1]](url)", "[link][ref]", "@team", "#123", "<b>x</b>", "# title", "> quote", "---", "```", "~~~"]) {
      const got = value({ branch: raw, branchOverrides: [{ branch: raw, values: { real_check: "sandbox_only" } }] });
      expect(got?.branch).toBe(inertEvidenceText(raw, 256));
      const rule = value({ branch: raw, branchRules: [{ pattern: raw, values: { real_check: "rovara_real_run" } }] });
      expect(rule?.rule).toBe(inertEvidenceText(raw, 256));
    }
    for (const raw of ["x\u202ey", "x\ufe0fy", "x".repeat(1024 * 1024)]) expect(resolvePolicy({ branch: raw }).status).toBe("refused");
  });
});
