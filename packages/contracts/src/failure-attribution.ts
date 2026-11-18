// Failure attribution (TE-A6, DEC 254zt): the pure join of one check's FAILING tests to the files and commits the change touched. For each failing test it names the change that most likely broke it, or says "unknown".
// Why: "3 failed" tells a reviewer nothing about where to look. But a wrong name is worse than no name, so a test is joined to a change only on strong, unique evidence, and every doubt is `unknown`. Nothing is ever guessed.
//
// The evidence, and how much each is worth (`FAILURE_SIGNAL_SCORES`):
//   named_in_failure  3  the test's own failure text (its assertion message or stack) names a file the change touched. The strong signal: the code that failed is in the change.
//   own_test_file     2  the failing test lives in a file the change touched. Weak on its own: the test was edited, but the break may come from elsewhere, so it never names a change alone.
// A change is a commit when one is known (every changed file of one commit is the same change), otherwise one file. Its score is each signal counted once. A test is joined to a change only when the best score reaches
// `FAILURE_MIN_SCORE` AND beats the next change by at least `FAILURE_MIN_MARGIN`. Otherwise it is `unknown` with a fixed reason: nothing pointed at a change, only weak evidence, or several changes fit equally well.
//
// What it never does:
//   - It never reads a file or a clock, and it copies nothing from the failure text into the result: only the changed paths the caller gave, a commit id the caller gave, and the fixed words below.
//   - It never names a deleted file, and never matches a path that is only the end of another name (`xsrc/a.ts` is not `src/a.ts`).
//   - It never cuts a long input short: past a limit the whole check is `per_check` with a fixed reason, and the caller shows what it showed before.
// Bounded: at most 50 failing tests, 5,000 changed files, 4,000 characters of text for one test and 120,000 in all; each token of the text is looked up under at most 16 path endings. Nothing here imports a Node module.

export const FAILURE_ATTRIBUTION_LIMITS = { failuresMax: 50, changesMax: 5_000, textMax: 4_000, totalTextMax: 120_000, pathMax: 500, idMax: 500, pathsShown: 3 } as const;
/** The most path segments of a token looked up from its end. A changed path with more segments than this is never matched (the test is then `unknown`, never wrongly named). */
const SEGMENTS_MAX = 16;
const TOKEN_MAX = 500;

export const FAILURE_SIGNALS = ["named_in_failure", "own_test_file"] as const;
export type FailureSignal = (typeof FAILURE_SIGNALS)[number];
export const FAILURE_SIGNAL_SCORES: Record<FailureSignal, number> = { named_in_failure: 3, own_test_file: 2 };
/** The least score that names a change. One strong signal reaches it; the weak one alone does not. */
export const FAILURE_MIN_SCORE = 3;
/** How far the best change must be ahead of the next one. A tie is `several_changes`. */
export const FAILURE_MIN_MARGIN = 1;

export const FAILURE_UNKNOWN_REASONS = ["no_failure_details", "no_changed_file_named", "weak_evidence", "several_changes"] as const;
export type FailureUnknownReason = (typeof FAILURE_UNKNOWN_REASONS)[number];
/** The words after "unknown:" for each reason. Fixed text: nothing a repository wrote. */
export const FAILURE_UNKNOWN_WORDS: Record<FailureUnknownReason, string> = {
  no_failure_details: "the report gave no failure details",
  no_changed_file_named: "the failure names no changed file",
  weak_evidence: "only weak evidence",
  several_changes: "several changes fit equally",
};

export const FAILURE_PER_CHECK_REASONS = ["no_failures", "too_many_failures", "too_many_changes", "too_much_text", "duplicate_ids", "bad_input"] as const;
export type FailurePerCheckReason = (typeof FAILURE_PER_CHECK_REASONS)[number];

export interface FailureInput {
  /** The test's id (`file::name`). */
  id: string;
  /** The test's file as the id names it, relative to the repository root. Absent when the report did not say. */
  file?: string;
  /** The test's own failure message or stack, as the report wrote it (redacted and cut by the caller). Read, never copied. */
  text?: string;
}
export interface FailureChange {
  /** The changed file, relative to the repository root. Unique in one call (give a repository prefix when several repositories are joined). */
  path: string;
  status: "ADDED" | "MODIFIED" | "DELETED" | "UNPLACEABLE";
  /** The one commit that changed this file in the task's range. Only when the caller knows that exactly one did; otherwise leave it out. A full 40 (or 64) character lowercase hex id. */
  commit?: string;
}
export interface FailureAttributionInput {
  failures: readonly FailureInput[];
  changes: readonly FailureChange[];
}
export type FailureCause =
  | { kind: "change"; paths: string[]; pathsCount: number; commit?: string; basis: FailureSignal[] }
  | { kind: "unknown"; reason: FailureUnknownReason };
