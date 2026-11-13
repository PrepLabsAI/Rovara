// Setup and test health SH31: changed-line coverage from a Go cover profile (`go test -coverprofile`). The profile is read into line ranges per repository file; `changedLineCoverage` then answers, for the lines a change
// added or changed, how many are statements the tests ran. The intersection is format-neutral (ranges per path), so another reader (Cobertura, LCOV) can feed it later.
// Java reports J2: the JaCoCo XML reader (`parseJacocoXml`) feeds the same intersection; `parseLineCoverage` picks the reader from the report's content.
//
// A profile line is `import/path/file.go:startLine.startCol,endLine.endCol statements count`. The import path is mapped to a repository path through the module paths and directories the caller gives (from go.mod /
// go.work); a block outside every known module, or whose path leaves the repository, is dropped and counted. A block covers whole lines (columns are ignored): a line is a statement when any block touches it and is
// covered when ANY block on it ran, so `if cond {` is covered when the condition ran even if the body did not. Comment lines inside a block's lines are counted with it.
// Fail closed and bounded: a text that is not a complete, well-formed profile (a wrong header, a malformed line, mixed modes, a reversed or enormous range, more than 1,000,000 blocks) is `undefined`, "not measured".
// Ranges are merged, never expanded line by line, so a block over millions of lines costs nothing.
import { EVIDENCE_COVERAGE_FILES_MAX, EVIDENCE_UNCOVERED_LINES_MAX } from "@rovara-code/contracts";
import { parseAttributes, plainName, tagEnd, withoutCommentsAndCdata } from "./test-report.js";

/** A cover profile larger than this, or with more blocks, is not read. */
export const GO_COVER_PROFILE_MAX_BYTES = 8 * 1024 * 1024;
export const GO_COVER_PROFILE_MAX_BLOCKS = 1_000_000;
const LINE_MAX = 10_000_000;
const MODES: ReadonlySet<string> = new Set(["set", "count", "atomic"]);
const BLOCK = /^(.+):(\d{1,8})\.\d{1,8},(\d{1,8})\.\d{1,8} \d{1,12} (\d{1,16})$/u;

/** Inclusive line ranges, sorted and non-overlapping. */
type Ranges = ReadonlyArray<readonly [number, number]>;
export interface FileLines { statements: Ranges; covered: Ranges }
export interface LineCoverage {
  /** Repository-relative POSIX path to the file's lines. */
  files: ReadonlyMap<string, FileLines>;
  /** Go: blocks dropped because their file is outside every known module. JaCoCo: source files dropped because no source root holds them (or their name leaves the root). */
  unmappedBlocks: number;
  /** JaCoCo only: source files (as `package/File.java`) that could not be placed in exactly one repository file: found under several source roots, or named twice in the report. They are not in `files`. */
  ambiguousFiles?: readonly string[];
}

/** A module of the repository: its module path (go.mod's `module`) and its directory from the repository root (`.` for the root). */
export interface GoModuleRoot { path: string; dir: string }

