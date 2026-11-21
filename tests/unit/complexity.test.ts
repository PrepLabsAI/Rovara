// Issue #1294: the cognitive complexity score (scripts/complexity.ts), its file set, the hotspot ranking and the CI ratchet.
import { describe, expect, it } from "vitest";
import {
  THRESHOLD,
  compareToBaseline,
  excessOf,
  formatBaseline,
  isSourceFile,
  lowerBaseline,
  parseBaseline,
  parseChurn,
  rankFiles,
  scoreFile,
  scoreSource,
} from "../../scripts/complexity.js";

const scoreOf = (text: string, name: string) => scoreSource(text).find((entry) => entry.name === name)?.score;

describe("cognitive complexity", () => {
  it("scores the paper's sumOfPrimes 7: nested loops and if add their nesting, a labelled continue adds 1", () => {
    const text = `function sumOfPrimes(max: number) {
      let total = 0;
      OUT: for (let i = 1; i <= max; ++i) {
        for (let j = 2; j < i; ++j) {
          if (i % j == 0) {
            continue OUT;
          }
        }
        total += i;
      }
      return total;
    }`;
    expect(scoreOf(text, "sumOfPrimes")).toBe(7);
  });

  it("scores a whole switch 1, however many cases it has", () => {
    expect(scoreOf(`function getWords(n: number) { switch (n) { case 1: return "one"; case 2: return "a couple"; case 3: return "a few"; default: return "lots"; } }`, "getWords")).toBe(1);
  });

  it("adds 1 for else if and else without nesting, and 1 per run of like logical operators", () => {
    // if +1, `a && b && c || d` +2, else if +1, else +1.
    expect(scoreOf(`function f(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) { if (a && b && c || d) {} else if (e) {} else {} }`, "f")).toBe(5);
    expect(scoreOf(`function g(a: boolean, b: boolean) { return (a && b) && a; }`, "g")).toBe(1);
    expect(scoreOf(`function h(a?: string, b?: string) { return a ?? b ?? "x"; }`, "h")).toBe(1);
  });

  it("adds nesting for a ternary inside an if, and for a catch inside a loop", () => {
    expect(scoreOf(`function f(a: boolean, b: boolean) { let x = 0; if (a) { x = b ? 1 : 2; } return x; }`, "f")).toBe(3);
    // for +1, catch +2 (nesting 1), if +3 (nesting 2).
    expect(scoreOf(`function f(x: boolean) { for (;;) { try { break; } catch { if (x) { return; } } } }`, "f")).toBe(6);
  });

  it("scores a nested function by itself: its body does not add to the function around it", () => {
    const text = `function outer(a: boolean, b: boolean) { if (a) {} const inner = () => { if (b) {} }; return inner; }`;
    expect(scoreOf(text, "outer")).toBe(1);
    expect(scoreOf(text, "inner")).toBe(1);
  });

  it("names methods by their class, callbacks by their call, and a returned handler by the factory that returns it", () => {
    const text = `class Store { save(a: boolean) { if (a) {} } constructor() { if (Math.random()) {} } }
      [1].map((n) => { if (n) {} });
      export function createHandler() { return async (event: unknown) => { if (event) {} }; }`;
    const names = scoreSource(text).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["Store.save", "Store.constructor", "(callback in [1].map)", "createHandler", "(returned by createHandler)"]));
  });

  it("scores the top level of a module as its own entry, and leaves it out when it has no branches", () => {
    expect(scoreOf(`if (process.argv[2] === "x") { console.log(1); }`, "(top level)")).toBe(1);
    expect(scoreSource(`export const a = 1;`).map((entry) => entry.name)).not.toContain("(top level)");
  });

  it("counts excess as the sum of each function's score above the threshold", () => {
    expect(THRESHOLD).toBe(15);
    expect(excessOf([{ name: "a", line: 1, score: 20 }, { name: "b", line: 2, score: 15 }, { name: "c", line: 3, score: 16 }])).toBe(6);
    const deep = `function deep(a: boolean) { ${"if (a) { ".repeat(6)}${"} ".repeat(6)} }`; // 1+2+3+4+5+6 = 21
    expect(scoreFile("x.ts", deep)).toMatchObject({ excess: 6, lines: 1 });
  });
});

describe("the files it covers", () => {
  it("takes production TypeScript and leaves out tests, fixtures, declarations and build output", () => {
    expect(isSourceFile("packages/broker/src/aws/broker.ts")).toBe(true);
    expect(isSourceFile("packages/web/src/App.tsx")).toBe(true);
    expect(isSourceFile("scripts/ci-plan.ts")).toBe(true);
    for (const path of ["packages/broker/src/x.test.ts", "packages/a/src/types.d.ts", "packages/a/dist/x.ts", "infra/test/fixtures/x.ts", "packages/a/src/tests/x.ts", "scripts/README.md"]) {
      expect(isSourceFile(path), path).toBe(false);
    }
  });
});

describe("the hotspot report", () => {
  it("counts commits per file from git log --name-only, and ranks by excess x (1 + commits)", () => {
    const commits = parseChurn("a.ts\nb.ts\n\na.ts\n");
    expect(commits).toEqual({ "a.ts": 2, "b.ts": 1 });
    const files = [
      { file: "a.ts", lines: 10, functions: [], excess: 10 },
      { file: "b.ts", lines: 10, functions: [], excess: 20 },
      { file: "c.ts", lines: 10, functions: [], excess: 0 },
    ];
    expect(rankFiles(files, commits, "hotspot").map((row) => [row.file, row.hotspot])).toEqual([["b.ts", 40], ["a.ts", 30]]);
    expect(rankFiles(files, commits, "complexity").map((row) => row.file)).toEqual(["b.ts", "a.ts"]);
  });
});

describe("the ratchet", () => {
  it("fails a file whose excess went up, and a new file with any", () => {
    const result = compareToBaseline({ "a.ts": 10 }, { "a.ts": 11, "new.ts": 3 });
    expect(result.pass).toBe(false);
    expect(result.raised).toHaveLength(2);
    expect(result.raised.join("\n")).toMatch(/a\.ts has excess complexity 11, more than its baseline of 10/u);
    expect(result.raised.join("\n")).toMatch(/new\.ts has excess complexity 3 and no baseline entry/u);
  });

  it("passes the same or lower excess, with a reminder to lower the baseline", () => {
    const result = compareToBaseline({ "a.ts": 10, "gone.ts": 4 }, { "a.ts": 7 });
    expect(result.pass).toBe(true);
    expect(result.lowered).toHaveLength(2);
    expect(compareToBaseline({ "a.ts": 10 }, { "a.ts": 10 })).toMatchObject({ pass: true, lowered: [] });
  });

  it("update only lowers: never raises an entry or adds a file, and drops simplified or deleted ones", () => {
    const lowered = lowerBaseline({ "a.ts": 10, "b.ts": 5, "gone.ts": 4 }, { "a.ts": 12, "b.ts": 2, "new.ts": 9 });
    expect(lowered).toEqual({ "a.ts": 10, "b.ts": 2, "gone.ts": 0 });
    expect(parseBaseline(formatBaseline(lowered))).toEqual({ "a.ts": 10, "b.ts": 2 });
  });

  it("refuses a malformed baseline", () => {
    expect(() => parseBaseline(`{"files": []}`)).toThrow(/must be/u);
    expect(() => parseBaseline(`{"files": {"a.ts": 0}}`)).toThrow(/positive whole number/u);
    expect(() => parseBaseline(`{"files": {"a.ts": 1.5}}`)).toThrow(/positive whole number/u);
  });
});
