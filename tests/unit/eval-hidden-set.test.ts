// TE-F3 part A: the hidden eval set rules (O44). A hidden set is mounted only in the sealed round; every other round answers with one fixed sentence; what goes back to the coding agent is a score and a count per measure and nothing else.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_EGRESS_ROUND_KINDS } from "../../packages/contracts/src/model-egress/evidence-lines.js";
import { MeasuresFileSchema } from "../../packages/contracts/src/measures-file.js";
import { evalCheckResult } from "../../packages/contracts/src/eval-check.js";
import type { EvalBaseRecord } from "../../packages/contracts/src/eval-base-cache.js";
import { evalFactsAllRun } from "../../packages/contracts/src/eval-pacing.js";
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

describe("what goes back to the coding agent", () => {
  const base: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }, { name: "recall", unit: "fraction", value: 0.7, direction: "up_good", spread: 0.05 }], caseCount: 40, recordedOn: "2026-11-13", roundKind: "check_sealed", runnerSchemaVersion: 1 };
  const file = (measures: Array<Record<string, unknown>>) => MeasuresFileSchema.parse({ schemaVersion: 1, measures });
  const m = (name: string, value: number, over: Record<string, unknown> = {}) => ({ name, unit: "fraction", value, direction: "up_good", spread: 0.05, ...over });

  it("outside a hidden round: a score (two decimals) and a count of the cases that RAN, by position, and nothing else", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([m("accuracy", 0.8234, { count: 9999 }), m("recall", 0.7)]), base, facts: evalFactsAllRun(40) });
    const feedback = agentFeedbackFor(result);
    expect(Object.keys(feedback)).toEqual(["measures"]);
    expect(feedback.measures).toEqual([{ index: 0, score: 0.82, count: 40 }, { index: 1, score: 0.7, count: 40 }]);
    for (const entry of feedback.measures) expect(Object.keys(entry)).toEqual(["index", "score", "count"]);
  });
  it("in a hidden round: pass or fail only, no score and no count", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([m("accuracy", 0.8234, { count: 40 }), m("recall", 0.2, { count: 40 })]), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    const feedback = agentFeedbackFor(result);
    expect(feedback.measures).toEqual([{ index: 0, pass: true }, { index: 1, pass: false }]);
    for (const entry of feedback.measures) expect(Object.keys(entry)).toEqual(["index", "pass"]);
    expect(JSON.stringify(feedback)).not.toMatch(/0\.8|0\.2|40/u);
  });
  it("a hidden score far above the band reads as a pass, never as 'better' (no direction beyond no-drop)", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([m("accuracy", 0.99, { count: 40 })]), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    expect(result.verdicts[0]).toMatchObject({ verdict: "no_detectable_change", sentence: "no detectable drop on the hidden set" });
    expect(agentFeedbackFor(result).measures).toEqual([{ index: 0, pass: true }]);
  });
  it("carries no case id, input, output, name, diff or path even when the result object is hostile", () => {
    const canary = `c-${randomBytes(4).toString("hex")}`;
    for (const hiddenSetUsed of [true, false]) {
      const result = evalCheckResult({ roundKind: "check_sealed", head: file([m("accuracy", 0.8, { count: 40 })]), base, facts: evalFactsAllRun(40), hiddenSetUsed });
      const hostile = { ...result, caseIds: [canary], verdicts: result.verdicts.map((verdict) => ({ ...verdict, caseId: canary, label: canary, input: canary, path: `/hidden/${canary}`, sentence: canary })), summary: canary };
      const text = JSON.stringify(agentFeedbackFor(hostile));
      expect(text).not.toContain(canary);
      expect(text).not.toContain("/hidden");
    }
  });
  it("is empty when the eval did not run (no score is invented)", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([m("accuracy", 0.8)]), base, facts: { total: 40, run: 10, notRun: 30, byClass: { rate_limit: 30 }, overrunStop: false }, hiddenSetUsed: true });
    expect(agentFeedbackFor(result)).toEqual({ measures: [] });
  });
  it("rounds an ordinary score to two decimals, so the exact value is not handed out digit by digit", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([m("accuracy", 0.8349999, { count: 40 })]), base, facts: evalFactsAllRun(40) });
    expect(agentFeedbackFor(result).measures[0]).toMatchObject({ score: 0.83 });
  });
  it("a hostile runner's 50 unmatched measures with huge values leave nothing beyond pass/fail: no verdict, no number, no word", () => {
    const marker = `c-${randomBytes(4).toString("hex")}`;
    const huge = Array.from({ length: 49 }, (_, index) => m(`${marker}${String(index)}`, 9.99e11 - index, { unit: marker, spread: 9e11, count: 99_999_999 }));
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([m("accuracy", 0.79, { count: 40 }), ...huge]), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    expect(result.verdicts).toHaveLength(1);
    expect(result.measures).toEqual([]);
    expect(agentFeedbackFor(result)).toEqual({ measures: [{ index: 0, pass: true }] });
    const text = JSON.stringify(result);
    expect(text).not.toContain(marker);
    expect(text).not.toMatch(/9\.99e|99999999|999999/u);
    // all of them unmatched: nothing but "not run"
    const allUnmatched = evalCheckResult({ roundKind: "check_sealed", head: file(huge), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    expect(allUnmatched).toMatchObject({ outcome: "not_run", verdicts: [], measures: [], notRun: { reason: "no_base_score" } });
    expect(agentFeedbackFor(allUnmatched)).toEqual({ measures: [] });
  });
});

