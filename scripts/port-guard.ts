// The port guard: the first check a Rovara Code port lane runs (docs/porting.md). It looks at the work a lane adds to public
// `code/next` and fails when that work carries something that must never reach the public repository:
//
//   cloud-path      a Cloud-only path (decision 41): org/, spend/, audit/, team-record/, devices/, the Cloud web app and audit verifier
//                   packages, the Cloud upgrade command, the Cloud CDK stacks, the Cloud-only contracts files
//   cloud-aws       the AWS line (decision 72, O2): only four generic adapters (DynamoDB, SQS, S3, Secrets Manager) may be public, and they live in one
//                   package. Refused: a NEW file under an aws/ directory, a NEW file under infra/ (Cloud's CDK), a private adapter inside the adapters
//                   package, and an AWS SDK client or CDK import outside that list in the adapters package or in a new file.
//                   The list is data (scripts/boundary-allowlist.json), read by this guard and by Cloud's boundary check
//   cloud-import    a TypeScript/JavaScript file (any name that carries a .ts/.js/... extension, or text that reads as such code) that imports one of those (also a vendor/ folder, a `cloud-*` package or an AWS client off the list), or a package/CI file that names one of those packages
//   stray-file      an editor, merge or sed backup/scratch file (`*-E`, `*.orig`, `*.rej`, `*.bak`, `*~`, `*.swp`, `*.tmp`, `.DS_Store` and kin): a stray
//                   copy can hold raw Cloud source under a name no other rule reads (a lane once committed 27 `*.ts-E` files from `sed -i -E`)
//   build-detector  the internal build-system detector (decision 45.11: an optional plug-in package, never core)
//   private-name    a prospect or customer name (matched against a salted hash list, so no name is written in this file), the staging account id, an account id inside an ARN, an API Gateway host, a
//                   host under the product's dev domain, a private branch name (an integration or Cloud lane branch), or the private repository's name, on an added line
//   link            a symlink or a submodule (a link can point at a Cloud-only file, and the scan reads blobs, not targets)
//   scan-bypass     an inline allow comment for gitleaks, or a gitleaks config / ignore file (they would switch the secret scan off)
//   guard-files     an edit to the guard itself, its tests, or the CI workflow that runs it (the controller reviews those by hand;
//                   the guard's own lane passes --allow-guard-edits)
//   secret          anything gitleaks finds in the range
//   accepted-stale  an entry of the accepted-findings list whose file the range itself changes or removes (the list must not rot where the range works)
//
// Accepted findings (scripts/port-guard-accepted.json, read from beside this script like the boundary data, never from the checkout): a finding of
// rule cloud-aws or secret is skipped only when its path and rule match an entry AND the file's blob at the range tip is the entry's exact blob. No
// wildcard and no directory: any edit to the file brings every finding about it back, and a new file is never covered. No other rule can be accepted
// (a private name never), and the list itself is a guard file. An entry is judged against the range: its file absent at the tip and untouched by the range,
// it is inactive (a note); present with other content but untouched by the range, a warning; changed or removed by the range itself, an accepted-stale
// finding, and the file is judged on its own merits as if it had no entry.
//
// It checks the range's net diff (merge base to tip) and also every non-merge commit in the range, so a commit that adds a file
// and a later commit that removes it still fails: the history is pushed too. It prints file:line, the rule and a label for the
// pattern, never the text it matched. Exit status: 0 clean, 1 findings, 2 the guard could not run (bad range, git or gitleaks missing).
//
// Node runs this file directly, so only erasable syntax and only Node's own modules. Usage, from inside the lane's worktree:
//   node scripts/port-guard.ts [--range <base>..<tip>] [--allow-guard-edits] [--boundary <file>] [--accepted <file>]      (default range: origin/code/next..HEAD)
// The controller's extended name list (one regular expression per line) is read from the file named by PORT_GUARD_PRIVATE_NAMES, if set.
//
// No name is written in this file or in its tests: the protected words are salted hashes (see NameSource), and the tests use invented names.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath, posix } from "node:path";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------------------------------------------------------------------------
// The boundary data (scripts/boundary-allowlist.json): the Cloud-only package names and the four generic AWS adapters that may be public (decision 72, O2).
// One file, read by this guard and by Cloud's boundary check. It is read from BESIDE this script (or from the file named by --boundary), never from the
// checkout being judged: CI and the controller run a trusted copy of the guard, and a lane must not be able to widen the lists it is judged by. A file
// that cannot be found, read or is malformed stops the guard (exit 2); there is no fallback and no empty default.

