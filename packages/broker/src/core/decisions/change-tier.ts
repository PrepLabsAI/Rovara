// The change tier: how far a change reaches, in three words (small, standard, risky) and, for what it touched, five kinds (docs, code_config, dependency, install_link, ci_file).
//
// THE RULES (the highest match wins):
//  - RISKY, full planning stays: a path on the one sensitive list (`sensitive-list.ts`), an instruction or prompt file, a hook, a git settings file, an environment file, a package-manager source setting, an install lifecycle script,
//    a registry or dependency source that changed, a CI file that gained a privileged trigger or secret, a symlink, submodule, mode change, binary file, LFS pointer, more than 400 lines of code, and any diff that is unknown or incomplete.
//  - STANDARD: more than 100 lines of code, more than 3 files, two or more modules, an API change, a new dependency, or a deleted code file.
//  - SMALL: everything else. Kinds tell what it touched.
// The tier comes from the CODE HOST's view of the change (merge base to head), never from what an agent says; a diff that cannot be read in full is risky. It is computed twice: an ESTIMATE before the build (from the request and the files
// the plan names) and the DIFF tier after it; the diff tier is recomputed on every push and at merge. The tier of a change never goes down (`raiseTier`): a later, smaller diff keeps the higher tier.
//
// This file is pure: no store, no host, no clock (the caller passes `at`). The thresholds are named settings with these defaults; changing them is an admin action that is out of scope here.
import { type FlowTier, type FlowTierKind, type FlowTierLevel, type WorkflowFlow, FLOW_CATCH_COUNTERS_MAX, FLOW_MAX_BYTES, FLOW_REASON_PATH_MAX, FLOW_TIER_HISTORY_MAX, FLOW_TIER_REASONS_MAX, flowRecordBytes } from "@agentx/contracts";
import { CHANGED_FILES_MAX } from "../proof/changed-files.js";
import { isTestPath } from "../proof/verification-report.js";
import { isCiFilePath, isHookPath, isInstructionPath, isTierSensitivePath, normalizedTierPath } from "./sensitive-list.js";

/** The version of these rules, written with every tier (`flow.rulesVersion`), so a stored tier says which rules made it. */
export const TIER_RULES_VERSION = 1;

export type TierLevel = FlowTierLevel;
export type TierKind = FlowTierKind;
export type ChangeTier = FlowTier;
export type TierReason = ChangeTier["reasons"][number];

/** The size limits, as named settings. */
export interface TierThresholds {
  /** More lines of code than this is at least standard. */
  readonly standardLines: number;
  /** More files than this is at least standard. */
  readonly standardFiles: number;
  /** More lines of code than this is risky. */
  readonly riskyLines: number;
}
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = { standardLines: 100, standardFiles: 3, riskyLines: 400 };

/** The order of the levels; a tier never goes down this list. */
const RANK: Readonly<Record<TierLevel, number>> = { small: 0, standard: 1, risky: 2 };
export const tierRank = (level: TierLevel): number => RANK[level];
export const higherLevel = (left: TierLevel, right: TierLevel): TierLevel => (RANK[right] > RANK[left] ? right : left);

// ---- the reason codes (stable words; later steps read them)

export const TIER_REASON_CODES = [
  // risky
  "incomplete_diff", "no_diff_files", "too_many_files", "unreadable_content", "binary_content", "mode_or_type_change", "symlink_suspected", "submodule", "lfs_pointer",
  "sensitive_path", "instruction_file", "hook_file", "git_settings_file", "env_file", "package_source_setting", "registry_source_changed", "dependency_source", "install_script",
  "ci_privileged", "large_change",
  // standard
  "more_than_lines", "more_than_files", "two_or_more_modules", "api_change", "new_dependency", "lockfile_not_understood", "code_file_deleted", "no_files_named", "request_mentions_sensitive_area",
] as const;

// ---- input

/** A changed file as the code host reports it. `patch` is the host's own text of the change (absent for a binary file, a mode change or a file too large to show). */
export interface TierFile {
  /** The repository, when the change spans several: a module is per repository. */
  repository?: string | undefined;
  path: string;
  previousPath?: string | undefined;
  /** The host's word: `added`, `removed`, `modified`, `renamed`, `copied`, `changed` (GitHub's word for a mode change)... */
  status: string;
  additions: number;
  deletions: number;
  patch?: string | undefined;
  /** The diff changes a route declaration or a response schema (read by `parseChangedFiles`). */
  apiShapeChanged?: boolean | undefined;
}

export interface DiffInput {
  files: readonly TierFile[];
  /** False when the host's list was cut, or a file had a path that cannot be listed: the diff is not known in full. */
  complete: boolean;
}

export interface TierContext {
  /** The code the tier is for: the head commit and the merge base. Written into the tier so it says what it was computed from. */
  headSha?: string | undefined;
  mergeBase?: string | undefined;
  /** ISO time of the computation. */
  at: string;
  thresholds?: TierThresholds | undefined;
}

// ---- reading a patch

interface PatchLines { added: string[]; removed: string[]; header: string[]; hunks: number; noEolMarkers: number; contentLines: number; firstHunkFromStart: boolean }

