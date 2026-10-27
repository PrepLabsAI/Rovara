import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AgentXNameSchema, RelativeWorkspacePathSchema, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, agentXError } from "@agentx/contracts";
import { inertContextText } from "./context-text.js";
import type { PreparationManifest } from "./prepare.js";
import { readVerifiedBaseRuleFile, type BaseRuleFile } from "./trusted-base-objects.js";

// Pi discovers these names in its working directory, in the directories above it, and in the
// agent directory. The worker runs Pi at the workspace root, so the repositories checked out
// below it are never reached; the worker loads their context files itself, in Pi's own order.
export const REPOSITORY_CONTEXT_FILE_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

export const MAX_REPOSITORY_CONTEXT_FILE_BYTES = 65_536;

export interface WorkspaceRepositoryReference {
  name: string;
  path: string;
  /**
   * The commit a base-commit read uses. It comes from the caller (the broker's base for the task), never from the
   * preparation manifest, which the agent can write; absent means the repository has no trusted base.
   */
  baseCommit?: string;
}

/** Where a repository's rule file is read from: the checked-out files, or the commit the task started from (A5). */
export interface RepositoryContextOptions {
  at?: "working-tree" | "base-commit";
}

export interface RepositoryContextFile {
  path: string;
  content: string;
}

export interface RepositoryContextFiles {
  files: RepositoryContextFile[];
  diagnostics: string[];
  /** With `at: "base-commit"`: one fixed line for each repository whose working-tree rule file differs from the base commit's. */
  notices: string[];
}

/** The prepared repositories, or none when the workspace has no readable manifest. */
export async function readPreparedRepositories(
  rootPath: string,
): Promise<WorkspaceRepositoryReference[]> {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8"),
    ) as PreparationManifest;
    if (!Array.isArray(manifest.repositories)) return [];
    return manifest.repositories
      .filter((repository) => typeof repository?.name === "string" && typeof repository?.path === "string")
      .map(({ name, path }) => ({ name, path }));
  } catch {
    return [];
  }
}

/**
 * Loads each repository's own context file, labelled with the repository it belongs to. A
 * repository without one contributes nothing; a file that escapes its repository or exceeds
 * the size cap is skipped with a diagnostic. Hidden characters are removed from what is loaded
 * (A4). With `at: "base-commit"` the file is read from the repository's recorded commit, never
 * from the working tree (A5): without a commit a repository contributes no file, and a commit that cannot be verified
 * against its own ids stops the load (see {@link isRuleFilesUnverified}).
 */
export async function loadRepositoryContextFiles(
  rootPath: string,
  repositories: readonly WorkspaceRepositoryReference[],
  options: RepositoryContextOptions = {},
): Promise<RepositoryContextFiles> {
  const atBase = options.at === "base-commit";
  const canonicalRoot = await realpath(resolve(rootPath)).catch(() => resolve(rootPath));
  const files: RepositoryContextFile[] = [];
  const diagnostics: string[] = [];
  const notices: string[] = [];
  for (const repository of repositories) {
    // The name and path reach the model (labels, the review note); an entry settings would refuse reaches nothing.
    if (!AgentXNameSchema.safeParse(repository.name).success) {
      diagnostics.push(INVALID_REPOSITORY_DIAGNOSTIC);
      continue;
    }
    const located = await locateRepository(canonicalRoot, repository);
    if (located.diagnostic) {
      diagnostics.push(located.diagnostic);
      continue;
    }
    if (!RelativeWorkspacePathSchema.safeParse(repository.path).success) {
      diagnostics.push(INVALID_REPOSITORY_DIAGNOSTIC);
      continue;
    }
    if (!located.directory) continue;
    const read = atBase
      ? await readBaseCommitRuleFile(located.directory, repository, canonicalRoot)
      : await readWorkingTreeRuleFile(located.directory, repository);
    if (read.diagnostic) diagnostics.push(read.diagnostic);
    if (read.raw) {
      const { text, removed } = inertContextText(read.raw.content);
      files.push({
        path: read.raw.path,
        content: labelledContent(repository, read.raw.candidate, text),
      });
      if (removed > 0) diagnostics.push(`removed ${removed} hidden characters from ${read.raw.candidate} of ${repository.name}`);
    }
    if (atBase && read.usable) {
      const working = await readWorkingTreeRuleFile(located.directory, repository);
      if (ruleFileSignature(read) !== ruleFileSignature(working)) {
        const edited = working.raw?.candidate ?? working.skipped ?? read.raw?.candidate ?? read.skipped;
        if (edited !== undefined) notices.push(`This change edits ${edited} of ${inert(repository.name)}. Review that edit as code; the rules above are the ones from before the change.`);
      }
    }
  }
  return { files, diagnostics, notices };
}

const INVALID_REPOSITORY_DIAGNOSTIC = "skipped a repository context file: its name or path is not valid";

