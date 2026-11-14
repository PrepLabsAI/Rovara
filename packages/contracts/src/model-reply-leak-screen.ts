// TE-R2 part A (M2, release 0.5.19; DECISIONS 161, 166b): the LEAK SCREENS. PURE: no I/O, no clock, no randomness, no Node module.
//
// WHY: the prompt of a captured call is written or shaped by the coding agent's own run. A real model would obey that prompt, so an independent reply that follows it is faithful (STEERING is not a leak, and nothing here judges it).
// SMUGGLING is the leak: a prompt that carries the diff, a test's expected answer or a test's name tells the "independent" agent what the test wants. These screens look for those three things and refuse the call when they find one.
//
// A refusal means "this call stays not counted": the coding agent's reply or `unmatched` stands. A screen NEVER blocks the task. Fixed words (code, never data): `prompt_has_diff`, `prompt_echoes_test_expectation`, `prompt_names_a_test`.
//
// `TaskLeakFacts` is built by the WORKER (Part B) from the added lines of the changed TEST files and of the changed fixture or data files under test directories, with `buildTaskLeakFacts`. It is used here and nowhere else, and never
// enters the brief or the agent.
//
// WHAT IS SCREENED: everything the agent is sent, exactly as it is sent (`replyRequestData`, the same description `buildAgentInput` serializes): the prompt, every string AND every key of the declared schema (enum, const, default,
// examples, $comment, descriptions, property names), tool names and descriptions, and the model name. WHAT IT IS SCREENED AGAINST: every string literal of 6 or more characters on any changed test line (not only assertion lines: a
// `const WANTED = ...` or a multi-line `toEqual` is caught), the lines and values of changed data files, test names and test paths. Both sides are normalized first (NFKC, lower case, zero-width and other format characters removed, entities
// decoded, white space collapsed) and base64, hex and URL-encoded runs of 16 or more characters in the request are decoded and screened too.
//
// WHAT THE SCREENS DO NOT CATCH (the PR says so too): an answer smuggled in words they do not match (a paraphrase, rot13 or another cipher, a translation, a code word, an answer built from words spread over fields, digits spelled out), a
// literal shorter than 6 characters, an expectation that lives only in a fixture or helper file that was not changed in this task, and an expectation held in a multi-line string. They are heuristics: they lower the risk, they do not
// PROVE independence, and nothing may call a reply "proven independent" because it passed them (see `INDEPENDENT_REPLY_CAVEAT`). A prompt that legitimately contains a test's own input is refused too: a false refusal costs a "not counted"
// label, never a wrong "counted". If the facts were cut at a bound (`truncated`), the screen refuses everything (`leak_facts_incomplete`): it never passes a call it could not fully check.
import { replyRequestData, type ReplyBrief } from "./model-reply-brief.js";

export const LEAK_REFUSALS = ["prompt_has_diff", "prompt_echoes_test_expectation", "prompt_names_a_test", "leak_facts_incomplete"] as const;
export type LeakRefusal = (typeof LEAK_REFUSALS)[number];
export type LeakScreenResult = { readonly ok: true } | { readonly ok: false; readonly reason: LeakRefusal };

export const LEAK_LITERAL_MIN_CHARS = 6;
const LEAK_LITERAL_MAX_CHARS = 2_048;
const LEAK_MAX_LITERALS = 4_000;
const LEAK_MAX_NAMES = 2_000;
const LEAK_MAX_LINE_CHARS = 4_096;
const LEAK_MAX_FILES = 500;
const DECODE_MAX_RUNS = 200;
const DECODE_MAX_CHARS = 256 * 1024;

/** What the screens compare against. The worker builds it; it has no place in the brief. */
export interface TaskLeakFacts {
  /** Paths of the changed test and test-data files. */
  readonly testPaths: readonly string[];
  /** Test names found on the changed lines. */
  readonly testNames: readonly string[];
  /** Every string literal of 6 or more characters from the changed test lines and the changed data files' values. */
  readonly expectationLiterals: readonly string[];
  /** The facts were cut at a bound: the screen refuses every call (it cannot fully check). */
  readonly truncated: boolean;
}
export interface ChangedTestFile {
  readonly path: string;
  /** The added or changed lines of the file (not the whole file). */
  readonly changedLines: readonly string[];
}

export const NO_TASK_LEAK_FACTS: TaskLeakFacts = { testPaths: [], testNames: [], expectationLiterals: [], truncated: false };

