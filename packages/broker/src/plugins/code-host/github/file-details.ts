import { agentXError, isAiInstructionPath, type FileEntryType, type HostScope } from "@agentx/contracts";
import type { GitHubCodeHostProvider } from "./provider.js";

type Tree = Awaited<ReturnType<NonNullable<GitHubCodeHostProvider["listTreeAtCommit"]>>>;
type TreeEntry = Tree["entries"][number];
export type IndexedTree = { truncated: boolean; entries: ReadonlyMap<string, TreeEntry> };

/** Unknown modes and inconsistent mode/type pairs are never ordinary files. */
export function fileEntryType(entry: TreeEntry): FileEntryType | undefined {
  if (entry.type === "commit" && entry.mode === "160000") return "submodule";
  if (entry.type !== "blob") return undefined;
  switch (entry.mode) {
    case "100644": case "100664": return "file";
    case "100755": return "executable";
    case "120000": return "symlink";
    default: return undefined;
  }
}

/** An absent path is known only in a complete tree, and never below a non-directory entry. */
export function entryAt(tree: IndexedTree, path: string): FileEntryType | "none" | undefined {
  if (tree.truncated) return undefined;
  const entry = tree.entries.get(path);
  if (entry !== undefined) return fileEntryType(entry);
  let slash = path.indexOf("/");
  while (slash !== -1) {
    const parent = tree.entries.get(path.slice(0, slash));
    if (parent !== undefined && (parent.type !== "tree" || parent.mode !== "040000")) return undefined;
    slash = path.indexOf("/", slash + 1);
  }
  return "none";
}

/** Eight complete trees per adapter. No failed or truncated response is retained. Keys include the caller's company, repository and immutable commit id. */
export function fileTrees(provider: GitHubCodeHostProvider, credentialRef: string) {
  const cache = new Map<string, IndexedTree>();
  return async (url: string, revision: string, scope: HostScope, options?: { timeoutMs?: number }, authorized = false): Promise<IndexedTree> => {
    if (!/^[a-f0-9]{40}$/u.test(revision)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const key = JSON.stringify([scope, url, revision]);
    const found = cache.get(key);
    if (found !== undefined) {
      // changedFiles has just performed a scoped files read; standalone reads must recheck current authorization.
      if (!authorized) await provider.checkRepository({ url, credentialRef }, scope);
      cache.delete(key); cache.set(key, found);
      return found;
    }
    const read = await provider.listTreeAtCommit!(url, revision, scope, options);
    const entries = new Map<string, TreeEntry>();
    for (const entry of read.entries) {
      if (entries.has(entry.path)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned duplicate tree paths");
      entries.set(entry.path, entry);
    }
    const tree = { truncated: read.truncated, entries };
    if (!read.truncated) {
      cache.set(key, tree);
      if (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    return tree;
  };
}

export function instructionList(tree: IndexedTree, max: number): { files: Array<{ path: string; type: FileEntryType }>; complete: boolean } {
  const files: Array<{ path: string; type: FileEntryType }> = [];
  let complete = !tree.truncated;
  for (const entry of tree.entries.values()) {
    if (entry.type === "tree" && entry.mode === "040000") continue;
    if (!isAiInstructionPath(entry.path)) continue;
    const type = fileEntryType(entry);
    if (type === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "An instruction file type is unknown");
    if (files.length >= max) { complete = false; continue; }
    files.push({ path: entry.path, type });
  }
  return { files, complete };
}
