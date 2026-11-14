// TE-F3 part A: the hidden eval set rules (O44). A hidden set is mounted only in the sealed round; every other round answers with one fixed sentence; what goes back to the coding agent is a score and a count per measure and nothing else.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_EGRESS_ROUND_KINDS } from "../../packages/contracts/src/model-egress/evidence-lines.js";
import { evalCheckResult } from "../../packages/contracts/src/eval-check.js";
import {
  EVAL_ROUND_KINDS, HIDDEN_EVAL_MOUNT_PATH, HIDDEN_EVAL_NEEDS_SEALED_SENTENCE, agentFeedbackFor, evalSetHashOf, hiddenEvalSetFor, type HiddenEvalSetSource,
} from "../../packages/contracts/src/eval-hidden-set.js";

const HASH = "c".repeat(64);
function source(over: Partial<{ exists: boolean; hostPath: string; hash: string; failOpen: boolean; failExists: boolean }> = {}) {
  const calls = { exists: 0, open: 0 };
  const held: HiddenEvalSetSource = {
    exists: () => { calls.exists += 1; if (over.failExists === true) return Promise.reject(new Error("no")); return Promise.resolve(over.exists ?? true); },
    open: () => { calls.open += 1; if (over.failOpen === true) return Promise.reject(new Error("no")); return Promise.resolve({ hostPath: over.hostPath ?? "/var/lib/rovara/hidden/p1", hash: over.hash ?? HASH }); },
  };
  return { held, calls };
}

describe("the hidden set is mounted only in the sealed round", () => {
  it("knows the same round kinds as the model-call ledger", () => {
    expect([...EVAL_ROUND_KINDS]).toEqual([...MODEL_EGRESS_ROUND_KINDS]);
  });
  it("round matrix: only check_sealed opens the set; every other round (and an unknown one) is told it needs the sealed round, without the set being opened", async () => {
    for (const kind of ["working", "check_unsealed", "check_sealed", "sealed", "CHECK_SEALED", "", undefined, null, 7]) {
      const { held, calls } = source();
      const answer = await hiddenEvalSetFor(kind as never, held);
      if (kind === "check_sealed") {
        expect(answer, String(kind)).toEqual({ status: "mounted", hash: HASH, mount: { hostPath: "/var/lib/rovara/hidden/p1", containerPath: HIDDEN_EVAL_MOUNT_PATH, readOnly: true } });
        expect(calls.open).toBe(1);
      } else {
        expect(answer, String(kind)).toEqual({ status: "needs_sealed_round", sentence: HIDDEN_EVAL_NEEDS_SEALED_SENTENCE });
        expect(calls.open, `${String(kind)} must never open the set`).toBe(0);
      }
    }
  });
  it("says nothing about a hidden set when the project has none, in any round", async () => {
    for (const kind of ["working", "check_unsealed", "check_sealed"] as const) {
      const { held, calls } = source({ exists: false });
      expect(await hiddenEvalSetFor(kind, held)).toEqual({ status: "none" });
      expect(calls.open).toBe(0);
    }
  });
  it("fixes the sentence and the mount path", () => {
    expect(HIDDEN_EVAL_NEEDS_SEALED_SENTENCE).toBe("not run: the hidden eval set needs the sealed round");
    expect(HIDDEN_EVAL_MOUNT_PATH).toBe("/rovara/hidden-eval");
  });
  it("fails closed in the sealed round when the set cannot be opened or its answer is not sound: unavailable, never a guessed mount", async () => {
    expect(await hiddenEvalSetFor("check_sealed", source({ failOpen: true }).held)).toEqual({ status: "unavailable" });
    expect(await hiddenEvalSetFor("check_sealed", source({ failExists: true }).held)).toEqual({ status: "unavailable" });
    for (const bad of [{ hostPath: "relative/path" }, { hostPath: "/a/../b" }, { hostPath: "/a b" }, { hostPath: "" }, { hostPath: "/a\0b" }, { hash: "xyz" }, { hash: "C".repeat(64) }]) {
      expect(await hiddenEvalSetFor("check_sealed", source(bad).held), JSON.stringify(bad)).toEqual({ status: "unavailable" });
    }
  });
  it("never lets the answer carry the set's contents, only a hash and a path", async () => {
    const canary = `c-${randomBytes(4).toString("hex")}`;
    const held: HiddenEvalSetSource = { exists: () => Promise.resolve(true), open: () => Promise.resolve({ hostPath: "/var/lib/rovara/hidden/p1", hash: HASH, cases: [canary] } as never) };
    expect(JSON.stringify(await hiddenEvalSetFor("check_sealed", held))).not.toContain(canary);
  });
});

