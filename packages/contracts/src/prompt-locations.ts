// L4-EVP: where a project's AI prompts live INSIDE code (a system prompt kept as a string in agent.py, a persona in a YAML key), so a change to one asks for the eval even though its path is not named like a prompt.
//
// The setup agent PROPOSES these (files plus a function, variable, decorator or YAML key), a maintainer confirms them as part of the approved setup (they are a field of the project's setup revision, read at
// the task's starting revision), and from then on they are plain data: NO model is asked at task time. Two readers use the same rules:
//   - the broker's change tier reads a changed FILE against them (file level: it sees a patch, not the file), and asks for the eval when one matches (`eval_hint`);
//   - the worker's changed-prompt classifier reads both sides of a changed file and, for Python and YAML where the region can be found whole, compares the REGION (region level). Any region that cannot be found on
//     either side, or a language this module does not read, falls back to the file: a change to the file counts as touching the location. A region is called untouched only when both sides' regions were found whole and are equal; known blind spots of a text reader (a value built from another name, a YAML alias) are narrowed by returning "no region" where they can be seen, and are otherwise the project's to cover by naming the whole file.
// Fixed words only; nothing from a file is echoed into a message.
import { z } from "zod";
import { AgentXNameSchema } from "./names.js";
import { RelativeWorkspacePathSchema } from "./project.js";

/** A CHECKS run that asks for the eval is sent the project's prompt locations (`evalPromptLocations`) only to a worker whose /ping lists this; the dispatcher drops the field for an older worker (the eval then runs as before: the AI-related walk still decides which calls count as changed). */
export const EVAL_PROMPT_LOCATIONS_FEATURE = "task.evalPromptLocations.v1" as const;
/** At most this many locations in one project's setup. */
export const PROMPT_LOCATIONS_MAX = 40;
export const PROMPT_LOCATION_KINDS = ["file", "function", "variable", "decorator", "yaml_key"] as const;
export type PromptLocationKind = (typeof PROMPT_LOCATION_KINDS)[number];
/** An identifier, or a dotted path of them (`Agent.system_prompt`, `agents.support.system_prompt`). */
export const PROMPT_SYMBOL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}(?:\.[A-Za-z_$][A-Za-z0-9_$-]{0,63}){0,5}$/u;

export const PromptLocationSchema = z.object({
  /** The repository's name in the project. */
  repo: AgentXNameSchema,
  /** The tracked file that holds the prompt, inside that repository. */
  path: RelativeWorkspacePathSchema.refine((path) => path.split("/")[0] !== ".git" && !/[\p{Cc}\p{Cf}]/u.test(path), "not a file path Rovara reads"),
  /** `file`: the whole file is the prompt. The others name a region of it by `symbol`. */
  kind: z.enum(PROMPT_LOCATION_KINDS),
  symbol: z.string().regex(PROMPT_SYMBOL_PATTERN).optional(),
}).strict().refine((location) => (location.kind === "file") === (location.symbol === undefined), "a file location has no symbol and every other kind names one");
export type PromptLocation = z.infer<typeof PromptLocationSchema>;

export const promptLocationKey = (location: PromptLocation): string => `${location.repo}\u0000${location.path}\u0000${location.kind}\u0000${location.symbol ?? ""}`;

/** The stored setting: unique locations, at most `PROMPT_LOCATIONS_MAX`. */
export const PromptLocationsSchema = z.array(PromptLocationSchema).max(PROMPT_LOCATIONS_MAX).superRefine((locations, context) => {
  const seen = new Set<string>();
  for (const [index, location] of locations.entries()) {
    const key = promptLocationKey(location);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "prompt locations are unique" });
    seen.add(key);
  }
});

