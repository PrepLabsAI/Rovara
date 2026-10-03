import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
  type ProjectCommand,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { runCollected, TIMEOUT_KILL_GRACE_MS } from "./collected-process.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "./git.js";
import type { CommandResult } from "./readiness.js";

const UP_TIMEOUT_MS = 20 * 60_000;
/** How long one exec that signals a command's process group in the container may take (#174). */
const KILL_EXEC_TIMEOUT_MS = 10_000;
/**
 * How much longer than a command's own timeout its local client may run: the grace period before
 * KILL, then this. A safety net for a client that the stop sequence did not end (#174).
 */
const CLIENT_TIMEOUT_MARGIN_MS = 10_000;
/** What a container without bash says when an exec asks for it (Docker, then Podman/crun) (#174). */
const NO_BASH = /exec: "bash": executable file not found|executable file `bash` not found/;
const NO_BASH_MESSAGE = "the container has no bash, which AgentX needs to run commands in it; add bash to its image";
/**
 * Sends SIGTERM to the command's process group. It waits up to 5 s for the group file, which the
 * wrapper writes only once the command has started, and keeps the group ID in "$1.stop": the wrapper
 * removes the group file as soon as the group leader exits, and the KILL step still needs the ID.
 * Only "No such process" counts as a group already gone; any other kill error (such as "Operation
 * not permitted" for a group running as root) is printed and fails the exec.
 */
const TERM_SCRIPT = 'for _ in {1..50}; do [ -s "$1" ] && break; sleep 0.1; done; p=$(cat "$1" 2>/dev/null) || exit 0; case "$p" in ""|*[!0-9]*) exit 0;; esac; echo "$p" > "$1.stop"; out=$(kill -TERM -- "-$p" 2>&1) && exit 0; case "$out" in *"No such process"*) exit 0;; esac; echo "$out"; exit 1';
/** Sends SIGKILL to what is left of the process group, if anything, and removes both files. */
const KILL_SCRIPT = 'p=$(cat "$1.stop" 2>/dev/null || cat "$1" 2>/dev/null); rm -f "$1" "$1.stop"; case "$p" in ""|*[!0-9]*) exit 0;; esac; out=$(kill -KILL -- "-$p" 2>&1) && exit 0; case "$out" in *"No such process"*) exit 0;; esac; echo "$out"; exit 1';

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
  /** The signal that ended the CLI, when one did (#154). */
  signal?: string;
  /** True when the command's timeout stopped the CLI (#154). */
  timedOut?: boolean;
}

/**
 * The repository's folder in the devcontainer, where the project's own config mounts it (for example
 * `/workspaces/sample-project-a`), and the same folder in the worker. The shell sees both; the file
 * tools, which run in the worker, see only the host folder (#128).
 */
export interface DevcontainerPaths {
  hostFolder: string;
  containerFolder: string;
}

/** The two folders, or undefined when the devcontainer mounts the repository at its host path. */
export function devcontainerPaths(target: DevcontainerTarget, started: DevcontainerUpResult): DevcontainerPaths | undefined {
  const containerFolder = started.remoteWorkspaceFolder.replace(/\/+$/, "");
  if (!isAbsolute(containerFolder) || containerFolder === "" || containerFolder === target.workspaceFolder) return undefined;
  return { hostFolder: target.workspaceFolder, containerFolder };
}

/**
 * The agent's shell is the container's, so it writes `cd /workspaces/repo && npm test`, a path only the container has.
 * AgentX replays from the workspace root, where that folder is `<host folder relative to root>`, so a leading
 * `cd <containerFolder>[/sub] &&` reads as `cd <relative>[/sub] &&` (spec 051 Ruling X, and the same for coding tasks).
 * Only that exact folder, then a `/` or a space, so `/workspaces/repoX` stays out. The test-command matcher then
 * applies its own safe-path rule to what is left (no `..`, no absolute path), and the replay's realpath containment
 * refuses a link out of the workspace. A host folder outside `root` is never rewritten.
 */
