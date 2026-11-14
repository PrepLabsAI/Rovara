import { EVAL_QUESTION_LIMIT, evalCheckResult, evalNeedsSecondLook, evalSuspects, type EvalQuestionComparison, type EvalQuestionSamples } from "@agentx/contracts";

/** Seeded simulation of the exact F3c rule, including fresh suspect re-asks and second look.
 * A drop removes pass probability from the strongest questions first (the review's hard-drop scenario).
 * This estimates one scenario's power; it is never an eligibility gate or a promise about all changes. */
export function evalHealthPower(probabilities: readonly number[], drop: number, trials = 256): number {
  if (probabilities.length === 0 || probabilities.length > EVAL_QUESTION_LIMIT || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) || !Number.isFinite(drop) || drop < 0 || drop > 1 || !Number.isSafeInteger(trials) || trials < 1 || trials > 5_000) throw new RangeError("invalid power inputs");
  let seed = 7713;
  const random = (): number => { seed += 0x6D2B79F5; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const newer = [...probabilities];
  let remaining = drop * newer.length;
  for (const { p, i } of probabilities.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p)) {
    const loss = Math.min(remaining, Math.max(0, p - .02));
    newer[i] = p - loss; remaining -= loss;
  }
  if (remaining > 1e-8) return 0;
  const draw = (p: number, n: number) => Array.from({ length: n }, () => ({ pass: random() < p, answer: "sample" }));
  let caught = 0;
  for (let trial = 0; trial < trials; trial++) {
    let qs: EvalQuestionComparison[] = probabilities.map((p, i) => ({ id: String(i), category: "ordinary", old: draw(p, 3), first: draw(newer[i]!, 1)[0]! }));
    const suspects = evalSuspects(qs); const selected = new Set([...suspects.down, ...suspects.up]);
    qs = qs.map((q, i) => selected.has(q.id) ? { ...q, freshOld: draw(probabilities[i]!, 3), freshNew: draw(newer[i]!, 3) } : q);
    if (evalNeedsSecondLook(qs)) qs = qs.map((q, i) => ({ ...q, moreNew: draw(newer[i]!, 2) }));
    if (evalCheckResult({ roundKind: "check_unsealed", questions: qs, changedPromptCalls: 1 }).label === "Worse on eval") caught++;
  }
  return caught / trials;
}
export interface EvalHealthSensitivity {
  powerAt20: number;
  smallestDropPoints: number | null;
  additionalQuestionsFor20: number | null;
  note: string;
}
export function evalHealthSensitivity(questions: readonly EvalQuestionSamples[]): EvalHealthSensitivity {
  // Jeffreys smoothing: three identical outcomes do not imply a probability of zero or one.
  const probabilities = questions.map(q => (q.samples.filter(s => s.pass).length + .5) / (q.samples.length + 1));
  const observed = questions.reduce((sum, q) => sum + q.samples.filter(s => s.pass).length, 0) / questions.reduce((sum, q) => sum + q.samples.length, 0);
  const powerAt20 = observed >= .2 ? evalHealthPower(probabilities, .2) : 0;
  let smallestDropPoints: number | null = null;
  const mean = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  // Search five-point steps; only the tested steps are claimed, never an exact threshold.
  for (let points = 5; points <= Math.floor(Math.min(mean - .02, observed) * 20) * 5; points += 5) {
    const power = points === 20 ? powerAt20 : evalHealthPower(probabilities, points / 100);
    if (power >= .8) { smallestDropPoints = points; break; }
  }
  let additionalQuestionsFor20: number | null = powerAt20 >= .8 ? 0 : null;
  if (additionalQuestionsFor20 === null && mean >= .22 && observed >= .2) {
    // Bounded growth estimates; repeated probabilities mean new questions have comparable wobble.
    for (let n = Math.min(EVAL_QUESTION_LIMIT, Math.max(20, questions.length * 2)); n > questions.length; n = Math.min(EVAL_QUESTION_LIMIT, n * 2)) {
      if (evalHealthPower(Array.from({ length: n }, (_, i) => probabilities[i % probabilities.length]!), .2) >= .8) { additionalQuestionsFor20 = n - questions.length; break; }
      if (n === EVAL_QUESTION_LIMIT) break;
    }
  }
  return { powerAt20, smallestDropPoints, additionalQuestionsFor20,
    note: observed === 0 ? "No baseline answers passed, so there are no passing answers to lose in a further drop." : "Simulation estimate: 80% catch probability, 256 seeded trials, five-point drop steps, independent questions with similar wobble and fresh per-question re-asks. Extra-question counts use tested doubled sizes, up to 1,000 questions. Three runs cannot establish certainty; correlated questions or provider caching can weaken this estimate." };
}
