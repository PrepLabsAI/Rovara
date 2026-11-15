// Rovara Code (Plan 6 Task 13): the files a task's workspace diff names, read the way the risk rules and the pull request description need them. The shared `diffStat` (the task view's list) drops a file whose
// header Git printed in quotes, records only the new name of a rename, and counts a file it cannot count as 0 lines. A risk judged on that list could miss a sensitive file or call a big change small, so this
// reader keeps the real names (unquoted, both names of a rename) and leaves a count out when the diff has none to give (a new unstaged file, a binary patch, a change of mode or name only): unknown is not 0.
import { redactText, type ChangeRequestFile } from "@agentx/contracts";
import { isTestPath, type ChangedFileEntry } from "./verification-report.js";

/** The most files read; a diff that names this many may name more. */
export const CHANGED_FILES_MAX = 200;
/** The workspace diff's own notes that its list is not the whole change (a diff cut to fit, or a base commit that is gone so only uncommitted changes show). */
const INCOMPLETE_NOTES = [/\[workspace diff truncated/u, /\[the commit this workspace was prepared at is not in this repository/u];

/** An added line that switches a test off: a skipped or pending test in the common frameworks. */
const SKIP_MARKER = /(?:\b(?:it|test|describe|context|specify)(?:\.concurrent)?\.(?:skip|todo|only|fixme)\b|\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(|\.skipIf\s*\(|\bpending\s*\(|@(?:Disabled|Ignore)\b|#\[ignore\]|\bt\.Skip(?:Now)?\s*\(|\bpytest\.mark\.skip|@unittest\.skip|\bskipTest\s*\()/u;
/** A line of package.json that sets a `test` script (`test`, `test:unit`, ...), added or removed. */
const TEST_SCRIPT_LINE = /^[+-]\s*"test(?::[\w:.-]+)?"\s*:/u;

/**
 * An added or removed line that declares a route or a response model: a decorator or registration in the common web frameworks (FastAPI and Flask, Express and its kin, Nest, Spring, Go's routers).
 * A handler whose body alone changes does not match; the route's own line is what says the public API is touched.
 */
const API_ROUTE_LINE = new RegExp([
  String.raw`^[+-]\s*@\w+(?:\.\w+)*\.(?:get|post|put|patch|delete|head|options|route|api_route|websocket)\s*\(`,
  String.raw`^[+-]\s*@(?:Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(`,
  String.raw`^[+-]\s*@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b`,
  String.raw`^[+-]\s*(?:\w+\.)*(?:app|router|api|server|routes|fastify|express|route)\.(?:get|post|put|patch|delete|head|options|all)\s*\(\s*['"\x60/]`,
  String.raw`^[+-].*\b(?:response_model|response_class)\s*=`,
  String.raw`^[+-]\s*\w+\.(?:GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle)\(\s*"`,
].join("|"), "u");
/** A file that defines what a response looks like: a schema, serializer or DTO file or folder, an OpenAPI or Swagger document, a protobuf or GraphQL file. Tests of them are not. */
const API_SCHEMA_PATH = /(?:(?:^|\/)(?:schemas?|serializers?|dtos?)(?:\/|\.[a-z]+$)|(?:^|\/)[\w.-]*\.(?:schema|dto)\.[a-z]+$|(?:^|\/)(?:openapi|swagger)[\w.-]*\.(?:ya?ml|json)$|\.(?:proto|graphql|gql)$)/u;

/** Git's C-style quoting (`"a/\303\274.ts"`, `\"`, `\\`, `\t`, `\n`) undone; an unquoted name is returned as it is. */
export function unquoteGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return token;
  const bytes: number[] = [];
  const inner = token.slice(1, -1);
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/u.exec(inner.slice(index + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += 3;
    } else {
      const next = inner[index + 1];
      const code = next === undefined ? undefined : simple[next];
      if (code !== undefined) bytes.push(code);
      else if (next !== undefined) bytes.push(...Buffer.from(next, "utf8"));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The two names in a `diff --git` line (without its `a/` and `b/`), quoted or not; undefined when the line is not in a shape Git writes. */
function headerNames(rest: string): { from: string; to: string } | undefined {
  const strip = (name: string, prefix: "a/" | "b/") => (name.startsWith(prefix) ? name.slice(2) : undefined);
  let from: string | undefined;
  let to: string | undefined;
  if (rest.startsWith('"')) {
    const close = /^"(?:[^"\\]|\\.)*"/u.exec(rest)?.[0];
    if (close === undefined) return undefined;
    from = strip(unquoteGitPath(close), "a/");
    to = strip(unquoteGitPath(rest.slice(close.length).trim()), "b/");
  } else {
    const quotedTo = / ("b\/(?:[^"\\]|\\.)*")$/u.exec(rest);
    if (quotedTo !== null) {
      from = strip(rest.slice(0, quotedTo.index), "a/");
      to = strip(unquoteGitPath(quotedTo[1]!), "b/");
    } else {
      const plain = /^a\/(.+) b\/(.+)$/u.exec(rest);
      from = plain?.[1];
      to = plain?.[2];
    }
  }
  return from === undefined || to === undefined ? undefined : { from, to };
}

/**
 * The files of a `workspace.diff` artifact: per repository a `## <name>` section with `### status` and `### diff`. Lines are counted only inside hunks. A file has no count when the diff gave no hunk for it
 * (a new file that Git does not track yet, a binary patch, a mode or name change alone). `complete` is false when the diff says it is cut, when its base is gone, or when it names as many files as are kept.
 */
export function parseChangedFiles(text: string): { files: ChangedFileEntry[]; complete: boolean } {
  const tracked: ChangedFileEntry[] = [];
  const untracked: ChangedFileEntry[] = [];
  let repository = "";
  let section: "none" | "status" | "diff" = "none";
  let current: ChangedFileEntry | undefined;
  let inHunk = false;
  const deleted = new Set<ChangedFileEntry>();
  const skipped = new Set<ChangedFileEntry>();
  const testCommand = new Set<ChangedFileEntry>();
  const apiRoute = new Set<ChangedFileEntry>();
  for (const line of text.split("\n")) {
    const heading = /^## (\S+)$/u.exec(line);
    if (heading !== null) {
      repository = heading[1]!;
      section = "none";
      current = undefined;
      inHunk = false;
      continue;
    }
    if (line === "### status") { section = "status"; continue; }
    if (line === "### diff") { section = "diff"; continue; }
    if (section === "status") {
      const entry = /^\?\? (.+)$/u.exec(line);
      if (entry !== null) untracked.push({ repository, path: unquoteGitPath(entry[1]!) });
      continue;
    }
    if (section !== "diff") continue;
    if (line.startsWith("diff --git ")) {
      const names = headerNames(line.slice("diff --git ".length));
      inHunk = false;
      if (names === undefined) { current = undefined; continue; }
      current = { repository, path: names.to, ...(names.from === names.to ? {} : { renamedFrom: names.from }) };
      tracked.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (!inHunk && line.startsWith("deleted file mode")) deleted.add(current);
    if (line.startsWith("@@")) {
      inHunk = true;
      current.added ??= 0;
      current.removed ??= 0;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      current.added = (current.added ?? 0) + 1;
      if (SKIP_MARKER.test(line)) skipped.add(current);
    } else if (line.startsWith("-")) current.removed = (current.removed ?? 0) + 1;
    if (TEST_SCRIPT_LINE.test(line) && (current.path === "package.json" || current.path.endsWith("/package.json"))) testCommand.add(current);
    if ((line.startsWith("+") || line.startsWith("-")) && API_ROUTE_LINE.test(line)) apiRoute.add(current);
  }
  // What a change does to the tests it touches (Plan 6 Task 16): a test file deleted, moved out of the test paths, or losing more lines than it gains; a line added that skips or focuses a test; the test command changed.
  for (const file of tracked) {
    if (testCommand.has(file)) file.testCommandChanged = true;
    // The public API (task P, blind test 02): a route or response model line changed, or a schema file did (not a test of one). A file in a schema folder with no changed line is only moved or re-moded.
    if (!isTestPath(file.path) && (apiRoute.has(file) || (API_SCHEMA_PATH.test(file.path.toLowerCase()) && ((file.added ?? 0) + (file.removed ?? 0) > 0)))) file.apiShapeChanged = true;
    const wasTest = file.renamedFrom !== undefined && isTestPath(file.renamedFrom);
    if (!isTestPath(file.path) && !wasTest) continue;
    if (deleted.has(file) || (wasTest && !isTestPath(file.path)) || (file.removed ?? 0) > (file.added ?? 0)) file.testsRemoved = true;
    if (skipped.has(file)) file.testsSkipped = true;
  }
  const known = new Set(tracked.map((file) => `${file.repository}\u0000${file.path}`));
  const all = [...tracked, ...untracked.filter((file) => !known.has(`${file.repository}\u0000${file.path}`))];
  const files = all.slice(0, CHANGED_FILES_MAX).map((file) => ({
    ...file, repository: redactText(file.repository), path: redactText(file.path),
    ...(file.renamedFrom === undefined ? {} : { renamedFrom: redactText(file.renamedFrom) }),
  }));
  return { files, complete: all.length < CHANGED_FILES_MAX && !INCOMPLETE_NOTES.some((note) => note.test(text)) };
}

/** A path from the host that a one-line diff header could not carry honestly (a line break or a control character) is not listed, and the list is then not complete. */
export const plainChangedPath = (path: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(path) && path.length > 0 && path.length <= 4_096;

/**
 * The files one change request changes, as the code host reports them, in the shape the risk rules read. The host's counts are kept; the flags the risk rules read from the diff (a removed or skipped test, a changed test
 * command, a route) come from the patch the host gave for the file, when it gave one. `complete` is false when the host's list was cut or a file had a path that cannot be listed.
 */
export function changedFilesFromHostFiles(repositoryId: string, files: readonly ChangeRequestFile[], listComplete: boolean): { files: ChangedFileEntry[]; complete: boolean } {
  const usable = files.filter((file) => plainChangedPath(file.path) && (file.previousPath === undefined || plainChangedPath(file.previousPath)));
  const text = [`## ${repositoryId}`, "### status", "### diff", ...usable.map((file) => {
    const from = file.previousPath ?? file.path;
    return [`diff --git a/${from} b/${file.path}`, ...(file.status === "removed" ? ["deleted file mode 100644"] : []), `--- a/${from}`, `+++ b/${file.path}`, ...(file.patch === undefined ? [] : [file.patch.startsWith("@@") ? file.patch : `@@ -0,0 +0,0 @@\n${file.patch}`])].join("\n");
  })].join("\n");
  const parsed = parseChangedFiles(text);
  const counts = new Map(usable.map((file) => [`${file.previousPath ?? ""}\u0000${file.path}`, file]));
  return {
    // The host's own counts replace the ones read from a patch (a file with no patch has none to read, and "unknown" is not 0).
    files: parsed.files.map((entry) => {
      const source = counts.get(`${entry.renamedFrom ?? ""}\u0000${entry.path}`);
      return source === undefined ? entry : { ...entry, added: source.additions, removed: source.deletions };
    }),
    complete: listComplete && usable.length === files.length && parsed.complete,
  };
}
