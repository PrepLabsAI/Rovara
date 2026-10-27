import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentXError, type ProjectCommand } from "@agentx/contracts";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { containerBashOperations, runContainerCommand, type ContainerCommandOptions, type ContainerExec } from "./devcontainer.js";
import { fileOpsExec, type FileOpsTarget } from "./file-ops-exec.js";
import type { CommandResult } from "./readiness.js";
import { hiddenWorkspaceDirectories } from "./workspace-state.js";
import { createDockerCli, taskContainerExec, type DockerCli } from "./swebench/containers.js";

/**
 * On an EC2 worker, code the task controls (the agent's shell, project setup and readiness commands, project checks, the
 * agent's file tools) never runs in the worker's own process or user. A project without a devcontainer runs it in this
 * sandbox instead: a container in which a task's commands run without host access, with no Docker socket, no extra group,
 * no capabilities, no new privileges, and only the workspace mounted, without the worker's own state in it
 * (workspace-state.ts). It is started from the worker's own image (the base environment), which AGENTX_SANDBOX_IMAGE
 * names, and removed when the operation ends.
 *
 * A project's devcontainer is the other sandbox (devcontainer.ts, devcontainer-policy.ts).
 */

/** The user-defined bridge network of every sandbox: outbound internet works, the host's network and other containers' do not. */
export const TASK_SANDBOX_NETWORK = "agentx-task";
/** The label every sandbox carries, with the ID of the operation it serves. */
export const TASK_SANDBOX_LABEL = "agentx.task";
/** The label that says which workspace a sandbox belongs to, so a worker removes only its own. */
export const TASK_SANDBOX_WORKSPACE_LABEL = "agentx.workspace";

/** A stable key for a workspace root: what marks the sandboxes of one worker's workspace. */
export function workspaceKey(rootPath: string): string {
  return createHash("sha256").update(resolve(rootPath)).digest("hex").slice(0, 16);
}
/** The `node` user of environments/base/Dockerfile, which the worker also runs as. */
export const TASK_SANDBOX_USER = "1000:1000";
/** Where the worker image (which is the sandbox image) keeps Node and the file-tool helper (environments/base/Dockerfile). */
export const SANDBOX_FILE_OPS_NODE = "/usr/local/bin/node";
export const SANDBOX_FILE_OPS_HELPER = "/opt/agentx/packages/worker/dist/sandbox-file-ops.js";
/**
 * The most processes and threads one sandbox may use (the limit counts threads, so a JVM or browser build needs room; it
 * still stops a fork bomb).
 */
export const TASK_SANDBOX_PIDS_LIMIT = "4096";

/**
 * The CPU limit of a sandbox on a host with `hostCpus`: all but one, so the worker and Docker keep a core. The Docker daemon
 * refuses a limit above the host's CPU count, so a one-CPU host gets no limit rather than a sandbox that cannot start.
 */
export function sandboxCpuLimit(hostCpus: number): string | undefined {
  return Number.isInteger(hostCpus) && hostCpus > 1 ? String(hostCpus - 1) : undefined;
}
/**
 * The worker image's ENV that is the worker's own and not the project's: the sandbox starts from that image. NODE_ENV=production
 * is for the worker process, and in a project's commands it makes `npm ci` skip the devDependencies, so `npm test` cannot find vitest.
 * Every sandbox command (project setup and readiness, AgentX's checks, the agent's shell) runs without it, except a project command
 * whose own `env` sets it. The image's other ENV (PORT, AGENTX_WORKSPACE_ROOT, AGENTX_WORKER_PROCESS_SCOPE) is left as it is.
 */
export const SANDBOX_UNSET_ENVIRONMENT: readonly string[] = ["NODE_ENV"];
/**
 * Where the sandbox's commands keep Python packages installed with `pip install --user` (what `pip install --break-system-packages` does for the non-root sandbox user), under the
 * workspace root and outside every repository. Without it they went to the container's own HOME, which is gone with the container: setup ran in one throw-away container and the
 * agent, the checks and the next send-back each got a new one from the image, with no `pytest` or `ruff` in it. Node needs nothing like it: `npm ci` writes `node_modules`
 * into the repository. The folder holds a `.gitignore` of `*`, so a repository at the workspace root never sees it as a change.
 */
