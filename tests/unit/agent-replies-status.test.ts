import { describe, expect, it } from "vitest";
import { agentRepliesStatus } from "../../packages/broker/src/core/proof/agent-replies.js";

const digest = "1".repeat(64);
const checkId = "readiness:0";
const item = (test?: string) => ({ checkId, label: "Tests", granularity: test === undefined ? "check" : "test", ...(test === undefined ? {} : { test }), verdict: "proves_change", reason: "assertion_failed_on_old" });
const proof = (items: unknown[] = [item("a"), item("b")]) => ({ schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items, durationMs: 1 });
const run = (items: unknown[] = [{ checkId, test: "a", result: "passed" }, { checkId, test: "b", result: "passed_on_rerun" }]) => ({ schemaVersion: 1, candidateDigest: digest, items });
const status = (realRun: unknown, testProof: unknown = proof()) => agentRepliesStatus({ checkId, testProof, realRun });

describe("agent replies agreement", () => {
  it("confirms only every proving item for the same digest, with rerun passes allowed", () => {
    expect(status(run())).toBe("confirmed");
    expect(status(run([{ checkId, result: "passed" }]), proof([item()]))).toBe("confirmed");
  });
  it("does not confuse checks or tests or infer whole-check success", () => {
    expect(status(run([{ checkId, result: "passed" }]))).toBe("unconfirmed");
    expect(status(run(), proof([item()]))).toBe("unconfirmed");
    expect(status(run([{ checkId: "other", test: "a", result: "passed" }]), proof([item("a")]))).toBe("unconfirmed");
    expect(status(run(), proof([{ ...item("a"), test: undefined }]))).toBe("unconfirmed");
    expect(status(run(), proof([{ ...item(), test: "a" }]))).toBe("unconfirmed");
  });
  it("leaves missing, not-run, stale and unreadable evidence unconfirmed", () => {
    for (const value of [undefined, {}, null, { ...run(), candidateDigest: "2".repeat(64) }, run([]), run([{ checkId, test: "a", result: "passed" }]), run([{ checkId, test: "a", result: "passed" }, { checkId, test: "b", result: "not_run" }]), run([{ checkId, test: "a", result: "unknown" }])]) expect(status(value)).toBe("unconfirmed");
    expect(status(run(), proof([]))).toBe("unconfirmed");
    expect(status(run(), { ...proof(), status: "not_checked" })).toBe("unconfirmed");
    expect(status(run(), { ...proof(), scriptedReplies: "broken" })).toBe("unconfirmed");
  });
  it("a failing proving item wins over passes and missing or not-run items in either order", () => {
    const failed = { checkId, test: "b", result: "failed" };
    for (const first of [undefined, { checkId, test: "a", result: "passed" }, { checkId, test: "a", result: "not_run" }]) {
      for (const items of [[...(first ? [first] : []), failed], [failed, ...(first ? [first] : [])]]) expect(status(run(items))).toBe("disagreed");
    }
    expect(status(run([{ checkId, result: "failed" }]), proof([item()]))).toBe("disagreed");
  });
  it("ignores non-proving items but never promotes an empty proof", () => {
    expect(status(run(), proof([item("a"), { ...item("b"), verdict: "does_not_prove" }]))).toBe("confirmed");
    expect(status(run(), proof([{ ...item("a"), verdict: "does_not_prove" }]))).toBe("unconfirmed");
  });
  it("returns fixed words for invalid values without leaking their contents", () => {
    const secret = `gh${"p"}_${"a".repeat(36)}`;
    for (const value of [secret, { ...run(), items: secret }, run([{ checkId, test: "a", result: secret }]), run([{ checkId, test: "a", result: "passed" }, { checkId, test: "a", result: "failed" }])]) expect(status(value)).toBe("unconfirmed");
    expect(agentRepliesStatus({ checkId: 1, testProof: proof(), realRun: run() })).toBe("unconfirmed");
  });
  it("handles the full 200-item bound and refuses huge proof arrays without traversing them", () => {
    const names = Array.from({ length: 200 }, (_, i) => String(i).padEnd(500, "x"));
    const start = performance.now();
    expect(status(run(names.map((test) => ({ checkId, test, result: "passed" }))), proof(names.map(item)))).toBe("confirmed");
    const huge = Array.from({ length: 100_000 }, () => item("a"));
    Object.defineProperty(huge, 0, { get: () => { throw new Error("must not visit"); } });
    expect(status(run(), proof(huge))).toBe("unconfirmed");
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

it("refuses an invalid rule argument with fixed words instead of throwing", () => {
  for (const value of [null, undefined, "unreadable", [], {}]) expect(agentRepliesStatus(value as never)).toBe("unconfirmed");
});
