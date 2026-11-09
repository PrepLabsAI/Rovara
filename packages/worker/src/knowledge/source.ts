// Knowledge resolver (K1, C2): where a repository's rule files are read from.
//
// The resolver never touches a file system itself. It asks a `KnowledgeFileSource` to list a folder and read a file, so the same code reads:
// - the commit a task started from, through the verified object copy of trusted-base-objects.ts (judging stages, and the meta repo at its
//   pinned `knowledgeCommit`): every commit, tree and file is hashed against its own id, and an object that does not verify stops the read;
// - the checked-out files (the builder's own session), confined to the repository the way the existing rule-file read is (R56);
// - memory, for tests and for the meta-repo contract stub (stub-meta.ts).
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, agentXError } from "@agentx/contracts";
import { runFileOp } from "../sandbox-file-ops.js";
import {
  BaseObjectsUnverified,
  VERIFIED_MAX_BLOB_BYTES,
  VERIFIED_TREE_BYTES,
  openVerifiedBaseObjects,
  parseTreeListing,
  type ReadOptions,
  type TreeListingEntry,
  type VerifiedBaseObjects,
} from "../trusted-base-objects.js";
import type { KnowledgeReadAt } from "./model.js";

export interface DirectoryEntry {
  name: string;
  kind: "file" | "dir" | "symlink" | "other";
}

export type FileRead =
  | { kind: "file"; content: string }
  | { kind: "missing" }
  | { kind: "too_large"; size?: number }
  /** A link the source refuses to follow (the base commit holds a symbolic link, or a link resolves outside the repository). */
  | { kind: "symlink" }
  | { kind: "unreadable" };

export interface KnowledgeFileSource {
  readonly readAt: KnowledgeReadAt;
  /** The entries of a repository-relative folder (`""` is the root), or undefined when it is not a readable folder. */
  listDirectory(directory: string): Promise<DirectoryEntry[] | undefined>;
  /** One file's text, at most `limitBytes` of it; a larger file is `too_large`. */
  readFile(path: string, limitBytes: number): Promise<FileRead>;
  close(): Promise<void>;
}

/** The base-commit objects of one repository stopped the read: the fixed stop the existing rule-file path uses. */
export const knowledgeUnverified = () => agentXError("CONFIG_INVALID", WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE);

const MAX_OBJECT_FETCHES = 4_000;
/** Each object read has its own deadline (trusted-base-objects.ts); this bounds a whole source, so many slow reads cannot add up without end. */
const SOURCE_TOTAL_MS = 10 * 60_000;

function splitPath(path: string): string[] | undefined {
  if (path === "") return [];
  const parts = path.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? undefined : parts;
}

/**
 * A repository's files at `commit`, from the verified object copy. Folders are walked from the commit's tree one level at a time and cached;
 * each tree and file is fetched (and hashed against its id) once. A read that cannot be verified throws the fixed rule-files-unverified error:
 * the working tree is never the fallback, and a stage must not run without its rules. At most 4,000 objects are fetched per source.
 */
