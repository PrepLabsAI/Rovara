// TE-R2 part A (M2, release 0.5.19; DECISIONS 161, 166b): the LEAK SCREENS. PURE: no I/O, no clock, no randomness, no Node module.
//
// WHY: the prompt of a captured call is written or shaped by the coding agent's own run. A real model would obey that prompt, so an independent reply that follows it is faithful (STEERING is not a leak, and nothing here judges it).
// SMUGGLING is the leak: a prompt that carries the diff, a test's expected answer or a test's name tells the "independent" agent what the test wants. These screens look for those three things and refuse the call when they find one.
//
// A refusal means "this call stays not counted": the coding agent's reply or `unmatched` stands. A screen NEVER blocks the task. Fixed words (code, never data): `prompt_has_diff`, `prompt_echoes_test_expectation`, `prompt_names_a_test`.
//
// `TaskLeakFacts` is built by the WORKER (Part B) from the changed TEST files' added lines with `buildTaskLeakFacts`, is used here and nowhere else, and never enters the brief or the agent.
//
// WHAT THE SCREENS DO NOT CATCH (the PR says so too): an answer smuggled in words they do not match (a paraphrase, an encoding, a code word, a translation, text split across fields), an expectation that is only in a test's fixture or
// helper file that was not changed in this task, and an expectation shorter than 6 characters. They are heuristics: they lower the risk, they do not PROVE independence, and nothing may call a reply "proven independent" because it passed them.
// They are language-agnostic string scans (no AST): an assertion line is any line with an assertion word; a literal is a quoted string of 6 or more characters on it. A prompt that legitimately contains such a literal is refused too:
// a false refusal costs a "not counted" label, never a wrong "counted".
import type { ReplyBrief } from "./model-reply-brief.js";

export const LEAK_REFUSALS = ["prompt_has_diff", "prompt_echoes_test_expectation", "prompt_names_a_test"] as const;
export type LeakRefusal = (typeof LEAK_REFUSALS)[number];
export type LeakScreenResult = { readonly ok: true } | { readonly ok: false; readonly reason: LeakRefusal };

export const LEAK_LITERAL_MIN_CHARS = 6;
const LEAK_LITERAL_MAX_CHARS = 2_048;
const LEAK_MAX_LITERALS = 2_000;
const LEAK_MAX_NAMES = 2_000;
const LEAK_MAX_LINE_CHARS = 4_096;
const LEAK_MAX_FILES = 500;

/** What the screens compare against. The worker builds it; it has no place in the brief. */
export interface TaskLeakFacts {
  /** Paths of the changed test files. */
  readonly testPaths: readonly string[];
  /** Test names found on the changed lines. */
  readonly testNames: readonly string[];
  /** String literals of 6 or more characters from assertion lines of the changed tests. */
  readonly expectationLiterals: readonly string[];
}
export interface ChangedTestFile {
  readonly path: string;
  /** The added or changed lines of the file (not the whole file). */
  readonly changedLines: readonly string[];
}

export const NO_TASK_LEAK_FACTS: TaskLeakFacts = { testPaths: [], testNames: [], expectationLiterals: [] };

const ASSERTION_LINE = /\b(?:expect|assert\w*|should|toBe\w*|toEqual|toStrictEqual|toContain\w*|toMatch\w*|toHaveBeenCalledWith|assertEqual|assert_eq|assertEquals|equal|Equal|want|expected)\b|==|!=/u;
const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/gu;
const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe|context|specify)(?:\.\w+)?\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`)/u,
  /\bdef\s+(test_\w+)/u,
  /\bfunc\s+(Test\w+)\s*\(/u,
  /\b(?:void|public)\s+(test\w+)\s*\(/u,
];

const unescape = (text: string): string => text.replace(/\\(["'`\\])/gu, "$1").replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");
const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * Builds the facts from the changed test files' added lines: test paths, test names (JS `it`/`test`/`describe`, Python `def test_`, Go `func Test`, Java `void test`) and the quoted literals of 6 or more characters on assertion lines.
 * Bounded: 500 files, 2,000 literals, 2,000 names, 4,096 characters per line, 2,048 per literal. Never throws.
 */
