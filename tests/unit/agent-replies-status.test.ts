import { describe, expect, it } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
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
  it("handles the full 200-item bound in time that grows linearly with the items", () => {
    const outcomes = new Map<number, string>();
    // Work grows linearly with the item count up to the 200-item bound (an index per item, not a scan of all results per item).
    expectLinearScaling((count) => {
      const names = Array.from({ length: count }, (_, i) => String(i).padEnd(500, "x"));
      const realRun = run(names.map((test) => ({ checkId, test, result: "passed" })));
      const testProof = proof(names.map(item));
      return () => { outcomes.set(count, status(realRun, testProof)); };
    }, { n: 25, label: "agent replies: items up to the 200 bound" });
    expect([outcomes.get(25), outcomes.get(200)]).toEqual(["confirmed", "confirmed"]);
  });
  it("refuses a huge proof array on its length alone, without visiting any element", () => {
    // A huge proof array is refused by its length alone: the cost does not grow with the array, and no element is read.
    const huge = (count: number) => {
      const array = Array.from({ length: count }, () => item("a"));
      Object.defineProperty(array, 0, { get: () => { throw new Error("must not visit"); } });
      return array;
    };
    const verdicts = new Map<number, string>();
    expectLinearScaling((count) => {
      const testProof = proof(huge(count));
      return () => { verdicts.set(count, status(run(), testProof)); };
    }, { n: 2_500, label: "agent replies: huge proof array refused" });
    expect([verdicts.get(2_500), verdicts.get(20_000)]).toEqual(["unconfirmed", "unconfirmed"]);
  });
});

it("refuses an invalid rule argument with fixed words instead of throwing", () => {
  for (const value of [null, undefined, "unreadable", [], {}]) expect(agentRepliesStatus(value as never)).toBe("unconfirmed");
});
