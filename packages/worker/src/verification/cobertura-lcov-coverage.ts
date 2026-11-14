// Proof and evidence P3: changed-line coverage. A project's own tests can already write a coverage report (pytest-cov or coverage.py as Cobertura XML or LCOV, jest, vitest, nyc and c8 as LCOV or Cobertura).
// AgentX never changes a customer's command, so it reads the file the command already writes, and intersects it with the lines the change added or changed (the diff from the task's start commit to the
// checked tree, renames included, a pure deletion counting no line). It says how many of those lines the tests ran, and which ones they did not.
//
// What counts: a changed line is "measured" when the coverage report lists it (a comment, a blank line or a declaration is not an executable line, so no report lists it). A changed file the report does not
// list at all is not measured. A report that is missing, stale (not written in this round), unreadable, over the size cap, or not a coverage report is "no coverage report": nothing is claimed.
//
// The report is untrusted text (the repository's tests wrote it, and so may the agent): every read is bounded (bytes, files, lines), the scan is one forward pass with no backtracking, a malformed file is
// refused whole, and a file name inside it only ever selects among the paths the diff already names, so it can never make AgentX read any other file.
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { EVIDENCE_COVERAGE_FILES_MAX, EVIDENCE_UNCOVERED_LINES_MAX, type EvidenceRaw, type ProjectCommand } from "@agentx/contracts";
import type { CandidateChange } from "./diff.js";
import { isTestPath } from "./test-paths.js";
import { readContainedReport, type ReportFileFailure } from "./report-file.js";
import { ATTRIBUTE_TEXT_MAX, parseAttributes, tagEnd, unescapeXml, withoutCommentsAndCdata } from "./test-report.js";

/** A coverage file larger than this is not read. */
export const COVERAGE_REPORT_MAX_BYTES = 16 * 1024 * 1024;
/** A report that lists more files, or more lines in all, than this is not read: its totals could not be trusted to be complete. */
export const COVERAGE_REPORT_MAX_FILES = 20_000;
export const COVERAGE_REPORT_MAX_LINES = 4_000_000;
/** The most changed lines one change is intersected over; a change this large is not measured line by line. */
export const COVERAGE_CHANGED_LINES_MAX = 2_000_000;
export interface CoverageLimits { files: number; lines: number }
export const COVERAGE_LIMITS: CoverageLimits = { files: COVERAGE_REPORT_MAX_FILES, lines: COVERAGE_REPORT_MAX_LINES };
const NAME_MAX = 1_024;
/** The most changed files that may share a name's last two path segments for a suffix match, and the most `<source>` directories tried for one: bounds the work a report can ask for. */
const SUFFIX_CANDIDATES_MAX = 8;
const SUFFIX_SOURCES_MAX = 8;
const LCOV_LINE_MAX = 4_096;

export type CoverageFormat = "cobertura" | "lcov";
/** One file a report names: for each line the report lists, whether any test ran it. */
export type ReportLines = Map<number, boolean>;
export interface ParsedCoverage {
  /** `line`: a Go cover profile or a JaCoCo report, already placed in its repository (`line-coverage-join.ts`). */
  format: CoverageFormat | "line";
  /** Cobertura's `<source>` directories, which its relative file names are relative to. */
  sources: string[];
  files: Map<string, ReportLines>;
}

// ---- parsing

function addLine(lines: ReportLines, line: number, hits: number, total: { lines: number }, limits: CoverageLimits): boolean {
  if (total.lines >= limits.lines) return false;
  total.lines += 1;
  // A line listed twice (a method's lines and its class's, or a file in two classes) is covered when any listing says so.
  lines.set(line, (lines.get(line) ?? false) || hits > 0);
  return true;
}

const POSITIVE_INTEGER = /^\d{1,9}$/u;
const HITS = /^\d{1,15}(?:\.\d+)?$/u;