export const SANDBOX_PYTHON_USER_BASE_DIRECTORY = ".agentx-python";
/** The environment variable that names the sandbox image; boot.sh sets it to the worker's own image. */
export const TASK_SANDBOX_IMAGE_ENVIRONMENT = "AGENTX_SANDBOX_IMAGE";
/** `local` or `sandbox` (the default): where a project without a devcontainer runs its commands. `local` is for tests and a developer's machine, never EC2. */
export const TASK_SHELL_ENVIRONMENT = "AGENTX_TASK_SHELL";
/** The image's init (environments/base/Dockerfile): PID 1 that reaps what a command leaves behind. */
const SANDBOX_INIT = "/usr/bin/tini";
const SANDBOX_START_TIMEOUT_MS = 5 * 60_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
/** What hides a folder of the workspace volume that is not the project's. */
const MASK_OPTIONS = "ro,noexec,nosuid,size=4k";

/**
 * An EC2 worker, by either marker: boot.sh writes AGENTX_RUNTIME=ec2 to the worker's environment, and the worker image sets
 * AGENTX_WORKER_PROCESS_SCOPE=container. Neither is needed for the sandbox, which is the default everywhere; they make
 * the local shell impossible to ask for.
 */
export function isEc2WorkerRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AGENTX_RUNTIME === "ec2" || environment.AGENTX_WORKER_PROCESS_SCOPE === "container";
}

/**
 * The local shell runs task code as a child of the worker. It is for tests and a developer's own machine, and only when
 * it is asked for (`explicit`: the caller was told to use it, or AGENTX_TASK_SHELL=local). Nothing falls back to it: not
 * a missing sandbox, not an unset variable, and on the EC2 runtime it is refused whatever asks.
 */