/** A stored or sent value read at run time. Anything that does not check is NO location (never a partial list). */
export function promptLocationsOf(raw: unknown): PromptLocation[] {
  if (raw === undefined) return [];
  const parsed = PromptLocationsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** The locations a changed file may be in. A change that names no repository (`repo` undefined) matches by path alone: more hints, never fewer. */
export function promptLocationsInFile(locations: readonly PromptLocation[], file: { repo?: string | undefined; path: string }): PromptLocation[] {
  return locations.filter((location) => location.path === file.path && (file.repo === undefined || location.repo === file.repo));
}

// ---- regions (Python and YAML)

const MAX_LINES = 60_000;
/** Characters of lines one region read may visit in all (a nested file cannot make it quadratic, and a very long line costs what it is): past it the region is "not found", which counts as touched. */
const VISIT_BUDGET = 40_000_000;
class NoRegion extends Error {}
interface Budget { left: number }
const spend = (budget: Budget, n = 1): void => { budget.left -= n; if (budget.left < 0) throw new NoRegion(); };
const NO_REGION = undefined;
type Region = string | undefined;
const indentOf = (line: string): number => { let n = 0; while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1; return n; };
const blank = (line: string): boolean => line.trim() === "" || line.trim().startsWith("#");
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

interface PyScan { lines: string[]; /** The line starts inside a string or a bracket: a continuation, never the start or end of a block. */ cont: boolean[] }
/** One pass over Python text: which lines start inside a string (triple-quoted or not) or an open bracket, or after a backslash. Linear. The last text read is kept, so several locations in one file scan it once. */
const scanCache = new Map<string, PyScan | null>();
function scanPython(text: string): PyScan | undefined {
  const known = scanCache.get(text);
  if (known !== undefined) return known ?? undefined;
  const made = scanPythonOnce(text);
  if (scanCache.size >= 4) scanCache.delete(scanCache.keys().next().value as string);
  scanCache.set(text, made ?? null);
  return made;
}
function scanPythonOnce(text: string): PyScan | undefined {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.length > MAX_LINES) return undefined;
  const cont: boolean[] = [];
  let triple: string | undefined; let depth = 0; let backslash = false;
  for (const line of lines) {
    cont.push(triple !== undefined || depth > 0 || backslash);
    backslash = false;
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;
      if (triple !== undefined) {
        if (c === "\\") { i += 2; continue; }
        if (line.startsWith(triple, i)) { triple = undefined; i += 3; continue; }
        i += 1; continue;
      }
      if (c === "#") break;
      if (c === "\"" || c === "'") {
        if (line.startsWith(c.repeat(3), i)) { triple = c.repeat(3); i += 3; continue; }
        // A one-line string: skip to its end (an unterminated one ends at the line's end).
        i += 1;
        while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
        i += 1; continue;
      }
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      i += 1;
    }
    if (triple === undefined && line.endsWith("\\")) backslash = true;
  }
  return { lines, cont };
}

/** The end (exclusive) of the statement that starts at line `start`: the first line after it that does not continue it. */
function pyStatementEnd(scan: PyScan, start: number, budget: Budget): number {
  let end = start + 1;
  while (end < scan.lines.length && scan.cont[end]) { spend(budget, scan.lines[end]!.length + 1); end += 1; }
  return end;
}
/** The end (exclusive) of the block that starts at `start` (header at `start`, body indented deeper). */
function pyBlockEnd(scan: PyScan, start: number, limit: number, budget: Budget): number {
  const base = indentOf(scan.lines[start]!);
  let end = pyStatementEnd(scan, start, budget);
  for (let i = end; i < limit; i += 1) {
    spend(budget, scan.lines[i]!.length + 1);
    if (scan.cont[i] || blank(scan.lines[i]!)) { end = i + 1; continue; }
    if (indentOf(scan.lines[i]!) <= base) break;
    end = i + 1;
  }
  // Trailing blank lines and comments belong to what follows.
  while (end > start + 1 && blank(scan.lines[end - 1]!) && !scan.cont[end - 1]) end -= 1;
  return end;
}
/** Only the outermost of overlapping ranges: a region found inside another is already part of it, and keeping both makes a nested file quadratic. */
function outermost<T extends [number, number, ...number[]]>(ranges: T[]): T[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept: T[] = [];
  for (const range of sorted) { const last = kept[kept.length - 1]; if (last === undefined || range[0] >= last[1]) kept.push(range); }
  return kept;
}

function pyRegion(text: string, location: PromptLocation): Region {
  const scan = scanPython(text);
  if (scan === undefined || location.symbol === undefined) return NO_REGION;
  const budget: Budget = { left: VISIT_BUDGET };
  // A decorator is named whole (`app.tool`, `agent.system_prompt`); the others are a dotted path of classes ending in the name.
  const parts = location.kind === "decorator" ? [location.symbol] : location.symbol.split(".");
  let ranges: Array<[number, number]> = [[0, scan.lines.length]];
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const name = escapeRe(part);
    const pattern = !last ? new RegExp(String.raw`^\s*class\s+${name}\b`, "u")
      : location.kind === "function" ? new RegExp(String.raw`^\s*(?:async\s+)?def\s+${name}\s*\(`, "u")
      // An assignment of the name, a plain one or an augmented one (`X += ...` changes the value too).
      : location.kind === "variable" ? new RegExp(String.raw`^\s*(?:self\.)?${name}\s*(?::[^=\n]*)?(?:\*\*|//|<<|>>|[-+*/|&@%^])?=(?!=)`, "u")
      : new RegExp(String.raw`^\s*@${name}(?![\w.])`, "u");
    const found: Array<[number, number]> = [];
    for (const [from, to] of ranges) {
      for (let i = from; i < to; i += 1) {
        spend(budget, scan.lines[i]!.length + 1);
        if (scan.cont[i] || !pattern.test(scan.lines[i]!)) continue;
        if (!last) found.push([i, Math.min(pyBlockEnd(scan, i, to, budget), to)]);
        else if (location.kind === "variable") found.push([i, pyStatementEnd(scan, i, budget)]);
        else if (location.kind === "function") {
          // Decorators directly above the def are part of it.
          let start = i;
          while (start > from && /^\s*@/u.test(scan.lines[start - 1]!) && !scan.cont[start - 1]) { spend(budget, scan.lines[start - 1]!.length + 1); start -= 1; }
          found.push([start, pyBlockEnd(scan, i, to, budget)]);
        } else {
          // A decorator: its own lines through the block it decorates.
          let at = i;
          while (at < to && (scan.cont[at] || /^\s*@/u.test(scan.lines[at]!))) { spend(budget, scan.lines[at]!.length + 1); at += 1; }
          found.push([i, at < to ? pyBlockEnd(scan, at, to, budget) : to]);
        }
      }
    }
    if (found.length === 0) return NO_REGION;
    ranges = outermost(found);
  }
  return ranges.map(([from, to]) => scan.lines.slice(from, to).join("\n")).join("\n\u0000\n");
}