export function workspaceRelativeCommand(command: string, paths: DevcontainerPaths, root: string): string {
  const base = relative(root, paths.hostFolder);
  if (base === ".." || base.startsWith(`..${sep}`) || isAbsolute(base)) return command;
  // D-15 (#290): the host folder too. devcontainerContextFile tells the agent both paths name the same files and to
  // prefer the host one, so `cd <hostFolder> && pytest` must count as the same check.
  for (const folder of [paths.containerFolder, paths.hostFolder]) {
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rewritten = command.replace(new RegExp(`^( *)cd +${escaped}(?=/| )(/?\\S*)( +&& +)`, "s"), (_match, lead: string, sub: string, join: string) => {
      const target = `${base}${sub}`;
      return target === "" ? lead : `${lead}cd ${target}${join}`;
    });
    if (rewritten !== command) return rewritten;
  }
  return command;
}

/** A path under the container folder, as the same file under the host folder; any other path as given. */
export function hostPath(paths: DevcontainerPaths, path: string): string {
  if (path === paths.containerFolder) return paths.hostFolder;
  if (path.startsWith(`${paths.containerFolder}/`)) return `${paths.hostFolder}${path.slice(paths.containerFolder.length)}`;
  return path;
}

/** What the agent is told, so it knows both paths name the same files. */
export function devcontainerContextFile(paths: DevcontainerPaths): { path: string; content: string } {
  return {
    path: "AgentX devcontainer",
    content: [
      "Shell commands (the bash tool) run inside this project's devcontainer.",
      `The repository is at ${paths.hostFolder}. Inside the devcontainer it is also at ${paths.containerFolder}.`,
      "Both paths name the same files, in the file tools and in the shell; prefer the first.",
    ].join("\n"),
  };
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
  if (result.timedOut === true) throw new Error(`devcontainer did not start: timed out after ${UP_TIMEOUT_MS / 60_000} min`);
  const reason = [outcome?.message, outcome?.description].filter((part) => typeof part === "string").join(": ");
  throw new Error(`devcontainer did not start${reason ? `: ${reason}` : ` (exit ${String(result.exitCode)})`}`);
}

/**
 * A project command (`setup` or `readiness`) run in the devcontainer, in its workspace directory. It
 * runs in its own process group in the container, so its timeout stops it there too (#174), and so
 * does `signal` (spec 051, a check rerun): the abort ends the local client at once.
 */
export async function runDevcontainerCommand(
  cli: DevcontainerCli,
  target: DevcontainerTarget,
  command: ProjectCommand,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const cwd = contained(target.rootPath, command.cwd);
  const run = await runInContainerGroup(devcontainerExec(cli, target), {
    groupFilePrefix: "agentx-command",
    // The executable and its arguments stay positional parameters: no shell reads them again.
    body: 'exec "$@"',
    cwd,
    args: [command.executable, ...command.args],
    timeoutMs: command.timeoutSeconds * 1_000,
    // The command's own variables (#54) reach the command only, never the TERM and KILL execs.
    ...(command.env !== undefined ? { env: { ...command.env } } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const { result } = run;
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: withStopFailures(result.stderr, run.stopFailures),
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    ...(run.timedOut || result.timedOut === true ? { timedOut: true } : {}),
  };
}

/** The command's stderr, then a line for each step of the stop sequence that failed. */
function withStopFailures(stderr: string, failures: readonly string[]): string {
  if (failures.length === 0) return stderr;
  return [...(stderr === "" ? [] : [stderr.replace(/\n$/, "")]), ...failures].join("\n");
}

/**
 * The agent's shell in the devcontainer. The command runs in its own process group, whose ID it
 * records, so that an abort or timeout stops it inside the container: stopping the local
 * `devcontainer exec` client alone would leave it running there.
 */
export function devcontainerBashOperations(cli: DevcontainerCli, target: DevcontainerTarget): BashOperations {
  return containerBashOperations(devcontainerExec(cli, target));
}

/**
 * Runs one command in a container: `devcontainer exec` for a project's devcontainer, `docker exec`
 * for a SWE-bench task container (spec 043).
 */
export type ContainerExec = (
  command: readonly string[],
  options: {
    env?: Record<string, string>;
    /** A local safety net: how long the exec client may run. */
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdout?: (data: Buffer) => void;
    onStderr?: (data: Buffer) => void;
  },
) => Promise<DevcontainerProcess>;

/**
 * The agent's shell in a container, each command in its own process group (see devcontainerBashOperations).
 * A timeout reports back after the stop sequence: the TERM exec, the 5 s grace period, then the KILL
 * exec (each exec bounded at 10 s); an abort reports back at once.
 */
export function containerBashOperations(exec: ContainerExec): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      const run = await runInContainerGroup(exec, {
        groupFilePrefix: "agentx-shell",
        // The agent's command is shell text, so this shell reads it.
        body: 'eval "$1"',
        cwd,
        args: [command],
        ...(timeout !== undefined && timeout > 0 ? { timeoutMs: timeout * 1_000 } : {}),
        env: sessionEnvironment(env),
        ...(signal !== undefined ? { signal } : {}),
        onStdout: onData,
        onStderr: onData,
      });
      if (run.aborted) throw new Error("aborted");
      for (const failure of run.stopFailures) onData(Buffer.from(`\n${failure}\n`));
      if (run.timedOut) throw new Error(`timeout:${String(timeout)}`);
      return { exitCode: run.result.exitCode };
    },
  };
}

