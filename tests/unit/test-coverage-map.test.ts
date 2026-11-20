import { describe, expect, it } from "vitest";
import { buildCoverage, decodeMappings, executedUnion, globMatch, isTableCase, offsetLines, reduce, type TestRecord } from "../../scripts/test-coverage-map.js";
import { executedIntervals, isProductScript } from "../support/coverage-map-core.js";

// #1211: per-test coverage, and the smallest set of tests that keeps it.
describe("the executed regions of a script (executedIntervals)", () => {
  it("takes the innermost V8 range: a block that did not run is cut out of the function that did", () => {
    expect(executedIntervals([{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 40, endOffset: 60, count: 0 }])).toEqual([[0, 40], [60, 100]]);
  });
  it("leaves out a nested function that was never called, and keeps one that was", () => {
    const ranges = [{ startOffset: 0, endOffset: 100, count: 2 }, { startOffset: 10, endOffset: 20, count: 0 }, { startOffset: 50, endOffset: 70, count: 3 }];
    expect(executedIntervals(ranges)).toEqual([[0, 10], [20, 100]]);
  });
  it("reports nothing for a script whose functions all have a zero count", () => {
    expect(executedIntervals([{ startOffset: 0, endOffset: 30, count: 0 }])).toEqual([]);
  });
  it("counts only product code: a package's src, never tests or node_modules", () => {
    expect(isProductScript("/r/packages/verifier/src/executor/redact.ts")).toBe(true);
    expect(isProductScript("/r/packages/verifier/src/executor/redact.test.ts")).toBe(false);
    expect(isProductScript("/r/node_modules/x/packages/y/src/z.js")).toBe(false);
    expect(isProductScript("/r/tests/unit/a.test.ts")).toBe(false);
  });
});

describe("mapping transformed code back to TypeScript lines", () => {
  it("decodes source map segments into generated columns and 1-based original lines", () => {
    // "AAAA" = col 0, src 0, line 0, col 0; ";AACA" = next line, original line +1.
    expect(decodeMappings("AAAA;AACA")).toEqual([[[0, 1]], [[0, 2]]]);
  });
  it("reads the inline source map of a vitest transform and gives each offset its line", () => {
    const map = Buffer.from(JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA;AACA" })).toString("base64");
    const source = `a();\nb();\n//# sourceMappingURL=data:application/json;base64,${map}\n`;
    expect(offsetLines(source)).toEqual([[0, 1], [5, 2]]);
  });
});

const record = (id: string, iv: Array<[number, number]>, extra: Partial<TestRecord> = {}): TestRecord =>
  ({ id: `tests/unit/x.test.ts > ${id}`, file: "tests/unit/x.test.ts", concurrent: false, scripts: { "packages/p/src/m.ts": { h: "h1", iv } }, ...extra });

describe("the smallest covering set (buildCoverage + reduce)", () => {
  it("treats two tests that ran the same code as the same blocks, however V8 grouped the ranges", () => {
    const records = [record("a", [[0, 100]]), record("b", [[0, 40], [40, 100]]), record("c", [[0, 40]])];
    const coverage = buildCoverage(records, () => []);
    expect(coverage.perTest.get(records[0]!.id)).toEqual(coverage.perTest.get(records[1]!.id));
    const result = reduce(records.map((r) => r.id), coverage.perTest, new Set());
    expect(result.kept).toEqual([records[0]!.id]);
    expect(result.redundant.map((r) => r.id)).toEqual([records[1]!.id, records[2]!.id]);
    expect(result.redundant[1]!.coveredBy).toEqual([records[0]!.id]);
  });
  it("keeps a test that runs any block no kept test runs, so coverage never drops", () => {
    const records = [record("wide", [[0, 50]]), record("narrow", [[0, 10], [60, 70]])];
    const coverage = buildCoverage(records, () => []);
    const result = reduce(records.map((r) => r.id), coverage.perTest, new Set());
    expect(result.redundant).toEqual([]);
  });
  it("always keeps the tests the keep rules name, and never calls a test with no product code redundant", () => {
    const records = [record("big", [[0, 100]]), record("security check", [[0, 10]]), record("spawns the CLI", [])];
    const coverage = buildCoverage(records, () => []);
    expect(coverage.zero).toEqual([records[2]!.id]);
    const result = reduce(records.map((r) => r.id), coverage.perTest, new Set([records[1]!.id]));
    expect(result.kept).toEqual([records[1]!.id, records[0]!.id]);
    expect(result.redundant).toEqual([]);
  });
});

describe("comparing two runs (executedUnion)", () => {
  it("is the same for two runs that executed the same ranges, however the tests split them, and differs when a range is missing", () => {
    expect(executedUnion([record("a", [[0, 40]]), record("b", [[30, 100]])])).toEqual(executedUnion([record("c", [[0, 100]])]));
    expect(executedUnion([record("a", [[0, 40]])])).not.toEqual(executedUnion([record("c", [[0, 100]])]));
  });
});

describe("flagging table cases and matching keep rules", () => {
  it("flags another case of the same table (same suites, titles differ only in the input) for the owner", () => {
    expect(isTableCase("f > cookies > _uetsid is never strong in any browser", ["f > cookies > _clsk is never strong in any browser"])).toBe(true);
    expect(isTableCase("f > cookies > rejects an empty header", ["f > cookies > _clsk is never strong in any browser"])).toBe(false);
    expect(isTableCase("f > a > _uetsid is never strong in any browser", ["f > b > _clsk is never strong in any browser"])).toBe(false);
  });
  it("matches keep globs with * against the whole file or test id", () => {
    expect(globMatch("tests/unit/*-access-*.test.ts", "tests/unit/task-access-policy.test.ts")).toBe(true);
    expect(globMatch("*refuses*", "tests/unit/a.test.ts > x > refuses a token")).toBe(true);
    expect(globMatch("tests/unit/a.test.ts", "tests/unit/ab.test.ts")).toBe(false);
    expect(globMatch("*sandbox*", "tests/unit/a.test.ts > Sandbox egress stays closed", true)).toBe(true);
    expect(globMatch("*sandbox*", "tests/unit/a.test.ts > Sandbox egress stays closed")).toBe(false);
  });
});
