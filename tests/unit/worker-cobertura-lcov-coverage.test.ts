// Proof and evidence P3: changed-line coverage. The worker reads the Cobertura XML or LCOV file a project's own tests already write (the command is never changed), intersects it with the lines the change
// added or changed (renames included; a pure deletion counts no line), and reports covered and uncovered changed lines per file. Real files in a real workspace, and a real git repository for the diff.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceRawSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import {
  COVERAGE_REPORT_MAX_BYTES, coveragePart, coverageSpecsOf, intersectCoverage, parseCobertura, parseLcov, readChangedCoverage, type RepositoryChanges,
} from "../../packages/worker/src/verification/cobertura-lcov-coverage.js";
import { candidateChanges, parseCandidateChanges } from "../../packages/worker/src/verification/diff.js";
import { collectEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";
import { readContainedReport } from "../../packages/worker/src/verification/report-file.js";

const run = promisify(execFile);
const DIGEST = "d".repeat(64);
const command = (args: string[], cwd = ".", executable = "pytest"): ProjectCommand => ({ executable, args, cwd, timeoutSeconds: 60 });
const entry = (index: number, over: Partial<CheckEntry> = {}): CheckEntry => ({ id: `readiness:${String(index)}`, label: "pytest", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 100, exitCode: 0, ...over });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "changed-coverage-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function git(directory: string, args: string[]): Promise<string> {
  return (await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: directory })).stdout.trim();
}

/** A repository under the workspace root with a base commit; `change` edits the work tree, and the candidate is the tree of everything in it afterwards. */
async function repository(files: Record<string, string>, change: (directory: string) => Promise<void>): Promise<{ directory: string; base: string; tree: string }> {
  const directory = join(root, "api");
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-q"]);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-q", "-m", "base"]);
  const base = await git(directory, ["rev-parse", "HEAD"]);
  await change(directory);
  await git(directory, ["add", "-A"]);
  return { directory, base, tree: await git(directory, ["write-tree"]) };
}

const lines = (count: number, prefix = "x") => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1)}`).join("\n") + "\n";
/** Cobertura as pytest-cov writes it: sources absolute, file names relative to a source. */
const cobertura = (source: string, classes: Array<{ filename: string; lines: Array<[number, number]> }>) => `<?xml version="1.0" ?>
<coverage version="7.6" timestamp="1" lines-valid="9" lines-covered="5" line-rate="0.5" branches-covered="0" branches-valid="0" branch-rate="0" complexity="0">
  <sources><source>${source}</source></sources>
  <packages><package name="pkg"><classes>
${classes.map((item) => `    <class name="${item.filename}" filename="${item.filename}" complexity="0" line-rate="0.5" branch-rate="0"><methods/><lines>${item.lines.map(([number, hits]) => `<line number="${String(number)}" hits="${String(hits)}"/>`).join("")}</lines></class>`).join("\n")}
  </classes></package></packages>
