// The port guard: the first check a Rovara Code port lane runs (docs/porting.md). It looks at the work a lane adds to public
// `code/next` and fails when that work carries something that must never reach the public repository:
//
//   cloud-path      a Cloud-only path (decision 41): org/, spend/, audit/, team-record/, devices/, the Cloud web app and audit verifier
//                   packages, the Cloud upgrade command, the Cloud CDK stacks, the Cloud-only contracts files
//   cloud-import    a TypeScript/JavaScript file that imports one of those, or a package/CI file that names one of those packages
//   build-detector  the internal build-system detector (decision 45.11: an optional plug-in package, never core)
//   private-name    a prospect or customer name (matched against a salted hash list, so no name is written in this file), the staging account id, an account id inside an ARN, an API Gateway host, a
//                   host under the product's dev domain, or the private repository's name, on an added line
//   link            a symlink or a submodule (a link can point at a Cloud-only file, and the scan reads blobs, not targets)
//   scan-bypass     an inline allow comment for gitleaks, or a gitleaks config / ignore file (they would switch the secret scan off)
//   guard-files     an edit to the guard itself, its tests, or the CI workflow that runs it (the controller reviews those by hand;
//                   the guard's own lane passes --allow-guard-edits)
//   secret          anything gitleaks finds in the range
//
// It checks the range's net diff (merge base to tip) and also every non-merge commit in the range, so a commit that adds a file
// and a later commit that removes it still fails: the history is pushed too. It prints file:line, the rule and a label for the
// pattern, never the text it matched. Exit status: 0 clean, 1 findings, 2 the guard could not run (bad range, git or gitleaks missing).
//
// Node runs this file directly, so only erasable syntax and only Node's own modules. Usage, from inside the lane's worktree:
//   node scripts/port-guard.ts [--range <base>..<tip>] [--allow-guard-edits]      (default range: origin/code/next..HEAD)
// The controller's extended name list (one regular expression per line) is read from the file named by PORT_GUARD_PRIVATE_NAMES, if set.
//
// No name is written in this file or in its tests: the protected words are salted hashes (see NameSource), and the tests use invented names.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, posix } from "node:path";

export interface Finding {
  /** The rule's name, as in the list above. */
  rule: string;
  file: string;
  /** The line in the file at the end of the range; null for a finding about the file as a whole. */
  line: number | null;
  /** Which pattern fired, in words. Never the matched text. */
  detail: string;
  /** The commit (short sha) whose patch showed it, when the net diff did not. */
  commit?: string;
}

/** Thrown when the guard cannot do its job (as opposed to finding something). */
export class GuardError extends Error {}

const join = (...parts: string[]): string => parts.join("");

// ---------------------------------------------------------------------------------------------------------------------------------
// Rule: cloud-path (decision 41). Matched case-insensitively, because the developer's Mac and the Windows checkouts do not tell
// `Org/` and `org/` apart.

/** Directory names that are Cloud-only wherever they appear in a path. */
const CLOUD_DIRS = ["org", "spend", "audit", "team-record", "devices"];

/** Cloud-only contracts files that Code does keep, each with the reason. A new entry needs both owners (decision 42a). */
const CLOUD_PATH_ALLOWED = new Set<string>([
  // Code keeps Cloud's company-scoped key scheme (decision 45.6; inventory lane L1: "org-scoped-keys (keys only)").
  "packages/contracts/src/org-scoped-keys",
  // The audit-sink PORT: a Code plug-in interface (the "AuditSink" policy seam of inventory section 2.2, a no-op in Code) that Cloud fills with
  // its audit outbox. Decision 41 puts the audit LEDGER, its verifier and its outbox in Cloud; the port is only the interface and its test.
  // Cloud's ledger code stays refused by the audit/ directory, contracts audit-* and CDK stack rules above.
  "packages/contracts/src/audit-sink",
  "packages/contracts/src/audit-sink.test",
  // Public's own install-upgrade command, which was in public before the port. A lane may edit these six files (and main.ts may keep
  // importing them) but may not add to the directory: Cloud's much larger upgrade directory is not ported (decision 41).
  "packages/cli/src/upgrade/answers",
  "packages/cli/src/upgrade/cli",
  "packages/cli/src/upgrade/export",
  "packages/cli/src/upgrade/review",
  "packages/cli/src/upgrade/run",
  "packages/cli/src/upgrade/target",
]);

interface PathRule { label: string; pattern: RegExp }

const CLOUD_PATH_RULES: readonly PathRule[] = [
  { label: `a Cloud-only directory (${CLOUD_DIRS.join(", ")})`, pattern: new RegExp(`(^|/)(${CLOUD_DIRS.join("|")})/`, "i") },
  {
    label: "a Cloud-only contracts file (org*, spend*, audit*, team-record*)",
    pattern: /^packages\/contracts\/src\/(org|spend|audit|team-record)([-.].*)?$/i,
  },
  { label: "a Cloud-only package (the web app, its UI or the audit verifier)", pattern: /^packages\/(ui|web|audit-verifier)(\/|$)/i },
  { label: "the Cloud upgrade command", pattern: /^packages\/cli\/src\/upgrade(\/|\.|$)/i },
  {
    label: "a Cloud CDK stack",
    pattern: /^infra\/lib\/(?:[^/]+\/)*(audit-[^/]*|team-record-[^/]*|org-[^/]*|spend-[^/]*|web-app|cloud-identity|custom-domain[^/]*|edition-env)\.ts$/i,
  },
  { label: "Cloud-only documentation (enterprise, audit ledger)", pattern: /^docs\/(enterprise|audit-ledger)(\/|\.|$)/i },
];

/** Decision 45.11: a code file (or a module named without an extension, or any file under env-detect/) with the internal build-system detector's name among the words of its path, tests included. */
const CODE_SOURCE = /\.[cm]?[jt]sx?$/i;

