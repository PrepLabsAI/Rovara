/**
 * The file-tool helper: the process that touches a task's files, run inside the task's own container (the task sandbox,
 * or the project's devcontainer) by `docker exec -i`, never in the worker. The agent's file tools (`read`, `write`,
 * `edit`, `grep`, `find`, `ls`) send it one request and read one JSON line back (sandbox-file-tools.ts).
 *
 * It imports nothing outside Node's standard library, so the compiled `sandbox-file-ops.js` runs as one file, and the
 * devcontainer can be given a copy of just that file (devcontainer.ts, installFileOpsHelper). Only erasable TypeScript is
 * used, so `node --experimental-strip-types` runs this source as it is (the contract test does).
 *
 * The second layer: the kernel never follows a symlink here. Every path is walked one component at a time from a
 * verified root directory descriptor, each component opened as `/proc/self/fd/<parent>/<name>` with O_NOFOLLOW (and
 * O_DIRECTORY for a directory), so a link the task flips between a check and the open cannot lead outside the root.
 * A symlink inside the workspace is read and followed by this code itself, in a stack of verified directories, and a
 * link whose target leaves the root is refused with OUTSIDE. It needs `/proc`, so it runs on Linux only.
 */
import { constants as fsConstants, realpathSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, open, opendir, readlink, realpath, rename, unlink, access } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

/** The prefix of the temporary file an atomic write makes in the target's own directory. */
export const FILE_OPS_TEMP_PREFIX = ".agentx-file-ops-";
/** A request longer than this once encoded is refused: it carries paths and patterns, never content. */
export const MAX_REQUEST_ARGUMENT_BYTES = 16 * 1024;
/** The largest file `readFile` returns, and the largest `writeFile` accepts. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SYMLINKS_PER_CALL = 40;
const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GREP_LINE_CHARS = 1_000;
const MAX_CONTEXT_LINES = 50;
const MAX_RESULT_LIMIT = 10_000;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);
const WATCHDOG_MS = 58_000;
/** How long a grep or a glob may match before the helper gives up on the pattern (the match runs in a thread it can end). */
export const DEFAULT_MATCH_DEADLINE_MS = 20_000;
/** Names the variable that lowers the deadline (the contract test sets it); it is the container's, never the agent's. */
export const MATCH_DEADLINE_ENVIRONMENT = "AGENTX_FILE_OPS_DEADLINE_MS";

export type FileOpsErrorCode = "ENOENT" | "EISDIR" | "ENOTDIR" | "OUTSIDE" | "EACCES" | "TOO_LARGE" | "INVALID" | "PATTERN_TOO_SLOW";

export type SandboxFileRequest = { root: string } & (
  | { op: "readFile"; path: string; /** Read only this many leading bytes (an image check); absent: the whole file. */ head?: number }
  | { op: "access"; path: string; write?: boolean }
  | { op: "stat"; path: string }
  | { op: "readdir"; path: string }
  | { op: "exists"; path: string }
  | { op: "writeFile"; path: string; /** The byte length of the content on stdin, so a cut-short stream is told apart from a short file. */ size: number }
  | { op: "mkdir"; path: string }
  | { op: "sweep"; path: string }
  | { op: "countLines"; path: string }
  | { op: "glob"; pattern: string; cwd: string; ignore: string[]; limit: number }
  | { op: "grep"; pattern: string; path: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit: number }
);

export interface GrepLine { n: number; text: string; match: boolean }
export interface GrepBlock { path: string; lines: GrepLine[] }
export type DirectoryEntryKind = "dir" | "file" | "gone";

export type SandboxFileResult =
  | { contentBase64: string }
  | { exists: boolean }
  | { type: "file" | "dir" | "other"; size: number; mtimeMs: number; mode: number }
  | { entries: Array<{ name: string; kind: DirectoryEntryKind }> }
  | { paths: string[] }
  | { searchIsDirectory: boolean; blocks: GrepBlock[]; limitReached: boolean }
  | { removed: number }
  | { lineCount: number }
  | Record<string, never>;

export type SandboxFileResponse = { ok: true; result: SandboxFileResult } | { ok: false; code: FileOpsErrorCode; message: string };

export class FileOpsError extends Error {
  readonly code: FileOpsErrorCode;
  constructor(code: FileOpsErrorCode, message: string) {
    super(message);
    this.name = "FileOpsError";
    this.code = code;
  }
}

const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

