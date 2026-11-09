// Java reports J1: a JUnit report FOLDER. Maven (Surefire `target/surefire-reports/`, Failsafe `target/failsafe-reports/`) and Gradle (`build/test-results/<task>/`) write one JUnit XML file per test class, so the path a
// check names is a folder, not one file. `readJunitFolder` reads the `.xml` files directly in it (no subfolder) and merges them into one `ParsedTestReport` with the single-file reader (`parseJunit`), so names are
// redacted, one line and cut, and the counts are those of the test cases actually read.
//
// Fail closed and bounded:
//   - a file that cannot be read (too large, malformed, not JUnit although it is named `TEST-*.xml`, unreadable) or that is refused (a symbolic link, a directory or other non-regular file named like a report) is
//     counted and shows as ONE errored entry named for the file, so a lost failure never reads as a pass; `complete` is false and the notes say how many;
//   - a file that is not JUnit at all (`failsafe-summary.xml`) is ignored; a complete suite with no test case is empty; a cut-off one is malformed;
//   - too many files or directory entries, too many bytes in total, or too many tests: the report is `undefined` ("not measured"), the counts could not be trusted to be complete;
//   - every file is opened once with O_NOFOLLOW and its size taken from the open descriptor, and the bytes read are capped at what is left of the total (a file that grows while it is read, or one that reports size 0, cannot
//     pass the cap); the byte total is checked BEFORE each file is read, so no file is read once the total would be passed;
//   - with a workspace root (`readTestReportAt` always gives one), OPEN is followed by a check that the file really lies inside the root: the path is resolved (`realpath`) and the descriptor's file must be the same inode as the
//     one the resolved path names. O_NOFOLLOW stops only a link in the LAST part, so a parent folder swapped for a link to somewhere else between the lstat walk and the open is caught here, not read.
// `readTestReportAt` is the entry point for the evidence path: a path relative to the workspace root, no `..`, no link in any component, a file or a folder.
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { counted, parseJunit, parseTestReport, plainName, TEST_REPORT_MAX_BYTES, TEST_REPORT_MAX_TESTS, type ParsedTestReport, type ReportedTest } from "./test-report.js";

/** More report files than this in one folder is not read. */
export const REPORT_FOLDER_MAX_FILES = 5_000;
/** More directory entries than this (files, folders, logs) is not read: a listing that long is not a test-results folder. */
export const REPORT_FOLDER_MAX_ENTRIES = 20_000;
/** More bytes than this across the report files is not read. */
export const REPORT_FOLDER_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ReportFolderOutcome {
  /** The merged report, or undefined when nothing was measured. */
  report?: ParsedTestReport;
  /** Files that held test cases. */
  filesRead: number;
  /** Complete JUnit files with no test case. */
  filesEmpty: number;
  /** `.xml` files that were not JUnit (a summary file) and were skipped. */
  filesIgnored: number;
  /** Files that looked like reports but could not be read; each is an errored entry in the report. */
  filesMalformed: number;
  /** Links and non-regular files named like reports; each is an errored entry in the report. */
  filesRefused: number;
  /** False when any file was malformed or refused, or a bound was passed: the counts may be missing tests, and must not be read as a clean pass. */
  complete: boolean;
  /** Plain-language lines for the person; no file text. */
  notes: string[];
}

const JUNIT_ELEMENT = /<(?:testsuites?|testcase)[\s/>]/u;
const TESTCASE = /<testcase[\s/>]/u;
/** A suite that ends where a suite ends: a closing tag, or a self-closing tag, as the last thing in the file. */
const COMPLETE_SUITE = /(?:<\/testsuites?\s*>|<testsuites?(?:\s[^<>]*)?\/>)\s*$/u;
const NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;
const problemTest = (name: string, what: string): ReportedTest => ({ name: plainName(`${name} (${what})`), status: "errored" });

function notMeasured(notes: string[], note: string, partial: Partial<ReportFolderOutcome> = {}): ReportFolderOutcome {
  return { filesRead: 0, filesEmpty: 0, filesIgnored: 0, filesMalformed: 0, filesRefused: 0, ...partial, complete: false, notes: [...notes, note] };
}

/** Whether the resolved path `real` lies inside the resolved workspace root. */
const within = (real: string, realRoot: string): boolean => real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);

