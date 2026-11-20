// TE-A6 Parts B and C (DEC 254zt): a failing check names the failing tests and the change that most likely broke each, or says unknown. Without per-test data the per-check output is byte for byte what it always was.
import { describe, expect, it } from "vitest";
import { EVIDENCE_RENDER_LIMITS, EvidencePackReadSchema, EvidencePackSchema, EvidencePackV2Schema, FAILURE_UNKNOWN_WORDS, FailureCausesFileSchema, failureCauseWords, renderEvidence, type EvidencePackV2 } from "../../packages/contracts/src/index.js";
import { v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const SHA = "a".repeat(40);
const change = (path: string, commit?: string) => ({ kind: "change" as const, paths: [path], pathsCount: 1, ...(commit === undefined ? {} : { commit }), basis: ["named_in_failure" as const] });
const failedPack = (causes?: unknown, names = ["tests/cart.test.ts::applies discount", "tests/cart.test.ts::rounds"]): EvidencePackV2 => {
  const pack = clone(v2Pack()) as unknown as { checks: Array<Record<string, unknown>> };
  pack.checks[0] = {
    ...pack.checks[0]!, before: "passed", after: "failed", class: "regression", exitCode: 1,
    tests: { total: names.length + 1, passed: 1, failed: names.length, skipped: 0, errored: 0, names: [...names.map((name) => ({ name, status: "failed" })), { name: "tests/a.py::one", status: "passed" }], newTests: [], ...(causes === undefined ? {} : { failureCauses: causes }) },
  };
  return pack as unknown as EvidencePackV2;
};

describe("the report names the failing tests and the change that likely broke each", () => {

  it("says a change with several files, and with no known commit, in fixed words", () => {
    const cause = { kind: "change" as const, paths: ["src/a.ts", "src/b.ts", "src/c.ts"], pathsCount: 5, basis: ["named_in_failure" as const] };
    expect(failureCauseWords(cause, (value) => value)).toBe("likely broken by a change to src/a.ts, src/b.ts, src/c.ts and 2 more files");
    expect(failureCauseWords({ ...cause, paths: ["src/a.ts"], pathsCount: 2 }, (value) => value)).toBe("likely broken by a change to src/a.ts and 1 more file");
    for (const reason of Object.keys(FAILURE_UNKNOWN_WORDS)) expect(failureCauseWords({ kind: "unknown", reason: reason as never }, (value) => value)).toBe(`unknown (${FAILURE_UNKNOWN_WORDS[reason as keyof typeof FAILURE_UNKNOWN_WORDS]})`);
    expect(failureCauseWords({ kind: "unknown", reason: "made_up" as never }, (value) => value)).toBe("unknown (not known)");
  });

  it("keeps the commit on a line that is cut at 200 characters, because the commit comes before the paths", () => {
    const cause = { kind: "change" as const, paths: ["a/" + "x".repeat(110), "b/" + "y".repeat(110), "c/" + "z".repeat(110)], pathsCount: 3, commit: SHA, basis: ["named_in_failure" as const] };
    const line = renderEvidence(failedPack([{ testId: "tests/cart.test.ts::applies discount", cause }, { testId: "tests/cart.test.ts::rounds", cause: { kind: "unknown", reason: "weak_evidence" } }])).body.find((row) => row.startsWith("  - tests/cart.test.ts::applies"))!;
    expect(line.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.bulletMax + 4);
    expect(line).toContain("(commit aaaaaaa)");
  });

  it("lists at most ten failing tests in all and counts the rest; the text stays bounded", () => {
    const ids = Array.from({ length: 14 }, (_, index) => `tests/t.test.ts::case ${String(index)}`);
    const out = renderEvidence(failedPack(ids.map((testId) => ({ testId, cause: change("src/" + "x".repeat(110) + ".ts", SHA) })), ids));
    const subs = out.body.filter((line) => line.startsWith("  - "));
    expect(subs).toHaveLength(EVIDENCE_RENDER_LIMITS.failureCausesListed);
    expect(out.body).toContain("- and 4 more failing tests with a cause not listed");
    expect(out.text.length).toBeLessThan(EVIDENCE_RENDER_LIMITS.textMax);
  });

});

describe("the pack carries the causes", () => {
  const causes = [{ testId: "tests/cart.test.ts::applies discount", cause: change("src/cart.ts", SHA) }, { testId: "tests/cart.test.ts::rounds", cause: { kind: "unknown" as const, reason: "weak_evidence" as const } }];

  it("the strict writers (v1 and v2) and the reader accept them, and a v1 pack without them is untouched", () => {
    expect(EvidencePackV2Schema.safeParse(failedPack(causes)).success).toBe(true);
    const v1 = clone(v1Pack()) as unknown as { checks: Array<{ tests: Record<string, unknown>; after: string }> };
    expect(EvidencePackSchema.safeParse(v1).success).toBe(true);
    expect(JSON.stringify(EvidencePackSchema.parse(v1))).not.toContain("failureCauses");
    v1.checks[0]!.after = "failed";
    v1.checks[0]!.tests = { total: 2, passed: 1, failed: 1, skipped: 0, errored: 0, names: [{ name: "tests/a.py::two", status: "failed" }, { name: "tests/a.py::one", status: "passed" }], newTests: [], failureCauses: [{ testId: "tests/a.py::two", cause: change("src/a.py") }] };
    expect(EvidencePackSchema.safeParse(v1).success).toBe(true);
    expect(EvidencePackReadSchema.parse(v1).checks[0]!.tests!.failureCauses).toHaveLength(1);
    (v1.checks[0]!.tests as { failureCauses: Array<{ testId: string }> }).failureCauses[0]!.testId = "tests/a.py::one";
    expect(EvidencePackSchema.safeParse(v1).success).toBe(false);
  });

  it("refuses a cause for a test the check does not show failing, and two causes for one test", () => {
    expect(EvidencePackV2Schema.safeParse(failedPack([{ testId: "tests/a.py::one", cause: change("src/cart.ts") }])).success).toBe(false);
    expect(EvidencePackV2Schema.safeParse(failedPack([{ testId: "nope", cause: change("src/cart.ts") }])).success).toBe(false);
    expect(EvidencePackV2Schema.safeParse(failedPack([...causes, ...causes])).success).toBe(false);
  });

  it("the worker's file is bound to a digest and to at most 64 checks", () => {
    const file = { schemaVersion: 1, candidateDigest: "d".repeat(64), checks: [{ checkId: "readiness:0", causes }] };
    expect(FailureCausesFileSchema.safeParse(file).success).toBe(true);
    expect(FailureCausesFileSchema.safeParse({ ...file, candidateDigest: "short" }).success).toBe(false);
    expect(FailureCausesFileSchema.safeParse({ ...file, checks: [{ checkId: "readiness:0", causes: [] }] }).success).toBe(false);
    expect(FailureCausesFileSchema.safeParse({ ...file, extra: 1 }).success).toBe(false);
    expect(FailureCausesFileSchema.safeParse({ ...file, checks: [file.checks[0], file.checks[0]] }).success).toBe(false);
  });
});
