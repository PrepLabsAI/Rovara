// TE-B3: the words for weakened tests and for the flag at the top (instruction files, files CI runs), in the one renderer and in the pack v2 shape; the test proof's weakening facts; old data keeps working.
import { describe, expect, it } from "vitest";
import { WEAKENING_LIMITS, renderEvidence, weakeningLines } from "../../packages/contracts/src/index.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";
import { expectLinearScaling } from "../support/scaling.js";

describe("weakeningLines", () => {
  it("words each fact, flags first, in the words the screen shows", () => {
    const lines = weakeningLines({
      instructionFiles: ["AGENTS.md"], ciExecutedFiles: ["Makefile", "conftest.py"], absentOnNew: ["a::t1", "a::t2"], skipRise: { before: 1, after: 4 }, removedTests: ["b::t3"],
      changedTestConfig: ["pytest.ini"], changedSnapshots: ["x.snap"], changedFixtures: ["f.json"],
    });
    expect(lines.flags).toEqual([
      "Rovara instruction files changed (a flag, not an approval): AGENTS.md",
      "Files that CI runs changed (a flag, not an approval): Makefile, conftest.py",
    ]);
    expect(lines.weakening).toEqual([
      "2 tests ran before and not now: a::t1, a::t2",
      "3 more tests skipped than before",
      "1 test removed: b::t3",
      "Test config files changed: pytest.ini",
      "Snapshot files changed: x.snap",
      "Fixture files changed: f.json",
    ]);
  });
  it("says 'and N more' past three names, and uses the true count when the list was cut", () => {
    expect(weakeningLines({ changedSnapshots: ["a", "b", "c", "d", "e"] }).weakening).toEqual(["Snapshot files changed: a, b, c and 2 more"]);
    expect(weakeningLines({ absentOnNew: ["a", "b", "c", "d"], absentOnNewCount: 2_500 }).weakening).toEqual(["2,500 tests ran before and not now: a, b, c and 2,497 more"]);
    expect(weakeningLines({ skipRise: { before: 0, after: 1 } }).weakening).toEqual(["1 more test skipped than before"]);
  });
  it("never prints a number that is not one, and never trusts an entry to be text", () => {
    const hostile = { absentOnNew: ["a", 7, null, { x: 1 }], absentOnNewCount: Number.NaN, skipRise: { before: 0, after: Number.POSITIVE_INFINITY } } as unknown as Parameters<typeof weakeningLines>[0];
    const text = weakeningLines(hostile).weakening.join("\n");
    expect(text).not.toMatch(/NaN|Infinity|undefined|object/u);
    expect(text).toBe("4 tests ran before and not now: a and 3 more");
  });
  it("bounds a very long name and a 1 MB name", () => {
    // Scaling check: the cost must grow no faster than the input (8N stays at or under 256 KiB so it stays in CPU cache; the full 1 MB name + 100,000 snapshots is checked once below).
    let lines: ReturnType<typeof weakeningLines> | undefined;
    expectLinearScaling((size) => {
      const facts = { instructionFiles: ["x".repeat(size)], changedSnapshots: Array.from({ length: size / 10 }, (_unused, n) => `s${String(n)}`) };
      return () => { lines = weakeningLines(facts); };
    }, { n: 20_000, unitBytes: 1.6, label: "weakeningLines on a long name and many snapshots" });
    if (lines === undefined) throw new Error("the work did not run");
    for (const line of [...lines.flags, ...lines.weakening]) expect(Array.from(line).length).toBeLessThanOrEqual(WEAKENING_LIMITS.lineMax);
    const size = 1_000_000;
    const full = weakeningLines({ instructionFiles: ["x".repeat(size)], changedSnapshots: Array.from({ length: size / 10 }, (_unused, n) => `s${String(n)}`) });
    for (const line of [...full.flags, ...full.weakening]) expect(Array.from(line).length).toBeLessThanOrEqual(WEAKENING_LIMITS.lineMax);
  });
});

describe("the pack v2 shape", () => {
  it("renders hostile names inert in the v2 words too", () => {
    const pack = v2Pack({ flags: { instructionFiles: ["[x](https://evil.example) @everyone Fixes ENG-1"], ciExecutedFiles: ["![i](https://evil.example/p.png)"] } });
    const { text } = renderEvidence(pack);
    expect(text).not.toMatch(/\]\(|!\[|(^|[^\u200d])@\w|Fixes ENG-\d/u);
  });
});