export async function openBaseCommitSource(
  directory: string,
  commit: string,
  readAt: "base" | "knowledgeCommit",
  options: ReadOptions & { sourceTotalMs?: number } = {},
): Promise<KnowledgeFileSource> {
  let objects: VerifiedBaseObjects;
  try {
    objects = await openVerifiedBaseObjects(directory, commit, options);
  } catch {
    throw knowledgeUnverified();
  }
  const trees = new Map<string, TreeListingEntry[] | undefined>();
  const openedAt = Date.now();
  let fetches = 0;
  const fetchObject: VerifiedBaseObjects["fetchObject"] = async (type, oid, maximum, keep) => {
    fetches += 1;
    if (fetches > MAX_OBJECT_FETCHES || Date.now() - openedAt > (options.sourceTotalMs ?? SOURCE_TOTAL_MS)) throw new BaseObjectsUnverified();
    return objects.fetchObject(type, oid, maximum, keep);
  };
  const tree = async (path: string): Promise<TreeListingEntry[] | undefined> => {
    if (trees.has(path)) return trees.get(path);
    const parts = splitPath(path);
    let oid: string | undefined;
    if (parts === undefined) oid = undefined;
    else if (parts.length === 0) oid = objects.rootTreeId;
    else {
      const parent = await tree(parts.slice(0, -1).join("/"));
      const entry = parent?.find((candidate) => candidate.name === parts[parts.length - 1]);
      oid = entry !== undefined && (entry.mode & 0o170000) === 0o040000 ? entry.oid : undefined;
    }
    let listing: TreeListingEntry[] | undefined;
    if (oid !== undefined) {
      const bytes = (await fetchObject("tree", oid, VERIFIED_TREE_BYTES, VERIFIED_TREE_BYTES)).bytes;
      listing = bytes === undefined ? undefined : parseTreeListing(bytes, objects.hashBytes);
    }
    trees.set(path, listing);
    return listing;
  };
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      throw knowledgeUnverified();
    }
  };
  return {
    readAt,
    listDirectory: (path) => guarded(async () => {
      const listing = await tree(path);
      return listing?.map((entry) => ({ name: entry.name, kind: kindOfMode(entry.mode) }));
    }),
    readFile: (path, limitBytes) => guarded(async (): Promise<FileRead> => {
      const parts = splitPath(path);
      if (parts === undefined || parts.length === 0) return { kind: "missing" };
      const parent = await tree(parts.slice(0, -1).join("/"));
      const entry = parent?.find((candidate) => candidate.name === parts[parts.length - 1]);
      if (entry === undefined) return { kind: "missing" };
      const kind = kindOfMode(entry.mode);
      if (kind === "symlink") return { kind: "symlink" };
      if (kind !== "file") return { kind: "missing" };
      const blob = await fetchObject("blob", entry.oid, VERIFIED_MAX_BLOB_BYTES, limitBytes);
      if (blob.bytes === undefined) return { kind: "too_large", size: blob.size };
      return { kind: "file", content: blob.bytes.toString("utf8") };
    }),
    close: () => objects.close(),
  };
}

function kindOfMode(mode: number): DirectoryEntry["kind"] {
  const type = mode & 0o170000;
  if (type === 0o040000) return "dir";
  if (type === 0o100000) return "file";
  if (type === 0o120000) return "symlink";
  return "other";
}

const isContained = (parent: string, child: string): boolean => {
  const fromParent = relative(parent, child);
  return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
};

/**
 * A repository's checked-out files. On Linux every read goes through the confined file operations the agent's own tools use (no link is
 * followed out of the repository, and a link flipped between a check and an open cannot reach another file); elsewhere (a developer's
 * machine) a path is checked to stay inside the repository after its links are resolved. Names are exactly as the folder lists them.
 */