export type FailureAttribution =
  | { mode: "per_test"; results: Array<{ testId: string; cause: FailureCause }> }
  | { mode: "per_check"; reason: FailurePerCheckReason };

const perCheck = (reason: FailurePerCheckReason): FailureAttribution => ({ mode: "per_check", reason });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const STATUSES: ReadonlySet<unknown> = new Set(["ADDED", "MODIFIED", "DELETED", "UNPLACEABLE"]);
/** A line of plain text: a non-empty string without control or hidden characters, at most `max` long. */
const plain = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !HIDDEN.test(value);

/** The characters that end a token of failure text: spaces, quotes, brackets, separators. A path is read as one token. */
const TOKEN_SPLIT = /[\s"'`()<>[\]{}|,;=]+/u;

/** Parts of a path that are somebody else's code: a frame inside one never names a file of the change. */
const FOREIGN = /(?:^|\/)(?:node_modules|\.git|site-packages|dist-packages)\//u;

/** The token without trailing punctuation and `:line:column`, each removed from the end in one backwards pass (no regex that can rescan a long run). */
function withoutTail(token: string): { text: string; line: boolean } {
  let end = token.length;
  let line = false;
  for (;;) {
    const before = end;
    while (end > 0 && ".,:!?".includes(token[end - 1]!)) end -= 1;
    let digits = end;
    while (digits > 0 && token.charCodeAt(digits - 1) >= 48 && token.charCodeAt(digits - 1) <= 57) digits -= 1;
    if (digits < end && digits > 0 && token[digits - 1] === ":") { end = digits - 1; line = true; }
    if (end === before) break;
  }
  return { text: token.slice(0, end), line };
}

/**
 * The paths among `paths` that a failure text names, each once, sorted. A text names a path when a token of it (split at spaces, quotes and brackets, backslashes read as slashes, a `file://` start, a trailing `:line:column`
 * and trailing punctuation removed) IS the path or ENDS with it after a `/`. A path with no `/` (a root file such as `index.ts`) is named only by a token that is exactly it with a `:line` after it: its name alone also ends other packages' files and is ordinary prose.
 * A token inside `node_modules`, `.git` or `site-packages` names nothing. Bounded: each token is cut to its last 500 characters, stripped in one backwards pass, and looked up under at most 16 endings.
 */
export function namedChangedPaths(text: string, paths: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  if (text === "" || paths.size === 0) return [];
  for (const piece of text.split(TOKEN_SPLIT)) {
    if (piece === "") continue;
    // A token longer than a path can be keeps its end only; its start is then not a whole name, so only the endings after a slash are looked up.
    const cut = piece.length > TOKEN_MAX;
    const { text: token, line } = withoutTail((cut ? piece.slice(-TOKEN_MAX) : piece).replaceAll("\\", "/").replace(/^file:\/\//u, ""));
    if (token === "" || FOREIGN.test(token)) continue;
    // A root file (no `/`) is named only as `name:line`: its bare name is also ordinary prose ("cannot read package.json").
    if (!cut && paths.has(token) && (token.includes("/") || line)) found.add(token);
    let end = token.length;
    for (let segments = 0; segments < SEGMENTS_MAX && end > 0; segments += 1) {
      const slash = token.lastIndexOf("/", end - 1);
      if (slash === -1) break;
      const ending = token.slice(slash + 1);
      if (ending.includes("/") && paths.has(ending)) found.add(ending);
      end = slash;
    }
  }
  return [...found].sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Unit {
  key: string;
  commit?: string;
}

/** The test's file: the one it gave, else what its id says before `::`, with `./` and backslashes made plain. */
function ownFileOf(test: FailureInput): string | undefined {
  const raw = test.file ?? (test.id.includes("::") ? test.id.slice(0, test.id.indexOf("::")) : undefined);
  const file = raw?.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
  return file === undefined || file === "" ? undefined : file;
}
/** The same file spelled two ways: equal, or one is the end of the other after a `/` (a package-relative path against a repository-relative one). */
function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Joins one check's failing tests to the change. Never throws: an input that throws when read (a getter, a proxy) is `bad_input`. */
export function attributeFailures(input: FailureAttributionInput): FailureAttribution {
  try {
    return join(input);
  } catch {
    return perCheck("bad_input");
  }
}

function join(input: FailureAttributionInput): FailureAttribution {
  if (!isRecord(input) || !Array.isArray(input.failures) || !Array.isArray(input.changes)) return perCheck("bad_input");
  const failures = input.failures as readonly unknown[];
  const changes = input.changes as readonly unknown[];
  if (failures.length === 0) return perCheck("no_failures");
  if (failures.length > FAILURE_ATTRIBUTION_LIMITS.failuresMax) return perCheck("too_many_failures");
  if (changes.length > FAILURE_ATTRIBUTION_LIMITS.changesMax) return perCheck("too_many_changes");

  // Every input is read once, each field into a local, at runtime, before anything is joined.
  const tests: FailureInput[] = [];
  const ids = new Set<string>();
  let totalText = 0;
  let tooMuch = false;
  for (const entry of failures) {
    if (!isRecord(entry)) return perCheck("bad_input");
    const { id, file, text } = entry;
    if (!plain(id, FAILURE_ATTRIBUTION_LIMITS.idMax)) return perCheck("bad_input");
    if (file !== undefined && !plain(file, FAILURE_ATTRIBUTION_LIMITS.pathMax)) return perCheck("bad_input");
    if (text !== undefined && typeof text !== "string") return perCheck("bad_input");
    if (text !== undefined) {
      if (text.length > FAILURE_ATTRIBUTION_LIMITS.textMax) tooMuch = true;
      totalText += text.length;
    }
    if (ids.has(id)) return perCheck("duplicate_ids");
    ids.add(id);
    tests.push({ id, ...(file === undefined ? {} : { file }), ...(text === undefined ? {} : { text }) });
  }
  const unitOf = new Map<string, Unit>();
  const units = new Map<string, Unit>();
  const status = new Map<string, FailureChange["status"]>();
  for (const entry of changes) {
    if (!isRecord(entry)) return perCheck("bad_input");
    const { path, commit } = entry;
    const state = entry.status;
    if (!plain(path, FAILURE_ATTRIBUTION_LIMITS.pathMax) || !STATUSES.has(state)) return perCheck("bad_input");
    if (commit !== undefined && (typeof commit !== "string" || !COMMIT.test(commit))) return perCheck("bad_input");
    if (unitOf.has(path)) return perCheck("bad_input");
    const key = commit ?? `file\u0000${path}`;
    const unit = units.get(key) ?? { key, ...(commit === undefined ? {} : { commit }) };
    units.set(key, unit);
    unitOf.set(path, unit);
    status.set(path, state as FailureChange["status"]);
  }
  if (tooMuch || totalText > FAILURE_ATTRIBUTION_LIMITS.totalTextMax) return perCheck("too_much_text");
  // A deleted file is never named as a cause, but it still counts as a rival: a failure about a file the change removed is not evidence for another change.
  const all = new Set(unitOf.keys());
  const isLive = (path: string): boolean => status.get(path) !== "DELETED";

  const results: Array<{ testId: string; cause: FailureCause }> = [];
  for (const test of tests) {
    const ownFile = ownFileOf(test);
    const named = new Map<Unit, Set<string>>();
    const own = new Map<Unit, Set<string>>();
    for (const path of test.text === undefined ? [] : namedChangedPaths(test.text, all)) {
      // A stack always names the test's own file (however the id spells it): that is the own-file signal, never counted twice.
      if (ownFile !== undefined && sameFile(path, ownFile)) continue;
      const unit = unitOf.get(path)!;
      named.set(unit, (named.get(unit) ?? new Set<string>()).add(path));
    }
    if (ownFile !== undefined) {
      const matches = [...all].filter((path) => sameFile(path, ownFile));
      if (matches.length === 1 && isLive(matches[0]!)) own.set(unitOf.get(matches[0]!)!, new Set<string>([matches[0]!]));
    }
    const scored = [...new Set([...named.keys(), ...own.keys()])].map((unit) => ({
      unit,
      score: (named.has(unit) ? FAILURE_SIGNAL_SCORES.named_in_failure : 0) + (own.has(unit) ? FAILURE_SIGNAL_SCORES.own_test_file : 0),
    })).sort((a, b) => b.score - a.score || compareText(a.unit.key, b.unit.key));
    const top = scored[0];
    const unknown = (reason: FailureUnknownReason): void => { results.push({ testId: test.id, cause: { kind: "unknown", reason } }); };
    if (top === undefined) unknown(test.text === undefined || test.text === "" ? "no_failure_details" : "no_changed_file_named");
    else if (top.score < FAILURE_MIN_SCORE) unknown("weak_evidence");
    else if (scored[1] !== undefined && top.score - scored[1].score < FAILURE_MIN_MARGIN) unknown("several_changes");
    else {
      const livePaths = (set: Set<string> | undefined): string[] => [...(set ?? [])].filter(isLive);
      const paths = [...new Set([...livePaths(named.get(top.unit)), ...livePaths(own.get(top.unit))])].sort(compareText);
      if (paths.length === 0) unknown("no_changed_file_named");
      else {
        const basis = FAILURE_SIGNALS.filter((signal) => (signal === "named_in_failure" ? livePaths(named.get(top.unit)).length > 0 : own.has(top.unit)));
        results.push({ testId: test.id, cause: { kind: "change", paths: paths.slice(0, FAILURE_ATTRIBUTION_LIMITS.pathsShown), pathsCount: paths.length, ...(top.unit.commit === undefined ? {} : { commit: top.unit.commit }), basis } });
      }
    }
  }
  return { mode: "per_test", results };
}