/** Names the note that tells a reviewer its change edits a rule file; AgentX's own, never a file inside a repository. */
export const REVIEW_NOTE_PATH = "AgentX review note";

/** The reviewer's one fixed line per edited rule file, as a context file; none when no rule file was edited. */
export function ruleFileEditNote(notices: readonly string[]): RepositoryContextFile | undefined {
  if (notices.length === 0) return undefined;
  return { path: REVIEW_NOTE_PATH, content: ["AgentX review note (written by AgentX, not by any repository):", ...notices].join("\n") };
}

/** Names AgentX's workspace note, so it is never mistaken for a file inside a repository. */
export const WORKSPACE_NOTE_PATH = "AgentX workspace";

/**
 * AgentX's own note of where each prepared repository is checked out. Pi runs at the workspace
 * root, and a repository without a context file otherwise gives the model no hint of its path
 * (#155). Only the name and path the manifest records reach the note, encoded as data so
 * neither can add a line of its own. An entry project settings would refuse, as in a tampered
 * manifest, is left out.
 */
export function workspaceRepositoriesNote(
  repositories: readonly WorkspaceRepositoryReference[],
): RepositoryContextFile | undefined {
  const listed = repositories.filter(
    ({ name, path }) =>
      AgentXNameSchema.safeParse(name).success && RelativeWorkspacePathSchema.safeParse(path).success,
  );
  const [only] = listed;
  if (!only) return undefined;
  const lines =
    listed.length === 1
      ? [
          `${checkedOut(only)} Make every change inside it; files outside it are not part of the repository or its pull request.`,
        ]
      : [
          ...listed.map(checkedOut),
          "Make each change inside the repository it belongs to; files outside them are not part of any repository or its pull request.",
        ];
  return {
    path: WORKSPACE_NOTE_PATH,
    content: ["AgentX workspace note (written by AgentX, not by any repository):", ...lines].join("\n"),
  };
}

function checkedOut({ name, path }: WorkspaceRepositoryReference): string {
  return `The repository ${quoted(inertContextText(name).text)} is checked out at ${inert(path)} in this workspace.`;
}

/**
 * Appends the repository context files to the ones Pi's resource loader already discovered (its agent directory, the
 * working directory and the directories above it), which are kept without hidden characters. With `onlyOurs` they are
 * left out instead: a reviewer reads only AgentX's own files, because Pi's discovery reads the working tree, where a
 * coding session can write an AGENTS.md that no diff shows.
 */
export function appendRepositoryContextFiles(
  files: readonly RepositoryContextFile[],
  options: { onlyOurs?: boolean } = {},
): (base: { agentsFiles: RepositoryContextFile[] }) => { agentsFiles: RepositoryContextFile[] } {
  return (base) => ({
    agentsFiles: [
      ...(options.onlyOurs === true ? [] : base.agentsFiles.map((file) => ({ ...file, content: inertContextText(file.content).text }))),
      ...files,
    ],
  });
}

/** A rule file as read, before hidden characters are removed. */
interface RuleFileRead {
  raw?: { candidate: string; path: string; content: string };
  diagnostic?: string;
  /** The candidate that was found but could not be loaded (it escapes, is too large, or is a link). */
  skipped?: string;
  /** Base commit reads only: the commit could be read, so the result can be compared with the working tree. */
  usable?: boolean;
}

/** Equal for two reads of the same rule file, different when the name or the content differs. */
function ruleFileSignature(read: RuleFileRead): string {
  if (read.raw) return `file:${read.raw.candidate}:${read.raw.content}`;
  if (read.skipped !== undefined) return `skipped:${read.skipped}`;
  return "";
}

async function locateRepository(
  canonicalRoot: string,
  repository: WorkspaceRepositoryReference,
): Promise<{ directory?: string; diagnostic?: string }> {
  let requestedDirectory: string;
  try {
    requestedDirectory = containedPath(canonicalRoot, repository.path);
  } catch {
    return {
      diagnostic: `skipped the context file of ${repository.name}: ${repository.path} escapes the workspace root`,
    };
  }
  // A repository whose checkout is missing or unreadable simply contributes no context.
  const directory = await realpath(requestedDirectory).catch(() => undefined);
  if (!directory) return {};
  if (!isContained(canonicalRoot, directory)) {
    return {
      diagnostic: `skipped the context file of ${repository.name}: ${repository.path} resolves outside the workspace`,
    };
  }
  return { directory };
}