/** Whether the text starts with a Go cover profile header (`mode: set|count|atomic`): how a coverage file is told from Cobertura XML or LCOV. */
export function looksLikeGoCoverProfile(text: string): boolean {
  const header = /^\s*mode:[ \t]*(\w+)[ \t]*$/mu.exec(text.slice(0, 256));
  return header !== null && text.slice(0, header.index).trim() === "" && MODES.has(header[1]!);
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function repositoryPath(importPath: string, modules: readonly GoModuleRoot[]): string | undefined {
  let best: GoModuleRoot | undefined;
  for (const module of modules) if (importPath.startsWith(`${module.path}/`) && (best === undefined || module.path.length > best.path.length)) best = module;
  if (best === undefined) return undefined;
  const rest = importPath.slice(best.path.length + 1);
  const joined = best.dir === "." || best.dir === "" ? rest : `${best.dir}/${rest}`;
  const parts = joined.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\")) && joined.length <= 500 ? joined : undefined;
}

export function parseGoCoverProfile(text: string, options: { modules: readonly GoModuleRoot[] }): LineCoverage | undefined {
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > GO_COVER_PROFILE_MAX_BYTES || options.modules.length === 0) return undefined;
  const perFile = new Map<string, { all: Array<[number, number]>; ran: Array<[number, number]> }>();
  let mode: string | undefined;
  let blocks = 0;
  let unmapped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("mode:")) {
      const found = line.slice("mode:".length).trim();
      if (!MODES.has(found) || (mode !== undefined && found !== mode)) return undefined;
      mode = found;
      continue;
    }
    const match = BLOCK.exec(line);
    if (mode === undefined || match === null) return undefined;
    const start = Number(match[2]);
    const end = Number(match[3]);
    const count = Number(match[4]);
    if (!Number.isSafeInteger(count) || start < 1 || end < start || end > LINE_MAX) return undefined;
    blocks += 1;
    if (blocks > GO_COVER_PROFILE_MAX_BLOCKS) return undefined;
    const path = repositoryPath(match[1]!, options.modules);
    if (path === undefined) { unmapped += 1; continue; }
    const entry = perFile.get(path) ?? { all: [], ran: [] };
    entry.all.push([start, end]);
    if (count > 0) entry.ran.push([start, end]);
    perFile.set(path, entry);
  }
  if (perFile.size === 0) return undefined;
  const files = new Map<string, FileLines>();
  for (const [path, entry] of perFile) files.set(path, { statements: merge(entry.all), covered: merge(entry.ran) });
  return { files, unmappedBlocks: unmapped };
}

// ---- JaCoCo XML (Maven `target/site/jacoco/jacoco.xml`, Gradle `build/reports/jacoco/test/jacocoTestReport.xml`)
//
// `<package name="com/acme"><sourcefile name="Foo.java"><line nr="12" mi="0" ci="3" mb="0" cb="0"/>`: a line is a statement when it has instructions (`mi` + `ci` > 0) and covered when any instruction ran (`ci` > 0,
// so a line with a missed branch is covered, the same "any block ran" rule as the Go reader). JaCoCo names a file by package and file name only, so the repository path is the source root plus that name. With the
// repository's file list the one root that holds the file is taken; a file under no root is counted as unmapped, a file under several roots (two modules with the same package and class) or named twice in the report is
// listed as ambiguous and dropped. Without the file list only a single source root is unambiguous. A report that is not complete, well-formed XML (an unclosed element, comment or CDATA section, a malformed `line`, an entity
// declaration, more than 2,000,000 lines) is `undefined`, "not measured".

/** A JaCoCo report larger than this, or with more lines or source files, is not read. */
export const JACOCO_XML_MAX_BYTES = 16 * 1024 * 1024;
export const JACOCO_MAX_LINES = 2_000_000;
export const JACOCO_MAX_SOURCE_FILES = 100_000;
/** Where Maven and Gradle keep main Java sources unless the build says otherwise. */
export const JAVA_DEFAULT_SOURCE_ROOT = "src/main/java";
const JAVA_SOURCE_ROOTS_MAX = 100;
const JAVA_ROOT = /^((?:[A-Za-z0-9_.-]{1,100}\/){0,10}src\/main\/(?:java|kotlin))\/.+\.(?:java|kt)$/u;
const COUNT_MAX = 1_000_000_000;

const isSpace = (character: string | undefined): boolean => character !== undefined && /\s/u.test(character);
const skipSpace = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};
/** Skips any run of comments (each ends at its FIRST `-->`) and spaces from `from`; -1 when a comment is not closed. One forward pass: the position only moves ahead. */
function skipComments(text: string, from: number): number {
  let at = skipSpace(text, from);
  while (text.startsWith("<!--", at)) {
    const close = text.indexOf("-->", at + 4);
    if (close === -1) return -1;
    at = skipSpace(text, close + 3);
  }
  return at;
}

/**
 * Whether the text is a JaCoCo XML report: after the XML declaration, comments and a DOCTYPE, the root element is `<report>`. A forward scan with no backtracking (the file is written by a command the agent
 * can influence, and a pattern with nested quantifiers over comments took exponential time on a file made of empty comments).
 */