/** Cobertura XML: `<class filename>` holds `<line number hits>` (also inside `<method>`). One forward pass; an unclosed tag, comment or CDATA section makes the file unreadable. */
export function parseCobertura(text: string, limits: CoverageLimits = COVERAGE_LIMITS): ParsedCoverage | undefined {
  const bare = withoutCommentsAndCdata(text);
  if (bare === undefined || !/<coverage[\s>]/u.test(bare)) return undefined;
  const files = new Map<string, ReportLines>();
  const sources: string[] = [];
  const total = { lines: 0 };
  let current: string | undefined;
  let position = 0;
  for (;;) {
    const start = bare.indexOf("<", position);
    if (start === -1) break;
    if (bare[start + 1] === "/") {
      const end = bare.indexOf(">", start);
      if (end === -1) return undefined;
      if (bare.startsWith("</class", start) && /[\s>]/u.test(bare[start + "</class".length] ?? ">")) current = undefined;
      position = end + 1;
      continue;
    }
    if (bare[start + 1] === "?" || bare[start + 1] === "!") {
      const end = bare.indexOf(">", start);
      if (end === -1) return undefined;
      position = end + 1;
      continue;
    }
    let nameEnd = start + 1;
    while (nameEnd < bare.length && /[A-Za-z]/u.test(bare[nameEnd]!)) nameEnd += 1;
    const tag = bare.slice(start + 1, nameEnd);
    const end = tagEnd(bare, nameEnd);
    if (end === -1) return undefined;
    const selfClosing = bare[end - 1] === "/";
    position = end + 1;
    if (tag === "source" && !selfClosing) {
      const close = bare.indexOf("<", position);
      if (close === -1) return undefined;
      const value = unescapeXml(bare.slice(position, close)).trim();
      if (value !== "" && value.length <= NAME_MAX && sources.length < 64 && !value.includes("\0")) sources.push(value);
      position = close;
      continue;
    }
    if (tag !== "class" && tag !== "line") continue;
    const attributeText = bare.slice(nameEnd, selfClosing ? end - 1 : end);
    if (attributeText.length > ATTRIBUTE_TEXT_MAX) return undefined;
    const attributes = parseAttributes(attributeText);
    if (tag === "class") {
      const name = attributes.get("filename");
      current = name === undefined || name === "" || name.length > NAME_MAX || name.includes("\0") ? undefined : name;
      // A class with a file name but no lines still names the file (measured, with nothing to run).
      if (current !== undefined && !files.has(current)) {
        if (files.size >= limits.files) return undefined;
        files.set(current, new Map());
      }
      if (selfClosing) current = undefined;
      continue;
    }
    const number = attributes.get("number");
    const hits = attributes.get("hits");
    if (current === undefined || number === undefined || hits === undefined || !POSITIVE_INTEGER.test(number) || !HITS.test(hits)) continue;
    if (!addLine(files.get(current)!, Number(number), Number(hits), total, limits)) return undefined;
  }
  return { format: "cobertura", sources, files };
}

/** LCOV tracefile: `SF:<path>` then `DA:<line>,<hits>[,<checksum>]` lines, then `end_of_record`. Other records (functions, branches, totals) are ignored: the totals are counted from the lines. */
export function parseLcov(text: string, limits: CoverageLimits = COVERAGE_LIMITS): ParsedCoverage | undefined {
  const files = new Map<string, ReportLines>();
  const total = { lines: 0 };
  let current: string | undefined;
  let sawFile = false;
  for (const raw of text.split("\n")) {
    if (raw.length > LCOV_LINE_MAX) {
      // A line this long is not a record anyone wrote for a coverage tool: skip it, but a path it would have named is not trusted.
      if (raw.startsWith("SF:")) current = undefined;
      continue;
    }
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("SF:")) {
      const name = line.slice(3).trim();
      sawFile = true;
      current = name === "" || name.length > NAME_MAX || name.includes("\0") ? undefined : name;
      if (current !== undefined && !files.has(current)) {
        if (files.size >= limits.files) return undefined;
        files.set(current, new Map());
      }
    } else if (line === "end_of_record") {
      current = undefined;
    } else if (line.startsWith("DA:") && current !== undefined) {
      const [number, hits] = line.slice(3).split(",");
      if (number === undefined || hits === undefined || !POSITIVE_INTEGER.test(number) || !HITS.test(hits)) continue;
      if (!addLine(files.get(current)!, Number(number), Number(hits), total, limits)) return undefined;
    }
  }
  return sawFile ? { format: "lcov", sources: [], files } : undefined;
}

