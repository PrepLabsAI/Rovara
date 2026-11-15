import { expect, it } from "vitest";
import { evalHealthPower, evalHealthSensitivity } from "../../packages/worker/src/verification/eval-health-power.js";
it("uses the F3c rule: no-change stays quiet and a seeded hard20 drop is caught", () => {
  const probabilities = Array.from({ length: 50 }, () => .85);
  expect(evalHealthPower(probabilities, 0, 1000)).toBeLessThan(.025);
  expect(evalHealthPower(probabilities, .2, 1000)).toBeGreaterThan(.85);
}, 60_000);
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
it("does not promise a drop larger than the measured passing share", () => {
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: String(i), samples: Array.from({ length: 3 }, () => ({ pass: i < 3, answer: "a" })) }));
  const result = evalHealthSensitivity(questions);
  expect(result.powerAt20).toBe(0); expect(result.additionalQuestionsFor20).toBeNull();
  if (result.smallestDropPoints !== null) expect(result.smallestDropPoints).toBeLessThanOrEqual(15);
});