function errno(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

/** The kernel's refusal as the protocol's code. EACCES, EPERM and EROFS (a read-only bind mount) are all EACCES. */
function fromKernel(error: unknown, path: string): FileOpsError {
  if (error instanceof FileOpsError) return error;
  switch (errno(error)) {
    case "ENOENT": return new FileOpsError("ENOENT", `${path} does not exist`);
    case "EISDIR": return new FileOpsError("EISDIR", `${path} is a directory`);
    case "ENOTDIR": return new FileOpsError("ENOTDIR", `${path} is not a directory`);
    case "EACCES": case "EPERM": case "EROFS": return new FileOpsError("EACCES", `${path} cannot be accessed`);
    case "ELOOP": return new FileOpsError("OUTSIDE", `${path} changed while it was being opened`);
    default: return new FileOpsError("INVALID", `${path}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400));
  }
}

function procPath(directory: FileHandle, name?: string): string {
  return name === undefined ? `/proc/self/fd/${directory.fd}` : `/proc/self/fd/${directory.fd}/${name}`;
}

function assertEntryName(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new FileOpsError("INVALID", `${JSON.stringify(name)} is not a file name`);
  }
}

/** A path as components below `root`: an absolute path must be `root` or under it, a relative one is below `root`. */
function componentsBelow(root: string, path: string): string[] {
  if (path.includes("\0")) throw new FileOpsError("INVALID", "a path contains a NUL byte");
  let rest = path;
  if (path.startsWith("/")) {
    if (path === root) rest = "";
    else if (root === "/") rest = path.slice(1);
    else if (path.startsWith(`${root}/`)) rest = path.slice(root.length + 1);
    else throw new FileOpsError("OUTSIDE", `${path} is outside the workspace`);
  }
  return rest.split("/");
}

interface Located {
  /** The final component's directory, verified, and its name. Absent when the path names a directory itself (`.`, `..`, the root). */
  entry?: { parent: FileHandle; name: string; stat: Stats | undefined };
  /** The directory the path resolved to when it names one by `.` or `..`, and the root. */
  directory?: FileHandle;
}

/** Walks paths below a verified root, holding every directory it opens until `close`. */
export class RootWalker {
  readonly root: string;
  private readonly rootHandle: FileHandle;
  private readonly opened: FileHandle[] = [];

  private constructor(root: string, rootHandle: FileHandle) {
    this.root = root;
    this.rootHandle = rootHandle;
  }

  /** Opens `root` with O_DIRECTORY | O_NOFOLLOW and requires that `/proc/self/fd/<fd>` is `root`, so `root` has no link in it. */
  static async open(root: string): Promise<RootWalker> {
    if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0") || (root.length > 1 && root.endsWith("/"))) {
      throw new FileOpsError("INVALID", "the root must be an absolute path");
    }
    let handle: FileHandle;
    try {
      handle = await open(root, DIRECTORY_FLAGS);
    } catch (error) {
      // A root that is itself a link answers ENOTDIR or ELOOP.
      if (errno(error) === "ENOTDIR" || errno(error) === "ELOOP") throw new FileOpsError("INVALID", `the root ${root} is not a canonical path`);
      throw fromKernel(error, root);
    }
    try {
      const actual = await realpath(procPath(handle));
      if (actual !== root) throw new FileOpsError("INVALID", `the root ${root} is not a canonical path (it is ${actual})`);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw fromKernel(error, root);
    }
    return new RootWalker(root, handle);
  }

  async close(): Promise<void> {
    await Promise.all(this.opened.splice(0).map((handle) => handle.close().catch(() => undefined)));
    await this.rootHandle.close().catch(() => undefined);
  }

  get rootDirectory(): FileHandle { return this.rootHandle; }

  /**
   * `path` below the root. Every component but the last is a directory, opened by its parent's descriptor; the last is
   * looked up with lstat and, unless `directory`, may be a file or may not exist. A symlink is read here and replaced by
   * its target in the queue of components still to walk, so the kernel never follows one. `..` pops the stack of verified
   * directories and is refused when it would leave the root. `create` makes each missing directory.
   */
  async locate(path: string, options: { directory?: boolean; create?: boolean } = {}): Promise<Located> {
    let queue = componentsBelow(this.root, path);
    const stack: FileHandle[] = [this.rootHandle];
    let links = 0;
    const followLink = (target: string, closeTo: () => void): void => {
      links += 1;
      if (links > MAX_SYMLINKS_PER_CALL) throw new FileOpsError("INVALID", `${path} has too many symbolic links`);
      if (target.startsWith("/")) {
        closeTo();
        queue = [...componentsBelow(this.root, target), ...queue];
      } else {
        queue = [...target.split("/"), ...queue];
      }
    };
    const closeToRoot = (): void => {
      while (stack.length > 1) {
        const handle = stack.pop()!;
        const index = this.opened.indexOf(handle);
        if (index >= 0) this.opened.splice(index, 1);
        void handle.close().catch(() => undefined);
      }
    };
    const nontrivial = (components: readonly string[]): boolean => components.some((component) => component !== "" && component !== ".");
    while (queue.length > 0) {
      const component = queue.shift()!;
      if (component === "" || component === ".") continue;
      if (component === "..") {
        if (stack.length === 1) throw new FileOpsError("OUTSIDE", `${path} is outside the workspace`);
        const handle = stack.pop()!;
        const index = this.opened.indexOf(handle);
        if (index >= 0) this.opened.splice(index, 1);
        void handle.close().catch(() => undefined);
        continue;
      }
      const parent = stack[stack.length - 1]!;
      const last = !nontrivial(queue);
      if (!last || options.directory === true) {
        let child: FileHandle | undefined;
        try {
          child = await open(procPath(parent, component), DIRECTORY_FLAGS);
        } catch (error) {
          const code = errno(error);
          if (code === "ENOENT" && options.create === true) {
            await mkdir(procPath(parent, component)).catch((failure: unknown) => {
              if (errno(failure) !== "EEXIST") throw fromKernel(failure, path);
            });
            queue.unshift(component);
            links += 1;
            if (links > MAX_SYMLINKS_PER_CALL) throw new FileOpsError("INVALID", `${path} changed too often while it was created`);
            continue;
          }
          if (code !== "ENOTDIR" && code !== "ELOOP") throw fromKernel(error, path);
          // A symlink (Linux answers ENOTDIR or ELOOP for O_DIRECTORY | O_NOFOLLOW on one): read it, never follow it.
          const target = await readlink(procPath(parent, component)).catch((failure: unknown) => {
            if (errno(failure) === "EINVAL") return undefined;
            throw fromKernel(failure, path);
          });
          if (target === undefined) {
            if (code === "ELOOP") { queue.unshift(component); links += 1; if (links > MAX_SYMLINKS_PER_CALL) throw new FileOpsError("INVALID", `${path} changed too often`); continue; }
            throw new FileOpsError("ENOTDIR", `${path} is not a directory`);
          }
          followLink(target, closeToRoot);
          continue;
        }
        this.opened.push(child);
        stack.push(child);
        continue;
      }
      let stat: Stats | undefined;
      try {
        stat = await lstat(procPath(parent, component));
      } catch (error) {
        if (errno(error) !== "ENOENT") throw fromKernel(error, path);
      }
      if (stat?.isSymbolicLink() === true) {
        const target = await readlink(procPath(parent, component)).catch((failure: unknown) => {
          if (errno(failure) === "EINVAL" || errno(failure) === "ENOENT") return undefined;
          throw fromKernel(failure, path);
        });
        if (target === undefined) { queue.unshift(component); links += 1; if (links > MAX_SYMLINKS_PER_CALL) throw new FileOpsError("INVALID", `${path} changed too often`); continue; }
        followLink(target, closeToRoot);
        continue;
      }
      return { entry: { parent, name: component, stat } };
    }
    return { directory: stack[stack.length - 1]! };
  }

  /** The directory a path names (every component a directory, the missing ones made when `create`). */
  async directory(path: string, create = false): Promise<FileHandle> {
    const located = await this.locate(path, { directory: true, create });
    if (located.directory === undefined) throw new FileOpsError("ENOTDIR", `${path} is not a directory`);
    return located.directory;
  }

  /** Opens a located entry that is a directory. */
  async openEntryDirectory(entry: NonNullable<Located["entry"]>, path: string): Promise<FileHandle> {
    try {
      const handle = await open(procPath(entry.parent, entry.name), DIRECTORY_FLAGS);
      this.opened.push(handle);
      return handle;
    } catch (error) {
      throw fromKernel(error, path);
    }
  }
}

function typeOf(stat: Stats): "file" | "dir" | "other" {
  return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
}

/** A request path or a file name made safe to put in an error: it is the agent's own text. */
function show(path: string): string {
  return path.length > 300 ? `${path.slice(0, 300)}...` : path;
}

// --- glob ---------------------------------------------------------------------------------------------------------------

/** A glob as a regular expression over `/`-separated paths: `**`, `*`, `?`, `[a-z]`, `[!a-z]`, `{a,b}` and `\x`. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "/" && pattern.slice(index) === "/**") { source += "(?:/.*)?"; break; }
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const afterSlash = pattern[index + 2] === "/";
        index += 1;
        if (afterSlash) { index += 1; source += "(?:.*/)?"; } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close < 0) { source += "\\["; continue; }
      let body = pattern.slice(index + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      source += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/gu, "\\$&")}]`;
      index = close;
    } else if (char === "{") { braceDepth += 1; source += "(?:"; }
    else if (char === "}" && braceDepth > 0) { braceDepth -= 1; source += ")"; }
    else if (char === "," && braceDepth > 0) source += "|";
    else if (char === "\\" && index + 1 < pattern.length) { index += 1; source += pattern[index]!.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"); }
    else source += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  // No `u` flag, so the linear-time fallback for catastrophic backtracking can apply (see grepOp).
  return new RegExp(`^${source}$`, "s");
}

// --- tree walking -------------------------------------------------------------------------------------------------------

interface TreeEntry {
  /** Path below the walk's start, `/`-separated. */
  relative: string;
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  /** The entry's directory, verified; `open` reads or descends through it. */
  parent: FileHandle;
}

/**
 * Lists a verified directory's tree by descriptor. A symlink is listed but never followed, read or descended into; a
 * directory is opened by its parent's descriptor with O_NOFOLLOW. `visit` returns "skip" to leave a directory unvisited
 * and "stop" to end the walk.
 */
async function walkTree(
  start: FileHandle,
  visit: (entry: TreeEntry) => Promise<"skip" | "stop" | undefined>,
  prefix = "",
  depth = 0,
): Promise<boolean> {
  if (depth > 64) return false;
  const directory = await opendir(procPath(start));
  const entries: Dirent[] = [];
  try {
    for await (const entry of directory) entries.push(entry);
  } catch {
    return false;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const dirent of entries) {
    let kind: TreeEntry["kind"] = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
    if (kind === "other") {
      try {
        const stat = await lstat(procPath(start, dirent.name));
        kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      } catch { continue; }
    }
    const relative = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
    const action = await visit({ relative, name: dirent.name, kind, parent: start });
    if (action === "stop") return true;
    if (kind !== "dir" || action === "skip") continue;
    let child: FileHandle;
    try {
      child = await open(procPath(start, dirent.name), DIRECTORY_FLAGS);
    } catch { continue; }
    try {
      if (await walkTree(child, visit, relative, depth + 1)) return true;
    } finally {
      await child.close().catch(() => undefined);
    }
  }
  return false;
}

async function readRegularFile(parent: FileHandle, name: string, maxBytes: number, head?: number): Promise<Buffer | "TOO_LARGE" | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(procPath(parent, name), READ_FLAGS);
  } catch { return undefined; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (head === undefined && stat.size > maxBytes) return "TOO_LARGE";
    const length = head === undefined ? stat.size : Math.min(head, stat.size);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } catch { return undefined; } finally {
    await handle.close().catch(() => undefined);
  }
}

// --- operations ---------------------------------------------------------------------------------------------------------

function limitOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_RESULT_LIMIT, Math.max(1, Math.floor(value))) : fallback;
}