describe("a hidden round's feedback position is Rovara's, not the runner's", () => {
  const base: EvalBaseRecord = { schemaVersion: 1, caseCount: 30, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1, measures: [{ name: "acc", unit: "fraction", direction: "up_good", value: 0.8, spread: 0.01, count: 30 }, { name: "rec", unit: "fraction", direction: "up_good", value: 0.7, spread: 0.01, count: 30 }] };
  const pad = (index: number) => ({ name: `pad_${String(index)}`, unit: "u", direction: "up_good" as const, value: 1e9, count: 30 });
  const matched = [{ name: "acc", unit: "fraction", direction: "up_good" as const, value: 0.81, count: 30 }, { name: "rec", unit: "fraction", direction: "up_good" as const, value: 0.1, count: 30 }];
  const run = (positions: [number, number]) => {
    const list: Array<Record<string, unknown>> = Array.from({ length: 50 }, (_, index) => pad(index));
    list[positions[0]] = matched[0]!;
    list[positions[1]] = matched[1]!;
    return evalCheckResult({ roundKind: "check_sealed", head: MeasuresFileSchema.parse({ schemaVersion: 1, measures: list }), base, facts: evalFactsAllRun(30), hiddenSetUsed: true });
  };
  it("is identical wherever the runner puts a matched measure among pads, and whatever order it lists two of them in (no position channel)", () => {
    const reference = run([0, 1]);
    for (const positions of [[0, 49], [17, 3], [49, 0], [30, 31]] as Array<[number, number]>) {
      const other = run(positions);
      expect(agentFeedbackFor(other)).toEqual(agentFeedbackFor(reference));
      expect(other).toEqual(reference);
    }
    expect(agentFeedbackFor(reference).measures).toEqual([{ index: 0, pass: true }, { index: 1, pass: false }]);
    // the single matched measure, at positions 0, 17 and 49
    const single = (position: number) => {
      const list: Array<Record<string, unknown>> = Array.from({ length: 50 }, (_, index) => pad(index));
      list[position] = matched[0]!;
      return agentFeedbackFor(evalCheckResult({ roundKind: "check_sealed", head: MeasuresFileSchema.parse({ schemaVersion: 1, measures: list }), base, facts: evalFactsAllRun(30), hiddenSetUsed: true }));
    };
    expect(single(17)).toEqual(single(0));
    expect(single(49)).toEqual(single(0));
    expect(single(0)).toEqual({ measures: [{ index: 0, pass: true }] });
  });
  it("outside a hidden round the position is still the runner's own file position", () => {
    const list: Array<Record<string, unknown>> = [pad(0), matched[0]!];
    const result = evalCheckResult({ roundKind: "check_unsealed", head: MeasuresFileSchema.parse({ schemaVersion: 1, measures: list }), base, facts: evalFactsAllRun(30) });
    expect(result.verdicts.map((verdict) => verdict.index)).toEqual([0, 1]);
  });
});

describe("a hidden-set round keeps every value out of the evidence", () => {
  const base: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }], caseCount: 40, recordedOn: "2026-11-13", roundKind: "check_sealed", runnerSchemaVersion: 1 };
  it("names and units come only from the base record; the v2 measures are empty, the verdict holds no score, and the summary has pass or fail words only", () => {
    const canary = `c-${randomBytes(4).toString("hex")}`;
    const head = MeasuresFileSchema.parse({ schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8123456, direction: "up_good", spread: 0.05 }, { name: canary, unit: canary, value: 0.5, direction: "up_good", spread: 0.1 }] });
    const result = evalCheckResult({ roundKind: "check_sealed", head, base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    const text = JSON.stringify(result);
    expect(text).not.toContain(canary);
    expect(text).not.toContain("0.8123456");
    expect(result.measures).toEqual([]);
    expect(result.verdicts.map((verdict) => verdict.head)).toEqual([undefined]);
    expect(result.verdicts.map((verdict) => verdict.base)).toEqual([undefined]);
    expect(result.summary).toBe("Eval (your runner): accuracy: no detectable drop on the hidden set");
    expect(JSON.stringify(agentFeedbackFor(result))).not.toContain(canary);
  });
  it("without a hidden set the runner's own measure name is shown (inertly), as before", () => {
    const head = MeasuresFileSchema.parse({ schemaVersion: 1, measures: [{ name: "brand-new-measure", unit: "fraction", value: 0.5, direction: "up_good", spread: 0.1 }] });
    const result = evalCheckResult({ roundKind: "check_unsealed", head, base, facts: evalFactsAllRun(40) });
    expect(result.verdicts[0]!.label).toBe("brand-new-measure");
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