async function readWorkingTreeRuleFile(
  directory: string,
  repository: WorkspaceRepositoryReference,
): Promise<RuleFileRead> {
  // Names exactly as the directory lists them: on a case-insensitive file system stat("AGENTS.md") also finds
  // "agents.md", which Git (and so the base-commit read) does not treat as the same file.
  const listed = new Set(await readdir(directory).catch(() => [] as string[]));
  for (const candidate of REPOSITORY_CONTEXT_FILE_CANDIDATES) {
    if (!listed.has(candidate)) continue;
    const candidatePath = resolve(directory, candidate);
    const metadata = await stat(candidatePath).catch(() => undefined);
    // Missing names, broken symlinks and directories are passed over, as Pi passes over them.
    if (!metadata?.isFile()) continue;
    // The first candidate that exists is the repository's context file. When it fails a check
    // it is reported rather than silently replaced by the next name in the order.
    const resolvedPath = await realpath(candidatePath).catch(() => undefined);
    if (!resolvedPath || !isContained(directory, resolvedPath)) {
      return { skipped: candidate, diagnostic: `skipped ${repository.path}/${candidate}: it resolves outside the repository` };
    }
    if (metadata.size > MAX_REPOSITORY_CONTEXT_FILE_BYTES) {
      return {
        skipped: candidate,
        diagnostic: `skipped ${repository.path}/${candidate}: ${metadata.size} bytes exceeds the ${MAX_REPOSITORY_CONTEXT_FILE_BYTES}-byte limit`,
      };
    }
    const content = await readFile(resolvedPath, "utf8").catch(() => undefined);
    if (content === undefined) return {};
    if (Buffer.byteLength(content, "utf8") > MAX_REPOSITORY_CONTEXT_FILE_BYTES) {
      return {
        skipped: candidate,
        diagnostic: `skipped ${repository.path}/${candidate}: it exceeds the ${MAX_REPOSITORY_CONTEXT_FILE_BYTES}-byte limit`,
      };
    }
    return { raw: { candidate, path: resolvedPath, content } };
  }
  return {};
}

/** Whether `error` is the worker's fixed stop for a base commit whose rule files could not be verified. */
export function isRuleFilesUnverified(error: unknown): boolean {
  return error instanceof Error && error.message.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE);
}

/**
 * The same candidate order, size cap and checks, read from `repository.baseCommit` through a verified copy of that commit's objects
 * (trusted-base-objects.ts): the commit, its tree and the rule file are each checked against their own id, and Git never reads the
 * repository's own config, hooks or object store settings. No base commit sent gives no file and a diagnostic (an older task); a base
 * commit that was sent but cannot be verified stops the load with one fixed reason, because the working tree is never the fallback and
 * a review must not run without its rule files. A base commit that simply holds no rule file gives neither a file nor a diagnostic.
 */
async function readBaseCommitRuleFile(
  directory: string,
  repository: WorkspaceRepositoryReference,
  workspaceRoot: string,
): Promise<RuleFileRead> {
  const commit = repository.baseCommit;
  if (commit === undefined) return { diagnostic: `skipped the context file of ${repository.name}: no usable base commit` };
  let found: BaseRuleFile;
  try {
    found = await readVerifiedBaseRuleFile(directory, commit, REPOSITORY_CONTEXT_FILE_CANDIDATES, MAX_REPOSITORY_CONTEXT_FILE_BYTES, { workspaceRoot });
  } catch {
    throw agentXError("CONFIG_INVALID", WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE);
  }
  if (found.kind === "absent") return { usable: true };
  if (found.kind === "symlink") {
    return { usable: true, skipped: found.candidate, diagnostic: `skipped ${repository.path}/${found.candidate}: it is a symbolic link in the base commit` };
  }
  if (found.kind === "oversize") {
    return {
      usable: true,
      skipped: found.candidate,
      diagnostic: `skipped ${repository.path}/${found.candidate}: ${found.size} bytes exceeds the ${MAX_REPOSITORY_CONTEXT_FILE_BYTES}-byte limit`,
    };
  }
  const content = found.content.toString("utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_REPOSITORY_CONTEXT_FILE_BYTES) {
    return { usable: true, skipped: found.candidate, diagnostic: `skipped ${repository.path}/${found.candidate}: it exceeds the ${MAX_REPOSITORY_CONTEXT_FILE_BYTES}-byte limit` };
  }
  return { usable: true, raw: { candidate: found.candidate, path: resolve(directory, found.candidate), content } };
}

function labelledContent(
  repository: WorkspaceRepositoryReference,
  candidate: string,
  content: string,
): string {
  const name = inert(repository.name);
  const path = inert(repository.path);
  return `${candidate} of the "${name}" repository, checked out at ${path} in this workspace. Its guidance applies to the files under ${path}.\n\n${content}`;
}

/** A name or path as one inert piece of text: no hidden characters, and the angle brackets that could close Pi's tag escaped. */
function inert(value: string): string {
  return quoted(inertContextText(value).text).slice(1, -1);
}

/**
 * A JSON string literal, with the line separators JSON leaves raw escaped as well, and the angle
 * brackets that could close the tag Pi wraps context files in.
 */
function quoted(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function containedPath(rootPath: string, configuredPath: string): string {
  if (isAbsolute(configuredPath)) throw new Error("repository path must be relative");
  const candidate = resolve(rootPath, configuredPath);
  if (!isContained(rootPath, candidate)) throw new Error("repository path escapes the workspace root");
  return candidate;
}

function isContained(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}
