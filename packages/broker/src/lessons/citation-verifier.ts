// The broker's `CitationVerifier` (ports.ts). It reads the cited file at the cited commit through the same bounded reader the code facts use (the code host's
// `fileAtRevision`, never a working tree) and applies the one shared anchor rule (`locateCitation` in contracts, the same one the worker uses). Fail closed: a repository that is not one of the
// project's, a commit that is not a full id, an unsafe path, a file over 1 MB, a read over 3 s, a host error all answer `unknown`, and the lesson is then not trusted as verified (never tier 0).
import { locateCitation } from "@agentx/contracts";
import { CODE_FACTS_TIMEOUT_MS, type CodeFactsReader } from "./code-facts.js";
import type { CitationVerifier } from "./ports.js";

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_BYTES = 1024 * 1024;
const MAX_PROJECT_REPOS = 100;

function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function createCitationVerifier(input: { reader: CodeFactsReader; repositoriesOf(workspaceId: string, project: string): Promise<readonly string[]>; timeoutMs?: number }): CitationVerifier {
  const timeoutMs = input.timeoutMs ?? CODE_FACTS_TIMEOUT_MS;
  return {
    async verify(request) {
      const unknown = { result: "unknown" as const };
      if (request.project === undefined || request.project === "" || !COMMIT.test(request.commit) || !safePath(request.path)) return unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const repositories = await input.repositoriesOf(request.workspaceId, request.project);
        if (!Array.isArray(repositories) || repositories.length > MAX_PROJECT_REPOS || !repositories.includes(request.repo)) return unknown;
        const text = await Promise.race([
          input.reader.file({ workspaceId: request.workspaceId, project: request.project, repo: request.repo, commit: request.commit, path: request.path, timeoutMs }),
          new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); timer.unref?.(); }),
        ]);
        if (text === "timeout") return unknown;
        if (text === undefined) return { result: "stale" };
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return unknown;
        const lines = text.split("\n").map((line) => line.replace(/\r$/u, ""));
        const found = locateCitation({ lineCount: lines.length, lines }, request);
        if (found.kind === "valid") return { result: "valid" };
        if (found.kind === "moved") return { result: "moved", startLine: found.startLine, endLine: found.endLine };
        return found.kind === "stale" ? { result: "stale" } : unknown;
      } catch { return unknown; } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}
