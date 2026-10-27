import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  truncateHead,
  truncateLine,
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { hostPath as devcontainerHostPath } from "./devcontainer.js";
import { notMountedMessage, type FileMount, toContainerPath, toHostPath, virtualDirectoryEntries } from "./devcontainer-file-paths.js";
import { FileOpsInterruptedError, fileOpsExec, type FileOpsReply, type FileOpsResult, type FileOpsTarget } from "./file-ops-exec.js";
import type { SandboxFileRequest } from "./sandbox-file-ops.js";

/** The names of the six Pi file tools these definitions replace. `bash` is not one of them. */
export const FILE_TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls"] as const;
type FileToolName = (typeof FILE_TOOL_NAMES)[number];

const GREP_DEFAULT_LIMIT = 100;
/** Pi's `GREP_MAX_LINE_LENGTH`, which Pi does not export. */
const GREP_MAX_LINE_LENGTH = 500;

/** An error with a Node-style `code`, the way Pi's own tools fail, so Pi's messages for it read the same. */
class FileToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FileToolError";
    this.code = code;
  }
}

interface ToolEnvironment {
  target: FileOpsTarget;
  cwd: string;
}

type Mapped = { path: string; root: string };
type RequestWithoutRoot<Op extends SandboxFileRequest["op"]> = Omit<Extract<SandboxFileRequest, { op: Op }>, "root">;

function absolute(path: string, cwd: string): string {
  const stripped = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(stripped) ? posix.normalize(stripped) : resolve(cwd, stripped);
}

/**
 * The host path the agent used, as the path and root the helper gets. In a devcontainer that is the same place under the
 * mount that holds it, and a path no mount holds is NOT_MOUNTED, refused without a call. In the task sandbox the
 * workspace is at its host path, so a path passes unchanged (a container path of the repository maps to the host one).
 */
function map(env: ToolEnvironment, path: string): Mapped {
  const { target } = env;
  if (target.mounts !== undefined) {
    const mapped = toContainerPath(target.mounts, env.cwd, path);
    // A search or listing with no path means the working folder, the workspace root, which is not a mount. It defaults to the
    // repository's mount, as the agent's shell sees it; any other workspace-level path stays NOT_MOUNTED.
    if ("notMounted" in mapped && absolute(path, env.cwd) === posix.normalize(env.cwd)) {
      const repository = repositoryMount(target);
      if (repository !== undefined) return { path: repository.containerPath, root: repository.containerPath };
    }
    if ("notMounted" in mapped) throw new FileToolError("NOT_MOUNTED", notMountedMessage(mapped.notMounted, target.mounts));
    return { path: mapped.containerPath, root: mapped.mountRoot };
  }
  const known = target.paths === undefined ? path : devcontainerHostPath(target.paths, path);
  return { path: absolute(known, env.cwd), root: target.root };
}

/** The mount of the devcontainer's repository: the one at its workspace folder, or the only mount there is. */
function repositoryMount(target: FileOpsTarget): FileMount | undefined {
  const mounts = target.mounts ?? [];
  return mounts.find((mount) => mount.containerPath === target.root) ?? (mounts.length === 1 ? mounts[0] : undefined);
}

function backToHost(env: ToolEnvironment, containerPath: string): string {
  return env.target.mounts === undefined ? containerPath : toHostPath(env.target.mounts, containerPath);
}

/** What the agent is told when the helper refuses. */
function refusal(code: string, message: string, shown: string): FileToolError {
  switch (code) {
    case "OUTSIDE": return new FileToolError("OUTSIDE", `${shown} is outside the workspace`);
    case "EACCES": return new FileToolError("EACCES", `${shown} can't be read or changed by the agent's file tools: the file's owner or permissions don't allow it. Use bash to change it, or check who created it.`);
    case "ENOENT": return new FileToolError("ENOENT", `ENOENT: no such file or directory, '${shown}'`);
    case "EISDIR": return new FileToolError("EISDIR", `EISDIR: illegal operation on a directory, '${shown}'`);
    case "ENOTDIR": return new FileToolError("ENOTDIR", `ENOTDIR: not a directory, '${shown}'`);
    case "PATTERN_TOO_SLOW": return new FileToolError("PATTERN_TOO_SLOW", message);
    case "TOO_LARGE": return new FileToolError("TOO_LARGE", `${shown}: ${message}. Use bash (head, tail or sed -n) to work with part of it.`);
    default: return new FileToolError("INVALID", message);
  }
}

