import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  compareToBaseline,
  formatBaseline,
  interpretTscRun,
  lowerBaseline,
  parseBaseline,
  parseTscOutput,
} from "../../scripts/typecheck-baseline.js";

// Paths here are made up on purpose, so they never match a real file's baseline entry.
const MULTI_LINE = [
  "tests/sample/a.test.ts(12,3): error TS2375: Type '{ profile?: string | undefined; }' is not assignable to type 'Options' with 'exactOptionalPropertyTypes: true'.",
  "  Types of property 'profile' are incompatible.",
  "    Type 'string | undefined' is not assignable to type 'string'.",
  "tests/sample/a.test.ts(40,9): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.",
  "scripts/sample/b.ts(7,1): error TS2322: Type 'number' is not assignable to type 'string'.",
  "",
].join("\n");

describe("parsing tsc output (--pretty false)", () => {
  it("counts one error per file location and ignores the indented lines that continue a multi-line error", () => {
    expect(parseTscOutput(MULTI_LINE)).toEqual({
      counts: { "tests/sample/a.test.ts": 2, "scripts/sample/b.ts": 1 },
      problems: [],
    });
  });

  it("reads Windows line endings and backslash paths as the same repository paths", () => {
    const text = "tests\\sample\\a.test.ts(1,1): error TS2322: Bad.\r\n  More detail.\r\n";
    expect(parseTscOutput(text)).toEqual({ counts: { "tests/sample/a.test.ts": 1 }, problems: [] });
  });

  it("reports an error with no file location (a config or startup error) as a problem, never as a count", () => {
    const parsed = parseTscOutput("error TS5083: Cannot read file '/repo/tsconfig.lint.json'.\n");
    expect(parsed.counts).toEqual({});
    expect(parsed.problems).toEqual(["error TS5083: Cannot read file '/repo/tsconfig.lint.json'."]);
  });

  it("reports a compiler option error (TS5xxx) or an error inside a JSON config file as a problem", () => {
    const parsed = parseTscOutput([
      "tsconfig.lint.json(4,5): error TS5023: Unknown compiler option 'nope'.",
      "tsconfig.base.json(2,3): error TS1005: ',' expected.",
      "",
    ].join("\n"));
    expect(parsed.counts).toEqual({});
    expect(parsed.problems).toHaveLength(2);
  });

  it("reports any unrecognised line, such as a crash's stack trace, as a problem", () => {
    const parsed = parseTscOutput("tests/sample/a.test.ts(1,1): error TS2322: Bad.\nTypeError: Cannot read properties of undefined\n    at Object.foo (tsc.js:1:2)\n");
    expect(parsed.counts).toEqual({ "tests/sample/a.test.ts": 1 });
    expect(parsed.problems).toEqual(["TypeError: Cannot read properties of undefined", "    at Object.foo (tsc.js:1:2)"]);
  });

  it("does not let an indented line count before any error has started", () => {
    expect(parseTscOutput("  stray indented text\n").problems).toEqual(["  stray indented text"]);
  });
});

describe("judging a tsc run, so a crash or config error never passes as zero errors", () => {
  const ok = { status: 0, signal: null, stdout: "", stderr: "" };

  it("accepts a clean run with no output as zero errors", () => {
    expect(interpretTscRun(ok)).toEqual({ ok: true, counts: {} });
  });

  it("accepts exit code 2 with located errors as the per-file counts", () => {
    expect(interpretTscRun({ ...ok, status: 2, stdout: MULTI_LINE })).toEqual({
      ok: true,
      counts: { "tests/sample/a.test.ts": 2, "scripts/sample/b.ts": 1 },
    });
  });

  it("fails a non-zero exit with no errors in the output (a crash that printed nothing parseable)", () => {
    const run = interpretTscRun({ ...ok, status: 1, stdout: "" });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toMatch(/exited with code 1 but reported no errors/);
  });

  it("fails a zero exit that still printed errors", () => {
    expect(interpretTscRun({ ...ok, status: 0, stdout: MULTI_LINE }).ok).toBe(false);
  });

  it("fails when tsc was killed by a signal, could not start, or timed out", () => {
    expect(interpretTscRun({ ...ok, status: null, signal: "SIGKILL" }).ok).toBe(false);
    const notStarted = interpretTscRun({ ...ok, status: null, error: new Error("spawn ENOENT") });
    expect(notStarted.ok).toBe(false);
    if (!notStarted.ok) expect(notStarted.reason).toContain("spawn ENOENT");
  });

  it("fails when tsc wrote anything to stderr, even with located errors on stdout", () => {
    expect(interpretTscRun({ ...ok, status: 2, stdout: MULTI_LINE, stderr: "FATAL ERROR: heap out of memory\n" }).ok).toBe(false);
  });

  it("fails a config error even when other files also have errors", () => {
    const run = interpretTscRun({ ...ok, status: 2, stdout: `${MULTI_LINE}error TS6053: File 'missing.ts' not found.\n` });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toContain("error TS6053");
  });

  it("fails an exit code tsc only uses for a broken project setup, such as 3", () => {
    expect(interpretTscRun({ ...ok, status: 3, stdout: MULTI_LINE }).ok).toBe(false);
  });
});