interface ContainerGroupCommand {
  /** The group file's name in the container's /tmp, before a random suffix. */
  groupFilePrefix: string;
  /** Shell code run in the command's directory, with the command's `args` as its positional parameters. */
  body: string;
  cwd: string;
  args: readonly string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

/**
 * Runs a command in a container in its own process group, whose ID goes to a file in the container's
 * /tmp. A timeout or an abort stops the group there, not just the local exec client (#174): one exec
 * sends the group SIGTERM, and TIMEOUT_KILL_GRACE_MS after it answers another sends SIGKILL to any
 * member still running (one that ignores SIGTERM, even once the group leader has exited) and removes
 * the files. Then the local client is aborted, if it is still running. Each kill exec may take
 * KILL_EXEC_TIMEOUT_MS. A timeout waits for the whole sequence and reports each step that failed in
 * `stopFailures`; an abort ends the local client at once and does not wait. bash, not sh: dash's kill
 * does not take a negative process group ID, so a container without bash fails with an error that says so.
 */
async function runInContainerGroup(
  exec: ContainerExec,
  command: ContainerGroupCommand,
): Promise<{ result: DevcontainerProcess; timedOut: boolean; aborted: boolean; stopFailures: string[] }> {
  const groupFile = `/tmp/${command.groupFilePrefix}-${randomUUID()}.pgid`;
  const controller = new AbortController();
  const stopFailures: string[] = [];
  const signalGroup = async (step: "TERM" | "KILL", script: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const failure = await Promise.race([
      exec(["bash", "-c", script, "bash", groupFile], { timeoutMs: KILL_EXEC_TIMEOUT_MS }).then(
        (result) => result.exitCode === 0 ? undefined : stopFailureReason(result),
        (error: unknown) => error instanceof Error ? error.message : "the exec could not run",
      ),
      new Promise<string>((resolveTimer) => {
        timer = setTimeout(() => resolveTimer(`no answer within ${KILL_EXEC_TIMEOUT_MS / 1_000} s`), KILL_EXEC_TIMEOUT_MS).unref();
      }),
    ]);
    clearTimeout(timer);
    if (failure !== undefined) stopFailures.push(`AgentX could not stop the command in the container (${step}): ${failure}`);
  };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      await signalGroup("TERM", TERM_SCRIPT);
      // unref'd: after an abort the sequence finishes in the background and does not keep the worker running.
      await new Promise((resolveGrace) => setTimeout(resolveGrace, TIMEOUT_KILL_GRACE_MS).unref());
      await signalGroup("KILL", KILL_SCRIPT);
      controller.abort();
    })();
  };
  let timedOut = false;
  let aborted = false;
  const timer = command.timeoutMs !== undefined
    ? setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs)
    : undefined;
  const onAbort = () => { aborted = true; stop(); controller.abort(); };
  command.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await exec([
      "bash", "-c",
      // Job control only while starting the command, which puts it in its own process group; left
      // on, bash would also print a "Done" line into the output.
      `set -m; (cd -- "$1" && shift 2 && ${command.body}) & child=$!; set +m; echo "$child" > "$2"; wait "$child"; status=$?; rm -f "$2"; exit "$status"`,
      "bash", command.cwd, groupFile, ...command.args,
    ], {
      ...(command.env !== undefined ? { env: command.env } : {}),
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs + TIMEOUT_KILL_GRACE_MS + CLIENT_TIMEOUT_MARGIN_MS } : {}),
      signal: controller.signal,
      ...(command.onStdout !== undefined ? { onStdout: command.onStdout } : {}),
      ...(command.onStderr !== undefined ? { onStderr: command.onStderr } : {}),
    });
    const wasAborted = aborted || command.signal?.aborted === true;
    // A timeout waits for the stop sequence, so the result says whether it worked.
    if (timedOut && !wasAborted) await stopping;
    // bash never started when the container has none, so there is no output.
    if (!timedOut && !wasAborted && result.exitCode !== 0 && result.stdout === "" && NO_BASH.test(result.stderr)) {
      throw new Error(NO_BASH_MESSAGE);
    }
    return { result, timedOut, aborted: wasAborted, stopFailures: [...stopFailures] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    command.signal?.removeEventListener("abort", onAbort);
  }
}

