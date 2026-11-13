/**
 * TE-F4 static change contract (M2 / 0.5.19). No prompt, schema, endpoint or diagnostic text leaves the detector.
 * Q1 ruling: safe bounded repository paths are metadata and may appear ONLY in path/oldPath. Consumers must
 * render even these paths with their inert-text renderer. Unsafe paths are refused, with a SHA-256 reference.
 * Model names use F0a's narrower MODEL_NAME_PATTERN, never MODEL_ECHO_PATTERN. Numeric echoes must be finite;
 * other setting echoes come only from SETTING_ENUM_WORDS. No unknown source keys are copied into an object.
 */
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { sha256HexOf } from "./service-catalog-verify.js";
import { MODEL_FAMILIES } from "./model-catalog.js";
import { MODEL_NAME_PATTERN } from "./model-family-common.js";

export const PROMPT_CHANGE_SCHEMA_VERSION = 1;
export const PROMPT_CHANGE_KINDS = ["prompt_file", "prompt_text", "system_prompt", "model_name", "model_setting", "tool_schema", "model_endpoint"] as const;
export const PROMPT_CHANGE_VERBS = ["added", "removed", "modified", "renamed"] as const;
export const PROMPT_CHANGE_BASES = ["path_rule", "sdk_call", "key_name", "model_table", "catalog_host"] as const;
export const MODEL_SETTING_KEYS = ["temperature", "top_p", "top_k", "max_tokens", "stop_sequences", "seed", "frequency_penalty", "presence_penalty", "response_format", "reasoning_effort", "thinking_budget", "tool_choice"] as const;
export const SETTING_ENUM_WORDS = ["auto", "none", "required", "any", "text", "json_object", "json_schema", "minimal", "low", "medium", "high", "max", "enabled", "disabled"] as const;
export const PROMPT_CHANGE_INCOMPLETE_REASONS = ["too_many_files", "file_too_large", "total_too_large", "binary_file", "unreadable_diff", "diff_truncated", "hunks_only", "nonliteral_prompt"] as const;
export type PromptChangeKind = (typeof PROMPT_CHANGE_KINDS)[number];
export type ModelSettingKey = (typeof MODEL_SETTING_KEYS)[number];
export type PromptChangeIncompleteReason = (typeof PROMPT_CHANGE_INCOMPLETE_REASONS)[number];
export const PROMPT_CHANGE_INCOMPLETE_SENTENCES: Record<PromptChangeIncompleteReason, string> = {
  too_many_files: "Some files were not scanned because there are too many files.",
  file_too_large: "A file side was too large to scan.",
  total_too_large: "The input was too large to scan completely.",
  binary_file: "A binary file could not be scanned as text.",
  unreadable_diff: "Some source or diff text could not be read completely.",
  diff_truncated: "The workspace diff does not contain the whole change.",
  hunks_only: "Only changed hunks were available, so whole file coverage is unknown.",
  nonliteral_prompt: "A prompt expression could not be resolved statically.",
};
export const PROMPT_CHANGE_LIMITS = { files: 2000, fileBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024, pathChars: 512, pathBytes: 4096, items: 500, nesting: 64 } as const;

