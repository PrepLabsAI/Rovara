// L4-EVP: where a project's AI prompts live INSIDE code (a system prompt kept as a string in agent.py, a persona in a YAML key), so a change to one asks for the eval even though its path is not named like a prompt.
//
// The setup agent PROPOSES these (files plus a function, variable, decorator or YAML key), a maintainer confirms them as part of the approved setup (they are a field of the project's setup revision, read at
// the task's starting revision), and from then on they are plain data: NO model is asked at task time. Two readers use the same rules:
//   - the broker's change tier reads a changed FILE against them (file level: it sees a patch, not the file), and asks for the eval when one matches (`eval_hint`);
//   - the worker's changed-prompt classifier reads both sides of a changed file and, for Python and YAML where the region can be found whole, compares the REGION (region level). Any region that cannot be found on
//     either side, or a language this module does not read, falls back to the file: a change to the file counts as touching the location. A guess that a region is untouched is never made.
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
const NO_REGION = undefined;
type Region = string | undefined;
const indentOf = (line: string): number => { let n = 0; while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1; return n; };
const blank = (line: string): boolean => line.trim() === "" || line.trim().startsWith("#");

interface PyScan { lines: string[]; /** The line starts inside a string or a bracket: a continuation, never the start or end of a block. */ cont: boolean[] }
/** One pass over Python text: which lines start inside a string (triple-quoted or not) or an open bracket, or after a backslash. Linear. */
function scanPython(text: string): PyScan | undefined {
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
function pyStatementEnd(scan: PyScan, start: number): number {
  let end = start + 1;
  while (end < scan.lines.length && scan.cont[end]) end += 1;
  return end;
}
/** The end (exclusive) of the block that starts at `start` (header at `start`, body indented deeper). */
function pyBlockEnd(scan: PyScan, start: number, limit: number): number {
  const base = indentOf(scan.lines[start]!);
  let end = pyStatementEnd(scan, start);
  for (let i = end; i < limit; i += 1) {
    if (scan.cont[i] || blank(scan.lines[i]!)) { end = i + 1; continue; }
    if (indentOf(scan.lines[i]!) <= base) break;
    end = i + 1;
  }
  // Trailing blank lines and comments belong to what follows.
  while (end > start + 1 && blank(scan.lines[end - 1]!) && !scan.cont[end - 1]) end -= 1;
  return end;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function pyRegion(text: string, location: PromptLocation): Region {
  const scan = scanPython(text);
  if (scan === undefined || location.symbol === undefined) return NO_REGION;
  const parts = location.symbol.split(".");
  let ranges: Array<[number, number]> = [[0, scan.lines.length]];
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const name = escapeRe(part);
    const found: Array<[number, number]> = [];
    for (const [from, to] of ranges) {
      for (let i = from; i < to; i += 1) {
        if (scan.cont[i]) continue;
        const line = scan.lines[i]!;
        let match: RegExpExecArray | null = null;
        if (!last) match = new RegExp(String.raw`^\s*class\s+${name}\b`, "u").exec(line);
        else if (location.kind === "function") match = new RegExp(String.raw`^\s*(?:async\s+)?def\s+${name}\s*\(`, "u").exec(line);
        else if (location.kind === "variable") match = new RegExp(String.raw`^\s*(?:self\.)?${name}\s*(?::[^=\n]*)?=(?!=)`, "u").exec(line);
        else if (location.kind === "decorator") match = new RegExp(String.raw`^\s*@${name}\b`, "u").exec(line);
        if (match === null) continue;
        if (!last || location.kind === "variable") {
          const end = last ? pyStatementEnd(scan, i) : pyBlockEnd(scan, i, to);
          found.push([i, last ? end : Math.min(end, to)]);
        } else if (location.kind === "function") {
          // Decorators directly above the def are part of it.
          let start = i;
          while (start > from && /^\s*@/u.test(scan.lines[start - 1]!) && !scan.cont[start - 1]) start -= 1;
          found.push([start, pyBlockEnd(scan, i, to)]);
        } else {
          // A decorator: its own lines through the block it decorates.
          let at = i;
          while (at < to && (scan.cont[at] || /^\s*@/u.test(scan.lines[at]!))) at += 1;
          found.push([i, at < to ? pyBlockEnd(scan, at, to) : to]);
        }
      }
    }
    if (found.length === 0) return NO_REGION;
    ranges = found;
  }
  return ranges.map(([from, to]) => scan.lines.slice(from, to).join("\n")).join("\n\u0000\n");
}

function yamlRegion(text: string, location: PromptLocation): Region {
  if (location.symbol === undefined) return NO_REGION;
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.length > MAX_LINES) return NO_REGION;
  const parts = location.symbol.split(".");
  let ranges: Array<[number, number, number]> = [[0, lines.length, -1]];
  for (const part of parts) {
    const key = new RegExp(String.raw`^(\s*)(-\s+)?["']?${escapeRe(part)}["']?\s*:(?:\s|$)`, "u");
    const found: Array<[number, number, number]> = [];
    for (const [from, to, parentIndent] of ranges) {
      for (let i = from; i < to; i += 1) {
        const match = key.exec(lines[i]!);
        if (match === null) continue;
        const indent = (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
        if (indent <= parentIndent) continue;
        let end = i + 1;
        for (let j = i + 1; j < to; j += 1) {
          // A blank line or a comment never ends the block (a region too long is safe; one too short is not).
          if (blank(lines[j]!)) { end = j + 1; continue; }
          if (/^---(?:\s|$)/u.test(lines[j]!) || indentOf(lines[j]!) <= (match[1]?.length ?? 0)) break;
          end = j + 1;
        }
        while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
        found.push([i, end, indent]);
      }
    }
    if (found.length === 0) return NO_REGION;
    ranges = found.map(([from, to, indent]) => [from, to, indent] as [number, number, number]);
  }
  return ranges.map(([from, to]) => lines.slice(from, to).join("\n")).join("\n\u0000\n");
}

/** The text of the location's region in `text`, whole, or undefined when it cannot be found or this module does not read the language. Never throws. */
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
