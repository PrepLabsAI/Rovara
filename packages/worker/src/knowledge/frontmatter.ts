// Knowledge resolver (K1, C1): front matter of a rule file.
//
// Rule files carry a block between two `---` lines at the very top ("front matter must be first in the file", Kiro's steering page;
// Cursor, Copilot and Claude rules follow the same shape). The block is untrusted text, so this reads a deliberately small subset of
// YAML and refuses the rest: `key: value` lines, quoted or bare strings, booleans, inline lists `[a, b]` and block lists (`- item`).
// No anchors, tags, merge keys, nested maps or multi-line scalars are read, and the block is bounded.

export type FrontMatterValue = string | boolean | string[];

export type FrontMatterResult =
  | { ok: true; present: boolean; data: Record<string, FrontMatterValue>; body: string }
  | { ok: false; reason: "unterminated" | "unsupported" | "too_large" };

export const MAX_FRONT_MATTER_BYTES = 8 * 1024;
const MAX_KEYS = 50;
const MAX_LIST_ENTRIES = 50;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function unquote(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    const inner = value.slice(1, -1);
    // A double-quoted value may carry the escapes JSON does; an invalid one makes the block unsupported rather than guessed.
    if (value.startsWith('"')) {
      try { return JSON.parse(value) as string; } catch { return undefined; }
    }
    return inner.replace(/''/gu, "'");
  }
  if (value.startsWith('"') || value.startsWith("'")) return undefined;
  // Anchors, aliases, tags, block scalars and flow maps are YAML features this reader does not accept.
  if (/^[&*!|>{]/u.test(value) || value.startsWith("- ")) return undefined;
  // A trailing ` # comment` on a bare scalar.
  return value.replace(/\s+#.*$/u, "").trim();
}

function splitInlineList(raw: string): string[] | undefined {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim() === "") return [];
  const entries: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') { current += inner[index + 1] ?? ""; index += 1; } else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") { quote = char; current += char; }
    else if (char === "[" || char === "]") return undefined;
    else if (char === ",") { entries.push(current); current = ""; }
    else current += char;
  }
  if (quote !== undefined) return undefined;
  entries.push(current);
  const values: string[] = [];
  for (const entry of entries) {
    const value = unquote(entry);
    if (value === undefined) return undefined;
    // `[a, ]` (a trailing comma) is allowed; an empty item between two commas is not a pattern.
    if (value !== "") values.push(value);
  }
  return values.length > MAX_LIST_ENTRIES ? undefined : values;
}

/**
 * Splits `text` into its front matter and body. Text that does not start with `---` has no front matter (`present: false`, the whole text is
 * the body); a `---` that is never closed, a block that is too large and a line this reader does not accept are errors the caller reports.
 */
export function parseFrontMatter(text: string): FrontMatterResult {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!/^---[ \t]*\n/u.test(normalized)) return { ok: true, present: false, data: {}, body: normalized };
  const lines = normalized.split("\n");
  let end = -1;
  let size = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(lines[index]!)) { end = index; break; }
    size += lines[index]!.length + 1;
    if (size > MAX_FRONT_MATTER_BYTES) return { ok: false, reason: "too_large" };
  }
  if (end < 0) return { ok: false, reason: "unterminated" };
  const data: Record<string, FrontMatterValue> = {};
  let pendingList: { key: string; values: string[] } | undefined;
  const closeList = (): void => {
    if (pendingList !== undefined) { data[pendingList.key] = pendingList.values; pendingList = undefined; }
  };
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/u.exec(line) ?? /^-\s+(.*)$/u.exec(line);
    if (item !== null) {
      if (pendingList === undefined) return { ok: false, reason: "unsupported" };
      const value = unquote(item[1]!);
      if (value === undefined || pendingList.values.length >= MAX_LIST_ENTRIES) return { ok: false, reason: "unsupported" };
      if (value !== "") pendingList.values.push(value);
      continue;
    }
    closeList();
    if (/^\s/u.test(line)) return { ok: false, reason: "unsupported" };
    const colon = line.indexOf(":");
    const key = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!KEY.test(key) || Object.keys(data).length >= MAX_KEYS || Object.hasOwn(data, key)) return { ok: false, reason: "unsupported" };
    const raw = line.slice(colon + 1).trim();
    if (raw === "") { pendingList = { key, values: [] }; continue; }
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) return { ok: false, reason: "unsupported" };
      const values = splitInlineList(raw);
      if (values === undefined) return { ok: false, reason: "unsupported" };
      data[key] = values;
      continue;
    }
    const value = unquote(raw);
    if (value === undefined) return { ok: false, reason: "unsupported" };
    // A quoted scalar stays a string even when it reads `true`; only a bare true/false is a boolean.
    const bare = !raw.startsWith('"') && !raw.startsWith("'");
    data[key] = bare && value === "true" ? true : bare && value === "false" ? false : value;
  }
  closeList();
  return { ok: true, present: true, data, body: lines.slice(end + 1).join("\n") };
}

/** A front-matter value that may be one pattern or a list of them (`globs: "a, b"`, `applyTo: "**\/*.ts"`, `fileMatchPattern: [a, b]`) as a list. */
export function asPatternList(value: FrontMatterValue | undefined, options: { splitCommas: boolean }): string[] | undefined {
  if (value === undefined || typeof value === "boolean") return undefined;
  const parts = Array.isArray(value) ? value : [value];
  const patterns: string[] = [];
  for (const part of parts) {
    // Brace groups keep their commas: `**/*.{ts,tsx}` is one pattern.
    const pieces = options.splitCommas ? splitOutsideBraces(part) : [part];
    for (const piece of pieces) {
      const pattern = piece.trim();
      if (pattern !== "") patterns.push(pattern);
    }
  }
  return patterns.length === 0 || patterns.length > MAX_LIST_ENTRIES ? undefined : patterns;
}

function splitOutsideBraces(value: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{") depth += 1;
    else if (char === "}" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) { pieces.push(current); current = ""; } else current += char;
  }
  pieces.push(current);
  return pieces;
}