export function looksLikeJacocoXml(text: string): boolean {
  const head = text.slice(0, 4096).replace(/^\uFEFF/u, "");
  let at = skipSpace(head, 0);
  if (head.startsWith("<?xml", at)) {
    // `<?xml ... ?>`: the first `>` must be the one that closes the declaration.
    const close = head.indexOf(">", at);
    if (close === -1 || head[close - 1] !== "?" || close - 1 < at + 5) return false;
    at = close + 1;
  }
  at = skipComments(head, at);
  if (at === -1) return false;
  if (head.startsWith("<!DOCTYPE", at)) {
    // A DOCTYPE with an internal subset (`[`) is not accepted.
    const close = head.indexOf(">", at);
    const subset = head.indexOf("[", at);
    if (close === -1 || (subset !== -1 && subset < close)) return false;
    at = close + 1;
    at = skipComments(head, at);
    if (at === -1) return false;
  }
  return head.startsWith("<report", at) && (isSpace(head[at + 7]) || head[at + 7] === ">");
}

/**
 * The source roots a Java repository has, from its file list: every `<module>/src/main/java` and `<module>/src/main/kotlin` that holds a `.java` or `.kt` file, sorted, at most 100. With no such file the default
 * root (`src/main/java`) is returned. A build that moves its sources (Maven `sourceDirectory`, Gradle `sourceSets`) is not read here: a JaCoCo file in a moved root is then counted as not placed, never guessed.
 */
export function javaSourceRoots(repoPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const path of repoPaths) {
    const root = JAVA_ROOT.exec(path)?.[1];
    if (root !== undefined) roots.add(root);
    if (roots.size >= JAVA_SOURCE_ROOTS_MAX) break;
  }
  return roots.size === 0 ? [JAVA_DEFAULT_SOURCE_ROOT] : [...roots].sort();
}

export interface JacocoOptions {
  /** Source roots from the repository root (`javaSourceRoots`). */
  sourceRoots: readonly string[];
  /** The repository's file list: with it, the root that holds a file decides its path; without it only one root is unambiguous. */
  repoPaths?: readonly string[] | ReadonlySet<string>;
}

const tagName = (text: string, from: number): string => {
  let end = from;
  while (end < text.length && /[\w:.-]/u.test(text[end]!)) end += 1;
  return text.slice(from, end);
};
const safeName = (value: string | undefined): value is string => value !== undefined && value.length <= 300 && !value.includes("\\") && !value.includes("\0") && !value.includes("//") && !value.startsWith("/") && value.split("/").every((part) => part !== "." && part !== "..");
const wholeNumber = (value: string | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || !/^\d{1,12}$/u.test(value)) return undefined;
  const number = Number(value);
  return number >= min && number <= max ? number : undefined;
};

/**
 * A package or file name from a report is kept (as part of a path) and may be shown, so it goes through the same guard as a test name (`plainName`: control characters, secrets, length). A name the guard
 * would change is not a name this reader can trust as a path: the file is counted as not placed, never stored under an altered or redacted name.
 */
const plainPath = (value: string): boolean => plainName(value) === value;

type RangeEntry = { all: Array<[number, number]>; ran: Array<[number, number]> };

