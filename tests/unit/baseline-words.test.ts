// TE-C1: the baseline per base commit, the pure parts (contracts): the row's shape, the asked-for wire fields, and the one line the pull request says.
import { describe, expect, it } from "vitest";
import {
  BASELINE_ANCESTOR_MAX, BASELINE_CANDIDATES_MAX, BASELINE_WRITERS, BaselineCandidateSchema, BaselineRowSchema, EvidenceBaselineSchema, EvidenceRawSchema, RawBaselineSchema, TEST_ENV_BASELINE_FEATURE,
  TestEnvTaskPlanSchema, WORKER_INVOCATION_FEATURES, baselineLine, baselineSetIsWhole,
} from "@agentx/contracts";
import { failingSetIsWhole } from "../../packages/broker/src/core/test-env/nightly.js";

const SHA = "4f2a9c1".padEnd(40, "0");
const row = (over: Record<string, unknown> = {}) => ({
  recordedAt: "2026-11-13T06:00:00.000Z", envRevision: 1, branch: "main", headSha: SHA, finishedAt: "2026-11-13T05:00:00.000Z", writer: "nightly",
  tests: { total: 10, passed: 7, failed: 2, skipped: 1 }, failed: ["a.py::x", "a.py::y"], flaky: ["b.py::z"], ...over,
});

describe("the baseline row and the wire fields", () => {
  it("a row is the nightly baseline's own field rules plus the writer, strict, and the writer is one of three words", () => {
    expect(BaselineRowSchema.safeParse(row()).success).toBe(true);
    expect(BASELINE_WRITERS).toEqual(["nightly", "readiness", "final_round"]);
    for (const bad of [{ writer: "task" }, { writer: undefined }, { headSha: "abc" }, { envRevision: 0 }, { extra: 1 }, { failed: Array.from({ length: 501 }, (_, i) => `t${String(i)}`) }, { coverageMapRef: "a".repeat(64) }]) {
      expect(BaselineRowSchema.safeParse(row(bad)).success).toBe(false);
    }
    // No person is named in a row: nothing to erase for a person.
    expect(Object.keys(BaselineRowSchema.parse(row())).sort()).toEqual(["branch", "envRevision", "failed", "finishedAt", "flaky", "headSha", "recordedAt", "tests", "writer"]);
  });

  it("the whole-set rule is the nightly's own rule", () => {
    for (const baseline of [
      { failed: ["a"], failedUnlisted: 1, tests: { total: 5, passed: 3, failed: 2, skipped: 0 } }, { failed: ["a"], failedUnlisted: 0, tests: { total: 5, passed: 3, failed: 2, skipped: 0 } },
      { failed: [], tests: { total: 5, passed: 5, failed: 0, skipped: 0 } }, { failed: ["a", "b"], tests: { total: 5, passed: 3, failed: 1, skipped: 1 } },
    ]) expect(baselineSetIsWhole(baseline)).toBe(failingSetIsWhole(baseline));
  });

  it("the candidates and the worker's claim are shas and an integer 0 to 50, strict", () => {
    expect(BASELINE_ANCESTOR_MAX).toBe(50);
    expect(BASELINE_CANDIDATES_MAX).toBe(5);
    expect(BaselineCandidateSchema.safeParse({ sha: SHA }).success).toBe(true);
    expect(BaselineCandidateSchema.safeParse({ sha: "main" }).success).toBe(false);
    expect(BaselineCandidateSchema.safeParse({ sha: SHA.toUpperCase() }).success).toBe(false);
    for (const commitsBack of [0, 1, 50]) expect(RawBaselineSchema.safeParse({ sha: SHA, commitsBack }).success).toBe(true);
    for (const commitsBack of [-1, 51, 1.5, Number.NaN, Infinity, "3"]) expect(RawBaselineSchema.safeParse({ sha: SHA, commitsBack }).success).toBe(false);
    expect(RawBaselineSchema.safeParse({ sha: SHA, commitsBack: 1, extra: true }).success).toBe(false);
  });

  it("the raw evidence file takes an optional baseline, and a file without it still reads (old workers)", () => {
    const raw = { schemaVersion: 1, candidateDigest: "a".repeat(64), checks: [] };
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
    expect(EvidenceRawSchema.safeParse({ ...raw, baseline: { sha: SHA, commitsBack: 3 } }).success).toBe(true);
    expect(EvidenceRawSchema.safeParse({ ...raw, baseline: { sha: SHA, commitsBack: 99 } }).success).toBe(false);
  });

  it("the task plan takes at most five candidates, never an empty list, and the feature is one a worker lists", () => {
    const plan = { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "u", kind: "test" }] };
    expect(TestEnvTaskPlanSchema.safeParse(plan).success).toBe(true);
    const sha = (n: number) => String(n).repeat(40).slice(0, 40);
    expect(TestEnvTaskPlanSchema.safeParse({ ...plan, baselineCandidates: [{ sha: sha(1) }] }).success).toBe(true);
    expect(TestEnvTaskPlanSchema.safeParse({ ...plan, baselineCandidates: [] }).success).toBe(false);
    expect(TestEnvTaskPlanSchema.safeParse({ ...plan, baselineCandidates: [1, 2, 3, 4, 5, 6].map((n) => ({ sha: sha(n) })) }).success).toBe(false);
    expect(TestEnvTaskPlanSchema.safeParse({ ...plan, baselineCandidates: [{ sha: sha(1), extra: 1 }] }).success).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_ENV_BASELINE_FEATURE);
  });
});