// ---- where a command's coverage report is

export interface CoverageSpec {
  /** `named`: the approved `coveragePath`, whose format is told from its name and then its content (Cobertura, LCOV, JaCoCo, Go cover profile). */
  format: CoverageFormat | "named";
  /** The file's path as the command line names it, relative to the command's cwd. */
  argument: string;
}

/** Values given to an option, in the forms `--name=value` and `--name value` (and, for a list option, the plain words after it). */
function optionValues(args: readonly string[], names: readonly string[], list = false): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!names.includes(name)) continue;
    if (equals !== -1) {
      values.push(arg.slice(equals + 1));
      continue;
    }
    for (let next = index + 1; next < args.length && !args[next]!.startsWith("-"); next += 1) {
      values.push(args[next]!);
      if (!list) break;
    }
  }
  return values.map((value) => value.replace(/^\[|\]$/gu, "")).flatMap((value) => value.split(",")).map((value) => value.trim().replace(/^['"]|['"]$/gu, "")).filter((value) => value !== "");
}

const join = (directory: string, name: string) => `${directory.replace(/\/+$/u, "")}/${name}`;
const isReportPath = (value: string) => value.length <= NAME_MAX && !value.startsWith("-") && /\.(?:xml|info|lcov)$/iu.test(value);

/**
 * The coverage files a command's own line asks its tool to write (pytest-cov `--cov-report=xml[:path]` or `lcov[:path]`, `coverage xml|lcov [-o path]`, jest `--coverageReporters` and `--coverageDirectory`,
 * vitest `--coverage.reporter` and `--coverage.reportsDirectory`, nyc and c8 `--reporter` and `--report-dir`, and any option about coverage given a report file), Cobertura first. A command that names none has none: the tools' default
 * file names are NOT guessed (EV-2), because a test the agent wrote can write a report at a default name with every line hit, and a report counts only when the check's own command line asks for it. What this
 * leaves is inherent: a report the named command writes proves what the project's tooling wrote, not that it measured the real code, since code that runs in the round (a test, a conftest, a coverage config the
 * agent changed) can forge that file too. The command is never altered.
 */
export function coverageSpecsOf(command: ProjectCommand, approvedPath?: string): CoverageSpec[] {
  const args = command.args;
  const words = [command.executable.split("/").at(-1) ?? command.executable, ...args];
  const specs: CoverageSpec[] = [];
  const add = (format: CoverageFormat, argument: string) => {
    if (argument !== "" && argument.length <= NAME_MAX && !specs.some((spec) => spec.argument === argument)) specs.push({ format, argument });
  };
  // pytest-cov
  for (const value of optionValues(args, ["--cov-report"])) {
    const [kind, ...rest] = value.split(":");
    const path = rest.join(":");
    if (kind === "xml") add("cobertura", path === "" ? "coverage.xml" : path);
    else if (kind === "lcov") add("lcov", path === "" ? "coverage.lcov" : path);
  }
  // coverage.py
  const tool = words.findIndex((word, index) => word === "coverage" && (index === 0 || words[index - 1] === "-m"));
  const subcommand = tool === -1 ? undefined : words.slice(tool + 1).find((word) => !word.startsWith("-"));
  if (subcommand === "xml" || subcommand === "lcov") {
    const out = optionValues(args, ["-o", "--output"])[0];
    add(subcommand === "xml" ? "cobertura" : "lcov", out ?? (subcommand === "xml" ? "coverage.xml" : "coverage.lcov"));
  }
  // jest, vitest, nyc, c8
  const jsDirectory = optionValues(args, ["--coverageDirectory", "--coverage.reportsDirectory", "--reportsDirectory", "--report-dir", "--reports-dir"])[0] ?? "coverage";
  const nycLike = words.some((word) => word === "nyc" || word === "c8");
  const reporters = [...optionValues(args, ["--coverageReporters"], true), ...optionValues(args, ["--coverage.reporter"], true), ...(nycLike ? optionValues(args, ["--reporter", "-r"]) : [])];
  for (const reporter of reporters) {
    if (reporter === "cobertura") add("cobertura", join(jsDirectory, "cobertura-coverage.xml"));
    else if (reporter === "lcov" || reporter === "lcovonly") add("lcov", join(jsDirectory, "lcov.info"));
  }
  // any option about coverage given a report file
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name === "--cov-report" || !/^--?[\w.-]*(?:cov|lcov|cobertura)[\w.-]*$/iu.test(name)) continue;
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (value !== undefined && !value.includes(":") && isReportPath(value)) add(/\.xml$/iu.test(value) ? "cobertura" : "lcov", value);
  }
  specs.sort((left, right) => Number(right.format === "cobertura") - Number(left.format === "cobertura"));
  // The report the maintainer approved for this check (`coveragePath` of the approved test environment or setup): a named report like the ones above, tried after them. It is data a person approved, not a guess, which
  // is why it meets the rule that no file name is guessed; the project's coverage may be set in a config (pytest addopts, jest, vitest, a JaCoCo build) and not on the command line.
  if (approvedPath !== undefined && approvedPath !== "" && approvedPath.length <= NAME_MAX && !approvedPath.startsWith("-") && !approvedPath.includes("\0") && !specs.some((spec) => spec.argument === approvedPath)) specs.push({ format: "named", argument: approvedPath });
  return specs;
}