const DATA_FILE = /\.(?:json|jsonl|ndjson|ya?ml|txt|csv|tsv|md|toml|xml|html?)$/iu;
const CELL_FILE = /\.(?:csv|tsv)$/iu;
const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/gu;
const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe|context|specify)(?:\.\w+)?\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`)/u,
  /\bdef\s+(test_\w+)/u,
  /\bfunc\s+(Test\w+)\s*\(/u,
  /\b(?:void|public)\s+(test\w+)\s*\(/u,
];

const unescape = (text: string): string => text.replace(/\\(["'`\\])/gu, "$1").replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");

/**
 * Builds the facts from the added lines of the changed test files and of the changed fixture or data files under test directories: test paths, test names (JS `it`/`test`/`describe`, Python `def test_`, Go `func Test`, Java `void test`),
 * every quoted string of 6 or more characters (a template literal is split around its substitutions), and for a data file also its plain values (`key: value`, list items, CSV cells, whole lines). Bounded: 500 files, 4,000 literals, 2,000
 * names, 4,096 characters per line, 2,048 per literal; hitting a bound sets `truncated`. Never throws.
 */
export function buildTaskLeakFacts(files: readonly ChangedTestFile[]): TaskLeakFacts {
  const testPaths: string[] = [];
  const names = new Set<string>();
  const literals = new Set<string>();
  let truncated = files.length > LEAK_MAX_FILES;
  const addLiteral = (text: string): void => {
    if (text.length < LEAK_LITERAL_MIN_CHARS) return;
    if (literals.size >= LEAK_MAX_LITERALS) {
      truncated = literals.has(text.slice(0, LEAK_LITERAL_MAX_CHARS)) ? truncated : true;
      return;
    }
    literals.add(text.slice(0, LEAK_LITERAL_MAX_CHARS));
  };
  for (const file of files.slice(0, LEAK_MAX_FILES)) {
    if (typeof file.path === "string" && file.path.length > 0) testPaths.push(file.path);
    const isData = typeof file.path === "string" && DATA_FILE.test(file.path);
    for (const raw of file.changedLines) {
      if (typeof raw !== "string") continue;
      if (raw.length > LEAK_MAX_LINE_CHARS) truncated = true;
      const line = raw.length > LEAK_MAX_LINE_CHARS ? raw.slice(0, LEAK_MAX_LINE_CHARS) : raw;
      if (!isData) {
        for (const pattern of TEST_NAME_PATTERNS) {
          const found = pattern.exec(line);
          const name = found === null ? undefined : found.slice(1).find((part) => part !== undefined);
          if (name === undefined) continue;
          if (names.size < LEAK_MAX_NAMES) names.add(unescape(name));
          else truncated = true;
        }
      }
      for (const quoted of line.matchAll(QUOTED)) {
        const body = unescape(quoted[1] ?? quoted[2] ?? quoted[3] ?? "");
        if (quoted[3] !== undefined) for (const piece of body.split(/\$\{[^}]*\}/gu)) addLiteral(piece);
        else addLiteral(body);
      }
      if (isData) {
        if (CELL_FILE.test(file.path)) for (const cell of line.split(/[,\t]/u)) addLiteral(cell.trim().replace(/^["']|["']$/gu, ""));
        else {
          const plain = line.trim().replace(/^[-*]\s+/u, "").replace(/^[A-Za-z0-9_.-]{1,64}\s*[:=]\s+/u, "").replace(/[,;]$/u, "").trim();
          if (plain.length > 0 && !/^["'`]/u.test(plain)) addLiteral(plain);
        }
      }
    }
  }
  return { testPaths, testNames: [...names], expectationLiterals: [...literals], truncated };
}

// ---- normalizing and decoding (both sides of every comparison)

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/giu;
const NAMED_ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (text: string): string =>
  text.replace(ENTITY, (whole: string, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITY[lower] ?? whole;
  });

/** NFKC, entities decoded, zero-width and other format characters (and variation selectors) removed, lower case, white space, `_` and `-` collapsed to one space. */
export function normalizeScreenText(text: string): string {
  const folded = decodeEntities(text.normalize("NFKC")).replace(/[\p{Cf}\uFE00-\uFE0F]/gu, "").toLowerCase().replace(/\u00df/gu, "ss");
  return folded.replace(/[\s_-]+/gu, " ").trim(); // `_` and `-` count as a space: a literal turned into a property or tool name still matches
}

const printable = (text: string): boolean => {
  if (text.length < LEAK_LITERAL_MIN_CHARS) return false;
  let good = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 || code === 9 || code === 10 || code === 13) good += 1;
  }
  return good / [...text].length >= 0.9;
};
const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return printable(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
};
function fromBase64(run: string): string | undefined {
  try {
    const standard = run.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    return utf8(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}
function fromHex(run: string): string | undefined {
  const bytes = new Uint8Array(run.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(run.slice(index * 2, index * 2 + 2), 16);
  return utf8(bytes);
}
function fromPercent(run: string): string | undefined {
  try {
    const decoded = decodeURIComponent(run);
    return printable(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Every base64, hex and URL-encoded run of 16 or more characters in the text, decoded one level (raw, not normalized). */
export function decodedRuns(text: string): string[] {
  const variants: string[] = [];
  let budget = DECODE_MAX_CHARS;
  const take = (patterns: readonly [RegExp, (run: string) => string | undefined, ((run: string) => boolean)?][]): void => {
    for (const [pattern, decode, wanted] of patterns) {
      let runs = 0;
      for (const match of text.matchAll(pattern)) {
        runs += 1;
        if (runs > DECODE_MAX_RUNS || budget <= 0) break;
        if (wanted !== undefined && !wanted(match[0])) continue;
        const decoded = decode(match[0]);
        if (decoded === undefined) continue;
        budget -= decoded.length;
        variants.push(decoded);
      }
    }
  };
  take([
    [/[A-Za-z0-9+/_-]{16,}={0,2}/gu, fromBase64],
    [/(?:[0-9a-fA-F]{2}){8,}/gu, fromHex],
    [/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}){16,}/gu, fromPercent, (run) => run.includes("%")],
  ]);
  return variants;
}

/** The text as it is, normalized, plus its decoded runs normalized. */
export function screenVariants(text: string): string[] {
  return [normalizeScreenText(text), ...decodedRuns(text).map(normalizeScreenText)];
}

/** Every string AND every key in what the agent is sent (`replyRequestData`): the prompt, schemas (enum, const, default, examples, $comment, descriptions, property names), tool names and descriptions, the model name. */
export function agentVisibleStrings(brief: ReplyBrief): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 28) return;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) {
        out.push(key);
        walk((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  walk(replyRequestData(brief), 0);
  return out;
}

const hasBareHunk = (text: string): boolean => {
  let run = 0;
  let plus = false;
  let minus = false;
  for (const line of text.split("\n")) {
    if (/^[+-]/u.test(line) && !/^-{3,}\s*$/u.test(line) && !/^[+-]{3}\s*$/u.test(line)) {
      run += 1;
      plus = plus || line.startsWith("+");
      minus = minus || line.startsWith("-");
      if (run >= 3 && plus && minus) return true;
    } else {
      run = 0;
      plus = false;
      minus = false;
    }
  }
  return false;
};
const hasDiffMarker = (text: string): boolean => text.includes("diff --git") || text.includes("@@ -") || text.includes("+++ b/") || hasBareHunk(text);

/**
 * Screens a brief. In order: facts that were cut (refuse); diff markers (`diff --git`, `@@ -`, `+++ b/`, or a run of bare `+`/`-` hunk lines) anywhere in what the agent is sent; a changed test's path or basename, or a test's name; any string literal of the
 * changed tests and test data (normalized, decoded runs included). The first hit refuses. Pure; the text is bounded by the brief's own bounds and the facts by theirs.
 */
export function screenBrief(brief: ReplyBrief, taskFacts: TaskLeakFacts): LeakScreenResult {
  if (taskFacts.truncated) return { ok: false, reason: "leak_facts_incomplete" };
  const strings = agentVisibleStrings(brief);
  if (strings.some((text) => hasDiffMarker(text) || decodedRuns(text).some(hasDiffMarker))) return { ok: false, reason: "prompt_has_diff" };
  const variants = strings.flatMap(screenVariants);
  const haystack = variants.join("\u0001");
  for (const path of taskFacts.testPaths) {
    for (const needle of [normalizeScreenText(path), normalizeScreenText(path.slice(path.lastIndexOf("/") + 1))]) {
      if (needle.length >= LEAK_LITERAL_MIN_CHARS && haystack.includes(needle)) return { ok: false, reason: "prompt_names_a_test" };
    }
  }
  for (const name of taskFacts.testNames) {
    const needle = normalizeScreenText(name);
    if (needle.length >= LEAK_LITERAL_MIN_CHARS && haystack.includes(needle)) return { ok: false, reason: "prompt_names_a_test" };
  }
  for (const literal of taskFacts.expectationLiterals) {
    const needle = normalizeScreenText(literal);
    if (needle.length >= LEAK_LITERAL_MIN_CHARS && haystack.includes(needle)) return { ok: false, reason: "prompt_echoes_test_expectation" };
  }
  return { ok: true };
}