function absoluteOf(root: string, relative: string): string {
  return root === "/" ? `/${relative}` : `${root}/${relative}`;
}

async function readFileOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "readFile" }>): Promise<SandboxFileResult> {
  const located = await walker.locate(request.path);
  if (located.entry === undefined) throw new FileOpsError("EISDIR", `${show(request.path)} is a directory`);
  const { parent, name, stat } = located.entry;
  if (stat === undefined) throw new FileOpsError("ENOENT", `${show(request.path)} does not exist`);
  if (stat.isDirectory()) throw new FileOpsError("EISDIR", `${show(request.path)} is a directory`);
  let handle: FileHandle;
  try {
    handle = await open(procPath(parent, name), READ_FLAGS);
  } catch (error) {
    throw fromKernel(error, show(request.path));
  }
  try {
    const opened = await handle.stat();
    if (opened.isDirectory()) throw new FileOpsError("EISDIR", `${show(request.path)} is a directory`);
    if (!opened.isFile()) throw new FileOpsError("INVALID", `${show(request.path)} is not a regular file`);
    const head = request.head;
    if (head === undefined && opened.size > MAX_FILE_BYTES) {
      throw new FileOpsError("TOO_LARGE", `${show(request.path)} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB`);
    }
    const length = head === undefined ? opened.size : Math.min(Math.max(0, Math.floor(head)), opened.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { contentBase64: buffer.subarray(0, filled).toString("base64") };
  } catch (error) {
    throw fromKernel(error, show(request.path));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function accessOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "access" }>): Promise<SandboxFileResult> {
  const located = await walker.locate(request.path);
  if (located.entry === undefined) return {};
  const { parent, name, stat } = located.entry;
  if (stat === undefined) throw new FileOpsError("ENOENT", `${show(request.path)} does not exist`);
  if (stat.isDirectory()) {
    if (request.write === true) throw new FileOpsError("EISDIR", `${show(request.path)} is a directory`);
    return {};
  }
  try {
    const handle = await open(procPath(parent, name), (request.write === true ? fsConstants.O_WRONLY : fsConstants.O_RDONLY) | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    await handle.close();
  } catch (error) {
    throw fromKernel(error, show(request.path));
  }
  return {};
}

async function statOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "stat" }>): Promise<SandboxFileResult> {
  const located = await walker.locate(request.path);
  const stat = located.entry === undefined
    ? await located.directory!.stat().catch((error: unknown) => { throw fromKernel(error, show(request.path)); })
    : located.entry.stat;
  if (stat === undefined) throw new FileOpsError("ENOENT", `${show(request.path)} does not exist`);
  return { type: typeOf(stat), size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
}

async function existsOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "exists" }>): Promise<SandboxFileResult> {
  try {
    const located = await walker.locate(request.path);
    return { exists: located.entry === undefined || located.entry.stat !== undefined };
  } catch (error) {
    // A missing component is "does not exist"; anything else (OUTSIDE, EACCES) is the caller's to see.
    if (error instanceof FileOpsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) return { exists: false };
    throw error;
  }
}

