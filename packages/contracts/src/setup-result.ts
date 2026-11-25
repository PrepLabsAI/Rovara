// DEC 254zzz495 / N1: how a setup-run command ended in words (`setupResultOf`), and is a command a PURE search or listing, the one kind of command whose "exit 1 and nothing printed" means "it looked and matched nothing" (an answer) instead of "it failed"?
// Browser-safe, pure; its only import is a type. The journal's command is the redacted one-line text; this reads it with a small shell word reader and ALLOW-LISTS what it accepts, so anything it does not understand
// (a `source`, a package manager, an interpreter, `||`, `;`, a command substitution, a redirection other than `2>&1` and `2>/dev/null`, a `-exec`) is simply not a pure search and the entry stays "Failed".
//
// What a pure search is:
//   stages joined by `&&`; every stage but the last is `cd <dir>` or a pipeline of read-only programs; the last stage is a pipeline whose LAST program (it sets the exit code: there is no pipefail) is a search program.
//   search programs: grep egrep fgrep rg test [ which type `command -v`. Read-only programs before a pipe: those, and find ls cat sort head tail wc, and `xargs <one of the read-only programs>`.
//   `find` alone never counts: it exits 0 when nothing matches, so a `find` exit 1 is an error.

import type { SetupJournalEntry } from "./setup-run.js";

// ---- how a journal entry ended, in words (the one function every reader shares)

/**
 * How one command of a setup run ended, in one place for every reader (the worker's try counter, the next run's carry-over, the local page, and the Cloud screens that mirror this file):
 *   worked         exit 0;
 *   timed_out      it ran out of time;
 *   nothing_found  a PURE search or listing (`isPureSearchCommand`: grep, rg, find piped into grep, test, which ..., optionally after `cd <dir> &&`) exited 1 with no output at all. That is an answer, not a failure;
 *   failed         everything else: any other exit, a command that did not finish, anything printed (the tail is the merged, redacted output, so an error message keeps it failed), and every command that is not
 *                  a pure search (a `source`, `||`, `;`, a chain with a non-search step, a package manager, an interpreter): their exit 1 is a real failure.
 * Lives beside the parser, not in setup-run.ts: that module is pinned to import only zod (the DNS helper's memory limit).
 */
export const SETUP_RESULT_WORDS = ["worked", "nothing_found", "timed_out", "failed"] as const;
export type SetupResultWord = (typeof SETUP_RESULT_WORDS)[number];

/** The fixed words of a "nothing found" row (the row's result and its tooltip). */
export const SETUP_NOTHING_FOUND_WORDS = { row: "Nothing found", tooltip: "The search ran and matched nothing. That is an answer, not a failure." } as const;

/** What `setupResultOf` reads of an entry: the journal entry's own fields. */
export type SetupResultInput = Pick<SetupJournalEntry, "command" | "exitCode" | "timedOut" | "tail">;

/** How a command ended (see `SETUP_RESULT_WORDS`). Pure; never throws; the command's words decide only whether it is a pure search, never whether it worked. */
export function setupResultOf(entry: SetupResultInput): SetupResultWord {
  if (entry.timedOut) return "timed_out";
  if (entry.exitCode === 0) return "worked";
  return entry.exitCode === 1 && entry.tail.trim() === "" && isPureSearchCommand(entry.command) ? "nothing_found" : "failed";
}

// ---- is the command a pure search

// `ag` is not here: it has no exit code of its own for an error, so an error it hid behind `2>/dev/null` would read as "nothing found".
const SEARCH_PROGRAMS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "test", "[", "which", "type"]);
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([...SEARCH_PROGRAMS, "find", "ls", "cat", "sort", "head", "tail", "wc"]);
/** What `xargs` may run. */
const XARGS_PROGRAMS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "ls", "cat", "wc", "head", "tail"]);
/** `find` actions that run a program or write a file. */
const FIND_ACTIONS = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/u;
/** Options that make an otherwise read-only program run another program or write a file. */
const DANGEROUS_ARGUMENT: Readonly<Record<string, RegExp>> = {
  rg: /^--(?:pre|hostname-bin)(?:=|$)/u,
  sort: /^(?:-[A-Za-z]*o|--output|--compress-program|--files0-from)/u,
};

