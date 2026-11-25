import { spawn } from "node:child_process";
import { runCollected, type CollectedProcess, type CollectedProcessOptions } from "./collected-process.js";
import type { ContainerExec } from "./devcontainer.js";

/** What `execBytes` takes: bytes on stdin, and a hard cap on the bytes it keeps from stdout. */
export interface DockerExecBytesOptions {
  stdin?: Buffer;
  /**
   * Environment variables for the docker CLI process itself, added to the worker's own (`docker run -e NAME` passes `NAME` on to the container from here, so the value is never an argument of the command line). Absent: the
   * worker's environment unchanged.
   */
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes: number;
}

/** The raw result of `execBytes`: stdout is exact (never redacted or cut), and `tooLarge` says the cap ended the process. */
export interface DockerExecBytesResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
  tooLarge?: boolean;
}

/** The Docker CLI, as a seam for tests. */
export interface DockerCli {
  run(args: readonly string[], options?: CollectedProcessOptions): Promise<CollectedProcess>;
  /**
   * Runs `docker <args>` with bytes on stdin and returns stdout as exact bytes: the agent's file tools read and write
   * through it (file-ops-exec.ts), where `run`'s redaction and 1 MiB cut would corrupt a file. Absent in fakes that do not
   * serve file tools.
   */
  execBytes?(args: readonly string[], options: DockerExecBytesOptions): Promise<DockerExecBytesResult>;
}

export function createDockerCli(): DockerCli {
  return { run: (args, options) => runCollected("docker", args, options ?? {}), execBytes: dockerExecBytes };
}

function dockerExecBytes(args: readonly string[], options: DockerExecBytesOptions): Promise<DockerExecBytesResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      resolvePromise({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", aborted: true });
      return;
    }
    const child = spawn("docker", [...args], { stdio: ["pipe", "pipe", "pipe"], ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }) });
    const chunks: Buffer[] = [];
    let kept = 0;
    let stderr = "";
    let tooLarge = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (result: DockerExecBytesResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const stop = (): void => { if (!child.killed) child.kill("SIGKILL"); };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const onAbort = (): void => { aborted = true; stop(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      kept += chunk.length;
      if (kept > options.maxStdoutBytes) { tooLarge = true; stop(); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192); });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); if (!settled) { settled = true; reject(error); } });
    child.on("close", (exitCode) => finish({
      exitCode, stdout: Buffer.concat(chunks), stderr,
      ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}), ...(tooLarge ? { tooLarge } : {}),
    }));
    child.stdin.end(options.stdin);
  });
}

/** `docker exec` in the task container, for the agent's shell. */
export function taskContainerExec(docker: DockerCli, name: string): ContainerExec {
  return (command, options) => docker.run([
    "exec",
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    name, ...command,
  ], {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  });
}
