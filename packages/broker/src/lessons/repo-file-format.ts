// The text of `.rovara/lessons.md`. Pure: no store, no host, no model, no clock.
//
// The file: a fixed header, then sections by path scope (the whole repository first, then paths in byte order), then one block per lesson, blocks by id:
//
//   <!-- rovara:les_7f3a -->
//   - Run `pnpm db:migrate` before integration tests; they fail without the schema.
//
// No dates, counts, links, task ids, hosts or names, so an unchanged set gives the same bytes. Lesson text is cleaned (NFC, line breaks to spaces, bidi and zero-width characters removed, 600 code points cut on a grapheme
// boundary), wrapped at 80 columns with a two space hanging indent, never at a word a formatter would read as a new list item, heading or rule. LF only, one final LF.
//
// Rovara never rewrites a file it did not write alone. `applyFileChanges` is a SURGICAL edit of the merged file: it removes, replaces or adds exactly the blocks asked for and leaves every other byte (the team's own
// blocks, text between blocks, a different order of sections, CRLF) as it was. On a file Rovara wrote alone the result is the canonical render, whatever order the changes arrive in (the tests pin it).
import { createHash } from "node:crypto";

export const FILE_HEADER = [
  "# Team lessons for this repository",
  "",
  "Proposed by Rovara from this repo's own reviews and commits; merged by your team.",
  "Edit freely: Rovara reads your edits. Keep each `<!-- rovara:... -->` line with its lesson.",
];
export const WHOLE_REPOSITORY = "Whole repository";
export const TEXT_MAX_CODE_POINTS = 600;
export const WRAP_WIDTH = 80;