interface Segment { words: string[]; redirect: "none" | "merge" | "discard" }
type Pipeline = Segment[];

interface ReaderState { pipelines: Pipeline[]; segments: Segment[]; words: string[]; word: string; started: boolean; redirect: Segment["redirect"] }

const blank = (): ReaderState => ({ pipelines: [], segments: [], words: [], word: "", started: false, redirect: "none" });

function endWord(state: ReaderState): void {
  if (state.started) state.words.push(state.word);
  state.word = "";
  state.started = false;
}

/** Ends the segment under way. False when it is empty (a command is missing: `a && && b`, a leading or trailing pipe). */
function endSegment(state: ReaderState): boolean {
  endWord(state);
  if (state.words.length === 0) return false;
  state.segments.push({ words: state.words, redirect: state.redirect });
  state.words = [];
  state.redirect = "none";
  return true;
}

function endPipeline(state: ReaderState): boolean {
  if (!endSegment(state)) return false;
  state.pipelines.push(state.segments);
  state.segments = [];
  return true;
}

/** The text inside single quotes, up to the closing quote; the index after it, or undefined when it never closes. */
function singleQuoted(text: string, from: number, state: ReaderState): number | undefined {
  const close = text.indexOf("'", from);
  if (close < 0) return undefined;
  state.word += text.slice(from, close);
  state.started = true;
  return close + 1;
}

/** The text inside double quotes (a backslash makes the next character plain); a `$(`, `$((` or backtick inside is an expansion that runs something. The index after the closing quote, or undefined. */
function doubleQuoted(text: string, from: number, state: ReaderState): number | undefined {
  let index = from;
  state.started = true;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '"') return index + 1;
    if (char === "`" || (char === "$" && text[index + 1] === "(")) return undefined;
    if (char === "\\" && index + 1 < text.length) { state.word += text[index + 1] as string; index += 2; continue; }
    state.word += char;
    index += 1;
  }
  return undefined;
}

/** A `>` outside quotes: only `2>&1` and `2>/dev/null` are allowed. The index after it, or undefined. */
function redirection(text: string, at: number, state: ReaderState): number | undefined {
  if (state.word !== "2") return undefined;
  const rest = text.slice(at);
  const merged = /^>&1(?=\s|$|\|)/u.exec(rest);
  const discarded = /^>\s*\/dev\/null(?=\s|$|\|)/u.exec(rest);
  const match = merged ?? discarded;
  if (match === null) return undefined;
  state.word = "";
  state.started = false;
  state.redirect = merged === null ? "discard" : "merge";
  return at + match[0].length;
}

/** One unquoted character that is not a quote, a space, a backslash or an operator. False: it is one this reader refuses (`;`, `` ` ``, `$(`, a lone `&`, a bracket or brace, a `<`, a newline, a comment). */
const REFUSED_UNQUOTED = new Set([";", "`", "(", ")", "{", "}", "<", "\n", "\r"]);

/** One step of the reader: handles the character at `index` and answers the index to go on from, or undefined when the command is one this reader refuses. */
type ReaderStep = (text: string, index: number, state: ReaderState) => number | undefined;

const backslash: ReaderStep = (text, index, state) => {
  const next = text[index + 1];
  if (next === undefined) return undefined;
  state.word += next;
  state.started = true;
  return index + 2;
};
const space: ReaderStep = (_text, index, state) => { endWord(state); return index + 1; };
const andOperator: ReaderStep = (text, index, state) => (text[index + 1] === "&" && endPipeline(state) ? index + 2 : undefined);
const pipeOperator: ReaderStep = (text, index, state) => (text[index + 1] !== "|" && endSegment(state) ? index + 1 : undefined);

const STEPS: ReadonlyMap<string, ReaderStep> = new Map<string, ReaderStep>([
  ["'", (text, index, state) => singleQuoted(text, index + 1, state)],
  ['"', (text, index, state) => doubleQuoted(text, index + 1, state)],
  ["\\", backslash], [" ", space], ["\t", space], [">", redirection], ["&", andOperator], ["|", pipeOperator],
]);

