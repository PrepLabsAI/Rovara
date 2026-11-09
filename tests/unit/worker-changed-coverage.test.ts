// Setup and test health SH31: the Go cover-profile reader and the changed-line coverage it feeds (the evidence's `coverage` part). Fail closed: a profile it cannot read completely is "not measured" (undefined),
// a line counts as covered when ANY block on it ran, and only lines the profile calls statements are counted.
import { describe, expect, it } from "vitest";
import { EVIDENCE_COVERAGE_FILES_MAX, EVIDENCE_UNCOVERED_LINES_MAX, EvidenceCoverageSchema } from "../../packages/contracts/src/evidence.js";
import { GO_COVER_PROFILE_MAX_BLOCKS, changedLineCoverage, looksLikeGoCoverProfile, parseGoCoverProfile } from "../../packages/worker/src/verification/changed-coverage.js";

const MODULES = [{ path: "example.com/acme/match", dir: "." }];
const profile = (...blocks: string[]): string => ["mode: set", ...blocks, ""].join("\n");
const changed = (entries: Record<string, number[]>): ReadonlyMap<string, readonly number[]> => new Map(Object.entries(entries));

describe("parseGoCoverProfile", () => {
  it("maps import paths to repository paths through the module path and its directory, longest module first", () => {
    const text = profile(
      "example.com/acme/match/pkg/a.go:3.10,5.2 2 1",
      "example.com/acme/match/tools/b.go:1.1,2.2 1 0",
      "example.com/acme/match/tools/sub/c.go:1.1,2.2 1 1",
    );
    const read = parseGoCoverProfile(text, { modules: [...MODULES, { path: "example.com/acme/match/tools", dir: "tools" }] })!;
    expect([...read.files.keys()].sort()).toEqual(["pkg/a.go", "tools/b.go", "tools/sub/c.go"]);
    expect(read.unmappedBlocks).toBe(0);
    const nested = parseGoCoverProfile("mode: set\nexample.com/acme/match/tools/b.go:1.1,2.2 1 1\n", { modules: [{ path: "example.com/acme/match", dir: "svc" }, { path: "example.com/acme/match/tools", dir: "svc/tools" }] })!;
    expect([...nested.files.keys()]).toEqual(["svc/tools/b.go"]);
  });
  it("drops blocks outside every known module, with a path that leaves the repository, or in a lookalike module, and counts them", () => {
    const text = profile(
      "example.com/acme/match/a.go:1.1,2.2 1 1",
      "example.com/other/lib/x.go:1.1,2.2 1 1",
      "example.com/acme/matchmaker/y.go:1.1,2.2 1 1",
      "example.com/acme/match/../escape.go:1.1,2.2 1 1",
      "example.com/acme/match//double.go:1.1,2.2 1 1",
      "/abs/z.go:1.1,2.2 1 1",
    );
    const read = parseGoCoverProfile(text, { modules: MODULES })!;
    expect([...read.files.keys()]).toEqual(["a.go"]);
    expect(read.unmappedBlocks).toBe(5);
    expect(parseGoCoverProfile(profile("example.com/other/lib/x.go:1.1,2.2 1 1"), { modules: MODULES })).toBeUndefined();
  });
  it("reads set, count and atomic modes, repeated identical headers, and refuses mixed modes", () => {
    for (const mode of ["set", "count", "atomic"]) expect(parseGoCoverProfile(`mode: ${mode}\nexample.com/acme/match/a.go:1.1,2.2 1 7\n`, { modules: MODULES })).toBeDefined();
    const joined = "mode: count\nexample.com/acme/match/a.go:1.1,2.2 1 1\nmode: count\nexample.com/acme/match/b.go:1.1,2.2 1 0\n";
    expect([...parseGoCoverProfile(joined, { modules: MODULES })!.files.keys()]).toEqual(["a.go", "b.go"]);
    expect(parseGoCoverProfile("mode: set\nexample.com/acme/match/a.go:1.1,2.2 1 1\nmode: count\n", { modules: MODULES })).toBeUndefined();
    expect(parseGoCoverProfile("mode: weird\nexample.com/acme/match/a.go:1.1,2.2 1 1\n", { modules: MODULES })).toBeUndefined();
  });
  it("is not measured (undefined) for a profile it cannot read completely", () => {
    const bad = [
      "", "mode: set\n", "example.com/acme/match/a.go:1.1,2.2 1 1\n",
      profile("example.com/acme/match/a.go:1.1,2.2 1"), profile("example.com/acme/match/a.go:1.1,2.2 1 1 1"), profile("example.com/acme/match/a.go:1.1,2.2 x 1"),
      profile("example.com/acme/match/a.go:5.1,2.2 1 1"), profile("example.com/acme/match/a.go:0.1,2.2 1 1"), profile("example.com/acme/match/a.go:1.1,20000000.2 1 1"),
      profile("example.com/acme/match/a.go:1.1,2.2 1 1", "garbage line"), profile("example.com/acme/match/a.go:1.1,2.2 1 -1"),
    ];
    for (const text of bad) expect(parseGoCoverProfile(text, { modules: MODULES }), text).toBeUndefined();
    expect(parseGoCoverProfile(profile("example.com/acme/match/a.go:1.1,2.2 1 1"), { modules: [] })).toBeUndefined();
  });
  it("is bounded: too many blocks or too large a text is not read, and a block over millions of lines costs no per-line work", () => {
    // The byte cap bites first (a block line is at least 19 bytes), so a profile of a million blocks is refused whole.
    const many = ["mode: set", ...Array.from({ length: 1_000_001 }, (_, n) => `example.com/acme/match/a.go:${String(n + 1)}.1,${String(n + 1)}.5 1 1`)].join("\n");
    expect(parseGoCoverProfile(many, { modules: MODULES })).toBeUndefined();
    expect(GO_COVER_PROFILE_MAX_BLOCKS).toBe(1_000_000);
    const started = Date.now();
    const wide = parseGoCoverProfile(profile("example.com/acme/match/a.go:1.1,9999999.2 1 1"), { modules: MODULES })!;
    expect(changedLineCoverage(wide, changed({ "a.go": [5_000_000] })).coverage).toMatchObject({ linesChanged: 1, linesCovered: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it("recognises a Go cover profile by its header, not a Cobertura or LCOV file", () => {
    expect(looksLikeGoCoverProfile("mode: atomic\nx.go:1.1,2.2 1 1\n")).toBe(true);
    expect(looksLikeGoCoverProfile("\n  mode: set\n")).toBe(true);
    expect(looksLikeGoCoverProfile('<?xml version="1.0"?><coverage/>')).toBe(false);
    expect(looksLikeGoCoverProfile("TN:\nSF:a.go\nend_of_record\n")).toBe(false);
    expect(looksLikeGoCoverProfile("mode: other\n")).toBe(false);
  });
});

describe("changedLineCoverage", () => {
  const read = parseGoCoverProfile(profile(
    "example.com/acme/match/a.go:10.20,14.2 3 1",   // lines 10-14 ran
    "example.com/acme/match/a.go:16.2,18.3 2 0",    // lines 16-18 never ran
    "example.com/acme/match/a.go:20.5,20.30 1 1",   // line 20: the condition ran
    "example.com/acme/match/a.go:20.31,22.3 1 0",   // lines 20-22: the body did not
    "example.com/acme/match/b.go:1.1,3.2 2 0",
  ), { modules: MODULES })!;

  it("counts only the changed lines the profile calls statements, covered when any block on the line ran", () => {
    const { coverage } = changedLineCoverage(read, changed({ "a.go": [1, 9, 10, 12, 15, 17, 18, 19, 20, 21, 22, 23] }));
    // statements among the changed lines: 10 12 (ran) 17 18 (never) 20 (cond ran, body did not: covered) 21 22 (never)
    expect(coverage).toEqual({ linesChanged: 7, linesCovered: 3, files: [{ path: "a.go", uncovered: [17, 18, 21, 22] }] });
    expect(EvidenceCoverageSchema.safeParse(coverage).success).toBe(true);
  });
  it("lists files with uncovered lines in path order, lines ascending and without repeats, and ignores files the profile does not name", () => {
    const { coverage, unmeasured } = changedLineCoverage(read, changed({ "b.go": [3, 1, 1, 2], "a.go": [17], "c.go": [1, 2], "d_test.go": [1] }));
    expect(coverage).toEqual({ linesChanged: 4, linesCovered: 0, files: [{ path: "a.go", uncovered: [17] }, { path: "b.go", uncovered: [1, 2, 3] }] });
    expect(unmeasured).toEqual(["c.go"]);
  });
  it("ignores lines that are not positive whole numbers", () => {
    expect(changedLineCoverage(read, changed({ "a.go": [0, -1, 1.5, Number.NaN, 11] })).coverage).toEqual({ linesChanged: 1, linesCovered: 1, files: [] });
  });
  it("has nothing to report when no changed line is a measured statement", () => {
    expect(changedLineCoverage(read, changed({ "a.go": [1, 2, 3] })).coverage).toEqual({ linesChanged: 0, linesCovered: 0, files: [] });
    expect(changedLineCoverage(read, changed({})).coverage).toEqual({ linesChanged: 0, linesCovered: 0, files: [] });
  });
  it("keeps the evidence's limits: files and uncovered lines per file are cut, and the counts stay true", () => {
    const blocks = Array.from({ length: EVIDENCE_COVERAGE_FILES_MAX + 5 }, (_, n) => `example.com/acme/match/f${String(n).padStart(3, "0")}.go:1.1,${String(EVIDENCE_UNCOVERED_LINES_MAX + 50)}.2 1 0`);
    const big = parseGoCoverProfile(profile(...blocks), { modules: MODULES })!;
    const lines = Array.from({ length: EVIDENCE_UNCOVERED_LINES_MAX + 50 }, (_, n) => n + 1);
    const { coverage } = changedLineCoverage(big, changed(Object.fromEntries(blocks.map((_, n) => [`f${String(n).padStart(3, "0")}.go`, lines]))));
    expect(coverage.files).toHaveLength(EVIDENCE_COVERAGE_FILES_MAX);
    expect(coverage.files[0]?.uncovered).toHaveLength(EVIDENCE_UNCOVERED_LINES_MAX);
    expect(coverage.linesChanged).toBe((EVIDENCE_COVERAGE_FILES_MAX + 5) * (EVIDENCE_UNCOVERED_LINES_MAX + 50));
    expect(EvidenceCoverageSchema.safeParse(coverage).success).toBe(true);
  });
});