export function openWorkingTreeSource(repositoryDirectory: string): KnowledgeFileSource {
  const linux = process.platform === "linux";
  const listPortable = async (path: string): Promise<DirectoryEntry[] | undefined> => {
    const target = resolve(repositoryDirectory, path);
    if (!isContained(repositoryDirectory, target) && target !== repositoryDirectory) return undefined;
    const real = await realpath(target).catch(() => undefined);
    if (real === undefined || (real !== repositoryDirectory && !isContained(repositoryDirectory, real))) return undefined;
    const dirents = await readdir(real, { withFileTypes: true }).catch(() => undefined);
    if (dirents === undefined) return undefined;
    const entries: DirectoryEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        // A link is a file or a folder by where it leads inside the repository; one that leaves it is a refused link.
        const resolved = await realpath(join(real, dirent.name)).catch(() => undefined);
        const info = resolved === undefined || !isContained(repositoryDirectory, resolved) ? undefined : await stat(resolved).catch(() => undefined);
        entries.push({ name: dirent.name, kind: info?.isFile() === true ? "file" : info?.isDirectory() === true ? "dir" : "symlink" });
      } else entries.push({ name: dirent.name, kind: dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other" });
    }
    return entries;
  };
  const listConfined = async (path: string): Promise<DirectoryEntry[] | undefined> => {
    const response = await runFileOp({ root: repositoryDirectory, op: "readdir", path: path === "" ? "." : path });
    if (!response.ok) return undefined;
    const { entries } = response.result as { entries: Array<{ name: string; kind: "dir" | "file" | "gone" }> };
    return entries.map((entry) => ({ name: entry.name, kind: entry.kind === "gone" ? "symlink" : entry.kind }));
  };
  const readPortable = async (path: string, limitBytes: number): Promise<FileRead> => {
    const target = resolve(repositoryDirectory, path);
    if (!isContained(repositoryDirectory, target)) return { kind: "missing" };
    const real = await realpath(target).catch(() => undefined);
    if (real === undefined) return { kind: "missing" };
    if (!isContained(repositoryDirectory, real)) return { kind: "symlink" };
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile()) return { kind: "missing" };
    if (info.size > limitBytes) return { kind: "too_large", size: info.size };
    const content = await readFile(real, "utf8").catch(() => undefined);
    if (content === undefined) return { kind: "unreadable" };
    return Buffer.byteLength(content, "utf8") > limitBytes ? { kind: "too_large" } : { kind: "file", content };
  };
  const readConfined = async (path: string, limitBytes: number): Promise<FileRead> => {
    const info = await runFileOp({ root: repositoryDirectory, op: "stat", path });
    if (!info.ok) return info.code === "OUTSIDE" ? { kind: "symlink" } : { kind: "missing" };
    const metadata = info.result as { type?: string; size?: number };
    if (metadata.type !== "file") return { kind: "missing" };
    if ((metadata.size ?? 0) > limitBytes) return { kind: "too_large", size: metadata.size ?? 0 };
    const read = await runFileOp({ root: repositoryDirectory, op: "readFile", path });
    if (!read.ok) return read.code === "OUTSIDE" ? { kind: "symlink" } : read.code === "TOO_LARGE" ? { kind: "too_large" } : { kind: "unreadable" };
    const content = Buffer.from((read.result as { contentBase64: string }).contentBase64, "base64").toString("utf8");
    return Buffer.byteLength(content, "utf8") > limitBytes ? { kind: "too_large" } : { kind: "file", content };
  };
  return {
    readAt: "working",
    listDirectory: (path) => (splitPath(path) === undefined ? Promise.resolve(undefined) : linux ? listConfined(path) : listPortable(path)),
    readFile: (path, limitBytes) => (splitPath(path) === undefined || path === "" ? Promise.resolve<FileRead>({ kind: "missing" }) : linux ? readConfined(path, limitBytes) : readPortable(path, limitBytes)),
    close: () => Promise.resolve(),
  };
}

/** Files held in memory (tests, and the meta-repo stub). Keys are repository-relative paths; a value `{ symlink: true }` is a refused link. */
export function memoryKnowledgeSource(
  files: Readonly<Record<string, string | { symlink: true }>>,
  readAt: KnowledgeReadAt = "base",
): KnowledgeFileSource {
  const paths = Object.keys(files);
  return {
    readAt,
    listDirectory: (directory) => {
      const prefix = directory === "" ? "" : `${directory}/`;
      const children = new Map<string, DirectoryEntry["kind"]>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) children.set(rest.slice(0, slash), "dir");
        else children.set(rest, typeof files[path] === "string" ? "file" : "symlink");
      }
      return Promise.resolve(directory !== "" && children.size === 0 ? undefined : [...children].map(([name, kind]) => ({ name, kind })));
    },
    readFile: (path, limitBytes) => {
      const value = files[path];
      if (value === undefined) return Promise.resolve<FileRead>({ kind: "missing" });
      if (typeof value !== "string") return Promise.resolve<FileRead>({ kind: "symlink" });
      return Promise.resolve<FileRead>(Buffer.byteLength(value, "utf8") > limitBytes ? { kind: "too_large", size: Buffer.byteLength(value, "utf8") } : { kind: "file", content: value });
    },
    close: () => Promise.resolve(),
  };
}