/** The changed lines of a patch (the host's, or a git diff's). Lines before the first hunk are header lines (mode, similarity, binary notes). */
function readPatch(patch: string): PatchLines {
  const read: PatchLines = { added: [], removed: [], header: [], hunks: 0, noEolMarkers: 0, contentLines: 0, firstHunkFromStart: false };
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      if (read.hunks === 0) read.firstHunkFromStart = /^@@ -(?:0,0|1)(?:,\d+)? /u.test(line);
      read.hunks += 1; inHunk = true; continue;
    }
    if (!inHunk) { read.header.push(line); continue; }
    if (line.startsWith("\\")) { read.noEolMarkers += 1; continue; }
    if (line.startsWith("+")) { read.added.push(line.slice(1)); read.contentLines += 1; } else if (line.startsWith("-")) { read.removed.push(line.slice(1)); read.contentLines += 1; } else if (line.startsWith(" ")) read.contentLines += 1;
  }
  return read;
}

const hasNul = (text: string): boolean => text.includes("\u0000");
const LFS_POINTER = /^\s*[+-]?\s*version https:\/\/git-lfs\.github\.com\/spec\/v\d+\s*$/mu;
const SUBMODULE = /^[+-]?\s*Subproject commit [0-9a-f]{7,64}\s*$/mu;
const GIT_TYPE_HEADERS = /^(?:old mode|new mode) \d+|^(?:new|deleted) file mode (?:120000|160000)\b/mu;
const BINARY_NOTE = /^(?:Binary files .* differ|GIT binary patch)\s*$/mu;

// ---- classes of file

const PROSE_EXTENSION = /\.(md|markdown|rst|adoc|txt)$/u;
const baseName = (path: string): string => path.split("/").at(-1) ?? "";
/** The file name of a path as the rules read it (normalized, so `README.MD` and `SECURITY.md` are read like their lower-case names). */
const nameOf = (path: string): string => baseName(normalizedTierPath(path));
/** Names a prose extension does not make a document: dependency pins, locks, ownership, licence, environment and security files. */
const NOT_DOCS_NAME = /^(?:[^/]*(?:requirements|constraints)[^/]*\.txt|cmakelists\.txt|robots\.txt|ads\.txt|[^/]*\.lock|codeowners|license[^/]*|\.env[^/]*|security[^/]*)$/u;
/** Dependency pins kept in a folder of their own (`requirements/base.txt`). */
const PINS_FOLDER = /(?:^|\/)(?:requirements|constraints)\/[^/]*\.txt$/u;

function isProsePath(path: string): boolean {
  const name = nameOf(path);
  return PROSE_EXTENSION.test(name) && !NOT_DOCS_NAME.test(name) && !PINS_FOLDER.test(normalizedTierPath(path)) && !isTierSensitivePath(path) && !isInstructionPath(path) && !isHookPath(path);
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "go.sum", "pipfile.lock", "poetry.lock", "uv.lock", "gemfile.lock", "composer.lock",
  "packages.lock.json", "mix.lock", "pubspec.lock", "gradle.lockfile", "flake.lock", "podfile.lock", "cartfile.resolved",
]);
const MANIFEST_NAMES = new Set([
  "package.json", "composer.json", "pyproject.toml", "cargo.toml", "go.mod", "gemfile", "pipfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "mix.exs", "pubspec.yaml", "directory.packages.props",
]);
const isLockfile = (path: string): boolean => LOCKFILE_NAMES.has(baseName(path)) || baseName(path).endsWith(".lock");
const isRequirementsFile = (path: string): boolean => /^[^/]*(?:requirements|constraints)[^/]*\.txt$/u.test(baseName(path)) || PINS_FOLDER.test(path);
const isManifest = (path: string): boolean => MANIFEST_NAMES.has(baseName(path)) || /\.csproj$/u.test(baseName(path)) || isRequirementsFile(path);

