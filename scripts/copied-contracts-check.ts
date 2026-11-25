// E1-0, check 1 (arch rule 4): no NEW copied contract file. A ratchet that only goes down.
//
// "Copied" means one of four things, each read from what the existing copies look like today (the list is in scripts/copied-contracts-baseline.json):
//   shared  a file under contracts/shared/: a wire format both repositories hold byte for byte (the JSON schema, its fixtures, its hash pins);
//   marked  a source file whose leading comment says it is a copy of, or is copied to, Cloud, or "canonical in Code and Cloud", or names "Cloud's copy / mirror";
//   pinned  a contract source file whose bytes are pinned by sha256 in a contracts/shared/*.sha256.json file, or by a test that says in the same few lines that the file is
//           shared, mirrored or Cloud's (the pin is how Cloud's copy is compared with it; a plain frozen-interface hash with no such word is not a copy);
//   twin    two production source files in two DIFFERENT packages with the same text once comments, blank lines and import lines are left out (a copy that only had its import
//           paths changed), at least TWIN_MIN_LINES lines long.
// The baseline lists every path that is a copy today. A path that is a copy and is NOT in the baseline fails ("do not copy a contract: import it from packages/contracts, or ask
// for a decision line"). A path that is in the baseline and no longer a copy (deleted, or the copy marker removed) passes; `shrink` drops it from the baseline and never adds one.
// This check sees Code only. A file added to Cloud's `packages/contracts` copy is Cloud's own ratchet (the same rule, in Cloud's tree).
//
// Usage, from the repository root:  node scripts/copied-contracts-check.ts check | shrink
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CopyKind = "shared" | "marked" | "pinned" | "twin";
/** A path that is a copy, with every reason it is one. */
export type CopyMap = Record<string, CopyKind[]>;

export const BASELINE_PATH = "scripts/copied-contracts-baseline.json";
export const TWIN_MIN_LINES = 20;
/** The leading comment of a file is read up to this many lines for a copy marker. */
const LEADING_COMMENT_MAX_LINES = 30;
const MARKER = /canonical in Code and Cloud|cop(?:ied|y|ies) (?:from|to|of) (?:the )?Cloud|byte-identical to Cloud|Cloud(?:'|’)s (?:contracts )?(?:copy|mirror)/iu;
const SKIPPED = new Set(["node_modules", "dist", "cdk.out", ".release-synth", ".git"]);

function walk(root: string, directory: string, keep: (path: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, directory));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (SKIPPED.has(name)) continue;
    const path = `${directory}/${name}`;
    if (statSync(join(root, path)).isDirectory()) found.push(...walk(root, path, keep));
    else if (keep(path)) found.push(path);
  }
  return found.sort();
}

const isProductionSource = (path: string): boolean => path.endsWith(".ts") && !path.endsWith(".d.ts") && !/\.(test|spec)\.ts$/u.test(path) && !/\/(fixtures?|__snapshots__)\//u.test(path);

/** The package a path under `packages/<name>/src/` belongs to (the part after `packages/`), or undefined. */
export function packageOf(path: string): string | undefined {
  return /^packages\/([^/]+)\/src\//u.exec(path)?.[1];
}

/** The leading comment block of a source text: every comment line from the top, up to LEADING_COMMENT_MAX_LINES. */
export function leadingComment(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n").slice(0, LEADING_COMMENT_MAX_LINES)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) lines.push(trimmed);
    else break;
  }
  return lines.join("\n");
}

export function isMarkedCopy(text: string): boolean {
  return MARKER.test(leadingComment(text));
}

const isImportLine = (line: string): boolean => /^import\b/u.test(line) || /^export\b.*\bfrom\s+["']/u.test(line) || /^\}?\s*from\s+["']/u.test(line);

/** The text with comments, blank lines and import / re-export lines left out, so a copy that only changed its import paths still matches. */
export function normalisedSource(text: string): string[] {
  const lines: string[] = [];
  let inBlockComment = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) inBlockComment = !line.includes("*/");
    else if (line.startsWith("/*")) inBlockComment = !line.includes("*/");
    else if (line !== "" && !line.startsWith("//") && !isImportLine(line)) lines.push(line);
  }
  return lines;
}

