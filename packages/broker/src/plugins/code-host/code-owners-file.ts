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

function escapeSegment(segment: string): string {
  let out = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") {
      if (segment[index + 1] === "*") { out += ".*"; index += 1; } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return out;
}

/** A gitignore-style pattern as GitHub's CODEOWNERS reads it. */
function compile(pattern: string): (path: string) => boolean {
  const directory = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\/+/u, "").replace(/\/+$/u, "");
  // A pattern with a slash anywhere but the end is anchored to the root, as is one that starts with a slash.
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const segments = trimmed.split("/");
  let body = "";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "**") body += last ? ".*" : "(?:.*/)?";
    else body += escapeSegment(segment) + (last ? "" : "/");
  }
  const lastSegment = segments[segments.length - 1] ?? "";
  // A name with no wildcard (or a directory) owns what is inside it; a wildcard in the last segment (`*.js`, `docs/*`) matches that level only.
  const ownsInside = directory || !/[*?]/u.test(lastSegment);
  const regex = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${ownsInside ? "(?:/.*)?" : ""}$`, "u");
  return (path) => regex.test(path);
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
