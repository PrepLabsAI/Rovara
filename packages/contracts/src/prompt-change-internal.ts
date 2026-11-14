/** Internal primitives. Work counts UTF-16 visits (including native linear passes), tokens, hashes and comparisons;
 * bytes counts examined UTF-8 source/path/diff bytes. No source text is retained in stats. */
import { sha256HexOf } from "./service-catalog-verify.js";
import { PROMPT_CHANGE_LIMITS, type PromptChangeIncompleteReason } from "./prompt-change.js";
export interface PromptChangeStats { steps: number; bytes: number; scannedFiles: number; skippedFiles: number }
export interface PromptChangeOptions { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; stats?: boolean }
export interface Work { stats: PromptChangeStats; reasons: Set<PromptChangeIncompleteReason> }
export const newWork = (): Work => ({ stats: { steps: 0, bytes: 0, scannedFiles: 0, skippedFiles: 0 }, reasons: new Set() });
export function limit(value: number | undefined, maximum: number): number { return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : maximum; }
export function limits(options: PromptChangeOptions) { return { files: limit(options.maxFiles, PROMPT_CHANGE_LIMITS.files), fileBytes: limit(options.maxFileBytes, PROMPT_CHANGE_LIMITS.fileBytes), totalBytes: limit(options.maxTotalBytes, PROMPT_CHANGE_LIMITS.totalBytes) }; }
const encoder = new TextEncoder();
export function hash(text: string, work: Work): string { work.stats.steps += text.length + 1; return sha256HexOf(encoder.encode(text)); }
export function byteLength(text: string, work: Work): number { work.stats.steps += text.length + 1; return encoder.encode(text).length; }
/** Collapse all whitespace (including line wraps), discard Unicode format/bidi characters. Linear, no backtracking. */
export function normalizePromptText(text: string, work: Work): string {
  work.stats.steps += text.length * 3 + 1;
  return text.replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
}
export function fingerprint(text: string, work: Work): string { return hash(normalizePromptText(text, work), work); }
