// Java reports J1: a JUnit report FOLDER (Maven target/surefire-reports, target/failsafe-reports, Gradle build/test-results/<task>) read into one report. Fail closed and bounded: a file that cannot be read is
// an errored entry plus a count, never a quiet pass; a link or special file is refused; a folder over a bound is "not measured".
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidTestId, testIdOf } from "@rovara-code/contracts";
import { TEST_REPORT_MAX_BYTES, TEST_REPORT_MAX_TESTS, displayLine } from "../../packages/worker/src/verification/test-report.js";
import { REPORT_FOLDER_MAX_FILES, readJunitFolder, readTestReportAt } from "../../packages/worker/src/verification/test-report-folder.js";

// What Surefire writes: one TEST-<class>.xml per class.
const suite = (cls: string, cases: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="${cls}" time="0.05" tests="9" errors="0" skipped="0" failures="0">\n<properties><property name="java.version" value="21"/></properties>\n${cases}\n</testsuite>`;
const OK = (cls: string, name: string): string => `<testcase name="${name}" classname="${cls}" time="0.01"/>`;
const FAIL = (cls: string, name: string): string => `<testcase name="${name}" classname="${cls}" time="0.02"><failure message="expected 1 but was 2" type="org.opentest4j.AssertionFailedError">trace</failure></testcase>`;
const SKIP = (cls: string, name: string): string => `<testcase name="${name}" classname="${cls}" time="0"><skipped/></testcase>`;
const ERR = (cls: string, name: string): string => `<testcase name="${name}" classname="${cls}" time="0.02"><error message="boom" type="java.lang.IllegalStateException">trace</error></testcase>`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rovara-report-folder-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const put = (name: string, text: string): void => writeFileSync(join(dir, name), text);

describe("readJunitFolder", () => {
  it("merges the per-class files into one report with the right totals and class-plus-name test ids", async () => {
    put("TEST-com.acme.MatchTest.xml", suite("com.acme.MatchTest", [OK("com.acme.MatchTest", "scoresPartner"), FAIL("com.acme.MatchTest", "rejectsNoRegion")].join("\n")));
    put("TEST-com.acme.RankTest.xml", suite("com.acme.RankTest", [OK("com.acme.RankTest", "top5"), SKIP("com.acme.RankTest", "slow"), ERR("com.acme.RankTest", "timeout")].join("\n")));
    const result = await readJunitFolder(dir);
    expect(result.report).toMatchObject({ format: "junit", total: 5, passed: 2, failed: 1, skipped: 1, errored: 1 });
    expect(result.report?.tests.map((test) => `${test.file}::${test.name}`)).toEqual([
      "com/acme/MatchTest::scoresPartner", "com/acme/MatchTest::rejectsNoRegion", "com/acme/RankTest::top5", "com/acme/RankTest::slow", "com/acme/RankTest::timeout",
    ]);
    expect(result).toMatchObject({ filesRead: 2, filesMalformed: 0, filesRefused: 0, complete: true });
  });
  it("counts the test cases it reads, not the files' own summary attributes, and keeps a repeated id from a rerun", async () => {
    put("TEST-a.A.xml", suite("a.A", OK("a.A", "t")));
    put("TEST-a.B.xml", suite("a.A", OK("a.A", "t")));
    expect((await readJunitFolder(dir)).report?.total).toBe(2);
  });
  it("reads other *.xml JUnit files, ignores files that are not JUnit (a failsafe summary) and ignores non-xml files and subfolders", async () => {
    put("TEST-a.A.xml", suite("a.A", OK("a.A", "t")));
    put("junit-extra.xml", `<testsuites><testsuite name="x">${OK("b.B", "u")}</testsuite></testsuites>`);
    put("failsafe-summary.xml", '<failsafe-summary result="null" timeout="false"><completed>2</completed></failsafe-summary>');
    put("a.A.txt", "Tests run: 1");
    put("a.A-output.txt", "log");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "TEST-c.C.xml"), suite("c.C", OK("c.C", "deep")));
    const result = await readJunitFolder(dir);
    expect(result.report?.total).toBe(2);
    expect(result).toMatchObject({ filesRead: 2, filesIgnored: 1, filesMalformed: 0, complete: true });
  });
  it("counts a malformed TEST file, shows it as one errored entry named for the file, and still reads the others", async () => {
    put("TEST-a.A.xml", suite("a.A", OK("a.A", "t")));
    put("TEST-b.B.xml", '<testsuite name="b.B"><testcase name="cut" classname="b.B"><failure>');
    put("TEST-c.C.xml", "<html>not a report</html>");
    const result = await readJunitFolder(dir);
    expect(result).toMatchObject({ filesRead: 1, filesMalformed: 2, complete: false });
    expect(result.report).toMatchObject({ total: 3, passed: 1, errored: 2 });
    expect(result.report?.tests.filter((test) => test.status === "errored").map((test) => test.name).join("|")).toContain("TEST-b.B.xml");
    expect(result.notes.join(" ")).toMatch(/2 .*could not be read/u);
  });
  it("treats a suite with no test case as empty (not malformed) only when it is complete", async () => {
    put("TEST-a.A.xml", suite("a.A", OK("a.A", "t")));
    put("TEST-e.E.xml", '<testsuite name="e.E" tests="0"></testsuite>');
    put("TEST-f.F.xml", '<testsuite name="f.F" tests="0"/>');
    put("TEST-g.G.xml", '<testsuite name="g.G" tests="0"');
    const result = await readJunitFolder(dir);
    expect(result).toMatchObject({ filesRead: 1, filesEmpty: 2, filesMalformed: 1, complete: false });
    expect(result.report?.total).toBe(2);
  });
  it("is not measured when the folder holds no test at all, or is empty", async () => {
    expect((await readJunitFolder(dir)).report).toBeUndefined();
    put("TEST-e.E.xml", '<testsuite name="e.E" tests="0"/>');
    const result = await readJunitFolder(dir);
    expect(result.report).toBeUndefined();
    expect(result).toMatchObject({ filesEmpty: 1, complete: true });
  });
  it("refuses a symbolic link, a directory named like a report and never reads the link's target", async () => {
    put("TEST-a.A.xml", suite("a.A", OK("a.A", "t")));
    const outside = mkdtempSync(join(tmpdir(), "rovara-report-outside-"));
    try {
      writeFileSync(join(outside, "secret.xml"), suite("z.Z", OK("z.Z", "leaked")));
      symlinkSync(join(outside, "secret.xml"), join(dir, "TEST-z.Z.xml"));
      mkdirSync(join(dir, "TEST-d.D.xml"));
      const result = await readJunitFolder(dir);
      expect(result).toMatchObject({ filesRead: 1, filesRefused: 2, complete: false });
      expect(result.report?.tests.map((test) => test.name).join("|")).not.toContain("leaked");
      expect(result.report).toMatchObject({ total: 3, passed: 1, errored: 2 });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("counts a file over the per-file limit as malformed without reading it", async () => {
    put("TEST-a.A.xml", suite("a.A", OK("a.A", "t")));
    put("TEST-big.Big.xml", suite("big.Big", OK("big.Big", "t")) + " ".repeat(TEST_REPORT_MAX_BYTES));
    const result = await readJunitFolder(dir);
    expect(result).toMatchObject({ filesRead: 1, filesMalformed: 1, complete: false });
  });
  it("is not measured when the folder has too many files, too many bytes in total, or too many tests", async () => {
    for (let index = 0; index <= REPORT_FOLDER_MAX_FILES; index += 1) put(`TEST-c${String(index)}.xml`, `<testsuite>${OK("c.C", `t${String(index)}`)}</testsuite>`);
    const tooMany = await readJunitFolder(dir);
    expect(tooMany.report).toBeUndefined();
    expect(tooMany.complete).toBe(false);
    expect(tooMany.notes.join(" ")).toMatch(/more than/u);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const half = `<testsuite>${OK("c.C", "t").repeat(TEST_REPORT_MAX_TESTS / 2 + 1)}</testsuite>`;
    put("TEST-h1.xml", half);
    put("TEST-h2.xml", half);
    const tests = await readJunitFolder(dir);
    expect(tests.report).toBeUndefined();
    expect(tests.complete).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const filler = `<testsuite>${OK("c.C", "t")}</testsuite>${" ".repeat(TEST_REPORT_MAX_BYTES - 1000)}`;
    for (let index = 0; index < 9; index += 1) put(`TEST-f${String(index)}.xml`, filler);
    const bytes = await readJunitFolder(dir);
    expect(bytes.report).toBeUndefined();
    expect(bytes.complete).toBe(false);
    expect(bytes.notes.join(" ")).toMatch(/bytes/u);
  });
  it("redacts and cuts names as a single report does, and never throws for a folder that is not there", async () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    put("TEST-a.A.xml", suite("a.A", OK("a.A", `uses ${token}`)));
    expect((await readJunitFolder(dir)).report?.tests[0]?.name).not.toContain(token);
    const missing = await readJunitFolder(join(dir, "nope"));
    expect(missing.report).toBeUndefined();
    expect(missing.complete).toBe(false);
  });
});

describe("readJunitFolder inside a workspace root", () => {
  it("refuses a folder reached through a symbolic link in a PARENT part, not only in the last part", async () => {
    const outside = mkdtempSync(join(tmpdir(), "rovara-report-outside-"));
    try {
      mkdirSync(join(outside, "reports"));
      writeFileSync(join(outside, "reports", "TEST-z.Z.xml"), suite("z.Z", OK("z.Z", "leaked")));
      symlinkSync(outside, join(dir, "target"));
      // The last part (`reports`) is a real folder, so the final lstat alone would pass.
      const result = await readJunitFolder(join(dir, "target", "reports"), dir);
      expect(result.report).toBeUndefined();
      expect(result.complete).toBe(false);
      expect(result.notes.join(" ")).toMatch(/not inside the workspace/u);
      expect(JSON.stringify(result)).not.toContain("leaked");
      expect((await readTestReportAt(dir, "target/reports")).problem).toBe("refused");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("reads a folder inside the root, also when the root itself is reached through a link", async () => {
    const linked = join(tmpdir(), `rovara-report-linked-${String(process.pid)}-${String(Date.now())}`);
    try {
      mkdirSync(join(dir, "r"));
      writeFileSync(join(dir, "r", "TEST-a.A.xml"), suite("a.A", OK("a.A", "t")));
      symlinkSync(dir, linked);
      expect((await readJunitFolder(join(linked, "r"), linked)).report?.total).toBe(1);
      expect((await readTestReportAt(linked, "r")).report?.total).toBe(1);
    } finally {
      rmSync(linked, { force: true });
    }
  });
  it("cuts a very long path before doing any work on it, and drops trailing slashes without a pattern that is quadratic", async () => {
    for (const path of ["/".repeat(80_000) + "a", "a".repeat(501), "a" + "/".repeat(80_000)]) {
      const started = performance.now();
      expect((await readTestReportAt(dir, path)).problem, path.slice(0, 5)).toBe("refused");
      expect(performance.now() - started).toBeLessThan(50);
    }
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "r", "TEST-a.A.xml"), suite("a.A", OK("a.A", "t")));
    expect((await readTestReportAt(dir, "r" + "/".repeat(300))).report?.total).toBe(1);
  });
  it("redacts a secret in a report's file attribute, and keeps a hidden character in the file as written but never as a valid test id (shown as one plain line)", async () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    put("TEST-a.A.xml", suite("a.A", `<testcase name="t" classname="a.A" file="src/${token}/A.java"/><testcase name="u" classname="a.A" file="src/B\u202e.java"/><testcase name="v" classname="a.A" file="src/Fine.java"/>`));
    const result = await readJunitFolder(dir);
    expect(JSON.stringify(result.report)).not.toContain(token);
    // NH-1 re-check F2/F5: the file is kept as the report wrote it (a test's id is built from it, and an id must be the real one), so the hidden character stays in the parsed report; the id it makes is not valid,
    // is never matched, and is shown only as one plain line (the evidence and the nightly use `isValidTestId` and `displayLine`).
    const files = result.report?.tests.map((test) => test.file);
    expect(files?.[1]).toBe("src/B\u202e.java");
    const ids = result.report?.tests.map((test) => testIdOf(test)) ?? [];
    expect(ids.map((id) => isValidTestId(id))).toEqual([true, false, true]);
    expect(displayLine(ids[1]!)).not.toContain("\u202e");
    expect(displayLine(ids[1]!)).toBe("src/B .java::u");
    expect(files?.[2]).toBe("src/Fine.java");
  });
});

describe("readTestReportAt", () => {
  it("reads a folder or a single file under the root, by relative path", async () => {
    mkdirSync(join(dir, "target", "surefire-reports"), { recursive: true });
    writeFileSync(join(dir, "target", "surefire-reports", "TEST-a.A.xml"), suite("a.A", OK("a.A", "t")));
    writeFileSync(join(dir, "single.xml"), suite("s.S", OK("s.S", "one") + FAIL("s.S", "two")));
    const folder = await readTestReportAt(dir, "target/surefire-reports/");
    expect(folder.report?.total).toBe(1);
    expect(folder.folder?.filesRead).toBe(1);
    const file = await readTestReportAt(dir, "single.xml");
    expect(file.report).toMatchObject({ total: 2, failed: 1 });
    expect(file.folder).toBeUndefined();
  });
  it("refuses a path that leaves the root, is absolute, or goes through a symbolic link, and reports a missing path", async () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "TEST-a.A.xml"), suite("a.A", OK("a.A", "t")));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    for (const path of ["../x", "/etc", "a/../b", "link", "link/TEST-a.A.xml", "", "a\\b"]) expect((await readTestReportAt(dir, path)).report, path).toBeUndefined();
    expect((await readTestReportAt(dir, "link")).problem).toBe("refused");
    expect((await readTestReportAt(dir, "gone")).problem).toBe("missing");
  });
  it("does not read a folder for a JSON-only request", async () => {
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "r", "TEST-a.A.xml"), suite("a.A", OK("a.A", "t")));
    expect((await readTestReportAt(dir, "r", "json")).report).toBeUndefined();
  });
});