export function buildTaskLeakFacts(files: readonly ChangedTestFile[]): TaskLeakFacts {
  const testPaths: string[] = [];
  const names = new Set<string>();
  const literals = new Set<string>();
  for (const file of files.slice(0, LEAK_MAX_FILES)) {
    if (typeof file.path === "string" && file.path.length > 0) testPaths.push(file.path);
    for (const raw of file.changedLines) {
      if (typeof raw !== "string") continue;
      const line = raw.length > LEAK_MAX_LINE_CHARS ? raw.slice(0, LEAK_MAX_LINE_CHARS) : raw;
      for (const pattern of TEST_NAME_PATTERNS) {
        const found = pattern.exec(line);
        const name = found === null ? undefined : found.slice(1).find((part) => part !== undefined);
        if (name !== undefined && names.size < LEAK_MAX_NAMES) names.add(unescape(name));
      }
      if (!ASSERTION_LINE.test(line)) continue;
      for (const quoted of line.matchAll(QUOTED)) {
        const body = unescape(quoted[1] ?? quoted[2] ?? quoted[3] ?? "");
        if (body.length >= LEAK_LITERAL_MIN_CHARS && literals.size < LEAK_MAX_LITERALS) literals.add(body.slice(0, LEAK_LITERAL_MAX_CHARS));
      }
    }
  }
  return { testPaths, testNames: [...names], expectationLiterals: [...literals] };
}

/** Every piece of text a real model would read in the brief: the prompt text, the tool descriptions and the `description` and `title` strings of the schemas. */
export function briefReadableTexts(brief: ReplyBrief): string[] {
  const texts: string[] = [brief.promptText];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 16 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if ((key === "description" || key === "title") && typeof child === "string") texts.push(child);
      else walk(child, depth + 1);
    }
  };
  for (const tool of brief.shape.tools ?? []) {
    if (tool.description !== undefined) texts.push(tool.description);
    walk(tool.parametersSchema, 0);
  }
  walk(brief.shape.jsonSchema, 0);
  return texts;
}

const hasDiffMarker = (text: string): boolean => text.includes("diff --git") || text.includes("@@ -") || text.includes("+++ b/");

/**
 * Screens a brief. In order: diff markers (`diff --git`, `@@ -`, `+++ b/`) anywhere a model would read; a literal from an assertion line of the changed tests (exact, or with white space collapsed); a changed test file's path or
 * basename, or a changed test's name. The first hit refuses. Pure and fast: the text is bounded (the brief's own bounds) and the facts are capped.
 */
export function screenBrief(brief: ReplyBrief, taskFacts: TaskLeakFacts): LeakScreenResult {
  const texts = briefReadableTexts(brief);
  if (texts.some(hasDiffMarker)) return { ok: false, reason: "prompt_has_diff" };
  const collapsed = texts.map(collapse);
  for (const literal of taskFacts.expectationLiterals) {
    if (literal.length < LEAK_LITERAL_MIN_CHARS) continue;
    const flat = collapse(literal);
    if (texts.some((text) => text.includes(literal)) || (flat.length >= LEAK_LITERAL_MIN_CHARS && collapsed.some((text) => text.includes(flat)))) return { ok: false, reason: "prompt_echoes_test_expectation" };
  }
  for (const path of taskFacts.testPaths) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    for (const needle of [path, base]) {
      if (needle.length >= LEAK_LITERAL_MIN_CHARS && texts.some((text) => text.includes(needle))) return { ok: false, reason: "prompt_names_a_test" };
    }
  }
  for (const name of taskFacts.testNames) {
    if (name.length >= LEAK_LITERAL_MIN_CHARS && texts.some((text) => text.includes(name))) return { ok: false, reason: "prompt_names_a_test" };
  }
  return { ok: true };
}
