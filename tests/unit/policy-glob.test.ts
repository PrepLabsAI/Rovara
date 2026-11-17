import { describe, expect, it } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
import { POLICY_PATH_MAX, POLICY_PATTERN_MAX, matchPolicyGlob } from "../../packages/contracts/src/policy-glob.js";
import { resolvePolicy } from "../../packages/contracts/src/policy.js";

describe("policy glob", () => {
  it("stops dead matches and charges only active states", () => {
    const short = matchPolicyGlob("services/payments/**/*.ts", "p");
    const long = matchPolicyGlob("services/payments/**/*.ts", "packages/" + "x".repeat(500));
    expect(short.matched).toBe(false);
    expect(long.matched).toBe(false);
    expect(long.steps).toBe(short.steps);
    expect(short.steps).toBeLessThanOrEqual(30);
    expect(matchPolicyGlob("a".repeat(256), "a".repeat(256)).steps).toBeLessThan(1_100);
  });
  it("resolves 100 rules against 2000 realistic paths, including a last-path match", () => {
    const changedPaths = Array.from({ length: 2000 }, (_, i) => `packages/some-module-${i}/src/component-file-${i}.ts`);
    const pathRules = Array.from({ length: 100 }, (_, i) => ({ pattern: `services/payments-${i}/**/*.ts`, values: { real_check: "rovara_real_run" } }));
    expect(resolvePolicy({ changedPaths, pathRules })).toMatchObject({ status: "resolved", issues: [], values: { real_check: { value: "their_ci_fix" } } });
    changedPaths[1999] = "services/payments-99/x.ts";
    expect(resolvePolicy({ changedPaths, pathRules })).toMatchObject({ status: "resolved", issues: [], values: { real_check: { value: "rovara_real_run", origin: "path_rule" } } });
  });
  it("glob double star crosses segments and accepts zero directories", () => {
    for (const [pattern, path, matched] of [["src/*", "src/a/b", false], ["src/**", "src/a/b", true], ["**/a.ts", "a.ts", true], ["src/**/a.ts", "src/a.ts", true], ["src/**/a.ts", "src/x/y/a.ts", true], ["**/a.ts", "xa.ts", false], ["a?c", "abc", true], ["a?c", "a/c", false], ["a[bc]", "ab", false], ["a[bc]", "a[bc]", true], ["src/🐈?", "src/🐈x", true]] as const) expect(matchPolicyGlob(pattern, path).matched, `${pattern} ${path}`).toBe(matched);
  });
  it("pattern refusal and path refusal never turn hostile input into a match", () => {
    for (const pattern of ["*".repeat(1_000_000), "x".repeat(1024 * 1024), "**/".repeat(1000), "a\0*", "\u202e**", "a\u200d*", "a\ufe0f*", "../**", "/**", "services/**/", "C:/**", "a/../**", "a\\**"]) {
      expect(matchPolicyGlob(pattern, "a/b")).toMatchObject({ matched: false, reason: "invalid_pattern" });
      expect(resolvePolicy({ branch: "a/b", branchRules: [{ pattern, values: { real_check: "rovara_real_run" } }] }).values["real_check"]?.value).toBe("their_ci_fix");
    }
    for (const path of ["../x", "/etc/x", "a/../x", "C:/x", "a\0b", "x\u202e", "x".repeat(513)]) expect(matchPolicyGlob("**", path)).toMatchObject({ matched: false, reason: "invalid_path" });
  });
  // SCALING-CAP-BLIND: the scaling check below stays inside the caps (256-character pattern, 512-character path), so it cannot see a regression that works on input past them. One over each cap is refused with ZERO steps, however
  // much longer the input is; exactly at each cap is matched, within the step bound.
  it("the caps are 256 and 512 characters (a change to either is a decision, not a drive-by)", () => {
    expect([POLICY_PATTERN_MAX, POLICY_PATH_MAX]).toEqual([256, 512]);
  });
  it("refuses a pattern one character over its cap and a path one character over its cap with no work at all, and does the same for far longer ones", () => {
    for (const length of [257, 512, 1_000_000]) expect(matchPolicyGlob("a".repeat(length), "a"), `pattern ${String(length)}`).toEqual({ matched: false, steps: 0, reason: "invalid_pattern" });
    for (const length of [513, 1_024, 1_000_000]) expect(matchPolicyGlob("**", "a".repeat(length)), `path ${String(length)}`).toEqual({ matched: false, steps: 0, reason: "invalid_path" });
    // The same hostile shapes over the cap (alternating stars, deep directories) are refused as cheaply.
    expect(matchPolicyGlob("*?".repeat(129).slice(0, 257), "a/b").steps).toBe(0);
    expect(matchPolicyGlob("**/z", "a/".repeat(513).slice(0, 513).replace(/\/$/u, "ab")).steps).toBe(0);
  });
  it("matches a pattern exactly at its cap and a path exactly at its cap, within the step bound (control: the over-cap case above is refused)", () => {
    const pattern = `${"*".repeat(255)}z`;
    const path = `${"a".repeat(511)}z`;
    expect(pattern).toHaveLength(256);
    expect(path).toHaveLength(512);
    const result = matchPolicyGlob(pattern, path);
    expect(result.reason).toBeUndefined();
    expect(result.steps).toBeGreaterThan(0);
    expect(result.steps).toBeLessThanOrEqual(1024 * (pattern.length + path.length + 1));
  });
  it("bounds work linearly for adversarial patterns, with N vs 4N timing", () => {
    const pattern = "**/".repeat(70) + "z";
    const pathOf = (n: number) => "a/".repeat(n / 2 - 1) + "aa";
    const results = new Map<number, ReturnType<typeof matchPolicyGlob>>();
    expectLinearScaling((n) => {
      const path = pathOf(n);
      return () => { results.set(n, matchPolicyGlob(pattern, path)); };
    }, { n: 64, label: "policy glob: adversarial pattern" });
    for (const n of [64, 512]) {
      const got = results.get(n)!;
      expect(got.matched).toBe(false);
      expect(got.reason).toBeUndefined();
      expect(got.steps).toBeGreaterThan(n);
      expect(got.steps).toBeLessThanOrEqual(1024 * (pattern.length + pathOf(n).length + 1));
    }
  });
});

it("refuses an aggregate matcher work limit instead of ignoring an expensive lock rule", () => {
  const got = resolvePolicy({ changedPaths: Array(2000).fill("a/".repeat(250) + "x"), pathRules: [{ pattern: "**/".repeat(70) + "z", values: { real_check: "rovara_real_run" } }] });
  expect(got.status).toBe("refused");
  expect(got.issues).toContain("work_limit");
  expect(got.values).toEqual({});
});