export interface PublicAdapter { id: string; port: string; sdk: readonly string[] }
export interface BoundaryData {
  cloudOnlyPackages: readonly string[];
  cloudOnlyPackagePatterns: readonly string[];
  publicAwsAdapters: { package: string; dir: string; adapters: readonly PublicAdapter[] };
  awsSdkPublicPaths: readonly string[];
  /** AWS SDK clients that one named plug-in may import (a sanctioned AWS adapter that is not one of the four): only the listed clients, only in that folder. */
  awsSdkSanctioned: ReadonlyArray<{ id: string; dir: string; sdk: readonly string[]; reason: string }>;
  /** Paths whose files hold SDK and CDK names as text fixtures (env-detect tests); the AWS import rule does not read them. */
  awsImportFixturePaths: readonly string[];
  /** Findings on commits that are already public and cannot be rewritten, each keyed by the full commit sha, the rule and the file. */
  knownHistory: ReadonlyArray<{ commit: string; rule: string; file: string; reason: string }>;
  publicNpmPackages: ReadonlyArray<{ name: string; source: string }>;
}

export const BOUNDARY_FILE = "scripts/boundary-allowlist.json";

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Checks the shape of the boundary data; throws a GuardError that names what is wrong. */
export function parseBoundary(text: string, from: string): BoundaryData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GuardError(`${from} is not valid JSON`);
  }
  const data = raw as Partial<BoundaryData> | null;
  const adapters = data?.publicAwsAdapters;
  const entries = (value: unknown): Array<Record<string, unknown>> | null =>
    Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null) ? (value as Array<Record<string, unknown>>) : null;
  const npm = entries(data?.publicNpmPackages);
  const list = entries(adapters?.adapters);
  const sanctioned = entries(data?.awsSdkSanctioned);
  const history = entries(data?.knownHistory);
  const ok =
    data !== null && typeof data === "object" &&
    isStrings(data.cloudOnlyPackages) && isStrings(data.cloudOnlyPackagePatterns) && isStrings(data.awsSdkPublicPaths) &&
    npm !== null && npm.every((entry) => typeof entry.name === "string" && typeof entry.source === "string") &&
    adapters !== undefined && typeof adapters.package === "string" && typeof adapters.dir === "string" && list !== null && list.length > 0 &&
    list.every((a) => typeof a.id === "string" && /^[a-z0-9-]+$/.test(a.id) && typeof a.port === "string" && isStrings(a.sdk)) &&
    sanctioned !== null && sanctioned.every((e) => typeof e.id === "string" && typeof e.dir === "string" && e.dir.endsWith("/") && isStrings(e.sdk) && typeof e.reason === "string") &&
    isStrings(data.awsImportFixturePaths) &&
    history !== null && history.every((e) => typeof e.commit === "string" && /^[0-9a-f]{40}$/.test(e.commit) && typeof e.rule === "string" && typeof e.file === "string" && typeof e.reason === "string");
  if (!ok) throw new GuardError(`${from} does not have the shape the guard reads (cloudOnlyPackages, cloudOnlyPackagePatterns, publicAwsAdapters, awsSdkPublicPaths, awsSdkSanctioned, awsImportFixturePaths, knownHistory, publicNpmPackages)`);
  for (const pattern of data.cloudOnlyPackagePatterns!) {
    try {
      new RegExp(pattern);
    } catch {
      throw new GuardError(`${from} holds a package pattern that is not a regular expression`);
    }
  }
  return data as BoundaryData;
}

let boundaryCache: BoundaryData | undefined;
let boundaryFile: string | undefined;

/** Reads and checks one boundary data file. */
export function loadBoundary(file: string): BoundaryData {
  if (!existsSync(file)) {
    throw new GuardError(
      `could not find the boundary data ${file}; the guard reads it from beside itself (or from --boundary <file>) and never from the checkout it judges, so a trusted copy of the guard needs the data file next to it`,
    );
  }
  return parseBoundary(readFileSync(file, "utf8"), file);
}

/** Point the guard at a boundary data file (--boundary); the default is the file beside this script. */
export function useBoundaryFile(file: string | undefined): void {
  boundaryFile = file;
  boundaryCache = undefined;
}

/** The boundary data: the file named by --boundary, else the one beside this script. Never the checkout's copy. */
export function boundary(): BoundaryData {
  if (boundaryCache !== undefined) return boundaryCache;
  boundaryCache = loadBoundary(boundaryFile ?? joinPath(dirname(fileURLToPath(import.meta.url)), "boundary-allowlist.json"));
  return boundaryCache;
}

/** Runs `fn` with other boundary data in force (for tests of the data-driven rules). */
export function withBoundary<T>(data: BoundaryData, fn: () => T): T {
  const previous = boundaryCache;
  boundaryCache = data;
  try {
    return fn();
  } finally {
    boundaryCache = previous;
  }
}

/** The service clients and helpers the four public adapters may import, from the boundary data. */
function publicAwsSdk(data: BoundaryData): Set<string> {
  return new Set(data.publicAwsAdapters.adapters.flatMap((adapter) => adapter.sdk));
}

/** The adapters package's directory with a trailing slash, lower-cased for comparing. */
const adaptersDir = (data: BoundaryData): string => `${data.publicAwsAdapters.dir.replace(/\/+$/, "").toLowerCase()}/`;

interface PathRule { label: string; pattern: RegExp }

