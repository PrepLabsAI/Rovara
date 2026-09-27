import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
  type ProjectCommand,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { CommandResult } from "./readiness.js";

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const UP_TIMEOUT_MS = 20 * 60_000;

/**
 * Where a project's devcontainer runs (#121). The whole workspace is mounted into the container at
 * the same path as on the host, so a path means the same file to the worker, the agent's file
 * tools and a command in the container.
 */
export interface DevcontainerTarget {
  rootPath: string;
  workspaceFolder: string;
  configPath: string;
}

export interface DevcontainerUpResult {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

export interface DevcontainerProcess {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The `devcontainer` CLI, as a seam for tests. */
export interface DevcontainerCli {
  run(
    args: readonly string[],
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onStdout?: (data: Buffer) => void;
      onStderr?: (data: Buffer) => void;
    },
  ): Promise<DevcontainerProcess>;
}

export function devcontainerTarget(rootPath: string, project: StoredProjectDefinition): DevcontainerTarget | undefined {
  const devcontainer = project.devcontainer;
  if (devcontainer === undefined) return undefined;
  const repository = project.repositories.find((entry) => entry.name === devcontainer.repository);
  if (repository === undefined) throw new Error(`devcontainer names unregistered repository ${devcontainer.repository}`);
  const workspaceFolder = contained(rootPath, repository.path);
  return {
    rootPath,
    workspaceFolder,
    configPath: contained(workspaceFolder, devcontainer.configPath ?? DEFAULT_DEVCONTAINER_CONFIG_PATH),
  };
}

/** The devcontainer a prepared workspace recorded, from its preparation manifest. */
export function preparedDevcontainerTarget(
  rootPath: string,
  manifest: {
    devcontainer?: { repository: string; configPath: string };
    repositories: ReadonlyArray<{ name: string; path: string }>;
  },
): DevcontainerTarget | undefined {
  if (manifest.devcontainer === undefined) return undefined;
  const { repository: name, configPath } = manifest.devcontainer;
  const repository = manifest.repositories.find((entry) => entry.name === name);
  if (repository === undefined) throw new Error(`devcontainer repository ${name} is not in the workspace`);
  return { rootPath, workspaceFolder: contained(rootPath, repository.path), configPath: contained(rootPath, configPath) };
}

/**
 * Creates the devcontainer, or starts the existing one (on a resumed instance its containers are
 * stopped), and runs its lifecycle commands. Idempotent.
 */
export async function ensureDevcontainer(cli: DevcontainerCli, target: DevcontainerTarget): Promise<DevcontainerUpResult> {
  const result = await cli.run([
    "up",
    ...targetArgs(target),
    "--mount", `type=bind,source=${target.rootPath},target=${target.rootPath}`,
    "--log-format", "json",
  ], { timeoutMs: UP_TIMEOUT_MS });
  const outcome = lastJsonLine(result.stdout);
  if (result.exitCode === 0 && outcome?.outcome === "success" && typeof outcome.containerId === "string") {
    return {
      containerId: outcome.containerId,
      remoteUser: typeof outcome.remoteUser === "string" ? outcome.remoteUser : "",
      remoteWorkspaceFolder: typeof outcome.remoteWorkspaceFolder === "string" ? outcome.remoteWorkspaceFolder : "",
    };
  }
  const reason = [outcome?.message, outcome?.description].filter((part) => typeof part === "string").join(": ");
  throw new Error(`devcontainer did not start${reason ? `: ${reason}` : ` (exit ${String(result.exitCode)})`}`);
}

/** A project command (`setup` or `readiness`) run in the devcontainer, in its workspace directory. */
export async function runDevcontainerCommand(
  cli: DevcontainerCli,
  target: DevcontainerTarget,
  command: ProjectCommand,
): Promise<CommandResult> {
  const cwd = contained(target.rootPath, command.cwd);
  const result = await cli.run([
    "exec", ...targetArgs(target),
    "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", cwd, command.executable, ...command.args,
  ], { timeoutMs: command.timeoutSeconds * 1_000 });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The agent's shell in the devcontainer. The command runs in its own process group, whose ID it
 * records, so that an abort or timeout stops it inside the container: stopping the local
 * `devcontainer exec` client alone would leave it running there.
 */
export function devcontainerBashOperations(cli: DevcontainerCli, target: DevcontainerTarget): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      const groupFile = `/tmp/agentx-shell-${randomUUID()}.pgid`;
      let stopping: Promise<unknown> | undefined;
      // bash, not sh: dash's kill does not take a negative process group ID.
      const stop = () => {
        stopping ??= cli.run(["exec", ...targetArgs(target), "bash", "-c", 'kill -TERM -- "-$(cat "$1")" 2>/dev/null; rm -f "$1"', "bash", groupFile], {})
          .catch(() => undefined);
      };
      const controller = new AbortController();
      let timedOut = false;
      const timer = timeout !== undefined && timeout > 0
        ? setTimeout(() => { timedOut = true; stop(); controller.abort(); }, timeout * 1_000)
        : undefined;
      const onAbort = () => { stop(); controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await cli.run([
          "exec", ...targetArgs(target), ...sessionEnvironment(env),
          "bash", "-c",
          // Job control only while starting the command, which puts it in its own process group;
          // left on, bash would also print a "Done" line into the output.
          'set -m; (cd -- "$1" && eval "$2") & child=$!; set +m; echo "$child" > "$3"; wait "$child"; status=$?; rm -f "$3"; exit "$status"',
          "bash", cwd, command, groupFile,
        ], { signal: controller.signal, onStdout: onData, onStderr: onData });
        await stopping;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${String(timeout)}`);
        return { exitCode: result.exitCode };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** The `devcontainer` CLI bundled with the worker, run with this Node. */
export function createDevcontainerCli(): DevcontainerCli {
  const require = createRequire(import.meta.url);
  const script = resolve(dirname(require.resolve("@devcontainers/cli/package.json")), "devcontainer.js");
  return {
    run(args, options) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
          killSignal: "SIGTERM",
        });
        const stdout = boundedCollector();
        const stderr = boundedCollector();
        child.stdout.on("data", (data: Buffer) => { stdout.add(data); options.onStdout?.(data); });
        child.stderr.on("data", (data: Buffer) => { stderr.add(data); options.onStderr?.(data); });
        child.on("error", (error) => {
          if (error.name === "AbortError") resolvePromise({ exitCode: null, stdout: stdout.text(), stderr: stderr.text() });
          else reject(error);
        });
        child.on("close", (code) => resolvePromise({ exitCode: code, stdout: stdout.text(), stderr: stderr.text() }));
      });
    },
  };
}

function targetArgs(target: DevcontainerTarget): string[] {
  return ["--workspace-folder", target.workspaceFolder, "--config", target.configPath];
}

/** pi's PI_* session variables, which its shell tool exposes to commands. */
function sessionEnvironment(env: NodeJS.ProcessEnv | undefined): string[] {
  return Object.entries(env ?? {})
    .filter(([name, value]) => name.startsWith("PI_") && value !== undefined)
    .flatMap(([name, value]) => ["--remote-env", `${name}=${String(value)}`]);
}

function lastJsonLine(output: string): Record<string, unknown> | undefined {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // The CLI's own log lines precede the result.
    }
  }
  return undefined;
}

function boundedCollector(): { add(data: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    add(data) {
      if (size >= MAX_COMMAND_OUTPUT_BYTES) return;
      const kept = data.subarray(0, MAX_COMMAND_OUTPUT_BYTES - size);
      chunks.push(kept);
      size += kept.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function contained(parent: string, path: string): string {
  if (isAbsolute(path)) throw new Error("devcontainer path must be relative");
  const candidate = resolve(parent, path);
  const fromParent = relative(parent, candidate);
  if (fromParent === ".." || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) {
    throw new Error("devcontainer path escapes its workspace");
  }
  return candidate;
}