describe("comparing per-file counts with the baseline", () => {
  const baseline = { "tests/sample/a.test.ts": 2, "scripts/sample/b.ts": 1 };

  it("passes with no reminder when every count matches", () => {
    const result = compareToBaseline(baseline, { ...baseline });
    expect(result.pass).toBe(true);
    expect(result.lowered).toEqual([]);
    expect(result.lines.join("\n")).not.toMatch(/lower the baseline/i);
  });

  it("fails when a file's count goes up, naming the file and both counts", () => {
    const result = compareToBaseline(baseline, { ...baseline, "tests/sample/a.test.ts": 3 });
    expect(result.pass).toBe(false);
    expect(result.raised).toEqual([{ file: "tests/sample/a.test.ts", baseline: 2, current: 3 }]);
    expect(result.lines.join("\n")).toContain("tests/sample/a.test.ts: 2 -> 3");
  });

  it("fails when a file not in the baseline has errors", () => {
    const result = compareToBaseline(baseline, { ...baseline, "tests/sample/new.test.ts": 1 });
    expect(result.pass).toBe(false);
    expect(result.raised).toEqual([{ file: "tests/sample/new.test.ts", baseline: 0, current: 1 }]);
  });

  it("passes and reminds to lower the baseline when a count goes down", () => {
    const result = compareToBaseline(baseline, { ...baseline, "tests/sample/a.test.ts": 1 });
    expect(result.pass).toBe(true);
    expect(result.lowered).toEqual([{ file: "tests/sample/a.test.ts", baseline: 2, current: 1 }]);
    expect(result.lines.join("\n")).toMatch(/npm run typecheck:baseline/);
  });

  it("passes and reminds to lower the baseline when a file has no errors left", () => {
    const result = compareToBaseline(baseline, { "tests/sample/a.test.ts": 2 });
    expect(result.pass).toBe(true);
    expect(result.lowered).toEqual([{ file: "scripts/sample/b.ts", baseline: 1, current: 0 }]);
    expect(result.lines.join("\n")).toMatch(/npm run typecheck:baseline/);
  });

  it("still fails on one raised file when another file went down", () => {
    const result = compareToBaseline(baseline, { "tests/sample/a.test.ts": 1, "scripts/sample/b.ts": 2 });
    expect(result.pass).toBe(false);
    expect(result.raised).toHaveLength(1);
    expect(result.lowered).toHaveLength(1);
  });

  it("reports the totals", () => {
    expect(compareToBaseline(baseline, { "tests/sample/a.test.ts": 1 }).lines.join("\n")).toContain("1 error in 1 file (baseline: 3 errors in 2 files)");
  });
});

describe("regenerating the baseline", () => {
  const baseline = { "tests/sample/a.test.ts": 2, "scripts/sample/b.ts": 1 };

  it("writes the lower counts and drops files with no errors left", () => {
    expect(lowerBaseline(baseline, { "tests/sample/a.test.ts": 1 })).toEqual({ ok: true, baseline: { "tests/sample/a.test.ts": 1 } });
  });

  it("refuses to raise a file's count", () => {
    const result = lowerBaseline(baseline, { ...baseline, "scripts/sample/b.ts": 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("scripts/sample/b.ts: 1 -> 2");
  });

  it("refuses to add a new file", () => {
    const result = lowerBaseline(baseline, { ...baseline, "tests/sample/new.test.ts": 4 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("tests/sample/new.test.ts: 0 -> 4");
  });
});

describe("the baseline file", () => {
  it("round-trips through format and parse, sorted by path, with a trailing newline", () => {
    const text = formatBaseline({ "tests/z.test.ts": 3, "scripts/a.ts": 1 });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("scripts/a.ts")).toBeLessThan(text.indexOf("tests/z.test.ts"));
    expect(parseBaseline(text)).toEqual({ "scripts/a.ts": 1, "tests/z.test.ts": 3 });
  });

  it("rejects a malformed baseline instead of treating it as empty", () => {
    expect(() => parseBaseline("not json")).toThrow();
    expect(() => parseBaseline("[]")).toThrow(/files/);
    expect(() => parseBaseline('{"files": {"a.ts": 0}}')).toThrow(/a\.ts/);
    expect(() => parseBaseline('{"files": {"a.ts": 1.5}}')).toThrow(/a\.ts/);
    expect(() => parseBaseline('{"files": {"a.ts": "2"}}')).toThrow(/a\.ts/);
    expect(() => parseBaseline('{"files": {}, "extra": 1}')).toThrow(/extra/);
  });

  it("is committed, parses, and is sorted the way the regenerate command writes it", async () => {
    const text = await readFile("tests/typecheck-baseline.json", "utf8");
    expect(formatBaseline(parseBaseline(text))).toBe(text);
  });
});

interface Step { id?: string; name?: string; if?: string; run?: string }
interface Workflow { jobs: Record<string, { steps: Step[] }> }

describe("wiring", () => {
  it("has npm scripts that build first, then check, and one that lowers the baseline", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck:all"]).toBe("tsc -b --pretty false && node scripts/typecheck-baseline.ts check");
    expect(pkg.scripts["typecheck:baseline"]).toBe("tsc -b --pretty false && node scripts/typecheck-baseline.ts update");
  });

  it("runs the ratchet in CI right after the typecheck, behind the docs-only check", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const steps = workflow.jobs.local!.steps;
    const typecheck = steps.findIndex((step) => step.run === "npm run typecheck");
    const ratchet = steps.findIndex((step) => step.run === "npm run typecheck:all");
    expect(ratchet).toBe(typecheck + 1);
    expect(steps[ratchet]!.if).toBe("steps.scope.outputs.docs_only != 'true'");
  });

  it("runs the ratchet in the release workflow's test job after the typecheck", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/release.yml", "utf8")) as Workflow;
    const runs = workflow.jobs.test!.steps.map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("npm run typecheck && npm run typecheck:all && npm run lint");
  });
});
