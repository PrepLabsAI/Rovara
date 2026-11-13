// TE-F3 part A: the hidden eval set rules (O44). A hidden set is mounted only in the sealed round; every other round answers with one fixed sentence; what goes back to the coding agent is a score and a count per measure and nothing else.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_EGRESS_ROUND_KINDS } from "../../packages/contracts/src/model-egress/evidence-lines.js";
import { MeasuresFileSchema } from "../../packages/contracts/src/measures-file.js";
import { evalCheckResult } from "../../packages/contracts/src/eval-check.js";
import type { EvalBaseRecord } from "../../packages/contracts/src/eval-base-cache.js";
import { evalFactsAllRun } from "../../packages/contracts/src/eval-pacing.js";
import {
  EVAL_ROUND_KINDS, HIDDEN_EVAL_MOUNT_PATH, HIDDEN_EVAL_NEEDS_SEALED_SENTENCE, agentFeedbackFor, hiddenEvalSetFor, type HiddenEvalSetSource,
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

  it("is a score and a count per measure, by position, and nothing else", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([{ name: "accuracy", unit: "fraction", value: 0.8234, direction: "up_good", spread: 0.05, count: 40 }, { name: "recall", unit: "fraction", value: 0.7, direction: "up_good", spread: 0.05 }]), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    const feedback = agentFeedbackFor(result);
    expect(Object.keys(feedback)).toEqual(["measures"]);
    expect(feedback.measures).toEqual([{ index: 0, score: 0.82, count: 40 }, { index: 1, score: 0.7, count: 40 }]);
    for (const entry of feedback.measures) expect(Object.keys(entry)).toEqual(["index", "score", "count"]);
  });
  it("carries no case id, input, output, name, diff or path even when the result object is hostile", () => {
    const canary = `c-${randomBytes(4).toString("hex")}`;
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05, count: 40 }]), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    const hostile = { ...result, caseIds: [canary], verdicts: result.verdicts.map((verdict) => ({ ...verdict, caseId: canary, label: canary, input: canary, path: `/hidden/${canary}`, sentence: canary })), summary: canary };
    const text = JSON.stringify(agentFeedbackFor(hostile));
    expect(text).not.toContain(canary);
    expect(text).not.toContain("/hidden");
  });
  it("is empty when the eval did not run (no score is invented)", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }]), base, facts: { total: 40, run: 10, notRun: 30, byClass: { rate_limit: 30 }, overrunStop: false }, hiddenSetUsed: true });
    expect(agentFeedbackFor(result)).toEqual({ measures: [] });
  });
  it("rounds the score to two decimals, so the exact value is not handed out digit by digit", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([{ name: "accuracy", unit: "fraction", value: 0.8349999, direction: "up_good", spread: 0.05, count: 40 }]), base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    expect(agentFeedbackFor(result).measures[0]!.score).toBe(0.83);
  });
});

describe("a hidden-set round never lets the runner's own words into the evidence", () => {
  const base: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }], caseCount: 40, recordedOn: "2026-11-13", roundKind: "check_sealed", runnerSchemaVersion: 1 };
  it("names and units come only from the base record; a measure the base does not know is shown anonymously with its name dropped", () => {
    const canary = `c-${randomBytes(4).toString("hex")}`;
    const head = MeasuresFileSchema.parse({ schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }, { name: canary, unit: canary, value: 0.5, direction: "up_good", spread: 0.1 }] });
    const result = evalCheckResult({ roundKind: "check_sealed", head, base, facts: evalFactsAllRun(40), hiddenSetUsed: true });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(agentFeedbackFor(result))).not.toContain(canary);
    expect(result.verdicts[1]).toMatchObject({ verdict: "not_run", reason: "no_base_score", label: "eval measure 2" });
    expect(result.measures.map((measure) => measure.name)).toEqual(["accuracy"]);
  });
  it("without a hidden set the runner's own measure name is shown (inertly), as before", () => {
    const head = MeasuresFileSchema.parse({ schemaVersion: 1, measures: [{ name: "brand-new-measure", unit: "fraction", value: 0.5, direction: "up_good", spread: 0.1 }] });
    const result = evalCheckResult({ roundKind: "check_unsealed", head, base, facts: evalFactsAllRun(40) });
    expect(result.verdicts[0]!.label).toBe("brand-new-measure");
  });
});
