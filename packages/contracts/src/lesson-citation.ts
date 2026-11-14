// Learning v2: what makes a code citation meaningful, and how one is located in a file. One definition for the broker's verifier and the worker's check,
// so "a valid code citation" means the same thing in both. Pure; no I/O.

/** An anchor must carry real content: a lone `}` or `);` proves nothing about where a lesson points. */
export const ANCHOR_MIN_CHARS = 12;
/** The anchor is the first cited line, so it must sit at the start line, give or take this many lines. */
export const ANCHOR_TOLERANCE = 3;

export function isMeaningfulAnchor(anchor: string): boolean {
  const trimmed = anchor.trim();
  return trimmed.replace(/\s+/gu, "").length >= ANCHOR_MIN_CHARS && /[A-Za-z_][A-Za-z0-9_]{3,}/u.test(trimmed);
}

/** What a check needs of a file: its line count, and its lines unless it is too large to hold. */
export interface CitedLines { lineCount: number; lines: string[] | undefined }
export type CitationLocation = { kind: "valid" } | { kind: "moved"; startLine: number; endLine: number } | { kind: "stale" } | { kind: "unchecked" };

/**
 * Valid: the anchor line is at the start line (within ANCHOR_TOLERANCE). Moved: the anchor is found exactly once in the file, elsewhere; the range keeps its
 * length and ends inside the file. Stale: no file, a trivial anchor, or an anchor that is missing or ambiguous. The anchor is checked before the line count,
 * so a file that shrank but still holds the anchor is moved, not stale.
 */
export function locateCitation(file: CitedLines | undefined, citation: { startLine: number; endLine: number; anchor: string }): CitationLocation {
  if (file === undefined || !isMeaningfulAnchor(citation.anchor)) return { kind: "stale" };
  if (file.lines === undefined) return citation.startLine > file.lineCount ? { kind: "stale" } : { kind: "unchecked" };
  const wanted = citation.anchor.trimEnd();
  const found: number[] = [];
  for (const [position, line] of file.lines.entries()) if (line.trimEnd() === wanted) found.push(position + 1);
  if (found.some((line) => Math.abs(line - citation.startLine) <= ANCHOR_TOLERANCE)) return { kind: "valid" };
  if (found.length === 1) {
    const length = citation.endLine - citation.startLine;
    const startLine = Math.max(1, Math.min(found[0]!, file.lineCount - length));
    return { kind: "moved", startLine, endLine: Math.min(file.lineCount, startLine + length) };
  }
  return { kind: "stale" };
}
