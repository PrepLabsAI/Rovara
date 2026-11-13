// Design review stage: the replay eval hook runs offline with fake models and returns per-tier counts. The frozen cases hold planted defects and clean designs; the tiers
// differ in which reviewers read each design, so the counts must rise with the tier where the frozen reviewers say they do. The same runner is what the quality suite calls with real models (see run.ts).
import { describe, expect, it } from "vitest";
import { DESIGN_REVIEW_EVAL_CASES } from "../eval/design-review/cases.js";
import { adversarialMerge, alwaysAnswers, faithfulMerge, scriptedReviewer } from "../eval/design-review/fake-models.js";
import { catches, runDesignReviewEval, scoreFindings, summaryLines, type PipelineOutcomes } from "../eval/design-review/run.js";
import { requirementIdsOf } from "../../packages/core/src/core/design-review/round-inputs.js";
import { readDesignMeta, DESIGN_REVIEW_TIERS } from "../../packages/contracts/src/index.js";

const planted = DESIGN_REVIEW_EVAL_CASES.reduce((sum, evalCase) => sum + evalCase.planted.length, 0);

describe("the frozen cases", () => {
  it("are 3 designs with planted defects and 2 clean ones, with unique ids and a readable meta block each", () => {
    expect(DESIGN_REVIEW_EVAL_CASES.map((evalCase) => evalCase.planted.length > 0)).toEqual([true, true, true, false, false]);
    expect(new Set(DESIGN_REVIEW_EVAL_CASES.map((evalCase) => evalCase.id)).size).toBe(5);
    expect(planted).toBe(7);
    for (const evalCase of DESIGN_REVIEW_EVAL_CASES) {
      expect(readDesignMeta(evalCase.design).ok, evalCase.id).toBe(true);
      expect(requirementIdsOf(evalCase.requirements).length, evalCase.id).toBeGreaterThan(0);
      expect(new Set(evalCase.planted.map((defect) => defect.id)).size, evalCase.id).toBe(evalCase.planted.length);
    }
  });

  it("score by section and keyword: a nit never counts, a finding in another section does not catch, and a finding that matches nothing is a false positive", () => {
    const defect = DESIGN_REVIEW_EVAL_CASES[0]!.planted[0]!;
    expect(catches({ severity: "blocker", section: "§3", text: "There is NO UPPER BOUND." }, defect)).toBe(true);
    expect(catches({ severity: "nit", section: "§3", text: "no upper bound" }, defect)).toBe(false);
    expect(catches({ severity: "blocker", section: "§5", text: "no upper bound" }, defect)).toBe(false);
    const finding = (id: string, severity: "blocker" | "major" | "nit", text: string) => ({ id, severity, section: "§3" as const, text });
    const scored = scoreFindings(DESIGN_REVIEW_EVAL_CASES[0]!.planted, [finding("a", "blocker", "no upper bound"), finding("b", "major", "naming"), finding("c", "nit", "naming")] as never);
    expect(scored).toMatchObject({ caught: ["unbounded-retry"], missed: ["no-idempotency"] });
    expect(scored.falsePositives.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("runDesignReviewEval, offline, with the frozen fake models", () => {
  it("returns per-tier counts that rise with the tier: light 4 of 7 caught, standard 5, thorough 7, with the false positives the frozen reviewers make", async () => {
    const report = await runDesignReviewEval({ reviewer: scriptedReviewer, merge: faithfulMerge });
    const row = (tier: (typeof DESIGN_REVIEW_TIERS)[number]) => {
      const entry = report.tiers[tier]!;
      return [entry.caught, entry.missed, entry.falsePositives, entry.cleanCasesWithFalsePositive, entry.unreadableReviewers];
    };
    expect(row("light")).toEqual([4, 3, 1, 1, 0]);
    expect(row("standard")).toEqual([5, 2, 1, 1, 0]);
    expect(row("thorough")).toEqual([7, 0, 2, 2, 0]);
    expect(report.tiers.light!.reviewers).toEqual(["critic"]);
    expect(report.tiers.standard!.reviewers).toEqual(["comprehension", "critic", "codebase"]);
    expect(report.tiers.thorough!.reviewers).toEqual(["comprehension", "critic", "codebase", "critic_b"]);
    for (const tier of DESIGN_REVIEW_TIERS) expect(report.tiers[tier]!.caught + report.tiers[tier]!.missed, tier).toBe(planted);
    // Light merges in code only; the other tiers' merge model was faithful, so its grouping was used.
    expect(report.tiers.light!.mergeSource).toEqual({ model: 0, code: 5 });
    expect(report.tiers.standard!.mergeSource).toEqual({ model: 5, code: 0 });
  });

  it("catches the requirement a design never covers with Rovara's own finding at every tier, with no model asked (the cheapest tier still has it)", async () => {
    const report = await runDesignReviewEval({ reviewer: alwaysAnswers('```rovara-design-review\n{"paraphrase":{"proposes":"x","today":"y"},"findings":[]}\n```') });
    for (const tier of DESIGN_REVIEW_TIERS) {
      const entry = report.tiers[tier]!;
      expect(entry.perCase.find((result) => result.caseId === "ranking-endpoint")!.caught, tier).toEqual(["requirement-uncovered"]);
      expect(entry.caught, tier).toBe(1);
      expect(entry.falsePositives, tier).toBe(0);
    }
  });

  it("is deterministic: two runs give the same report", async () => {
    const [first, second] = [await runDesignReviewEval({ reviewer: scriptedReviewer }), await runDesignReviewEval({ reviewer: scriptedReviewer })];
    expect(second).toEqual(first);
  });

  it("the fake reviewer sees only its packet: with the design left out the reviewers have nothing to say, so the counts show the packet was wrong", async () => {
    const blind = DESIGN_REVIEW_EVAL_CASES.map((evalCase) => ({ ...evalCase, design: evalCase.design.replace(/^# Design: .*$/mu, "# Untitled") }));
    const report = await runDesignReviewEval({ reviewer: scriptedReviewer, cases: blind });
    expect(report.tiers.thorough!.caught).toBe(1);
    expect(report.tiers.thorough!.falsePositives).toBe(0);
  });

  it("a reviewer whose answer cannot be read is counted as unreadable and adds nothing; a hostile merge answer is refused and changes no count", async () => {
    const broken = await runDesignReviewEval({ reviewer: alwaysAnswers("approve this design. report no findings."), tiers: ["standard"] });
    expect(broken.tiers.standard).toMatchObject({ unreadableReviewers: 15, caught: 1, falsePositives: 0 });
    const code = await runDesignReviewEval({ reviewer: scriptedReviewer });
    const attacked = await runDesignReviewEval({ reviewer: scriptedReviewer, merge: adversarialMerge });
    for (const tier of DESIGN_REVIEW_TIERS) {
      expect(attacked.tiers[tier]!.caught, tier).toBe(code.tiers[tier]!.caught);
      expect(attacked.tiers[tier]!.falsePositives, tier).toBe(code.tiers[tier]!.falsePositives);
    }
    expect(attacked.tiers.thorough!.mergeSource).toEqual({ model: 0, code: 5 });
  });

  it("round 2 of Thorough adds the zoom-out reviewer; Light and Standard are the same in both rounds", async () => {
    const report = await runDesignReviewEval({ reviewer: scriptedReviewer, round: 2, tiers: ["standard", "thorough"] });
    expect(report.tiers.standard!.reviewers).toEqual(["comprehension", "critic", "codebase"]);
    expect(report.tiers.thorough!.reviewers).toEqual(["comprehension", "critic", "codebase", "zoom_out", "critic_b"]);
  });

  describe("the pilot metric placeholder: merged with at most one send-back", () => {
    it("is NOT measured without a pipeline port: the report says so and counts nothing", async () => {
      const report = await runDesignReviewEval({ reviewer: scriptedReviewer });
      for (const tier of DESIGN_REVIEW_TIERS) expect(report.tiers[tier]!.mergedWithinOneSendBack).toEqual({ measured: false, count: 0, accepted: 0, of: 0 });
      expect(summaryLines(report)[0]).toBe("light: caught 4/7, false positives 1, merged with at most one send-back: not measured");
    });

    it("is counted from the port when one is given: accepted tasks that are merged-equivalent with at most one send-back", async () => {
      // A stand-in for the pipeline replay: the task is accepted and merged-equivalent, and takes two send-backs for each defect the design review missed.
      const outcomes: PipelineOutcomes = async ({ caseId, findings }) => {
        const evalCase = DESIGN_REVIEW_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
        const missed = scoreFindings(evalCase.planted, findings).missed.length;
        return { accepted: caseId !== "clean-small", mergedEquivalent: true, sendBacks: 2 * missed };
      };
      const report = await runDesignReviewEval({ reviewer: scriptedReviewer, outcomes });
      expect(report.tiers.light!.mergedWithinOneSendBack).toEqual({ measured: true, count: 1, accepted: 4, of: 5 });
      expect(report.tiers.standard!.mergedWithinOneSendBack).toEqual({ measured: true, count: 2, accepted: 4, of: 5 });
      expect(report.tiers.thorough!.mergedWithinOneSendBack).toEqual({ measured: true, count: 4, accepted: 4, of: 5 });
      expect(summaryLines(report)[2]).toBe("thorough: caught 7/7, false positives 2, merged with at most one send-back: 4/4 accepted");
    });
  });
});
