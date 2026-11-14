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
import { createHash } from "node:crypto";
import { type FlowTier, type FlowTierKind, type FlowTierLevel, type WorkflowFlow, FLOW_CATCH_COUNTERS_MAX, FLOW_MAX_BYTES, FLOW_REASON_PATH_MAX, FLOW_TIER_HISTORY_MAX, FLOW_TIER_REASONS_MAX, flowRecordBytes } from "@agentx/contracts";
import { CHANGED_FILES_MAX } from "../proof/changed-files.js";
import { isTestPath } from "../proof/verification-report.js";
import {
  BIDI_CONTROL, fileTypeOf, hasConfusableLetter, hasMixedScriptWord, hasNonAsciiLetter, isApiShapePath, isCheckConfigPath, isCiFilePath, isDocsAllowlistPath, isDocsBuildConfigPath, isHookPath, isInfraPath, isInstructionPath, isPromptHintPath, isScannerIgnorePath,
  isTierSensitivePath, normalizedTierPath,
} from "./sensitive-list.js";

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
  "ci_privileged", "large_change", "confusable_path", "infra_file", "instruction_import", "ci_unpinned_action", "ci_file_deleted", "check_config_deleted", "path_too_long", "link_kind_unknown", "ignore_file", "secret_like_text", "script_command", "check_weakened_security", "docs_executes", "bidi_control", "eval_hint", "line_break_character", "path_control_character", "ci_fetch_and_run", "ci_net_send", "ci_check_removed", "invisible_character", "confusable_text", "reviewer_injection_text", "docs_build_hook",
  // standard
  "more_than_lines", "more_than_files", "two_or_more_modules", "api_change", "new_dependency", "lockfile_not_understood", "code_file_deleted", "test_file_deleted", "no_files_named", "request_mentions_sensitive_area",
  "unrecognised_file_type", "long_lines", "package_alias", "lock_package_changed", "script_changed", "text_data_file", "vendored_code", "check_weakened", "docs_include", "docs_not_plain", "docs_unread", "docs_site_build", "docs_large", "scanner_ignore_file", "docs_build_config",
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
  /** What is known of the code at the head, beyond the diff. */
  head?: HeadFacts | undefined;
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

const baseName = (path: string): string => path.split("/").at(-1) ?? "";
/** The file name of a path as the rules read it (normalized, so `README.MD` and `SECURITY.md` are read like their lower-case names). */
const nameOf = (path: string): string => baseName(normalizedTierPath(path));
/** Names a prose extension does not make a document: dependency pins, locks, ownership, licence, environment and security files. */
const NOT_DOCS_NAME = /^(?:[^/]*(?:requirements|constraints)[^/]*\.txt|cmakelists\.txt|robots\.txt|ads\.txt|[^/]*\.lock|codeowners|license[^/]*|\.env[^/]*|security[^/]*)$/u;
/** Dependency pins kept in a folder of their own (`requirements/base.txt`). */
const PINS_FOLDER = /(?:^|\/)(?:requirements|constraints)\/[^/]*\.txt$/u;
const PROSE_EXTENSION = /\.(md|markdown|rst|adoc|txt)$/u;

/** Where a fact about a file is kept: by repository and path as the host listed it. */
export const factKey = (repository: string | undefined, path: string): string => `${repository ?? ""}\u0000${path}`;

/**
 * What is known of the code at the head commit, beyond the diff. All of it is optional; what is not given is not known, and the rules then fall back to what the diff alone shows (never to a lower tier).
 */
export interface HeadFacts {
  /** The text of files at the head (keyed by `factKey`), so the heading and fence a changed line sits in is known even when the hunk does not show it. */
  text?: ReadonlyMap<string, string> | undefined;
  /** Paths (normalized, keyed by `factKey`) that an instruction file at the head imports or links: a document an instruction file reads is an instruction. */
  instructionImports?: ReadonlySet<string> | undefined;
  /** False when the instruction files could not be read: no document can then be cleared as plain docs. */
  importsKnown?: boolean | undefined;
  /** Paths (keyed by `factKey`) the host says are a symbolic link or a submodule at the head. */
  links?: ReadonlySet<string> | undefined;
  /** Paths (keyed by `factKey`) whose kind was NOT asked (past the read limit): unknown is risky. */
  unchecked?: ReadonlySet<string> | undefined;
  /** True when the repository builds a documentation site (a docs build config exists at the head), or that could not be ruled out: a document may then be compiled or executed by the build. */
  docsSite?: boolean | undefined;
}

/** A document on the docs route: README*, CHANGELOG*, CONTRIBUTING* and `docs/**` in Markdown, reStructuredText or AsciiDoc, in no instruction, skill, prompt, agent, infrastructure or sensitive area. */
function isDocsPath(path: string): boolean {
  return isDocsAllowlistPath(path) && !NOT_DOCS_NAME.test(nameOf(path)) && !isTierSensitivePath(path) && !isInstructionPath(path) && !isPromptHintPath(path) && !isHookPath(path) && !isInfraPath(path) && !isCiFilePath(path)
    && !hasConfusableLetter(path) && !hasNonAsciiLetter(path);
}

// ---- the docs route is an allowlist on CONTENT

