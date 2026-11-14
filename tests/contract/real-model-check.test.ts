import { describe, expect, it } from "vitest";
import { REAL_MODEL_CHECK_ARTIFACT, RealModelCheckSchema, RealModelCheckWriteSchema, realModelPassed } from "../../packages/contracts/src/real-model-check.js";
import { TestProofSchema, TestProofWriteSchema } from "../../packages/contracts/src/test-proof.js";

import { agentRepliesStatus } from "../../packages/broker/src/core/proof/agent-replies.js";

const digest = "1".repeat(64);
const item = { checkId: "readiness:0", test: "a", result: "passed" };
const run = (items: unknown[] = [item]) => ({ schemaVersion: 1, candidateDigest: digest, items });
const proof = { schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 0 };

describe("F9 shared result contract", () => {
  it("has one artifact and accepts whole-check and test results including a rerun pass", () => {
    expect(REAL_MODEL_CHECK_ARTIFACT).toBe("real-model-check.json");
    for (const result of ["passed", "passed_on_rerun", "failed", "not_run"]) {
      expect(RealModelCheckWriteSchema.safeParse(run([{ ...item, result }, { checkId: "readiness:0", result }])).success).toBe(true);
      expect(realModelPassed(run([{ ...item, result }]), item.checkId, "a")).toBe(result.startsWith("passed"));
    }
  });
  it("matches exactly the check and optional test, never substitutes one granularity for another", () => {
    expect(realModelPassed(run(), item.checkId, "a")).toBe(true);
    expect(realModelPassed(run(), item.checkId)).toBe(false);
    expect(realModelPassed(run(), "other", "a")).toBe(false);
    expect(realModelPassed(run(), item.checkId, "missing")).toBe(false);
    const whole = run([{ checkId: item.checkId, result: "passed" }]);
    expect(realModelPassed(whole, item.checkId)).toBe(true);
    expect(realModelPassed(whole, item.checkId, "a")).toBe(false);
  });
  it("strips future keys in the reader and refuses them in the writer", () => {
    const future = { ...run([{ ...item, future: true }]), future: true };
    expect(RealModelCheckSchema.parse(future)).toEqual(run());
    expect(RealModelCheckWriteSchema.safeParse(future).success).toBe(false);
  });
  it("refuses the whole malformed run and conflicting duplicates with fixed false, without leaking", () => {
    const secret = `gh${"p"}_${"x".repeat(36)}`;
    for (const bad of [undefined, null, {}, { ...run(), schemaVersion: 2 }, { ...run(), candidateDigest: "x" }, run([item, { ...item, test: "other", result: secret }]), run([item, { ...item, result: "failed" }]), run([item, { ...item, checkId: 1 }]), run([{ ...item, test: "x".repeat(501) }]), run([{ ...item, test: "" }])]) {
      expect(RealModelCheckSchema.safeParse(bad).success).toBe(false);
      expect(realModelPassed(bad, item.checkId, "a")).toBe(false);
      expect(JSON.stringify(realModelPassed(bad, item.checkId, "a"))).not.toContain(secret);
    }
  });
  it("accepts the stated maximum and rejects oversized arrays before traversing them", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ checkId: "c".repeat(64), test: String(i).padEnd(500, "x"), result: "passed" }));
    expect(RealModelCheckSchema.safeParse(run(items)).success).toBe(true);
    const oversized = Array.from({ length: 100_000 }, () => item);
    Object.defineProperty(oversized, 0, { get: () => { throw new Error("must not visit"); } });
    const start = performance.now();
    expect(RealModelCheckSchema.safeParse(run(oversized)).success).toBe(false);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

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
  expect(RealModelCheckWriteSchema.safeParse(run()).success).toBe(true);
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


it("F9 workflow ids cannot confirm proof readiness ids", () => {
  const testProof = { ...proof, items: [{ checkId: "readiness:0", label: "Tests", granularity: "test", test: "a", verdict: "proves_change", reason: "assertion_failed_on_old" }], scriptedReplies: [{ checkId: "readiness:0", taskMade: 1, counted: 0 }] };
  expect(agentRepliesStatus({ checkId: "readiness:0", testProof, realRun: run() })).toBe("confirmed");
  expect(agentRepliesStatus({ checkId: "readiness:0", testProof, realRun: run([{ ...item, checkId: "workflow-id" }]) })).toBe("unconfirmed");
});
