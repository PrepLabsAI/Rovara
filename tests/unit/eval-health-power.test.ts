import { expect, it } from "vitest";
import { evalHealthPower, evalHealthSensitivity } from "../../packages/worker/src/verification/eval-health-power.js";
it("does not treat three identical answers as certainty, and reports the estimate assumptions", () => {
  const result = evalHealthSensitivity(Array.from({ length: 20 }, (_, i) => ({ id: String(i), samples: Array.from({ length: 3 }, () => ({ pass: true, answer: "same" })) })));
  expect(result.powerAt20).toBeGreaterThan(0); expect(result.powerAt20).toBeLessThan(1);
  expect(result.smallestDropPoints).toBeGreaterThanOrEqual(5);
  expect(result.additionalQuestionsFor20).not.toBeNull();
  expect(result.note).toContain("estimate"); expect(result.note).toContain("80%");
}, 60_000);
it.each([[[], .2, 1], [[NaN], .2, 1], [[1], NaN, 1], [[1], .2, 5001]] as const)("refuses invalid or unbounded simulation inputs", (ps, drop, trials) => {
  expect(() => evalHealthPower(ps, drop, trials)).toThrow();
});
