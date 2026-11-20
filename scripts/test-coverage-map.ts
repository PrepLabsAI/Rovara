// #1211: which tests only re-run lines other tests already cover. Three commands:
//   collect <out-dir> [--skip <ids.json>] <test files…>  runs vitest with tests/support/coverage-map-setup.ts, one record of product-code coverage per test
//   reduce <dir> [--keep tests/support/coverage-keep.json] [--json <out>] [--markdown <out>]
//                                                         finds a smallest set of tests that covers everything the whole set covers (greedy set cover over
//                                                         executed code blocks, which also covers every line); every other test is REDUNDANT
//   compare <dir-a> <dir-b>                               the product lines and blocks covered in each run, and whether they are the same
// A test is only ever redundant when every block it executes, in every module, is executed by a kept test: removing the redundant tests together keeps
// line and block coverage of the whole area exactly as it was (`compare` checks that by running the area again with them skipped). Tests that execute no
// in-process product code (they spawn a CLI, read a file, test a helper) are listed separately, never as redundant: per-test coverage can't see them.
// Node runs this file directly.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TestRecord { id: string; file: string; concurrent: boolean; failed?: boolean; scripts: Record<string, { h: string; iv: Array<[number, number]> }> }
export interface KeepRules { files?: string[]; titles?: string[] }

/** Reads every record the setup file wrote; a test id seen twice (an `it.each` with a fixed title) gets `#2`, `#3`. */
export function readRecords(directory: string): TestRecord[] {
  const records: TestRecord[] = [];
  const seen = new Map<string, number>();
  for (const name of readdirSync(directory).filter((entry) => entry.startsWith("records-") && entry.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line) as TestRecord;
      const count = (seen.get(record.id) ?? 0) + 1;
      seen.set(record.id, count);
      records.push(count === 1 ? record : { ...record, id: `${record.id} #${String(count)}` });
    }
  }
  return records;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes a source map's `mappings` into, per generated line, [generated column, original line] pairs (one source per vitest transform). */
