// Additive spot-check planning and fixed result words; no runner, filesystem or evidence publication.
// Conservative lexer: string/comment lines, ambiguous slash/angle lines, decorators and type-only
// declarations are skipped. Python f-string files and multiline type declarations are skipped whole.
// Nothing from a source file or test report is a display string. Mutant paths/replacements stay internal.
import { createHash } from "node:crypto";

export const MUTATION_SPOT_LIMITS = {
  maxMutants: 10, maxFiles: 20, maxFileBytes: 1024 * 1024, maxLineChars: 400,
  totalTimeMs: 5 * 60_000, perMutantTimeMs: 60_000,
} as const;
export type MutationLimits = { [K in keyof typeof MUTATION_SPOT_LIMITS]: number };
export type MutationOperator = "comparison" | "logical" | "boolean" | "integer" | "condition";
export interface SpotMutant { path: string; line: number; start: number; end: number; replacement: string; operator: MutationOperator }
export interface MutationLines { path: string; hunks: ReadonlyArray<readonly [number, number]> }
export type MutationReason = "unsupported_language" | "path_refused" | "no_mutants" | "no_tests" | "no_results" | "unreadable" | "candidate_changed" | "timed_out" | "partial" | "baseline_failed" | "repo_too_large";
export type MutationOutcome = "caught" | "survived" | "invalid" | "timed_out" | "not_run";
export type MutationMethod = "coverage_map" | "import_graph" | "affected";
export interface MutationSpotResult {
  status: "completed" | "not_run";
  reason?: MutationReason;
  trustedAfter: boolean;
  skippedLanguageFiles?: number;
  caught: number;
  counted: number;
  mutants: Array<{ line: number; operator: MutationOperator; outcome: MutationOutcome; method: MutationMethod }>;
  refusals: Array<{ reason: "path_refused"; fingerprint: string }>;
}
export interface MutationPlan {
  skippedLanguageFiles: number;
  mutants: SpotMutant[];
  reason?: MutationReason;
  refusals: MutationSpotResult["refusals"];
  /** Work counter for the bounded lexer, including characters skipped inside literals. */
  steps: number;
  filesScanned: number;
}
export function mutationLimits(overrides: Partial<MutationLimits> = {}): MutationLimits {
  const bound = (key: keyof MutationLimits) => {
    const value = overrides[key];
    return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), MUTATION_SPOT_LIMITS[key]) : MUTATION_SPOT_LIMITS[key];
  };
  return { maxMutants: bound("maxMutants"), maxFiles: bound("maxFiles"), maxFileBytes: bound("maxFileBytes"), maxLineChars: bound("maxLineChars"), totalTimeMs: bound("totalTimeMs"), perMutantTimeMs: bound("perMutantTimeMs") };
}
export const mutationPathRefused = (path: string): boolean => path.length > 512 || /[\p{Cc}\p{Cf}\p{M}]/u.test(path);
export const mutationPathFingerprint = (path: string): string => createHash("sha256").update(path).digest("hex");
export const mutationLanguage = (path: string): "python" | "javascript" | undefined => path.endsWith(".py") ? "python" : /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path) ? "javascript" : undefined;

const SWAPS: ReadonlyMap<string, string> = new Map([
  ["===", "!=="], ["!==", "==="], ["==", "!="], ["!=", "=="], ["<=", ">"], [">=", "<"], ["<", ">="], [">", "<="],
  ["&&", "||"], ["||", "&&"], ["and", "or"], ["or", "and"], ["true", "false"], ["false", "true"], ["True", "False"], ["False", "True"],
]);
const WORD = /[\p{ID_Continue}$.]/u;
type Frame = { kind: "quote"; delimiter: string; escaped: boolean } | { kind: "template"; escaped: boolean } | { kind: "interpolation"; depth: number } | { kind: "comment" };

