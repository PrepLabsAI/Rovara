// One project's code for the answer service (lead 4, J1), built from the project's repositories and the code host each one lives on. The same adapter serves the hosted core and `rovara up`: only where the
// handles come from differs.
//  - `heads()` asks each repository's host for its default-branch head ONCE per answer; a repository the host cannot answer for is left out (a code read of it is refused, a citation of it is not found).
//  - `read` opens a file at a commit, only in a repository of THIS project (a name that is not one answers "not there"), with a size cap and the caller's timeout.
import type { CodeHost, HostScope, RepositoryRef } from "@agentx/contracts";
import { READABLE_COMMIT, type CitationFileReader } from "../citations/citation-check.js";
import type { AnswerCodeSource } from "./ports.js";

/** The largest file the answer service reads (bytes); a bigger file is refused by the host, which reads as "not available". */
export const ANSWER_FILE_MAX_BYTES = 262_144;

export interface AnswerRepositoryHandle {
  /** The project's name for the repository. */
  name: string;
  defaultBranch: string;
  repository: RepositoryRef;
  host: Pick<CodeHost, "baseBranchHead" | "fileAtRevision">;
  scope: HostScope;
}

export function createAnswerCodeSource(handles: readonly AnswerRepositoryHandle[], projectRepositories: readonly string[]): AnswerCodeSource {
  const byName = new Map(handles.map((handle) => [handle.name, handle]));
  let heads: Promise<ReadonlyMap<string, string>> | undefined;
  const read: CitationFileReader = async (repository, path, commit, readOptions) => {
    const handle = byName.get(repository);
    // A repository that is not the project's, or a commit that is not a full hash, is never asked of the host.
    if (handle === undefined || !READABLE_COMMIT.test(commit)) return undefined;
    return await handle.host.fileAtRevision(handle.repository, path, commit, handle.scope, { ...(readOptions.untilLine === undefined ? {} : { untilLine: readOptions.untilLine }), timeoutMs: readOptions.timeoutMs, maxBytes: ANSWER_FILE_MAX_BYTES });
  };
  return {
    repositories: handles.map((handle) => handle.name),
    projectRepositories,
    heads() {
      heads ??= (async () => {
        const found = new Map<string, string>();
        await Promise.all(handles.map(async (handle) => {
          try {
            const head = await handle.host.baseBranchHead(handle.repository, handle.defaultBranch, handle.scope);
            if (READABLE_COMMIT.test(head)) found.set(handle.name, head);
          } catch { /* a repository the host cannot answer for is left out */ }
        }));
        return found;
      })();
      return heads;
    },
    read,
  };
}