type FileRead = { text: string; size: number } | "unreadable" | "too_large" | "not_regular" | "over_budget" | "outside";
/**
 * The text of the regular file `path` (opened without following a link), or why not. `remaining` is what is left of the folder's byte total: a file that is larger, or that grows past it while it is read, is
 * `over_budget` and is not read in full. With `realRoot` (the resolved workspace root) the opened file must be inside it (see the header).
 */
async function readReportFile(path: string, limits: { remaining: number; realRoot?: string }): Promise<FileRead> {
  let handle;
  try {
    handle = await open(path, NO_FOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ELOOP" ? "not_regular" : "unreadable";
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return "not_regular";
    if (limits.realRoot !== undefined) {
      // The path as it resolves NOW must be inside the workspace and name the very file this descriptor holds: a parent swapped for a link before the open (and put back after) leaves a different inode here.
      const real = await realpath(path);
      if (!within(real, limits.realRoot)) return "outside";
      const named = await stat(real);
      if (named.ino !== opened.ino || named.dev !== opened.dev) return "outside";
    }
    if (opened.size > TEST_REPORT_MAX_BYTES) return "too_large";
    if (opened.size > limits.remaining) return "over_budget";
    // Read at most one byte more than the cap allows; the size above is only a first look (a file can report 0 and keep growing).
    const cap = Math.min(TEST_REPORT_MAX_BYTES, limits.remaining);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, cap + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
      if (total > cap) return total > TEST_REPORT_MAX_BYTES ? "too_large" : "over_budget";
    }
    return { text: Buffer.concat(chunks, total).toString("utf8"), size: total };
  } catch {
    return "unreadable";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads every `.xml` file directly in `directory` as JUnit and merges them. Never throws. With `root` (the workspace), the folder and every file read must lie inside it once links are resolved; the evidence path
 * (`readTestReportAt`) always passes it.
 */
export async function readJunitFolder(directory: string, root?: string): Promise<ReportFolderOutcome> {
  const notes: string[] = [];
  let metadata;
  let realRoot: string | undefined;
  try {
    metadata = await lstat(directory);
    realRoot = root === undefined ? undefined : await realpath(root);
  } catch {
    return notMeasured(notes, "The report folder could not be found or read.");
  }
  if (!metadata.isDirectory()) return notMeasured(notes, "The report path is not a folder (a link or another kind of file is not followed).");
  const outside = "The report folder is not inside the workspace (a link in its path is not followed), so it was not read.";
  // A folder reached through a linked parent is refused before it is listed; its listing is checked again afterwards (a swap while listing).
  const insideNow = async (): Promise<boolean> => realRoot === undefined || within(await realpath(directory).catch(() => ""), realRoot);
  if (!(await insideNow())) return notMeasured(notes, outside);
  const names: Array<{ name: string; refused: boolean }> = [];
  let entries = 0;
  try {
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        entries += 1;
        if (entries > REPORT_FOLDER_MAX_ENTRIES) return notMeasured(notes, `The report folder lists more than ${String(REPORT_FOLDER_MAX_ENTRIES)} entries, so it was not read.`);
        if (!entry.name.endsWith(".xml") || entry.name.length > 255) continue;
        const regular = entry.isFile() || (!entry.isSymbolicLink() && !entry.isDirectory() && !entry.isBlockDevice() && !entry.isCharacterDevice() && !entry.isFIFO() && !entry.isSocket() && (await lstat(join(directory, entry.name)).catch(() => undefined))?.isFile() === true);
        names.push({ name: entry.name, refused: !regular });
        if (names.length > REPORT_FOLDER_MAX_FILES) return notMeasured(notes, `The report folder holds more than ${String(REPORT_FOLDER_MAX_FILES)} report files, so it was not read.`);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return notMeasured(notes, "The report folder could not be listed.");
  }
  if (!(await insideNow())) return notMeasured(notes, outside);
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const tests: ReportedTest[] = [];
  let filesRead = 0;
  let filesEmpty = 0;
  let filesIgnored = 0;
  let filesMalformed = 0;
  let filesRefused = 0;
  let bytes = 0;
  const partial = (): Pick<ReportFolderOutcome, "filesRead" | "filesEmpty" | "filesIgnored" | "filesMalformed" | "filesRefused"> => ({ filesRead, filesEmpty, filesIgnored, filesMalformed, filesRefused });
  for (const { name, refused } of names) {
    if (refused) {
      filesRefused += 1;
      tests.push(problemTest(name, "not a regular file, not read"));
      continue;
    }
    const read = await readReportFile(join(directory, name), { remaining: REPORT_FOLDER_MAX_TOTAL_BYTES - bytes, ...(realRoot === undefined ? {} : { realRoot }) });
    if (read === "over_budget") return notMeasured(notes, `The report files hold more than ${String(REPORT_FOLDER_MAX_TOTAL_BYTES)} bytes in total, so they were not read.`, partial());
    if (typeof read === "string") {
      if (read === "not_regular" || read === "outside") {
        filesRefused += 1;
        tests.push(problemTest(name, "not a regular file, not read"));
      } else {
        filesMalformed += 1;
        tests.push(problemTest(name, read === "too_large" ? "too large to read" : "could not be read"));
      }
      continue;
    }
    bytes += read.size;
    if (!JUNIT_ELEMENT.test(read.text)) {
      // `TEST-*.xml` is where the build writes test classes; any other name that is not JUnit (a summary) is not a report.
      if (name.startsWith("TEST-")) {
        filesMalformed += 1;
        tests.push(problemTest(name, "not a JUnit report"));
      } else filesIgnored += 1;
      continue;
    }
    const parsed = parseJunit(read.text);
    if (parsed === undefined) {
      if (!TESTCASE.test(read.text) && COMPLETE_SUITE.test(read.text)) filesEmpty += 1;
      else {
        filesMalformed += 1;
        tests.push(problemTest(name, "could not be read"));
      }
      continue;
    }
    filesRead += 1;
    if (tests.length + parsed.tests.length > TEST_REPORT_MAX_TESTS) return notMeasured(notes, `The report files hold more than ${String(TEST_REPORT_MAX_TESTS)} tests, so they were not read.`, partial());
    tests.push(...parsed.tests);
  }
  if (filesMalformed > 0) notes.push(`${plural(filesMalformed, "report file")} could not be read; each shows as an errored entry, and the counts may be missing tests.`);
  if (filesRefused > 0) notes.push(`${plural(filesRefused, "report file")} was a link or not a regular file and was not read; each shows as an errored entry.`);
  return { ...(tests.length === 0 ? {} : { report: counted("junit", tests) }), ...partial(), complete: filesMalformed === 0 && filesRefused === 0, notes };
}

export type ReportReadProblem = "refused" | "missing" | "unreadable";
export interface TestReportRead {
  report?: ParsedTestReport;
  /** Set when the path was a folder. */
  folder?: ReportFolderOutcome;
  problem?: ReportReadProblem;
}

const SAFE_PART = (part: string): boolean => part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0");

/**
 * A check's report path (relative to the workspace root) as a report: a file is read by `parseTestReport` (size cap included), a folder by `readJunitFolder`. The path must stay inside `root`: no `..`, not absolute,
 * and no component, the last one included, may be a symbolic link. `format: "json"` never reads a folder (only JUnit is written as one).
 */
export async function readTestReportAt(root: string, relativePath: string, format: "junit" | "json" | "auto" = "auto"): Promise<TestReportRead> {
  // The length is checked before anything is done with the text (a path of tens of thousands of slashes must cost nothing), and trailing slashes are dropped by a plain scan.
  if (relativePath.length > 500 || relativePath.startsWith("/")) return { problem: "refused" };
  let end = relativePath.length;
  while (end > 0 && relativePath.charCodeAt(end - 1) === 47) end -= 1;
  const parts = relativePath.slice(0, end).split("/");
  if (parts.length > 40 || !parts.every(SAFE_PART)) return { problem: "refused" };
  let current = root;
  let last;
  for (const part of parts) {
    current = join(current, part);
    try {
      last = await lstat(current);
    } catch (error) {
      return { problem: (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "missing" : "unreadable" };
    }
    if (last.isSymbolicLink()) return { problem: "refused" };
  }
  if (last === undefined) return { problem: "missing" };
  if (last.isDirectory()) {
    if (format === "json") return { problem: "refused" };
    const folder = await readJunitFolder(current, root);
    return { ...(folder.report === undefined ? {} : { report: folder.report }), folder };
  }
  if (!last.isFile()) return { problem: "refused" };
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return { problem: "unreadable" };
  }
  const read = await readReportFile(current, { remaining: TEST_REPORT_MAX_BYTES, realRoot });
  if (typeof read === "string") return { problem: read === "not_regular" || read === "outside" ? "refused" : "unreadable" };
  const report = parseTestReport(read.text, format);
  return report === undefined ? {} : { report };
}