export function assertLocalTaskExecutionAllowed(environment: NodeJS.ProcessEnv = process.env, options: { explicit?: boolean } = {}): void {
  if (isEc2WorkerRuntime(environment)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not run a task's commands inside the worker on an EC2 worker; they run in the task sandbox");
  }
  if (options.explicit !== true && environment[TASK_SHELL_ENVIRONMENT] !== "local") {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX runs a task's commands in the task sandbox; the local shell is for tests and a developer's machine, and needs ${TASK_SHELL_ENVIRONMENT}=local`);
  }
}

/**
 * Pi's local shell, which runs a command as a child of this process. Every use asks first (assertLocalTaskExecutionAllowed).
 * `explicit` is for a caller that was told to use the local shell.
 */
export function localBashOperations(options: { environment?: NodeJS.ProcessEnv; explicit?: boolean } = {}): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec(command, cwd, execOptions) {
      assertLocalTaskExecutionAllowed(options.environment ?? process.env, options.explicit === true ? { explicit: true } : {});
      return local.exec(command, cwd, execOptions);
    },
  };
}

export type TaskShellKind = "sandbox" | "local";

/** Where a project without a devcontainer runs its commands: the sandbox, unless AGENTX_TASK_SHELL=local says otherwise (never on EC2). */
export function taskShellFromEnvironment(environment: NodeJS.ProcessEnv = process.env): TaskShellKind {
  const requested = environment[TASK_SHELL_ENVIRONMENT];
  if (requested !== undefined && requested !== "" && requested !== "sandbox" && requested !== "local") {
    throw agentXError("CONFIG_INVALID", `${TASK_SHELL_ENVIRONMENT} must be "sandbox" or "local"`);
  }
  if (requested === "local") assertLocalTaskExecutionAllowed(environment);
  return requested === "local" ? "local" : "sandbox";
}

/** How a project without a devcontainer runs its commands: chosen explicitly, never by falling back from the other. */
export type TaskShellSelection =
  | { kind: "local" }
  | { kind: "sandbox"; docker?: DockerCli; image?: string; environment?: NodeJS.ProcessEnv };

/** The selection a worker makes from its environment. */
export function taskShellSelection(environment: NodeJS.ProcessEnv = process.env): TaskShellSelection {
  return taskShellFromEnvironment(environment) === "sandbox" ? { kind: "sandbox", environment } : { kind: "local" };
}

export interface TaskSandboxRunInput {
  name: string;
  taskId: string;
  image: string;
  rootPath: string;
  /** Folders of the workspace volume that are the worker's, not the project's (workspace-state.ts): each gets an empty read-only tmpfs over it. */
  maskedPaths: readonly string[];
  /** The host's CPU count, which sets the sandbox's CPU limit (sandboxCpuLimit). Default: this machine's, which is the host's. */
  hostCpus?: number;
}

/** The `docker run` arguments of a sandbox. The workspace is the only mount, at its own path. */
export function taskSandboxRunArgs(input: TaskSandboxRunInput): string[] {
  return [
    "run", "--detach",
    "--name", input.name,
    "--label", `${TASK_SANDBOX_LABEL}=${input.taskId}`,
    "--label", `${TASK_SANDBOX_WORKSPACE_LABEL}=${workspaceKey(input.rootPath)}`,
    "--network", TASK_SANDBOX_NETWORK,
    "--user", TASK_SANDBOX_USER,
    // A sandbox shares the instance with the worker: a runaway command (or a file-tool search) must not take every core or process.
    ...(sandboxCpuLimit(input.hostCpus ?? availableParallelism()) === undefined ? [] : ["--cpus", sandboxCpuLimit(input.hostCpus ?? availableParallelism())!]),
    "--pids-limit", TASK_SANDBOX_PIDS_LIMIT,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--volume", `${input.rootPath}:${input.rootPath}`,
    ...input.maskedPaths.flatMap((path) => ["--tmpfs", `${path}:${MASK_OPTIONS}`]),
    "--workdir", input.rootPath,
    "--entrypoint", SANDBOX_INIT,
    input.image, "--", "sleep", "infinity",
  ];
}

export interface TaskSandboxOptions {
  /** The workspace root (canonical). */
  rootPath: string;
  /** The operation this sandbox serves; it labels the container. */
  taskId: string;
  /** Test seam; default: the host's `docker`. */
  docker?: DockerCli;
  /** Default: AGENTX_SANDBOX_IMAGE in `environment`. */
  image?: string;
  environment?: NodeJS.ProcessEnv;
  /** Where the sandbox reports what it does not fail on; default: one JSON line on the worker's log. */
  log?: (event: Record<string, unknown>) => void;
}

/**
 * One sandbox container for one operation. It starts on first use (or `start()`), serves every command through
 * `docker exec`, and `dispose()` removes it, whether it started or not.
 */
export class TaskSandbox {
  readonly name: string;
  readonly exec: ContainerExec;
  private readonly docker: DockerCli;
  private starting: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: TaskSandboxOptions) {
    this.docker = options.docker ?? createDockerCli();
    this.name = `agentx-task-${options.taskId.replace(/[^a-zA-Z0-9_.-]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const exec = taskContainerExec(this.docker, this.name);
    this.exec = async (command, execOptions) => {
      await this.start();
      return exec(command, execOptions);
    };
  }

  /** Starts the container, once; a failed start stays failed. */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "the task sandbox was already removed"));
    this.starting ??= this.startContainer();
    return this.starting;
  }

  /** What every project command in the sandbox starts without (NODE_ENV) and with (the Python user site), unless the command sets it itself. */
  private commandOptions(): ContainerCommandOptions {
    const base = join(resolve(this.options.rootPath), SANDBOX_PYTHON_USER_BASE_DIRECTORY);
    return { unsetEnvironment: SANDBOX_UNSET_ENVIRONMENT, defaultEnvironment: { PYTHONUSERBASE: base }, pathPrefix: [join(base, "bin")] };
  }

  /** The agent's shell in the sandbox. */
  bashOperations(): BashOperations {
    return containerBashOperations(this.exec, this.commandOptions());
  }

  /** Where the agent's file tools run for this sandbox: as the sandbox's user, with the workspace as the only reachable root. */
  fileOpsTarget(): FileOpsTarget {
    return {
      container: this.name, user: TASK_SANDBOX_USER, node: SANDBOX_FILE_OPS_NODE, helper: SANDBOX_FILE_OPS_HELPER,
      root: resolve(this.options.rootPath), docker: this.docker,
    };
  }

  /** A project command (setup, readiness) in the sandbox. */
  runCommand(command: ProjectCommand, signal?: AbortSignal): Promise<CommandResult> {
    return runContainerCommand(this.exec, this.options.rootPath, command, signal, this.commandOptions());
  }

  /** Removes the container. Safe to call again, and when nothing started. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.starting === undefined) return;
    // A start still in flight finishes first, so the removal sees the container it creates.
    await this.starting.catch(() => undefined);
    await this.remove();
  }

  /** `docker rm --force`, once more if it fails; a container that cannot be removed is logged, since it keeps the workspace mounted. */
  private async remove(): Promise<void> {
    let failure = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.docker.run(["rm", "--force", this.name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS })
        .catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      if (result.exitCode === 0 || /no such container/iu.test(result.stderr)) return;
      failure = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${String(result.exitCode)}`;
    }
    (this.options.log ?? logEvent)({ event: "task-sandbox.remove.failed", container: this.name, taskId: this.options.taskId, reason: failure });
  }

  private async startContainer(): Promise<void> {
    const image = this.options.image ?? (this.options.environment ?? process.env)[TASK_SANDBOX_IMAGE_ENVIRONMENT];
    if (image === undefined || image === "") {
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX has no task sandbox image (${TASK_SANDBOX_IMAGE_ENVIRONMENT}), so it did not run the task's commands`);
    }
    const root = resolve(this.options.rootPath);
    await this.ensureNetwork();
    const maskedPaths = await hiddenWorkspaceDirectories(root);
    const result = await this.docker.run(
      taskSandboxRunArgs({ name: this.name, taskId: this.options.taskId, image, rootPath: root, maskedPaths }),
      { timeoutMs: SANDBOX_START_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join(" ").slice(0, 800);
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not start the task sandbox${result.timedOut === true ? " (timed out)" : ""}: ${detail || `exit ${String(result.exitCode)}`}`);
    }
    await this.prepareUserBase(root);
    // A write the file tools' helper was killed in leaves a `.agentx-file-ops-*` file; an earlier task's must not reach this one's snapshots.
    await fileOpsExec(this.fileOpsTarget(), { root, op: "sweep", path: root }).catch(() => undefined);
  }

  /**
   * The Python user site's folder, made before the first command: a real directory with a `.gitignore` of `*`. A link or file a task left at its name is removed (the link
   * itself, never its target), as the worker's state directories are (workspace-state.ts). A folder that cannot be made is logged, not fatal: pip makes it, without the `.gitignore`.
   */
  private async prepareUserBase(root: string): Promise<void> {
    const path = join(root, SANDBOX_PYTHON_USER_BASE_DIRECTORY);
    try {
      const found = await lstat(path).catch((error: unknown) => {
        if ((error as { code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      });
      if (found !== undefined && (found.isSymbolicLink() || !found.isDirectory())) await rm(path, { force: true });
      await mkdir(path, { recursive: true });
      await writeFile(join(path, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
    } catch (error) {
      (this.options.log ?? logEvent)({ event: "task-sandbox.python-user-base.failed", taskId: this.options.taskId, reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
    }
  }

  /**
   * Idempotent: another start may create the network between the check and the create. The data root persists on the
   * workspace volume, so a network of this name is not trusted: it must be a plain bridge, or it is removed and made again.
   */
  private async ensureNetwork(): Promise<void> {
    const inspect = ["network", "inspect", "--format", "{{.Driver}} {{json .Options}} {{.Internal}}", TASK_SANDBOX_NETWORK];
    const found = await this.docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
    if (found.exitCode === 0) {
      if (/^bridge (\{\}|null) false$/u.test(found.stdout.trim())) return;
      const removed = await this.docker.run(["network", "rm", TASK_SANDBOX_NETWORK], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
      if (removed.exitCode !== 0) {
        throw agentXError("RUNTIME_UNAVAILABLE", `the ${TASK_SANDBOX_NETWORK} network is not a plain bridge and could not be removed, so AgentX did not start the task sandbox: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`);
      }
    }
    const created = await this.docker.run(["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
    if (created.exitCode === 0) return;
    if (/^bridge (\{\}|null) false$/u.test((await this.docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS })).stdout.trim())) return;
    const detail = (created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not create the ${TASK_SANDBOX_NETWORK} network for the task sandbox: ${detail || `exit ${String(created.exitCode)}`}`);
  }
}