export function decodeMappings(mappings: string): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = [];
  let originalLine = 0;
  for (const lineText of mappings.split(";")) {
    const segments: Array<[number, number]> = [];
    let column = 0;
    for (const segment of lineText.split(",")) {
      if (segment === "") continue;
      const values: number[] = [];
      let value = 0, shift = 0;
      for (const char of segment) {
        const digit = BASE64.indexOf(char);
        if (digit < 0) throw new Error(`bad source map character ${char}`);
        value += (digit & 31) << shift;
        if ((digit & 32) !== 0) { shift += 5; continue; }
        values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
        value = 0; shift = 0;
      }
      column += values[0] ?? 0;
      if (values.length >= 4) {
        originalLine += values[2]!;
        segments.push([column, originalLine + 1]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** For one transformed script: sorted generated offsets, each with the 1-based TypeScript line it came from. */
export function offsetLines(source: string): Array<[number, number]> {
  const match = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/mu.exec(source);
  if (match === null) return [];
  const map = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as { mappings: string };
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) if (source.charCodeAt(index) === 10) lineStarts.push(index + 1);
  const result: Array<[number, number]> = [];
  decodeMappings(map.mappings).forEach((segments, line) => {
    for (const [column, original] of segments) result.push([(lineStarts[line] ?? 0) + column, original]);
  });
  return result.sort((a, b) => a[0] - b[0]);
}

export interface Coverage { blocks: Map<string, Set<number>>; lines: Map<string, Set<number>>; perTest: Map<string, Set<number>>; module: Map<string, string>; zero: string[] }

/**
 * Splits each script into atomic blocks at every interval boundary any test reported, so that two tests running the same code produce the same block ids
 * however V8 happened to group their ranges. Returns, per test, the ids of the blocks it executed (an id is global across scripts), and the lines.
 */
export function buildCoverage(records: readonly TestRecord[], linesOf: (hash: string) => Array<[number, number]>): Coverage {
  const boundaries = new Map<string, number[]>();
  for (const record of records) {
    for (const [url, { h, iv }] of Object.entries(record.scripts)) {
      const key = `${url}@${h}`;
      const list = boundaries.get(key) ?? [];
      for (const [start, end] of iv) list.push(start, end);
      boundaries.set(key, list);
    }
  }
  const blockBase = new Map<string, number>();
  const sortedBounds = new Map<string, number[]>();
  let next = 0;
  for (const [key, list] of [...boundaries.entries()].sort()) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    sortedBounds.set(key, sorted);
    blockBase.set(key, next);
    next += Math.max(sorted.length - 1, 0);
  }
  const blockLines = new Map<number, { url: string; lines: number[] }>();
  for (const [key, sorted] of sortedBounds) {
    const at = key.lastIndexOf("@");
    const url = key.slice(0, at), offsets = linesOf(key.slice(at + 1));
    const base = blockBase.get(key)!;
    let pointer = 0;
    for (let index = 0; index + 1 < sorted.length; index++) {
      const start = sorted[index]!, end = sorted[index + 1]!;
      while (pointer < offsets.length && offsets[pointer]![0] < start) pointer++;
      const lines = new Set<number>();
      for (let scan = pointer; scan < offsets.length && offsets[scan]![0] < end; scan++) lines.add(offsets[scan]![1]);
      blockLines.set(base + index, { url, lines: [...lines] });
    }
  }
  const perTest = new Map<string, Set<number>>(), module = new Map<string, string>(), blocks = new Map<string, Set<number>>(), lines = new Map<string, Set<number>>();
  const zero: string[] = [];
  for (const record of records) {
    const executed = new Set<number>();
    const linesPerUrl = new Map<string, number>();
    for (const [url, { h, iv }] of Object.entries(record.scripts)) {
      const key = `${url}@${h}`;
      const sorted = sortedBounds.get(key)!, base = blockBase.get(key)!;
      for (const [start, end] of iv) {
        let index = lowerBound(sorted, start);
        for (; index + 1 < sorted.length && sorted[index]! < end; index++) {
          executed.add(base + index);
          const info = blockLines.get(base + index)!;
          linesPerUrl.set(url, (linesPerUrl.get(url) ?? 0) + info.lines.length);
          const urlBlocks = blocks.get(url) ?? new Set<number>(); urlBlocks.add(base + index); blocks.set(url, urlBlocks);
          const urlLines = lines.get(url) ?? new Set<number>(); for (const line of info.lines) urlLines.add(line); lines.set(url, urlLines);
        }
      }
    }
    if (executed.size === 0) zero.push(record.id);
    perTest.set(record.id, executed);
    const top = [...linesPerUrl.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    module.set(record.id, top?.[0] ?? "(no product code)");
  }
  return { blocks, lines, perTest, module, zero };
}

function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0, high = sorted.length;
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid]! < value) low = mid + 1; else high = mid; }
  return low;
}

/** A glob with `*` only (any run of characters), matched against the whole string. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

export interface Reduction { kept: string[]; redundant: Array<{ id: string; coveredBy: string[]; tableCase?: boolean }>; forced: string[] }

/**
 * Whether a redundant test looks like another case of the same table (an `it.each` or a loop over inputs) as a test that covers it: the same file and
 * suites, and titles that differ only in a short middle part (the input). Those run the same lines with a different input, so line coverage alone can't
 * say the input doesn't matter (an entry in a list, a pattern in a regex); the owner decides on them.
 */
export function isTableCase(redundant: string, covering: readonly string[]): boolean {
  const parts = redundant.split(" > ");
  const title = parts[parts.length - 1]!, scope = parts.slice(0, -1).join(" > ");
  return covering.some((other) => {
    const otherParts = other.split(" > ");
    if (otherParts.slice(0, -1).join(" > ") !== scope) return false;
    const otherTitle = otherParts[otherParts.length - 1]!;
    let prefix = 0;
    while (prefix < title.length && prefix < otherTitle.length && title[prefix] === otherTitle[prefix]) prefix++;
    let suffix = 0;
    while (suffix < title.length - prefix && suffix < otherTitle.length - prefix && title[title.length - 1 - suffix] === otherTitle[otherTitle.length - 1 - suffix]) suffix++;
    return prefix + suffix >= 0.6 * Math.min(title.length, otherTitle.length);
  });
}

