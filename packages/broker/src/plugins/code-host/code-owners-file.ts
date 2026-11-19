// Port lane P2 (item C4): the CODEOWNERS file syntax, read the way GitHub, GitLab and Gitea read it, moved OUT of the merge core and behind `CodeHost.codeOwners()`. A host adapter that keeps its code
// owners in a file of this syntax reads it with `readCodeOwnersFile` and hands the core a neutral `CodeOwnersRead`; a host with another way to say who owns what writes its own and the core does not change.
//
// Where the repository has a CODEOWNERS file that covers the paths a pull request changes, a code owner has to approve it before Rovara calls it ready. This reads the file the way GitHub does (the last
// matching rule wins; a rule with no owner takes ownership away). It never trusts what it cannot read: a file with anything Rovara cannot read the way GitHub does (negation, character classes, an
// owner that is no @name or email, more rules than it reads) is `unsupported` as a whole: the rules after a line that was skipped could otherwise take the place of the ones that were meant.
import type { CodeOwner, CodeOwnersRead } from "@agentx/contracts";

export interface CodeOwnerRule {
  pattern: string;
  owners: string[];
  /** The pattern as a test on a path written with `/`, no leading slash. */
  matches(path: string): boolean;
}

/** The most rules read from one file. */
const RULES_MAX = 5_000;
const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

// A pattern is matched by stepping a small automaton over the path once, not by a regular expression: the file is the repository's, and a pattern such as `*a*a*a*a*b` made
// the old regex (`[^/]*a[^/]*a…`) backtrack for seconds to minutes on one path. The automaton reads what that regex read: `*` any run without `/`, `?` one character but `/`, `**`
// inside a name any run at all, a `**` segment any directories (`(?:.*/)?`, or `.*` last), a pattern with no slash but at its end at any depth, and a name with no wildcard what
// is inside it. "Any" stops at a line break, as `.` did; characters are code points, as with the `u` flag.
const NOT_SLASH = (char: string): boolean => char !== "/";
const NOT_LINE_BREAK = (char: string): boolean => char !== "\n" && char !== "\r" && char !== "\u2028" && char !== "\u2029";
interface MatchState { next: number[]; on?: { test: (char: string) => boolean; to: number } }

class Automaton {
  readonly states: MatchState[] = [{ next: [] }];
  private tail = 0;
  private add(): number { this.states.push({ next: [] }); return this.states.length - 1; }
  /** One character the test accepts. */
  one(test: (char: string) => boolean): void { const to = this.add(); this.states[this.tail]!.on = { test, to }; this.tail = to; }
  literal(char: string): void { this.one((other) => other === char); }
  /** Any run of characters the test accepts, possibly none. */
  run(test: (char: string) => boolean): void { const loop = this.add(); this.states[this.tail]!.next.push(loop); this.states[loop]!.on = { test, to: loop }; const out = this.add(); this.states[loop]!.next.push(out); this.tail = out; }
  /** `(?:<build>)?` */
  optional(build: () => void): void { const start = this.tail; build(); this.states[start]!.next.push(this.tail); }
  /** Adds `from` and every state its empty steps reach to `into`, each state once per step (`mark[state] === stamp` means already added). No
   *  per-state reach list is kept: with one, a run of k wildcards cost k^2 work per character (a review measured 5.9 s for `*` x 4000). */
  private reach(from: number, mark: Int32Array, stamp: number, into: number[]): void {
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (mark[at] === stamp) continue;
      mark[at] = stamp;
      into.push(at);
      for (const to of this.states[at]!.next) if (mark[to] !== stamp) stack.push(to);
    }
  }
  /** One pass over the path: each character costs at most every state and empty step once, so the whole match is linear in path length x pattern size. */
  accepts(path: string): boolean {
    const mark = new Int32Array(this.states.length);
    let stamp = 1;
    let current: number[] = [];
    this.reach(0, mark, stamp, current);
    for (const char of path) {
      stamp += 1;
      const next: number[] = [];
      for (const state of current) {
        const on = this.states[state]!.on;
        if (on !== undefined && on.test(char)) this.reach(on.to, mark, stamp, next);
      }
      if (next.length === 0) return false;
      current = next;
    }
    return current.includes(this.tail);
  }
}