export function parseJacocoXml(text: string, options: JacocoOptions): LineCoverage | undefined {
  if (text.length === 0 || options.sourceRoots.length === 0 || Buffer.byteLength(text, "utf8") > JACOCO_XML_MAX_BYTES || /<!ENTITY/u.test(text)) return undefined;
  const bare = withoutCommentsAndCdata(text);
  if (bare === undefined) return undefined;
  const known = options.repoPaths === undefined ? undefined : options.repoPaths instanceof Set ? options.repoPaths : new Set(options.repoPaths);
  // One pass over the tags; only report, package, sourcefile and line are looked at, every other element is skipped.
  const found = new Map<string, RangeEntry>();
  const repeated = new Set<string>();
  let unmapped = 0;
  let lines = 0;
  let currentPackage: string | undefined;
  /** The source file being read: its range entry, or undefined when its lines are dropped (a repeated or unplaceable name). */
  let current: { entry: RangeEntry | undefined } | undefined;
  let rootSeen = false;
  let rootClosed = false;
  let position = 0;
  for (;;) {
    const open = bare.indexOf("<", position);
    if (open === -1) break;
    const next = bare[open + 1];
    if (next === "?" || next === "!") {
      const skip = bare.indexOf(">", open);
      if (skip === -1) return undefined;
      position = skip + 1;
      continue;
    }
    const closing = next === "/";
    const name = tagName(bare, open + (closing ? 2 : 1));
    const end = tagEnd(bare, open + 1);
    if (end === -1 || name === "") return undefined;
    position = end + 1;
    if (closing) {
      if (name === "report") rootClosed = true;
      else if (name === "package") currentPackage = undefined;
      else if (name === "sourcefile") current = undefined;
      continue;
    }
    const selfClosing = bare[end - 1] === "/";
    const attributesOf = (): Map<string, string> => parseAttributes(bare.slice(open + 1 + name.length, selfClosing ? end - 1 : end));
    if (name === "report") {
      if (rootSeen) return undefined;
      rootSeen = true;
      if (selfClosing) rootClosed = true;
    } else if (name === "package") {
      const packageName = selfClosing ? undefined : (attributesOf().get("name") ?? "");
      // "\0" marks a package name that leaves the source root or holds odd characters: its files are counted as not placed.
      currentPackage = packageName === undefined || packageName === "" || (safeName(packageName) && plainPath(packageName)) ? packageName : "\0";
    } else if (name === "sourcefile") {
      if (!rootSeen || currentPackage === undefined) return undefined;
      const file = attributesOf().get("name");
      current = undefined;
      if (selfClosing) continue;
      if (found.size + repeated.size + unmapped >= JACOCO_MAX_SOURCE_FILES) return undefined;
      if (currentPackage === "\0" || !safeName(file) || file === "" || file.includes("/") || !plainPath(file)) {
        unmapped += 1;
        current = { entry: undefined };
        continue;
      }
      const key = currentPackage === "" ? file : `${currentPackage}/${file}`;
      if (found.has(key) || repeated.has(key)) {
        repeated.add(key);
        found.delete(key);
        current = { entry: undefined };
      } else {
        const entry: RangeEntry = { all: [], ran: [] };
        found.set(key, entry);
        current = { entry };
      }
    } else if (name === "line" && current !== undefined) {
      const attributes = attributesOf();
      const nr = wholeNumber(attributes.get("nr"), 1, LINE_MAX);
      const missed = wholeNumber(attributes.get("mi"), 0, COUNT_MAX);
      const covered = wholeNumber(attributes.get("ci"), 0, COUNT_MAX);
      if (nr === undefined || missed === undefined || covered === undefined) return undefined;
      lines += 1;
      if (lines > JACOCO_MAX_LINES) return undefined;
      if (current.entry !== undefined && missed + covered > 0) {
        current.entry.all.push([nr, nr]);
        if (covered > 0) current.entry.ran.push([nr, nr]);
      }
    }
  }
  if (!rootSeen || !rootClosed || currentPackage !== undefined || current !== undefined) return undefined;
  const files = new Map<string, FileLines>();
  const ambiguous = new Set<string>(repeated);
  for (const [key, entry] of found) {
    const candidates = options.sourceRoots.map((root) => (root === "" || root === "." ? key : `${root}/${key}`));
    const placed = known === undefined ? (candidates.length === 1 ? candidates : undefined) : candidates.filter((path) => known.has(path));
    if (placed === undefined || placed.length > 1) ambiguous.add(key);
    else if (placed.length === 0) unmapped += 1;
    else files.set(placed[0]!, { statements: merge(entry.all), covered: merge(entry.ran) });
  }
  if (files.size === 0) return undefined;
  return { files, unmappedBlocks: unmapped, ...(ambiguous.size === 0 ? {} : { ambiguousFiles: [...ambiguous].sort() }) };
}

export type LineCoverageFormat = "go" | "jacoco";
export interface LineCoverageOptions {
  /** Go modules (`readGoModuleRoots`): needed to read a Go cover profile. */
  goModules?: readonly GoModuleRoot[];
  /** Java source roots (`javaSourceRoots`): needed to read a JaCoCo report. */
  javaSourceRoots?: readonly string[];
  repoPaths?: readonly string[] | ReadonlySet<string>;
}