/** Files that say where packages come from. A change to one is risky whatever it says. */
const PACKAGE_SOURCE_FILES = /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.ya?ml)?|\.pnpmfile\.c?js|pip\.(?:conf|ini)|\.pypirc|nuget\.config|bunfig\.toml|\.condarc|\.gemrc|\.bundle\/config|\.cargo\/config(?:\.toml)?|\.mvn\/settings\.xml|settings\.xml|\.npmignore-registry)$/u;
/** Git's own settings files. */
const GIT_SETTINGS_FILES = /(?:^|\/)(?:\.gitmodules|\.gitattributes)$/u;
/** The words in a changed line that point a package manager at another source. */
const SOURCE_WORD_ANYWHERE = /(?:--?index-url|--extra-index-url|extra-index-url|index-url|--find-links|find-links|--trusted-host|trusted-host|--registry\b|npmRegistryServer)/iu;
const SOURCE_WORD_IN_CONFIG = /(?:^|[\s"'@:])(?:[\w-]+:)?registry\s*[=:]/iu;
const CONFIG_FILE = /\.(?:toml|cfg|ini|conf|ya?ml|json|xml|properties)$|(?:^|\/)\.[\w-]*rc$/u;

const INSTALL_SCRIPT_NAME = /^(?:install|setup|bootstrap|uninstall|get[-_][\w.-]*|install[-_][\w.-]*)(?:\.(?:sh|bash|zsh|ps1|bat|cmd|py))?$/u;
const isInstallScript = (path: string): boolean => INSTALL_SCRIPT_NAME.test(nameOf(path)) && !PROSE_EXTENSION.test(nameOf(path));

// ---- install links in documents

const URL_IN_LINE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bgit@[\w.-]+:|\]\(|\bhref\s*=|\bsrc\s*=|^\s*\[[^\]]+\]:\s*\S)/iu;
const COMMAND_WORDS = /(?:^\s*(?:[-*>]\s+)?|[$`>(|;&]\s*)(?:sudo|curl|wget|npm|npx|yarn|pnpm|pip3?|pipx|uv|poetry|brew|apt(?:-get)?|apk|dnf|yum|snap|choco|winget|scoop|docker|podman|go\s+(?:install|get)|cargo\s+install|gem\s+install|git\s+clone|bash|sh|zsh|powershell|iex|irm|make\s+install|chmod)\s/iu;
const FENCE = /^\s{0,3}(```|~~~)/u;
const INSTALL_HEADING = /^\s{0,3}#{1,6}\s+.*\b(?:install\w*|set\s?up|getting started|quick\s?start|download\w*|upgrad\w*|build from source|usage)\b/iu;
const ANY_HEADING = /^\s{0,3}#{1,6}\s/u;

/**
 * Whether a document's patch changes a command or a link that a reader would run or follow: any changed line that has a URL or reads as a command, any changed line inside a fenced block or an install section, and any change in a
 * hunk whose fence state cannot be known (the patch does not start at the top of the file and its first fence marker has no language, so the lines before it may be inside a block). A host that gave no patch is handled by the caller.
 */
function documentChangesLink(patch: string): boolean {
  const read = readPatchWithContext(patch);
  let fenced = read.startFenced;
  let inInstall = false;
  for (const entry of read.lines) {
    const text = entry.text;
    if (FENCE.test(text)) { fenced = !fenced; if (entry.changed) return true; continue; }
    if (ANY_HEADING.test(text)) inInstall = INSTALL_HEADING.test(text);
    if (!entry.changed) continue;
    if (fenced || inInstall || URL_IN_LINE.test(text) || COMMAND_WORDS.test(`${text} `)) return true;
    if (entry.beforeAmbiguousFence) return true;
  }
  return false;
}

interface ContextLine { text: string; changed: boolean; beforeAmbiguousFence: boolean }
function readPatchWithContext(patch: string): { lines: ContextLine[]; startFenced: boolean } {
  const lines: ContextLine[] = [];
  let inHunk = false;
  const hunks: Array<{ from: number; fromTop: boolean }> = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; hunks.push({ from: lines.length, fromTop: /^@@ -(?:0,0|1)(?:,\d+)? /u.test(line) }); continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    const mark = line[0];
    if (mark === "+" || mark === "-") lines.push({ text: line.slice(1), changed: true, beforeAmbiguousFence: false });
    else lines.push({ text: line.startsWith(" ") ? line.slice(1) : line, changed: false, beforeAmbiguousFence: false });
  }
  // Within each hunk that does not start at the top of the file, lines before its first fence marker may be inside a block when that marker has no language (it may be a closing one).
  hunks.forEach((hunk, index) => {
    if (hunk.fromTop) return;
    const end = index + 1 < hunks.length ? hunks[index + 1]!.from : lines.length;
    const firstFence = lines.slice(hunk.from, end).findIndex((entry) => FENCE.test(entry.text));
    if (firstFence < 0) return;
    const marker = lines[hunk.from + firstFence]!.text.trim();
    if (marker !== "```" && marker !== "~~~") return;
    for (let at = hunk.from; at < hunk.from + firstFence; at += 1) lines[at]!.beforeAmbiguousFence = true;
  });
  return { lines, startFenced: false };
}

// ---- dependencies in manifests and lock files