async function readdirOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "readdir" }>): Promise<SandboxFileResult> {
  const located = await walker.locate(request.path);
  let directory: FileHandle;
  if (located.entry === undefined) directory = located.directory!;
  else {
    if (located.entry.stat === undefined) throw new FileOpsError("ENOENT", `${show(request.path)} does not exist`);
    if (!located.entry.stat.isDirectory()) throw new FileOpsError("ENOTDIR", `${show(request.path)} is not a directory`);
    directory = await walker.openEntryDirectory(located.entry, show(request.path));
  }
  let listed: Dirent[];
  try {
    listed = [];
    for await (const entry of await opendir(procPath(directory))) listed.push(entry);
  } catch (error) {
    throw fromKernel(error, show(request.path));
  }
  const base = request.path.endsWith("/") ? request.path : `${request.path}/`;
  const entries: Array<{ name: string; kind: DirectoryEntryKind }> = [];
  for (const dirent of listed) {
    if (dirent.name.startsWith(FILE_OPS_TEMP_PREFIX)) continue;
    if (dirent.isDirectory()) { entries.push({ name: dirent.name, kind: "dir" }); continue; }
    if (!dirent.isSymbolicLink()) { entries.push({ name: dirent.name, kind: "file" }); continue; }
    // A link is a directory, a file or gone by where it leads inside the workspace, as `stat` would say; one that leaves it is gone.
    try {
      const target = await walker.locate(`${base}${dirent.name}`);
      const kind = target.entry === undefined || target.entry.stat?.isDirectory() === true ? "dir" : target.entry.stat === undefined ? "gone" : "file";
      entries.push({ name: dirent.name, kind });
    } catch {
      entries.push({ name: dirent.name, kind: "gone" });
    }
  }
  return { entries };
}

