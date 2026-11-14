// Knowledge resolver (K1, C1): references from one rule file to another.
//
// Two reference styles exist in the formats we read:
// - Claude memory imports: `@path/to/file.md` in the text, resolved from the importing file's folder.
// - Kiro file references: `#[[file:<path>]]`, `#[[file:<path>:<line>]]`, `#[[file:<path>:<start>-<end>]]` and `#[[folder:<path>]]`,
//   resolved from the repository root.
//
// Rules (design 3.3): same repository only, at most four deep, every byte counted in the budget. A reference that leaves the repository,
// is absolute, runs past the depth, repeats a file that is already included, or would pass the budget is left as written and reported
// by a fixed code. The files themselves come through `read`, which the resolver backs with the same verified source as the rule files
// (the base commit for judging stages), so an import can never read more than the stage may.
import { inertContextText } from "../context-text.js";

export type ImportStyle = "claude" | "kiro" | "none";

export type ImportIssueCode = "outside_repository" | "too_deep" | "missing" | "too_large" | "over_budget" | "too_many";

export interface ImportIssue {
  path: string;
  code: ImportIssueCode;
}

export type ImportRead = { kind: "file"; text: string } | { kind: "missing" } | { kind: "too_large" };

export interface ExpandImportsInput {
  /** The importing file's text, hidden characters already removed. */
  text: string;
  /** Its repository-relative path: Claude-style imports resolve from its folder. */
  path: string;
  style: ImportStyle;
  maxDepth: number;
  /** The most bytes all imported text may add together. */
  budgetBytes: number;
  /** Repository-relative paths already in the context (other loaded files, earlier imports): a reference to one is not repeated. */
  alreadyIncluded?: ReadonlySet<string>;
  read(path: string): Promise<ImportRead>;
  listDirectory?(path: string): Promise<string[] | undefined>;
}

export interface ExpandedImports {
  text: string;
  /** Repository-relative paths that were pulled in, in order. */
  imported: string[];
  issues: ImportIssue[];
  /** UTF-8 bytes the imports added. */
  addedBytes: number;
}

/** The most references followed from one file, and in one expansion; a file of a thousand `@x` lines is bounded. */
const MAX_REFERENCES_PER_EXPANSION = 64;
const MAX_FOLDER_LISTING = 50;
const CLAUDE_REFERENCE = /(^|\s)@([A-Za-z0-9_.\-/]{1,200})/gu;
const KIRO_REFERENCE = /#\[\[(file|folder):([^\]\n]{1,300})\]\]/gu;

/** `path` joined onto `folder` with `.` and `..` resolved, or undefined when it leaves the repository or is not a plain relative path. */
export function resolveRepositoryPath(folder: string, path: string): string | undefined {
  if (path === "" || path.startsWith("/") || path.startsWith("~") || path.includes("\\") || path.includes("\0") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)) return undefined;
  const parts = folder === "" ? [] : folder.split("/");
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The lines `spec` names (`12` or `10-20`, one-based), or the whole text without a spec; a malformed spec is undefined. */
function selectLines(text: string, spec: string | undefined): string | undefined {
  if (spec === undefined) return text;
  const match = /^(\d{1,7})(?:-(\d{1,7}))?$/u.exec(spec);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return undefined;
  return text.split("\n").slice(start - 1, end).join("\n");
}

interface Reference {
  kind: "file" | "folder";
  /** Where the reference starts and ends in the line. */
  index: number;
  length: number;
  /** For `@path`: the leading whitespace kept in front of the replacement. */
  keep: string;
  path: string;
  lines?: string;
}

function referencesIn(line: string, style: ImportStyle): Reference[] {
  const found: Reference[] = [];
  if (style === "kiro") {
    for (const match of line.matchAll(KIRO_REFERENCE)) {
      const kind = match[1] as "file" | "folder";
      let target = match[2]!.trim();
      let lines: string | undefined;
      if (kind === "file") {
        const range = /^(.*):(\d{1,7}(?:-\d{1,7})?)$/u.exec(target);
        if (range !== null) { target = range[1]!; lines = range[2]; }
      }
      found.push({ kind, index: match.index, length: match[0].length, keep: "", path: target, ...(lines === undefined ? {} : { lines }) });
    }
  } else if (style === "claude") {
    for (const match of line.matchAll(CLAUDE_REFERENCE)) {
      // A sentence's full stop is not part of the name.
      const path = match[2]!.replace(/\.+$/u, "");
      if (path === "") continue;
      // `@alice` is a mention; an import names a file: it has a folder or an extension.
      if (!path.includes("/") && !/\.[A-Za-z0-9]{1,8}$/u.test(path)) continue;
      found.push({ kind: "file", index: match.index + match[1]!.length, length: path.length + 1, keep: "", path });
    }
  }
  return found;
}

