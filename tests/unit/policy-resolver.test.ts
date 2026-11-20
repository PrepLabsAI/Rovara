import { describe, expect, it } from "vitest";
import { POLICY_FIELDS, POLICY_ORIGINS, resolvePolicy } from "../../packages/contracts/src/policy.js";
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
  it("absent rows preserve every today's value without applying Balanced", () => {
    // rovara-code.ts:40; test-environment.ts:42; second-review.ts:72–74;
    // broker/core/ci-fix/ci-fix.ts:44–49; broker/core/cost/limits.ts:6,16–20.
    // The five compatibility defaults are the approved Q1 answer: no current setting; feature not built yet.
    const today = { preset_level: null, real_check: "their_ci_fix", ci_fix_rounds: CI_FIX_ROUNDS_MAX, round_time_minutes: TEST_ENV_ROUND_BUDGET_MIN.default,
      model_budget_usd: null, machine_budget_minutes: null, extra_review: configuredSecondReviewMode({}) !== "off", after_merge_revert: "off", mutation_spot_check: "off", prompt_side_by_side: "off", browser_evidence: "off", device_evidence: "off" };
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
    expect(value({ companyLocks: { real_check: "rovara_real_run" } })?.origin).toBe("company_minimum");
    expect(value({ project: { model_budget_usd: 9 }, companyCeilings: { model_budget_usd: 5 } }, "model_budget_usd")?.origin).toBe("company_limit");
    expect(resolvePolicy({}, { installOff: true }).values["real_check"]?.origin).toBe("install_off");
    expect(new Set(POLICY_ORIGINS).size).toBe(14);
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
