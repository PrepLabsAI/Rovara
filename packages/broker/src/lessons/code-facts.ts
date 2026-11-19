// The real `CodeFacts` port (ports.ts). It answers what a tier-0 lesson's words may rest on: the identifiers of the cited code lines (comments and
// strings dropped, `code-lexer.ts`), whether a path exists in the tree at the cited commit, and the project's own repositories.
//
// Read-only, through a narrow reader (`CodeFactsReader`) that the code-host port fills (`codeHostFactsReader` over `CodeHost.fileAtRevision`). Bounded and fail closed: a repository
// that is not one of the PROJECT's, a commit that is not a full id, an unsafe path, a file over 1 MB, a read over 3 seconds, a host error or an unlexable file all give `undefined`
// ("not verified"), and the lesson is then not tier 0. Nothing here guesses.
//
// What this cannot check with the port as it is (stated, not hidden): that the commit is on the protected default branch, and the git blob hash of the file. The commit comes from the
// lesson's citation, which reflect-time code already limits to the task's base or merged commit (the branch head is dropped there); the host answers by that exact commit id.
import type { CodeHost, HostScope, RepositoryRef } from "@agentx/contracts";
import { LEX_MAX_BYTES, lexIdentifiers } from "./code-lexer.js";
import type { CodeFacts } from "./ports.js";

export const CODE_FACTS_TIMEOUT_MS = 3_000;
const MAX_PROJECT_REPOS = 100;
const MAX_IDENTIFIERS = 2_000;
const MAX_PATH = 512;

/** What the broker can read of one repository at one commit. */
export interface CodeFactsReader {
  /** The text of a file at the commit. Undefined when there is no such file (a directory is not a file). It may throw; the caller treats that as "not verified". */
  file(input: { workspaceId: string; project: string; repo: string; commit: string; path: string; timeoutMs: number }): Promise<string | undefined>;
  /** Optional: whether the path is a file, a directory or nothing at the commit. Undefined: the host cannot tell. Without this method only a readable file is known to exist. */
  kind?(input: { workspaceId: string; project: string; repo: string; commit: string; path: string; timeoutMs: number }): Promise<"file" | "dir" | "none" | undefined>;
}

export interface CodeFactsDeps {
  reader: CodeFactsReader;
  /** The project's own repositories (the project record), by name as lessons cite them. Throws on failure. */
  repositoriesOf(workspaceId: string, project: string): Promise<readonly string[]>;
  /** For tests: the time a read may take. Default 3 s. */
  timeoutMs?: number;
}

/** A `CodeFactsReader` over the code-host port. `resolve` gives the repository and scope for a project's repository name; no answer means no read. */
export function codeHostFactsReader(
  host: Pick<CodeHost, "fileAtRevision" | "pathKind">,
  resolve: (workspaceId: string, project: string, repo: string) => Promise<{ repository: RepositoryRef; scope: HostScope } | undefined>,
): CodeFactsReader {
  return {
    async file(input) {
      const target = await resolve(input.workspaceId, input.project, input.repo);
      if (target === undefined) return undefined;
      return host.fileAtRevision(target.repository, input.path, input.commit, target.scope, { timeoutMs: input.timeoutMs });
    },
    // Only where the host can tell a directory from nothing; a host without `pathKind` leaves the reader without `kind`, and then only a readable file counts.
    ...(host.pathKind === undefined ? {} : {
      async kind(input) {
        const target = await resolve(input.workspaceId, input.project, input.repo);
        if (target === undefined) return undefined;
        const kind = await host.pathKind!(target.repository, input.path, input.commit, target.scope, { timeoutMs: input.timeoutMs });
        // A symbolic link may point at a file, a directory or nothing: a lesson reader cannot tell, so it is not claimed to be any of them.
        return kind === "symlink" ? undefined : kind;
      },
    }),
  };
}

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** A repository-relative path: no empty, dot or dot-dot segment, no backslash, no control character, bounded. */
function safePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH || path.includes("\\") || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}
const GLOB_CHARS = /[*?[\]{}]/u;

/** The literal directory prefix of a path or glob: the segments before the first one that holds a glob character. `glob` says whether there was one. */
export function literalPrefix(path: string): { prefix: string; glob: boolean } {
  const segments = path.split("/");
  const at = segments.findIndex((s) => GLOB_CHARS.test(s));
  return at === -1 ? { prefix: path, glob: false } : { prefix: segments.slice(0, at).join("/"), glob: true };
}

export function createCodeFacts(deps: CodeFactsDeps): CodeFacts {
  const timeoutMs = deps.timeoutMs ?? CODE_FACTS_TIMEOUT_MS;

  /** The project's repository list, or undefined when it cannot be read or the repository is not on it. */
  async function allowed(workspaceId: string, project: string | undefined, repo: string): Promise<string | undefined> {
    if (project === undefined || project.length === 0) return undefined;
    let list: readonly string[];
    try { list = await deps.repositoriesOf(workspaceId, project); } catch { return undefined; }
    return Array.isArray(list) && list.length <= MAX_PROJECT_REPOS && list.includes(repo) ? project : undefined;
  }

  async function within<T>(run: () => Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([run(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref?.(); })]);
    } catch { return undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  return {
    async identifiers(input) {
      if (!COMMIT.test(input.commit) || !safePath(input.path)) return undefined;
      const project = await allowed(input.workspaceId, input.project, input.repo);
      if (project === undefined) return undefined;
      const text = await within(() => deps.reader.file({ workspaceId: input.workspaceId, project, repo: input.repo, commit: input.commit, path: input.path, timeoutMs }));
      if (typeof text !== "string" || text.length > LEX_MAX_BYTES) return undefined;
      const found = lexIdentifiers(input.path, text, input.startLine, input.endLine);
      return found === undefined ? undefined : [...new Set(found)].slice(0, MAX_IDENTIFIERS);
    },

    async pathExists(input) {
      if (!COMMIT.test(input.commit) || !safePath(input.path)) return undefined;
      const project = await allowed(input.workspaceId, input.project, input.repo);
      if (project === undefined) return undefined;
      const ask = { workspaceId: input.workspaceId, project, repo: input.repo, commit: input.commit, timeoutMs };
      const { prefix, glob } = literalPrefix(input.path);
      // A glob that starts with a glob character has the repository root as its prefix, which exists.
      if (glob && prefix === "") return true;
      if (deps.reader.kind !== undefined) {
        const kind = await within(() => deps.reader.kind!({ ...ask, path: prefix }));
        // A glob's prefix must be a directory; a plain path may be a file or a directory.
        if (kind !== undefined) return glob ? kind === "dir" : kind !== "none";
        // A host that cannot tell the kind (its `kind` answers "cannot tell", as the broker's reader does for a host without `pathKind`) falls back to reading the file, exactly as a reader
        // without `kind` always did; a glob needs the directory and stays unverified.
      }
      // No way to tell a directory from a missing path: only a file that can be read is known to exist.
      if (glob) return undefined;
      const text = await within(() => deps.reader.file({ ...ask, path: prefix }));
      return typeof text === "string" ? true : undefined;
    },

    async repositories(workspaceId, project) {
      // A failure is thrown: the caller (gatherMaterial) then verifies nothing.
      const list = await deps.repositoriesOf(workspaceId, project);
      if (!Array.isArray(list) || list.length > MAX_PROJECT_REPOS) throw new Error("the project's repository list is not usable");
      return [...new Set<string>(list)];
    },
  };
}