/** YAML that a line reader cannot follow whole: an alias (its value is another place's), a merge key. */
const YAML_ALIAS = /(?:^|[\s:[,{-])\*[A-Za-z0-9_-]+|^\s*<<\s*:/mu;
/** What may start the line that ends a key's block: another key, a list item, a comment, a document marker. Anything else (a quoted value continued at column 0) is a block this reader cannot bound. */
const YAML_BLOCK_END = /^\s*(?:["']?[^\s"'#:][^:]*["']?\s*:(?:\s|$)|-(?:\s|$)|#|---|\.\.\.)/u;

function yamlRegion(text: string, location: PromptLocation): Region {
  if (location.symbol === undefined) return NO_REGION;
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.length > MAX_LINES || YAML_ALIAS.test(text)) return NO_REGION;
  const budget: Budget = { left: VISIT_BUDGET };
  let ranges: Array<[number, number, number]> = [[0, lines.length, -1]];
  for (const part of location.symbol.split(".")) {
    const key = new RegExp(String.raw`^(\s*)(-\s+)?["']?${escapeRe(part)}["']?\s*:(?:\s|$)`, "u");
    const found: Array<[number, number, number]> = [];
    for (const [from, to, parentIndent] of ranges) {
      for (let i = from; i < to; i += 1) {
        spend(budget, lines[i]!.length + 1);
        const match = key.exec(lines[i]!);
        if (match === null) continue;
        const indent = (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
        if (indent <= parentIndent) continue;
        let end = i + 1;
        for (let j = i + 1; j < to; j += 1) {
          spend(budget, lines[j]!.length + 1);
          // A blank line or a comment never ends the block (a region too long is safe; one too short is not).
          if (blank(lines[j]!)) { end = j + 1; continue; }
          if (/^---(?:\s|$)/u.test(lines[j]!)) break;
          if (indentOf(lines[j]!) <= (match[1]?.length ?? 0)) { if (!YAML_BLOCK_END.test(lines[j]!)) throw new NoRegion(); break; }
          end = j + 1;
        }
        while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
        found.push([i, end, indent]);
      }
    }
    if (found.length === 0) return NO_REGION;
    ranges = outermost(found);
  }
  return ranges.map(([from, to]) => lines.slice(from, to).join("\n")).join("\n\u0000\n");
}

/** The text of the location's region in `text`, whole, or undefined when it cannot be found, the read ran out of its work bound, or this module does not read the language. Never throws. */
export function promptRegionOf(text: string, location: PromptLocation): Region {
  try {
    if (location.kind === "file" || typeof text !== "string") return NO_REGION;
    if (/\.pyi?$/u.test(location.path) && location.kind !== "yaml_key") return pyRegion(text, location);
    if (/\.ya?ml$/u.test(location.path) && location.kind === "yaml_key") return yamlRegion(text, location);
    return NO_REGION;
  } catch { return NO_REGION; }
}

/**
 * Whether a change to `path` touches the location. A different file, never. The same file: yes, unless BOTH sides' regions were found whole and are identical (region level). A file that is added or removed, a side
 * that is missing, a region that is not found on either side, or a language not read here is a touch (file level). Never throws; anything unreadable is a touch.
 */
export function promptLocationTouched(location: PromptLocation, change: { repo?: string | undefined; path: string; before?: string | undefined; after?: string | undefined }): boolean {
  try {
    if (promptLocationsInFile([location], change).length === 0) return false;
    if (location.kind === "file" || change.before === undefined || change.after === undefined) return true;
    const before = promptRegionOf(change.before, location);
    const after = promptRegionOf(change.after, location);
    return before === undefined || after === undefined || before !== after;
  } catch { return true; }
}