/** Runs one request in the target's container for the host path `path`; a refusal or a failure is thrown as the agent should read it. */
async function call<Op extends SandboxFileRequest["op"]>(
  env: ToolEnvironment,
  path: string,
  request: (mapped: Mapped) => RequestWithoutRoot<Op>,
  options: { stdin?: Buffer; signal?: AbortSignal } = {},
): Promise<FileOpsResult<Op>> {
  const mapped = map(env, path);
  const full = { root: mapped.root, ...request(mapped) } as unknown as Extract<SandboxFileRequest, { op: Op }>;
  let reply: FileOpsReply<Op>;
  try {
    reply = await fileOpsExec<Op>(env.target, full, options.stdin, options.signal);
  } catch (error) {
    // A helper killed by the timeout or an abort cannot clean up: sweep what an atomic write may have left.
    if (error instanceof FileOpsInterruptedError && full.op === "writeFile") await sweepAround(env, path);
    throw error;
  }
  if (reply.ok) return reply.result;
  if (full.op === "writeFile") await sweepAround(env, path);
  throw refusal(reply.code, reply.message, path);
}

async function sweepAround(env: ToolEnvironment, filePath: string): Promise<void> {
  await sweepFileOps(env.target, env.cwd, dirname(filePath)).catch(() => undefined);
}

/**
 * Removes the `.agentx-file-ops-*` files a killed write left under `folder` (a host path), in the target's container. The
 * worker calls it after a file-tool error or timeout, at a sandbox's start and before every candidate snapshot. A folder no
 * mount holds has nothing to sweep.
 */
export async function sweepFileOps(target: FileOpsTarget, cwd: string, folder: string): Promise<number> {
  const env: ToolEnvironment = { target, cwd };
  let mapped: Mapped;
  try { mapped = map(env, folder); } catch { return 0; }
  const reply = await fileOpsExec(target, { root: mapped.root, op: "sweep", path: mapped.path });
  return reply.ok ? reply.result.removed : 0;
}

// --- Pi operations ------------------------------------------------------------------------------------------------------