async function mkdirOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "mkdir" }>): Promise<SandboxFileResult> {
  await walker.directory(request.path, true);
  return {};
}

async function writeFileOp(
  walker: RootWalker,
  request: Extract<SandboxFileRequest, { op: "writeFile" }>,
  input: AsyncIterable<Uint8Array> | undefined,
): Promise<SandboxFileResult> {
  if (!Number.isSafeInteger(request.size) || request.size < 0) throw new FileOpsError("INVALID", "the write has no valid size");
  if (request.size > MAX_FILE_BYTES) throw new FileOpsError("TOO_LARGE", `a write is limited to ${MAX_FILE_BYTES / (1024 * 1024)} MiB`);
  if (input === undefined && request.size > 0) throw new FileOpsError("INVALID", "the write has no content");
  const located = await walker.locate(request.path);
  if (located.entry === undefined) throw new FileOpsError("EISDIR", `${show(request.path)} is a directory`);
  const { parent, name, stat } = located.entry;
  assertEntryName(name);
  if (stat?.isDirectory() === true) throw new FileOpsError("EISDIR", `${show(request.path)} is a directory`);
  if (stat !== undefined && !stat.isFile()) throw new FileOpsError("INVALID", `${show(request.path)} is not a regular file`);
  try {
    // The rename needs the directory, and a rename must never replace a file the user could not have written in place.
    await access(procPath(parent), fsConstants.W_OK | fsConstants.X_OK);
    if (stat !== undefined) {
      const probe = await open(procPath(parent, name), fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      await probe.close();
    }
  } catch (error) {
    throw fromKernel(error, show(request.path));
  }
  const temporary = `${FILE_OPS_TEMP_PREFIX}${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      procPath(parent, temporary),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      stat === undefined ? 0o644 : stat.mode & 0o7777,
    );
    let written = 0;
    if (input !== undefined) {
      for await (const chunk of input) {
        written += chunk.byteLength;
        if (written > request.size) throw new FileOpsError("INVALID", "the write sent more content than its size");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += bytesWritten;
        }
      }
    }
    if (written !== request.size) throw new FileOpsError("INVALID", `the write's content ended early (${written} of ${request.size} bytes)`);
    if (stat !== undefined) await handle.chmod(stat.mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(procPath(parent, temporary), procPath(parent, name));
    return {};
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(procPath(parent, temporary)).catch(() => undefined);
    throw fromKernel(error, show(request.path));
  }
}

/** The lines of a regular file of any size, counted as it streams (a last line with no newline counts), never held. */
async function countLinesOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "countLines" }>): Promise<SandboxFileResult> {
  const located = await walker.locate(request.path);
  if (located.entry === undefined || located.entry.stat === undefined) throw new FileOpsError("ENOENT", `${show(request.path)} does not exist`);
  if (!located.entry.stat.isFile()) throw new FileOpsError(located.entry.stat.isDirectory() ? "EISDIR" : "INVALID", `${show(request.path)} is not a regular file`);
  let handle: FileHandle;
  try {
    handle = await open(procPath(located.entry.parent, located.entry.name), READ_FLAGS);
  } catch (error) {
    throw fromKernel(error, show(request.path));
  }
  try {
    if (!(await handle.stat()).isFile()) throw new FileOpsError("INVALID", `${show(request.path)} is not a regular file`);
    const buffer = Buffer.alloc(64 * 1024);
    let newlines = 0;
    let last = 0x0a;
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) if (buffer[index] === 0x0a) newlines += 1;
      last = buffer[bytesRead - 1]!;
    }
    return { lineCount: last === 0x0a ? newlines : newlines + 1 };
  } catch (error) {
    throw fromKernel(error, show(request.path));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function sweepOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "sweep" }>): Promise<SandboxFileResult> {
  let start: FileHandle;
  try {
    start = await walker.directory(request.path);
  } catch (error) {
    // Nothing to sweep where there is no folder.
    if (error instanceof FileOpsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) return { removed: 0 };
    throw error;
  }
  let removed = 0;
  await walkTree(start, async (entry) => {
    if (entry.kind === "dir" && SKIPPED_DIRECTORIES.has(entry.name)) return "skip";
    if (entry.kind === "file" && entry.name.startsWith(FILE_OPS_TEMP_PREFIX)) {
      // unlink removes the name itself, whatever it has become; only a regular file was listed.
      await unlink(procPath(entry.parent, entry.name)).then(() => { removed += 1; }, () => undefined);
    }
    return undefined;
  });
  return { removed };
}