/**
 * Greedy set cover: the tests the keep rules name (and concurrent tests, whose coverage can't be told apart) are kept first; then, repeatedly, the test
 * adding the most not-yet-covered blocks (ties: the earlier test); a test that adds nothing is redundant. Each redundant test is listed with the kept tests
 * that together cover all of its blocks (the fewest found greedily). Tests with no product blocks are not considered here.
 */
export function reduce(order: readonly string[], perTest: ReadonlyMap<string, Set<number>>, forcedKeep: ReadonlySet<string>): Reduction {
  const covered = new Set<number>();
  const kept: string[] = [], forced: string[] = [];
  const candidates = order.filter((id) => (perTest.get(id)?.size ?? 0) > 0);
  for (const id of candidates) if (forcedKeep.has(id)) { kept.push(id); forced.push(id); for (const block of perTest.get(id)!) covered.add(block); }
  let remaining = candidates.filter((id) => !forcedKeep.has(id));
  for (;;) {
    let best: string | undefined, bestGain = 0;
    for (const id of remaining) {
      let gain = 0;
      for (const block of perTest.get(id)!) if (!covered.has(block)) gain++;
      if (gain > bestGain) { best = id; bestGain = gain; }
    }
    if (best === undefined) break;
    kept.push(best);
    for (const block of perTest.get(best)!) covered.add(block);
    remaining = remaining.filter((id) => id !== best);
  }
  const redundant = remaining.map((id) => {
    const need = new Set(perTest.get(id));
    const coveredBy: string[] = [];
    while (need.size > 0) {
      let best: string | undefined, bestHit = 0;
      for (const keptId of kept) {
        let hit = 0;
        for (const block of perTest.get(keptId)!) if (need.has(block)) hit++;
        if (hit > bestHit) { best = keptId; bestHit = hit; }
      }
      if (best === undefined) break;
      coveredBy.push(best);
      for (const block of perTest.get(best)!) need.delete(block);
    }
    return { id, coveredBy, ...(isTableCase(id, coveredBy) ? { tableCase: true } : {}) };
  });
  return { kept, redundant, forced };
}

function sourceReader(directory: string): (hash: string) => Array<[number, number]> {
  const cache = new Map<string, Array<[number, number]>>();
  return (hash) => {
    let value = cache.get(hash);
    if (value === undefined) {
      const path = join(directory, "sources", `${hash}.js`);
      value = existsSync(path) ? offsetLines(readFileSync(path, "utf8")) : [];
      cache.set(hash, value);
    }
    return value;
  };
}

function totals(coverage: Coverage): { lines: number; blocks: number; lineSet: Set<string> } {
  const lineSet = new Set<string>(), blockSet = new Set<number>();
  for (const [url, set] of coverage.lines) for (const line of set) lineSet.add(`${url}:${String(line)}`);
  for (const set of coverage.blocks.values()) for (const block of set) blockSet.add(block);
  return { lines: lineSet.size, blocks: blockSet.size, lineSet };
}

