import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { REAL_MODEL_CHECK_ARTIFACT, RealModelCheckSchema, RealModelCheckWriteSchema, realModelCheckLine, realModelPassed } from "../../packages/contracts/src/real-model-check.js";
import { TestProofSchema, TestProofWriteSchema } from "../../packages/contracts/src/test-proof.js";
import { agentRepliesStatus } from "../../packages/broker/src/core/proof/agent-replies.js";

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
  it.each(["[x[1]](https://example.invalid) ![a[b]c](x)", "[x][ref] ![x][ref]", "@person #123 <b>html</b>", "# title\n> quote\n---\n```\n~~~", "hidden\u200b\ufe0ftext"])("makes every displayed field inert: %s", text => {
    const r = result(); r.items[0]!.test = text; r.items[0]!.result = "failed"; r.totals.passed = 0; r.totals.failed = 1; r.model = text;
    const line = realModelCheckLine(r)!;
    expect(line).not.toMatch(/\[|<b>|@person|#123|https:\/\/example|\n|\ufe0f/u);
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
});

it("F9 workflow ids cannot confirm proof readiness ids", () => {
  const testProof = { ...proof, items: [{ checkId: "readiness:0", label: "Tests", granularity: "test", test: "a", verdict: "proves_change", reason: "assertion_failed_on_old" }], scriptedReplies: [{ checkId: "readiness:0", taskMade: 1, counted: 0 }] };
  expect(agentRepliesStatus({ checkId: "readiness:0", testProof, realRun: run() })).toBe("confirmed");
  expect(agentRepliesStatus({ checkId: "readiness:0", testProof, realRun: run([{ ...item, checkId: "workflow-id" }]) })).toBe("unconfirmed");
});
