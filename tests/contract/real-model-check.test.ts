import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { REAL_MODEL_CHECK_ARTIFACT, RealModelCheckSchema, RealModelCheckWriteSchema, realModelCheckLine, realModelPassed } from "../../packages/contracts/src/real-model-check.js";
import { TestProofSchema, TestProofWriteSchema } from "../../packages/contracts/src/test-proof.js";

function result(): z.infer<typeof RealModelCheckWriteSchema> {
  return { schemaVersion: 1, candidateDigest: "a".repeat(64), status: "completed", items: [{ checkId: "unit", test: "test_refund", result: "passed" }], totals: { selected: 1, passed: 1, passedOnRerun: 0, failed: 0, notRun: 0 }, calls: 3, costMicros: 40_000, model: "gemini-2.5-flash" };
}
describe("real model artifact", () => {
  it("owns the artifact and accepts the strict writer in the tolerant reader", () => {
    expect(REAL_MODEL_CHECK_ARTIFACT).toBe("real-model-check.json");
    const written = RealModelCheckWriteSchema.parse(result());
    expect(RealModelCheckSchema.parse({ ...written, future: true, items: written.items.map(i => ({ ...i, future: true })) })).toEqual(written);
    expect(RealModelCheckWriteSchema.safeParse({ ...written, future: true }).success).toBe(false);
    expect(RealModelCheckWriteSchema.safeParse({ ...written, items: [{ ...written.items[0], future: true }] }).success).toBe(false);
  });
  it.each([
    { schemaVersion: 2 }, { candidateDigest: "bad" }, { status: "unknown" }, { calls: NaN }, { costMicros: -1 },
    { items: [{ checkId: "unit", test: "x", result: "unknown" }] }, { items: [{ checkId: "unit", test: "x" }] },
    { items: [{ checkId: "unit", test: "x".repeat(501), result: "passed" }] },
    { items: [{ checkId: "unit", test: "x", result: "passed", reason: "secret cause" }] },
    { items: Array.from({ length: 201 }, () => result().items[0]) },
  ])("refuses malformed whole artifacts without leaking %j", patch => {
    const raw = { ...result(), ...patch };
    expect(RealModelCheckSchema.safeParse(raw).success).toBe(false);
    expect(realModelPassed(raw, "unit", "test_refund")).toBe(false);
    expect(realModelCheckLine(raw)).toBe("Real model check: not run: real model results could not be read.");
  });
  it("has exact golden lines and no line when skipped", () => {
    expect(realModelCheckLine(result())).toBe("Real model check: 1 of 1 changed AI tests passed on the real model (gemini-\u200D2.5-flash). 3 calls, $0.04, paid with your product key.");
    const flaky = result(); flaky.items[0]!.result = "passed_on_rerun"; flaky.totals.passed = 0; flaky.totals.passedOnRerun = 1;
    expect(realModelCheckLine(flaky)).toBe("Real model check: 0 of 1 passed; 1 passed only on re-run (flaky on the real model): test_refund. 3 calls, $0.04, paid with your product key.");
    const failed = result(); failed.items[0]!.result = "failed"; failed.totals.passed = 0; failed.totals.failed = 1;
    expect(realModelCheckLine(failed)).toContain("1 of 1 failed on the real model twice: test_refund.");
    const skipped = { ...result(), status: "skipped", items: [], totals: { selected: 0, passed: 0, passedOnRerun: 0, failed: 0, notRun: 0 }, calls: 0, costMicros: 0, model: null };
    expect(realModelCheckLine(skipped)).toBeUndefined();
  });
  it("counts exact test passes for 192a", () => {
    const r = result(); expect(realModelPassed(r, "unit", "test_refund")).toBe(true);
    r.items[0]!.result = "passed_on_rerun"; r.totals.passed = 0; r.totals.passedOnRerun = 1;
    expect(realModelPassed(r, "unit", "test_refund")).toBe(true);
    r.items[0]!.result = "failed"; r.totals.passedOnRerun = 0; r.totals.failed = 1;
    expect(realModelPassed(r, "unit", "test_refund")).toBe(false);
  });
  it.each(["[x[1]](https://example.invalid) ![a[b]c](x)", "[x][ref] ![x][ref]", "@person #123 <b>html</b>", "# title\n> quote\n---\n```\n~~~", "hidden\u200b\ufe0ftext"])("makes every displayed field inert: %s", text => {
    const r = result(); r.items[0]!.test = text; r.items[0]!.result = "failed"; r.totals.passed = 0; r.totals.failed = 1; r.model = text;
    const line = realModelCheckLine(r)!;
    expect(line).not.toMatch(/\[|<b>|@person|#123|https:\/\/example|\n|\ufe0f/u);
  });
  it("refuses a megabyte without echo or unbounded work", () => {
    const start = performance.now();
    expect(realModelCheckLine({ ...result(), model: "x".repeat(1_000_000) })).toBe("Real model check: not run: real model results could not be read.");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("TE-192a reference reader", () => {
  // Exact minimal fixture shape from TE-192a's real-model-check contract tests.
  const item = { checkId: "readiness:0", test: "a", result: "passed" };
  const run = (items: unknown[] = [item]) => ({ schemaVersion: 1, candidateDigest: "1".repeat(64), items });
  it.each(["passed", "passed_on_rerun", "failed", "not_run"])("reads minimal reference %s at both levels", state => {
    for (const entry of [{ ...item, result: state }, { checkId: item.checkId, result: state }]) {
      const raw = run([entry]);
      expect(RealModelCheckSchema.parse(raw)).toEqual(raw);
      const testId = "test" in entry ? entry.test : undefined;
      expect(realModelPassed(raw, item.checkId, testId)).toBe(state.startsWith("passed"));
      expect(realModelPassed(raw, "other", testId)).toBe(false);
      expect(realModelPassed(raw, item.checkId, testId === undefined ? "a" : undefined)).toBe(false);
      expect(RealModelCheckWriteSchema.safeParse(raw).success).toBe(false);
      expect(realModelCheckLine(raw)).toBe("Real model check: not run: real model results could not be read.");
    }
  });
  it("strips reference future fields and preserves the candidate binding", () => {
    expect(RealModelCheckSchema.parse({ ...run([{ ...item, future: true }]), future: true })).toEqual(run());
    for (const candidateDigest of [undefined, "x", "A".repeat(64), "a".repeat(63)]) {
      expect(realModelPassed({ ...run(), candidateDigest }, item.checkId, "a")).toBe(false);
    }
  });
  it("refuses every malformed reference item and duplicate without dropping valid siblings", () => {
    const badItems = [{ ...item, result: "private-cause" }, { ...item, checkId: 1 }, { ...item, test: "" }, { ...item, test: "x".repeat(501) }, { ...item, result: "failed" }];
    for (const bad of badItems) {
      const raw = run([item, bad]);
      expect(RealModelCheckSchema.safeParse(raw).success).toBe(false);
      expect(realModelPassed(raw, item.checkId, "a")).toBe(false);
    }
  });
  it("accepts maximum reference field lengths and refuses huge arrays before traversal", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ checkId: "c".repeat(64), test: String(i).padEnd(500, "x"), result: "passed" }));
    expect(RealModelCheckSchema.safeParse(run(items)).success).toBe(true);
    expect(realModelPassed(run(items), items[0]!.checkId, items[0]!.test)).toBe(true);
    const oversized = Array.from({ length: 100_000 }, () => item);
    Object.defineProperty(oversized, 0, { get: () => { throw new Error("must not visit"); } });
    const start = performance.now();
    expect(RealModelCheckSchema.safeParse(run(oversized)).success).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it.each([
    { totals: { selected: 0, passed: 0, passedOnRerun: 0, failed: 0, notRun: 0 } },
    { model: null }, { calls: 0 }, { status: "skipped" },
  ])("reads evidence independently of accounting, but the writer and summary refuse %j", patch => {
    const raw = { ...result(), ...patch };
    expect(RealModelCheckSchema.safeParse(raw).success).toBe(true);
    expect(realModelPassed(raw, "unit", "test_refund")).toBe(true);
    expect(RealModelCheckWriteSchema.safeParse(raw).success).toBe(false);
    expect(realModelCheckLine(raw)).toBe("Real model check: not run: real model results could not be read.");
  });
  it("keeps the writer's per-item reason consistency", () => {
    const raw = { ...result(), items: [{ checkId: "unit", test: "x", result: "not_run" }], status: "not_run", reason: "run_unavailable", totals: { selected: 1, passed: 0, passedOnRerun: 0, failed: 0, notRun: 1 } };
    expect(RealModelCheckSchema.safeParse(raw).success).toBe(true);
    expect(RealModelCheckWriteSchema.safeParse(raw).success).toBe(false);
    expect(realModelCheckLine(raw)).toBe("Real model check: not run: real model results could not be read.");
  });
});

describe("artifact limits and refusal words", () => {
  it("accepts exactly 200 items and scopes the same test name by check", () => {
    const r = result(); r.items = Array.from({ length: 200 }, (_, i) => ({ checkId: `c${i}`, test: "same", result: "passed" })); r.calls = 200; r.totals.selected = 200; r.totals.passed = 200;
    expect(RealModelCheckWriteSchema.safeParse(r).success).toBe(true); expect(realModelPassed(r, "c0", "same")).toBe(true); expect(realModelPassed(r, "missing", "same")).toBe(false);
    r.items[1] = r.items[0]!; expect(RealModelCheckSchema.safeParse(r).success).toBe(false);
  });
  it.each([
    ["ports_missing", "product key approval and monthly meter are not connected"], ["round_kind", "real model tests need a check round"],
    ["approval_missing", "product key approval is unavailable"], ["approval_invalid", "product key approval does not cover these tests"],
    ["no_product_key", "no product AI key is connected"], ["grant_cap", "the approved call or cost ceiling cannot fit these tests"],
    ["task_cap", "test model budget reached ($2.00 per task)"], ["monthly_cap", "the monthly cap cannot fit these tests"],
    ["attribution_unknown", "Rovara couldn't tell which tests use the model"], ["call_count_unknown", "call count unknown"],
    ["rate_limit", "provider rate limit"], ["quota", "provider quota used up"], ["overloaded", "provider overloaded"],
    ["key_refused", "the product key was refused (check it in Settings)"], ["cap", "test model budget reached ($2.00 per task)"],
    ["provider_error", "the model provider did not complete the call"], ["refused", "the model call was refused"],
    ["invalid_usage", "model usage could not be read"], ["invalid_results", "real model results could not be read"],
    ["timed_out", "the real model check reached its time limit"], ["run_unavailable", "the real model test run could not complete"],
    ["close_unavailable", "the monthly reservation could not be closed"], ["invalid_input", "real model inputs could not be read"],
    ["input_limit", "real model inputs exceed the size limit"], ["too_many_tests", "too many changed AI tests (51)"],
  ])("prints fixed words for %s, never stored causes", (reason, words) => {
    const raw = { ...result(), status: "not_run", items: [], totals: { selected: 0, passed: 0, passedOnRerun: 0, failed: 0, notRun: 0 }, model: "private-cause", calls: 0, costMicros: 0, reason, cause: "private-cause", ...(reason === "too_many_tests" ? { tooManyCount: 51 } : {}) };
    expect(realModelCheckLine(raw)).toBe(`Real model check: not run: ${words}.`); expect(realModelCheckLine(raw)).not.toContain("private-cause");
  });
});

it("rejects an over-limit artifact without visiting its rows", () => {
  const items = Array.from({ length: 201 }, () => result().items[0]);
  Object.defineProperty(items, "0", { get: () => { throw new Error("row must not be read"); } });
  expect(RealModelCheckSchema.safeParse({ ...result(), items }).success).toBe(false);
});


describe("exact check and test granularity", () => {
  it.each(["passed", "passed_on_rerun", "failed", "not_run"] as const)("accepts whole-check %s and never infers a test pass", state => {
    const r = result();
    r.items = [{ checkId: "unit", result: state, ...(state === "not_run" ? { reason: "run_unavailable" as const } : {}) }];
    r.totals = { selected: 1, passed: +(state === "passed"), passedOnRerun: +(state === "passed_on_rerun"), failed: +(state === "failed"), notRun: +(state === "not_run") };
    if (state === "not_run") { r.status = "not_run"; r.reason = "run_unavailable"; }
    expect(RealModelCheckWriteSchema.safeParse(r).success).toBe(true);
    expect(realModelPassed(r, "unit")).toBe(state === "passed" || state === "passed_on_rerun");
    expect(realModelPassed(r, "other")).toBe(false);
    expect(realModelPassed(r, "unit", "test_refund")).toBe(false);
    if (state === "failed") expect(realModelCheckLine(r)).toContain("twice: unit.");
  });
  it("never infers a whole-check pass from a per-test pass", () => {
    expect(realModelPassed(result(), "unit", "test_refund")).toBe(true);
    expect(realModelPassed(result(), "unit")).toBe(false);
    expect(realModelPassed(result(), "other", "test_refund")).toBe(false);
  });
  it("keeps both levels distinct and rejects duplicate whole-check items", () => {
    const r = result();
    r.items.push({ checkId: "unit", result: "failed" });
    r.totals.selected++; r.totals.failed++;
    expect(RealModelCheckWriteSchema.safeParse(r).success).toBe(true);
    expect(realModelPassed(r, "unit", "test_refund")).toBe(true);
    expect(realModelPassed(r, "unit")).toBe(false);
    r.items.push({ checkId: "unit", result: "failed" });
    r.totals.selected++; r.totals.failed++;
    expect(RealModelCheckWriteSchema.safeParse(r).success).toBe(false);
    expect(RealModelCheckSchema.safeParse(r).success).toBe(false);
  });
});

const digest = "1".repeat(64);
const item = { checkId: "readiness:0", test: "a", result: "passed" };
const run = (items: unknown[] = [item]) => ({ schemaVersion: 1, candidateDigest: digest, items });
const proof = { schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 0 };

describe("scriptedReplies proof part", () => {
  const facts = [{ checkId: "readiness:0", taskMade: 1, counted: 2 }];
  it("keeps old writer output identical and reads new reply facts", () => {
    expect(TestProofSchema.parse(TestProofWriteSchema.parse(proof))).toEqual(proof);
    expect(TestProofSchema.parse({ ...proof, scriptedReplies: facts })).toEqual({ ...proof, scriptedReplies: facts });
    expect(TestProofWriteSchema.safeParse({ ...proof, scriptedReplies: facts }).success).toBe(true);
  });
  it("never drops a present malformed part, including wrong numeric types and duplicate check ids", () => {
    for (const scriptedReplies of [null, {}, [{ ...facts[0], taskMade: -1 }], [{ ...facts[0], counted: Infinity }], [{ ...facts[0], taskMade: "1" }], [{ checkId: "readiness:0" }], [...facts, ...facts], Array.from({ length: 201 }, (_, i) => ({ ...facts[0], checkId: `readiness:${i}` }))]) {
      expect(TestProofSchema.safeParse({ ...proof, scriptedReplies }).success).toBe(false);
      expect(TestProofWriteSchema.safeParse({ ...proof, scriptedReplies }).success).toBe(false);
    }
  });
  it("accepts 200 reply facts and refuses oversized facts without visiting them", () => {
    const scriptedReplies = Array.from({ length: 200 }, (_, i) => ({ checkId: `readiness:${i}`, taskMade: 0, counted: Number.MAX_SAFE_INTEGER }));
    expect(TestProofWriteSchema.safeParse({ ...proof, scriptedReplies }).success).toBe(true);
    const huge = Array.from({ length: 100_000 }, () => facts[0]);
    Object.defineProperty(huge, 0, { get: () => { throw new Error("must not visit"); } });
    expect(TestProofSchema.safeParse({ ...proof, scriptedReplies: huge }).success).toBe(false);
  });
  it("strips only unknown fact keys on read, not on write", () => {
    const value = { ...proof, scriptedReplies: [{ ...facts[0], future: true }] };
    expect(TestProofSchema.parse(value).scriptedReplies).toEqual(facts);
    expect(TestProofWriteSchema.safeParse(value).success).toBe(false);
  });
});

it("refuses an oversized proof before traversing its items", () => {
  const items = Array.from({ length: 100_000 }, () => ({}));
  Object.defineProperty(items, 0, { get: () => { throw new Error("must not visit"); } });
  expect(TestProofSchema.safeParse({ ...proof, items }).success).toBe(false);
  expect(TestProofWriteSchema.safeParse({ ...proof, items }).success).toBe(false);
});

it("refuses invalid header and item fields at runtime", () => {
  const badItems = [
    { ...item, checkId: "" }, { ...item, checkId: "x".repeat(65) }, { ...item, checkId: null },
    { ...item, test: "" }, { ...item, test: 1 }, { ...item, result: undefined },
  ];
  const invalid = [...badItems.map((bad) => run([bad])), { ...run(), schemaVersion: 2 }, { ...run(), candidateDigest: "A".repeat(64) }, { ...run(), candidateDigest: "a".repeat(63) }, { ...run(), items: null }];
  // F9 (owner of the contract) keeps its strict writer: minimal 192a fixtures are read-only references, so run() is rejected here.
  expect(RealModelCheckWriteSchema.safeParse(run()).success).toBe(false);
  for (const value of invalid) {
    expect(RealModelCheckSchema.safeParse(value).success).toBe(false);
    expect(RealModelCheckWriteSchema.safeParse(value).success).toBe(false);
  }
});

it("refuses invalid reply fact ids and every non-count numeric form", () => {
  const facts = { checkId: "readiness:0", taskMade: 0, counted: 0 };
  const invalid = ["", "x".repeat(65), null].map((checkId) => ({ ...facts, checkId }));
  for (const field of ["taskMade", "counted"]) for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null]) invalid.push({ ...facts, [field]: value });
  expect(TestProofWriteSchema.safeParse({ ...proof, scriptedReplies: [facts] }).success).toBe(true);
  for (const value of invalid) {
    expect(TestProofSchema.safeParse({ ...proof, scriptedReplies: [value] }).success).toBe(false);
    expect(TestProofWriteSchema.safeParse({ ...proof, scriptedReplies: [value] }).success).toBe(false);
  }
});