/** Adds a segment's steps; returns its runs of plain characters, which a matching path must contain. */
function addSegment(automaton: Automaton, segment: string): string[] {
  const plain = segment.split(/[*?]/u).filter((part) => part !== "");
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") {
      if (segment[index + 1] === "*") { automaton.run(NOT_LINE_BREAK); index += 1; } else automaton.run(NOT_SLASH);
    } else if (char === "?") automaton.one(NOT_SLASH);
    else {
      // A whole code point, so `?` next to an emoji and the literal itself are read as the `u` flag read them.
      const point = String.fromCodePoint(segment.codePointAt(index)!);
      automaton.literal(point);
      index += point.length - 1;
    }
  }
  return plain;
}

/** A gitignore-style pattern as GitHub's CODEOWNERS reads it. */
function compile(pattern: string): (path: string) => boolean {
  const directory = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\/+/u, "").replace(/\/+$/u, "");
  // A pattern with a slash anywhere but the end is anchored to the root, as is one that starts with a slash.
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const segments = trimmed.split("/");
  const anyDirectories = (automaton: Automaton): void => automaton.optional(() => { automaton.run(NOT_LINE_BREAK); automaton.literal("/"); });
  const automaton = new Automaton();
  const plain: string[] = [];
  if (!anchored) anyDirectories(automaton);
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "**") { if (last) automaton.run(NOT_LINE_BREAK); else anyDirectories(automaton); } else {
      plain.push(...addSegment(automaton, segment));
      if (!last) automaton.literal("/");
    }
  }
  const lastSegment = segments[segments.length - 1] ?? "";
  // A name with no wildcard (or a directory) owns what is inside it; a wildcard in the last segment (`*.js`, `docs/*`) matches that level only.
  const ownsInside = directory || !/[*?]/u.test(lastSegment);
  if (ownsInside) automaton.optional(() => { automaton.literal("/"); automaton.run(NOT_LINE_BREAK); });
  // A quick refusal first (most rules name text the path does not have), then the automaton.
  return (path) => plain.every((part) => path.includes(part)) && automaton.accepts(path);
}

/** The rules of a CODEOWNERS file, in order, and whether the file held anything Rovara cannot read. Comments and blank lines are skipped. An email is an owner (Rovara cannot match it to an approver). */
export function parseCodeOwners(text: string): { rules: CodeOwnerRule[]; unsupported: boolean } {
  const rules: CodeOwnerRule[] = [];
  let unsupported = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/(^|\s)#.*$/u, "").trim();
    if (line === "") continue;
    const [pattern, ...rest] = line.split(/\s+/u);
    if (pattern === undefined || pattern === "" || pattern.startsWith("!") || pattern.includes("[") || rest.some((owner) => !OWNER.test(owner) && !EMAIL.test(owner))) { unsupported = true; continue; }
    // More rules than are read: the later, more specific ones would be the ones lost.
    if (rules.length >= RULES_MAX) return { rules, unsupported: true };
    rules.push({ pattern, owners: rest, matches: compile(pattern) });
  }
  return { rules, unsupported };
}

/** The owners of one path: those of the last rule that matches it (none when that rule names none). */
export function ownersOfPath(rules: readonly CodeOwnerRule[], path: string): string[] {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "");
  for (let index = rules.length - 1; index >= 0; index -= 1) if (rules[index]!.matches(normalized)) return rules[index]!.owners;
  return [];
}

/** One owner as the file writes it, in Rovara's words: `@login` is a person, `@org/team` a team (its name without the `@`), anything else (an email) an owner the core cannot match. */
export function codeOwnerOf(written: string): CodeOwner {
  if (!written.startsWith("@")) return { kind: "other", label: written };
  return written.includes("/") ? { kind: "team", team: written.slice(1) } : { kind: "person", login: written.slice(1) };
}

/** A CODEOWNERS file as the neutral answer of `CodeHost.codeOwners()`. */
export function readCodeOwnersFile(text: string): CodeOwnersRead {
  const parsed = parseCodeOwners(text);
  return { unsupported: parsed.unsupported, ownersOf: (path) => ownersOfPath(parsed.rules, path).map(codeOwnerOf) };
}
