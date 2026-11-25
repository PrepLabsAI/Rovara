// Whether a setup citation's quote is in its file. A citation is a file and an exact quote; there is no line to check (the model cannot count lines, and a line is of no use to a person). The broker reads the file
// at the cited commit and the citation holds when the quote is in it. What counts as the same text, and nothing more:
//   - the file's code (comments cut off: citation-comments.ts) is read as one text, every run of whitespace, line ends included, made one space. The proposal reader has already done the same to the quote, so a tab, an extra
//     space or a line break in the file never makes a real quote miss. Case, punctuation and every other character must be equal;
//   - a quote may run over AT MOST TWO consecutive lines of the file (a YAML `run: |` block, a pretty-printed JSON object): a blank line, a code fence line and a wholly commented line are each a break the quote cannot
//     cross, and a quote over three lines is not found;
//   - the search is bounded: it stops at the first place that is not cut out of a longer word, and past MAX_HITS places it gives up and finds nothing (fail closed).
// A quote that is not in the file at that commit is never found. Pure.
import { collapseWhitespace } from "../citations/citation-check.js";
import { COMMENT_LINE, codeLinesOf, type ScanBudget } from "./citation-comments.js";

/** One place a quote is in a file: the character before it and the (up to 8) characters after it in the file's code text (undefined / empty at the ends). */
export interface QuoteOccurrence { before: string | undefined; after: string | undefined }

/** A file's code as one text: its lines, comments cut off and whitespace made single, joined by a space, with the offset each line starts at. */
export interface CodeText { text: string; starts: readonly number[] }

const LINE_END = /\r\n|\r|\n/u;
const AFTER_CHARS = 8;
/** What stands for a line with no code (blank, or only a code fence marker): a break no quote can cross. A control character, which no quote holds. */
const BREAK_LINE = "\u0002";
/** How many places of a quote are looked at before the search gives up. */
export const MAX_HITS = 10_000;
/** What may touch a command's quote: the same set the command check uses (proposal-verify.ts `COMMAND_EDGE`). */
const CLEAN_EDGE = /^[\s"'`;&|()[\]{},=]$/u;

/** The file's code as one text, made once per file; every citation of the file searches it. */
export function codeTextOf(text: string, path: string | undefined, budget?: ScanBudget): CodeText {
  const parts: string[] = [];
  const starts: number[] = [];
  let offset = 0;
  for (const line of codeLinesOf(text.split(LINE_END), path, budget === undefined ? {} : { budget })) {
    const token = line === COMMENT_LINE ? COMMENT_LINE : collapseWhitespace(line) || BREAK_LINE;
    starts.push(offset);
    parts.push(token);
    offset += token.length + 1;
  }
  return { text: parts.join(" "), starts };
}

/** How many line starts are strictly inside `(from, to)`: the line joins a match across them crosses. */
function joinsIn(starts: readonly number[], from: number, to: number): number {
  const lowerBound = (target: number): number => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! < target) low = middle + 1; else high = middle;
    }
    return low;
  };
  return lowerBound(to) - lowerBound(from + 1);
}

/** Whether nothing glues a command's quote to a longer word at either end. */
export const isCommandClean = (place: QuoteOccurrence): boolean => (place.before === undefined || CLEAN_EDGE.test(place.before)) && (place.after === undefined || place.after === "" || CLEAN_EDGE.test(place.after[0]!));

/**
 * The place whose edges are judged: the first one that is `clean`, else the first; undefined when the quote is nowhere, when every place over two lines is left out, or when more than MAX_HITS places were looked at
 * without finding a clean one. Stops at the first clean place, and keeps no list of places.
 */
export function judgedOccurrence(code: CodeText, quote: string, clean: (place: QuoteOccurrence) => boolean): QuoteOccurrence | undefined {
  const wanted = collapseWhitespace(quote);
  if (wanted === "") return undefined;
  let first: QuoteOccurrence | undefined;
  let looked = 0;
  for (let at = code.text.indexOf(wanted); at !== -1; at = code.text.indexOf(wanted, at + 1)) {
    looked += 1;
    if (looked > MAX_HITS) return undefined;
    if (joinsIn(code.starts, at, at + wanted.length) > 1) continue;
    const place: QuoteOccurrence = { before: code.text[at - 1], after: code.text.slice(at + wanted.length, at + wanted.length + AFTER_CHARS) };
    if (clean(place)) return place;
    first ??= place;
  }
  return first;
}