function readKeep(path: string | undefined): KeepRules {
  if (path === undefined || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as KeepRules;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "collect") {
    const out = rest.shift();
    const skip = option(rest, "--skip");
    if (out === undefined || rest.length === 0) { console.error("usage: collect <out-dir> [--skip ids.json] <test files…>"); return 2; }
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const started = Date.now();
    const run = spawnSync("npx", ["vitest", "run", "--config", "vitest.coverage-map.config.ts", ...rest], {
      stdio: "inherit", env: { ...process.env, COVMAP_DIR: out, ...(skip === undefined ? {} : { COVMAP_SKIP: skip }) },
    });
    console.log(`collect: ${String(readRecords(out).length)} test records in ${((Date.now() - started) / 60000).toFixed(1)} min (vitest exit ${String(run.status)})`);
    return run.status ?? 1;
  }
  if (command === "reduce") {
    const directory = rest.shift();
    const keepPath = option(rest, "--keep") ?? "tests/support/coverage-keep.json";
    const jsonOut = option(rest, "--json"), markdownOut = option(rest, "--markdown");
    if (directory === undefined) { console.error("usage: reduce <dir> [--keep file] [--json out] [--markdown out]"); return 2; }
    const records = readRecords(directory);
    const coverage = buildCoverage(records, sourceReader(directory));
    const keep = readKeep(keepPath);
    const forcedKeep = new Set(records.filter((record) => record.concurrent || record.failed === true
      || (keep.files ?? []).some((glob) => globMatch(glob, record.file))
      || (keep.titles ?? []).some((glob) => globMatch(glob, record.id))).map((record) => record.id));
    const order = records.map((record) => record.id);
    const result = reduce(order, coverage.perTest, forcedKeep);
    const all = totals(coverage);
    const keptBlocks = new Set<number>();
    for (const id of result.kept) for (const block of coverage.perTest.get(id)!) keptBlocks.add(block);
    const perModule = new Map<string, { before: number; after: number; redundant: number }>();
    for (const record of records) {
      if (coverage.zero.includes(record.id)) continue;
      const entry = perModule.get(coverage.module.get(record.id)!) ?? { before: 0, after: 0, redundant: 0 };
      entry.before++;
      perModule.set(coverage.module.get(record.id)!, entry);
    }
    const redundantIds = new Set(result.redundant.map((entry) => entry.id));
    for (const [id, moduleUrl] of coverage.module) {
      const entry = perModule.get(moduleUrl);
      if (entry === undefined) continue;
      if (redundantIds.has(id)) entry.redundant++; else if (!coverage.zero.includes(id)) entry.after++;
    }
    const files = new Set(records.map((record) => record.file));
    const summary = {
      testFiles: files.size, tests: records.length, withProductCode: records.length - coverage.zero.length, noProductCode: coverage.zero.length,
      kept: result.kept.length, forcedKept: result.forced.length, redundant: result.redundant.length,
      redundantTableCases: result.redundant.filter((entry) => entry.tableCase === true).length,
      failedUnderCoverage: records.filter((record) => record.failed === true).length,
      productLines: all.lines, productBlocks: all.blocks, blocksCoveredByKept: keptBlocks.size,
    };
    const modules = [...perModule.entries()].map(([url, entry]) => ({ module: url, ...entry })).sort((a, b) => b.redundant - a.redundant || b.before - a.before);
    if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify({ summary, modules, redundant: result.redundant, noProductCode: coverage.zero, forcedKept: result.forced }, null, 2)}\n`);
    if (markdownOut !== undefined) {
      const lines = [`# Redundant tests (#1211)`, "", "```json", JSON.stringify(summary, null, 2), "```", "", "| module | tests | kept | redundant |", "|---|---|---|---|",
        ...modules.map((entry) => `| ${entry.module} | ${String(entry.before)} | ${String(entry.after)} | ${String(entry.redundant)} |`), "",
        ...[...groupBy(result.redundant, (entry) => entry.id.split(" > ")[0]!)].flatMap(([file, entries]) => [`## ${file}`, ...entries.map((entry) =>
          `- ${entry.tableCase === true ? "[same lines, different input] " : ""}${entry.id.split(" > ").slice(1).join(" > ")}  \n  covered by: ${entry.coveredBy.map((id) => `\`${id}\``).join(", ")}`), ""])];
      writeFileSync(markdownOut, `${lines.join("\n")}\n`);
    }
    console.log(JSON.stringify(summary, null, 2));
    return keptBlocks.size === all.blocks ? 0 : 1;
  }
  if (command === "compare") {
    const [left, right] = rest;
    if (left === undefined || right === undefined) { console.error("usage: compare <dir-a> <dir-b>"); return 2; }
    const a = totals(buildCoverage(readRecords(left), sourceReader(left))), b = totals(buildCoverage(readRecords(right), sourceReader(right)));
    const missing = [...a.lineSet].filter((line) => !b.lineSet.has(line));
    const extra = [...b.lineSet].filter((line) => !a.lineSet.has(line));
    console.log(JSON.stringify({ linesA: a.lines, linesB: b.lines, missingInB: missing.length, extraInB: extra.length, sampleMissing: missing.slice(0, 20) }, null, 2));
    return missing.length === 0 ? 0 : 1;
  }
  console.error("usage: test-coverage-map.ts collect|reduce|compare …");
  return 2;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) { const k = key(item); const list = map.get(k) ?? []; list.push(item); map.set(k, list); }
  return map;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) process.exitCode = main(process.argv.slice(2));
