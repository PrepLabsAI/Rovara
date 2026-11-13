/** TE-F4: deterministic pure static detection. No filesystem, network, process, clock or randomness.
 * Returns { report, stats? }; evidence serializes ONLY report, which has a strict schema. Stats contain counts only.
 * Missing/unsupported text yields incomplete, never none_found. Incomplete coverage retains status incomplete even with findings, except the required changes status for
 * truncated item lists; selectors inspect coverage too. Input ordering cannot select which capped files win:
 * exceeding the file/total-byte cap refuses the batch, rather than scanning an order-dependent prefix.
 */
import { canonicalJson } from "./canonical-json.js";
import { MODEL_NAME_PATTERN } from "./model-family-common.js";
import { isSafePromptChangePath, PROMPT_CHANGE_INCOMPLETE_REASONS, PROMPT_CHANGE_LIMITS, SETTING_ENUM_WORDS, type PromptChangeItem, type PromptChangeReport } from "./prompt-change.js";
import { parsePromptDiffInternal, type PromptChangedFile, type PromptChangeInput } from "./prompt-change-diff.js";
import { byteLength, fingerprint, hash, limits, newWork, type PromptChangeOptions, type PromptChangeStats, type Work } from "./prompt-change-internal.js";
import { aiPath, knownSdk, SDK_CALLS, promptFilePath, sourceMode } from "./prompt-change-rules.js";
import { scanPromptSource, type ScannedValue } from "./prompt-change-scan.js";
export type { PromptChangeOptions, PromptChangeStats } from "./prompt-change-internal.js";
export type { PromptChangedFile, PromptChangeInput } from "./prompt-change-diff.js";
export interface PromptChangeResult { report: PromptChangeReport; stats?: PromptChangeStats }
interface PathInfo {
  display: { path: string; fingerprint?: string }; id: string; bytes: number;
  mode: ReturnType<typeof sourceMode>; prompt: boolean; ai: boolean; documentation: boolean; embedded: boolean;
}
function inspectPath(path: string, work: Work): PathInfo {
  // Refuse before regexes, lowercasing, set membership or hashing unbounded names. The prefix/length
  // reference intentionally does not identify distinct equal-length names sharing this prefix.
  const prefix = path.slice(0, PROMPT_CHANGE_LIMITS.pathBytes);
  const bytes = byteLength(prefix, work);
  const refused = path.length > PROMPT_CHANGE_LIMITS.pathBytes || bytes > PROMPT_CHANGE_LIMITS.pathBytes;
  const id = hash(refused ? canonicalJson(["rovara.path-prefix.v1", path.length, prefix]) : path, work);
  if (refused) work.reasons.add("unreadable_diff");
  // A bounded suffix can still supply extension hints; unknown folders remain partial, never complete.
  const rulePath = refused ? path.slice(-128) : path;
  work.stats.steps += rulePath.length * 8 + Math.min(path.length, PROMPT_CHANGE_LIMITS.pathChars) + 1;
  const mode = sourceMode(rulePath);
  const safe = !refused && isSafePromptChangePath(path) && path !== "path_refused";
  return { display: safe ? { path } : { path: "path_refused", fingerprint: id }, id,
    bytes: refused ? Math.max(bytes, path.length) : bytes,
    mode: refused && mode === "other" ? "code" : mode, prompt: promptFilePath(rulePath), ai: aiPath(rulePath),
    documentation: /\.(?:md|mdx|txt|rst|adoc|csv|svg|css|html)$/iu.test(rulePath), embedded: /\.(?:html|md|mdx)$/iu.test(rulePath) };
}
interface FileIdentity { path: PathInfo["display"]; oldPath?: PathInfo["display"]; idPath: string }
function makeItem(identity: FileIdentity, before: ScannedValue | undefined, after: ScannedValue | undefined, verb: PromptChangeItem["verb"], work: Work): PromptChangeItem {
  const value: ScannedValue = after ?? before ?? { kind: "prompt_file", basis: "path_rule", anchor: "file/0", family: null, fingerprint: "", line: 1 };
  const { path, oldPath } = identity;
  let line = after?.line ?? null;
  if (line !== null && (!Number.isSafeInteger(line) || line < 1)) { work.reasons.add("unreadable_diff"); line = null; }
  const common = {
    id: hash(canonicalJson(["rovara.prompt-change.v1", value.kind, identity.idPath, value.anchor]), work),
    verb, basis: value.basis, path: path.path, ...(path.fingerprint ? { pathFingerprint: path.fingerprint } : {}),
    ...(oldPath ? { oldPath: oldPath.path, ...(oldPath.fingerprint ? { oldPathFingerprint: oldPath.fingerprint } : {}) } : {}),
    family: value.family, line, fingerprintBefore: before?.fingerprint ?? null, fingerprintAfter: after?.fingerprint ?? null,
  };
  // Defense at the output boundary: even an internal scanner value cannot create a free-text report field.
  if (value.kind === "model_name") {
    const safe = (v: ScannedValue | undefined) => typeof v?.echo === "string" && v.echo.length <= 128 && MODEL_NAME_PATTERN.test(v.echo) ? v.echo : undefined;
    const left = safe(before); const right = safe(after);
    return { ...common, kind: "model_name", ...(left === undefined ? {} : { before: left }), ...(right === undefined ? {} : { after: right }) };
  }
  if (value.kind === "model_setting") {
    const safe = (v: ScannedValue | undefined): number | (typeof SETTING_ENUM_WORDS)[number] | undefined => {
      if (typeof v?.echo === "number" && Number.isFinite(v.echo)) return v.echo;
      if (typeof v?.echo === "string" && (SETTING_ENUM_WORDS as readonly string[]).includes(v.echo)) return v.echo as (typeof SETTING_ENUM_WORDS)[number];
      return undefined;
    };
    const left = safe(before); const right = safe(after);
    return { ...common, kind: "model_setting", settingKey: value.settingKey!, ...(left === undefined ? {} : { before: left }), ...(right === undefined ? {} : { after: right }) };
  }
  return { ...common, kind: value.kind };
}
function pair(identity: FileIdentity, before: ScannedValue[], after: ScannedValue[], work: Work): PromptChangeItem[] {
  const items: PromptChangeItem[] = [];
  const byFingerprint = new Map<string, { list: number[]; next: number }>();
  const matchedBefore = new Set<number>(); const matchedAfter = new Set<number>();
  for (let i = 0; i < before.length; i++) {
    work.stats.steps++;
    const value = before[i]!; const key = `${value.kind}/${value.fingerprint}`;
    const queue = byFingerprint.get(key) ?? { list: [], next: 0 }; queue.list.push(i); byFingerprint.set(key, queue);
  }
  for (let i = 0; i < after.length; i++) {
    work.stats.steps++;
    const value = after[i]!; const queue = byFingerprint.get(`${value.kind}/${value.fingerprint}`); const j = queue?.list[queue.next];
    if (j !== undefined) { matchedBefore.add(j); matchedAfter.add(i); queue!.next++; }
  }
  const byAnchor = new Map<string, { list: number[]; next: number }>();
  // Ordinals are assigned among remaining equal key paths, after equal fingerprints have been matched.
  const anchorGroup = (value: ScannedValue) => value.anchor.slice(0, value.anchor.lastIndexOf("/"));
  for (let i = 0; i < before.length; i++) {
    work.stats.steps++;
    if (matchedBefore.has(i)) continue;
    const key = anchorGroup(before[i]!); const queue = byAnchor.get(key) ?? { list: [], next: 0 }; queue.list.push(i); byAnchor.set(key, queue);
  }
  for (let i = 0; i < after.length; i++) {
    work.stats.steps++;
    if (matchedAfter.has(i)) continue;
    const value = after[i]!; const queue = byAnchor.get(anchorGroup(value)); const j = queue?.list[queue.next];
    if (j !== undefined) { matchedBefore.add(j); queue!.next++; items.push(makeItem(identity, before[j], value, "modified", work)); }
    else items.push(makeItem(identity, undefined, value, "added", work));
  }
  for (let i = 0; i < before.length; i++) { work.stats.steps++; if (!matchedBefore.has(i)) items.push(makeItem(identity, before[i], undefined, "removed", work)); }
  return items;
}
function scan(file: PromptChangedFile, before: boolean, info: PathInfo, work: Work): ScannedValue[] {
  if ((before && file.status === "added") || (!before && file.status === "removed")) return [];
  const text = before ? file.before : file.after; if (text === undefined) return [];
  if (info.prompt) return [{ kind: "prompt_file", basis: "path_rule", anchor: "file/0", fingerprint: fingerprint(text, work), line: file.hunks?.[0]?.afterLine || 1, family: null }];
  if (info.mode === "other") {
    if (!info.documentation && text.length > 0) work.reasons.add("unreadable_diff");
    if (info.embedded) {
      work.stats.steps += text.length * 4 + 1;
      // Embedded grammars are not parsed. Imports, SDK packages or member calls make coverage partial.
      // Plain prose such as 'create', 'chat' and 'ai' must not become a source-code signal.
      if (/^[ \t]*(?:import|from)[ \t]+/mu.test(text)) work.reasons.add("unreadable_diff");
      for (const token of text.matchAll(/[A-Za-z_$@][A-Za-z0-9_$@/.-]*/gu)) {
        const name = token[0]; const dot = name.lastIndexOf(".");
        const memberCall = dot > 0 && SDK_CALLS.has(name.slice(dot + 1));
        let end = token.index + name.length;
        if (memberCall) while (end < text.length && /\s/u.test(text[end]!)) end++;
        if ((name !== "ai" && knownSdk(name)) || (memberCall && text[end] === "(")) { work.reasons.add("unreadable_diff"); break; }
      }
    }
    return [];
  }
  if (!file.hunks) return scanPromptSource(info, text, work);
  const values: ScannedValue[] = [];
  const ordinals = new Map<string, number>();
  for (const hunk of file.hunks) {
    work.stats.steps++;
    const found = scanPromptSource(info, before ? hunk.before : hunk.after, work);
    for (const value of found) {
      const group = value.anchor.slice(0, value.anchor.lastIndexOf("/"));
      const ordinal = ordinals.get(group) ?? 0; ordinals.set(group, ordinal + 1); value.anchor = `${group}/${ordinal}`;
      value.line += (before ? hunk.beforeLine : hunk.afterLine) - 1; values.push(value); }
  }
  return values;
}
function isArray(value: unknown): boolean { return Array.isArray(value); }
function detect(input: PromptChangeInput, options: PromptChangeOptions, work: Work, fromDiff = false): PromptChangeItem[] {
  const caps = limits(options); const items: PromptChangeItem[] = [];
  if (!input || !isArray(input.files)) { work.reasons.add("unreadable_diff"); return items; }
  if (input.files.length > caps.files) { work.reasons.add("too_many_files"); work.stats.skippedFiles += input.files.length; return items; }
  const eligible: Array<{ file: PromptChangedFile; path: PathInfo; oldPath: PathInfo }> = []; let total = 0;
  const paths = new Set<string>(); let duplicate = false;
  for (const supplied of input.files) {
    work.stats.steps++;
    if (!supplied) { work.reasons.add("unreadable_diff"); continue; }
    // Only this invocation's parser can provide hunk text. Otherwise caps apply to before/after alone.
    const file: PromptChangedFile = { path: supplied.path };
    if (supplied.oldPath !== undefined) file.oldPath = supplied.oldPath;
    if (supplied.before !== undefined) file.before = supplied.before;
    if (supplied.after !== undefined) file.after = supplied.after;
    if (supplied.status !== undefined) file.status = supplied.status;
    if (supplied.binary !== undefined) file.binary = supplied.binary;
    if (supplied.wholeFile !== undefined) file.wholeFile = supplied.wholeFile;
    if (fromDiff && supplied.hunks !== undefined) file.hunks = supplied.hunks;
    if (!file || typeof file.path !== "string" || (file.oldPath !== undefined && typeof file.oldPath !== "string") || (file.before !== undefined && typeof file.before !== "string") || (file.after !== undefined && typeof file.after !== "string")) { work.reasons.add("unreadable_diff"); continue; }
    if ((file.wholeFile !== undefined && typeof file.wholeFile !== "boolean") || (file.binary !== undefined && typeof file.binary !== "boolean") || (file.status !== undefined && !["added", "removed", "modified", "renamed"].includes(file.status))) { work.reasons.add("unreadable_diff"); continue; }
    const path = inspectPath(file.path, work);
    const oldPath = file.oldPath === undefined || file.oldPath === file.path ? path : inspectPath(file.oldPath, work);
    if (paths.has(path.id)) duplicate = true;
    paths.add(path.id);
    if (!file.wholeFile) work.reasons.add("hunks_only");
    const pathBytes = path.bytes + (file.oldPath === undefined ? 0 : oldPath.bytes);
    work.stats.bytes += pathBytes; total += pathBytes;
    if (file.binary) { work.reasons.add("binary_file"); work.stats.skippedFiles++; continue; }
    if (file.before === undefined && file.after === undefined) { if (file.wholeFile) work.reasons.add("unreadable_diff"); work.stats.skippedFiles++;
      if (file.oldPath !== undefined && file.status === "renamed" && (path.prompt || oldPath.prompt)) eligible.push({ file, path, oldPath });
      continue;
    }
    if (file.wholeFile && ((file.before === undefined && file.status !== "added") || (file.after === undefined && file.status !== "removed"))) work.reasons.add("unreadable_diff");
    let tooLarge = false;
    for (const side of [file.before, file.after]) {
      if (side === undefined) continue;
      // UTF-16 length is a lower bound for UTF-8 length, so giant text is rejected before allocation/scanning.
      if (side.length > caps.fileBytes) { work.reasons.add("file_too_large"); tooLarge = true; continue; }
      const bytes = byteLength(side, work); work.stats.bytes += bytes; total += bytes;
      if (bytes > caps.fileBytes) { work.reasons.add("file_too_large"); tooLarge = true; }
    }
    if (tooLarge) work.stats.skippedFiles++; else eligible.push({ file, path, oldPath });
  }
  if (total > caps.totalBytes) { work.reasons.add("total_too_large"); work.stats.skippedFiles += eligible.length; return items; }
  if (duplicate) { work.reasons.add("unreadable_diff"); return items; }
  for (const { file, path, oldPath } of eligible) {
    work.stats.scannedFiles++;
    const identity: FileIdentity = { path: path.display, ...(file.oldPath === undefined ? {} : { oldPath: oldPath.display }), idPath: path.id };
    const before = scan(file, true, oldPath, work); const after = scan(file, false, path, work);
    if (file.oldPath !== undefined && file.oldPath !== file.path && (path.prompt || oldPath.prompt)) {
      // One rename item, even when only one of the two names satisfies a prompt-file rule.
      const entry = (text: string | undefined, line: number): ScannedValue | undefined => text === undefined ? undefined : { kind: "prompt_file", basis: "path_rule", anchor: "file/0", fingerprint: fingerprint(text, work), line, family: null };
      items.push(makeItem(identity, entry(file.before, 1), entry(file.after, file.hunks?.[0]?.afterLine || 1), "renamed", work));
    } else for (const item of pair(identity, before, after, work)) items.push(item);
  }
  return items;
}
function finish(items: PromptChangeItem[], options: PromptChangeOptions, work: Work): PromptChangeResult {
  // Comparison inputs are bounded (path <=512, fixed kind, SHA-256 id). Count comparisons as well as scans.
  items.sort((a, b) => { work.stats.steps += a.path.length + b.path.length + 132; return a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  const counts = { prompt_file: 0, prompt_text: 0, system_prompt: 0, model_name: 0, model_setting: 0, tool_schema: 0, model_endpoint: 0 };
  for (const item of items) { work.stats.steps++; counts[item.kind]++; }
  const incompleteReasons = PROMPT_CHANGE_INCOMPLETE_REASONS.filter((reason) => work.reasons.has(reason));
  const coverage = incompleteReasons.length === 0 ? "complete" : incompleteReasons.length === 1 && incompleteReasons[0] === "hunks_only" ? "hunks_only" : "partial";
  const report: PromptChangeReport = {
    schemaVersion: 1, status: items.length > PROMPT_CHANGE_LIMITS.items ? "changes" : coverage !== "complete" ? "incomplete" : items.length > 0 ? "changes" : "none_found", coverage, incompleteReasons, counts,
    items: items.slice(0, PROMPT_CHANGE_LIMITS.items), itemsTruncated: items.length > PROMPT_CHANGE_LIMITS.items,
    reportDigest: hash(canonicalJson(items.map((item) => [item.id, item.fingerprintBefore, item.fingerprintAfter])), work),
  };
  return options.stats ? { report, stats: { ...work.stats } } : { report };
}
export function detectPromptChanges(input: PromptChangeInput, options: PromptChangeOptions = {}): PromptChangeResult {
  const work = newWork();
  try { return finish(detect(input, options, work), options, work); }
  catch { work.reasons.add("unreadable_diff"); return finish([], {}, work); }
}
export function detectPromptChangesInDiff(diffText: string, options: PromptChangeOptions = {}): PromptChangeResult {
  const work = newWork();
  try { const parsed = parsePromptDiffInternal(diffText, options, work); return finish(detect(parsed, options, work, true), options, work); }
  catch { work.reasons.add("unreadable_diff"); return finish([], {}, work); }
}
