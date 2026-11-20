// L4-TA6b: `fitRoundEstimateUsd` is the estimate one more automatic round is gated on: at most the usual $3, never more than is left under the cap, and a round is not tried at all with less than $0.25 left.
import { describe, expect, it } from "vitest";
import { workflowAutoSpendRefusal, wholeTaskSpendUsd } from "@agentx/contracts";
import { AUTOFIX_MIN_ROUND_USD, AUTOFIX_ROUND_ESTIMATE_USD, fitRoundEstimateUsd } from "../../packages/broker/src/core/build-step/autofix.js";

const refusal = (spent: number, cap: number) => workflowAutoSpendRefusal({ spentUsd: wholeTaskSpendUsd(spent), roundEstimateUsd: fitRoundEstimateUsd(AUTOFIX_ROUND_ESTIMATE_USD, spent, cap), capUsd: cap });

describe("fitRoundEstimateUsd (L4-TA6b)", () => {

  it("is kept above what is left, so the policy refuses, when less than $0.25 is left (or nothing, or less than nothing)", () => {
    for (const [spent, cap] of [[0.8, 1], [0.76, 1], [0.999999, 1], [1, 1], [2, 1], [14.8, 15]] as const) {
      expect(fitRoundEstimateUsd(3, spent, cap), `${String(spent)}/${String(cap)}`).toBeGreaterThanOrEqual(AUTOFIX_MIN_ROUND_USD);
      expect(refusal(spent, cap), `${String(spent)}/${String(cap)}`).toBe("spend-cap");
    }
    // exactly the floor is tried
    expect(refusal(0.75, 1)).toBeUndefined();
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