</coverage>`;
const lcov = (records: Array<{ file: string; lines: Array<[number, number]> }>) => records.map((record) => `TN:\nSF:${record.file}\n${record.lines.map(([number, hits]) => `DA:${String(number)},${String(hits)}`).join("\n")}\nLF:${String(record.lines.length)}\nLH:0\nend_of_record\n`).join("");

describe("the coverage report formats", () => {
  it("reads a Cobertura report: a line is covered when any listing of it says so, and the sources come with it", () => {
    const text = `<coverage><sources><source>/w/api/src</source><source>.</source></sources><packages><package><classes>
      <class filename="a.py"><methods><method name="f"><lines><line number="2" hits="0"/></lines></method></methods><lines><line number="1" hits="3"/><line number="2" hits="1"/></lines></class>
      <class filename="b.py"><lines><line number="5" hits="0"/></lines></class></classes></package></packages></coverage>`;
    const parsed = parseCobertura(text)!;
    expect(parsed.sources).toEqual(["/w/api/src", "."]);
    expect([...parsed.files.get("a.py")!]).toEqual([[2, true], [1, true]]);
    expect([...parsed.files.get("b.py")!]).toEqual([[5, false]]);
  });

  it("refuses a Cobertura file that is not a report or is malformed, and ignores a class hidden in a comment or CDATA", () => {
    expect(parseCobertura("<html><body>hello</body></html>")).toBeUndefined();
    expect(parseCobertura('<coverage><packages><class filename="a.py"><lines><line number="1" hits="1"')).toBeUndefined();
    expect(parseCobertura('<coverage><!-- <class filename="x.py"><lines><line number="1" hits="1"/></lines></class> --></coverage>')?.files.size).toBe(0);
    expect(parseCobertura('<coverage><![CDATA[<class filename="x.py">]]></coverage>')?.files.size).toBe(0);
    expect(parseCobertura('<coverage><!-- never closed')).toBeUndefined();
    // Lines before any class, or with a bad number or hits, are not read.
    const odd = parseCobertura('<coverage><line number="1" hits="1"/><class filename="a.py"><lines><line number="x" hits="1"/><line number="2" hits="-1"/><line number="3" hits="1"/></lines></class></coverage>')!;
    expect([...odd.files.get("a.py")!]).toEqual([[3, true]]);
  });

  it("reads an LCOV tracefile: DA records per SF, repeated files merged, CRLF and unknown records tolerated", () => {
    const parsed = parseLcov("TN:\r\nSF:/w/api/a.py\r\nDA:1,2\r\nDA:2,0,abc\r\nFN:1,f\r\nBRDA:1,0,0,1\r\nend_of_record\r\nSF:/w/api/a.py\nDA:2,5\nDA:1,0\nend_of_record\nDA:9,9\nSF:/w/api/b.py\nDA:oops,1\nDA:4,0\nend_of_record\n")!;
    expect([...parsed.files.get("/w/api/a.py")!]).toEqual([[1, true], [2, true]]);
    expect([...parsed.files.get("/w/api/b.py")!]).toEqual([[4, false]]);
    expect(parseLcov("hello\nworld\n")).toBeUndefined();
  });

  it("refuses a report with more files or lines than its limits (the totals could not be trusted), and a path that is too long", () => {
    const many = Array.from({ length: 6 }, (_, index) => `SF:/f${String(index)}.py\nDA:1,1\nend_of_record`).join("\n");
    expect(parseLcov(many, { files: 5, lines: 100 })).toBeUndefined();
    expect(parseLcov(many, { files: 6, lines: 5 })).toBeUndefined();
    expect(parseLcov(many, { files: 6, lines: 6 })?.files.size).toBe(6);
    const xml = `<coverage>${Array.from({ length: 3 }, (_, index) => `<class filename="f${String(index)}.py"><lines><line number="1" hits="1"/></lines></class>`).join("")}</coverage>`;
    expect(parseCobertura(xml, { files: 2, lines: 100 })).toBeUndefined();
    expect(parseCobertura(xml, { files: 3, lines: 2 })).toBeUndefined();
    expect(parseCobertura(xml, { files: 3, lines: 3 })?.files.size).toBe(3);
    expect(parseLcov(`SF:${"p".repeat(2000)}\nDA:1,1\nend_of_record\n`)?.files.size).toBe(0);
  });
});

describe("which file a command's tool writes (the command is never altered)", () => {
  const specs = (...args: string[]) => coverageSpecsOf(command(args)).map((spec) => `${spec.format}:${spec.argument}`);

  it("reads pytest-cov and coverage.py report options", () => {
    expect(specs("--cov=src", "--cov-report=xml")).toEqual(["cobertura:coverage.xml"]);
    expect(specs("--cov-report", "xml:reports/cov.xml", "--cov-report=term-missing")).toEqual(["cobertura:reports/cov.xml"]);
    expect(specs("--cov-report=lcov:out/cov.lcov", "--cov-report=xml")).toEqual(["cobertura:coverage.xml", "lcov:out/cov.lcov"]);
    expect(coverageSpecsOf(command(["xml", "-o", "out/c.xml"], ".", "coverage")).map((spec) => spec.argument)).toEqual(["out/c.xml"]);
    expect(coverageSpecsOf(command(["-m", "coverage", "lcov"], ".", "python")).map((spec) => spec.argument)).toEqual(["coverage.lcov"]);
  });

  it("reads jest, vitest, nyc and c8 reporter options; vitest's own test reporter is not a coverage reporter", () => {
    expect(coverageSpecsOf(command(["--coverage", "--coverageReporters=lcov", "--coverageDirectory=cov"], ".", "jest")).map((spec) => spec.argument)).toEqual(["cov/lcov.info"]);
    expect(coverageSpecsOf(command(["--coverageReporters", "text", "cobertura", "lcov"], ".", "jest")).map((spec) => spec.argument)).toEqual(["coverage/cobertura-coverage.xml", "coverage/lcov.info"]);
    expect(coverageSpecsOf(command(["run", "--coverage.reporter=lcov", "--coverage.reportsDirectory=out"], ".", "vitest")).map((spec) => spec.argument)).toEqual(["out/lcov.info"]);
    expect(coverageSpecsOf(command(["--reporter=lcov", "--report-dir=r", "mocha"], ".", "nyc")).map((spec) => spec.argument)).toEqual(["r/lcov.info"]);
    expect(coverageSpecsOf(command(["-r", "cobertura", "npm", "test"], ".", "c8")).map((spec) => spec.argument)).toEqual(["coverage/cobertura-coverage.xml"]);
    // `vitest --reporter=json` is the test reporter: no coverage file is named, so there is none to read (EV-2: no default names are guessed).
    expect(coverageSpecsOf(command(["run", "--reporter=json"], ".", "vitest"))).toEqual([]);
  });

  it("reads any option about coverage that is given a report file, but not pytest-cov's own report option", () => {
    expect(specs("--my-coverage-out=build/cov.xml")).toEqual(["cobertura:build/cov.xml"]);
    expect(specs("--lcov-file", "build/x.info")).toEqual(["lcov:build/x.info"]);
    expect(specs("--cov-report=xml:a.xml")).toEqual(["cobertura:a.xml"]);
  });

  // EV-2: the report a project's tests write at a tool's default name could be written by the agent's own tests (a conftest or a jest config that writes coverage.xml with every line hit). A report counts only when the
  // check's own command line names it, so forging one means changing the command a person approved. (The inherent limit stays: a report the named command writes proves what the project's tooling wrote.)
  it("guesses no default file name: a test command that names no report has none, and neither has a lint command", () => {
    expect(specs("-q")).toEqual([]);
    expect(coverageSpecsOf(command(["test"], ".", "npm"))).toEqual([]);
    expect(coverageSpecsOf(command(["--coverage"], ".", "jest"))).toEqual([]);
    expect(coverageSpecsOf(command(["."], ".", "eslint"))).toEqual([]);
    expect(coverageSpecsOf(command(["check"], ".", "ruff"))).toEqual([]);
  });

});

describe("the lines the change wrote", () => {
  it("counts only added and changed lines: a pure deletion wrote none, and the default reading is unchanged", () => {
    const status = "M\0a.py\0";
    const patch = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -3,2 +3,0 @@\n-x\n-y\n@@ -10,0 +9,2 @@\n+n\n+m\n@@ -20 +21 @@\n-p\n+q\n";
    expect(parseCandidateChanges(status, patch, false, { exactLines: true })[0]?.hunks).toEqual([[9, 10], [21, 21]]);
    expect(parseCandidateChanges(status, patch, false)[0]?.hunks).toEqual([[3, 4], [9, 10], [21, 21]]);
  });
});

describe("the intersection of a report with the diff", () => {
  const changesOf = async (box: { directory: string; base: string; tree: string }): Promise<RepositoryChanges[]> => [{ repositoryId: "api", directory: box.directory, changes: await candidateChanges({ directory: box.directory, baseCommitSha: box.base, treeSha: box.tree }, { exactLines: true }) }];

  it("reports covered and uncovered changed lines per file, for a modified file, an added file and a renamed file with edits", async () => {
    const box = await repository({ "src/mod.py": lines(10), "src/old.py": lines(10, "o"), "src/same.py": lines(5, "s") }, async (directory) => {
      await writeFile(join(directory, "src/mod.py"), lines(10).replace("x3\n", "NEW3\n").replace("x4\n", "NEW4\n"));
      await writeFile(join(directory, "src/fresh.py"), lines(4, "f"));
      await rename(join(directory, "src/old.py"), join(directory, "src/moved.py"));
      await writeFile(join(directory, "src/moved.py"), lines(10, "o").replace("o9\n", "EDIT9\n"));
      await rename(join(directory, "src/same.py"), join(directory, "src/same_moved.py"));
    });
    const parsed = parseCobertura(cobertura(join(box.directory, "src"), [
      { filename: "mod.py", lines: [[1, 1], [3, 1], [4, 0], [5, 1], [7, 0]] },
      { filename: "fresh.py", lines: [[1, 1], [2, 1], [3, 0], [4, 0]] },
      { filename: "moved.py", lines: [[9, 0], [10, 1]] },
      { filename: "same_moved.py", lines: [[1, 0]] },
    ]))!;
    const result = (await intersectCoverage(parsed, { repositories: await changesOf(box), bases: [root] }))!;
    const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
    expect(byPath["src/mod.py"]).toMatchObject({ changed: 2, covered: 1, uncovered: [4] });
    expect(byPath["src/fresh.py"]).toMatchObject({ changed: 4, covered: 2, uncovered: [3, 4] });
    expect(byPath["src/moved.py"]).toMatchObject({ changed: 1, covered: 0, uncovered: [9] });
    // A pure rename changed no line, so nothing of it is claimed even though the report lists its lines.
    expect(byPath["src/same_moved.py"]).toBeUndefined();
    expect(result.linesChanged).toBe(7);
    expect(result.linesCovered).toBe(3);
    // Files with uncovered lines come first.
    expect(result.files[0]?.uncovered.length).toBeGreaterThanOrEqual(result.files[1]!.uncovered.length);
  });

  it("does not count a deleted line, a changed line the report does not list, or a changed file the report does not name", async () => {
    const box = await repository({ "a.py": lines(8), "b.py": lines(3), "docs.md": "x\n" }, async (directory) => {
      await writeFile(join(directory, "a.py"), lines(8).replace("x2\nx3\n", "").replace("x6\n", "NEW6\n"));
      await writeFile(join(directory, "docs.md"), "changed\n");
      await writeFile(join(directory, "b.py"), "totally\nnew\nfile\n");
    });
    const parsed = parseLcov(lcov([{ file: join(box.directory, "a.py"), lines: [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0], [7, 0]] }]))!;
    const result = (await intersectCoverage(parsed, { repositories: await changesOf(box), bases: [root] }))!;
    // a.py lost two lines (nothing written) and rewrote the line now numbered 4 (x6 -> NEW6, listed and covered); b.py and docs.md are not in the report.
    expect(result.files).toEqual([{ repositoryId: "api", path: "a.py", changed: 1, covered: 1, uncovered: [] }]);
    expect(result).toMatchObject({ linesChanged: 1, linesCovered: 1 });
    // b.py is a changed source file the report never names: counted apart, not silently dropped. docs.md is not source.
    expect(result.unlistedFiles).toBe(1);
  });

  it("counts changed source files the report does not name, but not tests, documents, deleted files or files the report names", async () => {
    const box = await repository({ "src/a.py": lines(3), "src/named.py": lines(3), "src/gone.py": lines(3), "tests/test_a.py": lines(3), "README.md": "x\n" }, async (directory) => {
      await writeFile(join(directory, "src/a.py"), "n\nn\nn\n");
      await writeFile(join(directory, "src/named.py"), "n\nn\nn\n");
      await writeFile(join(directory, "src/new_module.ts"), "export const a = 1;\n");
      await writeFile(join(directory, "tests/test_a.py"), "n\n");
      await writeFile(join(directory, "README.md"), "changed\n");
      await rm(join(directory, "src/gone.py"));
    });
    const parsed = parseLcov(lcov([{ file: join(box.directory, "src/named.py"), lines: [[1, 1]] }]))!;
    const result = (await intersectCoverage(parsed, { repositories: await changesOf(box), bases: [root] }))!;
    expect(result.unlistedFiles).toBe(2);
    // A file the report names but lists none of the changed lines of is named.
    const comment = parseLcov(lcov([{ file: join(box.directory, "src/a.py"), lines: [[99, 1]] }, { file: join(box.directory, "src/named.py"), lines: [[1, 1]] }, { file: join(box.directory, "src/new_module.ts"), lines: [[1, 0]] }]))!;
    expect((await intersectCoverage(comment, { repositories: await changesOf(box), bases: [root] }))?.unlistedFiles).toBe(0);
    // A file the diff could not place (a type change, a binary patch) cannot be measured: counted too.
    const unplaced: RepositoryChanges[] = [{ repositoryId: "api", directory: join(root, "api"), changes: [{ path: "src/odd.py", status: "UNPLACEABLE" as const, hunks: [] }] }];
    expect((await intersectCoverage(parsed, { repositories: unplaced, bases: [root] }))?.unlistedFiles).toBe(1);
    expect(coveragePart(result, 1)).toMatchObject({ unlistedFiles: 2 });
    expect(coveragePart({ ...result, unlistedFiles: 0 }, 1)).not.toHaveProperty("unlistedFiles");
  });

  it("finds a file by a name relative to the check's directory, to the workspace root, or to a `<source>` that is not on this machine (unique suffix of two segments)", async () => {
    const box = await repository({ "pkg/a.py": lines(3), "pkg/b.py": lines(3), "other/b.py": lines(3) }, async (directory) => {
      for (const path of ["pkg/a.py", "pkg/b.py", "other/b.py"]) await writeFile(join(directory, path), "changed\nchanged\nchanged\n");
    });
    const repositories = await changesOf(box);
    const foreign = parseCobertura(cobertura("/home/runner/work/app/api", [{ filename: "pkg/a.py", lines: [[1, 1], [2, 0]] }]))!;
    expect((await intersectCoverage(foreign, { repositories, bases: [root] }))?.files).toEqual([{ repositoryId: "api", path: "pkg/a.py", changed: 2, covered: 1, uncovered: [2] }]);
    const relative = parseLcov(lcov([{ file: "api/pkg/a.py", lines: [[1, 1]] }]))!;
    expect((await intersectCoverage(relative, { repositories, bases: [root] }))?.linesChanged).toBe(1);
    const here = parseLcov(lcov([{ file: "pkg/a.py", lines: [[3, 0]] }]))!;
    expect((await intersectCoverage(here, { repositories, bases: [box.directory] }))?.files[0]).toMatchObject({ path: "pkg/a.py", uncovered: [3] });
    // A suffix of one path segment is never used, and a suffix that fits two repositories equally well is not guessed.
    const single = parseLcov(lcov([{ file: "/x/a.py", lines: [[1, 1]] }]))!;
    expect((await intersectCoverage(single, { repositories, bases: [root] }))?.files).toEqual([]);
    const both: RepositoryChanges[] = ["api", "web"].map((repositoryId) => ({ repositoryId, directory: join(root, repositoryId), changes: [{ path: "src/a.py", status: "MODIFIED" as const, hunks: [[1, 1] as const] }] }));
    const twice = parseLcov(lcov([{ file: "/ci/build/src/a.py", lines: [[1, 1]] }]))!;
    expect((await intersectCoverage(twice, { repositories: both, bases: [root] }))?.files).toEqual([]);
    // Inside a repository, a name is exact: the same file in the second repository is found by its own directory.
    const exact = parseLcov(lcov([{ file: join(root, "web/src/a.py"), lines: [[1, 0]] }]))!;
    expect((await intersectCoverage(exact, { repositories: both, bases: [root] }))?.files).toEqual([{ repositoryId: "web", path: "src/a.py", changed: 1, covered: 0, uncovered: [1] }]);
  });

  // EV-2: relative `<source>` entries are capped like the absolute ones (64 of them x 3 bases x 20,000 names took 2.4 s).
  it("tries at most 8 relative `<source>` directories of a report", async () => {
    const box = await repository({ "d3/a.py": lines(3), "d15/b.py": lines(3) }, async (directory) => {
      for (const path of ["d3/a.py", "d15/b.py"]) await writeFile(join(directory, path), "changed\nchanged\nchanged\n");
    });
    const repositories = await changesOf(box);
    const sources = Array.from({ length: 20 }, (_, index) => `<source>d${String(index)}</source>`).join("");
    const report = (filename: string) => parseCobertura(`<coverage><sources>${sources}</sources><packages><package><classes><class filename="${filename}"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`)!;
    expect(report("a.py").sources).toHaveLength(20);
    expect((await intersectCoverage(report("a.py"), { repositories, bases: [box.directory] }))?.files).toEqual([expect.objectContaining({ path: "d3/a.py" })]);
    expect((await intersectCoverage(report("b.py"), { repositories, bases: [box.directory] }))?.files).toEqual([]);
  });

  it("selects only among the paths the diff names: a report naming files outside the repository, or `..`, measures nothing", async () => {
    const box = await repository({ "a.py": lines(2) }, async (directory) => { await writeFile(join(directory, "a.py"), "c\nc\n"); });
    const parsed = parseLcov(lcov([{ file: "/etc/passwd", lines: [[1, 1]] }, { file: "../../etc/a.py", lines: [[1, 1]] }, { file: "../api/../api/../../a.py", lines: [[1, 1]] }]))!;
    expect((await intersectCoverage(parsed, { repositories: await changesOf(box), bases: [box.directory] }))?.files).toEqual([]);
  });

  it("refuses a change too large to expand line by line", async () => {
    const box = await repository({ "a.py": lines(2) }, async (directory) => { await writeFile(join(directory, "a.py"), lines(50, "n")); });
    const parsed = parseLcov(lcov([{ file: join(box.directory, "a.py"), lines: [[1, 1]] }]))!;
    expect(await intersectCoverage(parsed, { repositories: await changesOf(box), bases: [root], maxChangedLines: 49 })).toBeUndefined();
    expect((await intersectCoverage(parsed, { repositories: await changesOf(box), bases: [root], maxChangedLines: 50 }))?.linesChanged).toBe(1);
  });

  it("bounds the part the pack holds: 100 files, 200 uncovered lines each, repository-qualified paths for several repositories, one plain line", () => {
    const files = Array.from({ length: 130 }, (_, index) => ({ repositoryId: "api", path: `src/f${String(index)}.py`, changed: 300, covered: 0, uncovered: Array.from({ length: 300 }, (_unused, line) => line + 1) }));
    const part = coveragePart({ linesChanged: 39_000, linesCovered: 0, files, unlistedFiles: 0 }, 1);
    expect(part.files).toHaveLength(100);
    expect(part.files[0]?.uncovered).toHaveLength(200);
    expect(coveragePart({ linesChanged: 1, linesCovered: 1, unlistedFiles: 0, files: [{ repositoryId: "web", path: "a\nb.ts", changed: 1, covered: 1, uncovered: [] }] }, 2).files[0]?.path).toBe("web/a b.ts");
  });
});

describe("hostile reports cost a bounded time", () => {
  const timed = async <T>(work: () => Promise<T> | T): Promise<{ value: T; ms: number }> => { const start = performance.now(); const value = await work(); return { value, ms: performance.now() - start }; };
  // What these tests guard is growth, not speed: a slow runner makes every run slower, a super-linear blow-up makes the big input disproportionately slower. So the same work is timed at a size and at
  // four times that size (best of five, after a warm-up), and the time must grow roughly with the size: about 4x when linear, about 16x when quadratic. The limit of 8x sits between them with room
  // for noise; the floor on the small time keeps a very fast small run from turning timer noise into a ratio. A loose absolute ceiling catches a blow-up that a ratio cannot see (both sizes slow).
  const GROWTH_LIMIT = 8;
  const CEILING_MS = 5_000;
  const bestOf = async (work: () => unknown, runs = 5): Promise<number> => { let best = Infinity; for (let index = 0; index < runs; index += 1) best = Math.min(best, (await timed(work)).ms); return best; };
  const growth = async (small: () => unknown, large: () => unknown): Promise<{ smallMs: number; largeMs: number; ratio: number }> => {
    await small();
    await large();
    const smallMs = await bestOf(small);
    const largeMs = await bestOf(large);
    return { smallMs, largeMs, ratio: largeMs / Math.max(smallMs, 2) };
  };

  it("matches thousands of report names against thousands of changed files that end the same way, with many foreign sources, in time that grows with the size and not faster", async () => {
    const changed = (count: number): RepositoryChanges[] => [{ repositoryId: "api", directory: join(root, "api"), changes: Array.from({ length: count }, (_, index) => ({ path: `p${String(index)}/src/index.ts`, status: "MODIFIED" as const, hunks: [[1, 3] as const] })) }];
    const sources = Array.from({ length: 64 }, (_, index) => `<source>/ci/build${String(index)}</source>`).join("");
    // `count` changed files and 2.5 times as many report names, every one ending in src/index.ts.
    const report = (count: number) => {
      const classes = Array.from({ length: count * 2.5 }, (_, index) => `<class filename="m${String(index)}/src/index.ts"><lines><line number="1" hits="1"/></lines></class>`).join("");
      return parseCobertura(`<coverage><sources>${sources}</sources><packages><package><classes>${classes}</classes></package></packages></coverage>`)!;
    };
    const run = (count: number) => { const parsed = report(count); const repositories = changed(count); return () => intersectCoverage(parsed, { repositories, bases: [root] }); };
    const hostile = await growth(run(500), run(2_000));
    expect((await run(2_000)())?.files).toEqual([]);
    expect(hostile.ratio, `500 -> 2,000 files took ${hostile.smallMs.toFixed(1)} ms -> ${hostile.largeMs.toFixed(1)} ms`).toBeLessThan(GROWTH_LIMIT);
    expect(hostile.largeMs).toBeLessThan(CEILING_MS);
    // A one-segment name under several sources still finds its two-segment suffix under the right one.
    const oneSegment: RepositoryChanges[] = [{ repositoryId: "api", directory: join(root, "api"), changes: [{ path: "pkg/mod.ts", status: "MODIFIED" as const, hunks: [[1, 3] as const] }] }];
    const multi = parseCobertura('<coverage><sources><source>/ci/a</source><source>/ci/pkg</source></sources><packages><package><classes><class filename="mod.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>')!;
    expect((await intersectCoverage(multi, { repositories: oneSegment, bases: [root] }))?.files).toHaveLength(1);
    // Few candidates: the suffix match still works for a name that is not on this machine.
    const one = parseLcov(lcov([{ file: "/ci/build/p7/src/index.ts", lines: [[1, 1]] }]))!;
    expect((await intersectCoverage(one, { repositories: changed(2_000), bases: [root] }))?.files).toHaveLength(0);
    const single: RepositoryChanges[] = [{ repositoryId: "api", directory: join(root, "api"), changes: [{ path: "pkg/mod.ts", status: "MODIFIED" as const, hunks: [[1, 3] as const] }] }];
    expect((await intersectCoverage(parseLcov(lcov([{ file: "/ci/build/pkg/mod.ts", lines: [[1, 1]] }]))!, { repositories: single, bases: [root] }))?.files).toHaveLength(1);
  });

  it("reads a SARIF file with tens of thousands of rules and results, each result naming its rule by id, in time that grows with the size and not faster", async () => {
    const sarif = (count: number): string => {
      const rules = Array.from({ length: count }, (_, index) => ({ id: `R${String(index)}`, properties: { "security-severity": "8.0" } }));
      const results = Array.from({ length: count }, (_, index) => ({ ruleId: `R${String(count - 1 - index)}`, message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: "a.py" }, region: { startLine: 1 } } }] }));
      return JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "T", rules } }, results }] });
    };
    const { parseSarif } = await import("../../packages/worker/src/verification/sarif.js");
    const small = sarif(10_000);
    const large = sarif(40_000);
    const parsed = parseSarif(large);
    expect(parsed?.findings).toHaveLength(40_000);
    expect(parsed?.findings.every((finding) => finding.severity === "high")).toBe(true);
    const run = await growth(() => parseSarif(small), () => parseSarif(large));
    expect(run.ratio, `10,000 -> 40,000 results took ${run.smallMs.toFixed(1)} ms -> ${run.largeMs.toFixed(1)} ms`).toBeLessThan(GROWTH_LIMIT);
    expect(run.largeMs).toBeLessThan(CEILING_MS);
  });
});

describe("reading the report file", () => {
  const NOW = () => Date.now() - 5_000;

  it("reads a plain file inside the workspace, relative to the check's directory", async () => {
    await mkdir(join(root, "svc/reports"), { recursive: true });
    await writeFile(join(root, "svc/reports/cov.xml"), "<coverage/>");
    const read = await readContainedReport({ root, cwd: "svc", argument: "reports/cov.xml", maxBytes: 100, notBeforeMs: NOW() });
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && read.bytes.toString()).toBe("<coverage/>");
  });

  it("refuses a path that leaves the workspace, a symlink, a link in the middle of the path, a directory and an absolute path outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await writeFile(join(outside, "secret.xml"), "<coverage/>");
      await mkdir(join(root, "w"));
      await symlink(join(outside, "secret.xml"), join(root, "w/link.xml"));
      await symlink(outside, join(root, "w/dir"));
      await mkdir(join(root, "w/real"));
      const attempt = (argument: string, cwd = "w") => readContainedReport({ root: join(root, "w"), cwd: cwd === "w" ? "." : cwd, argument, maxBytes: 100, notBeforeMs: NOW() });
      for (const argument of ["../../" + outside.split("/").slice(-1)[0] + "/secret.xml", "link.xml", "dir/secret.xml", "real", join(outside, "secret.xml"), "", "a\0b"]) {
        expect((await attempt(argument)).ok, argument).toBe(false);
      }
      expect(await attempt("link.xml")).toEqual({ ok: false, reason: "unsafe_path" });
      expect(await attempt("../w2/none.xml")).toMatchObject({ ok: false });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file over the size cap (and a missing one with its own code), and one written before the round", async () => {
    await writeFile(join(root, "big.xml"), Buffer.alloc(101, 0x20));
    await writeFile(join(root, "ok.xml"), Buffer.alloc(100, 0x20));
    expect(await readContainedReport({ root, cwd: ".", argument: "big.xml", maxBytes: 100, notBeforeMs: NOW() })).toEqual({ ok: false, reason: "too_large" });
    expect((await readContainedReport({ root, cwd: ".", argument: "ok.xml", maxBytes: 100, notBeforeMs: NOW() })).ok).toBe(true);
    expect(await readContainedReport({ root, cwd: ".", argument: "none.xml", maxBytes: 100, notBeforeMs: NOW() })).toEqual({ ok: false, reason: "missing" });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "ok.xml"), old, old);
    expect(await readContainedReport({ root, cwd: ".", argument: "ok.xml", maxBytes: 100, notBeforeMs: NOW() })).toEqual({ ok: false, reason: "stale" });
    // Without a start time nothing is trusted.
    await writeFile(join(root, "fresh.xml"), "x");
    expect(await readContainedReport({ root, cwd: ".", argument: "fresh.xml", maxBytes: 100, notBeforeMs: undefined })).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a file dated into the future and a file whose change time is before the round, whatever its modification time says (an agent can date a file, not its change time)", async () => {
    await writeFile(join(root, "planted.xml"), "<coverage/>");
    const now = Date.now();
    const future = new Date(now + 365 * 86_400_000);
    await utimes(join(root, "planted.xml"), future, future);
    expect(await readContainedReport({ root, cwd: ".", argument: "planted.xml", maxBytes: 100, notBeforeMs: now - 5_000 })).toEqual({ ok: false, reason: "stale" });
    // Planted at `now`; the round "began" 10 s later and the file's modification time was set inside it.
    await writeFile(join(root, "dated.xml"), "<coverage/>");
    const inside = new Date(now + 11_000);
    await utimes(join(root, "dated.xml"), inside, inside);
    expect(await readContainedReport({ root, cwd: ".", argument: "dated.xml", maxBytes: 100, notBeforeMs: now + 10_000, nowMs: now + 20_000 })).toEqual({ ok: false, reason: "stale" });
    // The same file is accepted when the round began before it was written.
    expect((await readContainedReport({ root, cwd: ".", argument: "dated.xml", maxBytes: 100, notBeforeMs: now - 5_000, nowMs: now + 12_000 })).ok).toBe(true);
  });

  it("does not use a planted default-named coverage.xml dated into the future, so the pull request cannot be told every changed line is covered", async () => {
    const box = await repository({ "a.py": "1\n" }, async (directory) => { await writeFile(join(directory, "a.py"), "2\n"); });
    await writeFile(join(root, "coverage.xml"), cobertura(box.directory, [{ filename: "a.py", lines: [[1, 1]] }]));
    const future = new Date(Date.now() + 365 * 86_400_000);
    await utimes(join(root, "coverage.xml"), future, future);
    const repositories = [{ repositoryId: "api", directory: box.directory, startCommit: box.base, candidateTreeSha: box.tree }];
    expect(await collectEvidenceRaw({ rootPath: root, commands: [command(["-q"])], entries: [entry(0)], candidateDigest: DIGEST, repositories, roundStartedAtMs: Date.now() - 5_000 })).toBeUndefined();
  });

  it("has a default size cap of 16 MiB for a coverage report", async () => {
    expect(COVERAGE_REPORT_MAX_BYTES).toBe(16 * 1024 * 1024);
    const box = await repository({ "a.py": "1\n" }, async (directory) => { await writeFile(join(directory, "a.py"), "2\n"); });
    await writeFile(join(root, "coverage.xml"), Buffer.alloc(COVERAGE_REPORT_MAX_BYTES + 1, 0x20));
    const result = await readChangedCoverage({ rootPath: root, command: command(["--cov-report=xml"]), repositories: async () => [{ repositoryId: "api", directory: box.directory, changes: [] }], notBeforeMs: NOW(), used: new Set() });
    expect(result).toEqual({ skip: "too_large" });
  });

  it("says why there is none: no option and not a test command, a report that is not one, or a diff that cannot be read; and uses one file for one check", async () => {
    const box = await repository({ "a.py": "1\n" }, async (directory) => { await writeFile(join(directory, "a.py"), "2\n"); });
    const repositories = async () => [{ repositoryId: "api", directory: box.directory, changes: await candidateChanges({ directory: box.directory, baseCommitSha: box.base, treeSha: box.tree }, { exactLines: true }) }];
    const input = { rootPath: root, repositories, notBeforeMs: NOW(), used: new Set<string>() };
    expect(await readChangedCoverage({ ...input, command: command(["."], ".", "eslint") })).toEqual({ skip: "no_spec" });
    expect(await readChangedCoverage({ ...input, command: command(["--cov-report=xml"]) })).toEqual({ skip: "missing" });
    await writeFile(join(root, "coverage.xml"), "<html/>");
    expect(await readChangedCoverage({ ...input, command: command(["--cov-report=xml"]) })).toEqual({ skip: "unparsable" });
    await writeFile(join(root, "coverage.xml"), cobertura(box.directory, [{ filename: "a.py", lines: [[1, 0]] }]));
    expect(await readChangedCoverage({ ...input, command: command(["--cov-report=xml"]), repositories: async () => undefined })).toEqual({ skip: "changes_unreadable" });
    const first = await readChangedCoverage({ ...input, command: command(["--cov-report=xml"]) });
    expect(first).toMatchObject({ coverage: { linesChanged: 1, linesCovered: 0 } });
    // The same file is not the evidence of a second check.
    expect(await readChangedCoverage({ ...input, command: command(["--cov-report=xml"]) })).toEqual({ skip: "missing" });
  });
});

describe("the evidence a CHECKS run saves", () => {
  async function scenario(report: string, args = ["--cov=src", "--cov-report=xml"]) {
    const box = await repository({ "src/a.py": lines(6) }, async (directory) => { await writeFile(join(directory, "src/a.py"), lines(6).replace("x2\n", "N2\n").replace("x5\n", "N5\n")); });
    await writeFile(join(root, "coverage.xml"), report.replaceAll("@SRC@", join(box.directory, "src")));
    const repositories = [{ repositoryId: "api", directory: box.directory, startCommit: box.base, candidateTreeSha: box.tree }];
    return { box, repositories, args };
  }
  const REPORT = cobertura("@SRC@", [{ filename: "a.py", lines: [[1, 1], [2, 1], [4, 1], [5, 0]] }]);

  it("puts the changed-line coverage of the project's own report into the raw evidence, valid for the schema, and never alters the command", async () => {
    const { repositories, args } = await scenario(REPORT);
    const commands = [command(args)];
    const raw = await collectEvidenceRaw({ rootPath: root, commands, entries: [entry(0)], candidateDigest: DIGEST, repositories, roundStartedAtMs: Date.now() - 5_000 });
    expect(raw?.checks[0]?.coverage).toEqual({ linesChanged: 2, linesCovered: 1, files: [{ path: "src/a.py", uncovered: [5] }] });
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
    expect(commands[0]?.args).toEqual(["--cov=src", "--cov-report=xml"]);
  });

  it("claims nothing without a round start, for a stale report, for a check that did not end, or when the report is not for the check", async () => {
    const { repositories, args } = await scenario(REPORT);
    const base = { rootPath: root, candidateDigest: DIGEST, repositories };
    expect(await collectEvidenceRaw({ ...base, commands: [command(args)], entries: [entry(0)] })).toBeUndefined();
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "coverage.xml"), old, old);
    expect(await collectEvidenceRaw({ ...base, commands: [command(args)], entries: [entry(0)], roundStartedAtMs: Date.now() - 5_000 })).toBeUndefined();
    const now = new Date();
    await utimes(join(root, "coverage.xml"), now, now);
    expect(await collectEvidenceRaw({ ...base, commands: [command(args)], entries: [entry(0, { after: "timed_out" })], roundStartedAtMs: Date.now() - 5_000 })).toBeUndefined();
    expect(await collectEvidenceRaw({ ...base, commands: [command(["."], ".", "eslint")], entries: [entry(0)], roundStartedAtMs: Date.now() - 5_000 })).toBeUndefined();
    // No repository to diff: the changed lines are unknown, so nothing is claimed.
    expect(await collectEvidenceRaw({ ...base, repositories: [], commands: [command(args)], entries: [entry(0)], roundStartedAtMs: Date.now() - 5_000 })).toBeUndefined();
  });

  it("keeps a failed check's coverage next to its output tail", async () => {
    const { repositories, args } = await scenario(REPORT);
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command(args)], entries: [entry(0, { after: "failed", exitCode: 1, output: "boom" })], candidateDigest: DIGEST, repositories, roundStartedAtMs: Date.now() - 5_000 });
    expect(raw?.checks[0]).toMatchObject({ outputTail: "boom", coverage: { linesChanged: 2, linesCovered: 1 } });
  });

  // EV-2: a coverage.xml sitting at a default name is NOT read for a command that does not name it (the agent's own tests could have written it with every line hit).
  it("does not read a report at a default name for a test command that names none", async () => {
    const { repositories } = await scenario(REPORT);
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command(["-q"])], entries: [entry(0, { after: "failed", exitCode: 1, output: "boom" })], candidateDigest: DIGEST, repositories, roundStartedAtMs: Date.now() - 5_000 });
    expect(raw?.checks[0]?.coverage).toBeUndefined();
  });

  it("gives the report to the first check that names it, not to the lint check after it", async () => {
    const { repositories, args } = await scenario(REPORT);
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command(args), command(args)], entries: [entry(0), entry(1)], candidateDigest: DIGEST, repositories, roundStartedAtMs: Date.now() - 5_000 });
    expect(raw?.checks.map((check) => check.checkId)).toEqual(["readiness:0"]);
  });
});
