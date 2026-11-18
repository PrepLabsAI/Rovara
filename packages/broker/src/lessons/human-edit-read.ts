// L4-LM1c: reading a person's edit to a Rovara pull request, from what the code host says. The producer (the tracking pass's hook) and the worker (the queued job) run this same function, so what is queued is what is read.
//
// What it does, in the order it does it, and what each step refuses (a fixed reason, never a guess):
//  1. WALK  from the pull request's head back along each commit's FIRST parent to the commit Rovara last pushed (`base`), reading each commit's own changes and who wrote it (`commitChanges`, one request and a page or two
//     of files each). At most `HUMAN_EDIT_COMMITS_MAX` commits; a host that cannot read a commit, a chain that does not reach `base` (a force push, a rebase) or one that is too long is skipped, not guessed.
//  2. PROVE a commit is a PERSON's: one parent (a merge, such as "update branch" from the base, is never a person's edit), the host linked its author to an account of kind `person` with a stable id (Rovara's own git
//     identity is linked to nothing, and a bot or app account is not a person), and the committer is that same account or the host's own web committer. By id only: a login can be renamed or reused. Every other commit of
//     a mixed push (a bot's, a merge's, an unlinked identity's) is left out: only the person's commits are read.
//  3. BOUND  the person's commits together: a diff the host cut, or over the line or file limits, is `diff_too_large` and nothing of it is read; what is read is cut to a total of changed lines and files, each line redacted.
//  4. IGNORE what teaches nothing (the source's own list): lockfiles, generated and vendored files, renames with no change, whitespace-only changes, and an edit under 3 changed lines in all (`trivial`).
// The changed lines are returned for the caller to hand on ONCE, in memory; nothing here stores them, and the reasons below are the only thing a caller may keep.
import { redactText, type CodeHost, type HostScope, type PageBudget, type RepositoryRef, type ChangeRequestFile, type CommitChanges } from "@agentx/contracts";
import type { HumanEditFile } from "./capture-types.js";

/** The most commits one read walks (head back to the commit Rovara last pushed). */
export const HUMAN_EDIT_COMMITS_MAX = 20;
/** More changed files than this in the person's commits (before anything is ignored), or more changed lines than the next one: the diff is too large to read. */
export const HUMAN_EDIT_FILES_MAX = 100;
export const HUMAN_EDIT_LINES_MAX = 3_000;
/** What is handed on of an edit that is not too large: files, and changed lines in all and for each file (the extractor's own limit is 200 a file). */
export const HUMAN_EDIT_HANDED_FILES_MAX = 20;
export const HUMAN_EDIT_HANDED_LINES_MAX = 600;
export const HUMAN_EDIT_FILE_LINES_MAX = 200;
/** An edit of fewer changed lines than this (in all, after what is ignored) is not learned from. */
export const HUMAN_EDIT_MIN_LINES = 3;
const LINE_CHARS_MAX = 300;
const SYMBOLS_PER_FILE = 5;
const SYMBOL_CHARS = 100;
/** A full commit id of either hash length. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Thrown by an `allowanceBudget` that is spent: the edit takes more requests than a read of it may use, which is the same answer every time (the caller records it as too large; it never retries). */
export class HumanEditAllowanceError extends Error {
  constructor() { super("the human-edit read used its request allowance"); this.name = "HumanEditAllowanceError"; }
}
/** A budget of at most `max` requests of its own, each also charged to `parent` (the pass's, which may stop the read with its own error). */
export function allowanceBudget(parent: PageBudget | undefined, max: number): PageBudget {
  let used = 0;
  return { beforeRequest: () => { if (used >= max) throw new HumanEditAllowanceError(); used += 1; parent?.beforeRequest(); } };
}

/** Why an edit was not read: fixed words, safe to keep and to count. */
export const HUMAN_EDIT_SKIPS = ["host_cannot_read", "base_not_reached", "too_many_commits", "no_person_commit", "diff_too_large", "trivial"] as const;
export type HumanEditSkip = (typeof HUMAN_EDIT_SKIPS)[number];