const ID_LINE = /^<!--\s*rovara:([A-Za-z0-9_-]{4,64})\s*-->\s*$/u;
const HEADING = /^##\s+(\S.*?)\s*$/u;
const ANY_HEADING = /^#{1,6}(?:\s|$)/u;
/** A word a formatter would read as the start of a list item, heading, quote, rule, table or code fence when it begins a line. */
const LINE_START_HAZARD = /^(?:[-+*#>=<|~]|\d{1,9}[.)]|`{3,})/u;

/** The id line of a block. */
export const idLine = (id: string): string => `<!-- rovara:${id} -->`;

const BIDI_AND_ZERO_WIDTH = /[\u061c\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** Cuts at `max` code points without splitting a grapheme (an emoji with its joiners, a letter with its accents). */
function cutGraphemes(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;
  let out = "";
  let count = 0;
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) {
    const size = Array.from(segment).length;
    if (count + size > max) break;
    out += segment;
    count += size;
  }
  return out;
}

/**
 * The one line a lesson's text becomes: NFC, every line break (and U+2028/9) a space, bidi and zero-width and other control or format characters removed, HTML comment marks removed (a lesson can never write an id line or hide
 * text), runs of spaces collapsed, cut at 600 code points on a grapheme boundary. Empty when nothing is left.
 */
export function cleanLessonLine(raw: string): string {
  // eslint-disable-next-line no-control-regex -- line breaks, tabs and the vertical tab and form feed are exactly what is turned into spaces
  let text = raw.normalize("NFC").replace(/[\r\n\t\u000b\u000c\u0085\u2028\u2029]/gu, " ");
  text = text.replace(BIDI_AND_ZERO_WIDTH, "").replace(/[\p{Cc}\p{Cf}]/gu, "");
  text = text.replace(/<!--|-->/gu, " ").replace(/\s+/gu, " ").trim();
  return cutGraphemes(text, TEXT_MAX_CODE_POINTS).trim();
}

/** The text as read back from a file block or as rendered: NFC, one line, single spaces, no list marker. The comparison form (formatters and reflowing leave it unchanged). */
export function normalizeBlockText(raw: string): string {
  return raw.normalize("NFC").replace(/^\s*[-*+]\s+/u, "").replace(/\s+/gu, " ").trim();
}

/** A short stable fingerprint of a text, for "did the team change it" (never shown, never a secret). */
export const textHash = (normalized: string): string => createHash("sha256").update(normalized).digest("hex").slice(0, 16);

/** The bullet lines of a cleaned text: `- ` then the words, wrapped at 80 columns, continuation lines indented two spaces, never starting a continuation line with a formatter hazard. Deterministic. */
export function wrapBullet(text: string): string[] {
  const words = text.split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let line = "- ";
  let empty = true;
  for (const word of words) {
    if (empty) { line += word; empty = false; continue; }
    if (line.length + 1 + word.length > WRAP_WIDTH && !LINE_START_HAZARD.test(word)) {
      lines.push(line);
      line = `  ${word}`;
      continue;
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines;
}

/** The rendered block of one lesson: its id line, then its bullet. */
export const blockLines = (id: string, text: string): string[] => [idLine(id), ...wrapBullet(text)];

/** The order of two section headings: the whole repository first, then byte order (not locale order). */
export function compareHeadings(a: string, b: string): number {
  const key = (heading: string): Buffer => Buffer.from(heading === WHOLE_REPOSITORY ? "" : heading, "utf8");
  return Buffer.compare(key(a), key(b));
}
/** The order of two ids: byte order. */
export const compareIds = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---- parsing

export type Unit = { kind: "line"; text: string } | { kind: "block"; id: string; lines: string[] };
export interface ParsedBlock {
  id: string;
  /** The section heading it sits under (the whole repository when it sits above any heading), as written. */
  heading: string;
  /** The block's text in comparison form (`normalizeBlockText`). Empty for an id line with no bullet after it. */
  text: string;
  /** Where its unit is in `units`. */
  index: number;
}
export interface ParsedFile {
  units: Unit[];
  blocks: ParsedBlock[];
  /** Ids that appear more than once: the first block keeps the id, Rovara does not touch any block of these ids. */
  duplicates: string[];
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

/** Splits a file into units: every line is one unit, except a block (an id line and the bullet lines under it, up to a blank line, a heading or the next id line), which is one unit. Never throws. */
export function parseLessonsFile(text: string): ParsedFile {
  const eol: "\n" | "\r\n" = text.includes("\r\n") && !/(?<!\r)\n/u.test(text) ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/u);
  if (finalNewline) lines.pop();
  const units: Unit[] = [];
  const blocks: ParsedBlock[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let heading = WHOLE_REPOSITORY;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const id = ID_LINE.exec(line)?.[1];
    if (id !== undefined) {
      const body: string[] = [line];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() === "" || ANY_HEADING.test(next) || ID_LINE.test(next)) break;
        body.push(next);
        i += 1;
      }
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
      blocks.push({ id, heading, text: normalizeBlockText(body.slice(1).join(" ")), index: units.length });
      units.push({ kind: "block", id, lines: body });
      continue;
    }
    const section = HEADING.exec(line);
    if (section !== null) heading = section[1]!;
    else if (ANY_HEADING.test(line) && /^#\s/u.test(line)) heading = WHOLE_REPOSITORY;
    units.push({ kind: "line", text: line });
  }
  return { units, blocks, duplicates: [...duplicates], eol, finalNewline };
}

/** The first block of an id (a duplicated id has none for the purposes of change). */
export function blockOf(file: ParsedFile, id: string): ParsedBlock | undefined {
  if (file.duplicates.includes(id)) return undefined;
  return file.blocks.find((block) => block.id === id);
}

// ---- surgical change

export interface FileChanges {
  remove: readonly string[];
  /** Replace a block's bullet in place (same section). */
  replace: ReadonlyArray<{ id: string; text: string }>;
  /** Add a block under a section (created when absent, at its place in the order). A moved block is a remove and an add. */
  add: ReadonlyArray<{ id: string; heading: string; text: string }>;
}

const isBlank = (unit: Unit | undefined): boolean => unit?.kind === "line" && unit.text.trim() === "";
const headingOf = (unit: Unit | undefined): string | undefined => (unit?.kind === "line" ? HEADING.exec(unit.text)?.[1] : undefined);
const isAnyHeading = (unit: Unit | undefined): boolean => unit?.kind === "line" && ANY_HEADING.test(unit.text);

function removeBlockAt(units: Unit[], index: number): void {
  // The blank line that separates it goes with it: the one before, else the one after, so no double blank is left and none is lost.
  if (isBlank(units[index - 1])) units.splice(index - 1, 2);
  else if (isBlank(units[index + 1])) units.splice(index, 2);
  else units.splice(index, 1);
}

/** Removes the headings of sections with no content left (and the blank line before them); the next heading keeps a blank line before it. */
function dropEmptySections(units: Unit[]): void {
  for (let i = units.length - 1; i >= 0; i -= 1) {
    if (headingOf(units[i]) === undefined) continue;
    let end = i + 1;
    while (end < units.length && !isAnyHeading(units[end])) end += 1;
    if (!units.slice(i + 1, end).every(isBlank)) continue;
    const start = isBlank(units[i - 1]) ? i - 1 : i;
    units.splice(start, end - start);
    if (start < units.length && isAnyHeading(units[start]) && start > 0 && !isBlank(units[start - 1])) units.splice(start, 0, { kind: "line", text: "" });
  }
}

function insertBlock(units: Unit[], add: { id: string; heading: string; text: string }): void {
  const block: Unit = { kind: "block", id: add.id, lines: blockLines(add.id, add.text) };
  const blank: Unit = { kind: "line", text: "" };
  // Find the section.
  const sectionStarts: Array<{ index: number; heading: string }> = [];
  units.forEach((unit, index) => {
    const heading = headingOf(unit);
    if (heading !== undefined) sectionStarts.push({ index, heading });
  });
  const at = sectionStarts.find((s) => s.heading === add.heading)?.index ?? -1;
  if (at === -1) {
    // A new section, before the first existing section that sorts after it.
    const later = sectionStarts.find((s) => compareHeadings(s.heading, add.heading) > 0);
    const position = later === undefined ? units.length : (isBlank(units[later.index - 1]) ? later.index - 1 : later.index);
    units.splice(position, 0, blank, { kind: "line", text: `## ${add.heading}` }, blank, block);
    return;
  }
  let end = at + 1;
  while (end < units.length && !isAnyHeading(units[end])) end += 1;
  // After the last block with a smaller id; before the first with a greater one; else right after the heading.
  let anchor = at;
  for (let i = at + 1; i < end; i += 1) {
    const unit = units[i]!;
    if (unit.kind !== "block") continue;
    if (compareIds(unit.id, add.id) < 0) anchor = i;
    else break;
  }
  units.splice(anchor + 1, 0, blank, block);
}

/**
 * The file after the changes, as text. `existing` undefined starts from the header. Removals first, then replacements, then additions; a block of a duplicated id is never touched; a section left empty is removed. Other bytes
 * stay as they were. Always ends with exactly one line feed (in the file's own line ending).
 */
export function applyFileChanges(existing: string | undefined, changes: FileChanges): string {
  const parsed = parseLessonsFile(existing ?? `${FILE_HEADER.join("\n")}\n`);
  const units = [...parsed.units];
  const indexOfBlock = (id: string): number => (parsed.duplicates.includes(id) ? -1 : units.findIndex((unit) => unit.kind === "block" && unit.id === id));
  for (const id of changes.remove) {
    const index = indexOfBlock(id);
    if (index >= 0) removeBlockAt(units, index);
  }
  for (const replacement of changes.replace) {
    const index = indexOfBlock(replacement.id);
    if (index >= 0) units[index] = { kind: "block", id: replacement.id, lines: blockLines(replacement.id, replacement.text) };
  }
  dropEmptySections(units);
  for (const add of [...changes.add].sort((a, b) => compareHeadings(a.heading, b.heading) || compareIds(a.id, b.id))) {
    if (units.some((unit) => unit.kind === "block" && unit.id === add.id)) continue;
    insertBlock(units, add);
  }
  while (units.length > 0 && isBlank(units.at(-1))) units.pop();
  const lines = units.flatMap((unit) => (unit.kind === "block" ? unit.lines : [unit.text]));
  return `${lines.join(parsed.eol)}${parsed.eol}`;
}

/** The canonical file for a set of lessons: the header and every block. Equal to adding them one by one to an empty file, in any order. */
export const renderLessonsFile = (blocks: ReadonlyArray<{ id: string; heading: string; text: string }>): string => applyFileChanges(undefined, { remove: [], replace: [], add: blocks });

/** Whether a text is within the file's cap (bytes). */
export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