// ---- the intersection

export interface RepositoryChanges {
  repositoryId: string;
  /** The repository's directory on the worker. */
  directory: string;
  changes: readonly CandidateChange[];
}

export interface ChangedCoverageFile {
  repositoryId: string;
  path: string;
  /** Changed lines the report lists, how many of them a test ran, and which it did not. */
  changed: number;
  covered: number;
  uncovered: number[];
}
export interface ChangedCoverage {
  linesChanged: number;
  linesCovered: number;
  files: ChangedCoverageFile[];
  /** Changed source files (tests excluded) with lines of their own that the report never names: none of their lines is in the counts, and the count says so instead of leaving them out silently. */
  unlistedFiles: number;
}

const SOURCE_EXTENSION = /\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|go|java|kt|kts|scala|rb|rs|c|cc|cpp|cxx|h|hpp|cs|php|swift|m|mm)$/iu;

const posix = (path: string) => path.split(sep).join("/");
/** The path below `directory` (POSIX separators), or undefined when it is not strictly inside it. Both are absolute and already normalised, so a prefix test is the whole check (and costs no path arithmetic). */
const withinDirectory = (path: string, directory: string): string | undefined => {
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  if (!path.startsWith(prefix) || path.length === prefix.length) return undefined;
  const rest = path.slice(prefix.length);
  return rest.split(sep).includes("..") ? undefined : posix(rest);
};

interface Target { repositoryId: string; path: string; lines: Set<number> }

/** The new-side lines each added or modified file has, from the diff's inclusive ranges. A change too large to expand is refused whole (`undefined`). */
function changedTargets(repositories: readonly RepositoryChanges[], maxLines: number): Map<string, Target> | undefined {
  const targets = new Map<string, Target>();
  let total = 0;
  for (const repository of repositories) {
    for (const change of repository.changes) {
      if ((change.status !== "ADDED" && change.status !== "MODIFIED") || change.hunks.length === 0) continue;
      const lines = new Set<number>();
      for (const [first, last] of change.hunks) {
        total += Math.max(0, last - first + 1);
        if (total > maxLines) return undefined;
        for (let line = first; line <= last; line += 1) lines.add(line);
      }
      targets.set(`${repository.repositoryId}\0${change.path}`, { repositoryId: repository.repositoryId, path: change.path, lines });
    }
  }
  return targets;
}