const IMAGE_SIGNATURES: ReadonlyArray<{ mime: string; test: (head: Buffer) => boolean }> = [
  { mime: "image/png", test: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mime: "image/gif", test: (head) => head.subarray(0, 4).toString("latin1") === "GIF8" },
  { mime: "image/webp", test: (head) => head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" },
];

function readOperations(env: ToolEnvironment, writable: boolean): ReadOperations & EditOperations {
  const read = async (path: string): Promise<Buffer> =>
    Buffer.from((await call<"readFile">(env, path, (mapped) => ({ op: "readFile", path: mapped.path }))).contentBase64, "base64");
  return {
    readFile: read,
    access: async (path) => { await call<"access">(env, path, (mapped) => ({ op: "access", path: mapped.path, ...(writable ? { write: true } : {}) })); },
    writeFile: async (path, content) => { await writeBytes(env, path, Buffer.from(content, "utf8")); },
    detectImageMimeType: async (path) => {
      try {
        const head = Buffer.from((await call<"readFile">(env, path, (mapped) => ({ op: "readFile", path: mapped.path, head: 16 }))).contentBase64, "base64");
        return IMAGE_SIGNATURES.find((signature) => signature.test(head))?.mime ?? null;
      } catch {
        return null;
      }
    },
  };
}

async function writeBytes(env: ToolEnvironment, path: string, content: Buffer, signal?: AbortSignal): Promise<void> {
  await call<"writeFile">(env, path, (mapped) => ({ op: "writeFile", path: mapped.path, size: content.length }), { stdin: content, ...(signal === undefined ? {} : { signal }) });
}

function writeOperations(env: ToolEnvironment): WriteOperations {
  return {
    writeFile: async (path, content) => { await writeBytes(env, path, Buffer.from(content, "utf8")); },
    mkdir: async (path) => { await call<"mkdir">(env, path, (mapped) => ({ op: "mkdir", path: mapped.path })); },
  };
}

function lsOperations(env: ToolEnvironment): LsOperations {
  // `ls` stats every entry it lists; the listing already says which are directories, so those answers are kept for it.
  const kinds = new Map<string, "dir" | "file" | "gone">();
  // In a devcontainer the folders above the mounts (the workspace root) are no mount: they list the mounted folders, so the
  // agent sees `api/` and goes on to `api/src/a.ts`, which the other tools map.
  const virtual = (path: string): string[] | undefined =>
    env.target.mounts === undefined ? undefined : virtualDirectoryEntries(env.target.mounts, absolute(path, env.cwd));
  return {
    exists: async (path) => virtual(path) !== undefined || (await call<"exists">(env, path, (mapped) => ({ op: "exists", path: mapped.path }))).exists,
    stat: async (path) => {
      const known = kinds.get(path);
      if (known !== undefined) {
        kinds.delete(path);
        if (known === "gone") throw new FileToolError("ENOENT", `ENOENT: no such file or directory, '${path}'`);
        return { isDirectory: () => known === "dir" };
      }
      if (virtual(path) !== undefined) return { isDirectory: () => true };
      const stat = await call<"stat">(env, path, (mapped) => ({ op: "stat", path: mapped.path }));
      return { isDirectory: () => stat.type === "dir" };
    },
    readdir: async (path) => {
      const names = virtual(path);
      if (names !== undefined) {
        kinds.clear();
        for (const name of names) kinds.set(join(path, name), "dir");
        return names;
      }
      const { entries } = await call<"readdir">(env, path, (mapped) => ({ op: "readdir", path: mapped.path }));
      kinds.clear();
      for (const entry of entries) kinds.set(join(path, entry.name), entry.kind);
      return entries.map((entry) => entry.name);
    },
  };
}

function findOperations(env: ToolEnvironment): FindOperations {
  return {
    exists: async (path) => (await call<"exists">(env, path, (mapped) => ({ op: "exists", path: mapped.path }))).exists,
    glob: async (pattern, cwd, options) => {
      const { paths } = await call<"glob">(env, cwd, (mapped) => ({ op: "glob", pattern, cwd: mapped.path, ignore: options.ignore, limit: options.limit }));
      return paths.map((path) => backToHost(env, path));
    },
  };
}

// --- grep ---------------------------------------------------------------------------------------------------------------

/** Pi's grep (name, input schema, output format), searching in the container: Pi's own spawns ripgrep in the worker. */
function grepTool(env: ToolEnvironment, cwd: string): ToolDefinition {
  const pi = createGrepToolDefinition(cwd) as unknown as ToolDefinition;
  return {
    ...pi,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const input = params as { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number };
      const base = (ctx as { cwd?: string } | undefined)?.cwd ?? cwd;
      const searchPath = absolute(input.path === undefined || input.path === "" ? "." : input.path, base);
      const effectiveLimit = Math.max(1, input.limit ?? GREP_DEFAULT_LIMIT);
      const contextValue = input.context !== undefined && input.context > 0 ? input.context : 0;
      let found: FileOpsResult<"grep">;
      try {
        found = await call<"grep">(env, searchPath, (mapped) => ({
          op: "grep", pattern: input.pattern, path: mapped.path, limit: effectiveLimit,
          ...(input.glob === undefined ? {} : { glob: input.glob }),
          ...(input.ignoreCase === undefined ? {} : { ignoreCase: input.ignoreCase }),
          ...(input.literal === undefined ? {} : { literal: input.literal }),
          ...(contextValue > 0 ? { context: contextValue } : {}),
        }), { ...(signal === undefined ? {} : { signal }) });
      } catch (error) {
        if (error instanceof FileToolError && error.code === "ENOENT") throw new Error(`Path not found: ${searchPath}`, { cause: error });
        throw error;
      }
      if (found.blocks.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      const formatPath = (filePath: string): string => {
        if (found.searchIsDirectory) {
          const relativePath = relative(searchPath, filePath);
          if (relativePath !== "" && !relativePath.startsWith("..")) return relativePath.replace(/\\/gu, "/");
        }
        return basename(filePath);
      };
      let linesTruncated = false;
      const output: string[] = [];
      for (const block of found.blocks) {
        const shown = formatPath(backToHost(env, block.path));
        for (const line of block.lines) {
          const { text, wasTruncated } = truncateLine(line.text.replace(/\r/gu, ""), GREP_MAX_LINE_LENGTH);
          if (wasTruncated) linesTruncated = true;
          output.push(line.match ? `${shown}:${line.n}: ${text}` : `${shown}-${line.n}- ${text}`);
        }
      }
      const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let text = truncation.content;
      const details: Record<string, unknown> = {};
      const notices: string[] = [];
      if (found.limitReached) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
      return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
    },
  } as ToolDefinition;
}

/**
 * The agent's file tools, run in the target's container (file-ops-exec.ts) instead of the worker: Pi's own `read`, `write`,
 * `edit`, `find` and `ls` with operations that call the helper, and AgentX's `grep`. They replace the built-ins of the same
 * name, for the names the session exposes.
 */
export function sandboxFileTools(input: { target: FileOpsTarget; cwd: string; names: readonly string[] }): ToolDefinition[] {
  const env: ToolEnvironment = { target: input.target, cwd: input.cwd };
  const builders: Record<FileToolName, () => ToolDefinition> = {
    read: () => createReadToolDefinition(input.cwd, { operations: readOperations(env, false) }) as unknown as ToolDefinition,
    write: () => createWriteToolDefinition(input.cwd, { operations: writeOperations(env) }) as unknown as ToolDefinition,
    edit: () => createEditToolDefinition(input.cwd, { operations: readOperations(env, true) }) as unknown as ToolDefinition,
    grep: () => grepTool(env, input.cwd),
    find: () => createFindToolDefinition(input.cwd, { operations: findOperations(env) }) as unknown as ToolDefinition,
    ls: () => createLsToolDefinition(input.cwd, { operations: lsOperations(env) }) as unknown as ToolDefinition,
  };
  return input.names.filter((name): name is FileToolName => (FILE_TOOL_NAMES as readonly string[]).includes(name)).map((name) => builders[name]());
}