/** Reads a coverage file in the format it looks like (a Go cover profile or a JaCoCo XML report) into per-file line coverage. A format whose options are missing, or any other format, is `undefined`: not measured. */
export function parseLineCoverage(text: string, options: LineCoverageOptions): { format: LineCoverageFormat; coverage: LineCoverage } | undefined {
  if (looksLikeGoCoverProfile(text)) {
    const coverage = options.goModules === undefined ? undefined : parseGoCoverProfile(text, { modules: options.goModules });
    return coverage === undefined ? undefined : { format: "go", coverage };
  }
  if (looksLikeJacocoXml(text)) {
    const coverage = options.javaSourceRoots === undefined ? undefined : parseJacocoXml(text, { sourceRoots: options.javaSourceRoots, ...(options.repoPaths === undefined ? {} : { repoPaths: options.repoPaths }) });
    return coverage === undefined ? undefined : { format: "jacoco", coverage };
  }
  return undefined;
}

function contains(ranges: Ranges, line: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle]!;
    if (line < start) high = middle - 1;
    else if (line > end) low = middle + 1;
    else return true;
  }
  return false;
}

/** The most statement lines of one file, and of one report, that are expanded to a line-by-line map for the intersection; a file or report with more is not measured (ranges are merged, so a range this large is not real code). */
export const LINE_COVERAGE_FILE_LINES_MAX = 200_000;
export const LINE_COVERAGE_TOTAL_LINES_MAX = 2_000_000;

/**
 * One file's statements as the line map the changed-line intersection reads (a line is true when a test ran it), or undefined when it holds more than `LINE_COVERAGE_FILE_LINES_MAX` lines. Lets the Go and JaCoCo
 * readers feed the same intersection as Cobertura and LCOV.
 */
export function lineCoverageReportLines(file: FileLines): Map<number, boolean> | undefined {
  const lines = new Map<number, boolean>();
  for (const [start, end] of file.statements) {
    if (end - start + 1 + lines.size > LINE_COVERAGE_FILE_LINES_MAX) return undefined;
    for (let line = start; line <= end; line += 1) lines.set(line, contains(file.covered, line));
  }
  return lines;
}

/** A changed file a coverage report would be expected to name: a Go file that is not a test, or a Java or Kotlin file under a `src/main/java` or `src/main/kotlin` directory. */
const measurableSource = (path: string): boolean => (path.endsWith(".go") && !path.endsWith("_test.go")) || (/\.(?:java|kt)$/u.test(path) && /(?:^|\/)src\/main\/(?:java|kotlin)\//u.test(path));

/** The evidence's `coverage` part (`EvidenceCoverageSchema`). */
export interface ChangedCoverage {
  linesChanged: number;
  linesCovered: number;
  files: Array<{ path: string; uncovered: number[] }>;
}

/**
 * The changed lines (path to new-file line numbers) against the coverage. Only lines the profile calls statements are counted. Files with uncovered lines are listed in path order, at most
 * `EVIDENCE_COVERAGE_FILES_MAX` of them with at most `EVIDENCE_UNCOVERED_LINES_MAX` lines each (the counts stay true). `unmeasured` lists changed Go, Java and Kotlin source files the report does not name at all (no
 * statements there, or their package was not covered): the caller can say so, and their lines are not in the counts.
 */
export function changedLineCoverage(coverage: LineCoverage, changed: ReadonlyMap<string, readonly number[]>): { coverage: ChangedCoverage; unmeasured: string[] } {
  let linesChanged = 0;
  let linesCovered = 0;
  const files: ChangedCoverage["files"] = [];
  const unmeasured: string[] = [];
  for (const path of [...changed.keys()].sort()) {
    const lines = coverage.files.get(path);
    if (lines === undefined) {
      if (measurableSource(path)) unmeasured.push(path);
      continue;
    }
    const uncovered: number[] = [];
    for (const line of [...new Set(changed.get(path))].filter((value) => Number.isSafeInteger(value) && value >= 1).sort((a, b) => a - b)) {
      if (!contains(lines.statements, line)) continue;
      linesChanged += 1;
      if (contains(lines.covered, line)) linesCovered += 1;
      else uncovered.push(line);
    }
    if (uncovered.length > 0 && files.length < EVIDENCE_COVERAGE_FILES_MAX) files.push({ path, uncovered: uncovered.slice(0, EVIDENCE_UNCOVERED_LINES_MAX) });
  }
  return { coverage: { linesChanged, linesCovered, files }, unmeasured };
}