export interface IntersectContext {
  repositories: readonly RepositoryChanges[];
  /** The directories a relative file name may be relative to, absolute: the report's sources, the check's working directory and the workspace root. */
  bases: readonly string[];
  /** Changed lines past which the change is not measured line by line (default `COVERAGE_CHANGED_LINES_MAX`). */
  maxChangedLines?: number;
}

/**
 * The changed lines the report measures. A report file name is turned into a repository-relative path in turn: exact (an absolute name under a repository, or a relative name under a base), then, only for an
 * absolute name that is not on this machine (a path inside a container or on a CI host), by a unique suffix of at least two path segments. A name that selects nothing the diff names is ignored.
 */
export async function intersectCoverage(parsed: ParsedCoverage, context: IntersectContext): Promise<ChangedCoverage | undefined> {
  const targets = changedTargets(context.repositories, context.maxChangedLines ?? COVERAGE_CHANGED_LINES_MAX);
  if (targets === undefined) return undefined;
  const roots: Array<{ repositoryId: string; directories: string[] }> = [];
  for (const repository of context.repositories) {
    const real = await realpath(repository.directory).catch(() => undefined);
    roots.push({ repositoryId: repository.repositoryId, directories: [...new Set([resolve(repository.directory), ...(real === undefined ? [] : [real])])] });
  }
  const bases = [...new Set(context.bases.map((base) => resolve(base)))];
  // Targets with at least two path segments, by their last TWO segments, longest first: a suffix match looks only at the few targets that end the same way as the report's name, not at every changed file.
  const lastTwo = (path: string): string => path.split("/").slice(-2).join("/");
  const suffixes = new Map<string, Target[]>();
  for (const target of [...targets.values()].filter((candidate) => candidate.path.split("/").length >= 2).sort((left, right) => right.path.length - left.path.length)) {
    const key = lastTwo(target.path);
    const listed = suffixes.get(key);
    if (listed === undefined) suffixes.set(key, [target]);
    else listed.push(target);
  }
  // The report's sources, sorted out once (not per file): the absolute ones (the first few only) and the relative ones.
  const absoluteSources = parsed.sources.filter((source) => isAbsolute(source)).slice(0, SUFFIX_SOURCES_MAX);
  // The relative ones are capped the same way (64 relative sources x 3 bases x 20,000 names was 2.4 s).
  const relativeSources = parsed.sources.filter((source) => !isAbsolute(source)).slice(0, SUFFIX_SOURCES_MAX);
  const byTarget = new Map<Target, ReportLines>();
  const matchExact = (absolute: string): Target | undefined => {
    for (const root of roots) {
      for (const directory of root.directories) {
        const path = withinDirectory(absolute, directory);
        const target = path === undefined ? undefined : targets.get(`${root.repositoryId}\0${path}`);
        if (target !== undefined) return target;
      }
    }
    return undefined;
  };
  const matchSuffix = (absolute: string): Target | undefined => {
    const listed = suffixes.get(lastTwo(absolute)) ?? [];
    // Many changed files that end the same way cannot be told apart by a suffix anyway: not guessed, and not scanned (a hostile report would make it a scan per name).
    if (listed.length > SUFFIX_CANDIDATES_MAX) return undefined;
    const matches = listed.filter((target) => absolute.endsWith(`/${target.path}`));
    const best = matches[0];
    // Two different files that fit equally well are not told apart.
    return best === undefined || matches.some((other) => other !== best && other.path.length === best.path.length) ? undefined : best;
  };
  for (const [name, lines] of parsed.files) {
    // Names the report itself makes absolute (an absolute file name, or a name under an absolute `<source>`) may be paths on another machine; names made absolute by this machine's own directories are exact or nothing.
    // A name with no `.` or `..` segment is joined by concatenation (a path resolve per name and source was most of the time a big report cost).
    const plainName = !isAbsolute(name) && !/(^|[\\/])\.{1,2}([\\/]|$)/u.test(name) && !name.includes("\\");
    const foreign = isAbsolute(name) ? [normalize(name)] : absoluteSources.map((source) => (plainName ? `${source.endsWith(sep) ? source : `${source}${sep}`}${name}` : resolve(source, name)));
    const local = isAbsolute(name) ? [] : [...relativeSources.flatMap((source) => bases.map((base) => resolve(base, source, name))), ...bases.map((base) => resolve(base, name))];
    let target: Target | undefined;
    for (const absolute of [...foreign, ...local]) {
      target = matchExact(absolute);
      if (target !== undefined) break;
    }
    // Every foreign address of one name ends the same way, so when no changed file (or too many) ends like the name, none of them can match by suffix: the loop is skipped whole.
    // (A one-segment name ends differently under each source, so it is not skipped this way.)
    const sameEnding = foreign.length > 0 && name.split(/[\\/]/u).length >= 2;
    const candidates = foreign.length === 0 ? 0 : (suffixes.get(lastTwo(foreign[0]!))?.length ?? 0);
    if (target === undefined && foreign.length > 0 && (!sameEnding || (candidates > 0 && candidates <= SUFFIX_CANDIDATES_MAX))) {
      for (const absolute of foreign) {
        const posixPath = posix(absolute);
        if (posixPath.startsWith("/") && !roots.some((root) => root.directories.some((directory) => withinDirectory(absolute, directory) !== undefined))) {
          target = matchSuffix(posixPath);
          if (target !== undefined) break;
        }
      }
    }
    if (target === undefined) continue;
    const merged = byTarget.get(target) ?? new Map<number, boolean>();
    for (const [line, covered] of lines) merged.set(line, (merged.get(line) ?? false) || covered);
    byTarget.set(target, merged);
  }
  const files: ChangedCoverageFile[] = [];
  for (const [target, lines] of byTarget) {
    const measured = [...target.lines].filter((line) => lines.has(line)).sort((left, right) => left - right);
    if (measured.length === 0) continue;
    const uncovered = measured.filter((line) => lines.get(line) !== true);
    files.push({ repositoryId: target.repositoryId, path: target.path, changed: measured.length, covered: measured.length - uncovered.length, uncovered });
  }
  files.sort((left, right) => right.uncovered.length - left.uncovered.length || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  // A changed source file the report never named (a new module no test imports is absent from most tools' reports): counted apart, never dropped. A file the report names but lists none of the changed lines of is
  // named, so it is not here; a file the diff could not place (a type change, a binary patch) cannot be measured at all and is counted too.
  const named = new Set<string>();
  for (const target of byTarget.keys()) named.add(`${target.repositoryId}\0${target.path}`);
  let unlistedFiles = 0;
  for (const repository of context.repositories) {
    for (const change of repository.changes) {
      if (!SOURCE_EXTENSION.test(change.path) || isTestPath(change.path)) continue;
      const placed = (change.status === "ADDED" || change.status === "MODIFIED") && change.hunks.length > 0;
      if ((placed || change.status === "UNPLACEABLE") && !named.has(`${repository.repositoryId}\0${change.path}`)) unlistedFiles += 1;
    }
  }
  return { linesChanged: files.reduce((sum, file) => sum + file.changed, 0), linesCovered: files.reduce((sum, file) => sum + file.covered, 0), files, unlistedFiles };
}

/** The evidence's coverage part: files with uncovered lines first, then those fully covered, bounded as the pack's schema is. A path names its repository when the task has more than one. */
export function coveragePart(coverage: ChangedCoverage, repositoryCount: number): NonNullable<EvidenceRaw["checks"][number]["coverage"]> {
  return {
    linesChanged: coverage.linesChanged,
    linesCovered: coverage.linesCovered,
    ...(coverage.unlistedFiles > 0 ? { unlistedFiles: coverage.unlistedFiles } : {}),
    files: coverage.files.slice(0, EVIDENCE_COVERAGE_FILES_MAX).map((file) => ({
      path: plainPath(repositoryCount > 1 ? `${file.repositoryId}/${file.path}` : file.path),
      uncovered: file.uncovered.slice(0, EVIDENCE_UNCOVERED_LINES_MAX),
    })),
  };
}

/** A path as one plain line (control and format characters become spaces) and cut to the schema's length. */
export function plainPath(path: string, max = 500): string {
  const line = path.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return Array.from(line === "" ? "file" : line).slice(0, max).join("");
}

// ---- reading it all

export type CoverageSkip = ReportFileFailure | "no_spec" | "unparsable" | "changes_unreadable";
export interface ReadCoverageInput {
  rootPath: string;
  command: ProjectCommand;
  /** The diff of every repository, read only once a report has been found and parsed; undefined when any repository's diff cannot be read (no line is then claimed). */
  repositories: () => Promise<readonly RepositoryChanges[] | undefined>;
  /** When the check round began: a report older than this was not written by this round's checks. */
  notBeforeMs: number | undefined;
  /** The real paths of reports already used by an earlier check of the round (one file is the evidence of one check). */
  used: Set<string>;
  /** The `coveragePath` the maintainer approved for this check (relative to the check's directory). */
  approvedPath?: string | undefined;
  /** Places a Go cover profile or a JaCoCo report in the repository the check runs in (`line-coverage-join.ts`); absent: those formats are not read. */
  lineCoverage?: ((text: string, repositories: readonly RepositoryChanges[]) => Promise<ParsedCoverage | undefined>) | undefined;
  /** Overrides for tests: the file size cap (default `COVERAGE_REPORT_MAX_BYTES`) and the parse limits. */
  maxBytes?: number;
  limits?: CoverageLimits;
}

/** The changed-line coverage of the report a command's tool wrote in this round, or why there is none. Never throws. */
export async function readChangedCoverage(input: ReadCoverageInput): Promise<{ coverage: ChangedCoverage } | { skip: CoverageSkip }> {
  try {
    const specs = coverageSpecsOf(input.command, input.approvedPath);
    if (specs.length === 0) return { skip: "no_spec" };
    let last: CoverageSkip = "missing";
    for (const spec of specs) {
      const read = await readContainedReport({ root: input.rootPath, cwd: input.command.cwd, argument: spec.argument, maxBytes: input.maxBytes ?? COVERAGE_REPORT_MAX_BYTES, notBeforeMs: input.notBeforeMs });
      if (!read.ok) {
        last = read.reason;
        continue;
      }
      if (input.used.has(read.path)) {
        last = "missing";
        continue;
      }
      const text = read.bytes.toString("utf8");
      // The diff is read at most once, and only for a report that parsed (Go and JaCoCo are placed with the repository's files, so they need it first).
      let changes: readonly RepositoryChanges[] | undefined;
      let changesRead = false;
      const diffs = async () => { if (!changesRead) { changes = await input.repositories(); changesRead = true; } return changes; };
      let parsed: ParsedCoverage | undefined;
      if (spec.format === "cobertura") parsed = parseCobertura(text, input.limits);
      else if (spec.format === "lcov") parsed = parseLcov(text, input.limits);
      else {
        // The approved path: the format its name says first, then what its content is (Cobertura and JaCoCo are both `.xml`; a Go cover profile has any name).
        const lcovName = /\.(?:info|lcov)$/iu.test(spec.argument);
        parsed = lcovName ? parseLcov(text, input.limits) : parseCobertura(text, input.limits);
        if (parsed === undefined && input.lineCoverage !== undefined) {
          const repositories = await diffs();
          parsed = repositories === undefined ? undefined : await input.lineCoverage(text, repositories);
        }
      }
      if (parsed === undefined) {
        last = "unparsable";
        continue;
      }
      const cwd = resolve(input.rootPath, input.command.cwd);
      const repositories = await diffs();
      const coverage = repositories === undefined ? undefined : await intersectCoverage(parsed, { repositories, bases: [cwd, resolve(input.rootPath)] });
      if (coverage === undefined) return { skip: "changes_unreadable" };
      input.used.add(read.path);
      return { coverage };
    }
    return { skip: last };
  } catch {
    return { skip: "unparsable" };
  }
}
