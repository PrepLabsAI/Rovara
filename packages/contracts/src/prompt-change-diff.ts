/** Git/workspace unified diff reader. A hunk is NOT a whole file, including new/deleted-file hunks.
 * Separate hunks stay separate for lexical scanning: missing source must never invent adjacent arguments.
 * Quoted paths use Git's C/octal byte encoding. No broker dependency and no untrusted JSON parsing.
 */
import { PROMPT_CHANGE_INCOMPLETE_REASONS, type PromptChangeIncompleteReason, type PromptChangeReport } from "./prompt-change.js";
import { byteLength, limits, newWork, type PromptChangeOptions, type Work } from "./prompt-change-internal.js";
export interface PromptChangeHunk { before: string; after: string; beforeLine: number; afterLine: number }
export interface PromptChangedFile {
  path: string; oldPath?: string; status?: "added" | "removed" | "modified" | "renamed";
  before?: string; after?: string; binary?: boolean; wholeFile?: boolean;
  /** Parser-owned hunk boundaries and line offsets. detectPromptChanges ignores caller-supplied hunks; supply whole files instead. */
  hunks?: readonly PromptChangeHunk[];
}
export interface PromptChangeInput { files: readonly PromptChangedFile[] }
export interface ParsedPromptChangeDiff extends PromptChangeInput {
  files: PromptChangedFile[]; coverage: PromptChangeReport["coverage"]; incompleteReasons: PromptChangeIncompleteReason[];
}
const simpleEscapes = new Map([["a", 7], ["b", 8], ["t", 9], ["n", 10], ["v", 11], ["f", 12], ["r", 13], ['"', 34], ["\\", 92]]);
function unquote(raw: string, work: Work): string | undefined {
  work.stats.steps += raw.length + 1;
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"')) return undefined;
  const bytes: number[] = []; const encoder = new TextEncoder();
  for (let i = 1; i < raw.length - 1; i++) {
    work.stats.steps++;
    if (raw[i] !== "\\") {
      const point = raw.codePointAt(i)!;
      for (const b of encoder.encode(String.fromCodePoint(point))) bytes.push(b);
      if (point > 0xffff) i++;
      continue;
    }
    const octal = raw.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/u.test(octal)) { bytes.push(Number.parseInt(octal, 8)); i += 3; }
    else { const b = simpleEscapes.get(raw[i + 1] ?? ""); if (b === undefined) return undefined; bytes.push(b); i++; }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}