/** The Cloud-only rule a repository path falls under, or null. A directory path may be given without its trailing slash. */
export function cloudPathRule(path: string, names: NameSource = DEFAULT_NAMES): { rule: "cloud-path" | "build-detector"; detail: string } | null {
  const normal = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (CLOUD_PATH_ALLOWED.has(normal.toLowerCase().replace(/\.[cm]?[jt]sx?$/, ""))) return null;
  for (const candidate of [normal, `${normal}/`]) {
    for (const { label, pattern } of CLOUD_PATH_RULES) if (pattern.test(candidate)) return { rule: "cloud-path", detail: label };
  }
  const codeLike = CODE_SOURCE.test(normal) || !/\.[a-z0-9]+$/i.test(posix.basename(normal)) || /(^|\/)env-detect\//i.test(normal);
  if (codeLike && tokenViews(normal).some((tokens) => matchNames(tokens, matcherFor(names), "detectors").size > 0)) {
    return { rule: "build-detector", detail: "the internal build-system detector is an optional plug-in, not core (decision 45.11)" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rule: cloud-import.

const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less)$/i;
/** Files that wire packages together: a Cloud-only package named here would pull it into the build. */
const WIRING_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]+\.ya?ml)$/i;
const CLOUD_PACKAGE = /^@(agentx|rovara)\/(ui|web|audit-verifier)(\/|$)/i;
const CLOUD_PACKAGE_ANYWHERE = /@(agentx|rovara)\/(ui|web|audit-verifier)(?![a-z0-9-])|(^|[^a-z0-9-])packages\/(ui|web|audit-verifier)(?![a-z0-9-])/i;
const SEGMENT = new RegExp(`(^|/)(${CLOUD_DIRS.join("|")})(/|$)`, "i");

/**
 * Every module specifier a piece of source names: import/export ... from, import(), require(), require.resolve(), side-effect imports,
 * vi/jest mocks, `new URL(..., import.meta.url)` and triple-slash references. A string may use backquotes when it holds no `${}`, and a
 * comment may sit between the parenthesis and the string.
 */
const Q = "(['\"`])([^'\"`\\n$]+)\\1";
const OPEN = "\\s*(?:(?:\\/\\*[^]*?\\*\\/|\\/\\/[^\\n]*\\n)\\s*)*";
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bfrom${OPEN}${Q}`, "g"),
  new RegExp(`\\bimport\\.meta\\.resolve\\s*\\(${OPEN}${Q}`, "g"),
  new RegExp(`\\bnew\\s+(?:Shared)?Worker\\s*\\(${OPEN}${Q}`, "g"),
  new RegExp(`\\bimport\\s*\\(${OPEN}${Q}`, "g"),
  new RegExp(`\\b(?:require(?:\\.(?:resolve|context))?|__non_webpack_require__)\\s*\\(${OPEN}${Q}`, "g"),
  new RegExp(`\\bcreateRequire\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\(${OPEN}${Q}`, "g"),
  new RegExp(`\\bdeclare\\s+module\\s+${Q}`, "g"),
  new RegExp(`@import\\s+(?:url\\(\\s*)?${Q}`, "g"),
  new RegExp(`<(?:script|link|img|source|iframe|embed|object|video|audio|track|a)\\b[^>]*?\\b(?:src|href|data)\\s*=\\s*${Q}`, "gi"),
  new RegExp(`(?:^|[\\s;{}])import\\s+${Q}`, "g"),
  new RegExp(`\\b(?:vi|jest)\\.(?:mock|doMock|importActual|importMock|unmock|requireActual|requireMock)\\s*\\(${OPEN}${Q}`, "g"),
  new RegExp(`\\bnew\\s+URL\\s*\\(${OPEN}${Q}`, "g"),
  /\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"\n]+)\1/g,
];

/** `import.meta.glob("./a/*.ts")` and `import.meta.glob(["./a/*.ts", "!./b/*"])`: every string among its arguments. */
const GLOB_CALL = /\b(?:import\.meta\.glob(?:Eager)?(?:<[^>]*>)?|importScripts)\s*\(([^)]*)\)/g;

export function moduleSpecifiers(source: string): Array<{ specifier: string; line: number }> {
  const found: Array<{ specifier: string; line: number }> = [];
  // Where each line starts, so that a match's line number costs a binary search and not a scan from the top of the file.
  const starts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineAt = (index: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  for (const match of source.matchAll(GLOB_CALL)) {
    const line = lineAt(match.index);
    for (const quoted of (match[1] ?? "").matchAll(/(['"`])([^'"`\n$]+)\1/g)) found.push({ specifier: quoted[2]!.replace(/^!/, ""), line });
  }
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier === undefined) continue;
      found.push({ specifier, line: lineAt(match.index) });
    }
  }
  return found;
}

/** Why a module specifier written in `file` reaches Cloud-only code, or null. */
export function cloudImportReason(file: string, specifier: string, names: NameSource = DEFAULT_NAMES): string | null {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
    if (resolved.startsWith("..")) return null;
    const hit = cloudPathRule(resolved, names);
    return hit === null ? null : `imports ${hit.detail}`;
  }
  if (specifier.startsWith("/")) {
    const hit = cloudPathRule(specifier.replace(/^\/+/, ""), names);
    return hit === null ? null : `imports ${hit.detail}`;
  }
  if (specifier.startsWith("#") && SEGMENT.test(specifier.slice(1))) return "imports a Cloud-only package-imports alias";
  if (CLOUD_PACKAGE.test(specifier)) return "imports a Cloud-only package (the web app, its UI or the audit verifier)";
  if (SEGMENT.test(specifier)) return "imports a Cloud-only subpath of a package";
  return null;
}

/** Quoted relative or `file:` paths on a line of a package.json / tsconfig / workflow file that point into Cloud-only code. */
export function wiringPathReasons(file: string, text: string, names: NameSource = DEFAULT_NAMES): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/["']([^"'\n]+)["']/g)) {
    const value = match[1]!.replace(/^(file|link|portal):/, "");
    if (!value.startsWith(".")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), value));
    if (!resolved.startsWith("..") && cloudPathRule(resolved, names) !== null) out.push("points into Cloud-only code");
  }
  return out;
}