/** The repository paths under packages/contracts/src a test (or a hash-pin file) pins by sha256. */
export function pinnedPaths(root: string): Set<string> {
  const pinned = new Set<string>();
  const pinSource = /packages\/contracts\/src\/[\w./-]+\.ts/gu;
  for (const file of walk(root, "tests", (path) => path.endsWith(".ts"))) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pinSource)) {
        const near = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
        if (/createHash|sha256/u.test(near) && /mirror|shared|\bCloud\b|cop(?:y|ied)/iu.test(near)) pinned.add(match[0]);
      }
    });
  }
  for (const file of walk(root, "contracts/shared", (path) => path.endsWith(".sha256.json"))) {
    for (const key of Object.keys(JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, string>)) {
      if (/^packages\/contracts\/src\//u.test(key) && key.endsWith(".ts")) pinned.add(key);
    }
  }
  return pinned;
}

function add(copies: CopyMap, path: string, kind: CopyKind): void {
  const kinds = (copies[path] ??= []);
  if (!kinds.includes(kind)) kinds.push(kind);
}

/** The paths that are twins: the same normalised text (long enough) in two or more different packages. */
export function twinPaths(texts: ReadonlyMap<string, string>): string[] {
  const byBody = new Map<string, string[]>();
  for (const [path, text] of texts) {
    const body = normalisedSource(text);
    if (body.length >= TWIN_MIN_LINES) byBody.set(body.join("\n"), [...(byBody.get(body.join("\n")) ?? []), path]);
  }
  return [...byBody.values()].filter((paths) => new Set(paths.map((path) => packageOf(path))).size >= 2).flat();
}

export function scanRepository(root: string): CopyMap {
  const copies: CopyMap = {};
  for (const path of walk(root, "contracts/shared", () => true)) add(copies, path, "shared");
  const texts = new Map<string, string>();
  for (const path of walk(root, "packages", (candidate) => packageOf(candidate) !== undefined && isProductionSource(candidate))) texts.set(path, readFileSync(join(root, path), "utf8"));
  for (const [path, text] of texts) if (isMarkedCopy(text)) add(copies, path, "marked");
  for (const path of pinnedPaths(root)) if (texts.has(path)) add(copies, path, "pinned");
  for (const path of twinPaths(texts)) add(copies, path, "twin");
  return Object.fromEntries(Object.entries(copies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface Comparison { added: string[]; removed: string[] }

/** `added`: a path that is a copy now and is not in the baseline. `removed`: in the baseline and no longer a copy. */
export function compareToBaseline(scan: CopyMap, baseline: CopyMap): Comparison {
  return {
    added: Object.keys(scan).filter((path) => !(path in baseline)),
    removed: Object.keys(baseline).filter((path) => !(path in scan)),
  };
}

export function describeAdded(scan: CopyMap, added: readonly string[]): string[] {
  return added.map((path) => `${path} is a new copied contract file (${(scan[path] ?? []).join(", ")}): import the contract from packages/contracts instead of copying it, or ask the controller for a decision line (rule 4)`);
}

/** The baseline with every path that is no longer a copy taken out; nothing is ever added. */
export function shrunkBaseline(scan: CopyMap, baseline: CopyMap): CopyMap {
  return Object.fromEntries(Object.entries(baseline).filter(([path]) => path in scan));
}

export function readBaseline(root: string): CopyMap {
  return JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8")) as CopyMap;
}

export function formatBaseline(copies: CopyMap): string {
  return `${JSON.stringify(copies, null, 2)}\n`;
}

function main(): void {
  const mode = process.argv[2];
  const root = process.cwd();
  const scan = scanRepository(root);
  const baseline = readBaseline(root);
  const { added, removed } = compareToBaseline(scan, baseline);
  if (mode === "shrink") {
    if (added.length > 0) throw new Error(`a new copy exists; fix it, the baseline never grows:\n${describeAdded(scan, added).join("\n")}`);
    writeFileSync(join(root, BASELINE_PATH), formatBaseline(shrunkBaseline(scan, baseline)));
    process.stdout.write(`${removed.length} paths dropped from ${BASELINE_PATH}\n`);
    return;
  }
  if (added.length > 0) {
    process.stderr.write(`${describeAdded(scan, added).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`copied contracts pass (${Object.keys(scan).length} copies)${removed.length > 0 ? `; ${removed.length} are no longer copies, run: node scripts/copied-contracts-check.ts shrink` : ""}\n`);
}

if (process.argv[1]?.endsWith("copied-contracts-check.ts")) main();
