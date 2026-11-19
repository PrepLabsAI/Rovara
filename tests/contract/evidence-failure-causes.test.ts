// TE-A6 Parts B and C (DEC 254zt): a failing check names the failing tests and the change that most likely broke each, or says unknown. Without per-test data the per-check output is byte for byte what it always was.
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_RENDER_LIMITS, EvidencePackReadSchema, EvidencePackSchema, EvidencePackV2Schema, FAILURE_UNKNOWN_WORDS, FailureCausesFileSchema, FailureCausesSchema, failureCauseWords, renderEvidence,
  type EvidencePackV2,
} from "../../packages/contracts/src/index.js";
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
  it("lists each failing test under its check with the file and commit, or unknown and why", () => {
    const text = renderEvidence(failedPack([
      { testId: "tests/cart.test.ts::applies discount", cause: change("src/cart.ts", SHA) },
      { testId: "tests/cart.test.ts::rounds", cause: { kind: "unknown", reason: "weak_evidence" } },
    ])).body;
    const at = text.findIndex((line) => line.startsWith("- Tests: pytest -q"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(text.slice(at + 1, at + 3)).toEqual([
      "  - tests/cart.test.ts::applies discount: likely broken by a change (commit aaaaaaa) to src/cart.ts",
      "  - tests/cart.test.ts::rounds: unknown (only weak evidence)",
    ]);
  });

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

  it("shares the ten-test budget across checks: a second failed check lists only what is left", () => {
    const ids = Array.from({ length: 6 }, (_, index) => `tests/t.test.ts::case ${String(index)}`);
    const pack = clone(failedPack(ids.map((testId) => ({ testId, cause: change("src/a.ts", SHA) })), ids)) as unknown as { checks: Array<Record<string, unknown>> };
    pack.checks[1] = { ...clone(pack.checks[0]!), id: "second", label: "second suite", command: undefined };
    const body = renderEvidence(pack as unknown as EvidencePackV2).body;
    expect(body.filter((line) => line.startsWith("  - "))).toHaveLength(EVIDENCE_RENDER_LIMITS.failureCausesListed);
    expect(body.filter((line) => line.includes("more failing test"))).toEqual(["- and 2 more failing tests with a cause not listed"]);
  });

  it("makes every test id and path inert: no link, mention, issue reference, image or hidden character", () => {
    const hostile = "[click](https://evil.example/x) @owner #123 ![i](https://e.example/i.png) <b>x</b>";
    const out = renderEvidence(failedPack([{ testId: `tests/${hostile}.ts::a`, cause: { ...change(`src/${hostile}.ts`, SHA) } }], [`tests/${hostile}.ts::a`])).text;
    expect(out).not.toMatch(/https:\/\/|@owner|#123|<b>|\u202e|!\[/u);
    expect(out).toContain("likely broken by");
    // A hidden character cannot reach a line at all: the contract refuses it, so the check keeps its per-check line.
    const hidden = renderEvidence(failedPack([{ testId: "tests/a.ts::a\u202e", cause: change("src/a.ts", SHA) }], ["tests/a.ts::a\u202e"])).text;
    expect(hidden).not.toContain("likely broken by");
  });

  it("adds nothing for a check that did not fail, and nothing for causes it cannot read (a newer shape)", () => {
    const plain = renderEvidence(failedPack()).text;
    const passed = clone(failedPack([{ testId: "tests/cart.test.ts::rounds", cause: change("src/cart.ts", SHA) }])) as unknown as { checks: Array<{ after: string }> };
    passed.checks[0]!.after = "passed";
    const passedPlain = clone(failedPack()) as unknown as { checks: Array<{ after: string }> };
    passedPlain.checks[0]!.after = "passed";
    expect(renderEvidence(passed as unknown as EvidencePackV2).text).toBe(renderEvidence(passedPlain as unknown as EvidencePackV2).text);
    for (const odd of [[{ testId: "t", cause: { kind: "from_the_future", why: "x" } }], "text", 5, [], [{ nope: 1 }]]) expect(renderEvidence(failedPack(odd)).text).toBe(plain);
  });

  it("golden: a pack without per-test data renders exactly the per-check text it always did", () => {
    expect(renderEvidence(failedPack()).text).toBe([
      "Verified · Real run by Rovara",
      "Checked in a sealed round",
      "Checks: 2 (1 passed, 1 failed)",
      "Measures: reported by the project's test runner, not measured by Rovara",
      "- Tests: pytest -q: failed, 3 tests, 2 failed, 90% of changed lines covered",
      "- Benchmark: render time: passed, p95 118 ms (was 120 ms)",
      "Change proof: 1 proven",
      "Dependencies: Real · Recorded (12 Nov)",
      "- stripe: Recorded (12 Nov)",
      "- postgres: Real",
      "Spent: $0.40 model, 12 machine minutes ($0.10)",
      "Not tested:",
      "- refund flow (no test)",
    ].join("\n"));
    expect(renderEvidence(v2Pack()).body.some((line) => line.startsWith("  - "))).toBe(false);
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

  it("refuses causes that leave out a failing test of a check whose names list is whole", () => {
    expect(EvidencePackV2Schema.safeParse(failedPack([{ testId: "tests/cart.test.ts::rounds", cause: change("src/cart.ts") }])).success).toBe(false);
    expect(EvidencePackV2Schema.safeParse(failedPack([{ testId: "tests/cart.test.ts::rounds", cause: change("src/cart.ts") }, { testId: "tests/cart.test.ts::applies discount", cause: change("src/cart.ts") }])).success).toBe(true);
  });

  it("refuses a cause for a test the check does not show failing, and two causes for one test", () => {
    expect(EvidencePackV2Schema.safeParse(failedPack([{ testId: "tests/a.py::one", cause: change("src/cart.ts") }])).success).toBe(false);
    expect(EvidencePackV2Schema.safeParse(failedPack([{ testId: "nope", cause: change("src/cart.ts") }])).success).toBe(false);
    expect(EvidencePackV2Schema.safeParse(failedPack([...causes, ...causes])).success).toBe(false);
  });

  it("the cause schema refuses more than fifty tests, hidden characters, a bad commit, an unknown reason and extra keys", () => {
    const row = (value: unknown) => FailureCausesSchema.safeParse([{ testId: "t", cause: value }]).success;
    expect(row(change("src/a.ts", SHA))).toBe(true);
    expect(row(change("src/a\u0000.ts"))).toBe(false);
    expect(row({ ...change("src/a.ts"), commit: "xyz" })).toBe(false);
    expect(row({ ...change("src/a.ts"), extra: 1 })).toBe(false);
    expect(row({ kind: "unknown", reason: "bogus" })).toBe(false);
    expect(row({ ...change("src/a.ts"), paths: [] })).toBe(false);
    expect(row({ ...change("src/a.ts"), pathsCount: 0 })).toBe(false);
    expect(FailureCausesSchema.safeParse(Array.from({ length: 51 }, (_, index) => ({ testId: `t${String(index)}`, cause: change("src/a.ts") }))).success).toBe(false);
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