function lex(text: string, python: boolean, lineLimit: number): { lines: Array<{ text: string; start: number; line: number }>; steps: number } {
  const lines: Array<{ text: string; start: number; line: number }> = [];
  const stack: Frame[] = [];
  let start = 0; let line = 1; let unsafe = false; let lineComment = false; let steps = 0;
  // F-string grammars vary across Python versions (including same-quote nesting). Do not guess.
  if (python && /\b(?:f|fr|rf)["']/iu.test(text)) return { lines, steps: text.length };
  for (let i = 0; i <= text.length; i += 1) {
    steps += 1;
    const ch = text[i];
    if (ch === "\n" || i === text.length) {
      const value = text.slice(start, i);
      if (!unsafe && stack.length === 0 && value.length <= lineLimit) lines.push({ text: value, start, line });
      start = i + 1; line += 1; lineComment = false; unsafe = stack.length > 0;
      continue;
    }
    if (lineComment) continue;
    const frame = stack.at(-1);
    if (frame?.kind === "comment") {
      unsafe = true;
      if (ch === "*" && text[i + 1] === "/") { stack.pop(); i += 1; steps += 1; }
      continue;
    }
    if (frame?.kind === "quote") {
      unsafe = true;
      if (frame.escaped) { frame.escaped = false; continue; }
      if (ch === "\\") { frame.escaped = true; continue; }
      if (text.startsWith(frame.delimiter, i)) { stack.pop(); i += frame.delimiter.length - 1; steps += frame.delimiter.length - 1; }
      continue;
    }
    if (frame?.kind === "template") {
      unsafe = true;
      if (frame.escaped) { frame.escaped = false; continue; }
      if (ch === "\\") { frame.escaped = true; continue; }
      if (ch === "`") { stack.pop(); continue; }
      if (ch === "$" && text[i + 1] === "{") { stack.push({ kind: "interpolation", depth: 1 }); i += 1; steps += 1; }
      if (stack.length > 64) return { lines: [], steps };
      continue;
    }
    if (frame?.kind === "interpolation") {
      unsafe = true;
      if (ch === "{") frame.depth += 1;
      if (ch === "}") { frame.depth -= 1; if (frame.depth === 0) { stack.pop(); continue; } }
    }
    if (ch === '"' || ch === "'") {
      const delimiter = python && text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      stack.push({ kind: "quote", delimiter, escaped: false }); unsafe = true;
      i += delimiter.length - 1; steps += delimiter.length - 1;
    } else if (!python && ch === "`") { stack.push({ kind: "template", escaped: false }); unsafe = true; }
    else if (python && ch === "#") { lineComment = true; unsafe = true; }
    else if (!python && ch === "/" && text[i + 1] === "*") { stack.push({ kind: "comment" }); unsafe = true; i += 1; steps += 1; }
    else if (!python && ch === "/") { lineComment = text[i + 1] === "/"; unsafe = true; }
    if (stack.length > 64) return { lines: [], steps };
  }
  if (stack.length > 0) return { lines: [], steps };
  return { lines, steps };
}

function lineMutants(path: string, text: string, start: number, line: number, python: boolean): SpotMutant[] {
  if (/^\s*(?:(?:export|default)\s+)*(?:type|interface|declare|import)\b/u.test(text) || text.includes("@")) return [];
  // Conservatively skip annotations, object fields and assertions rather than mutate literal types.
  if (!python && (text.includes(":") || /\b(?:as|satisfies)\b/u.test(text))) return [];
  // A generic or JSX delimiter is ambiguous. Treat the complete comparison token as one operator.
  for (const token of text.matchAll(/<=?|>=?/gu)) if (!/\s/u.test(text[token.index - 1] ?? "") || !/\s/u.test(text[token.index + token[0].length] ?? "")) return [];
  const result: SpotMutant[] = [];
  const add = (at: number, length: number, replacement: string, operator: MutationOperator) => result.push({ path, line, start: start + at, end: start + at + length, replacement, operator });
  for (const match of text.matchAll(/===|!==|==|!=|<=|>=|<|>|&&|\|\||\b(?:and|or|true|false|True|False)\b|\b\d+\b/gu)) {
    const token = match[0]; const at = match.index;
    if (/^\w/u.test(token) && (WORD.test(text[at - 1] ?? "") || WORD.test(text[at + token.length] ?? ""))) continue;
    if (/^\d/u.test(token)) {
      const value = Number(token);
      if (Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER) add(at, token.length, String(value + 1), "integer");
    } else if (["true", "false", "True", "False"].includes(token)) {
      if (python === (token[0] === token[0]!.toUpperCase())) add(at, token.length, SWAPS.get(token)!, "boolean");
    } else if (["and", "or", "&&", "||"].includes(token)) {
      if (python === /^[a-z]/u.test(token)) add(at, token.length, SWAPS.get(token)!, "logical");
    } else add(at, token.length, SWAPS.get(token)!, "comparison");
  }
  const condition = python ? /^\s*if\s+([^:]+):\s*$/u.exec(text) : /\bif\s*\(/u.exec(text);
  if (condition !== null) {
    if (python) { const value = condition[1]!; const at = text.indexOf(value); add(at, value.length, `not (${value})`, "condition"); }
    else {
      const at = condition.index + condition[0].length; let depth = 1; let end = at;
      for (; end < text.length; end += 1) { if (text[end] === "(") depth += 1; if (text[end] === ")" && --depth === 0) break; }
      if (depth === 0 && end > at) add(at, end - at, `!(${text.slice(at, end)})`, "condition");
    }
  }
  return result;
}

/** Worker-supplied changed ranges only. Seeded round-robin selection spreads across files and operators. */
export function planMutants(files: ReadonlyArray<{ path: string; text: string }>, changedLines: readonly MutationLines[], seed: string, overrides: Partial<MutationLimits> = {}): MutationPlan {
  const limits = mutationLimits(overrides);
  const plan: MutationPlan = { skippedLanguageFiles: new Set(changedLines.filter(({ path }) => mutationLanguage(path) === undefined).map(({ path }) => path)).size, mutants: [], refusals: [], steps: 0, filesScanned: 0 };
  for (const { path } of changedLines) if (mutationPathRefused(path)) plan.refusals.push({ reason: "path_refused", fingerprint: mutationPathFingerprint(path) });
  if (plan.refusals.length > 0) return { ...plan, reason: "path_refused" };
  const changed = new Map(changedLines.map((file) => [file.path, file.hunks]));
  const rank = (value: string) => mutationPathFingerprint(`${seed}\0${value}`);
  const queues: SpotMutant[][] = [];
  for (const file of files.filter(({ path }) => mutationLanguage(path) !== undefined).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(0, limits.maxFiles)) {
    plan.filesScanned += 1;
    if (file.text.length > limits.maxFileBytes || Buffer.byteLength(file.text) > limits.maxFileBytes) continue;
    const ranges = changed.get(file.path) ?? [];
    const python = mutationLanguage(file.path) === "python";
    const scanned = lex(file.text, python, limits.maxLineChars); plan.steps += scanned.steps;
    // Multiline type syntax can contain literal-looking fields; skip the file instead of guessing where it ends.
    if (!python && file.text.split("\n").some((line) => /^\s*(?:export\s+)?(?:interface\b|type\b[^;]*$)/u.test(line))) continue;
    // Difference array avoids scanning every hunk for every line (an adversarial diff can have many hunks).
    const lineCount = file.text.split("\n").length;
    const changes = new Int32Array(lineCount + 2);
    for (const [first, last] of ranges) {
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || first > lineCount) continue;
      changes[first] = changes[first]! + 1;
      changes[Math.min(last, lineCount) + 1] = changes[Math.min(last, lineCount) + 1]! - 1;
    }
    let cursor = 0; let changedCount = 0;
    const choices = scanned.lines.flatMap((line) => {
      while (cursor < line.line) { cursor += 1; changedCount += changes[cursor]!; }
      return changedCount > 0 ? lineMutants(file.path, line.text, line.start, line.line, python) : [];
    });
    const groups = new Map<MutationOperator, SpotMutant[]>();
    for (const choice of choices) {
      const group = groups.get(choice.operator) ?? [];
      if (group.length < limits.maxMutants) group.push(choice);
      groups.set(choice.operator, group);
    }
    const ordered = [...groups].sort(([a], [b]) => rank(a).localeCompare(rank(b))).map(([, group]) => group);
    const queue: SpotMutant[] = [];
    while (ordered.some((group) => group.length > 0)) for (const group of ordered) { const next = group.shift(); if (next !== undefined) queue.push(next); }
    if (queue.length > 0) queues.push(queue);
  }
  queues.sort((a, b) => rank(a[0]!.path).localeCompare(rank(b[0]!.path)));
  for (let round = 0; plan.mutants.length < limits.maxMutants && queues.some((queue) => queue.length > round); round += 1) {
    for (let file = 0; file < queues.length && plan.mutants.length < limits.maxMutants; file += 1) {
      const queue = queues[file]!;
      // Rotate operators across files, while keeping each file's choices unique.
      const choice = round < queue.length ? queue[(round + file) % queue.length] : undefined;
      if (choice !== undefined) plan.mutants.push(choice);
    }
  }
  return plan.mutants.length === 0 ? { ...plan, reason: plan.skippedLanguageFiles > 0 && plan.filesScanned === 0 ? "unsupported_language" : "no_mutants" } : plan;
}

export const MUTATION_NOT_RUN_WORDS: Readonly<Record<MutationReason, string>> = {
  partial: "the mutation spot check ended before all planted changes ran",
  baseline_failed: "not run: baseline failed", repo_too_large: "not run: repo too large",
  unsupported_language: "not run: the mutation spot check covers TypeScript, JavaScript and Python today",
  path_refused: "not run: a file path was refused", no_mutants: "not run: no safe changed-line mutations were available",
  no_tests: "not run: covering tests with a named report could not be selected",
  no_results: "not run: no mutation produced a usable test result", unreadable: "not run: the mutation spot check could not read a safe copy",
  candidate_changed: "not run: the candidate working copy changed; re-export the candidate", timed_out: "not run: the mutation spot check timed out",
};
function validCounts(result: MutationSpotResult): boolean {
  return result.trustedAfter && result.status === "completed" && Number.isSafeInteger(result.caught) && Number.isSafeInteger(result.counted)
    && result.counted > 0 && result.counted <= MUTATION_SPOT_LIMITS.maxMutants && result.caught >= 0 && result.caught <= result.counted;
}
export function mutationSentence(result: MutationSpotResult): string {
  const sentence = validCounts(result) ? `tests caught ${result.caught} of ${result.counted} planted changes` : MUTATION_NOT_RUN_WORDS[result.reason ?? "no_mutants"];
  const skipped = result.skippedLanguageFiles;
  return sentence + (Number.isSafeInteger(skipped) && skipped! > 0 ? `; ${skipped} changed files not checked (language)` : "");
}
/** Entry only. A4's FILE source and the evidence baseline are deliberately not invented here. */
export function mutationMeasureEntry(result: MutationSpotResult): { name: string; unit: string; value: number; count: number; direction: "up_good" } | undefined {
  return validCounts(result) ? { name: "mutants caught", unit: "mutants", value: result.caught, count: result.counted, direction: "up_good" } : undefined;
}
