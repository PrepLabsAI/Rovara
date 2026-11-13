import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { matchPolicyGlob } from "../../packages/contracts/src/policy-glob.js";
import { resolvePolicy } from "../../packages/contracts/src/policy.js";

describe("policy glob", () => {
  it("glob double star crosses segments and accepts zero directories", () => {
    for (const [pattern, path, matched] of [["src/*", "src/a/b", false], ["src/**", "src/a/b", true], ["**/a.ts", "a.ts", true], ["src/**/a.ts", "src/a.ts", true], ["src/**/a.ts", "src/x/y/a.ts", true], ["**/a.ts", "xa.ts", false], ["a?c", "abc", true], ["a?c", "a/c", false], ["a[bc]", "ab", false], ["a[bc]", "a[bc]", true], ["src/🐈?", "src/🐈x", true]] as const) expect(matchPolicyGlob(pattern, path).matched, `${pattern} ${path}`).toBe(matched);
  });
  it("pattern refusal and path refusal never turn hostile input into a match", () => {
    for (const pattern of ["*".repeat(1_000_000), "x".repeat(1024 * 1024), "**/".repeat(1000), "a\0*", "\u202e**", "a\u200d*", "a\ufe0f*", "../**", "/**", "C:/**", "a/../**", "a\\**"]) {
      expect(matchPolicyGlob(pattern, "a/b")).toMatchObject({ matched: false, reason: "invalid_pattern" });
      expect(resolvePolicy({ branch: "a/b", branchRules: [{ pattern, values: { real_check: "rovara_real_run" } }] }).values["real_check"]?.value).toBe("their_ci_fix");
    }
    for (const path of ["../x", "/etc/x", "a/../x", "C:/x", "a\0b", "x\u202e", "x".repeat(513)]) expect(matchPolicyGlob("**", path)).toMatchObject({ matched: false, reason: "invalid_path" });
  });
  it("bounds work linearly for adversarial patterns, with N vs 4N timing", () => {
    const pattern = "**/".repeat(70) + "z";
    const measure = (n: number) => {
      const path = "a/".repeat(n / 2 - 1) + "aa";
      const start = performance.now();
      for (let i = 0; i < 100; i += 1) {
        const got = matchPolicyGlob(pattern, path);
        expect(got.matched).toBe(false);
        expect(got.reason).toBeUndefined();
        expect(got.steps).toBeGreaterThan(n);
        expect(got.steps).toBeLessThanOrEqual(1024 * (pattern.length + path.length + 1));
      }
      return performance.now() - start;
    };
    const n = measure(128); const fourN = measure(512);
    console.info(`policy glob timing N=${n.toFixed(2)}ms 4N=${fourN.toFixed(2)}ms`);
    expect(fourN).toBeLessThan(n * 12 + 300);
  });
});

it("refuses an aggregate matcher work limit instead of ignoring an expensive lock rule", () => {
  const got = resolvePolicy({ changedPaths: Array(2000).fill("a/".repeat(250) + "x"), pathRules: [{ pattern: "**/".repeat(70) + "z", values: { real_check: "rovara_real_run" } }] });
  expect(got.status).toBe("refused");
  expect(got.issues).toContain("work_limit");
  expect(got.values).toEqual({});
});