/** Deliberately narrow ordinary paths: letters/numbers, spaces, underscore, dot, slash and hyphen. */
export function isSafePromptChangePath(path: string): boolean {
  return path.length > 0 && path.length <= PROMPT_CHANGE_LIMITS.pathChars && !path.startsWith("---") && /^[\p{L}\p{N}_./-][\p{L}\p{N}_ ./-]*$/u.test(path);
}
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Path = z.string().max(PROMPT_CHANGE_LIMITS.pathChars).refine(isSafePromptChangePath, "path refused");
const common = {
  id: Hash, verb: z.enum(PROMPT_CHANGE_VERBS), basis: z.enum(PROMPT_CHANGE_BASES), path: Path,
  oldPath: Path.optional(), pathFingerprint: Hash.optional(), oldPathFingerprint: Hash.optional(),
  family: z.enum(MODEL_FAMILIES).nullable(), line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  fingerprintBefore: Hash.nullable(), fingerprintAfter: Hash.nullable(),
};
const fingerprintOnly = (kind: "prompt_file" | "prompt_text" | "system_prompt" | "tool_schema" | "model_endpoint") => z.object({ ...common, kind: z.literal(kind) }).strict();
export const PromptChangeItemSchema = z.discriminatedUnion("kind", [
  fingerprintOnly("prompt_file"), fingerprintOnly("prompt_text"), fingerprintOnly("system_prompt"), fingerprintOnly("tool_schema"), fingerprintOnly("model_endpoint"),
  z.object({ ...common, kind: z.literal("model_name"), before: z.string().max(128).regex(MODEL_NAME_PATTERN).optional(), after: z.string().max(128).regex(MODEL_NAME_PATTERN).optional() }).strict(),
  z.object({ ...common, kind: z.literal("model_setting"), settingKey: z.enum(MODEL_SETTING_KEYS), before: z.union([z.number().finite(), z.enum(SETTING_ENUM_WORDS)]).optional(), after: z.union([z.number().finite(), z.enum(SETTING_ENUM_WORDS)]).optional() }).strict(),
]).superRefine((item, ctx) => {
  if ((item.path === "path_refused" && !item.pathFingerprint) || (item.oldPath === "path_refused" && !item.oldPathFingerprint)) ctx.addIssue({ code: "custom", message: "refused path needs fingerprint" });
  if ((item.path !== "path_refused" && item.pathFingerprint !== undefined) || (item.oldPath !== "path_refused" && item.oldPathFingerprint !== undefined)) ctx.addIssue({ code: "custom", message: "safe path cannot carry a fingerprint" });
  if (item.verb === "renamed" && item.oldPath === undefined) ctx.addIssue({ code: "custom", message: "rename needs old path" });
  if (item.verb === "added" && (item.fingerprintBefore !== null || item.fingerprintAfter === null)) ctx.addIssue({ code: "custom", message: "invalid added fingerprints" });
  if (item.verb === "removed" && (item.fingerprintAfter !== null || item.fingerprintBefore === null)) ctx.addIssue({ code: "custom", message: "invalid removed fingerprints" });
  if (item.verb === "modified" && (item.fingerprintBefore === null || item.fingerprintAfter === null || item.fingerprintBefore === item.fingerprintAfter)) ctx.addIssue({ code: "custom", message: "invalid modified fingerprints" });
});
export type PromptChangeItem = z.infer<typeof PromptChangeItemSchema>;
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PromptChangeReportSchema = z.object({
  schemaVersion: z.literal(PROMPT_CHANGE_SCHEMA_VERSION), status: z.enum(["changes", "none_found", "incomplete"]),
  coverage: z.enum(["complete", "hunks_only", "partial"]), incompleteReasons: z.array(z.enum(PROMPT_CHANGE_INCOMPLETE_REASONS)).max(PROMPT_CHANGE_INCOMPLETE_REASONS.length),
  counts: z.object({ prompt_file: Count, prompt_text: Count, system_prompt: Count, model_name: Count, model_setting: Count, tool_schema: Count, model_endpoint: Count }).strict(),
  items: z.array(PromptChangeItemSchema).max(PROMPT_CHANGE_LIMITS.items), itemsTruncated: z.boolean(), reportDigest: Hash,
}).strict().superRefine((report, ctx) => {
  if (report.status === "none_found" && (report.coverage !== "complete" || report.items.length > 0 || report.incompleteReasons.length > 0)) ctx.addIssue({ code: "custom", message: "no changes needs complete coverage" });
  if (report.coverage === "complete" && report.incompleteReasons.length > 0) ctx.addIssue({ code: "custom", message: "complete coverage cannot have refusals" });
  if (report.status === "changes" && report.items.length === 0) ctx.addIssue({ code: "custom", message: "changes needs an item" });
  if (report.status === "incomplete" && (report.coverage === "complete" || report.incompleteReasons.length === 0)) ctx.addIssue({ code: "custom", message: "incomplete needs a refusal" });
  if (report.coverage !== "complete" && report.incompleteReasons.length === 0) ctx.addIssue({ code: "custom", message: "partial coverage needs a refusal" });
  if (new Set(report.incompleteReasons).size !== report.incompleteReasons.length) ctx.addIssue({ code: "custom", message: "duplicate incomplete reason" });
  const ids = new Set<string>();
  for (let i = 0; i < report.items.length; i++) {
    const item = report.items[i]!; const previous = report.items[i - 1];
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", message: "duplicate item id" });
    ids.add(item.id);
    if (previous && (previous.path > item.path || (previous.path === item.path && (previous.kind > item.kind || (previous.kind === item.kind && previous.id > item.id))))) ctx.addIssue({ code: "custom", message: "items must be sorted" });
  }
  // The digest includes omitted items, so a truncated report cannot be reverified from its display list.
  if (!report.itemsTruncated && report.reportDigest !== sha256HexOf(new TextEncoder().encode(canonicalJson(report.items.map((item) => [item.id, item.fingerprintBefore, item.fingerprintAfter]))))) ctx.addIssue({ code: "custom", message: "report digest mismatch" });
  const actual = { prompt_file: 0, prompt_text: 0, system_prompt: 0, model_name: 0, model_setting: 0, tool_schema: 0, model_endpoint: 0 };
  for (const item of report.items) actual[item.kind]++;
  let total = 0;
  for (const kind of PROMPT_CHANGE_KINDS) {
    total += report.counts[kind];
    if (report.itemsTruncated ? report.counts[kind] < actual[kind] : report.counts[kind] !== actual[kind]) ctx.addIssue({ code: "custom", message: "counts disagree with items" });
  }
  if (report.itemsTruncated && (report.items.length !== PROMPT_CHANGE_LIMITS.items || total <= PROMPT_CHANGE_LIMITS.items)) ctx.addIssue({ code: "custom", message: "invalid truncation" });
  if (report.itemsTruncated && report.status !== "changes") ctx.addIssue({ code: "custom", message: "truncated items are changes" });
});
export type PromptChangeReport = z.infer<typeof PromptChangeReportSchema>;
export interface PromptChangeDecision { needed: boolean; reason: "incomplete" | "changes" | "none_found" }
export function promptChangesNeedEval(report: PromptChangeReport): PromptChangeDecision {
  if (report.status === "incomplete" || report.coverage !== "complete") return { needed: true, reason: "incomplete" };
  return { needed: report.items.length > 0, reason: report.items.length > 0 ? "changes" : "none_found" };
}
export function promptChangesNeedSideBySide(report: PromptChangeReport): PromptChangeDecision {
  if (report.status === "incomplete" || report.coverage !== "complete") return { needed: true, reason: "incomplete" };
  const needed = report.counts.prompt_file + report.counts.prompt_text + report.counts.system_prompt + report.counts.tool_schema + report.counts.model_name > 0;
  return { needed, reason: needed ? "changes" : "none_found" };
}