/**
 * Removes the sandboxes an earlier worker process left for this workspace (a crash or a restart skips dispose), by label.
 * The worker calls it once at startup, when none of its own exists yet, so it cannot remove one that is in use; the
 * workspace label keeps it from removing another worker's sandboxes on a shared Docker daemon.
 */
export async function removeLeftoverTaskSandboxes(rootPath: string, docker: DockerCli = createDockerCli()): Promise<number> {
  const listed = await docker.run([
    "ps", "--all", "--quiet", "--filter", `label=${TASK_SANDBOX_LABEL}`, "--filter", `label=${TASK_SANDBOX_WORKSPACE_LABEL}=${workspaceKey(rootPath)}`,
  ], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  const ids = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "") : [];
  if (ids.length > 0) await docker.run(["rm", "--force", ...ids], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  return ids.length;
}

function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "worker", ...event }));
}

/** The sandbox for a selection, or undefined for the local shell (refused on the EC2 runtime). */
export function taskSandboxFor(selection: TaskShellSelection, input: { rootPath: string; taskId: string }): TaskSandbox | undefined {
  if (selection.kind === "local") {
    assertLocalTaskExecutionAllowed(process.env, { explicit: true });
    return undefined;
  }
  return new TaskSandbox({
    ...input,
    ...(selection.docker === undefined ? {} : { docker: selection.docker }),
    ...(selection.image === undefined ? {} : { image: selection.image }),
    ...(selection.environment === undefined ? {} : { environment: selection.environment }),
  });
}