const NOT_A_DEPENDENCY_KEY = new Set(["name", "version", "edition", "description", "license", "readme", "authors", "requires-python", "python", "rust-version", "homepage", "repository", "documentation", "keywords", "categories", "publish", "resolver", "build", "include", "exclude", "default-run", "channel", "main", "module", "types", "type", "private", "author", "packagemanager", "source"]);
const VERSIONISH = /^(?:[~^<>=v*]|\d|latest$|next$|workspace:|npm:|file:|link:|portal:|patch:|git(?:\+|:|@)|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(?:#|$))/iu;
const DEFAULT_REGISTRY_HOSTS = new Set([
  "registry.npmjs.org", "registry.yarnpkg.com", "registry.npmjs.com", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io", "rubygems.org", "proxy.golang.org", "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "api.nuget.org", "packagist.org", "repo.packagist.org", "github.com", "codeload.github.com",
]);
const hostsIn = (lines: readonly string[]): Set<string> => {
  const hosts = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(/\b(?:https?|git\+https?|git\+ssh|ssh|git|ftp):\/\/(?:[^@\s/"']*@)?([^/\s"':?#)]+)/giu)) hosts.add(match[1]!.toLowerCase());
  return hosts;
};
/** A source other than a registry: a git, file or link dependency, or a URL for a tarball. */
const NON_REGISTRY_SOURCE = /(?:git\+(?:https?|ssh)|git:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:|\bgit\s*=|\bpath\s*=|\bfile:|\blink:|\bportal:|-e\s+git|@\s*(?:https?|git\+))/iu;

/** The name of the dependency a manifest line declares, or undefined when the line is not one. */
function dependencyName(path: string, line: string): string | undefined {
  const name = baseName(path);
  if (name === "package.json" || name === "composer.json") {
    const match = /^\s*"([@\w][\w@./-]*)"\s*:\s*"([^"]*)"\s*,?\s*$/u.exec(line);
    if (match === null || NOT_A_DEPENDENCY_KEY.has(match[1]!.toLowerCase()) || !VERSIONISH.test(match[2]!)) return undefined;
    return match[1]!.toLowerCase();
  }
  if (isRequirementsFile(path)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:(?:===|==|>=|<=|~=|!=|<|>|@)|(?:#.*)?$)/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "go.mod") {
    const match = /^\s*(?:require\s+)?([A-Za-z0-9][\w.~/-]*\.[\w.~/-]+)\s+v[\w.+-]+(?:\s*\/\/.*)?$/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "gemfile") {
    const match = /^\s*gem\s+['"]([\w.-]+)['"]/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "pyproject.toml" || name === "cargo.toml" || name === "pipfile") {
    const pep = /^\s*"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:===|==|>=|<=|~=|!=|<|>|@)[^"]*"\s*,?\s*$/u.exec(line);
    if (pep !== null) return pep[1]!.toLowerCase();
    const table = /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=\s*(?:"[^"]*"|\{[^}]*\})\s*,?\s*$/u.exec(line);
    if (table === null || NOT_A_DEPENDENCY_KEY.has(table[1]!.toLowerCase())) return undefined;
    return table[1]!.toLowerCase();
  }
  return undefined;
}

/** The name an entry of a lock file carries (the header of one package), or undefined for any other line. */
function lockEntryName(path: string, line: string): string | undefined {
  const name = baseName(path);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
    const match = /^\s*"(?:[^"]*node_modules\/)([^"]+)"\s*:\s*\{\s*$/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "yarn.lock") {
    const match = /^\s*"?(@?[^@\s",]+)@/u.exec(line);
    return match === null || !/:\s*$/u.test(line) ? undefined : match[1]!.toLowerCase();
  }
  if (name === "pnpm-lock.yaml") {
    const match = /^\s{2,6}['"]?\/?(@?[^@\s'":]+)@[^'":\s]+['"]?:\s*$/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "cargo.lock" || name === "poetry.lock" || name === "uv.lock") {
    const match = /^name = "([^"]+)"\s*$/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "go.sum") {
    const match = /^(\S+) v\S+ h1:/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "gemfile.lock") {
    const match = /^ {4}([\w.-]+) \(/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  if (name === "composer.lock") {
    const match = /^\s*"name"\s*:\s*"([\w.-]+\/[\w.-]+)"/u.exec(line);
    return match === null ? undefined : match[1]!.toLowerCase();
  }
  return undefined;
}
const LOCK_FORMATS_READ = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock", "uv.lock", "go.sum", "gemfile.lock", "composer.lock"]);
interface DependencyReading {
  kind: boolean;
  newDependencies: string[];
  lockNotUnderstood: boolean;
  risky: TierReason[];
  /** Lines of the change that are dependency pinning, not code. */
  dependencyLines: number;
}

/** Reads the dependency side of a manifest or lock file from the changed lines. */
function readDependencies(file: TierFile, patch: PatchLines): DependencyReading {
  const path = normalizedTierPath(file.path);
  const lock = isLockfile(path);
  const out: DependencyReading = { kind: false, newDependencies: [], lockNotUnderstood: false, risky: [], dependencyLines: 0 };
  const reason = (code: string): TierReason => ({ code, path: file.path.slice(0, FLOW_REASON_PATH_MAX) });
  const addedNames = new Set<string>();
  const removedNames = new Set<string>();
  let touched = false;
  for (const line of patch.added) {
    const entry = lock ? lockEntryName(path, line) : dependencyName(path, line);
    if (entry !== undefined) { addedNames.add(entry); out.dependencyLines += 1; touched = true; }
  }
  for (const line of patch.removed) {
    const entry = lock ? lockEntryName(path, line) : dependencyName(path, line);
    if (entry !== undefined) { removedNames.add(entry); out.dependencyLines += 1; touched = true; }
  }
  // A lock file that changed at all is a dependency change; a manifest only when a dependency line did.
  if (touched || (lock && patch.added.length + patch.removed.length > 0)) out.kind = true;
  out.newDependencies = [...addedNames].filter((name) => !removedNames.has(name));
  // A lock file in a format this reader does not know cannot say which packages are new: standard.
  if (lock && patch.added.length + patch.removed.length > 0 && !LOCK_FORMATS_READ.has(baseName(path))) { out.lockNotUnderstood = true; out.kind = true; }
  // Where packages come from. An address on an added line that no removed line already had, and that is not a default registry, is a new source.
  const removedHosts = hostsIn(patch.removed);
  for (const host of hostsIn(patch.added)) {
    if (!DEFAULT_REGISTRY_HOSTS.has(host) && !removedHosts.has(host)) out.risky.push(reason("registry_source_changed"));
  }
  const removedSource = patch.removed.filter((line) => NON_REGISTRY_SOURCE.test(line)).map((line) => line.trim());
  if (patch.added.some((line) => NON_REGISTRY_SOURCE.test(line) && !removedSource.includes(line.trim()))) out.risky.push(reason("dependency_source"));
  if (baseName(path) === "package.json" && patch.added.some((line) => /^\s*"(?:preinstall|install|postinstall|prepare)"\s*:/u.test(line))) out.risky.push(reason("install_script"));
  if (lock && patch.added.some((line) => /^\s*"hasInstallScript"\s*:\s*true/u.test(line))) out.risky.push(reason("install_script"));
  return out;
}

// ---- continuous integration files

const CI_PRIVILEGED = /(?:pull_request_target|workflow_run|\bsecrets\s*\.|\bsecrets\s*:\s*inherit|\$\{\{\s*secrets\b|id-token|\bGITHUB_TOKEN\b|permissions\s*:\s*write-all|:\s*write\s*$|runs-on\s*:.*self-hosted|\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b)/iu;

// ---- one file

interface FileReading {
  risky: TierReason[];
  standard: TierReason[];
  kinds: Set<TierKind>;
  /** Lines of code the change adds and removes in this file (a document, a lock file and dependency pins are none). */
  codeLines: number;
  /** Counts toward "more than 3 files": every file that is not a document or a lock file. */
  countsAsFile: boolean;
  isCode: boolean;
  isTest: boolean;
}

function readFile(file: TierFile): FileReading {
  const reading: FileReading = { risky: [], standard: [], kinds: new Set(), codeLines: 0, countsAsFile: true, isCode: true, isTest: false };
  const here = (code: string): TierReason => ({ code, path: file.path.slice(0, FLOW_REASON_PATH_MAX) });
  const names = [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])];
  const removed = file.status === "removed";

  // Both names of a renamed file count: a file moved out of, or into, a sensitive folder is a change to it.
  for (const name of names) {
    const normal = normalizedTierPath(name);
    const reasonFor = (code: string): TierReason => ({ code, path: name.slice(0, FLOW_REASON_PATH_MAX) });
    if (isHookPath(name)) reading.risky.push(reasonFor("hook_file"));
    if (isInstructionPath(name)) reading.risky.push(reasonFor("instruction_file"));
    if (isTierSensitivePath(name)) reading.risky.push(reasonFor("sensitive_path"));
    if (GIT_SETTINGS_FILES.test(normal)) reading.risky.push(reasonFor("git_settings_file"));
    if (PACKAGE_SOURCE_FILES.test(normal)) reading.risky.push(reasonFor("package_source_setting"));
    if (/(?:^|\/)\.env[^/]*$/u.test(normal)) reading.risky.push(reasonFor("env_file"));
  }

  const normalPath = normalizedTierPath(file.path);
  const prose = isProsePath(file.path) && (file.previousPath === undefined || isProsePath(file.previousPath));
  const ci = isCiFilePath(file.path) || (file.previousPath !== undefined && isCiFilePath(file.previousPath));
  const lock = isLockfile(normalPath);
  const manifest = isManifest(normalPath);
  reading.isTest = isTestPath(normalPath);

  // What the host gave of the change itself. A deletion needs no text: nothing is added. A rename with no change needs none either.
  const pureRename = file.status === "renamed" && file.additions === 0 && file.deletions === 0;
  let patch: PatchLines | undefined;
  if (!removed && !pureRename) {
    if (file.status === "changed") reading.risky.push(here("mode_or_type_change"));
    if (file.patch === undefined) reading.risky.push(here("unreadable_content"));
    else {
      patch = readPatch(file.patch);
      const whole = file.patch;
      if (hasNul(whole)) reading.risky.push(here("binary_content"));
      if (BINARY_NOTE.test(whole)) reading.risky.push(here("binary_content"));
      if (SUBMODULE.test(whole)) reading.risky.push(here("submodule"));
      if (LFS_POINTER.test(whole)) reading.risky.push(here("lfs_pointer"));
      if (GIT_TYPE_HEADERS.test(patch.header.join("\n"))) reading.risky.push(here("mode_or_type_change"));
      // A symlink's content is its target, one line with no final newline. A host's patch does not say the mode, so this is read from the shape: every content line of the patch is followed by the no-newline mark.
      if (patch.contentLines > 0 && patch.contentLines <= 2 && patch.noEolMarkers >= patch.contentLines && patch.added.every((line) => !/\s/u.test(line)) && patch.removed.every((line) => !/\s/u.test(line))) reading.risky.push(here("symlink_suspected"));
    }
  }
  const hostLines = file.additions + file.deletions;

  if (removed) {
    // A deleted file is a loss, never a gain: a deleted document stays a document change, a deleted code file is at least standard.
    if (prose) reading.kinds.add("docs");
    else if (!ci) { reading.standard.push(here("code_file_deleted")); reading.kinds.add("code_config"); }
    reading.codeLines = prose || lock ? 0 : hostLines;
    reading.countsAsFile = !prose && !lock;
    reading.isCode = !prose && !lock;
    if (ci) { reading.kinds.add("ci_file"); reading.codeLines = hostLines; }
    return reading;
  }

  if (prose) {
    reading.kinds.add("docs");
    reading.isCode = false;
    reading.countsAsFile = false;
    if (patch === undefined) {
      // A document whose text cannot be read cannot be cleared of a changed link or command: at least install_link (and it is already risky unless it is a pure rename).
      if (!pureRename) reading.kinds.add("install_link");
    } else if (documentChangesLink(file.patch!)) reading.kinds.add("install_link");
    return reading;
  }

  // The host's own counts, and never fewer than the text shows.
  reading.codeLines = Math.max(hostLines, patch === undefined ? 0 : patch.added.length + patch.removed.length);
  if (lock) {
    reading.isCode = false;
    reading.countsAsFile = false;
    reading.codeLines = 0;
  }

  if (patch !== undefined) {
    if (manifest || lock) {
      const deps = readDependencies(file, patch);
      if (deps.kind) reading.kinds.add("dependency");
      reading.risky.push(...deps.risky);
      if (deps.newDependencies.length > 0) reading.standard.push(here("new_dependency"));
      if (deps.lockNotUnderstood) reading.standard.push(here("lockfile_not_understood"));
      reading.codeLines = lock ? 0 : Math.max(0, reading.codeLines - deps.dependencyLines);
      if (manifest && reading.codeLines > 0) reading.kinds.add("code_config");
    }
    // A package manager pointed at another source, in any non-document file.
    const changed = [...patch.added, ...patch.removed];
    const inConfig = CONFIG_FILE.test(normalPath) || manifest || lock || isRequirementsFile(normalPath);
    if (changed.some((line) => SOURCE_WORD_ANYWHERE.test(line)) || (inConfig && changed.some((line) => SOURCE_WORD_IN_CONFIG.test(line)))) reading.risky.push(here("package_source_setting"));
    if (ci && patch.added.some((line) => CI_PRIVILEGED.test(line))) reading.risky.push(here("ci_privileged"));
  }

  if (ci) reading.kinds.add("ci_file");
  else if (!lock && !manifest) reading.kinds.add("code_config");
  // A manifest or lock file whose text could not be read is risky already; it still counts as a dependency file.
  if (patch === undefined && (manifest || lock)) reading.kinds.add("dependency");
  if (isInstallScript(file.path)) { reading.kinds.add("install_link"); reading.kinds.add("code_config"); }
  // A file that is not a document or a lock file and has no kind yet (an instruction or sensitive file) stays kind-less: it is risky anyway.
  return reading;
}

// ---- modules

const MODULE_CONTAINERS = new Set(["packages", "apps", "services", "libs", "lib", "modules", "crates", "plugins", "cmd", "internal", "tools", "extensions"]);
/** The module a path belongs to: the folder under a container folder (`packages/broker`), else its first folder, else the repository's root. */
export function moduleOf(path: string): string {
  const parts = normalizedTierPath(path).split("/").filter((part) => part.length > 0);
  if (parts.length <= 1) return ".";
  if (MODULE_CONTAINERS.has(parts[0]!) && parts.length >= 3) return `${parts[0]!}/${parts[1]!}`;
  return parts[0]!;
}

// ---- reasons

function collect(reasons: readonly TierReason[]): TierReason[] {
  const seen = new Set<string>();
  const out: TierReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}\u0000${reason.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
    if (out.length >= FLOW_TIER_REASONS_MAX) break;
  }
  return out;
}
const withoutPath = (code: string): TierReason => ({ code });

// ---- the diff tier

/**
 * The tier of a change, from the code host's list of changed files (merge base to head). Every rule only raises. A diff that is not whole, or a file whose content could not be read, is risky: unknown is never small.
 * `kinds` says what the change touched, at every level.
 */
export function tierFromDiff(input: DiffInput, context: TierContext): ChangeTier {
  const limits = context.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  const risky: TierReason[] = [];
  const standard: TierReason[] = [];
  const kinds = new Set<TierKind>();
  if (!input.complete) risky.push(withoutPath("incomplete_diff"));
  if (input.files.length === 0) risky.push(withoutPath("no_diff_files"));
  if (input.files.length >= CHANGED_FILES_MAX) risky.push(withoutPath("too_many_files"));
  let lines = 0;
  let files = 0;
  let api: string | undefined;
  const modules = new Set<string>();
  const testModules = new Set<string>();
  for (const file of input.files) {
    const reading = readFile(file);
    risky.push(...reading.risky);
    standard.push(...reading.standard);
    for (const kind of reading.kinds) kinds.add(kind);
    lines += reading.codeLines;
    if (reading.countsAsFile) files += 1;
    if (reading.isCode) {
      const key = `${file.repository ?? ""}:${moduleOf(file.path)}`;
      (reading.isTest ? testModules : modules).add(key);
    }
    if (file.apiShapeChanged === true && api === undefined) api = file.path;
  }
  if (lines > limits.riskyLines) risky.push(withoutPath("large_change"));
  if (lines > limits.standardLines) standard.push(withoutPath("more_than_lines"));
  if (files > limits.standardFiles) standard.push(withoutPath("more_than_files"));
  // Tests belong to the module they test: they add a module only when nothing else is changed.
  const moduleCount = (modules.size > 0 ? modules : testModules).size;
  if (moduleCount >= 2) standard.push(withoutPath("two_or_more_modules"));
  if (api !== undefined) standard.push({ code: "api_change", path: api.slice(0, FLOW_REASON_PATH_MAX) });
  const level: TierLevel = risky.length > 0 ? "risky" : standard.length > 0 ? "standard" : "small";
  return {
    level, kinds: [...kinds].sort(), source: "diff", reasons: collect([...risky, ...standard]),
    ...(context.headSha === undefined ? {} : { headSha: context.headSha }), ...(context.mergeBase === undefined ? {} : { mergeBase: context.mergeBase }), at: context.at,
  };
}

// ---- the estimate

/** Words in a request that hint at a sensitive area. A hint raises the estimate to at least standard; it never refuses a request (and the diff decides the tier that counts). */
const SENSITIVE_REQUEST_HINT = /\b(?:auth\w*|log\s?in|sign\s?in|password\w*|token\w*|credential\w*|secret\w*|permission\w*|\biam\b|rbac|payment\w*|billing|invoice\w*|refund\w*|charge\w*|migration\w*|delete\w*|deletion|erase\w*|purge\w*|drop\s+table|encrypt\w*)\b/iu;

export interface EstimateInput {
  /** The files the plan names, when it names any. Undefined or empty: nothing is known of the size, and the estimate is standard. */
  plannedPaths?: readonly string[] | undefined;
  requestText?: string | undefined;
}

/**
 * The tier BEFORE the build, from the files the plan names and the words of the request. It cannot see lines, so it never reads size beyond the number of files and modules; it never reads a diff. A plan that names no files is
 * standard. Anything that is risky by its path is risky already. The diff tier replaces the estimate after the build.
 */
export function estimateTier(input: EstimateInput, context: TierContext): ChangeTier {
  const limits = context.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  const paths = [...new Set((input.plannedPaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0))];
  const risky: TierReason[] = [];
  const standard: TierReason[] = [];
  const kinds = new Set<TierKind>();
  if (paths.length === 0) standard.push(withoutPath("no_files_named"));
  let files = 0;
  const modules = new Set<string>();
  const testModules = new Set<string>();
  for (const path of paths) {
    const normal = normalizedTierPath(path);
    const reasonFor = (code: string): TierReason => ({ code, path: path.slice(0, FLOW_REASON_PATH_MAX) });
    if (isHookPath(path)) risky.push(reasonFor("hook_file"));
    if (isInstructionPath(path)) risky.push(reasonFor("instruction_file"));
    if (isTierSensitivePath(path)) risky.push(reasonFor("sensitive_path"));
    if (GIT_SETTINGS_FILES.test(normal)) risky.push(reasonFor("git_settings_file"));
    if (PACKAGE_SOURCE_FILES.test(normal)) risky.push(reasonFor("package_source_setting"));
    if (/(?:^|\/)\.env[^/]*$/u.test(normal)) risky.push(reasonFor("env_file"));
    if (isProsePath(path)) { kinds.add("docs"); continue; }
    if (isLockfile(normal)) { kinds.add("dependency"); continue; }
    files += 1;
    if (isCiFilePath(path)) kinds.add("ci_file");
    else if (isManifest(normal)) kinds.add("dependency");
    else kinds.add("code_config");
    if (isInstallScript(path)) kinds.add("install_link");
    (isTestPath(normal) ? testModules : modules).add(moduleOf(path));
  }
  if (files > limits.standardFiles) standard.push(withoutPath("more_than_files"));
  if ((modules.size > 0 ? modules : testModules).size >= 2) standard.push(withoutPath("two_or_more_modules"));
  if (input.requestText !== undefined && SENSITIVE_REQUEST_HINT.test(input.requestText)) standard.push(withoutPath("request_mentions_sensitive_area"));
  const level: TierLevel = risky.length > 0 ? "risky" : standard.length > 0 ? "standard" : "small";
  return { level, kinds: [...kinds].sort(), source: "estimate", reasons: collect([...risky, ...standard]), ...(context.headSha === undefined ? {} : { headSha: context.headSha }), at: context.at };
}

// ---- only up

/**
 * The tier after a new one is computed: it never goes down. A new tier that is lower keeps the higher level, the kinds and the reasons already recorded (the new head and merge base are the ones it is bound to).
 * An ESTIMATE is only a forecast, so the first real diff replaces it, whatever its level; every tier after that only goes up.
 */
export function raiseTier(previous: ChangeTier | undefined, next: ChangeTier): ChangeTier {
  if (previous === undefined || previous.source === "estimate") return next;
  const kinds = [...new Set([...previous.kinds, ...next.kinds])].sort();
  // The higher level keeps its own reasons first: they say why the tier is where it is.
  return RANK[next.level] >= RANK[previous.level]
    ? { ...next, kinds, reasons: collect([...next.reasons, ...previous.reasons]) }
    : { ...next, level: previous.level, kinds, reasons: collect([...previous.reasons, ...next.reasons]) };
}

/** Whether `fresh` is a higher level than the level an approval was given at. */
export const tierGrew = (approvedAt: TierLevel, fresh: Pick<ChangeTier, "level">): boolean => RANK[fresh.level] > RANK[approvedAt];

// ---- the planned-path limit

/** The paths a change touches that the plan did not name. A planned entry ending in `/` covers everything under it. A lock file is covered when its manifest's folder has a planned manifest. */
export function plannedPathsExceeded(planned: readonly string[], changed: ReadonlyArray<string | { path: string; previousPath?: string | undefined }>): string[] {
  const plan = planned.map(normalizedTierPath);
  const covered = (path: string): boolean => {
    const normal = normalizedTierPath(path);
    if (plan.some((entry) => entry === normal || (entry.endsWith("/") && normal.startsWith(entry)))) return true;
    if (isLockfile(normal)) {
      const folder = normal.includes("/") ? normal.slice(0, normal.lastIndexOf("/") + 1) : "";
      return plan.some((entry) => isManifest(entry) && (entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "") === folder);
    }
    return false;
  };
  const exceeded: string[] = [];
  for (const entry of changed) {
    const paths = typeof entry === "string" ? [entry] : [entry.path, ...(entry.previousPath === undefined ? [] : [entry.previousPath])];
    for (const path of paths) if (!covered(path) && !exceeded.includes(path)) exceeded.push(path);
  }
  return exceeded;
}

// ---- words for a person

const REASON_PHRASES: Readonly<Record<string, string>> = {
  incomplete_diff: "more files than Rovara could list", no_diff_files: "no files Rovara could list", too_many_files: "more files than Rovara can check", unreadable_content: "a file Rovara could not read",
  binary_content: "a binary file", mode_or_type_change: "a file-mode or file-type change", symlink_suspected: "what looks like a symbolic link", submodule: "a submodule", lfs_pointer: "a large-file pointer",
  large_change: "more than 400 lines of code", more_than_lines: "more than 100 lines of code", more_than_files: "more than 3 files", two_or_more_modules: "more than one module", api_change: "a public API",
  new_dependency: "a new dependency", lockfile_not_understood: "a lock file Rovara cannot read", code_file_deleted: "a deleted code file", no_files_named: "files the plan did not name", request_mentions_sensitive_area: "a sensitive area",
  registry_source_changed: "a package source", dependency_source: "a package source", install_script: "an install script", ci_privileged: "a privileged CI setting", package_source_setting: "a package source setting",
  hook_file: "a git hook", instruction_file: "an instruction file", sensitive_path: "a sensitive path", git_settings_file: "a git settings file", env_file: "an environment file",
};

/** What grew, in one plain phrase: the first reason that put the tier at its level, with its path when it has one. `shown` makes the path safe to print (the caller's inert-text function). */
export function tierGrowthPhrase(tier: Pick<ChangeTier, "level" | "reasons">, shown: (path: string) => string): string {
  const top = tier.reasons[0];
  if (top === undefined) return "something Rovara could not check";
  const phrase = REASON_PHRASES[top.code] ?? "something that needs more checks";
  return top.path === undefined ? phrase : `${phrase} (${shown(top.path)})`;
}

/** The sentence a merge is refused with when the change grew after the approvals were given. */
export function tierGrowthSentence(tier: Pick<ChangeTier, "level" | "reasons">, shown: (path: string) => string): string {
  return `This change now touches ${tierGrowthPhrase(tier, shown)}, so it needs ${tier.level} checks.`;
}

// ---- the record on the workflow


const compactTier = (tier: ChangeTier, reasons: number, pathMax: number): ChangeTier => ({
  ...tier, reasons: tier.reasons.slice(0, reasons).map((reason) => (reason.path === undefined ? reason : { ...reason, path: reason.path.slice(0, pathMax) })),
});

/**
 * The `flow` record kept under its size limit (`FLOW_MAX_BYTES`): a record over it makes the whole task unreadable, so the writer always fits it. Earlier tiers lose their reasons first, then the oldest earlier tiers go, then the
 * current tier's reasons are cut. The level, kinds and binding of the current tier are never cut.
 */
export function fitFlow(flow: WorkflowFlow): WorkflowFlow {
  if (flowRecordBytes(flow) <= FLOW_MAX_BYTES) return flow;
  let next: WorkflowFlow = flow.tierHistory === undefined ? flow : { ...flow, tierHistory: flow.tierHistory.map((tier) => compactTier(tier, 2, 80)) };
  while (flowRecordBytes(next) > FLOW_MAX_BYTES && next.tierHistory !== undefined && next.tierHistory.length > 0) {
    const [, ...rest] = next.tierHistory;
    const { tierHistory: _dropped, ...without } = next; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    next = rest.length === 0 ? without : { ...without, tierHistory: rest };
  }
  for (const [reasons, pathMax] of [[20, 200], [10, 120], [5, 80], [3, 60], [1, 40], [0, 0]] as const) {
    if (flowRecordBytes(next) <= FLOW_MAX_BYTES || next.tier === undefined) break;
    next = { ...next, tier: compactTier(next.tier, reasons, pathMax) };
  }
  return next;
}

/** The `flow` record with a new tier written. The previous tier moves into `tierHistory` (oldest first, at most 20) when it is a different tier. The level never goes down (`raiseTier`). */
export function recordTier(flow: WorkflowFlow | undefined, next: ChangeTier): { flow: WorkflowFlow; tier: ChangeTier; grew: boolean } {
  const previous = flow?.tier;
  const tier = raiseTier(previous, next);
  const history = [...(flow?.tierHistory ?? [])];
  if (previous !== undefined && (previous.source !== tier.source || previous.level !== tier.level || previous.headSha !== tier.headSha)) history.push(previous);
  const kept = history.slice(-FLOW_TIER_HISTORY_MAX);
  const grew = previous !== undefined && RANK[tier.level] > RANK[previous.level];
  return { flow: fitFlow({ ...(flow ?? { rulesVersion: TIER_RULES_VERSION }), rulesVersion: TIER_RULES_VERSION, tier, ...(kept.length === 0 ? {} : { tierHistory: kept }) }), tier, grew };
}

/** The `flow` record with one review step's catch counter written: how many findings it made, how many must be fixed. A step that ran again replaces its own counter. */
export function recordCatch(flow: WorkflowFlow | undefined, entry: { step: string; findings: number; mustFix: number }): WorkflowFlow {
  const others = (flow?.catchCounters ?? []).filter((counter) => counter.step !== entry.step);
  const counters = [...others, { step: entry.step.slice(0, 40), findings: Math.max(0, Math.trunc(entry.findings)), mustFix: Math.max(0, Math.trunc(entry.mustFix)), changedCode: 0 }].slice(-FLOW_CATCH_COUNTERS_MAX);
  return fitFlow({ ...(flow ?? { rulesVersion: TIER_RULES_VERSION }), rulesVersion: TIER_RULES_VERSION, catchCounters: counters });
}

/** The code changed: every review step that already ran has seen code change after it. */
export function recordCodeChanged(flow: WorkflowFlow | undefined): WorkflowFlow | undefined {
  if (flow?.catchCounters === undefined || flow.catchCounters.length === 0) return flow;
  return fitFlow({ ...flow, catchCounters: flow.catchCounters.map((counter) => ({ ...counter, changedCode: counter.changedCode + 1 })) });
}

/** The `flow` record when the change grew after the tier its approvals were given at: from the first level it was approved at to the highest it reached. Kept at the highest; never lowered. */
export function recordGrowth(flow: WorkflowFlow, from: TierLevel, to: TierLevel, at: string): WorkflowFlow {
  if (RANK[to] <= RANK[from]) return flow;
  const earlier = flow.grewAfterBuild;
  if (earlier !== undefined && RANK[earlier.to] >= RANK[to]) return flow;
  return fitFlow({ ...flow, grewAfterBuild: { from: earlier === undefined ? from : earlier.from, to, at } });
}