describe("Rovara's own hash of an eval set", () => {
  const file = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text) });
  it("depends on every path and every byte, and not on the order the files are listed in", () => {
    const a = evalSetHashOf([file("q/1.json", "one"), file("q/2.json", "two")]);
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
    expect(evalSetHashOf([file("q/2.json", "two"), file("q/1.json", "one")])).toBe(a);
    expect(evalSetHashOf([file("q/1.json", "one"), file("q/2.json", "twO")])).not.toBe(a);
    expect(evalSetHashOf([file("q/1.json", "one"), file("q/3.json", "two")])).not.toBe(a);
    expect(evalSetHashOf([file("q/1.json", "one")])).not.toBe(a);
  });
  it("refuses no files, an absolute or dotted path, and a path listed twice", () => {
    for (const bad of [[], [file("/etc/x", "a")], [file("../x", "a")], [file("a/./b", "a")], [file("a\\b", "a")], [file("a", "1"), file("a", "2")]]) expect(() => evalSetHashOf(bad as never)).toThrow(RangeError);
  });
});

describe("question feedback and private isolation", () => {
  const answer = { pass: true, answer: "private-answer-canary" };
  const questions = [{ id: "private-id-canary", category: "ordinary" as const, old: [answer, answer, answer], first: answer }];
  it("public feedback shows questions and answers, private feedback has one fixed boolean and no positions/counts", () => {
    const publicResult = evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1 });
    expect(agentFeedbackFor(publicResult)).toMatchObject({ questions: [{ id: "private-id-canary", oldAnswers: [answer.answer, answer.answer, answer.answer] }] });
    const privateResult = evalCheckResult({ roundKind: "check_sealed", questions, changedPromptCalls: 1, hiddenSetUsed: true });
    expect(agentFeedbackFor(privateResult)).toEqual({ pass: true });
    expect(JSON.stringify(privateResult)).not.toContain("canary");
    expect(privateResult).toMatchObject({ casesRun: 0, casesTotal: 0, questions: [], excluded: [], notices: [], measures: [], verdicts: [] });
  });
  it("private permutations and hostile extra fields cannot encode positions, ids or numeric values", () => {
    for (const count of [1, 20, 200]) {
      const qs = Array.from({ length: count }, (_, i) => ({ ...questions[0]!, id: `canary-${i}` }));
      const result = evalCheckResult({ roundKind: "check_sealed", questions: qs.reverse(), changedPromptCalls: count, hiddenSetUsed: true });
      expect(agentFeedbackFor({ ...result, injected: "canary" } as never)).toEqual({ pass: true });
    }
  });
  it("a missing private result is neither a pass nor a fail and unsealed private input is refused", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1, hiddenSetUsed: true });
    expect(result.notRun?.reason).toBe("hidden_set_needs_sealed_round");
    expect(agentFeedbackFor(result)).toEqual({ notRun: true });
  });
});
it("a private single-question break leaks no fix-request bit beyond the pass/fail result", () => {
  const yes = { pass: true, answer: "private old" }; const no = { pass: false, answer: "private new" };
  const result = evalCheckResult({ roundKind: "check_sealed", hiddenSetUsed: true, changedPromptCalls: 1,
    questions: [{ id: "private", category: "ordinary", old: [yes, yes, yes], first: no, freshOld: [yes, yes, yes], freshNew: [no, no, no] }] });
  expect(result.label).toBe("No drop found");
  expect(result.fixRequested).toBe(false);
  expect(agentFeedbackFor(result)).toEqual({ pass: true });
});