function step(text: string, index: number, state: ReaderState): number | undefined {
  const char = text[index] as string;
  const known = STEPS.get(char);
  if (known !== undefined) return known(text, index, state);
  if (REFUSED_UNQUOTED.has(char) || (char === "$" && text[index + 1] === "(") || (char === "#" && !state.started)) return undefined;
  state.word += char;
  state.started = true;
  return index + 1;
}

/**
 * The words of a command, as stages of `&&`-joined pipelines; undefined for anything this reader does not take whole. `||`, `;`, `&`, subshells, braces, redirections other than the two allowed, comments, a newline and
 * expansions that run a program all give undefined.
 */
function readCommand(text: string): Pipeline[] | undefined {
  const state = blank();
  let index = 0;
  while (index < text.length) {
    const moved = step(text, index, state);
    if (moved === undefined) return undefined;
    index = moved;
  }
  return endPipeline(state) ? state.pipelines : undefined;
}

const programOf = (segment: Segment): string | undefined => {
  const first = segment.words[0];
  return first === undefined || first.includes("/") ? undefined : first;
};

/** Whether the options of a read-only program stay read-only (no `-exec`, no `--pre`, no `sort -o`). */
function argumentsAreReadOnly(program: string, args: readonly string[]): boolean {
  if (program === "find") return !args.some((arg) => FIND_ACTIONS.test(arg));
  const dangerous = DANGEROUS_ARGUMENT[program];
  return dangerous === undefined || !args.some((arg) => dangerous.test(arg));
}

/** A segment that is read-only, with `xargs` and `command -v` read through to what they run. */
function isReadOnlySegment(segment: Segment): boolean {
  const program = programOf(segment);
  if (program === undefined) return false;
  const args = segment.words.slice(1);
  if (program === "command") return args[0] === "-v" || args[0] === "-V";
  if (program === "xargs") {
    const run = args.find((arg) => !arg.startsWith("-"));
    return run !== undefined && XARGS_PROGRAMS.has(run) && argumentsAreReadOnly(run, args.slice(args.indexOf(run) + 1));
  }
  return READ_ONLY_PROGRAMS.has(program) && argumentsAreReadOnly(program, args);
}

/** A segment that is a search program (what sets the exit code of a pure search), including `command -v`. */
function isSearchSegment(segment: Segment): boolean {
  const program = programOf(segment);
  if (program === undefined) return false;
  if (program === "command") return segment.words[1] === "-v" && isReadOnlySegment(segment);
  return SEARCH_PROGRAMS.has(program) && isReadOnlySegment(segment);
}

/** `cd <dir>` or `cd -- <dir>`, with no redirection: the only stage allowed before the last that is not a pipeline. */
function isChangeDirectory(pipeline: Pipeline): boolean {
  const only = pipeline.length === 1 ? pipeline[0] : undefined;
  if (only === undefined || only.redirect !== "none" || only.words[0] !== "cd") return false;
  return only.words.length === 2 || (only.words.length === 3 && only.words[1] === "--");
}

/** A pipeline of read-only programs. A `2>/dev/null` is allowed only on its last program (an earlier one that failed would hide its error, and the empty result would read as "nothing found"). */
function isReadOnlyPipeline(pipeline: Pipeline): boolean {
  return pipeline.every((segment, position) => isReadOnlySegment(segment) && (segment.redirect !== "discard" || position === pipeline.length - 1));
}

/**
 * Whether the command is a pure search or listing: only then may an exit of 1 with nothing printed read "nothing found". A command this does not read whole, any `source`, `.`, `eval`, package manager, interpreter or
 * build tool, `||`, `;`, a command substitution, and a search that is not the last thing to run all give false. Pure; never throws.
 */
export function isPureSearchCommand(command: string): boolean {
  const stages = readCommand(command.trim());
  if (stages === undefined) return false;
  const last = stages.at(-1);
  const lastSegment = last?.at(-1);
  if (last === undefined || lastSegment === undefined || !isSearchSegment(lastSegment) || !isReadOnlyPipeline(last)) return false;
  return stages.slice(0, -1).every((stage) => isChangeDirectory(stage) || isReadOnlyPipeline(stage));
}
