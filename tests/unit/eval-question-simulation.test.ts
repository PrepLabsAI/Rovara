import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { evalCheckResult, evalNeedsSecondLook, evalSuspects, type EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
// Seeded port of the review's evalsim2.py populations and hard20 effect.
function random(seed: number) { let state = seed >>> 0; return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
it("holds false Worse below 2.5% and catches hard20 at the agreed power across every population", () => {
  const reference = JSON.parse(readFileSync(new URL("../fixtures/eval-simulation-reference.json", import.meta.url), "utf8")) as Array<{ n: number; rate: number; mix: number; effect: string; worse: number }>;
  const trials = 5000;
  const table: string[] = [];
  for (const n of [20, 50, 200]) for (const rate of [.7, .85, .95]) for (const mix of [1, .2, .05]) {
    const rng = random(77 + n * 1000 + rate * 100 + mix * 10000);
    let falseWorse = 0; let caught = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const probs = Array.from({ length: n }, () => mix === 1 ? Math.max(0, Math.min(1, rate + .1 * Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng()))) : rng() < mix ? .3 + rng() * .65 : Number(rng() < (rate - (mix === .2 ? .125 : .03)) / (1 - mix)));
      const broken = new Set(probs.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p).slice(0, Math.round(n * .2)).map(x => x.i));
      for (const effect of [false, true]) {
        const draw = (p: number, count: number) => Array.from({ length: count }, () => ({ pass: rng() < p, answer: "a" }));
        const newer = probs.map((p, i) => effect && broken.has(i) ? .02 : p);
        let qs: EvalQuestionComparison[] = probs.map((p, i) => ({ id: String(i), category: "ordinary", old: draw(p, 3), first: draw(newer[i]!, 1)[0]! }));
        const selected = evalSuspects(qs);
        qs = qs.map((q, i) => [...selected.down, ...selected.up].includes(q.id) ? { ...q, freshOld: draw(probs[i]!, 3), freshNew: draw(newer[i]!, 3) } : q);
        if (evalNeedsSecondLook(qs)) qs = qs.map((q, i) => ({ ...q, moreNew: draw(newer[i]!, 2) }));
        const result = evalCheckResult({ roundKind: "check_unsealed", questions: qs, changedPromptCalls: 1 });
        expect(result.label).not.toBe("Not run");
        if (result.label === "Worse on eval") { if (effect) caught += 1; else falseWorse += 1; }
      }
    }
    const tag = `${n} / ${rate} / ${mix}`;
    table.push(`${tag}: false=${(100 * falseWorse / trials).toFixed(2)}%, hard20=${(100 * caught / trials).toFixed(2)}%`);
    console.log(table[table.length - 1]);
    for (const ref of reference.filter(row => row.n === n && row.rate === rate && row.mix === mix)) {
      // Published reference used 1500 trials at 20/50, only 300 at 200.
      expect(Math.abs((ref.effect === "none" ? falseWorse : caught) / trials - ref.worse), `reference ${tag} ${ref.effect}`).toBeLessThan(n === 200 ? .08 : .05);
    }
    expect(falseWorse / trials, tag).toBeLessThan(.025);
    expect(caught / trials, tag).toBeGreaterThanOrEqual(n === 20 ? .65 : .9);
  }
  const report = process.env["EVAL_SIM_REPORT"];
  if (report !== undefined) writeFileSync(report, table.join("\n") + "\n");
}, 900_000);