const HTML_TAG = /<\/?[A-Za-z][\w:-]*(?:[\s/>]|$)|\bjavascript:|\bon[a-z]{3,}\s*=/u;
/** Domains written without a scheme: a download or a registry named in words. */
const BARE_DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|sh|co|ai|xyz|example|test|cloud|site|online|info|me|us|uk|de|ru|cn|tk|ml|ga|cf|gq|zip|mov|run|page|link|click|top|pw|cc|ws|to|ly|gl|so|fm|tv)\b/iu;
const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\]\(|^\s*\[[^\]]+\]:\s*\S/iu;
/** Lines that a docs build, a template engine or a reader's tool treats as something other than prose. */
const NOT_PLAIN_MARKUP = /[{}]|^\s*[<>]|<<<|>>>|--8<--|:::|\[\[\[|\$\(|\$\{|^\s*\.\.\s+\S|^\s*\{%|%\}|^\s*\{\{|\bimport\s+\S+\s+from\b|^\s*export\s/u;
const KEY_VALUE = /(?:^|\s)[A-Za-z_][\w.-]*=\S/u;
const CONTROL_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** What a docs line holds that RUNS something when a build or a test reads it (risky, not merely standard). */
const DOCS_EXECUTES = /\b(?:require|import)\s*\(|child_process|execSync|spawnSync|\beval\s*\(|new Function\(|os\.system|subprocess|__import__|program-output|__class__|__mro__|\[\[\[cog|^\s*>>>|^\s*export\s+(?:const|default|function|let|var)|<script|dangerouslySetInnerHTML|createElement\s*\(|<\?php|\bsystem\s*\(/u;
const INLINE_CODE = /`([^`]*)`/gu;

/**
 * Whether a line is plain prose: no braces or template and directive syntax, no markup, no link or domain, no `KEY=value`, no control or direction-changing character, and no command in a code span (an odd backtick is a
 * span split over lines: it cannot be read, so it is not plain).
 */
export function plainProseLine(line: string): boolean {
  if (CONTROL_CHAR.test(line.replaceAll("\t", "")) || BIDI_CONTROL.test(line)) return false;
  if (NOT_PLAIN_MARKUP.test(line) || HTML_TAG.test(line) || SCHEME_URL.test(line) || BARE_DOMAIN.test(line) || KEY_VALUE.test(line)) return false;
  if ((line.match(/`/gu) ?? []).length % 2 === 1) return false;
  for (const span of line.matchAll(INLINE_CODE)) if (/\s/u.test(span[1]!.trim()) || isCommandLine(span[1]!)) return false;
  return !isCommandLine(line);
}

/** The block each line of a document sits in, or -1: fenced code, an indented code block, an HTML block (script, style, pre, iframe...) or a tag that runs over several lines, and a front-matter block. */
function blocksOfDocument(lines: readonly string[]): { blockOf: number[]; ranges: Array<[number, number]> } {
  const blockOf: number[] = lines.map(() => -1);
  const ranges: Array<[number, number]> = [];
  const open = (start: number, end: number): void => { ranges.push([start, end]); for (let at = start; at <= end; at += 1) blockOf[at] = ranges.length - 1; };
  if (lines[0]?.trim() === "---") { const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---"); if (close > 0) open(0, close); }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (blockOf[index] !== -1) { index += 1; continue; }
    if (FENCE.test(line)) {
      let end = lines.findIndex((candidate, at) => at > index && FENCE.test(candidate));
      if (end < 0) end = lines.length - 1;
      open(index, end); index = end + 1; continue;
    }
    const block = /<(script|style|pre|iframe|svg|template|textarea|object|embed|math|details|noscript)\b/iu.exec(line);
    if (block !== null) {
      let end = lines.findIndex((candidate, at) => at >= index && new RegExp(`</${block[1]!}\\s*>`, "iu").test(candidate));
      if (end < 0) end = lines.length - 1;
      open(index, end); index = end + 1; continue;
    }
    // A tag that is opened and not closed on its line runs on to the line that has the `>`.
    if (/<[A-Za-z][\w:-]*(?:\s[^>]*)?$/u.test(line) && !/>/u.test(line.slice(line.lastIndexOf("<")))) {
      let end = lines.findIndex((candidate, at) => at > index && />/u.test(candidate));
      if (end < 0) end = lines.length - 1;
      open(index, end); index = end + 1; continue;
    }
    if (INDENTED.test(line) && (index === 0 || lines[index - 1]!.trim() === "")) {
      let end = index;
      while (end + 1 < lines.length && (lines[end + 1]!.trim() === "" || INDENTED.test(lines[end + 1]!))) end += 1;
      while (end > index && lines[end]!.trim() === "") end -= 1;
      open(index, end); index = end + 1; continue;
    }
    index += 1;
  }
  return { blockOf, ranges };
}

/** The most changed lines the docs route may carry: more is a rewrite, and a rewrite is not looked at as prose. */
export const DOCS_ROUTE_LINES_MAX = 300;

/**
 * Whether a document's change is plain prose: every changed line is (`plainProseLine`), and so is every line of any block the change sits in. With the text of the file at the head the blocks are exact; without it nothing can
 * be said of what surrounds a hunk, so the caller does not clear it (`headKnown`). `run` marks a line that RUNS something (risky).
 */
function docsContentProblem(patch: string, headText: string | undefined, headKnown: boolean): { problem: "unread" | "not_plain" | "executes" | "include"; } | undefined {
  const hunks = hunksOf(patch);
  const changed = hunks.flatMap((hunk) => hunk.lines.filter((line) => line.changed));
  if (changed.some((line) => DOCS_EXECUTES.test(line.text))) return { problem: "executes" };
  if (changed.some((line) => /^\s*\.\.\s+(?:include|literalinclude|csv-table|figure|image)::|:file:|^\s*\{\{#include|^\s*\{%\s*include\b|<!--#include|^\s*include::|--8<--|^\s*<<<|@include|:::\{?include/iu.test(line.text))) return { problem: "include" };
  if (changed.some((line) => !plainProseLine(line.text))) return { problem: "not_plain" };
  if (headText === undefined) return headKnown ? { problem: "unread" } : undefined;
  const lines = headText.split("\n");
  const { blockOf, ranges } = blocksOfDocument(lines);
  for (const line of changed) {
    const block = blockOf[Math.min(line.newLine - 1, lines.length - 1)] ?? -1;
    if (block < 0) continue;
    const [start, end] = ranges[block]!;
    for (let at = start; at <= end; at += 1) {
      const text = lines[at]!;
      if (FENCE.test(text) || /^---\s*$/u.test(text)) continue;
      if (DOCS_EXECUTES.test(text)) return { problem: "executes" };
      if (!plainProseLine(text)) return { problem: "not_plain" };
    }
  }
  return undefined;
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "go.sum", "pipfile.lock", "poetry.lock", "uv.lock", "gemfile.lock", "composer.lock",
  "packages.lock.json", "mix.lock", "pubspec.lock", "gradle.lockfile", "flake.lock", "podfile.lock", "cartfile.resolved",
]);
const MANIFEST_NAMES = new Set([
  "package.json", "composer.json", "pyproject.toml", "cargo.toml", "go.mod", "go.work", "gemfile", "pipfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "libs.versions.toml", "mix.exs", "pubspec.yaml",
  "directory.packages.props", "directory.build.props", "directory.build.targets", "deno.json", "deno.jsonc", "import_map.json", "package.swift", "environment.yml", "environment.yaml", "conda.yml", "conda-lock.yml", "conanfile.txt", "conanfile.py", "vcpkg.json", "cartfile", "podfile", "brewfile", "setup.py", "setup.cfg",
]);
const isLockfile = (path: string): boolean => LOCKFILE_NAMES.has(baseName(path)) || baseName(path).endsWith(".lock");
/** A `.txt` that lists dependencies: by its name (requirements, constraints, reqs, deps, pins, conanfile, pip) or by living in a requirements folder. */
const isRequirementsFile = (path: string): boolean => /^[^/]*(?:requirement|constraint|reqs?\b|reqs?[-_.]|[-_.]reqs?\b|conanfile|depend|deps\b|[-_.]deps|pins?\b|pip)[^/]*\.txt$/u.test(baseName(path)) || PINS_FOLDER.test(path);
const isManifest = (path: string): boolean => MANIFEST_NAMES.has(baseName(path)) || /\.csproj$/u.test(baseName(path)) || isRequirementsFile(path);
/** Vendored third-party code: an edit to it is an edit to a dependency. */
const isVendored = (path: string): boolean => /(^|\/)(vendor|vendors|third[-_]party|third_party|node_modules|bower_components)\//u.test(normalizedTierPath(path));

/** Files that say where packages come from. A change to one is risky whatever it says. */
const PACKAGE_SOURCE_FILES = /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.ya?ml)?|\.pnpmfile\.c?js|pip\.(?:conf|ini)|\.pypirc|nuget\.config|bunfig\.toml|\.condarc|\.gemrc|\.bundle\/config|\.cargo\/config(?:\.toml)?|\.mvn\/settings\.xml|settings\.xml|uv\.toml|\.uv\/|poetry\.toml|\.terraformrc|\.netrc)$/u;
/** Git's own settings files. */
const GIT_SETTINGS_FILES = /(?:^|\/)(?:\.gitmodules|\.gitattributes)$/u;
/**
 * The words in a changed line that point a package manager at another source: index and registry settings with `-` or `_`, and the environment variables that do the same (`PIP_INDEX_URL`, `NPM_CONFIG_REGISTRY`, `UV_INDEX`, `GOPROXY`).
 * In real source code only the command-line forms count (a variable called `index_url` in a program is not a setting).
 */
const SOURCE_WORD = /(?:index[-_]url|find[-_]links|trusted[-_]host|--registry\b|npmRegistryServer|\bnpm_config_[a-z_]+|\bpip_[a-z_]*(?:index|find|trusted|proxy)[a-z_]*|\buv_(?:default_)?index[a-z_]*|\bgoproxy\b|\bgonosumdb\b|\bgoprivate\b|\bgoinsecure\b|\bcargo_registries[a-z_]*|\byarn_npm_registry[a-z_]*|\bbundle_mirror[a-z_]*)/iu;
const SOURCE_WORD_IN_CODE = /(?:--(?:extra-)?index-url|--find-links|--trusted-host|--registry\b|\bnpm_config_[a-z_]+|\bPIP_[A-Z_]*(?:INDEX|FIND_LINKS|TRUSTED_HOST|PROXY)[A-Z_]*|\bUV_(?:DEFAULT_)?INDEX\w*|\bGOPROXY\b|\bGONOSUMDB\b|\bYARN_NPM_REGISTRY\w*)/iu;
/** A registry or package source named as a key or setting: quoted JSON keys (`"registry":`), ini and yaml keys, NuGet restore sources in .props and .targets files. */
const SOURCE_WORD_IN_CONFIG = /(?:^|[\s"'@:{,])(?:[\w-]+:)?["']?(?:registry|registries|npmRegistry\w*|publishConfig|packageSources?|restoreSources?|RestoreSources|RestoreAdditionalProjectSources|RestoreFallbackFolders|nugetSources?|mirror|mirrors|repositories|index[-_]url)["']?\s*[=:]|<add\s+key=[^>]*value=["']?https?:|RestoreAdditionalProjectSources|<RestoreSources>|<PackageSource\b/iu;
const CONFIG_FILE = /\.(?:toml|cfg|ini|conf|ya?ml|json|xml|properties|props|targets|csproj|vbproj|fsproj|nuspec|gradle|kts|plist)$|(?:^|\/)\.[\w-]*rc$/u;
/** Settings that let install scripts run, or turn the guards against them off. */
const INSTALL_GUARD_WORDS = /(?:onlyBuiltDependencies|neverBuiltDependencies|trustedDependencies|dangerouslyAllowAllBuilds|ignore-scripts|ignoreScripts|enable-pre-post-scripts|enablePrePostScripts)/u;
/** The scripts an install runs, matched anywhere in a line (a one-line `"scripts": { "postinstall": ... }` too). */
const LIFECYCLE_SCRIPT = /"(?:(?:pre|post)?(?:install|prepare)|prepublish|prepack|postpack|(?:pre|post)-(?:install|update|autoload-dump|root-package-install|create-project|package-(?:install|update|uninstall))-cmd|post-autoload-dump)"\s*:/u;
/** Git hook runners configured inside package.json. */
const HOOK_CONFIG = /"(?:simple-git-hooks|husky|lefthook|pre-commit|pre-push|commit-msg|post-merge|post-checkout|post-rewrite|prepare-commit-msg|pre-rebase)"\s*:/u;
/** A line that sets a script of package.json (a command, not a dependency or a plain field). */
const SCRIPT_LINE = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/u;
/** What makes a script line more than a flag change: a chain, a pipe, a substitution, a shell or a fetch. */
const SHELL_LIKE_SCRIPT = /[;&|`]|\$\(|\b(?:sh|bash|zsh|curl|wget|node|npx|eval|exec|sudo|python3?|perl|ruby)\b/u;

const INSTALL_SCRIPT_NAME = /^(?:install|setup|bootstrap|uninstall|get[-_][\w.-]*|install[-_][\w.-]*)(?:\.(?:sh|bash|zsh|ps1|bat|cmd|py))?$/u;
const isInstallScript = (path: string): boolean => INSTALL_SCRIPT_NAME.test(nameOf(path)) && !PROSE_EXTENSION.test(nameOf(path));
const SHELL_LIKE = /\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/u;

// ---- install links in documents

const URL_IN_LINE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bgit@[\w.-]+:|\]\(|\bhref\s*=|\bsrc\s*=|^\s*\[[^\]]+\]:\s*\S)/iu;
/** A package manager, build tool or shell command with a verb, wherever it stands in a line (backticks or not). */
const TOOL_COMMAND = /\b(?:npm|npx|yarn|pnpm|bun|bunx|pip3?|pipx|uvx?|poetry|brew|apt(?:-get)?|apk|dnf|yum|snap|choco|winget|scoop|gem|cargo|go|composer|dotnet|nix|conda|mamba|helm|kubectl|terraform|docker|podman|git|make|gh|aws|gcloud|az|dpkg|rpm|zypper|pacman|flatpak|asdf|nvm|rustup|sdk)\s+(?:install|add|i|get|run|exec|dlx|x|tool|tap|cask|reinstall|global|upgrade|update|remove|clone|pull|build|create|init|apply|deploy|pip|-g|--global|-[a-z])\b/iu;
/** A tool that runs a package straight from a registry: whatever follows is what gets run. */
const RUNS_PACKAGE = /\b(?:npx|bunx|pnpx|uvx|pipx\s+run|yarn\s+dlx|pnpm\s+dlx|npm\s+exec|deno\s+run)\s+\S+/iu;
const SHELL_COMMAND = /(?:^|[\s`$>(|;&])(?:sudo|curl|wget|iex|irm|chmod|chown|eval|source)\s/iu;
const INTERPRETER_COMMAND = /\b(?:node|python3?|deno|bun|ruby|perl|php|java|sh|bash|zsh|pwsh|powershell|tsx|ts-node)\s+(?:-{1,2}\w|\.{0,2}\/|~\/|[\w./-]+\.(?:js|mjs|cjs|ts|py|sh|rb|pl|php|jar|ps1))/iu;
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/iu;
/** A line that reads as something to run, whether or not it is in a block. */
const isCommandLine = (text: string): boolean => TOOL_COMMAND.test(text) || RUNS_PACKAGE.test(text) || SHELL_COMMAND.test(` ${text}`) || INTERPRETER_COMMAND.test(text) || PIPE_TO_SHELL.test(text);
/** Used only where the section a line sits in is unknown: anything that is not plain prose. */
const LOOKS_TECHNICAL = /(?:^|\s)-{1,2}[a-z]|\.\/|~\/|^\s*\$ |&&|\|\s*\w|=\s*\S|\bhttps?\b|[\\/][\w.-]+\.\w{1,4}\b/iu;

const FENCE = /^\s*(```|~~~)/u;
const PRE_OPEN = /<pre\b/iu;
const PRE_CLOSE = /<\/pre\s*>/iu;
const INSTALL_WORDS = /\b(?:install\w*|set\s?up|getting started|quick\s?start|download\w*|upgrad\w*|build(?:ing)?(?: from source)?|usage|requirements?|prerequisites?|run(?:ning)?|deploy\w*|bootstrap\w*|commands?)\b/iu;
const ATX_HEADING = /^\s{0,3}#{1,6}\s+(.*)$/u;
const HTML_HEADING = /<h[1-6][^>]*>(.*?)<\/h[1-6]\s*>/iu;
/** An indented code block line: four spaces or a tab. */
const INDENTED = /^(?: {4}|\t)\S/u;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-{2,})\s*$/u;

interface LineState { fenced: boolean; install: boolean; pre: boolean; marker: boolean }

/** The state each line of a whole document is in: inside a fenced block or an HTML `pre`, under an install heading (`#` or underlined), or a block marker itself. */
function statesOfDocument(lines: readonly string[]): LineState[] {
  const states: LineState[] = [];
  let fenced = false;
  let pre = false;
  let install = false;
  let indented = false;
  lines.forEach((line, index) => {
    let marker = false;
    if (FENCE.test(line)) { fenced = !fenced; marker = true; indented = false; }
    else if (!fenced) {
      if (PRE_OPEN.test(line)) { pre = true; marker = true; }
      const heading = ATX_HEADING.exec(line) ?? HTML_HEADING.exec(line);
      if (heading !== null) install = INSTALL_WORDS.test(heading[1]!);
      else if (SETEXT_UNDERLINE.test(line) && index > 0 && lines[index - 1]!.trim() !== "") install = INSTALL_WORDS.test(lines[index - 1]!);
      // An indented code block: indented lines after a blank line (or after another indented line) until a line that is not.
      if (INDENTED.test(line) && (index === 0 || lines[index - 1]!.trim() === "" || indented)) indented = true;
      else if (line.trim() !== "") indented = false;
    }
    states.push({ fenced: fenced || indented, install, pre, marker });
    if (!fenced && PRE_CLOSE.test(line)) pre = false;
  });
  return states;
}

interface PatchLine { text: string; changed: boolean; newLine: number }
interface Hunk { startsAtTop: boolean; lines: PatchLine[] }
function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let cursor = 1;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header !== null) { current = { startsAtTop: Number(header[1]) <= 1, lines: [] }; hunks.push(current); cursor = Number(header[2]); continue; }
    if (current === undefined || line.startsWith("\\")) continue;
    const mark = line[0];
    if (mark === "+") { current.lines.push({ text: line.slice(1), changed: true, newLine: cursor }); cursor += 1; }
    else if (mark === "-") current.lines.push({ text: line.slice(1), changed: true, newLine: cursor });
    else { current.lines.push({ text: line.startsWith(" ") ? line.slice(1) : line, changed: false, newLine: cursor }); cursor += 1; }
  }
  return hunks;
}

/**
 * Whether a document's patch changes a command or a link that a reader would run or follow: any changed line that has a URL or reads as a command (in any form, with or without backticks), any changed line inside a fenced block,
 * an HTML `pre` or an install section, and a block marker itself. With the text of the file at the head the section a line sits in is exact, even when the hunk does not show the heading. Without it, a hunk that does not
 * start at the top has an unknown state before its first marker: its changed lines count when they are anything but plain prose.
 */
function documentChangesLink(patch: string, headText: string | undefined): boolean {
  const hunks = hunksOf(patch);
  const known = headText === undefined ? undefined : statesOfDocument(headText.split("\n"));
  for (const hunk of hunks) {
    let fenced = false;
    let pre = false;
    let install = false;
    let codeIndented = false;
    let unknownBefore = !hunk.startsAtTop && known === undefined;
    // Before a closing-looking fence (no language) the lines may be inside a block that began above the hunk.
    const bareFenceAt = unknownBefore ? hunk.lines.findIndex((entry) => /^\s*(?:```|~~~)\s*$/u.test(entry.text)) : -1;
    for (const [position, entry] of hunk.lines.entries()) {
      const text = entry.text;
      if (entry.changed && bareFenceAt > 0 && position < bareFenceAt) return true;
      let state: LineState | undefined = known?.[entry.newLine - 1];
      if (known === undefined) {
        if (FENCE.test(text)) { fenced = !fenced; unknownBefore = false; state = { fenced, install, pre, marker: true }; }
        else {
          if (PRE_OPEN.test(text)) { pre = true; state = { fenced, install, pre, marker: true }; } else if (PRE_CLOSE.test(text)) pre = false;
          const heading = ATX_HEADING.exec(text) ?? HTML_HEADING.exec(text);
          if (heading !== null) { install = INSTALL_WORDS.test(heading[1]!); unknownBefore = false; }
          // An indented line after a blank or another indented line of the hunk is a code block (a list item's text may be indented too: read as code).
          const before = position === 0 ? undefined : hunk.lines[position - 1]!.text;
          if (INDENTED.test(text) && (before === undefined || before.trim() === "" || INDENTED.test(before))) { codeIndented = true; }
          else if (text.trim() !== "") codeIndented = false;
          state = state ?? { fenced: fenced || codeIndented, install, pre, marker: false };
        }
      }
      if (!entry.changed) continue;
      if (state?.marker === true || state?.fenced === true || state?.pre === true || state?.install === true) return true;
      if (URL_IN_LINE.test(text) || isCommandLine(text)) return true;
      if (unknownBefore && LOOKS_TECHNICAL.test(text)) return true;
      // A changed line right under a setext heading in the hunk.
    }
    // Setext headings inside the hunk when no file text is known: the underline and the line above it.
    if (known === undefined) {
      const lines = hunk.lines;
      for (let index = 1; index < lines.length; index += 1) {
        if (SETEXT_UNDERLINE.test(lines[index]!.text) && lines[index - 1]!.text.trim() !== "" && INSTALL_WORDS.test(lines[index - 1]!.text)) {
          for (let after = index + 1; after < lines.length && !ATX_HEADING.test(lines[after]!.text) && !SETEXT_UNDERLINE.test(lines[after + 1]?.text ?? ""); after += 1) if (lines[after]!.changed) return true;
        }
      }
    }
  }
  return false;
}

// ---- dependencies in manifests and lock files

const NOT_A_DEPENDENCY_KEY = new Set(["name", "version", "edition", "description", "license", "readme", "authors", "requires-python", "python", "rust-version", "homepage", "repository", "documentation", "keywords", "categories", "publish", "resolver", "build", "include", "exclude", "default-run", "channel", "main", "module", "types", "type", "private", "author", "packagemanager", "source"]);
const VERSIONISH = /^(?:[~^<>=*]|v\d|\d|latest$|next$|workspace:|npm:|jsr:|file:|link:|portal:|patch:|git(?:\+|:|@)|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(?:#|$))/iu;
/** The package registries each ecosystem uses by default. A host that is not one of these, and that no removed line had, is a new source: GitHub and its tarball host are NOT registries. */
const DEFAULT_REGISTRY_HOSTS = new Set([
  "registry.npmjs.org", "registry.yarnpkg.com", "registry.npmjs.com", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io", "rubygems.org", "proxy.golang.org", "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "api.nuget.org", "packagist.org", "repo.packagist.org", "jsr.io", "deno.land", "conan.io", "center.conan.io", "conda.anaconda.org", "repo.anaconda.com",
]);
const hostsIn = (lines: readonly string[]): Set<string> => {
  const hosts = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(/\b(?:https?|git\+https?|git\+ssh|ssh|git|ftp):\/\/(?:[^@\s/"']*@)?([^/\s"':?#)]+)/giu)) hosts.add(match[1]!.toLowerCase());
  return hosts;
};
/** A source other than a registry: a git, file or link dependency, or a URL for a tarball. */
const NON_REGISTRY_SOURCE = /(?:git\+(?:https?|ssh)|git:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:|\bgit\s*=|\bpath\s*=|\bfile:|\blink:|\bportal:|-e\s+git|@\s*(?:https?|git\+))/iu;
/** A dependency value that names a GitHub repository by shorthand (`owner/repo`, `owner/repo#ref`). */
const SHORTHAND_SOURCE = /^[\w.-]+\/[\w.-]+(?:#.*)?$/u;
/** The package a registry address names (`.../name/-/name-1.0.0.tgz`). */
const RESOLVED_PACKAGE = /\/((?:@[^/"']+\/)?[^/"']+)\/-\/[^/"']+\.tgz/u;

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
    // A Conan reference: name/version, with an optional @user/channel.
    const conan = /^\s*([A-Za-z0-9][\w.-]*)\/[\w.+-]+(?:@[\w./-]+)?\s*$/u.exec(line);
    return match === null ? conan?.[1]?.toLowerCase() : match[1]!.toLowerCase();
  }
  if (name === "libs.versions.toml") return /^\s*([A-Za-z0-9][\w.-]*)\s*=\s*\{[^}]*(?:module|group)\s*=/u.exec(line)?.[1]?.toLowerCase();
  if (name === "environment.yml" || name === "environment.yaml" || name === "conda.yml") return /^\s*-\s*([A-Za-z0-9][\w.-]*)(?:\s*[=<>~!].*)?\s*$/u.exec(line)?.[1]?.toLowerCase();
  if (name === "package.swift") return /\.package\(\s*(?:name:\s*"[^"]*",\s*)?url:\s*"[^"]*\/([^/"]+?)(?:\.git)?"/u.exec(line)?.[1]?.toLowerCase();
  if (name === "deno.json" || name === "deno.jsonc" || name === "import_map.json") return /^\s*"([^"]+)"\s*:\s*"(?:https?:|jsr:|npm:)[^"]*"\s*,?\s*$/u.exec(line)?.[1]?.toLowerCase();
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

/** The version or source a package.json dependency line gives. */
const dependencyValue = (line: string): string | undefined => /^\s*"[@\w][\w@./-]*"\s*:\s*"([^"]*)"\s*,?\s*$/u.exec(line)?.[1];

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
  standard: TierReason[];
  /** Lines of the change that are dependency pinning, not code. */
  dependencyLines: number;
}

/** Reads the dependency side of a manifest or lock file from the changed lines. */
function readDependencies(file: TierFile, patch: PatchLines): DependencyReading {
  const path = normalizedTierPath(file.path);
  const lock = isLockfile(path);
  const name = baseName(path);
  const out: DependencyReading = { kind: false, newDependencies: [], lockNotUnderstood: false, risky: [], standard: [], dependencyLines: 0 };
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
  out.newDependencies = [...addedNames].filter((entry) => !removedNames.has(entry));
  // A lock file in a format this reader does not know cannot say which packages are new: standard.
  if (lock && patch.added.length + patch.removed.length > 0 && !LOCK_FORMATS_READ.has(name)) { out.lockNotUnderstood = true; out.kind = true; }
  // Where packages come from. An address on an added line that no removed line already had, and that is not a default registry, is a new source (GitHub and its tarball host are not registries).
  const removedHosts = hostsIn(patch.removed);
  for (const host of hostsIn(patch.added)) {
    if (!DEFAULT_REGISTRY_HOSTS.has(host) && !removedHosts.has(host)) out.risky.push(reason("registry_source_changed"));
  }
  const removedTrimmed = new Set(patch.removed.map((line) => line.trim()));
  if (patch.added.some((line) => NON_REGISTRY_SOURCE.test(line) && !removedTrimmed.has(line.trim()))) out.risky.push(reason("dependency_source"));
  if (name === "package.json" || name === "composer.json") {
    for (const line of patch.added) {
      const value = dependencyValue(line);
      if (value === undefined || removedTrimmed.has(line.trim())) continue;
      // A dependency that now names a GitHub repository by shorthand, or another package under an alias.
      if (SHORTHAND_SOURCE.test(value) && !value.startsWith("@") && !/^(?:workspace|file|link|npm|jsr|patch|catalog):/u.test(value)) out.risky.push(reason("dependency_source"));
      else if (/^(?:npm|jsr|patch):/u.test(value)) out.standard.push(reason("package_alias"));
    }
  }
  if ((name === "go.mod" || name === "go.work") && patch.added.some((line) => /^\s*(?:replace\s+)?\S+(?:\s+v\S+)?\s*=>\s*\S+/u.test(line) && !removedTrimmed.has(line.trim()))) out.risky.push(reason("dependency_source"));
  // Scripts a package manager runs: hooks configured in package.json, and any change to its scripts (a command with a chain, a pipe or a shell is risky; another change is standard).
  if (name === "package.json") {
    if (patch.added.some((line) => HOOK_CONFIG.test(line) && !removedTrimmed.has(line.trim()))) out.risky.push(reason("install_script"));
    for (const line of patch.added) {
      const script = SCRIPT_LINE.exec(line);
      if (script === null || removedTrimmed.has(line.trim()) || NOT_A_DEPENDENCY_KEY.has(script[1]!.toLowerCase()) || VERSIONISH.test(script[2]!)) continue;
      out.standard.push(reason("script_changed"));
      if (SHELL_LIKE_SCRIPT.test(script[2]!)) out.risky.push(reason("script_command"));
    }
  }
  // A lock entry that now resolves to another package than before (same registry, other name).
  if (lock) {
    const before = new Set(patch.removed.flatMap((line) => RESOLVED_PACKAGE.exec(line)?.[1] ?? []));
    if (patch.added.some((line) => { const target = RESOLVED_PACKAGE.exec(line)?.[1]; return target !== undefined && !before.has(target); })) out.standard.push(reason("lock_package_changed"));
  }
  if (patch.added.some((line) => LIFECYCLE_SCRIPT.test(line) && !removedTrimmed.has(line.trim())) && (name === "package.json" || name === "composer.json")) out.risky.push(reason("install_script"));
  if (patch.added.some((line) => INSTALL_GUARD_WORDS.test(line))) out.risky.push(reason("install_script"));
  if (lock && patch.added.some((line) => /^\s*"hasInstallScript"\s*:\s*true/u.test(line))) out.risky.push(reason("install_script"));
  // A change of where packages come from is a dependency change, whatever the file looks like.
  if (out.risky.some((entry) => entry.code === "registry_source_changed" || entry.code === "dependency_source")) out.kind = true;
  return out;
}

// ---- continuous integration files

const CI_PRIVILEGED = /(?:pull_request_target|workflow_run|issue_comment|pull_request_review(?:_comment)?|\bsecrets\s*\.|\bsecrets\s*\[|\bsecrets\s*:\s*inherit|\$\{\{\s*secrets\b|toJSON\(\s*secrets|github\.token|id-token|\bGITHUB_TOKEN\b|permissions\s*:\s*write-all|:\s*write\b|runs-on\s*:.*self-hosted|\$\{\{\s*(?:github\.event\.(?:comment|issue|pull_request|review|head_commit|pages|commits|discussion)|github\.head_ref)|\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b)/iu;
/** Code fetched and run in CI: a download piped into a shell or an interpreter, process substitution, a registry package run at a moving tag. */
const CI_FETCH_AND_RUN = /\b(?:curl|wget|fetch)\b[^|\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k|fi)?sh|python[\d.]*|perl|ruby|node|php|pwsh|powershell)\b|<\(\s*(?:curl|wget)\b|\beval\s+"?\$\(\s*(?:curl|wget)|\b(?:iex|Invoke-Expression)\b.*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/iu;
const CI_RUNS_REGISTRY_CODE = /\b(?:npx|bunx|pnpx|uvx|pipx\s+run|yarn\s+dlx|pnpm\s+dlx|npm\s+exec)\s+(?:-\S+\s+)*[\w@./-]*@(?:latest|next|canary|beta|alpha|rc|dev|\*|[a-z][\w.-]*)\b/iu;
/** Data sent out of the job: a raw socket, an upload with curl or wget. */
const CI_NET_EXFIL = /\b(?:nc|ncat|netcat|socat)\s+\S+|\/dev\/(?:tcp|udp)\/|\bcurl\b[^\n]*\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|-X\s*(?:POST|PUT))\b|\bwget\b[^\n]*--(?:post-data|post-file|body-data)/iu;
/** A command that runs the project's tests. */
const TEST_COMMAND = /\b(?:npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+(?:run\s+)?test|vitest|jest|mocha|pytest|py\.test|tox|nox|go\s+test|cargo\s+(?:test|nextest)|mvn\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|make\s+(?:test|check)|rspec|phpunit|dotnet\s+test|ctest)\b/iu;
/** What a CI change does that no line of it says plainly: fetches and runs code, sends data out, or takes a test command away. */
function ciDangerous(added: readonly string[], removed: readonly string[]): string | undefined {
  if (added.some((line) => CI_FETCH_AND_RUN.test(line) || CI_RUNS_REGISTRY_CODE.test(line))) return "ci_fetch_and_run";
  if (added.some((line) => CI_NET_EXFIL.test(line))) return "ci_net_send";
  if (removed.filter((line) => TEST_COMMAND.test(line)).length > added.filter((line) => TEST_COMMAND.test(line)).length) return "ci_check_removed";
  return undefined;
}

/** A step that uses an action from someone else, pinned to a branch or a tag (both can be moved) instead of a commit. The owner `actions` and `github` are the platform's own. */
function movingActions(added: readonly string[], removed: readonly string[]): boolean {
  const removedTrimmed = new Set(removed.map((line) => line.trim()));
  return added.some((line) => {
    const spec = /^\s*(?:-\s*)?uses\s*:\s*['"]?([^\s'"#]+)/u.exec(line)?.[1];
    if (spec === undefined || removedTrimmed.has(line.trim()) || spec.startsWith("./") || spec.startsWith("docker://")) return false;
    const owner = spec.split("/")[0]!.toLowerCase();
    if (owner === "actions" || owner === "github") return false;
    return !/@[0-9a-f]{40}$/u.test(spec);
  });
}

// ---- one file

interface FileReading {
  risky: TierReason[];
  standard: TierReason[];
  /** Notes that do not raise the tier (an `eval_hint` for a product prompt file). */
  hints: TierReason[];
  kinds: Set<TierKind>;
  /** Lines of code the change adds and removes in this file (a document, a lock file and dependency pins are none). */
  codeLines: number;
  /** Counts toward "more than 3 files": every file that is not a document or a lock file. */
  countsAsFile: boolean;
  isCode: boolean;
  isTest: boolean;
  /** Bytes the change adds to this file (not a lock file, not a document). */
  addedBytes?: number;
}

/** Added lines longer than this, or more added bytes than the limit in one file, make a change at least standard (a minified file or a blob hides in few lines). */
export const LONG_LINE_CHARS = 500;
export const ADDED_BYTES_MAX = 8_000;
/** All the bytes a change adds, in every file together. */
export const ADDED_BYTES_TOTAL_MAX = 20_000;

/** Text that looks like a credential: a cloud key id, a platform token, a private key block. A fixture or a config that holds one is risky (a leaked credential, or a test of one that is wrongly real). */
/** Line-ending characters other than the newline the patch is split on. */
const LINE_BREAK_ODD = new RegExp(`[${["\\r", "\\u0085", "\\u2028", "\\u2029", "\\u000B", "\\u000C"].join("")}]`, "u");
const SECRET_LIKE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/u;
/** A line that switches a check off: in a test runner's or scanner's configuration, an exclude, an ignore, a skip, an off, a lowered threshold. */
const WEAKEN_CHECK_LINE = /\b(?:exclude|excludes|ignore|ignored|skips?|skipped|disable|disabled|select|extend-ignore|per-file-ignores|todo|allowFailure|allow_failures?|threshold|testPathIgnorePatterns|continue-on-error|coveragePathIgnorePatterns)\b|['"](?:off|0)['"]|:\s*(?:0|false)\b/iu;
/** A line that silences a linter or a type check, in any file. */
const SILENCE_LINE = /['"]off['"]|\beslint-disable|@ts-(?:ignore|nocheck|expect-error)|#\s*(?:nosec|noqa|type:\s*ignore|pragma:\s*no cover)|\/\/\s*nolint|NOSONAR|#\s*pylint:\s*disable|\/\/\s*@suppress/u;
/** An added line that skips or focuses a test. */
const SKIP_TEST_LINE = /(?:\b(?:it|test|describe|context|specify)(?:\.concurrent)?\.(?:skip|todo|only|fixme)\b|\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(|\.skipIf\s*\(|\bpending\s*\(|@(?:Disabled|Ignore)\b|#\[ignore\]|\bt\.Skip(?:Now)?\s*\(|\bpytest\.mark\.skip|@unittest\.skip|\bskipTest\s*\()/u;
/** A line of a type-check setup that remaps modules or relaxes strictness. */
const TSCONFIG_WEAKEN = /^\s*"[^"]+\/\*"\s*:\s*\[|"paths"\s*:|"strict"\s*:\s*false|"noImplicitAny"\s*:\s*false|"skipLibCheck"\s*:\s*true|"checkJs"\s*:\s*false/u;
/** Words in a changed line that put it in a security rule or test: weakening one of those is risky, not standard. */
const SECURITY_LINE = /\b(?:auth\w*|token\w*|secret\w*|password\w*|crypto\w*|security|redact\w*|permission\w*|csrf|xss|sanitiz\w*|inject\w*|escape\w*|sign(?:in|ature)\w*|session\w*|encrypt\w*|iam|rbac|acl|policy|policies|gosec|bandit|semgrep|codeql|snyk|trivy|gitleaks|brakeman|detekt|hadolint|checkov|b60\d|shell injection)\b/iu;
/** Settings files that hold the configuration of a test runner, a linter or a scanner in a section among other things. */
const TOOL_SECTION = /\[(?:tool\.(?:bandit|ruff|pylint|flake8|mypy|semgrep|coverage|pytest|isort)|bandit|flake8|pylint|coverage|mypy|tool:pytest|testenv)\b/u;
const TOOL_SETTINGS_FILE = /^(?:pyproject\.toml|setup\.cfg|tox\.ini|\.coveragerc)$/u;
/** Words in an added line that address whoever (or whatever) reviews the change: a line written for the reviewer is not code. */
const REVIEWER_INJECTION = /\b(?:note|attention|message|instructions?|hey|hi|dear)\s+(?:for|to)\s+(?:the\s+)?(?:automated\s+|ai\s+|llm\s+|code\s+)?(?:reviewers?|agents?|assistants?|models?|bots?|ai)\b|\b(?:ai|llm|automated)\s+(?:code\s+)?(?:reviewers?|agents?)\b|\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?)|\banswer\s+(?:no|yes)\s+to\s+(?:every|all|each)\b|\bdo\s+not\s+(?:flag|report|mention)\s+this\b|\bsystem\s+prompt\b|\breviewers?\s*[:,-]|\bevery\s+(?:question|answer)\b|\ball\s+(?:\w+\s+)?answers\b|\b(?:end|begin|start)\s+of\s+(?:the\s+)?untrusted\b|-{2,}\s*(?:begin|end)\b.*\b(?:data|patch|files)\b|\buntrusted\s+data\b/iu;
/** Lines of a .gitignore that keep secrets out: taking one away exposes them. */
const SECRET_IGNORE = /\.env|secret|credential|\.pem|\.key\b|id_rsa|\.npmrc|token|\.aws|\.ssh|\.p12|\.pfx|\.kube/iu;
const TSCONFIG_NAME = /^tsconfig[\w.-]*\.json$/u;
const URL_ANYWHERE = /[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/giu;

/** The most characters one path may have: a longer one cannot be listed honestly. */
const PATH_CHARS_MAX = 4_096;

function readFile(file: TierFile, head: HeadFacts | undefined): FileReading {
  const reading: FileReading = { risky: [], standard: [], hints: [], kinds: new Set(), codeLines: 0, countsAsFile: true, isCode: true, isTest: false };
  const here = (code: string): TierReason => ({ code, path: file.path.slice(0, FLOW_REASON_PATH_MAX) });
  const names = [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])];
  const removed = file.status === "removed";

  // Both names of a renamed file count: a file moved out of, or into, a sensitive folder is a change to it. A path with a look-alike letter is never matched on the look-alike: it is risky itself; so is a code path with any
  // letter outside ASCII (no map of look-alikes is complete), and a path too long to list.
  for (const name of names) {
    const normal = normalizedTierPath(name);
    const reasonFor = (code: string): TierReason => ({ code, path: name.slice(0, FLOW_REASON_PATH_MAX) });
    if (hasConfusableLetter(name) || (hasNonAsciiLetter(name) && fileTypeOf(name) !== "prose")) reading.risky.push(reasonFor("confusable_path"));
    if (name.length > PATH_CHARS_MAX) reading.risky.push(reasonFor("path_too_long"));
    // A path with a line break or any control or format character can forge a line of anything that prints it.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) reading.risky.push(reasonFor("path_control_character"));
    if (isHookPath(name)) reading.risky.push(reasonFor("hook_file"));
    if (isInstructionPath(name)) reading.risky.push(reasonFor("instruction_file"));
    else if (isPromptHintPath(name)) reading.hints.push(reasonFor("eval_hint"));
    if (isTierSensitivePath(name)) reading.risky.push(reasonFor("sensitive_path"));
    if (isInfraPath(name)) reading.risky.push(reasonFor("infra_file"));
    if (GIT_SETTINGS_FILES.test(normal)) reading.risky.push(reasonFor("git_settings_file"));
    if (PACKAGE_SOURCE_FILES.test(normal)) reading.risky.push(reasonFor("package_source_setting"));
    if (/(?:^|\/)\.env[^/]*$/u.test(normal)) reading.risky.push(reasonFor("env_file"));
    if (/(?:^|\/)\.(?:docker|npm|helm|cf|gcloud|vercel)ignore$/u.test(normal)) reading.risky.push(reasonFor("ignore_file"));
    if (isScannerIgnorePath(name)) reading.standard.push(reasonFor("scanner_ignore_file"));
    if (isDocsBuildConfigPath(name)) reading.standard.push(reasonFor("docs_build_config"));
    const key = factKey(file.repository, name);
    if (head?.instructionImports?.has(factKey(file.repository, normal)) === true) reading.risky.push(reasonFor("instruction_import"));
    if (head?.links?.has(key) === true) reading.risky.push(reasonFor("symlink_suspected"));
    if (head?.unchecked?.has(key) === true) reading.risky.push(reasonFor("link_kind_unknown"));
  }

  const normalPath = normalizedTierPath(file.path);
  reading.isTest = isTestPath(normalPath);
  // A rename is a delete of the old path plus an add of the new one: what the old path was, it no longer is. A workflow, a scanner's configuration or a test renamed away is a deletion of it.
  if (file.previousPath !== undefined) {
    const old = file.previousPath;
    const oldCi = isCiFilePath(old);
    if (oldCi && !(isCiFilePath(file.path) && /\.ya?ml$/u.test(normalPath))) { reading.kinds.add("ci_file"); reading.risky.push({ code: "ci_file_deleted", path: old.slice(0, FLOW_REASON_PATH_MAX) }); }
    if (isCheckConfigPath(old) && !isCheckConfigPath(file.path)) reading.risky.push({ code: "check_config_deleted", path: old.slice(0, FLOW_REASON_PATH_MAX) });
    if (isTestPath(normalizedTierPath(old)) && !reading.isTest) reading.standard.push({ code: "test_file_deleted", path: old.slice(0, FLOW_REASON_PATH_MAX) });
    else if (fileTypeOf(old) === "code" && fileTypeOf(file.path) !== "code") reading.standard.push({ code: "code_file_deleted", path: old.slice(0, FLOW_REASON_PATH_MAX) });
  }

  // A document is plain docs only when every name of it is on the docs route, and when it is known that no instruction file reads it.
  const prose = isDocsPath(file.path) && (file.previousPath === undefined || isDocsPath(file.previousPath)) && head?.importsKnown !== false;
  const proseFile = fileTypeOf(file.path) === "prose";
  const ci = isCiFilePath(file.path) || (file.previousPath !== undefined && isCiFilePath(file.previousPath));
  const lock = isLockfile(normalPath);
  const manifest = isManifest(normalPath);

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
      // A symlink's content is its target: one or two lines, each a path (a slash, or no spaces), with no final newline. A host's patch does not say the mode, so this is read from the shape; `links` is what the host says.
      const looksLikePath = (line: string): boolean => line.includes("/") || line.startsWith(".") || !/\s/u.test(line);
      if (patch.contentLines > 0 && patch.contentLines <= 2 && patch.noEolMarkers >= patch.contentLines && [...patch.added, ...patch.removed].every(looksLikePath)) reading.risky.push(here("symlink_suspected"));
    }
  }
  const hostLines = file.additions + file.deletions;

  if (removed) {
    // A deleted file is a loss, never a gain. A deleted CI file, or a test runner's or scanner's configuration, changes what is checked (risky). A deleted test or code file is at least standard. A deleted document stays a document change.
    if (ci) { reading.kinds.add("ci_file"); reading.risky.push(here("ci_file_deleted")); reading.codeLines = hostLines; return reading; }
    if (isCheckConfigPath(file.path)) { reading.kinds.add("code_config"); reading.risky.push(here("check_config_deleted")); reading.codeLines = hostLines; return reading; }
    if (prose || proseFile) { reading.kinds.add(prose ? "docs" : "code_config"); reading.codeLines = prose ? 0 : hostLines; reading.countsAsFile = !prose; reading.isCode = !prose; if (proseFile && !prose) reading.standard.push(here("code_file_deleted")); return reading; }
    reading.standard.push(here(reading.isTest ? "test_file_deleted" : "code_file_deleted"));
    reading.kinds.add("code_config");
    reading.codeLines = lock ? 0 : hostLines;
    reading.countsAsFile = !lock;
    reading.isCode = !lock;
    return reading;
  }

  // The docs route is an allowlist on content: plain prose only, in a repository that builds no documentation site, in a document no instruction file reads (`prose`), and not a rewrite. Anything else is not docs.
  let routed = false;
  if (prose && patch !== undefined) {
    // Text written for whoever reviews it, a credential, a word of mixed scripts: none of these is documentation, whatever route the lines take.
    if (patch.added.some((line) => REVIEWER_INJECTION.test(line))) reading.risky.push(here("reviewer_injection_text"));
    if (patch.added.some((line) => SECRET_LIKE.test(line))) reading.risky.push(here("secret_like_text"));
    if (patch.added.some((line) => hasMixedScriptWord(line))) reading.risky.push(here("confusable_text"));
    reading.addedBytes = patch.added.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    const problem = docsContentProblem(file.patch!, head?.text?.get(factKey(file.repository, file.path)), head !== undefined);
    if (problem?.problem === "executes") reading.risky.push(here("docs_executes"));
    else if (problem?.problem === "include") reading.standard.push(here("docs_include"));
    else if (problem?.problem === "not_plain") reading.standard.push(here("docs_not_plain"));
    else if (problem?.problem === "unread") reading.standard.push(here("docs_unread"));
    if (head?.docsSite === true) reading.standard.push(here("docs_site_build"));
    if (hostLines > DOCS_ROUTE_LINES_MAX) reading.standard.push(here("docs_large"));
    routed = problem === undefined && head?.docsSite !== true && hostLines <= DOCS_ROUTE_LINES_MAX;
  } else if (prose) routed = true;
  if (routed) {
    reading.kinds.add("docs");
    reading.isCode = false;
    reading.countsAsFile = false;
    if (patch === undefined) {
      // A document whose text cannot be read cannot be cleared of a changed link or command: at least install_link (and it is already risky unless it is a pure rename).
      if (!pureRename) reading.kinds.add("install_link");
    } else if (documentChangesLink(file.patch!, head?.text?.get(factKey(file.repository, file.path)))) reading.kinds.add("install_link");
    return reading;
  }
  if (prose && patch !== undefined && documentChangesLink(file.patch!, head?.text?.get(factKey(file.repository, file.path)))) reading.kinds.add("install_link");
  // A document that is not on the docs route is read as one (its size is the docs rule's, not a count of code).
  const proseOffRoute = prose && patch !== undefined;

  // The host's own counts, and never fewer than the text shows.
  reading.codeLines = Math.max(hostLines, patch === undefined ? 0 : patch.added.length + patch.removed.length);
  if (proseOffRoute) { reading.codeLines = 0; reading.isCode = false; reading.countsAsFile = false; }
  if (lock) {
    reading.isCode = false;
    reading.countsAsFile = false;
    reading.codeLines = 0;
  }

  // A file type the rules do not know (an unknown extension or dot file) is never small: nobody has said what it does. A plain text file that is not a dependency list is data a program may read.
  if (fileTypeOf(file.path) === "unknown" && !ci) reading.standard.push(here("unrecognised_file_type"));
  if (/\.txt$/u.test(normalPath) && !manifest) reading.standard.push(here("text_data_file"));
  if (isVendored(file.path)) { reading.standard.push(here("vendored_code")); reading.kinds.add("dependency"); }

  if (patch !== undefined) {
    if (manifest || lock) {
      const deps = readDependencies(file, patch);
      if (deps.kind) reading.kinds.add("dependency");
      reading.risky.push(...deps.risky);
      reading.standard.push(...deps.standard);
      if (deps.newDependencies.length > 0) reading.standard.push(here("new_dependency"));
      if (deps.lockNotUnderstood) reading.standard.push(here("lockfile_not_understood"));
      reading.codeLines = lock ? 0 : Math.max(0, reading.codeLines - deps.dependencyLines);
      if (manifest && reading.codeLines > 0) reading.kinds.add("code_config");
    }
    // A package manager pointed at another source. In real source code only the command-line forms count.
    const changed = [...patch.added, ...patch.removed];
    const inConfig = CONFIG_FILE.test(normalPath) || manifest || lock || isRequirementsFile(normalPath);
    const sourceWord = fileTypeOf(file.path) === "code" && !SHELL_LIKE.test(normalPath) ? SOURCE_WORD_IN_CODE : SOURCE_WORD;
    if (changed.some((line) => sourceWord.test(line)) || (inConfig && changed.some((line) => SOURCE_WORD_IN_CONFIG.test(line)))) reading.risky.push(here("package_source_setting"));
    if (!manifest && !lock && patch.added.some((line) => INSTALL_GUARD_WORDS.test(line)) && inConfig) reading.risky.push(here("install_script"));
    if (ci && patch.added.some((line) => CI_PRIVILEGED.test(line))) reading.risky.push(here("ci_privileged"));
    if (ci && movingActions(patch.added, patch.removed)) reading.risky.push(here("ci_unpinned_action"));
    const ciCode = ci ? ciDangerous(patch.added, patch.removed) : undefined;
    if (ciCode !== undefined) reading.risky.push(here(ciCode));
    // A check weakened without a deletion: an exclude or an off in a runner's or scanner's configuration, a silenced linter, a skipped test, a remapped module. Standard; risky when the line is about a security rule or test.
    const toolSettings = TOOL_SETTINGS_FILE.test(baseName(normalPath)) && TOOL_SECTION.test(file.patch!);
    const removedSecurity = isCheckConfigPath(file.path) ? patch.removed.filter((line) => SECURITY_LINE.test(line) && !patch.added.includes(line)) : [];
    const weakened = [
      ...(isCheckConfigPath(file.path) || toolSettings ? patch.added.filter((line) => WEAKEN_CHECK_LINE.test(line)) : []),
      ...removedSecurity,
      ...(TSCONFIG_NAME.test(baseName(normalPath)) ? patch.added.filter((line) => TSCONFIG_WEAKEN.test(line)) : []),
      ...(reading.isTest ? patch.added.filter((line) => SKIP_TEST_LINE.test(line)) : []),
      ...patch.added.filter((line) => SILENCE_LINE.test(line)),
    ];
    if (weakened.length > 0) {
      reading.standard.push(here("check_weakened"));
      if (weakened.some((line) => SECURITY_LINE.test(line)) || (reading.isTest && isTierSensitivePath(file.path)) || ((isCheckConfigPath(file.path) || toolSettings) && SECURITY_LINE.test(file.patch!))) reading.risky.push(here("check_weakened_security"));
    }
    // Content that is not what it looks like: reordering controls, a word that mixes scripts, a line written for the reviewer. None has a place in code or configuration.
    if (patch.added.some((line) => BIDI_CONTROL.test(line))) reading.risky.push(here("bidi_control"));
    // Any format character (zero-width, soft hyphen, the Unicode tag block models read and people do not): invisible text has no place in code.
    if (patch.added.some((line) => /\p{Cf}/u.test(line))) reading.risky.push(here("invisible_character"));
    // Characters that end a line for some readers and not for others (a lone carriage return, next line, line and paragraph separators, vertical tab, form feed): code that reads one way and runs another.
    if (patch.added.some((line) => LINE_BREAK_ODD.test(line))) reading.risky.push(here("line_break_character"));
    if (patch.added.some((line) => hasMixedScriptWord(line))) reading.risky.push(here("confusable_text"));
    if (patch.added.some((line) => REVIEWER_INJECTION.test(line))) reading.risky.push(here("reviewer_injection_text"));
    // A .gitignore that lets go of a secret pattern; a documentation build's hooks and plugins run code.
    if (baseName(normalPath) === ".gitignore" && (patch.removed.some((line) => SECRET_IGNORE.test(line)) || patch.added.some((line) => /^\s*!/u.test(line) && SECRET_IGNORE.test(line)))) reading.standard.push(here("ignore_file"));
    if (isDocsBuildConfigPath(file.path) && patch.added.some((line) => /\bhooks?\b|\bexec\b|subprocess|os\.system|\bplugins?\b|\beval\b/u.test(line))) reading.risky.push(here("docs_build_hook"));
    // Text that looks like a credential, in any file that is not a document.
    if (patch.added.some((line) => SECRET_LIKE.test(line))) reading.risky.push(here("secret_like_text"));
    // Size by bytes as well as lines: a long line or a large added blob hides in few lines, and the total counts per file. Lock files are generated.
    const addedBytes = patch.added.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    if (!lock && (patch.added.some((line) => line.length > LONG_LINE_CHARS) || addedBytes > ADDED_BYTES_MAX)) reading.standard.push(here("long_lines"));
    reading.addedBytes = lock ? 0 : addedBytes;
    // A link changed in a configuration file (a funding page, a homepage, a feed): the old and the new side by side.
    if (fileTypeOf(file.path) === "config" && !lock && !manifest && !ci) {
      const before = new Set(patch.removed.flatMap((line) => line.match(URL_ANYWHERE) ?? []));
      if (patch.added.some((line) => (line.match(URL_ANYWHERE) ?? []).some((url) => !before.has(url)))) reading.kinds.add("install_link");
    }
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

/**
 * The reasons cut to a limit, keeping the `eval_hint` whatever the limit does to the rest: the evaluation check relies on it, and a busy tier (many risky reasons) must still carry it. The hint goes last; the others keep their order.
 */
export function capReasons(reasons: readonly TierReason[], limit: number): TierReason[] {
  const hint = reasons.find((reason) => reason.code === "eval_hint");
  if (hint === undefined) return reasons.slice(0, Math.max(0, limit));
  return [...reasons.filter((reason) => reason.code !== "eval_hint").slice(0, Math.max(0, limit - 1)), hint];
}

function collect(reasons: readonly TierReason[]): TierReason[] {
  const seen = new Set<string>();
  const unique: TierReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}\u0000${reason.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reason);
  }
  return capReasons(unique, FLOW_TIER_REASONS_MAX);
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
  const hints: TierReason[] = [];
  const kinds = new Set<TierKind>();
  if (!input.complete) risky.push(withoutPath("incomplete_diff"));
  if (input.files.length === 0) risky.push(withoutPath("no_diff_files"));
  if (input.files.length >= CHANGED_FILES_MAX) risky.push(withoutPath("too_many_files"));
  let lines = 0;
  let files = 0;
  let bytes = 0;
  let api: string | undefined;
  const modules = new Set<string>();
  const testModules = new Set<string>();
  for (const file of input.files) {
    const reading = readFile(file, context.head);
    risky.push(...reading.risky);
    standard.push(...reading.standard);
    hints.push(...reading.hints);
    for (const kind of reading.kinds) kinds.add(kind);
    lines += reading.codeLines;
    bytes += reading.addedBytes ?? 0;
    if (reading.countsAsFile) files += 1;
    if (reading.isCode) {
      const key = `${file.repository ?? ""}:${moduleOf(file.path)}`;
      (reading.isTest ? testModules : modules).add(key);
    }
    if ((file.apiShapeChanged === true || (isApiShapePath(file.path) && file.additions + file.deletions > 0 && file.status !== "renamed")) && api === undefined) api = file.path;
  }
  if (lines > limits.riskyLines) risky.push(withoutPath("large_change"));
  if (lines > limits.standardLines) standard.push(withoutPath("more_than_lines"));
  if (files > limits.standardFiles) standard.push(withoutPath("more_than_files"));
  if (bytes > ADDED_BYTES_TOTAL_MAX) standard.push(withoutPath("long_lines"));
  // Tests belong to the module they test: they add a module only when nothing else is changed.
  const moduleCount = (modules.size > 0 ? modules : testModules).size;
  if (moduleCount >= 2) standard.push(withoutPath("two_or_more_modules"));
  if (api !== undefined) standard.push({ code: "api_change", path: api.slice(0, FLOW_REASON_PATH_MAX) });
  const level: TierLevel = risky.length > 0 ? "risky" : standard.length > 0 ? "standard" : "small";
  return {
    level, kinds: [...kinds].sort(), source: "diff", reasons: collect([...risky, ...standard, ...hints]),
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
  const hints: TierReason[] = [];
  const kinds = new Set<TierKind>();
  if (paths.length === 0) standard.push(withoutPath("no_files_named"));
  let files = 0;
  const modules = new Set<string>();
  const testModules = new Set<string>();
  for (const path of paths) {
    const normal = normalizedTierPath(path);
    const reasonFor = (code: string): TierReason => ({ code, path: path.slice(0, FLOW_REASON_PATH_MAX) });
    if (hasConfusableLetter(path)) risky.push(reasonFor("confusable_path"));
    if (isHookPath(path)) risky.push(reasonFor("hook_file"));
    if (isInstructionPath(path)) risky.push(reasonFor("instruction_file"));
    else if (isPromptHintPath(path)) hints.push(reasonFor("eval_hint"));
    if (isTierSensitivePath(path)) risky.push(reasonFor("sensitive_path"));
    if (isInfraPath(path)) risky.push(reasonFor("infra_file"));
    if (GIT_SETTINGS_FILES.test(normal)) risky.push(reasonFor("git_settings_file"));
    if (PACKAGE_SOURCE_FILES.test(normal)) risky.push(reasonFor("package_source_setting"));
    if (/(?:^|\/)\.env[^/]*$/u.test(normal)) risky.push(reasonFor("env_file"));
    if (isDocsPath(path)) { kinds.add("docs"); continue; }
    if (isLockfile(normal)) { kinds.add("dependency"); continue; }
    files += 1;
    if (fileTypeOf(path) === "unknown" && !isCiFilePath(path)) standard.push(reasonFor("unrecognised_file_type"));
    if (isApiShapePath(path)) standard.push(reasonFor("api_change"));
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
  return { level, kinds: [...kinds].sort(), source: "estimate", reasons: collect([...risky, ...standard, ...hints]), ...(context.headSha === undefined ? {} : { headSha: context.headSha }), at: context.at };
}

// ---- only up

/**
 * The tier after a new one is computed: it never goes down. A new tier that is lower keeps the higher level, the kinds and the reasons already recorded (the new head and merge base are the ones it is bound to).
 * An ESTIMATE is only a forecast, so the first real diff replaces it, whatever its level; every tier after that only goes up.
 */
export function raiseTier(previous: ChangeTier | undefined, next: ChangeTier): ChangeTier {
  // A forecast is replaced by the first real tier, unless a reviewer has already raised it: what the reviewer's questions found stays (the tier's source has no value for it, so its reasons say so).
  if (previous === undefined || (previous.source === "estimate" && !previous.reasons.some((reason) => reason.code.startsWith("reviewer_")))) return next;
  const kinds = [...new Set([...previous.kinds, ...next.kinds])].sort();
  // The higher level keeps its own reasons first: they say why the tier is where it is.
  return RANK[next.level] >= RANK[previous.level]
    ? { ...next, kinds, reasons: collect([...next.reasons, ...previous.reasons]) }
    : { ...next, level: previous.level, kinds, reasons: collect([...previous.reasons, ...next.reasons]) };
}

/**
 * The tier the planning steps were chosen at, when some were skipped: the first estimate on the record (or the level skipped steps are only ever skipped at, small, when none is kept). Undefined when no planning step was skipped:
 * the whole plan ran, so nothing was chosen at a lower tier than the change has now.
 */
export function planningLevelOf(flow: WorkflowFlow | undefined): TierLevel | undefined {
  if (flow === undefined || flow.skippedSteps === undefined || flow.skippedSteps.length === 0) return undefined;
  const estimate = [...(flow.tierHistory ?? []), ...(flow.tier === undefined ? [] : [flow.tier])].find((tier) => tier.source === "estimate");
  return estimate?.level ?? "small";
}

/** Whether `fresh` is a higher level than the level an approval was given at. */
export const tierGrew = (approvedAt: TierLevel, fresh: Pick<ChangeTier, "level">): boolean => RANK[fresh.level] > RANK[approvedAt];

// ---- the planned-path limit

/** A path as the plan limit compares it: exactly (case matters on the systems code runs on), with `\\` read as `/` and no leading `./`. */
const planPath = (path: string): string => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");

/** The paths a change touches that the plan did not name. A planned entry ending in `/` covers everything under it. A lock file is covered when its manifest's folder has a planned manifest. Case-sensitive. */
export function plannedPathsExceeded(planned: readonly string[], changed: ReadonlyArray<string | { path: string; previousPath?: string | undefined }>): string[] {
  const plan = planned.map(planPath);
  const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
  const covered = (path: string): boolean => {
    const exact = planPath(path);
    if (plan.some((entry) => entry === exact || (entry.endsWith("/") && exact.startsWith(entry)))) return true;
    if (isLockfile(exact.toLowerCase())) return plan.some((entry) => isManifest(entry.toLowerCase()) && folderOf(entry) === folderOf(exact));
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
  confusable_path: "a path with a look-alike letter", infra_file: "an infrastructure file", instruction_import: "a file an instruction file reads", ci_unpinned_action: "a CI action that is not pinned to a commit",
  path_too_long: "a path too long to list", link_kind_unknown: "a path whose kind Rovara did not check", ignore_file: "an ignore file", secret_like_text: "text that looks like a credential", script_command: "a script that runs a command", check_weakened_security: "a security check weakened",
  eval_hint: "a prompt file that needs the evaluation check", line_break_character: "a line-ending character that reads differently by reader", path_control_character: "a control character in a file name",
  ci_fetch_and_run: "a CI step that fetches code and runs it", ci_net_send: "a CI step that sends data out", ci_check_removed: "a CI step that no longer runs the tests", invisible_character: "invisible text",
  docs_executes: "a document line that runs something", bidi_control: "text that reorders what is shown", confusable_text: "a word that mixes look-alike letters", reviewer_injection_text: "a line written for the reviewer", docs_build_hook: "a hook of a documentation build",
  docs_not_plain: "a document line that is not plain prose", docs_unread: "a document Rovara could not read in full", docs_site_build: "a document of a site that is built", docs_large: "more than 300 changed document lines", scanner_ignore_file: "a file that tells a scanner what to skip", docs_build_config: "the setup of a documentation build",
  script_changed: "a changed script", text_data_file: "a text file a program may read", vendored_code: "vendored code", check_weakened: "a check switched off", docs_include: "a document that includes another file",
  ci_file_deleted: "a deleted CI file", check_config_deleted: "a deleted test or scanner setting", test_file_deleted: "a deleted test", unrecognised_file_type: "a kind of file Rovara does not know", long_lines: "very long lines or a large amount of text",
  package_alias: "a package under another name", lock_package_changed: "a different package in a lock file",
  hook_file: "a git hook", instruction_file: "an instruction file", sensitive_path: "a sensitive path", git_settings_file: "a git settings file", env_file: "an environment file",
};

/** What grew, in one plain phrase: the first reason that put the tier at its level, with its path when it has one. `shown` makes the path safe to print (the caller's inert-text function). */
export function tierGrowthPhrase(tier: Pick<ChangeTier, "level" | "reasons">, shown: (path: string) => string): string {
  const top = tier.reasons[0];
  if (top === undefined) return "something Rovara could not check";
  const phrase = REASON_PHRASES[top.code] ?? (top.code.startsWith("reviewer_") ? "something the reviewer flagged" : "something that needs more checks");
  return top.path === undefined ? phrase : `${phrase} (${shown(top.path)})`;
}

/** The sentence a merge is refused with when the change grew after the approvals were given. */
export function tierGrowthSentence(tier: Pick<ChangeTier, "level" | "reasons">, shown: (path: string) => string): string {
  return `This change now touches ${tierGrowthPhrase(tier, shown)}, so it needs ${tier.level} checks.`;
}

// ---- the record on the workflow


const compactTier = (tier: ChangeTier, reasons: number, pathMax: number): ChangeTier => ({
  ...tier, reasons: capReasons(tier.reasons, Math.max(reasons, tier.reasons.some((reason) => reason.code === "eval_hint") ? 1 : 0)).map((reason) => (reason.path === undefined ? reason : { ...reason, path: reason.path.slice(0, pathMax) })),
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

// ---- the records the review steps and the reviewer floor leave

/**
 * What the review steps and the reviewer floor leave on the record is bound to the FULL head, in `flow.quickChecks` (its `detail` holds the head in full: a catch-counter step is too short for one, and a prefix of a head is not
 * a head). One entry for the reviewer's questions (head and a digest of the patch the reviewer was given), and one per tier for the review steps (head). A new record of the same kind replaces the one before it.
 */
/** The kind the records carry (the contract has no kind of its own for them): a record counts only with this kind, outcome "passed" and its prefix. */
const RECORD_KIND = "code_config" as const;
const isRecord = (check: { kind: string; outcome: string; detail?: string | undefined }, detail: string): boolean => check.kind === RECORD_KIND && check.outcome === "passed" && check.detail === detail;
const QUESTIONS_PREFIX = "tier_questions ";
const REVIEW_PREFIX = "tier_review ";
const questionsDetail = (headSha: string, patchDigest: string): string => `${QUESTIONS_PREFIX}head=${headSha} patch=${patchDigest}`;
const reviewDetail = (level: TierLevel, headSha: string): string => `${REVIEW_PREFIX}level=${level} head=${headSha}`;

function withQuickCheck(flow: WorkflowFlow | undefined, prefix: string, detail: string, at: string, replaces: (detail: string) => boolean): WorkflowFlow {
  const kept = (flow?.quickChecks ?? []).filter((check) => !(check.detail?.startsWith(prefix) === true && replaces(check.detail)));
  return fitFlow({ ...(flow ?? { rulesVersion: TIER_RULES_VERSION }), rulesVersion: TIER_RULES_VERSION, quickChecks: [...kept, { kind: RECORD_KIND, outcome: "passed" as const, detail, at }].slice(-10) });
}

/** The `flow` record with the review of a tier written for the head it ran on (in full): findings, and how many must be fixed. Without a head nothing is bound, and nothing is written. */
export function recordTierReview(flow: WorkflowFlow | undefined, input: { level: TierLevel; headSha: string | undefined; findings: number; mustFix: number; at?: string }): WorkflowFlow {
  const counted = recordCatch(flow, { step: `tier_review_${input.level}`, findings: input.findings, mustFix: input.mustFix });
  if (input.headSha === undefined) return counted;
  return withQuickCheck(counted, REVIEW_PREFIX, reviewDetail(input.level, input.headSha), input.at ?? new Date().toISOString(), (detail) => detail.startsWith(`${REVIEW_PREFIX}level=${input.level} `));
}

/** Whether a review at `level`, or a higher one, has run on exactly this head. Without a head nothing can have. */
export function tierReviewRecorded(flow: WorkflowFlow | undefined, level: TierLevel, headSha: string | undefined): boolean {
  if (headSha === undefined) return false;
  return (["small", "standard", "risky"] as const).some((candidate) => RANK[candidate] >= RANK[level] && (flow?.quickChecks ?? []).some((check) => isRecord(check, reviewDetail(candidate, headSha))));
}

/** The `flow` record with the reviewer's questions written for exactly this head and the patch the reviewer was given (a digest). */
export function recordQuestionsAnswered(flow: WorkflowFlow | undefined, input: { headSha: string; patchDigest: string; at: string }): WorkflowFlow {
  return withQuickCheck(flow, QUESTIONS_PREFIX, questionsDetail(input.headSha, input.patchDigest), input.at, () => true);
}

/** Whether the reviewer's questions were answered for exactly this head and exactly this patch. Without a head nothing can have been. */
export const reviewerFloorRecorded = (flow: WorkflowFlow | undefined, headSha: string | undefined, patchDigest: string): boolean =>
  headSha !== undefined && (flow?.quickChecks ?? []).some((check) => isRecord(check, questionsDetail(headSha, patchDigest)));

/**
 * Whether a tier still owes the reviewer's questions: EVERY small tier, whatever it touched (code, documents, CI, dependencies). Every list of words and paths leaks, so a change that no list put higher is asked of the one
 * strongest-available reviewer before it merges (the merge gate refuses it until the answers are on the record for the current head and patch), when planning steps were skipped (`skippedPlanning`).
 */
export const needsReviewerFloor = (tier: Pick<ChangeTier, "level">): boolean => tier.level === "small";

/**
 * Whether the lighter flow actually skipped planning steps for the task (P2 writes `skippedSteps`). The reviewer's questions stand in for the review those steps would have given, so they are owed ONLY then: a task that
 * ran the whole plan (today's flow, and the laptop's) is not asked for them, and the growth and risky-review rules apply to it as before.
 */
export const skippedPlanning = (flow: WorkflowFlow | undefined): boolean => (flow?.skippedSteps?.length ?? 0) > 0;

/** A digest of the patch text of a change as the code host lists it, in the form the reviewer is given (`canonicalPatchText`): the floor records it and the merge gate recomputes it from the host. */
export function patchDigestOf(patchText: string): string {
  return createHash("sha256").update(patchText).digest("hex");
}

/** The patch of a change in ONE canonical form: files in repository and path order, each with its name(s) and its patch text. The floor's reviewer is given exactly this, and the gate digests exactly this. */
export function canonicalPatchText(files: readonly TierFile[]): string {
  // JSON, so no path or patch can forge a header line, and a rename is two named fields.
  return JSON.stringify([...files].sort((left, right) => `${left.repository ?? ""}\u0000${left.path}`.localeCompare(`${right.repository ?? ""}\u0000${right.path}`))
    .map((file) => ({ repository: file.repository ?? null, path: file.path, previousPath: file.previousPath ?? null, status: file.status, patch: file.patch ?? null })));
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