async function globOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "glob" }>): Promise<SandboxFileResult> {
  const start = await walker.directory(request.cwd);
  const limit = limitOf(request.limit, 1_000);
  const pattern = request.pattern.startsWith("./") ? request.pattern.slice(2) : request.pattern;
  const hasSlash = pattern.includes("/");
  const matcher = globToRegExp(hasSlash && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**" ? `**/${pattern}` : pattern);
  const ignored = (request.ignore ?? []).map((entry) => globToRegExp(entry));
  const found: string[] = [];
  await walkTree(start, async (entry) => {
    if (ignored.some((expression) => expression.test(entry.relative))) return "skip";
    if (matcher.test(hasSlash ? entry.relative : entry.name)) {
      found.push(`${entry.relative}${entry.kind === "dir" ? "/" : ""}`);
      if (found.length >= limit) return "stop";
    }
    return undefined;
  });
  const base = absoluteOfPath(walker.root, request.cwd);
  return { paths: found.map((relative) => `${base === "/" ? "" : base}/${relative}`) };
}

/** The absolute, link-free path of a request path that is already known to be below the root (a lexical join). */
function absoluteOfPath(root: string, path: string): string {
  const parts: string[] = [];
  for (const component of componentsBelow(root, path)) {
    if (component === "" || component === ".") continue;
    if (component === "..") parts.pop(); else parts.push(component);
  }
  return parts.length === 0 ? root : absoluteOf(root, parts.join("/"));
}

async function grepOp(walker: RootWalker, request: Extract<SandboxFileRequest, { op: "grep" }>): Promise<SandboxFileResult> {
  if (typeof request.pattern !== "string" || request.pattern === "") throw new FileOpsError("INVALID", "the search pattern is empty");
  // No `u` flag, unless the pattern needs it: V8's linear-time fallback for catastrophic backtracking (the flag the worker
  // starts this process with) does not apply to a `u` or `i` expression. A pattern with `\p{`, `\P{` or `\u{` means nothing
  // without `u`, so it gets it, and (like a case-insensitive search) relies on the deadline alone.
  const needsUnicode = request.literal !== true && /\\[pPu]\{/u.test(request.pattern);
  let expression: RegExp;
  try {
    expression = new RegExp(request.literal === true ? request.pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") : request.pattern, `${request.ignoreCase === true ? "i" : ""}${needsUnicode ? "u" : ""}`);
  } catch (error) {
    throw new FileOpsError("INVALID", `the search pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
  const limit = limitOf(request.limit, 100);
  const context = Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(request.context ?? 0)));
  let exclude = false;
  let filter: RegExp | undefined;
  let filterByName = false;
  if (request.glob !== undefined && request.glob !== "") {
    let globPattern = request.glob;
    if (globPattern.startsWith("!")) { exclude = true; globPattern = globPattern.slice(1); }
    filterByName = !globPattern.includes("/");
    filter = globToRegExp(globPattern.startsWith("/") ? globPattern.slice(1) : globPattern);
  }
  const located = await walker.locate(request.path);
  const blocks: GrepBlock[] = [];
  let limitReached = false;
  let matches = 0;
  const searchFile = async (parent: FileHandle, name: string, absolute: string): Promise<void> => {
    const content = await readRegularFile(parent, name, MAX_GREP_FILE_BYTES);
    if (content === undefined || content === "TOO_LARGE" || content.subarray(0, 4_096).includes(0)) return;
    const lines = content.toString("utf8").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
    for (let index = 0; index < lines.length && !limitReached; index += 1) {
      if (!expression.test(lines[index]!)) continue;
      matches += 1;
      const first = context > 0 ? Math.max(0, index - context) : index;
      const last = context > 0 ? Math.min(lines.length - 1, index + context) : index;
      const shown: GrepLine[] = [];
      for (let line = first; line <= last; line += 1) shown.push({ n: line + 1, text: lines[line]!.slice(0, MAX_GREP_LINE_CHARS), match: line === index });
      blocks.push({ path: absolute, lines: shown });
      if (matches >= limit) limitReached = true;
    }
  };
  if (located.entry !== undefined && !(located.entry.stat?.isDirectory() === true)) {
    if (located.entry.stat === undefined) throw new FileOpsError("ENOENT", `${show(request.path)} does not exist`);
    await searchFile(located.entry.parent, located.entry.name, absoluteOfPath(walker.root, request.path));
    return { searchIsDirectory: false, blocks, limitReached };
  }
  const start = located.entry === undefined ? located.directory! : await walker.openEntryDirectory(located.entry, show(request.path));
  const base = absoluteOfPath(walker.root, request.path);
  await walkTree(start, async (entry) => {
    if (limitReached) return "stop";
    if (entry.kind === "dir") return SKIPPED_DIRECTORIES.has(entry.name) ? "skip" : undefined;
    if (entry.kind !== "file") return undefined;
    if (entry.name.startsWith(FILE_OPS_TEMP_PREFIX)) return undefined;
    if (filter !== undefined && filter.test(filterByName ? entry.name : entry.relative) === exclude) return undefined;
    await searchFile(entry.parent, entry.name, `${base === "/" ? "" : base}/${entry.relative}`);
    return limitReached ? "stop" : undefined;
  });
  return { searchIsDirectory: true, blocks, limitReached };
}

/** Runs one request against the files under `request.root`. `input` carries a write's content. Never throws: the reply says why. */
export async function runFileOp(request: SandboxFileRequest, input?: AsyncIterable<Uint8Array>): Promise<SandboxFileResponse> {
  let walker: RootWalker | undefined;
  try {
    if (typeof request !== "object" || request === null || typeof request.root !== "string" || typeof request.op !== "string") {
      throw new FileOpsError("INVALID", "the request is malformed");
    }
    walker = await RootWalker.open(request.root);
    let result: SandboxFileResult;
    switch (request.op) {
      case "readFile": result = await readFileOp(walker, request); break;
      case "access": result = await accessOp(walker, request); break;
      case "stat": result = await statOp(walker, request); break;
      case "readdir": result = await readdirOp(walker, request); break;
      case "exists": result = await existsOp(walker, request); break;
      case "writeFile": result = await writeFileOp(walker, request, input); break;
      case "mkdir": result = await mkdirOp(walker, request); break;
      case "sweep": result = await sweepOp(walker, request); break;
      case "countLines": result = await countLinesOp(walker, request); break;
      case "glob": result = await globOp(walker, request); break;
      case "grep": result = await grepOp(walker, request); break;
      default: throw new FileOpsError("INVALID", "the request has an unknown operation");
    }
    return { ok: true, result };
  } catch (error) {
    const failure = error instanceof FileOpsError ? error : fromKernel(error, "the request");
    return { ok: false, code: failure.code, message: failure.message };
  } finally {
    await walker?.close();
  }
}

/**
 * A grep or a glob runs in a worker thread of this file, under a deadline. A pattern that backtracks catastrophically
 * (`(a+)+$`, `*a*a*a*a*b`) blocks the thread's event loop, which no timer in it can interrupt; the main thread can, and
 * ends the thread (V8 stops a running regular expression). The caller is told PATTERN_TOO_SLOW.
 */
export function runMatchingWithDeadline(request: SandboxFileRequest, deadlineMs: number): Promise<SandboxFileResponse> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { agentxFileOpsRequest: request } });
    const finish = (response: SandboxFileResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolvePromise(response), () => resolvePromise(response));
    };
    const timer = setTimeout(() => finish({
      ok: false, code: "PATTERN_TOO_SLOW",
      message: `the search took longer than ${Math.round(deadlineMs / 1_000)} s and was stopped; narrow the path or the glob, or simplify the pattern`,
    }), deadlineMs);
    worker.once("message", (message: unknown) => finish(message as SandboxFileResponse));
    worker.once("error", (error) => finish({ ok: false, code: "INVALID", message: `the search failed: ${error.message}`.slice(0, 300) }));
    worker.once("exit", () => finish({ ok: false, code: "INVALID", message: "the search ended without an answer" }));
  });
}

function matchDeadline(environment: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(environment[MATCH_DEADLINE_ENVIRONMENT]);
  return Number.isFinite(requested) && requested >= 50 && requested <= 50_000 ? requested : DEFAULT_MATCH_DEADLINE_MS;
}

/** The request in `argument` (base64url JSON), refused when it is longer than MAX_REQUEST_ARGUMENT_BYTES. */
export function parseRequestArgument(argument: string | undefined): SandboxFileRequest {
  if (argument === undefined || argument === "") throw new FileOpsError("INVALID", "the request is missing");
  if (Buffer.byteLength(argument, "utf8") > MAX_REQUEST_ARGUMENT_BYTES) {
    throw new FileOpsError("INVALID", `the request is longer than ${MAX_REQUEST_ARGUMENT_BYTES} bytes`);
  }
  try {
    return JSON.parse(Buffer.from(argument, "base64url").toString("utf8")) as SandboxFileRequest;
  } catch {
    throw new FileOpsError("INVALID", "the request is not base64url JSON");
  }
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => process.exit(3), WATCHDOG_MS);
  watchdog.unref();
  let response: SandboxFileResponse;
  try {
    const request = parseRequestArgument(process.argv[2]);
    response = request.op === "grep" || request.op === "glob"
      ? await runMatchingWithDeadline(request, matchDeadline())
      : await runFileOp(request, request.op === "writeFile" ? process.stdin : undefined);
  } catch (error) {
    const failure = error instanceof FileOpsError ? error : fromKernel(error, "the request");
    response = { ok: false, code: failure.code, message: failure.message };
  }
  await new Promise<void>((done) => process.stdout.write(`${JSON.stringify(response)}\n`, () => done()));
  process.exitCode = 0;
  // A write whose stdin was never read must not keep the process open, and a terminated search thread is already gone.
  process.stdin.destroy();
  process.exit(0);
}

const entryScript = process.argv[1];
const searchRequest = (workerData as { agentxFileOpsRequest?: SandboxFileRequest } | null)?.agentxFileOpsRequest;
if (!isMainThread && searchRequest !== undefined && parentPort !== null) {
  // The search thread: run the one request and answer.
  const port = parentPort;
  void runFileOp(searchRequest).then((response) => { port.postMessage(response); });
} else if (isMainThread && entryScript !== undefined) {
  let isEntry = false;
  try {
    isEntry = pathToFileURL(realpathSync(entryScript)).href === import.meta.url;
  } catch { /* an unreadable entry path is not this module */ }
  if (isEntry) void main();
}