/** A person as the host names them: the stable id is what counts (a login can be renamed). */
export interface HostPerson { login: string; hostUserId: string }

export type HumanEditRead =
  | { kind: "edit"; /** The person commits, oldest first. */ commits: string[]; /** Each distinct person, once, by the host's id. */ people: HostPerson[]; files: HumanEditFile[] }
  | { kind: "skip"; reason: HumanEditSkip };

export interface HumanEditReadInput {
  host: Pick<CodeHost, "commitChanges">;
  repository: RepositoryRef;
  scope: HostScope;
  /** The commit Rovara last pushed: the walk ends when it reaches it. */
  base: string;
  /** The pull request's head now. */
  head: string;
  /** Called before every request. It throws when the allowance or time is used up, and the read stops with it. */
  budget?: PageBudget | undefined;
}

/**
 * The person who wrote a commit, or undefined when it is not proved to be one. See the header (step 2). Takes only the host's own fields: it never reads the commit message or any name.
 */
export function personOfCommit(read: Pick<CommitChanges, "parents" | "identity">): HostPerson | undefined {
  const identity = read.identity;
  if (identity === undefined || read.parents.length !== 1) return undefined;
  const author = identity.author;
  if (author === undefined || author.accountType !== "person" || author.hostUserId === undefined || author.hostUserId === "" || /\[bot\]$/iu.test(author.login)) return undefined;
  const committer = identity.committer;
  const sameCommitter = committer !== undefined && committer.accountType === "person" && committer.hostUserId === author.hostUserId;
  if (identity.webFlow !== true && !sameCommitter) return undefined;
  return { login: author.login, hostUserId: author.hostUserId };
}

/** Files that teach nothing about how the team writes code: dependency locks, generated and built output, vendored code, snapshots. */
const IGNORED_PATH = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|uv\.lock|gradle\.lockfile)$/u,
  /\.lock$/u,
  /(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage|__generated__|generated)\//u,
  /\.(min\.js|min\.css|map|snap|pb\.go|generated\.[a-z]+)$/u,
  /(^|\/)__snapshots__\//u,
];
const isIgnoredPath = (path: string): boolean => IGNORED_PATH.some((pattern) => pattern.test(path));

/** The changed lines of a patch (`+` and `-` lines inside hunks), and the hunk headers. */
function linesOfPatch(patch: string): { headers: string[]; changed: string[] } {
  const headers: string[] = [];
  const changed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) headers.push(line);
    else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) changed.push(line);
  }
  return { headers, changed };
}

/** A change that only moves whitespace: the added lines and the removed lines are the same lines once whitespace is gone. */
function whitespaceOnly(changed: readonly string[]): boolean {
  const norm = (sign: string): string[] => changed.filter((line) => line.startsWith(sign)).map((line) => line.slice(1).replace(/\s+/gu, "")).filter((line) => line !== "").sort();
  const added = norm("+");
  const removed = norm("-");
  return added.length === removed.length && added.every((line, index) => line === removed[index]);
}

/** One line of a patch as it may be handed on: control characters gone, secrets redacted, cut short. */
const cleanLine = (line: string): string => redactText([...line].filter((char) => { const code = char.codePointAt(0)!; return code >= 0x20 && code !== 0x7f; }).join("")).slice(0, LINE_CHARS_MAX);

/** The names a hunk header gives its place (`@@ -1,2 +1,2 @@ function load()` names `function load()`): a few, short, plain. */
function symbolsOf(headers: readonly string[]): string[] {
  const out: string[] = [];
  for (const header of headers) {
    const named = /^@@[^@]*@@\s*(.+)$/u.exec(header)?.[1];
    if (named === undefined) continue;
    const symbol = cleanLine(named).slice(0, SYMBOL_CHARS).trim();
    if (symbol !== "" && !out.includes(symbol)) out.push(symbol);
    if (out.length >= SYMBOLS_PER_FILE) break;
  }
  return out;
}

interface Walked { sha: string; read: CommitChanges }

const skip = (reason: HumanEditSkip): HumanEditRead => ({ kind: "skip", reason });

