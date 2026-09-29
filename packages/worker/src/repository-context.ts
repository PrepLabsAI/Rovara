import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AgentXNameSchema, RelativeWorkspacePathSchema } from "@agentx/contracts";
import type { PreparationManifest } from "./prepare.js";

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
}

export interface RepositoryContextFile {
  path: string;
  content: string;
}

export interface RepositoryContextFiles {
  files: RepositoryContextFile[];
  diagnostics: string[];
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
 * the size cap is skipped with a diagnostic.
 */
export async function loadRepositoryContextFiles(
  rootPath: string,
  repositories: readonly WorkspaceRepositoryReference[],
): Promise<RepositoryContextFiles> {
  const canonicalRoot = await realpath(resolve(rootPath)).catch(() => resolve(rootPath));
  const files: RepositoryContextFile[] = [];
  const diagnostics: string[] = [];
  for (const repository of repositories) {
    const loaded = await loadRepositoryContextFile(canonicalRoot, repository);
    if (loaded.file) files.push(loaded.file);
    if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
  }
  return { files, diagnostics };
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
  return `The repository ${quoted(name)} is checked out at ${quoted(path).slice(1, -1)} in this workspace.`;
}

/** Appends the repository context files to the ones Pi's resource loader already discovered. */
export function appendRepositoryContextFiles(
  files: readonly RepositoryContextFile[],
): (base: { agentsFiles: RepositoryContextFile[] }) => { agentsFiles: RepositoryContextFile[] } {
  return (base) => ({ agentsFiles: [...base.agentsFiles, ...files] });
}

async function loadRepositoryContextFile(
  canonicalRoot: string,
  repository: WorkspaceRepositoryReference,
): Promise<{ file?: RepositoryContextFile; diagnostic?: string }> {
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
  for (const candidate of REPOSITORY_CONTEXT_FILE_CANDIDATES) {
    const candidatePath = resolve(directory, candidate);
    const metadata = await stat(candidatePath).catch(() => undefined);
    // Missing names, broken symlinks and directories are passed over, as Pi passes over them.
    if (!metadata?.isFile()) continue;
    // The first candidate that exists is the repository's context file. When it fails a check
    // it is reported rather than silently replaced by the next name in the order.
    const resolvedPath = await realpath(candidatePath).catch(() => undefined);
    if (!resolvedPath || !isContained(directory, resolvedPath)) {
      return { diagnostic: `skipped ${repository.path}/${candidate}: it resolves outside the repository` };
    }
    if (metadata.size > MAX_REPOSITORY_CONTEXT_FILE_BYTES) {
      return {
        diagnostic: `skipped ${repository.path}/${candidate}: ${metadata.size} bytes exceeds the ${MAX_REPOSITORY_CONTEXT_FILE_BYTES}-byte limit`,
      };
    }
    const content = await readFile(resolvedPath, "utf8").catch(() => undefined);
    if (content === undefined) return {};
    if (Buffer.byteLength(content, "utf8") > MAX_REPOSITORY_CONTEXT_FILE_BYTES) {
      return {
        diagnostic: `skipped ${repository.path}/${candidate}: it exceeds the ${MAX_REPOSITORY_CONTEXT_FILE_BYTES}-byte limit`,
      };
    }
    return { file: { path: resolvedPath, content: labelledContent(repository, candidate, content) } };
  }
  return {};
}

function labelledContent(
  repository: WorkspaceRepositoryReference,
  candidate: string,
  content: string,
): string {
  return `${candidate} of the "${repository.name}" repository, checked out at ${repository.path} in this workspace. Its guidance applies to the files under ${repository.path}.\n\n${content}`;
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