/** The imports of a TypeScript/JavaScript source that reach Cloud-only code. */
export function importFindings(file: string, source: string, names: NameSource = DEFAULT_NAMES): Finding[] {
  if (!CODE_FILE.test(file)) return [];
  const out: Finding[] = [];
  for (const { specifier, line } of moduleSpecifiers(source)) {
    const reason = cloudImportReason(file, specifier, names);
    if (reason !== null) out.push({ rule: "cloud-import", file, line, detail: reason });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rule: private-name (added lines only).

/** AWS documentation placeholder account ids. They name no real account. */
const PLACEHOLDER_ACCOUNTS = new Set(["123456789012", "111122223333", "222222222222", "000000000000", "999988887777", "210987654321"]);
/** API Gateway host labels that are obvious placeholders (a real API id is ten random letters and digits). */
const PLACEHOLDER_API_IDS = new Set(["abc", "abc123", "example", "examplehost", "test"]);

/**
 * Prospect and customer names, internal build-system names and the other words that must never appear in public are NOT written in this
 * file: only salted SHA-256 hashes of them (the salt is public, so the list cannot be read back, though a short common word can still be
 * guessed and hashed). Text is folded to ASCII, split into [a-z0-9] words (also at camel-case and letter/digit boundaries), and each word
 * and each run of two or three adjacent words, joined, is looked up. A 32-bit FNV-1a value of the same word is kept beside each hash so
 * that only likely candidates are hashed (a 100,000-line file stays fast). The extended list the controller keeps outside the repository
 * (PORT_GUARD_PRIVATE_NAMES, one regular expression per line) is applied on top with the same folding and line-splitting logic.
 */
export interface NameEntry {
  label: string;
  fnv: number;
  sha: string;
  /** Set (to the word's length) for a word that is also refused glued inside a longer word, as the earlier substring match did. */
  len?: number;
}
export interface NameSource {
  /** The salt put before every word before hashing: `sha256(salt + ":" + word)`. */
  salt: string;
  /** Names: looked up as a word or as a join of two or three adjacent words. */
  entries: readonly NameEntry[];
  /** Words that mark the internal build-system detector in a TypeScript/JavaScript file's path. */
  detectors: readonly NameEntry[];
  /** The controller's private extended list, as regular expressions (matched case-insensitively on the folded text). */
  patterns: readonly RegExp[];
}

export const NAME_SALT = "rovara-port-guard-names-v1";

/** 32-bit FNV-1a of a string of UTF-16 code units. */
export function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashWord(salt: string, word: string): string {
  return createHash("sha256").update(`${salt}:${word}`).digest("hex");
}

/** A name source from plain words (for tests and for the controller's tooling; the repository itself holds hashes only). */
export function nameSourceFromWords(
  salt: string,
  names: Readonly<Record<string, readonly string[]>>,
  detectors: readonly string[] = [],
  patterns: readonly RegExp[] = [],
  glued: readonly string[] = [],
): NameSource {
  const entry = (label: string, word: string): NameEntry => ({
    label,
    fnv: fnv1a(word),
    sha: hashWord(salt, word),
    ...(glued.includes(word) ? { len: word.length } : {}),
  });
  return {
    salt,
    entries: Object.entries(names).flatMap(([label, words]) => words.map((word) => entry(label, word))),
    detectors: detectors.map((word) => entry("the internal build-system detector", word)),
    patterns,
  };
}

const DEFAULT_ENTRIES: readonly NameEntry[] = [
  { label: "a prospect or customer name", fnv: 2493420191, sha: "31406dc9bc917735f9566c6c04d2d0ee25d0992fdd7f70d858a55a2fa74b4d43", len: 6 },
  { label: "a prospect or customer name", fnv: 3191371333, sha: "3e2afa0a8c014a8daf3cbcb28e02732fcd1833e653e711609eb2883911a4f4b6", len: 5 },
  { label: "a prospect or customer name", fnv: 2941995673, sha: "314f1b385dcd1ee0db9cd1121b3bfee98ecfe5a36b697382faf38c98cc5c4542" },
  { label: "a prospect or customer name", fnv: 4290217838, sha: "34a11f05e52e21c34d83012b1f4f9b07a7b2868eae43c1b57d8a13a8ed02d231" },
  { label: "an internal build-system name", fnv: 694238375, sha: "4de9fc530b09e3559615077c2ef2d26ffaa248915b3b231f2d3b8d15a3b47e68", len: 7 },
  { label: "an internal build-system name", fnv: 1741298301, sha: "4cd0e7c8a9aebbc41788d5775058cac3e8b01a35e5ad3e3a6afc8e087dba732b", len: 11 },
  { label: "a prospect pilot name", fnv: 3827887625, sha: "d666d04bd88e5135126f4806c2eb8e60ddcc270b3678dc4d82438ae47978e9ac", len: 11 },
  { label: "a prospect pilot name", fnv: 4157596708, sha: "107f5f03468502145987f26dcaa527ea457b8a91e481818c9485e743ead32050", len: 10 },
  { label: "a prospect pilot name", fnv: 1356487453, sha: "e81ea3d03b89bde150d1840221d478dccd004df637b5a6718902457479afd7a8" },
  { label: "a prospect product name", fnv: 1800621379, sha: "9a34ede7b086ee57c3eb5919e4d822be75d5f5a663a983bcbb63852171cbfbfc", len: 15 },
  { label: "the staging account id", fnv: 768729539, sha: "699050960619e7a80b433b54ac72d202beee7d04f5737eb33a3ae4d0c7d5718d", len: 12 },
  { label: "the private repository name", fnv: 838782955, sha: "1696afefb858617e6b341027e68db7f492f801e7013cc70644c036883d64cac4" },
];
const DEFAULT_DETECTORS: readonly NameEntry[] = [
  { label: "the internal build-system detector", fnv: 2469444183, sha: "cedb6af9fe7ce1177ad9a2bfff7707c36c89babb67c33253d6a40ad19fc6d6b7" },
];

export const DEFAULT_NAMES: NameSource = { salt: NAME_SALT, entries: DEFAULT_ENTRIES, detectors: DEFAULT_DETECTORS, patterns: [] };

/** Lookup tables for a name source, built once per source. */
interface Matcher {
  salt: string;
  names: ReadonlyMap<number, readonly NameEntry[]>;
  /** The names that are also refused glued inside a longer word, and the lengths they come in. */
  glued: ReadonlyMap<number, readonly NameEntry[]>;
  gluedLengths: readonly number[];
  detectors: ReadonlyMap<number, readonly NameEntry[]>;
  patterns: readonly RegExp[];
}
const matchers = new WeakMap<NameSource, Matcher>();
function matcherFor(source: NameSource): Matcher {
  let matcher = matchers.get(source);
  if (matcher === undefined) {
    const index = (entries: readonly NameEntry[]): Map<number, NameEntry[]> => {
      const map = new Map<number, NameEntry[]>();
      for (const entry of entries) map.set(entry.fnv, [...(map.get(entry.fnv) ?? []), entry]);
      return map;
    };
    const gluedEntries = source.entries.filter((entry) => entry.len !== undefined);
    matcher = {
      salt: source.salt,
      names: index(source.entries),
      glued: index(gluedEntries),
      gluedLengths: [...new Set(gluedEntries.map((entry) => entry.len!))].sort((x, y) => x - y),
      detectors: index(source.detectors),
      patterns: source.patterns,
    };
    matchers.set(source, matcher);
  }
  return matcher;
}

/** The longest word or join worth looking up; nothing on the list is near this long. */
const LONGEST_NAME = 48;

/** The labels of the words and the two- and three-word joins among `tokens` that are on the list. */
function matchNames(tokens: readonly string[], matcher: Matcher, table: "names" | "detectors" = "names"): Set<string> {
  const found = new Set<string>();
  const index = matcher[table];
  const test = (entries: readonly NameEntry[] | undefined, candidate: string): void => {
    if (entries === undefined) return;
    const sha = hashWord(matcher.salt, candidate);
    for (const entry of entries) if (entry.sha === sha) found.add(entry.label);
  };
  const check = (candidate: string, single: boolean): void => {
    test(index.get(fnv1a(candidate)), candidate);
    // A listed word glued inside a longer word, as in a user name or a prefixed form: every window of a listed length. Looked up in single
    // words only, which keeps ordinary code fast.
    if (single && table === "names") {
      for (const length of matcher.gluedLengths) {
        if (length >= candidate.length) break;
        for (let start = 0; start + length <= candidate.length; start += 1) {
          const window = candidate.slice(start, start + length);
          test(matcher.glued.get(fnv1a(window)), window);
        }
      }
    }
  };
  const joins = table === "names" ? 3 : 1;
  for (let i = 0; i < tokens.length; i += 1) {
    let candidate = tokens[i]!;
    if (candidate.length > LONGEST_NAME) continue;
    check(candidate, true);
    for (let n = 1; n < joins && i + n < tokens.length; n += 1) {
      candidate += tokens[i + n]!;
      if (candidate.length > LONGEST_NAME) break;
      check(candidate, false);
    }
  }
  return found;
}

const tokenize = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** The word lists of a text: as folded to ASCII, and again with words also split at camel-case and letter/digit boundaries. */
function tokenViews(raw: string): string[][] {
  const views = [tokenize(foldToAscii(raw))];
  const spaced = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2");
  if (spaced !== raw) views.push(tokenize(foldToAscii(spaced)));
  return views;
}

/** Labels of the names (hashed list and private patterns) that a text holds. */
function nameLabels(raw: string, names: NameSource): Set<string> {
  const matcher = matcherFor(names);
  const found = new Set<string>();
  for (const tokens of tokenViews(raw)) for (const label of matchNames(tokens, matcher)) found.add(label);
  if (matcher.patterns.length > 0) {
    const folded = foldToAscii(raw);
    for (const pattern of matcher.patterns) if (pattern.test(folded)) found.add("a name from the private list");
  }
  return found;
}

/** Not names but shapes: a host under the product's dev domain. */
const DEV_HOST = new RegExp(`rovara\\.${join("d", "ev")}(?![a-z0-9-])`, "i");

/**
 * The private extended list: one regular expression per line; blank lines and lines starting with # are skipped; lines are trimmed (write \s
 * for a deliberate space and \x23 for a leading #). The patterns run on every added line, so avoid nested quantifiers: a catastrophic pattern
 * would hang the guard.
 */
export function loadPrivatePatterns(file: string): RegExp[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new GuardError(`could not read the private name list ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter(({ text }) => text !== "" && !text.startsWith("#"))
    .map(({ text, number }) => {
      try {
        return new RegExp(text, "i");
      } catch {
        throw new GuardError(`the private name list ${file} holds a line (line ${number}) that is not a regular expression`);
      }
    });
}

const ARN_ACCOUNT = /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12})(?!\d)/gi;
const ECR_ACCOUNT = /(?<!\d)(\d{12})\.dkr\.ecr\./gi;
const ACCOUNT_FIELD = /account(?:[_-]?id)?["']?\s*[:=]\s*["']?(\d{12})(?!\d)/gi;
const API_HOST = /(?<![a-z0-9-])(?:([a-z0-9-]+)\.)?execute-api\.[a-z0-9.-]+/gi;

/** Letters from other alphabets that read as Latin ones, and the zero-width characters that hide a name from a pattern. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "н": "h", "і": "i", "ј": "j", "к": "k", "ӏ": "l", "м": "m", "о": "o", "р": "p",
  "ѕ": "s", "т": "t", "у": "y", "х": "x", "ѵ": "v", "ɡ": "g", "ı": "i",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "﹘": "-", "﹣": "-",
  "г": "r", "ɑ": "a", "ϲ": "c", "ȷ": "j", "ɩ": "i", "ꜱ": "s", "ʜ": "h", "ᴠ": "v", "ᴏ": "o", "ᴄ": "c", "ᴀ": "a", "ᴇ": "e", "ɴ": "n", "ʀ": "r",
  "ᴛ": "t", "ɪ": "i", "ᴍ": "m", "ᴊ": "j", "ᴘ": "p", "ᴋ": "k", "ᴅ": "d", "ʟ": "l", "ɢ": "g",
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "γ": "y",
};
/** Code points that draw nothing (soft hyphen, joiners, zero-width spaces, direction marks, variation selectors, byte-order mark). */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
];
const isInvisible = (cp: number): boolean => INVISIBLE_RANGES.some(([from, to]) => cp >= from && cp <= to);

/** The text as a reader sees it in ASCII: compatibility forms (full-width, ligatures) folded, accents and invisible characters dropped, look-alikes mapped. */
export function foldToAscii(text: string): string {
  let ascii = true;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text;
  let out = "";
  for (const ch of text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()) {
    if (!isInvisible(ch.codePointAt(0)!)) out += LOOK_ALIKES[ch] ?? ch;
  }
  return out;
}

/** Name labels found in text that spans several added lines but in none of them alone (a name broken over two lines). */
export function splitNameFindings(lines: readonly string[], names: NameSource = DEFAULT_NAMES): string[] {
  // A comment marker at the start of each line is not part of the text; a word may also break in its middle, so join both ways.
  const bare = lines.map((line) => line.replace(/^\s*(?:\/\/+|\/?\*+\/?|#+|--+|;+|>+|%+)?[ \t]?/, "").replace(/\s+$/, ""));
  const found = new Set<string>();
  for (const text of [bare.join("\n"), bare.join("")]) for (const label of nameLabels(text, names)) found.add(label);
  if (found.size === 0) return [];
  for (const line of lines) for (const label of nameLabels(line, names)) found.delete(label);
  return [...found];
}

/** What on one added line must not reach the public repository. Labels only, never the text. */
export function lineFindings(raw: string, names: NameSource = DEFAULT_NAMES): string[] {
  const line = foldToAscii(raw);
  const out: string[] = [...nameLabels(raw, names)];
  if (DEV_HOST.test(line)) out.push("a host under the product's dev domain");
  for (const match of line.matchAll(ARN_ACCOUNT)) {
    if (!PLACEHOLDER_ACCOUNTS.has(match[1] ?? "")) out.push("an account id inside an ARN");
  }
  for (const pattern of [ECR_ACCOUNT, ACCOUNT_FIELD]) {
    for (const match of line.matchAll(pattern)) {
      if (!PLACEHOLDER_ACCOUNTS.has(match[1] ?? "")) out.push("an AWS account id");
    }
  }
  for (const match of line.matchAll(API_HOST)) {
    const label = match[1]?.toLowerCase();
    if (label !== undefined && !PLACEHOLDER_API_IDS.has(label)) out.push("an API Gateway host");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Patches.

export interface AddedLine { file: string; line: number; text: string }

/** C-style unquoting of a path git printed in double quotes. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch));
      continue;
    }
    const next = inner[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))![0];
      bytes.push(Number.parseInt(octal, 8));
      i += octal.length;
      continue;
    }
    const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The lines a `git diff -U0` / `git diff-tree -p -U0` patch adds, with their line numbers in the new file. */
export function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let remainingOld = 0;
  let remainingNew = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (remainingOld > 0 && line.startsWith("-")) {
      remainingOld -= 1;
      continue;
    }
    if (remainingNew > 0 && line.startsWith("+")) {
      if (file !== null) out.push({ file, line: newLine, text: line.slice(1) });
      remainingNew -= 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("diff --git ")) {
      file = null;
      remainingOld = 0;
      remainingNew = 0;
    } else if (line.startsWith("+++ ")) {
      const target = unquote(line.slice(4).replace(/\t.*$/, ""));
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
    } else if (line.startsWith("@@")) {
      const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header === null) continue;
      remainingOld = header[1] === undefined ? 1 : Number(header[1]);
      newLine = Number(header[2]);
      remainingNew = header[3] === undefined ? 1 : Number(header[3]);
    }
  }
  return out;
}

/**
 * The lines a merge commit adds that none of its parents had, from `git diff-tree --cc -p -U0`: the content of an "evil merge".
 * A combined hunk header carries one `-range` per parent and each line starts with one column per parent.
 */
export function addedLinesCombined(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let columns = 0;
  let remaining = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (remaining > 0 && columns > 0) {
      const head = line.slice(0, columns);
      if (head.length === columns && /^[ +-]+$/.test(head)) {
        if (!head.includes("-")) {
          if (/^\++$/.test(head) && file !== null) out.push({ file, line: newLine, text: line.slice(columns) });
          newLine += 1;
          remaining -= 1;
        }
        continue;
      }
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      file = null;
      remaining = 0;
    } else if (line.startsWith("+++ ")) {
      const target = unquote(line.slice(4).replace(/\t.*$/, ""));
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
    } else if (line.startsWith("@@@")) {
      const header = /^(@@@+) (?:-\S+ )+\+(\d+)(?:,(\d+))? @@@+/.exec(line);
      if (header === null) continue;
      columns = header[1]!.length - 1;
      newLine = Number(header[2]);
      remaining = header[3] === undefined ? 1 : Number(header[3]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Git.

function git(cwd: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.error !== undefined) throw new GuardError(`could not run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new GuardError(`git ${args[0]} failed: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  }
  return result.status === 0 ? result.stdout : "";
}

export interface Range { base: string; tip: string; text: string }

/** `A..B` or `A...B`. A bare revision is refused: the guard must know where the lane's work starts. */
export function parseRange(cwd: string, text: string): Range {
  const match = /^(.+?)(\.\.\.?)(.+)$/.exec(text);
  if (match === null) throw new GuardError(`the range "${text}" must look like <base>..<tip>`);
  const [, left, , right] = match;
  for (const rev of [left!, right!]) {
    if (rev.startsWith("-") || /\s/.test(rev)) throw new GuardError(`"${rev}" is not a revision`);
  }
  const resolve = (rev: string): string => {
    const out = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], true).trim();
    if (out === "") throw new GuardError(`"${rev}" is not a commit in this repository (did you fetch?)`);
    return out;
  };
  return { base: resolve(left!), tip: resolve(right!), text };
}

interface RawEntry { path: string; newMode: string; newSha: string }

/** The files a diff leaves in place (added, copied, modified, type-changed), with the new file mode. Renames are not followed. */
function rawEntries(cwd: string, command: string[]): RawEntry[] {
  const out = git(cwd, [...command, "--raw", "-z", "--no-abbrev", "--no-renames", "--diff-filter=d"]);
  const parts = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.split(/\s+/);
    const path = parts[i + 1]!;
    if (path === "") continue;
    entries.push({ path, newMode: meta[1] ?? "", newSha: meta[3] ?? "" });
  }
  return entries;
}

/**
 * The files a merge commit changed against all its parents at once, with the mode and blob the merge left. The combined raw format is
 * `::<mode of each parent> <mode left> <blob of each parent> <blob left> <status>`, one colon per parent.
 */
function combinedEntries(cwd: string, commit: string): RawEntry[] {
  const parts = git(cwd, ["diff-tree", "--cc", "-r", "--no-commit-id", "--raw", "-z", "--no-abbrev", commit]).split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    const parents = /^:+/.exec(meta)?.[0].length ?? 0;
    const fields = meta.slice(parents).split(/\s+/);
    const newMode = fields[parents] ?? "";
    if (path === "" || newMode === "000000") continue;
    entries.push({ path, newMode, newSha: fields[2 * parents + 1] ?? "" });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The scan.

/** The comment that tells gitleaks to skip a line; spelled in two pieces so that this file does not carry it. */
const INLINE_ALLOW = new RegExp(join("gitleaks", ":", "allow"), "i");

const GUARD_FILES = [
  /^scripts\/port-guard\.ts$/i,
  /^tests\/[^/]+\/port-guard[^/]*$/i,
  /^\.github\/workflows\/ci\.yml$/i,
  /(^|\/)\.gitleaks[^/]*$/i,
];

class Collector {
  readonly findings: Finding[] = [];
  readonly names: NameSource;
  constructor(names: NameSource) {
    this.names = names;
  }
  /** The lines the range adds to each file (keyed by a digest of path and text), for the second gitleaks pass. */
  readonly addedText = new Map<string, { path: string; text: string }>();
  /** Merge commit -> the lines its own resolution added (combined diff), for gitleaks to read from stdin. */
  readonly mergePatches = new Map<string, string>();
  private readonly seen = new Set<string>();
  add(finding: Finding): void {
    const key = `${finding.rule}|${finding.file}|${finding.line ?? ""}|${finding.detail}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.findings.push(finding);
  }
}

export interface ScanInput {
  cwd: string;
  /** One commit to scan against its parent (a root commit against nothing), or a merge against all its parents at once. */
  commit?: string;
  merge?: boolean;
  /** For the net diff: the merge base. */
  base?: string;
  tip: string;
  allowGuardEdits: boolean;
}

function scanChange(collector: Collector, input: ScanInput): void {
  const { cwd, tip, allowGuardEdits } = input;
  const label = input.commit === undefined ? undefined : input.commit.slice(0, 8);
  const add = (finding: Finding): void => collector.add(label === undefined ? finding : { ...finding, commit: label });

  let entries: RawEntry[];
  let patchCommand: string[];
  let parse: (patch: string) => AddedLine[] = addedLines;
  if (input.commit === undefined) {
    // The net diff from the merge base to the tip.
    const command = ["diff", input.base!, tip];
    entries = rawEntries(cwd, command);
    patchCommand = command;
  } else if (input.merge === true) {
    // A merge: only what no parent had (its conflict resolutions and anything slipped in), as the other commits show their own work.
    entries = combinedEntries(cwd, input.commit);
    patchCommand = ["diff-tree", "--cc", "--no-commit-id", input.commit];
    parse = addedLinesCombined;
  } else {
    // A commit against its parent (--root lets a first commit show too).
    const command = ["diff-tree", "--root", "-r", "--no-commit-id", input.commit];
    entries = rawEntries(cwd, command);
    patchCommand = command;
  }

  for (const { path, newMode } of entries) {
    const pathHit = cloudPathRule(path, collector.names);
    if (pathHit !== null) add({ rule: pathHit.rule, file: path, line: null, detail: pathHit.detail });
    // A file or directory named after a prospect or a private host is as public as its contents.
    for (const detail of lineFindings(path, collector.names)) add({ rule: "private-name", file: path, line: null, detail: `${detail} in a file name` });
    if (newMode === "120000" || newMode === "160000") {
      add({ rule: "link", file: path, line: null, detail: newMode === "160000" ? "a submodule" : "a symlink" });
    }
    if (!allowGuardEdits && GUARD_FILES.some((pattern) => pattern.test(path))) {
      add({ rule: "guard-files", file: path, line: null, detail: "the guard, its tests or the CI workflow changed; the controller reviews this by hand" });
    }
    if (/(^|\/)\.gitleaks(ignore|\.toml)$/i.test(path)) {
      add({ rule: "scan-bypass", file: path, line: null, detail: "a gitleaks config or ignore file would change what the secret scan sees" });
    }
    // The file as the range leaves it: its imports, wherever in the file they are.
    if (input.commit === undefined && CODE_FILE.test(path) && newMode !== "120000" && newMode !== "160000") {
      const blob = git(cwd, ["cat-file", "blob", `${tip}:${path}`], true);
      for (const finding of importFindings(path, blob, collector.names)) add(finding);
    }
  }

  // --text: a gitattributes `-diff`/`binary` entry or a NUL byte must not turn a file's lines into "Binary files differ".
  const patch = git(cwd, [...patchCommand, "-p", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-renames", "--diff-filter=d", "--src-prefix=a/", "--dst-prefix=b/"]);
  if (input.merge === true && input.commit !== undefined) {
    const lines = parse(patch).map((added) => added.text);
    if (lines.length > 0) collector.mergePatches.set(input.commit, lines.join("\n") + "\n");
  }
  const added = parse(patch);
  // The second gitleaks pass reads what the range adds to every file, under a neutral name: its default config skips files by name
  // (lockfiles, images, vendor directories and more). Only added lines, so a file that already held a public fixture is not re-judged.
  const perFile = new Map<string, string[]>();
  // Linear in the added lines (re-check 3, R3-1): append in place instead of copying the array for every line.
  for (const { file, text } of added) {
    let lines = perFile.get(file);
    if (lines === undefined) { lines = []; perFile.set(file, lines); }
    lines.push(text);
  }
  for (const [path, texts] of perFile) {
    const text = texts.join("\n") + "\n";
    collector.addedText.set(createHash("sha1").update(path).update("\0").update(text).digest("hex"), { path, text });
  }
  // A name broken over two added lines: the lines of one hunk, joined.
  for (let start = 0; start < added.length; ) {
    let end = start + 1;
    while (end < added.length && added[end]!.file === added[start]!.file && added[end]!.line === added[end - 1]!.line + 1) end += 1;
    if (end - start > 1) {
      const first = added[start]!;
      for (const detail of splitNameFindings(added.slice(start, end).map((a) => a.text), collector.names)) {
        add({ rule: "private-name", file: first.file, line: first.line, detail: `${detail} (split over lines)` });
      }
    }
    start = end;
  }
  for (const { file, line, text } of added) {
    for (const detail of lineFindings(text, collector.names)) add({ rule: "private-name", file, line, detail });
    if (INLINE_ALLOW.test(text)) add({ rule: "scan-bypass", file, line, detail: "an inline allow comment for gitleaks" });
    // Every line of an import is checked in the added text too, so an import added and later removed is still caught.
    if (CODE_FILE.test(file)) for (const finding of importFindings(file, text, collector.names)) add({ ...finding, line });
    if (WIRING_FILE.test(file)) {
      if (CLOUD_PACKAGE_ANYWHERE.test(text)) {
        add({ rule: "cloud-import", file, line, detail: "names a Cloud-only package (the web app, its UI or the audit verifier)" });
      }
      for (const detail of wiringPathReasons(file, text, collector.names)) add({ rule: "cloud-import", file, line, detail });
    }
    // The guard's own entry point: a lane must not point `npm run port:guard` at something else.
    if (/(^|\/)package\.json$/i.test(file) && /port:guard/.test(text) && !allowGuardEdits) {
      add({ rule: "guard-files", file, line, detail: "the port:guard script changed; the controller reviews this by hand" });
    }
  }

  // The commit message and who wrote it travel with the push.
  if (input.commit !== undefined) {
    const header = git(cwd, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%B", input.commit]).split("\n");
    header.forEach((text, index) => {
      for (const detail of lineFindings(text, collector.names)) add({ rule: "private-name", file: "(commit message or author)", line: index + 1, detail });
    });
    for (const detail of splitNameFindings(header.slice(4), collector.names)) add({ rule: "private-name", file: "(commit message or author)", line: 1, detail: `${detail} (split over lines)` });
  }
}

export interface GuardOptions {
  cwd: string;
  range: string;
  allowGuardEdits?: boolean;
  /** "run" (the default and the only value the command line uses) or "off" for unit tests of the other rules. */
  gitleaks?: "run" | "off";
  /** The names to refuse (hashes and the private list); the command line builds it from the default list and PORT_GUARD_PRIVATE_NAMES. */
  names?: NameSource;
  /** The gitleaks executable; tests point it at a name that does not exist to prove the failure is loud. */
  gitleaksBin?: string;
}

export interface GuardResult { findings: Finding[]; commits: number; range: Range }

interface LeakReport { RuleID?: string; File?: string; StartLine?: number; Commit?: string }

function runGitleaks(options: GuardOptions, range: Range, collector: Collector): void {
  const bin = options.gitleaksBin ?? "gitleaks";
  const scratch = mkdtempSync(joinPath(tmpdir(), "port-guard-"));
  try {
    // A trusted config and an empty ignore folder: the lane's own .gitleaks.toml / .gitleaksignore must not decide what is scanned.
    const config = joinPath(scratch, "gitleaks.toml");
    writeFileSync(config, 'title = "port-guard"\n[extend]\nuseDefault = true\n');
    const emptyIgnore = joinPath(scratch, "no-ignore");
    mkdirSync(emptyIgnore);
    const scan = (subcommand: string[], cwd: string, report: string, stdin?: string): LeakReport[] => {
      const result = spawnSync(
        bin,
        [
          ...subcommand.slice(0, 1), "--no-banner", "--redact", "--exit-code", "2", "--ignore-gitleaks-allow",
          "--config", config, "--gitleaks-ignore-path", emptyIgnore, "--report-format", "json", "--report-path", report,
          ...subcommand.slice(1),
        ],
        { cwd, encoding: "utf8", maxBuffer: 1 << 28, ...(stdin === undefined ? {} : { input: stdin }) },
      );
      if (result.error !== undefined) {
        const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
        throw new GuardError(missing
          ? `gitleaks is not installed (looked for "${bin}"). Install it (brew install gitleaks) and run the guard again; it will not pass without the secret scan.`
          : `could not run gitleaks: ${result.error.message}`);
      }
      if (result.status === 0) return [];
      if (result.status !== 2) throw new GuardError(`gitleaks failed with status ${result.status}: ${(result.stderr ?? "").trim().split("\n").slice(-1)[0] ?? ""}`);
      let leaks: LeakReport[];
      try {
        leaks = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as LeakReport[]) : [];
      } catch {
        throw new GuardError("gitleaks reported a finding but its report could not be read");
      }
      if (leaks.length === 0) throw new GuardError("gitleaks reported a finding but its report was empty");
      return leaks;
    };

    // Pass 1: every patch in the range. --text keeps gitattributes from hiding a file. Merge commits show no patch here (-m would diff them
    // against each parent and re-report everything the base gained since a stale parent); their own additions are pass 3.
    for (const leak of scan(["git", `--log-opts=--text ${range.base}..${range.tip}`, "."], options.cwd, joinPath(scratch, "report.json"))) {
      collector.add({
        rule: "secret",
        file: leak.File ?? "(unknown file)",
        line: leak.StartLine ?? null,
        detail: `gitleaks rule ${leak.RuleID ?? "unknown"}`,
        ...(leak.Commit === undefined ? {} : { commit: leak.Commit.slice(0, 8) }),
      });
    }

    // Pass 2: gitleaks's default config skips whole classes of files by path (lockfiles, images, node_modules, vendor directories, any path
    // containing its own config's name, and more). So the lines the range adds to every file are written under neutral names and scanned as
    // plain files; the path cannot excuse what is inside. Files pass 1 already reported are not scanned again.
    const reported = new Set(collector.findings.filter((f) => f.rule === "secret").map((f) => f.file));
    const pending = [...collector.addedText.values()].filter((entry) => !reported.has(entry.path));
    if (pending.length > 0) {
      const blobs = joinPath(scratch, "blobs");
      mkdirSync(blobs);
      const names = new Map<string, string>();
      pending.forEach((entry, index) => {
        const name = `blob-${index + 1}.txt`;
        writeFileSync(joinPath(blobs, name), entry.text);
        names.set(name, entry.path);
      });
      for (const leak of scan(["dir", blobs], options.cwd, joinPath(scratch, "report-blobs.json"))) {
        const name = (leak.File ?? "").split("/").pop() ?? "";
        collector.add({
          rule: "secret",
          file: names.get(name) ?? "(unknown file)",
          line: null,
          detail: `gitleaks rule ${leak.RuleID ?? "unknown"} (in the added lines)`,
        });
      }
    }

    // Pass 3: what each merge commit's own resolution added (nothing a parent had), read from the guard's combined diff.
    for (const [commit, text] of collector.mergePatches) {
      for (const leak of scan(["stdin"], options.cwd, joinPath(scratch, `report-merge-${commit.slice(0, 8)}.json`), text)) {
        collector.add({
          rule: "secret",
          file: "(merge commit's own changes)",
          line: leak.StartLine ?? null,
          detail: `gitleaks rule ${leak.RuleID ?? "unknown"}`,
          commit: commit.slice(0, 8),
        });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runGuard(options: GuardOptions): GuardResult {
  const range = parseRange(options.cwd, options.range);
  const collector = new Collector(options.names ?? DEFAULT_NAMES);
  const mergeBase = git(options.cwd, ["merge-base", range.base, range.tip], true).trim();
  if (mergeBase === "") throw new GuardError(`"${range.text}" has no common ancestor; the guard needs the lane's base`);
  const allowGuardEdits = options.allowGuardEdits === true;
  scanChange(collector, { cwd: options.cwd, base: mergeBase, tip: range.tip, allowGuardEdits });
  const commits = git(options.cwd, ["rev-list", "--reverse", "--parents", `${range.base}..${range.tip}`])
    .split("\n")
    .filter((row) => row !== "")
    .map((row) => row.split(" "));
  for (const [commit, ...parents] of commits) {
    scanChange(collector, { cwd: options.cwd, commit: commit!, merge: parents.length > 1, tip: range.tip, allowGuardEdits });
  }
  if (options.gitleaks !== "off") runGitleaks(options, range, collector);
  return { findings: collector.findings, commits: commits.length, range };
}

export function formatFinding(finding: Finding): string {
  const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const commit = finding.commit === undefined ? "" : ` (commit ${finding.commit})`;
  return `${where}  [${finding.rule}] ${finding.detail}${commit}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Command line.

export const DEFAULT_RANGE = "origin/code/next..HEAD";

export function main(argv: readonly string[]): number {
  let range = DEFAULT_RANGE;
  let allowGuardEdits = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--range") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("port-guard: --range needs a value such as origin/code/next..HEAD");
        return 2;
      }
      range = value;
      i += 1;
    } else if (arg.startsWith("--range=")) range = arg.slice("--range=".length);
    else if (arg === "--allow-guard-edits") allowGuardEdits = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/port-guard.ts [--range <base>..<tip>] [--allow-guard-edits]\n(default range: " + DEFAULT_RANGE + ")");
      return 0;
    } else {
      console.error(`port-guard: unknown argument ${arg}`);
      return 2;
    }
  }
  try {
    const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (root.status !== 0) throw new GuardError("run the guard from inside the lane's worktree");
    // The controller's extended name list lives outside the repository; without it only the hashed list is checked.
    const privateList = process.env.PORT_GUARD_PRIVATE_NAMES;
    let names = DEFAULT_NAMES;
    if (privateList === undefined || privateList === "") {
      console.log("port-guard: note: the extended name list was not loaded (PORT_GUARD_PRIVATE_NAMES is not set); only the built-in hashed list was checked.");
    } else {
      names = { ...DEFAULT_NAMES, patterns: loadPrivatePatterns(privateList) };
    }
    const result = runGuard({ cwd: root.stdout.trim(), range, allowGuardEdits, names });
    if (result.findings.length === 0) {
      console.log(`port-guard: clean. ${result.commits} commit${result.commits === 1 ? "" : "s"} in ${range}; no Cloud-only path or import, no private name, no secret.`);
      return 0;
    }
    for (const finding of result.findings) console.error(formatFinding(finding));
    console.error(`port-guard: ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} in ${range}. Nothing here may reach the public repository.`);
    return 1;
  } catch (error) {
    console.error(`port-guard: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1]?.endsWith("port-guard.ts")) process.exitCode = main(process.argv.slice(2));
