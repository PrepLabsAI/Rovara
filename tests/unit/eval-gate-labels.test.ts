// TE-F3-b: the local mirror of A3-2's label contract (pr/te-a3-trust-classes-2 @ 7b440ce01). The words are pinned here so a drift from A3's words is caught; the DEFERRED row says to switch to A3's own file after both merge.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHANGE_PROOF_LABELS, CHANGE_PROOF_LABEL_WORDS, EVAL_NOT_QUALIFIED_REASONS, EVAL_NOT_QUALIFIED_REASON_WORDS, changeProofLabelCountsAsProven, changeProofLabelQualified, evalProofLabel } from "../../packages/contracts/src/eval-gate-labels.js";
import { EVAL_GATE_DETAILS, EVAL_GATE_DETAIL_ROWS } from "../../packages/contracts/src/eval-gate.js";

describe("the A3 label mirror", () => {
  it("has A3's exact labels, reasons and words", () => {
    expect([...CHANGE_PROOF_LABELS]).toEqual(["proven", "no_regression_eval", "improved_eval", "eval_not_qualified"]);
    expect(CHANGE_PROOF_LABEL_WORDS).toEqual({ proven: "Proven", no_regression_eval: "No regression measured (eval)", improved_eval: "Improved on eval", eval_not_qualified: "Eval not qualified" });
    expect([...EVAL_NOT_QUALIFIED_REASONS]).toEqual(["not_gated", "cannot_detect_drop", "too_few_questions", "cap_hit", "provider_outage", "questions_edited_by_change", "baseline_too_old", "no_coverage_evidence", "judge_not_pinned", "replies_not_independent"]);
    expect(EVAL_NOT_QUALIFIED_REASON_WORDS.cannot_detect_drop).toBe("the eval cannot detect the agreed drop");
    expect(EVAL_NOT_QUALIFIED_REASON_WORDS.questions_edited_by_change).toBe("the change edited the eval questions, scoring or thresholds");
  });
  it("labels an eval no_regression_eval or improved_eval only from a gated outcome; anything else, including a claim of proven, is not qualified", () => {
    expect(evalProofLabel({ outcome: "no_regression_eval" })).toEqual({ label: "no_regression_eval", words: "No regression measured (eval)" });
    expect(evalProofLabel({ outcome: "improved_eval" })).toEqual({ label: "improved_eval", words: "Improved on eval" });
    for (const outcome of ["proven", "passed", undefined, "not_qualified"]) expect(evalProofLabel({ outcome }).label).toBe("eval_not_qualified");
    expect(evalProofLabel({ outcome: "proven", reason: "cap_hit" }).words).toBe("not qualified: a cap was hit");
    expect(evalProofLabel({ outcome: "x", reason: "bogus" }).words).toBe("not qualified: the result was not gated");
    expect(changeProofLabelCountsAsProven("no_regression_eval")).toBe(false);
    expect(changeProofLabelCountsAsProven("improved_eval")).toBe(false);
    expect(changeProofLabelCountsAsProven("proven")).toBe(true);
    expect(changeProofLabelQualified("eval_not_qualified")).toBe(false);
    expect(changeProofLabelQualified("improved_eval")).toBe(true);
  });
  it("maps every gate detail to one of A3's reasons with fixed words", () => {
    expect(EVAL_GATE_DETAILS.length).toBe(Object.keys(EVAL_GATE_DETAIL_ROWS).length);
    for (const detail of EVAL_GATE_DETAILS) {
      expect((EVAL_NOT_QUALIFIED_REASONS as readonly string[]).includes(EVAL_GATE_DETAIL_ROWS[detail].reason)).toBe(true);
      expect(EVAL_GATE_DETAIL_ROWS[detail].words).toMatch(/^[a-z]/u);
    }
  });
  it("is not re-exported by the package index (so A3's own names cannot collide after both merge)", () => {
    expect(readFileSync(new URL("../../packages/contracts/src/index.ts", import.meta.url), "utf8")).not.toMatch(/from "\.\/eval-gate-labels/u);
  });
});