export async function expandImports(input: ExpandImportsInput): Promise<ExpandedImports> {
  const imported: string[] = [];
  const issues: ImportIssue[] = [];
  const included = new Set(input.alreadyIncluded ?? []);
  included.add(input.path);
  let addedBytes = 0;
  let references = 0;

  const expand = async (text: string, path: string, depth: number): Promise<string> => {
    if (input.style === "none") return text;
    const output: string[] = [];
    let fenced = false;
    for (const line of text.split("\n")) {
      if (/^\s{0,3}(```|~~~)/u.test(line)) { fenced = !fenced; output.push(line); continue; }
      if (fenced) { output.push(line); continue; }
      // Inline code is text, not a reference: only the stretches outside backticks are searched.
      const segments = line.split("`");
      const rebuilt: string[] = [];
      for (let index = 0; index < segments.length; index += 1) {
        rebuilt.push(index % 2 === 1 ? segments[index]! : await expandLine(segments[index]!, path, depth));
      }
      output.push(rebuilt.join("`"));
    }
    return output.join("\n");
  };

  const expandLine = async (line: string, path: string, depth: number): Promise<string> => {
    const found = referencesIn(line, input.style);
    if (found.length === 0) return line;
    let result = "";
    let cursor = 0;
    for (const reference of found) {
      result += line.slice(cursor, reference.index);
      cursor = reference.index + reference.length;
      const original = line.slice(reference.index, cursor);
      const replacement = await follow(reference, path, depth);
      result += replacement ?? original;
    }
    return result + line.slice(cursor);
  };

  const follow = async (reference: Reference, from: string, depth: number): Promise<string | undefined> => {
    // Kiro references are relative to the repository root; Claude's to the importing file's folder.
    const target = resolveRepositoryPath(input.style === "kiro" ? "" : folderOf(from), reference.path);
    if (target === undefined) { issues.push({ path: shown(reference.path), code: "outside_repository" }); return undefined; }
    if (depth + 1 > input.maxDepth) { issues.push({ path: target, code: "too_deep" }); return undefined; }
    if (references >= MAX_REFERENCES_PER_EXPANSION) { issues.push({ path: target, code: "too_many" }); return undefined; }
    references += 1;
    if (reference.kind === "folder") {
      const names = await input.listDirectory?.(target);
      if (names === undefined) { issues.push({ path: target, code: "missing" }); return undefined; }
      const listing = `[Folder ${target}]\n${names.slice(0, MAX_FOLDER_LISTING).map((name) => `- ${inertContextText(name).text}`).join("\n")}\n[End of ${target}]`;
      if (addedBytes + Buffer.byteLength(listing, "utf8") > input.budgetBytes) { issues.push({ path: target, code: "over_budget" }); return undefined; }
      addedBytes += Buffer.byteLength(listing, "utf8");
      return listing;
    }
    if (included.has(target)) return `[Already included: ${target}]`;
    const read = await input.read(target);
    if (read.kind === "missing") { issues.push({ path: target, code: "missing" }); return undefined; }
    if (read.kind === "too_large") { issues.push({ path: target, code: "too_large" }); return undefined; }
    const selected = selectLines(inertContextText(read.text).text, reference.lines);
    if (selected === undefined) { issues.push({ path: target, code: "missing" }); return undefined; }
    const wrapped = `[Imported from ${target}]\n${selected}\n[End of ${target}]`;
    const bytes = Buffer.byteLength(wrapped, "utf8");
    if (addedBytes + bytes > input.budgetBytes) { issues.push({ path: target, code: "over_budget" }); return undefined; }
    addedBytes += bytes;
    included.add(target);
    imported.push(target);
    // The imported text can import in turn, one level deeper.
    const nested = reference.lines === undefined ? await expand(selected, target, depth + 1) : selected;
    return nested === selected ? wrapped : `[Imported from ${target}]\n${nested}\n[End of ${target}]`;
  };

  return { text: await expand(input.text, input.path, 0), imported, issues, addedBytes };
}

/** A path as it is shown in an issue: bounded, with no control characters. */
function shown(path: string): string {
  return path.slice(0, 200).replace(/[^\x20-\x7e]/gu, "?");
}