describe("the line the pull request says", () => {
  const base = { branch: "main", shortSha: "4f2a9c1", writer: "nightly" as const, ageHours: 2, commitsBack: 0, partial: false, knownFailing: 3, flaky: 2 };

  it("says which run it compared with, how old it was, and the counts", () => {
    expect(baselineLine(base)).toBe("Compared with main at 4f2a9c1 (nightly, 2 h old): 3 known failing, 2 flaky");
    expect(baselineLine({ ...base, commitsBack: 3, partial: true })).toBe("Compared with main at 4f2a9c1 (nightly, 2 h old, 3 commits back; partial): 3 known failing, 2 flaky");
    expect(baselineLine({ ...base, commitsBack: 1, partial: true, ageHours: 0, knownFailing: 0, flaky: 0 })).toBe("Compared with main at 4f2a9c1 (nightly, under 1 h old, 1 commit back; partial): 0 known failing, 0 flaky");
    expect(baselineLine({ ...base, writer: "readiness", knownFailing: 1234 })).toBe("Compared with main at 4f2a9c1 (readiness run, 2 h old): 1,234 known failing, 2 flaky");
    expect(baselineLine({ ...base, writer: "final_round" })).toContain("(final round, 2 h old)");
  });

  it("a hostile branch name is inert, and a hostile or short sha is not printed as it came", () => {
    const hostile = baselineLine({ ...base, branch: "[x](https://evil.example/a) @owner #123 <img src=x> ENG-42\n# heading ```" });
    expect(hostile).not.toMatch(/https:\/\/(?!‍)|<img|\n|(?<![‍])@owner|#123/u);
    expect(hostile.split("\n")).toHaveLength(1);
    expect(hostile.startsWith("Compared with ")).toBe(true);
    expect(baselineLine({ ...base, shortSha: "../../etc" })).toContain("an unknown commit");
    expect(baselineLine({ ...base, branch: "" })).toContain("Compared with the base branch at 4f2a9c1");
    // A megabyte of branch name is cut before anything else is done, and is fast.
    const started = Date.now();
    expect(baselineLine({ ...base, branch: "a".repeat(1_000_000) }).length).toBeLessThan(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the stored words (what a pull request reads back) are strict, and a number that is not a count is refused", () => {
    const stored = { schemaVersion: 1, sha: SHA, branch: "main", writer: "nightly", commitsBack: 2, ageHours: 5, knownFailing: 1, flaky: 0 };
    expect(EvidenceBaselineSchema.safeParse(stored).success).toBe(true);
    for (const bad of [{ commitsBack: 51 }, { ageHours: -1 }, { knownFailing: Number.NaN }, { flaky: 1.5 }, { writer: "task" }, { sha: "abc" }, { extra: 1 }]) expect(EvidenceBaselineSchema.safeParse({ ...stored, ...bad }).success).toBe(false);
  });
});