/** Reads a person's edit between `base` and `head`. THROWS when the host cannot answer (a read failure is never a skip: the caller tries again). */
export async function readPersonEdit(input: HumanEditReadInput): Promise<HumanEditRead> {
  const read = input.host.commitChanges;
  if (read === undefined) return skip("host_cannot_read");
  if (!SHA.test(input.base) || !SHA.test(input.head)) return skip("base_not_reached");
  // 1. WALK: first parents, head back to the commit Rovara last pushed.
  const chain: Walked[] = [];
  let current = input.head;
  while (current !== input.base) {
    if (chain.length >= HUMAN_EDIT_COMMITS_MAX) return skip("too_many_commits");
    const answer = await read.call(input.host, input.repository, current, input.scope, input.budget);
    if (!Array.isArray(answer.parents) || !answer.parents.every((parent) => typeof parent === "string" && SHA.test(parent)) || !Array.isArray(answer.files)) return skip("host_cannot_read");
    chain.push({ sha: current, read: answer });
    const first = answer.parents[0];
    // A root commit before the base was reached: the pull request's history does not pass through the commit Rovara pushed.
    if (first === undefined) return skip("base_not_reached");
    current = first;
  }
  // 2. PROVE: only a person's commits are read, whatever else the push held.
  const mine = chain.map((entry) => ({ entry, person: personOfCommit(entry.read) })).filter((found): found is { entry: Walked; person: HostPerson } => found.person !== undefined).reverse();
  if (mine.length === 0) return skip("no_person_commit");
  // 3. BOUND: the person's commits together. A diff the host cut is not read.
  if (mine.some(({ entry }) => entry.read.complete !== true)) return skip("diff_too_large");
  const all: ChangeRequestFile[] = mine.flatMap(({ entry }) => entry.read.files);
  const paths = new Set(all.map((file) => file.path));
  const lines = all.reduce((total, file) => total + file.additions + file.deletions, 0);
  if (paths.size > HUMAN_EDIT_FILES_MAX || lines > HUMAN_EDIT_LINES_MAX) return skip("diff_too_large");
  // 4. IGNORE, then hand on what is left, bounded.
  const perFile = new Map<string, { additions: number; deletions: number; headers: string[]; changed: string[] }>();
  for (const file of all) {
    if (isIgnoredPath(file.path) || (file.previousPath !== undefined && isIgnoredPath(file.previousPath))) continue;
    // A rename with nothing changed, a binary file and a file the host gave no text for say nothing in words.
    if (file.patch === undefined || file.additions + file.deletions === 0) continue;
    const parts = linesOfPatch(file.patch);
    if (parts.changed.length === 0) continue;
    const found = perFile.get(file.path) ?? { additions: 0, deletions: 0, headers: [], changed: [] };
    found.additions += file.additions;
    found.deletions += file.deletions;
    found.headers.push(...parts.headers);
    found.changed.push(...parts.changed);
    perFile.set(file.path, found);
  }
  const files: HumanEditFile[] = [];
  let kept = 0;
  let total = 0;
  for (const [path, found] of [...perFile.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (whitespaceOnly(found.changed)) continue;
    total += found.additions + found.deletions;
    if (files.length >= HUMAN_EDIT_HANDED_FILES_MAX || kept >= HUMAN_EDIT_HANDED_LINES_MAX) continue;
    const room = Math.min(HUMAN_EDIT_FILE_LINES_MAX, HUMAN_EDIT_HANDED_LINES_MAX - kept);
    const changed = found.changed.slice(0, room).map(cleanLine);
    kept += changed.length;
    files.push({ path, additions: found.additions, deletions: found.deletions, symbols: symbolsOf(found.headers), hunks: [...found.headers.slice(0, 20).map(cleanLine), ...changed] });
  }
  if (files.length === 0 || total < HUMAN_EDIT_MIN_LINES) return skip("trivial");
  const people = [...new Map(mine.map(({ person }) => [person.hostUserId, person] as const)).values()];
  return { kind: "edit", commits: mine.map(({ entry }) => entry.sha), people, files };
}
