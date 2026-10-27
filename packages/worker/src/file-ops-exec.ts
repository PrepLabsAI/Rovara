import { z } from "zod";
import { agentXError } from "@agentx/contracts";
import type { DevcontainerPaths } from "./devcontainer.js";
import type { FileMount } from "./devcontainer-file-paths.js";
import { MAX_REQUEST_ARGUMENT_BYTES, type FileOpsErrorCode, type SandboxFileRequest, type SandboxFileResponse } from "./sandbox-file-ops.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";

/**
 * Where the agent's file tools run: inside a container, as a user, with a Node and the helper (sandbox-file-ops.ts) that
 * the container itself holds. Never in the worker.
 */
export interface FileOpsTarget {
  /** The container's name or ID. */
  container: string;
  /** `docker exec --user`: the sandbox's `1000:1000`, or the devcontainer's `remoteUser`. */
  user: string;
  /** An absolute path in the container; never `node` from its PATH. */
  node: string;
  /** The helper's absolute path in the container. */
  helper: string;
  /** The folder the helper is confined to when a request names none of its own. */
  root: string;
  /** A devcontainer's bind mounts under the workspace (devcontainer-file-paths.ts). Set means paths are mapped host to container. */
  mounts?: FileMount[];
  /** In the fallback sandbox of a devcontainer task: the repository's container folder, which the agent may still name. */
  paths?: DevcontainerPaths;
  /** Test seam; default: the host's `docker`. */
  docker?: DockerCli;
}

/**
 * Flags for the container's Node: V8 switches a regular expression to its linear-time engine when it backtracks too much, so
 * most catastrophic patterns finish at once (the helper's deadline catches the rest).
 */
export const FILE_OPS_NODE_FLAGS = ["--enable-experimental-regexp-engine-on-excessive-backtracks"] as const;

/**
 * `docker exec` options that clear what a container's own environment could add to the helper's Node (extra options, extra
 * module folders): the helper runs with the Node it was given and nothing the container sets.
 */
export const FILE_OPS_ENVIRONMENT_RESET = ["-e", "NODE_OPTIONS=", "-e", "NODE_PATH="] as const;

/** How long one helper call may take, and how much of its reply is kept (larger is TOO_LARGE). */
export const FILE_OPS_TIMEOUT_MS = 60_000;
export const FILE_OPS_MAX_REPLY_BYTES = 16 * 1024 * 1024;

const CODES = ["ENOENT", "EISDIR", "ENOTDIR", "OUTSIDE", "EACCES", "TOO_LARGE", "INVALID", "PATTERN_TOO_SLOW"] as const satisfies readonly FileOpsErrorCode[];
const EmptySchema = z.object({}).strict();
const ResultSchemas = {
  readFile: z.object({ contentBase64: z.string() }),
  access: EmptySchema,
  stat: z.object({ type: z.enum(["file", "dir", "other"]), size: z.number(), mtimeMs: z.number(), mode: z.number() }),
  readdir: z.object({ entries: z.array(z.object({ name: z.string(), kind: z.enum(["dir", "file", "gone"]) })) }),
  exists: z.object({ exists: z.boolean() }),
  writeFile: EmptySchema,
  mkdir: EmptySchema,
  sweep: z.object({ removed: z.number() }),
  countLines: z.object({ lineCount: z.number() }),
  glob: z.object({ paths: z.array(z.string()) }),
  grep: z.object({
    searchIsDirectory: z.boolean(),
    limitReached: z.boolean(),
    blocks: z.array(z.object({ path: z.string(), lines: z.array(z.object({ n: z.number(), text: z.string(), match: z.boolean() })) })),
  }),
} as const satisfies Record<SandboxFileRequest["op"], z.ZodType>;
const FailureSchema = z.object({ ok: z.literal(false), code: z.enum(CODES), message: z.string() });
const SuccessSchema = z.object({ ok: z.literal(true), result: z.unknown() });

export type FileOpsResult<Op extends SandboxFileRequest["op"]> = z.infer<(typeof ResultSchemas)[Op]>;
export type FileOpsFailure = Extract<SandboxFileResponse, { ok: false }>;
export type FileOpsReply<Op extends SandboxFileRequest["op"]> = { ok: true; result: FileOpsResult<Op> } | FileOpsFailure;

/**
 * Runs the helper in the target's container with `docker exec -i`. The request travels as one base64url JSON argument (paths
 * and patterns only, at most 16 KiB), a write's content on stdin, and the reply comes back as one JSON line on stdout. The
 * container is untrusted: a reply that is not what the helper sends is an error, never a result.
 */
export async function fileOpsExec<Op extends SandboxFileRequest["op"]>(
  target: FileOpsTarget,
  request: Extract<SandboxFileRequest, { op: Op }>,
  stdin?: Buffer,
  signal?: AbortSignal,
): Promise<FileOpsReply<Op>> {
  const argument = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  if (Buffer.byteLength(argument, "utf8") > MAX_REQUEST_ARGUMENT_BYTES) {
    return { ok: false, code: "INVALID", message: `the request is longer than ${MAX_REQUEST_ARGUMENT_BYTES} bytes once encoded; use a shorter path or pattern` };
  }
  const docker = target.docker ?? defaultDocker();
  if (docker.execBytes === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX has no way to run the file tools in the task's container");
  const reply = await docker.execBytes(
    ["exec", "-i", "--user", target.user, ...FILE_OPS_ENVIRONMENT_RESET, target.container, target.node, ...FILE_OPS_NODE_FLAGS, target.helper, argument],
    { ...(stdin === undefined ? {} : { stdin }), ...(signal === undefined ? {} : { signal }), timeoutMs: FILE_OPS_TIMEOUT_MS, maxStdoutBytes: FILE_OPS_MAX_REPLY_BYTES },
  );
  if (reply.aborted === true || signal?.aborted === true) throw new FileOpsInterruptedError("aborted");
  if (reply.timedOut === true) throw new FileOpsInterruptedError(`the file operation timed out after ${FILE_OPS_TIMEOUT_MS / 1_000} s`);
  if (reply.tooLarge === true) return { ok: false, code: "TOO_LARGE", message: "the result is larger than 16 MiB" };
  if (reply.exitCode !== 0) {
    const detail = reply.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new Error(`the file tools could not run in the task's container (exit ${String(reply.exitCode)})${detail === "" ? "" : `: ${detail}`}`);
  }
  const line = reply.stdout.toString("utf8").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("the file tools in the task's container sent a reply that is not JSON"); }
  const failure = FailureSchema.safeParse(parsed);
  if (failure.success) return failure.data;
  const success = SuccessSchema.safeParse(parsed);
  const result = success.success ? ResultSchemas[request.op].safeParse(success.data.result) : undefined;
  if (result === undefined || !result.success) throw new Error("the file tools in the task's container sent a reply that is not what they send");
  return { ok: true, result: result.data as FileOpsResult<Op> };
}

/** A helper call that did not finish (a timeout or an abort), so a temporary file may be left behind (the worker sweeps). */
export class FileOpsInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileOpsInterruptedError";
  }
}

let shared: DockerCli | undefined;
function defaultDocker(): DockerCli {
  shared ??= createDockerCli();
  return shared;
}
