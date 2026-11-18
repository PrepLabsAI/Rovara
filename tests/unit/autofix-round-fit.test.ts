// L4-TA6b: `fitRoundEstimateUsd` is the estimate one more automatic round is gated on: at most the usual $3, never more than is left under the cap, and a round is not tried at all with less than $0.25 left.
import { describe, expect, it } from "vitest";
import { workflowAutoSpendRefusal, wholeTaskSpendUsd } from "@agentx/contracts";
import { AUTOFIX_MIN_ROUND_USD, AUTOFIX_ROUND_ESTIMATE_USD, fitRoundEstimateUsd } from "../../packages/broker/src/core/build-step/autofix.js";

const refusal = (spent: number, cap: number) => workflowAutoSpendRefusal({ spentUsd: wholeTaskSpendUsd(spent), roundEstimateUsd: fitRoundEstimateUsd(AUTOFIX_ROUND_ESTIMATE_USD, spent, cap), capUsd: cap });

describe("fitRoundEstimateUsd (L4-TA6b)", () => {
  it("is the usual $3 while there is room for it", () => {
    expect(fitRoundEstimateUsd(3, 0, 10)).toBe(3);
    expect(fitRoundEstimateUsd(3, 7, 10)).toBe(3);
    expect(fitRoundEstimateUsd(3, 0, 3)).toBe(3);
  });

  it("is what is left when less than $3 is left, never more", () => {
    expect(fitRoundEstimateUsd(3, 0, 1)).toBe(1);
    expect(fitRoundEstimateUsd(3, 0.5, 1)).toBe(0.5);
    expect(fitRoundEstimateUsd(3, 14, 15)).toBe(1);
    expect(fitRoundEstimateUsd(3, 0.75, 1)).toBeLessThanOrEqual(0.25);
  });

  it("is rounded down to a whole micro-dollar, so spent plus estimate never reads over the cap through floating-point error", () => {
    for (const [spent, cap] of [[0.1, 1], [0.7, 1], [0.9 - 0.2, 1], [2.3, 4.1], [0.3, 0.9], [14.1, 15]] as const) {
      const estimate = fitRoundEstimateUsd(3, spent, cap);
      expect(spent + estimate, `${String(spent)}/${String(cap)}`).toBeLessThanOrEqual(cap);
      expect(refusal(spent, cap), `${String(spent)}/${String(cap)}`).toBeUndefined();
    }
  });

  it("is kept above what is left, so the policy refuses, when less than $0.25 is left (or nothing, or less than nothing)", () => {
    for (const [spent, cap] of [[0.8, 1], [0.76, 1], [0.999999, 1], [1, 1], [2, 1], [14.8, 15]] as const) {
      expect(fitRoundEstimateUsd(3, spent, cap), `${String(spent)}/${String(cap)}`).toBeGreaterThanOrEqual(AUTOFIX_MIN_ROUND_USD);
      expect(refusal(spent, cap), `${String(spent)}/${String(cap)}`).toBe("spend-cap");
    }
    // exactly the floor is tried
    expect(refusal(0.75, 1)).toBeUndefined();
  });

  it("a configured estimate below the floor is still refused under the floor, and a configured estimate is a ceiling, never raised", () => {
    expect(workflowAutoSpendRefusal({ spentUsd: wholeTaskSpendUsd(0.8), roundEstimateUsd: fitRoundEstimateUsd(0.1, 0.8, 1), capUsd: 1 })).toBe("spend-cap");
    expect(fitRoundEstimateUsd(2, 0, 10)).toBe(2);
    expect(fitRoundEstimateUsd(2, 9.5, 10)).toBe(0.5);
  });

  it("unknown stays unknown: a spend or cap that is not a finite non-negative number leaves the estimate alone, and the policy asks inputs-missing", () => {
    for (const [spent, cap] of [[Number.NaN, 1], [0, Number.NaN], [-1, 1], [0, -1], [Number.POSITIVE_INFINITY, 1], [0, Number.POSITIVE_INFINITY]] as const) {
      expect(fitRoundEstimateUsd(3, spent, cap)).toBe(3);
      expect(refusal(spent, cap), `${String(spent)}/${String(cap)}`).toBe("inputs-missing");
    }
  });

  it("never refuses a round that fits through float error, and never misses exactly $0.25 left (reviewer's brute-force cases and a sweep)", () => {
    const cases: Array<[number, number]> = [[0.000008, 0.29], [0.04, 0.29], [0.1, 0.35], [0.16, 0.41]];
    for (const [spent, cap] of cases) {
      expect(refusal(spent, cap), `${String(spent)}/${String(cap)}`).toBeUndefined();
      expect(spent + fitRoundEstimateUsd(3, spent, cap)).toBeLessThanOrEqual(cap);
    }
    // a sweep over caps in cents and spends in whole micros, with at least $0.25 left: always tried; with less: always asked
    for (let capCents = 25; capCents <= 400; capCents += 7) {
      const cap = capCents / 100;
      for (let spentMicros = 0; spentMicros <= capCents * 10_000; spentMicros += 13_337) {
        const spent = spentMicros / 1e6;
        const leftMicros = capCents * 10_000 - spentMicros;
        expect(refusal(spent, cap) === undefined, `${String(spent)}/${String(cap)}`).toBe(leftMicros >= 250_000);
      }
    }
  });
});
