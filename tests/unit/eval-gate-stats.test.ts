// TE-F3-b: the statistics behind the gate. Known values from standard tables, then the paired and Holm rules as behaviour.
import { describe, expect, it } from "vitest";
import { holmRejections, normalCdf, pairQuestionRuns, pairedEffect } from "../../packages/contracts/src/eval-gate-stats.js";

describe("normal distribution", () => {
  it.each([[0, 0.5], [1.959963984540054, 0.975], [-1.959963984540054, 0.025], [0.8416212335729143, 0.8], [3, 0.9986501019683699], [-3, 0.0013498980316301]])("cdf(%s) = %s", (x, expected) => {
    expect(normalCdf(x)).toBeCloseTo(expected, 12);
  });
  it("is monotone, symmetric and clamped", () => {
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 12);
    expect(normalCdf(0.84)).toBeCloseTo(0.79955, 4);
    expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalCdf(-100)).toBe(0);
    expect(Number.isNaN(normalCdf(Number.NaN))).toBe(true);
  });
});

describe("Holm-Bonferroni", () => {
  it("rejects the smallest p at alpha/m, the next at alpha/(m-1), and stops at the first that fails", () => {
    // alpha 0.025, m = 4: thresholds 0.00625, 0.008333, 0.0125, 0.025.
    expect(holmRejections([0.005, 0.009, 0.2, 0.0001], 0.025)).toEqual([true, true, false, true]);
    expect(holmRejections([0.005, 0.013, 0.2, 0.0001], 0.025)).toEqual([true, false, false, true]);
    expect(holmRejections([0.02, 0.5, 0.6], 0.025)).toEqual([false, false, false]);
    expect(holmRejections([0.02], 0.025)).toEqual([true]);
  });
  it("is more careful than no correction: 0.02 is under alpha but not under alpha/3", () => {
    expect(holmRejections([0.02, 0.3, 0.4], 0.025)).toEqual([false, false, false]);
  });
  it("walks all the way when every p passes, in the input's order", () => {
    expect(holmRejections([0.0124, 0.001, 0.0083], 0.025)).toEqual([true, true, true]);
  });
  it("never rejects a p that is not a number in [0, 1]", () => {
    expect(holmRejections([Number.NaN, -0.1, 1.5, 0.0001], 0.025)).toEqual([false, false, false, true]);
  });
});

describe("paired effect", () => {
  const q = (id: string, baseRuns: number[], headRuns: number[], category = "c") => ({ id, category, baseRuns, headRuns });
  it("is the mean difference with a standard error from the OLD runs only", () => {
    const got = pairedEffect([q("a", [0.5, 0.7, 0.6], [0.7, 0.9]), q("b", [0.2, 0.2, 0.2], [0.2, 0.2])]);
    expect(got?.effect).toBeCloseTo(0.1, 12);
    // question a: variance of old runs 0.01, x (1/3 + 1/2); question b: 0.
    expect(got?.se).toBeCloseTo(Math.sqrt(0.01 * (1 / 3 + 1 / 2)) / 2, 12);
    expect(got?.baseMean).toBeCloseTo(0.4, 12);
    expect(got?.headMean).toBeCloseTo(0.5, 12);
  });
  it("does not depend on how different the questions are from each other (that is what pairing removes)", () => {
    const same = pairedEffect([q("a", [0.1, 0.1, 0.1], [0.1]), q("b", [0.9, 0.9, 0.9], [0.9])]);
    expect(same?.se).toBe(0);
    expect(same?.effect).toBe(0);
  });
  it("has no answer for no questions, one old run (no noise estimate) or no new run", () => {
    expect(pairedEffect([])).toBeUndefined();
    expect(pairedEffect([q("a", [0.5], [0.5])])).toBeUndefined();
    expect(pairedEffect([q("a", [0.5, 0.5], [])])).toBeUndefined();
  });
  it("pairs question runs by id, orders runs by index, and counts questions missing on a side", () => {
    const row = (id: string, run: number, score: number, category = "c") => ({ id, category, run, score });
    const got = pairQuestionRuns([row("a", 1, 0.8), row("a", 0, 0.6), row("gone", 0, 1)], [row("a", 0, 0.7), row("new", 0, 1)]);
    expect(got.paired).toEqual([{ id: "a", category: "c", baseRuns: [0.6, 0.8], headRuns: [0.7], baseIndexes: [0, 1], headIndexes: [0] }]);
    expect(got.unpaired.sort()).toEqual(["gone", "new"]);
    expect(pairQuestionRuns([row("a", 0, 1)], [row("a", 0, 1, "other")]).paired).toEqual([]);
  });
});