function names(raw: string, work: Work): { from: string; to: string } | undefined {
  let split = -1;
  if (raw.startsWith('"')) {
    for (let i = 1; i < raw.length; i++) {
      work.stats.steps++;
      if (raw[i] === "\\") { i++; continue; }
      if (raw[i] === '"') { split = i + 1; break; }
    }
  } else {
    // Git leaves spaces unquoted. The ---/+++ headers, when present, confirm the chosen separator.
    split = raw.lastIndexOf(" b/");
    if (split < 0) split = raw.lastIndexOf(' "b/');
    work.stats.steps += raw.length * 2;
  }
  if (split < 0) return undefined;
  const from = unquote(raw.slice(0, split), work); const to = unquote(raw.slice(split + 1), work);
  return from?.startsWith("a/") && to?.startsWith("b/") ? { from: from.slice(2), to: to.slice(2) } : undefined;
}
export function parsePromptDiffInternal(text: string, options: PromptChangeOptions, work: Work): ParsedPromptChangeDiff {
  const caps = limits(options); const files: PromptChangedFile[] = [];
  const reasons = work.reasons; reasons.add("hunks_only");
  if (typeof text !== "string") { reasons.add("unreadable_diff"); return { files, coverage: "partial", incompleteReasons: [...reasons] }; }
  // Cheap character rejection before allocating UTF-8 bytes. No prefix is falsely called a complete diff.
  if (text.length > caps.totalBytes) { reasons.add("total_too_large"); return { files, coverage: "partial", incompleteReasons: [...reasons] }; }
  const bytes = byteLength(text, work); work.stats.bytes += bytes;
  if (bytes > caps.totalBytes) { reasons.add("total_too_large"); return { files, coverage: "partial", incompleteReasons: [...reasons] }; }
  let current: PromptChangedFile | undefined;
  let hunks: PromptChangeHunk[] = [];
  let before: string[] = []; let after: string[] = [];
  let oldLeft = 0; let newLeft = 0; let oldLine = 1; let newLine = 1; let inHunk = false;
  let sawInput = false; let statusSection = false; let sideBytes = 0;
  const finishHunk = () => {
    if (!inHunk) return;
    if (oldLeft !== 0 || newLeft !== 0) reasons.add("unreadable_diff");
    hunks.push({ before: before.join("\n"), after: after.join("\n"), beforeLine: oldLine, afterLine: newLine });
    before = []; after = []; inHunk = false;
  };
  const finishFile = () => {
    finishHunk();
    if (current && hunks.length > 0) {
      current.hunks = hunks; current.before = hunks.map((h) => h.before).join("\n"); current.after = hunks.map((h) => h.after).join("\n");
    }
    hunks = []; sideBytes = 0;
  };
  for (let start = 0; start < text.length;) {
    let end = start;
    while (end < text.length && text[end] !== "\n") { end++; work.stats.steps++; }
    // Git frames records with LF only. A lone CR belongs to the hunk payload.
    const line = text.slice(start, end > start && text[end - 1] === "\r" ? end - 1 : end);
    start = end + 1;
    work.stats.steps++;
    if (line.startsWith("[workspace diff truncated") || line.startsWith("[the commit this workspace was prepared at is not in this repository")) { reasons.add("diff_truncated"); continue; }
    if (line.startsWith("## ")) { finishFile(); current = undefined; statusSection = false; sawInput = true; continue; }
    if (line === "### status") { statusSection = true; continue; }
    if (line === "### diff") { statusSection = false; continue; }
    if (statusSection) { if (line.startsWith("?? ")) reasons.add("unreadable_diff"); continue; }
    if (line.startsWith("diff --git ")) {
      finishFile(); current = undefined; sawInput = true;
      if (files.length >= caps.files) { reasons.add("too_many_files"); break; }
      const pair = names(line.slice(11), work);
      if (!pair) { reasons.add("unreadable_diff"); continue; }
      current = { path: pair.to, ...(pair.from === pair.to ? {} : { oldPath: pair.from }), wholeFile: false, status: pair.from === pair.to ? "modified" : "renamed" };
      files.push(current); continue;
    }
    if (line.startsWith("@@")) {
      finishHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
      if (!match || !current) { reasons.add("unreadable_diff"); continue; }
      oldLine = Number(match[1]); newLine = Number(match[3]); oldLeft = Number(match[2] ?? 1); newLeft = Number(match[4] ?? 1);
      if (![oldLine, newLine, oldLeft, newLeft].every((n) => Number.isSafeInteger(n) && n >= 0)) { reasons.add("unreadable_diff"); continue; }
      inHunk = true; continue;
    }
    if (inHunk && (oldLeft > 0 || newLeft > 0)) {
      const prefix = line[0];
      if (prefix === " " || prefix === "-" || prefix === "+") {
        const content = line.slice(1);
        sideBytes += byteLength(content, work) + 1;
        if (sideBytes > caps.fileBytes * 2) { reasons.add("file_too_large"); finishFile(); current = undefined; continue; }
        if (prefix !== "+") { before.push(content); oldLeft--; }
        if (prefix !== "-") { after.push(content); newLeft--; }
        if (oldLeft < 0 || newLeft < 0) reasons.add("unreadable_diff");
        continue;
      }
      if (line === "\\ No newline at end of file") continue;
      reasons.add("unreadable_diff"); finishHunk();
    }
    if (!current) { if (line.trim() !== "") reasons.add("unreadable_diff"); continue; }
    if (line.startsWith("new file mode ")) current.status = "added";
    else if (line.startsWith("deleted file mode ")) current.status = "removed";
    else if (line.startsWith("rename from ")) { const path = unquote(line.slice(12), work); if (path === undefined) reasons.add("unreadable_diff"); else current.oldPath = path; current.status = "renamed"; }
    else if (line.startsWith("rename to ")) { const path = unquote(line.slice(10), work); if (path === undefined) reasons.add("unreadable_diff"); else current.path = path; current.status = "renamed"; }
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") { current.binary = true; reasons.add("binary_file"); }
    else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // Git appends a TAB to unquoted ---/+++ names containing spaces.
      const raw = line.slice(4);
      const path = unquote(raw.endsWith("\t") ? raw.slice(0, -1) : raw, work);
      if (path === undefined) reasons.add("unreadable_diff");
      else if (path !== "/dev/null" && line.startsWith("+++ ") && path.startsWith("b/")) current.path = path.slice(2);
    } else if (!(line === "" || line === "\\ No newline at end of file" || /^(?:index |old mode |new mode |similarity index |dissimilarity index )/u.test(line) || current.binary)) reasons.add("unreadable_diff");
  }
  finishFile();
  if (!sawInput && text.trim() !== "") reasons.add("unreadable_diff");
  return { files, coverage: reasons.size === 1 ? "hunks_only" : "partial", incompleteReasons: PROMPT_CHANGE_INCOMPLETE_REASONS.filter((reason) => reasons.has(reason)) };
}
export function parseUnifiedDiff(text: string, options: PromptChangeOptions = {}): ParsedPromptChangeDiff {
  const work = newWork();
  try { return parsePromptDiffInternal(text, options, work); }
  catch { return { files: [], coverage: "partial", incompleteReasons: ["unreadable_diff", "hunks_only"] }; }
}