/** Why a kill exec failed: the last line it printed, or its exit status. */
function stopFailureReason(result: DevcontainerProcess): string {
  const last = `${result.stdout}\n${result.stderr}`.trim().split("\n").at(-1)?.trim() ?? "";
  if (last !== "") return last.slice(0, 300);
  return result.timedOut === true ? "timed out" : `exit ${String(result.exitCode)}`;
}

/** `devcontainer exec` in the target's devcontainer, with the given variables set there. */
function devcontainerExec(cli: DevcontainerCli, target: DevcontainerTarget): ContainerExec {
  return (command, { env, ...options }) => cli.run([
    "exec", ...targetArgs(target),
    ...remoteEnvArgs(env),
    ...command,
  ], options);
}

/** The `devcontainer` CLI bundled with the worker, run with this Node. */
export function createDevcontainerCli(): DevcontainerCli {
  const require = createRequire(import.meta.url);
  const script = resolve(dirname(require.resolve("@devcontainers/cli/package.json")), "devcontainer.js");
  return {
    run(args, options) {
      return runCollected(process.execPath, [script, ...args], options);
    },
  };
}

/** Variables set in the devcontainer for one exec only: a project command's `env` (#54), pi's PI_* variables. */
function remoteEnvArgs(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([name, value]) => ["--remote-env", `${name}=${value}`]);
}

function targetArgs(target: DevcontainerTarget): string[] {
  return ["--workspace-folder", target.workspaceFolder, "--config", target.configPath];
}

/**
 * pi's PI_* session variables, which its shell tool exposes to commands, and AgentX's git identity,
 * which the agent's shell sets (#208). The worker's other variables stay out of the container.
 */
function sessionEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {})
    .filter((entry): entry is [string, string] =>
      (entry[0].startsWith("PI_") || Object.hasOwn(AGENTX_GIT_IDENTITY_ENVIRONMENT, entry[0])) && entry[1] !== undefined));
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

function contained(parent: string, path: string): string {
  if (isAbsolute(path)) throw new Error("devcontainer path must be relative");
  const candidate = resolve(parent, path);
  const fromParent = relative(parent, candidate);
  if (fromParent === ".." || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) {
    throw new Error("devcontainer path escapes its workspace");
  }
  return candidate;
}