const CLOUD_PATH_RULES: readonly PathRule[] = [
  { label: `a Cloud-only directory (${CLOUD_DIRS.join(", ")})`, pattern: new RegExp(`(^|/)(${CLOUD_DIRS.join("|")})/`, "i") },
  {
    label: "a Cloud-only contracts file (org*, spend*, audit*, team-record*)",
    pattern: /^packages\/contracts\/src\/(org|spend|audit|team-record)([-.].*)?$/i,
  },
  { label: "a Cloud-only package (the web app, its UI, the model proxy, the design tokens or the audit verifier)", pattern: /^packages\/(ui|web|audit-verifier|model-proxy|design-tokens)(\/|$)/i },
  { label: "a Cloud-only package (a `cloud` or `cloud-*` package)", pattern: /^packages\/cloud(-[^/]+)?(\/|$)/i },
  {
    label: "a vendor/ folder (Cloud keeps its pinned copy of Code in one; a vendor folder never goes into Code)",
    pattern: /(^|\/)vendor\//i,
  },
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
export function cloudPathRule(path: string, names: NameSource = DEFAULT_NAMES): { rule: "cloud-path" | "cloud-aws" | "build-detector"; detail: string } | null {
  const normal = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (CLOUD_PATH_ALLOWED.has(normal.toLowerCase().replace(/\.[cm]?[jt]sx?$/, ""))) return null;
  for (const candidate of [normal, `${normal}/`]) {
    for (const { label, pattern } of CLOUD_PATH_RULES) if (pattern.test(candidate)) return { rule: "cloud-path", detail: label };
  }
  const adapterHit = adaptersPackageRule(normal);
  if (adapterHit !== null) return { rule: "cloud-aws", detail: adapterHit };
  const codeLike = CODE_SOURCE.test(normal) || !/\.[a-z0-9]+$/i.test(posix.basename(normal)) || /(^|\/)env-detect\//i.test(normal);
  if (codeLike && tokenViews(normal).some((tokens) => matchNames(tokens, matcherFor(names), "detectors").size > 0)) {
    return { rule: "build-detector", detail: "the internal build-system detector is an optional plug-in, not core (decision 45.11)" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rule: cloud-aws (decision 72, O2). Only the four generic adapters (DynamoDB storage, SQS queue, S3 objects, Secrets Manager secrets) are public,
// in one package; every other AWS piece (the handlers, the CDK, the EC2, Cognito, Slack and model-gateway adapters) stays in Cloud.

/** Why a path inside the public adapters package is not allowed there (a private adapter among the four), or null. */
export function adaptersPackageRule(path: string): string | null {
  const data = boundary();
  const lower = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const prefix = `${adaptersDir(data)}src/`;
  if (!lower.startsWith(prefix)) return null;
  const first = lower.slice(prefix.length).split("/")[0] ?? "";
  const stem = first.split(".")[0] ?? "";
  if (stem === "index" || data.publicAwsAdapters.adapters.some((adapter) => adapter.id === stem)) return null;
  return "a private adapter inside the public AWS adapters package (only the DynamoDB, SQS, S3 and Secrets Manager adapters may be public, decision 72)";
}

/**
 * Rules for a file that a range or commit ADDS (existing public files that Cloud's history shares are not judged by their names): a new file under
 * an aws/ directory is a Cloud handler, and a new file under infra/ is Cloud's CDK. The four public adapters live in the adapters package, whose
 * directory is not called aws.
 */
export function addedFileRule(path: string): { rule: "cloud-aws"; detail: string } | null {
  const normal = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (/(^|\/)aws\//i.test(normal)) {
    return { rule: "cloud-aws", detail: "a new file under an aws/ directory is a Cloud AWS handler; the four generic adapters live in the adapters package, everything else AWS stays private" };
  }
  if (/^infra\//i.test(normal)) {
    return { rule: "cloud-aws", detail: "a new file under infra/ is Cloud's CDK; Code adds none (Cloud's infrastructure stays private)" };
  }
  return null;
}

/**
 * Why importing `specifier` from `file` crosses the AWS line, or null. An AWS SDK service client or library off the adapters' list, or the CDK, is
 * refused in the adapters package always and in a NEW file elsewhere (a file Code already had keeps what it imports; the install flow under
 * awsSdkPublicPaths may use any client, since it talks to the customer's own account).
 */
export function awsImportReason(file: string, specifier: string, isNewFile: boolean): string | null {
  const data = boundary();
  const lower = file.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const inAdapters = lower.startsWith(adaptersDir(data));
  if (!inAdapters && !isNewFile) return null;
  if (!inAdapters && data.awsSdkPublicPaths.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return null;
  if (!inAdapters && data.awsImportFixturePaths.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return null;
  const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? "");
  // A sanctioned AWS adapter (a plug-in, not one of the four): only the clients named for it, only in its own folder.
  if (!inAdapters && data.awsSdkSanctioned.some((entry) => lower.startsWith(entry.dir.toLowerCase()) && entry.sdk.includes(base))) return null;
  if (/^@aws-sdk\/(client|lib)-/.test(base) && !publicAwsSdk(data).has(base)) {
    return "imports an AWS SDK client or library for a service that is not one of the four public adapters (DynamoDB, SQS, S3, Secrets Manager)";
  }
  if (base === "aws-cdk-lib" || base.startsWith("@aws-cdk/") || base === "constructs") return "imports the AWS CDK, which is Cloud's infrastructure code";
  return null;
}

/** The AWS-line findings among the imports of a piece of source. */
export function awsImportFindings(file: string, source: string, isNewFile: boolean): Finding[] {
  const out: Finding[] = [];
  const testFile = /^tests\//i.test(file.replaceAll("\\", "/")) || /\.test\.[cm]?[jt]sx?$/i.test(file);
  for (const { specifier, line, inString } of moduleSpecifiers(withoutNul(source))) {
    // A test that writes `import ... from "<module>"` inside a string is building a fixture (env-detect reads such text), not importing the module.
    if (inString && testFile) continue;
    const reason = awsImportReason(file, specifier, isNewFile);
    if (reason !== null) out.push({ rule: "cloud-aws", file, line, detail: reason });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rule: stray-file. Editor, merge and sed leftovers: a lane once committed 27 `*.ts-E` files (macOS `sed -i -E` keeps the original under
// the suffix `-E`), raw Cloud source that no other rule read because the name did not end in a code extension.

/** A suffix that makes a file name a leftover, with what it is, in words. Matched on the last path segment, case-insensitively. */
const STRAY_SUFFIXES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /.-E\d*$/, label: "a sed backup (`sed -i -E` on macOS keeps the original as <name>-E)" },
  { pattern: /\..*-e\d*$/i, label: "a sed backup (`sed -i -e` on macOS keeps the original as <name>-e)" },
  { pattern: /[~#]$|,v$/, label: "an editor or version-control backup (trailing ~, # or ,v)" },
  { pattern: /\.(?:orig|rej|bak|backup|bk|tmp|temp)\d*$/i, label: "a merge, patch, editor or scratch leftover" },
  { pattern: /\.sw[pxno]$/i, label: "a vim swap file" },
];
/** Whole names, or names built around a word, that are leftovers wherever they sit in the name. */
const STRAY_NAMES: ReadonlyArray<{ pattern: RegExp; label: string; codeOnly?: boolean }> = [
  { pattern: /^(?:\.ds_store|thumbs\.db|desktop\.ini|\.appledouble|\.localized)$/i, label: "an operating-system metadata file" },
  { pattern: /^\._./, label: "a macOS resource-fork (AppleDouble) file" },
  { pattern: /^#.+#$/, label: "an editor auto-save file (#name#)" },
  { pattern: /^\.#./, label: "an editor lock file (.#name)" },
  { pattern: /^\.~lock\./i, label: "an office-suite lock file" },
  { pattern: /\.(?:orig|rej|bak|backup|swp|swo)\./i, label: "a merge, patch or editor leftover (the marker sits inside the name)" },
  { pattern: /\.(?:BASE|LOCAL|REMOTE|BACKUP)\.\d+/, label: "a merge-tool temporary file" },
  { pattern: /^\.merge_file_/i, label: "a merge-tool temporary file" },
  // Only for source files: a document called "Brand copy.md" is an ordinary name, a source file called "engine copy.ts" is a duplicate.
  { pattern: / copy(?: \d+)?(?:\.|$)/i, label: "a Finder duplicate (\"name copy\")", codeOnly: true },
  { pattern: / \(\d+\)(?:\.|$)/, label: "a browser or Finder duplicate (\"name (1)\")", codeOnly: true },
];

/** Why a repository path is a stray file (an editor, merge or sed leftover), or null. The last path segment decides. */
export function strayFileRule(path: string): { rule: "stray-file"; detail: string } | null {
  const base = posix.basename(path.replaceAll("\\", "/"));
  for (const { pattern, label, codeOnly } of [...STRAY_SUFFIXES, ...STRAY_NAMES] as Array<{ pattern: RegExp; label: string; codeOnly?: boolean }>) {
    if (pattern.test(base) && (codeOnly !== true || isCodeFile(base))) return { rule: "stray-file", detail: label };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rule: cloud-import.

const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less)$/i;
/** A code extension anywhere in the file name, not only at the end: `x.ts-E`, `x.ts.orig`, `x.ts~`, `x.tsx.bak` are still source. */
const CODE_EXT_ANYWHERE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less)(?![a-z0-9])/i;
/** Files that wire packages together: a Cloud-only package named here would pull it into the build (also when a backup suffix follows the name). */
const WIRING_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]+\.ya?ml)(?![a-z0-9])/i;
/** Files larger than this are not read for code-looking text unless their name says code (a huge blob is data, and the read is the cost). */
const SNIFF_LIMIT = 8 << 20;

/** The text with NUL bytes and a byte-order mark removed, so that a UTF-16 copy of a source file reads as the source it is. */
const withoutNul = (text: string): string => (text.includes("\0") || text.startsWith("\uFEFF") ? text.replaceAll("\0", "").replace(/^\uFEFF/, "") : text);

/** True when a file name carries a code extension (at the end or followed by a backup suffix). */
export function isCodeFile(file: string): boolean {
  return CODE_FILE.test(file) || CODE_EXT_ANYWHERE.test(posix.basename(file.replaceAll("\\", "/")));
}

/** True when a file is checked as TypeScript/JavaScript: by its name, or because its text reads as such code. */
export function looksLikeCode(file: string, text: string): boolean {
  return isCodeFile(file) || moduleSpecifiers(withoutNul(text)).length > 0;
}
const CLOUD_PACKAGE = /^@(agentx|rovara|preplabsai)\/(ui|web|audit-verifier|model-proxy|design-tokens|cloud(?:-[a-z0-9-]+)?)(\/|$)/i;
const CLOUD_PACKAGE_ANYWHERE =
  /@(agentx|rovara|preplabsai)\/(ui|web|audit-verifier|model-proxy|design-tokens|cloud(?:-[a-z0-9-]+)?)(?![a-z0-9-])|(^|[^a-z0-9-])packages\/(ui|web|audit-verifier|model-proxy|design-tokens|cloud(?:-[a-z0-9-]+)?)(?![a-z0-9-])/i;
const SEGMENT = new RegExp(`(^|/)(${[...CLOUD_DIRS, "vendor"].join("|")})(/|$)`, "i");

/** The Cloud-only package a specifier names, from the boundary data (exact names and patterns), or null. */
function boundaryPackageHit(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return false;
  const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? "");
  const data = boundary();
  return data.cloudOnlyPackages.includes(base) || data.cloudOnlyPackagePatterns.some((pattern) => new RegExp(pattern, "i").test(base));
}

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

export function moduleSpecifiers(source: string): Array<{ specifier: string; line: number; inString: boolean }> {
  const found: Array<{ specifier: string; line: number; inString: boolean }> = [];
  /** True when an odd number of quote marks precede the match on its own line: the "import" is text inside a string literal. */
  const insideString = (index: number): boolean => {
    const before = source.slice(source.lastIndexOf("\n", index - 1) + 1, index);
    return (before.match(/['"`]/g)?.length ?? 0) % 2 === 1;
  };
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
    for (const quoted of (match[1] ?? "").matchAll(/(['"`])([^'"`\n$]+)\1/g)) found.push({ specifier: quoted[2]!.replace(/^!/, ""), line, inString: false });
  }
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier === undefined) continue;
      found.push({ specifier, line: lineAt(match.index), inString: insideString(match.index) });
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
  if (CLOUD_PACKAGE.test(specifier) || boundaryPackageHit(specifier)) return "imports a Cloud-only package (the web app, its UI, the audit verifier or a cloud-* package)";
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
export function importFindings(file: string, source: string, names: NameSource = DEFAULT_NAMES, force = false): Finding[] {
  if (!force && !isCodeFile(file)) return [];
  const out: Finding[] = [];
  for (const { specifier, line, inString } of moduleSpecifiers(withoutNul(source))) {
    // A path that climbs out of the repository lands inside Cloud's repository once this code is vendored there. Not read in tests (the vendored copy has none, and
    // their fixtures write such paths inside multi-line strings) nor as text in a string.
    const outside = specifier.startsWith(".") && !inString && !/^tests\//i.test(file) && !/\.test\.[cm]?[jt]sx?$/i.test(file) && posix.normalize(posix.join(posix.dirname(file), specifier)).startsWith("..");
    const reason = outside ? "imports a path outside the repository (once vendored into Cloud it would reach Cloud's own code)" : cloudImportReason(file, specifier, names);
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

/**
 * Private branch names: the integration branches (`prefix/` and four digits), the Cloud integration branch and the Cloud convergence lane branches
 * (`prefix/word`). The words are assembled from pieces, so that this file does not carry them. The text is read as a branch name could be written
 * in a URL, a Windows path or a loose sentence: `%2F` and `\` count as a slash, and spaces around the slash do not matter for the integration forms.
 * Not branch names: a word that merely ends in a prefix (`acc/`), a `/cc/` path segment of a URL, the Creative Commons licence shorthand, and a folder called `integ/`
 * (the integration form needs its digits). A slash may come before a lane name only after `heads/`, `origin/`, `private/`, `remotes/` or `upstream/`.
 */
const BRANCH_LABEL = "a private branch name (integration and Cloud lane branches are never public)";
// A branch name may follow a ref prefix (`heads/`, `origin/`), a GitHub page path (`tree/`, `blob/`, `commits/`) or a compare range (`main...name`).
const BRANCH_START = "(?:(?<![a-z0-9_.\\/-])|(?<=\\b(?:heads|origin|private|remotes|upstream|tree|blob|commits|commit)\\/)|(?<=\\.\\.))";
const PRIVATE_BRANCHES: readonly RegExp[] = [
  new RegExp(`(?:(?<![a-z0-9_.-])|(?<=\\.\\.))${join("in", "teg")}\\s*\\/\\s*\\d{3,4}(?!\\d)`, "i"),
  new RegExp(`${BRANCH_START}${join("clo", "ud")}\\s*\\/\\s*${join("ne", "xt")}(?![a-z0-9_/-]|\\.[a-z])`, "i"),
  new RegExp(`${BRANCH_START}${join("c", "c")}\\/(?!(?:by|bcc)(?![a-z0-9]))[a-z][a-z0-9-]*`, "i"),
];

/** True when a text names a private branch (see above). */
export function hasPrivateBranch(raw: string): boolean {
  // Read as a branch name could be written: HTML character references, percent-encoding (also encoded again), backslashes, doubled slashes.
  let text = foldToAscii(raw).replace(/&#0*(?:47|92);|&#x0*(?:2f|5c);|&sol;|&bsol;/gi, "/");
  for (let i = 0; i < 3; i += 1) text = text.replace(/%25/gi, "%");
  text = text.replace(/%2f/gi, "/").replace(/%5c/gi, "/").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  return PRIVATE_BRANCHES.some((pattern) => pattern.test(text));
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
  // A branch name broken over lines reads in the joined text only.
  if ([bare.join("\n"), bare.join("")].some(hasPrivateBranch) && !lines.some(hasPrivateBranch)) found.add(BRANCH_LABEL);
  if (found.size === 0) return [];
  for (const line of lines) for (const label of nameLabels(line, names)) found.delete(label);
  return [...found];
}

/** What on one added line must not reach the public repository. Labels only, never the text. */
export function lineFindings(raw: string, names: NameSource = DEFAULT_NAMES): string[] {
  const line = foldToAscii(raw);
  const out: string[] = [...nameLabels(raw, names)];
  if (DEV_HOST.test(line)) out.push("a host under the product's dev domain");
  if (hasPrivateBranch(raw)) out.push(BRANCH_LABEL);
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

interface RawEntry { path: string; newMode: string; newSha: string; /** git's one-letter status (A added, M modified, ...); empty for a merge's combined entries. */ status: string }

/** The files a diff leaves in place (added, copied, modified, type-changed), with the new file mode. Renames are not followed. */
function rawEntries(cwd: string, command: string[]): RawEntry[] {
  const out = git(cwd, [...command, "--raw", "-z", "--no-abbrev", "--no-renames", "--diff-filter=d"]);
  const parts = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.split(/\s+/);
    const path = parts[i + 1]!;
    if (path === "") continue;
    entries.push({ path, newMode: meta[1] ?? "", newSha: meta[3] ?? "", status: meta[4] ?? "" });
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
    entries.push({ path, newMode, newSha: fields[2 * parents + 1] ?? "", status: "" });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The scan.

/** The comment that tells gitleaks to skip a line; spelled in two pieces so that this file does not carry it. */
const INLINE_ALLOW = new RegExp(join("gitleaks", ":", "allow"), "i");

const GUARD_FILES = [
  /^scripts\/port-guard\.ts$/i,
  /^scripts\/boundary-allowlist\.json$/i,
  /^scripts\/port-guard-accepted\.json$/i,
  /^tests\/[^/]+\/port-guard[^/]*$/i,
  /^\.github\/workflows\/ci\.yml$/i,
  /(^|\/)\.gitleaks[^/]*$/i,
  // The built-in starter list of test service images: part of the source, so Code's release is its trust anchor. A change to the list is a change to what runs with no owner approval, so it is reviewed by hand.
  /^packages\/contracts\/src\/owner-starter-images\.ts$/i,
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
  // A finding on a commit that is already public and cannot be rewritten is excused only by name: this commit, this rule, this file (the boundary data).
  const known = (finding: Finding): boolean =>
    input.commit !== undefined && boundary().knownHistory.some((e) => e.commit === input.commit && e.rule === finding.rule && e.file === finding.file);
  const add = (finding: Finding): void => {
    if (!known(finding)) collector.add(label === undefined ? finding : { ...finding, commit: label });
  };

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

  /** Files checked as TypeScript/JavaScript: by name, or because the file (net diff) or its added text reads as such code. */
  const codeLike = new Set<string>();
  /** Files this range or commit adds (a modified file is judged by its added lines only, an added one also by its name). */
  const newFiles = new Set<string>();
  for (const { path, newMode, status } of entries) {
    const pathHit = cloudPathRule(path, collector.names);
    if (pathHit !== null) add({ rule: pathHit.rule, file: path, line: null, detail: pathHit.detail });
    if (status === "A") {
      newFiles.add(path);
      const addedHit = addedFileRule(path);
      if (addedHit !== null) add({ rule: addedHit.rule, file: path, line: null, detail: addedHit.detail });
    }
    // A file or directory named after a prospect or a private host is as public as its contents.
    for (const detail of lineFindings(path, collector.names)) add({ rule: "private-name", file: path, line: null, detail: `${detail} in a file name` });
    const strayHit = strayFileRule(path);
    if (strayHit !== null) add({ rule: strayHit.rule, file: path, line: null, detail: `${strayHit.detail}; remove it from the lane (check git status before every commit)` });
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
    // A file that is code by its name (also `x.ts-E`, `x.ts.orig`) or by its text, whatever it is called.
    if (input.commit === undefined && newMode !== "120000" && newMode !== "160000") {
      const blob = git(cwd, ["cat-file", "blob", `${tip}:${path}`], true);
      if (looksLikeCode(path, blob.length > SNIFF_LIMIT ? "" : blob)) {
        codeLike.add(path);
        for (const finding of importFindings(path, blob, collector.names, true)) add(finding);
        // The AWS line: the adapters package is judged whole; elsewhere only a file the range adds (a file Code already had keeps its imports).
        for (const finding of awsImportFindings(path, blob, newFiles.has(path))) add(finding);
      }
    }
  }

  // --text: a gitattributes `-diff`/`binary` entry or a NUL byte must not turn a file's lines into "Binary files differ".
  const patch = git(cwd, [...patchCommand, "-p", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-renames", "--diff-filter=d", "--src-prefix=a/", "--dst-prefix=b/"]);
  if (input.merge === true && input.commit !== undefined) {
    const lines = parse(patch).map((added) => added.text);
    if (lines.length > 0) collector.mergePatches.set(input.commit, lines.join("\n") + "\n");
  }
  // A UTF-16 file reads as text with a NUL between the letters: without them the name and secret checks see the words (the earlier patch passes see the raw bytes).
  const rawAdded = parse(patch);
  const added = rawAdded.map((line) => (line.text.includes("\0") || line.text.includes("\uFFFD") ? { ...line, text: withoutNul(line.text).replaceAll("\uFFFD", "") } : line));
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
  // A name broken over two added lines: the lines of one hunk, joined. Read on the raw lines and, when stripping changed any, on the cleaned lines too
  // (stripping joins the text either side of a bad byte, which can hide a name that the raw line shows).
  for (const lines of added.some((line, index) => line.text !== rawAdded[index]!.text) ? [rawAdded, added] : [added]) {
    for (let start = 0; start < lines.length; ) {
      let end = start + 1;
      while (end < lines.length && lines[end]!.file === lines[start]!.file && lines[end]!.line === lines[end - 1]!.line + 1) end += 1;
      if (end - start > 1) {
        const first = lines[start]!;
        for (const detail of splitNameFindings(lines.slice(start, end).map((a) => a.text), collector.names)) {
          add({ rule: "private-name", file: first.file, line: first.line, detail: `${detail} (split over lines)` });
        }
      }
      start = end;
    }
  }
  // The same decision for the added text of each file, which is all a single commit's scan has: by name, or by the text of the file's added lines.
  for (const [path, texts] of perFile) if (!codeLike.has(path) && looksLikeCode(path, texts.join("\n"))) codeLike.add(path);
  for (const [index, { file, line, text }] of added.entries()) {
    const raw = rawAdded[index]!.text;
    if (raw !== text) for (const detail of lineFindings(raw, collector.names)) add({ rule: "private-name", file, line, detail });
    for (const detail of lineFindings(text, collector.names)) add({ rule: "private-name", file, line, detail });
    if (INLINE_ALLOW.test(text)) add({ rule: "scan-bypass", file, line, detail: "an inline allow comment for gitleaks" });
    // Every line of an import is checked in the added text too, so an import added and later removed is still caught.
    if (codeLike.has(file)) {
      for (const finding of importFindings(file, text, collector.names, true)) add({ ...finding, line });
      for (const finding of awsImportFindings(file, text, newFiles.has(file))) add({ ...finding, line });
    }
    if (WIRING_FILE.test(file)) {
      if (CLOUD_PACKAGE_ANYWHERE.test(text)) {
        add({ rule: "cloud-import", file, line, detail: "names a Cloud-only package (the web app, its UI, the audit verifier or a cloud-* package)" });
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
  /** The accepted findings; the command line reads them with `loadAccepted`. Absent: none. */
  accepted?: readonly AcceptedFinding[];
}

export interface GuardResult { findings: Finding[]; commits: number; range: Range; notes?: string[]; warnings?: string[] }

// ---------------------------------------------------------------------------------------------------------------------------------
// Accepted findings.

/** The only rules a finding may be accepted under. Never private-name, guard-files, scan-bypass or any other. */
export const ACCEPTABLE_RULES: readonly string[] = ["cloud-aws", "secret"];

export interface AcceptedFinding {
  /** One exact repository path: no wildcard, no directory. */
  path: string;
  rule: "cloud-aws" | "secret";
  /** The git blob id (40 hex) of the file's accepted content. */
  blob: string;
  reason: string;
}

/** Reads and checks the accepted-findings data; anything off is a GuardError (the guard does not run on a list it cannot trust). */
export function parseAccepted(text: string, source: string): AcceptedFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GuardError(`${source} is not JSON`);
  }
  const record = data as { version?: unknown; accepted?: unknown };
  if (record === null || typeof record !== "object" || record.version !== 1 || !Array.isArray(record.accepted)) throw new GuardError(`${source} must be { "version": 1, "accepted": [...] }`);
  const seen = new Set<string>();
  return record.accepted.map((raw: unknown, index: number) => {
    const entry = raw as Record<string, unknown>;
    const where = `${source} entry ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "blob,path,reason,rule") throw new GuardError(`${where} must have exactly path, rule, blob and reason`);
    const { path, rule, blob, reason } = entry;
    if (typeof path !== "string" || path === "" || /[*?[\]{}!\\]/.test(path) || path.endsWith("/") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new GuardError(`${where}: the path must be one exact file path (no wildcard, no directory)`);
    }
    if (typeof rule !== "string" || !ACCEPTABLE_RULES.includes(rule)) throw new GuardError(`${where}: only ${ACCEPTABLE_RULES.join(" and ")} findings can be accepted`);
    if (typeof blob !== "string" || !/^[0-9a-f]{40}$/.test(blob)) throw new GuardError(`${where}: blob must be a 40-character git blob id`);
    if (typeof reason !== "string" || reason.trim().length < 10) throw new GuardError(`${where}: give the reason`);
    const key = `${rule}|${path}`;
    if (seen.has(key)) throw new GuardError(`${where}: ${path} is listed twice for ${rule}`);
    seen.add(key);
    return { path, rule: rule as AcceptedFinding["rule"], blob, reason };
  });
}

let acceptedFile: string | undefined;
/** Point the guard at an accepted-findings file (--accepted); the default is the file beside this script. */
export function useAcceptedFile(file: string | undefined): void {
  acceptedFile = file;
}

/** The accepted findings: the file named by --accepted, else the one beside this script (none when there is no such file). Never the checkout's copy. */
export function loadAccepted(): AcceptedFinding[] {
  const file = acceptedFile ?? joinPath(dirname(fileURLToPath(import.meta.url)), "port-guard-accepted.json");
  if (acceptedFile === undefined && !existsSync(file)) return [];
  return parseAccepted(readFileSync(file, "utf8"), file);
}

/** What the accepted list did to a run: the findings left, and the notes (inactive entries) and warnings (changed outside the range) to print. */
export interface AcceptedOutcome { findings: Finding[]; notes: string[]; warnings: string[] }

/**
 * The findings left after the accepted ones. An entry skips findings only when the file at the tip is its exact blob. Otherwise: absent at the tip and
 * untouched by the range, it is inactive (a note); present but different and untouched, a warning; changed or removed by the range, an accepted-stale finding.
 */
export function applyAccepted(cwd: string, tip: string, findings: readonly Finding[], accepted: readonly AcceptedFinding[], touched: ReadonlySet<string>): AcceptedOutcome {
  const fresh = new Set<string>();
  const stale: Finding[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  for (const entry of accepted) {
    const current = git(cwd, ["rev-parse", "--verify", "--quiet", `${tip}:${entry.path}`], true).trim();
    if (current === entry.blob) { fresh.add(`${entry.rule}|${entry.path}`); continue; }
    if (touched.has(entry.path)) {
      stale.push({ rule: "accepted-stale", file: entry.path, line: null, detail: current === "" ? `the range removes a file with an accepted ${entry.rule} finding; remove the entry` : `the range changes a file with an accepted ${entry.rule} finding, so it is judged as if it had none; review it and remove or update the entry` });
    } else if (current === "") {
      notes.push(`${entry.path}: accepted ${entry.rule} entry inactive (the file is not at the tip)`);
    } else {
      warnings.push(`${entry.path}: accepted ${entry.rule} entry no longer matches the file (changed before this range); remove or update the entry`);
    }
  }
  return { findings: [...findings.filter((finding) => !(ACCEPTABLE_RULES.includes(finding.rule) && fresh.has(`${finding.rule}|${finding.file}`))), ...stale], notes, warnings };
}

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
  // Every path the range changes: in its net diff or in any of its commits (a file changed and changed back was still touched).
  const touched = new Set([
    ...git(options.cwd, ["diff", "--name-only", "--no-renames", mergeBase, range.tip]).split("\n"),
    ...git(options.cwd, ["log", "--name-only", "--no-renames", "--format=", "-m", `${range.base}..${range.tip}`]).split("\n"),
  ].filter((path) => path !== ""));
  const outcome = applyAccepted(options.cwd, range.tip, collector.findings, options.accepted ?? [], touched);
  return { findings: outcome.findings, commits: commits.length, range, notes: outcome.notes, warnings: outcome.warnings };
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
    else if (arg === "--boundary") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("port-guard: --boundary needs the boundary data file");
        return 2;
      }
      useBoundaryFile(value);
      i += 1;
    }
    else if (arg === "--accepted") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("port-guard: --accepted needs the accepted-findings file");
        return 2;
      }
      useAcceptedFile(value);
      i += 1;
    }
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/port-guard.ts [--range <base>..<tip>] [--allow-guard-edits] [--boundary <file>] [--accepted <file>]\n(default range: " + DEFAULT_RANGE + ")");
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
    const result = runGuard({ cwd: root.stdout.trim(), range, allowGuardEdits, names, accepted: loadAccepted() });
    for (const note of result.notes ?? []) console.log(`port-guard: note: ${note}`);
    for (const warning of result.warnings ?? []) console.log(`port-guard: warning: ${warning}`);
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
