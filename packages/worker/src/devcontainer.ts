import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
  agentXError,
  type ProjectCommand,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { runCollected, TIMEOUT_KILL_GRACE_MS } from "./collected-process.js";
import {
  DOCKER_DATA_DIRECTORY,
  DOCKER_DATA_VISIBLE,
  WORKER_STATE_VISIBLE,
  containerProblems,
  devcontainerConfigRefusal,
  parseJsonc,
  hostPathResolver,
  type ContainerInspection,
} from "./devcontainer-policy.js";
import { inertContextText } from "./context-text.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "./git.js";
import { fileOpsExec, type FileOpsTarget } from "./file-ops-exec.js";
import type { CommandResult } from "./readiness.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";
import { hiddenWorkspaceDirectories, isMaskVolumeName } from "./workspace-state.js";

const execFile = promisify(execFileCallback);
const UP_TIMEOUT_MS = 20 * 60_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
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
 * AgentX replays from the workspace root, where that folder is `<host folder relative to root>`, so a cd target of
 * `<containerFolder>[/sub]` reads as `<relative>[/sub]`, and "" for the root (spec 051 Ruling X, and the same for coding
 * tasks). #299: the test-command scan asks this for every cd in a command, not only a leading `cd … &&`. Only that exact
 * folder, then a `/` or nothing, so `/workspaces/repoX` stays out. The scan then applies its own safe-path rule (no
 * `..`, no absolute path), and the replay's realpath containment refuses a link out of the workspace. A host folder
 * outside `root` maps nothing.
 */
export function workspaceRelativeCdTarget(target: string, paths: DevcontainerPaths, root: string): string | undefined {
  const base = relative(root, paths.hostFolder);
  if (base === ".." || base.startsWith(`..${sep}`) || isAbsolute(base)) return undefined;
  // D-15 (#290): the host folder too. devcontainerContextFile tells the agent both paths name the same files and to
  // prefer the host one, so `cd <hostFolder> && pytest` must count as the same check.
  for (const folder of [paths.containerFolder, paths.hostFolder]) {
    if (target !== folder && !target.startsWith(`${folder}/`)) continue;
    const sub = target.slice(folder.length);
    return base === "" ? sub.replace(/^\/+/, "") : `${base}${sub}`;
  }
  return undefined;
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
      `The repository is at ${inertContextText(paths.hostFolder).text}. Inside the devcontainer it is also at ${inertContextText(paths.containerFolder).text}.`,
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
  /**
   * What AgentX checks against its rules (devcontainer-policy.ts): the full configuration before `up`, and the container
   * as Docker ran it after, removed when it breaks them. The bundled CLI has these; a test seam without them skips both.
   */
  checks?: DevcontainerChecks;
}

/** The configuration `devcontainer up` would use, read by the devcontainer CLI without starting anything. */
export interface DevcontainerFullConfiguration {
  /** devcontainer.json as the CLI reads it. */
  configuration: unknown;
  /** With every feature's and the image's own `devcontainer.metadata` settings merged in. */
  mergedConfiguration: unknown;
  /** Each feature as the CLI fetched it, with the digest of what it fetched. */
  featuresConfiguration?: unknown;
  /** The CLI's mount of the repository folder. */
  workspaceMount?: string;
}

export interface DevcontainerChecks {
  fullConfiguration(target: DevcontainerTarget): Promise<DevcontainerFullConfiguration>;
  inspect(containerId: string): Promise<ContainerInspection>;
  /** Stops and deletes the container. */
  remove(containerId: string): Promise<void>;
  /** Deletes volumes by name, once their container is gone; one already gone or still in use is left. */
  removeVolumes?(names: readonly string[]): Promise<void>;
}

/** The empty volume mounted over the workspace's Docker data folder in every dev container. */
export const DOCKER_DATA_MASK_VOLUME = "agentx-docker-data-mask";

/**
 * The empty volume mounted over one of the workspace's hidden folders. Its name is the folder's and this start's own
 * (`token`), so what a container writes into it is not seen by another container; the Docker data folder keeps its
 * original name as the prefix.
 */
function maskVolume(path: string, token: string): string {
  const name = basename(path);
  return `${name === DOCKER_DATA_DIRECTORY ? DOCKER_DATA_MASK_VOLUME : `agentx-mask-${name.replace(/^\./u, "")}`}-${token}`;
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
  await assertDevcontainerConfigAllowed(target);
  const lockfile = cli.checks === undefined ? undefined : await assertFullConfigurationAllowed(cli.checks, target);
  // `up` fetches remote features again. With a lockfile of the digests just checked, and --frozen-lockfile, it uses
  // exactly that content or fails before it builds anything.
  const start = (hidden: readonly string[]) => lockfile === undefined
    ? startDevcontainer(cli, target, hidden, false)
    : withFeatureLockfile(target, lockfile, () => startDevcontainer(cli, target, hidden, true));
  // On an EC2 worker the workspace volume also holds Docker's data root, the verifier's runtime and the worker's own state,
  // none of them the project's: a volume mounted over each inside the dev container hides it there.
  let hidden = await hiddenWorkspaceDirectories(target.rootPath);
  const started = await start(hidden);
  if (cli.checks === undefined) return started;
  let { problems, volumes } = await startedContainerProblems(cli.checks, started.containerId, target, hidden);
  let current = started;
  if (problems.length > 0 && problems.every((problem) => problem === DOCKER_DATA_VISIBLE || problem === WORKER_STATE_VISIBLE)) {
    // A container created before AgentX hid these folders: created again, with them hidden.
    await removeStartedContainer(cli.checks, current.containerId, volumes);
    hidden = await hiddenWorkspaceDirectories(target.rootPath);
    current = await start(hidden);
    ({ problems, volumes } = await startedContainerProblems(cli.checks, current.containerId, target, hidden));
  }
  if (problems.length > 0) {
    await removeStartedContainer(cli.checks, current.containerId, volumes);
    throw agentXError("CONFIG_INVALID", `The dev container for ${relative(target.rootPath, target.workspaceFolder) || "."} was started with ${problems.join(", ")}, which AgentX does not allow, so AgentX removed it. A dev container feature or the image's devcontainer.metadata label can ask for these; see "Dev container" in docs/project-configuration.md.`.slice(0, 1_000));
  }
  return current;
}

/** Refuses a devcontainer.json that asks Docker for part of the worker host (devcontainer-policy.ts). */
async function assertDevcontainerConfigAllowed(target: DevcontainerTarget): Promise<void> {
  const shown = relative(target.rootPath, target.configPath);
  let text: string;
  try {
    text = await readFile(target.configPath, "utf8");
  } catch (error) {
    // No config: `devcontainer up` says so.
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw agentXError("CONFIG_INVALID", `AgentX could not read the dev container config ${shown}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
  }
  let config: unknown;
  try {
    config = parseJsonc(text);
  } catch {
    throw agentXError("CONFIG_INVALID", `AgentX could not read the dev container config ${shown} as JSON with comments, so it did not start it`);
  }
  const reason = devcontainerConfigRefusal(config, policyContext(target));
  if (reason !== undefined) {
    throw agentXError("CONFIG_INVALID", `The dev container config ${shown} uses ${reason}, which AgentX does not allow: it would give code in the container the worker host. Remove it; see "Dev container" in docs/project-configuration.md for what is allowed.`.slice(0, 1_000));
  }
}

function policyContext(target: DevcontainerTarget) {
  return {
    rootPath: target.rootPath,
    workspaceFolder: target.workspaceFolder,
    configFolder: dirname(target.configPath),
    resolvePath: hostPathResolver(target.rootPath),
  };
}

/**
 * Refuses, before any container starts, what the dev container's features or its image's `devcontainer.metadata` label
 * would add: the devcontainer CLI merges them into the configuration `up` uses, and reads that without starting anything.
 */
async function assertFullConfigurationAllowed(checks: DevcontainerChecks, target: DevcontainerTarget): Promise<FeatureLockfile> {
  let full: DevcontainerFullConfiguration;
  try {
    full = await checks.fullConfiguration(target);
  } catch (error) {
    throw new Error(`AgentX could not read the dev container's full configuration (with its features and image), so it did not start it: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512), { cause: error });
  }
  const context = policyContext(target);
  const reason = devcontainerConfigRefusal(full.configuration, context)
    ?? devcontainerConfigRefusal(full.mergedConfiguration, context)
    ?? (full.workspaceMount === undefined ? undefined : devcontainerConfigRefusal({ workspaceMount: full.workspaceMount }, context));
  if (reason !== undefined) {
    throw agentXError("CONFIG_INVALID", `The dev container config ${relative(target.rootPath, target.configPath)}, with its features and image, uses ${reason}, which AgentX does not allow: it would give code in the container the worker host. AgentX did not start it; see "Dev container" in docs/project-configuration.md for what is allowed.`.slice(0, 1_000));
  }
  const localFeature = localFeatureOutsideConfigFolder(full.featuresConfiguration, target);
  if (localFeature !== undefined) {
    throw agentXError("CONFIG_INVALID", `The dev container config ${relative(target.rootPath, target.configPath)} uses the local feature ${localFeature}, which is not inside ${relative(target.rootPath, dirname(target.configPath)) || "."}, so AgentX did not start the dev container. A local feature must be a folder inside the dev container config's own folder, reached through no link that leaves it.`.slice(0, 1_000));
  }
  return featureLockfile(full.featuresConfiguration, relative(target.rootPath, target.configPath));
}

/**
 * The first local feature (one in a folder of the repository rather than from a registry) whose folder, with links resolved,
 * is not inside the folder of devcontainer.json; undefined when each is. The CLI's own check does not resolve links.
 */
function localFeatureOutsideConfigFolder(featuresConfiguration: unknown, target: DevcontainerTarget): string | undefined {
  const sets = (featuresConfiguration as { featureSets?: unknown } | null | undefined)?.featureSets;
  const resolvePath = hostPathResolver(target.rootPath);
  const folder = resolvePath(resolve(dirname(target.configPath)));
  for (const set of Array.isArray(sets) ? sets as unknown[] : []) {
    const source = (set as { sourceInformation?: { type?: unknown; userFeatureId?: unknown; resolvedFilePath?: unknown } } | null)?.sourceInformation;
    if (source?.type !== "file-path") continue;
    const id = typeof source.userFeatureId === "string" ? source.userFeatureId : "(unnamed)";
    if (typeof source.resolvedFilePath !== "string") return id;
    const fromFolder = relative(folder, resolvePath(resolve(source.resolvedFilePath)));
    if (fromFolder.startsWith("..") || isAbsolute(fromFolder)) return id;
  }
  return undefined;
}

/** A devcontainer lockfile: the exact content of each remote feature, by digest. */
export interface FeatureLockfile {
  features: Record<string, { version: unknown; resolved: string; integrity: string; dependsOn?: string[] }>;
}

/**
 * The lockfile for the features the CLI fetched for the check, in the CLI's own format, so that `up --frozen-lockfile`
 * accepts it only when it fetches the same content. A local feature (in .devcontainer) needs no entry. A feature the
 * CLI cannot pin (one fetched from a GitHub release, or without a digest) is refused, naming it.
 */
export function featureLockfile(featuresConfiguration: unknown, shownConfigPath: string): FeatureLockfile {
  const sets = (featuresConfiguration as { featureSets?: unknown } | null | undefined)?.featureSets;
  const entries: Array<[string, FeatureLockfile["features"][string]]> = [];
  for (const set of Array.isArray(sets) ? sets as unknown[] : []) {
    const featureSet = set as {
      sourceInformation?: { type?: unknown; userFeatureId?: unknown; tarballUri?: unknown; featureRef?: { registry?: unknown; path?: unknown } };
      computedDigest?: unknown;
      features?: Array<{ version?: unknown; dependsOn?: unknown }>;
    };
    const source = featureSet.sourceInformation;
    const id = typeof source?.userFeatureId === "string" ? source.userFeatureId : "(unnamed)";
    if (source?.type === "file-path") continue;
    const digest = featureSet.computedDigest;
    let resolved: string | undefined;
    if (source?.type === "oci" && typeof source.featureRef?.registry === "string" && typeof source.featureRef.path === "string") {
      resolved = `${source.featureRef.registry}/${source.featureRef.path}@${String(digest)}`;
    } else if (source?.type === "direct-tarball" && typeof source.tarballUri === "string") {
      resolved = source.tarballUri;
    }
    if (resolved === undefined || typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw agentXError("CONFIG_INVALID", `The dev container config ${shownConfigPath} uses the feature ${id}, which AgentX cannot pin to the content it checked. Use a feature published to an OCI registry, a tarball URL, or a local feature in .devcontainer.`.slice(0, 1_000));
    }
    const feature = featureSet.features?.[0];
    const dependsOn = feature?.dependsOn !== null && typeof feature?.dependsOn === "object" ? Object.keys(feature.dependsOn) : [];
    entries.push([id, { version: feature?.version, resolved, integrity: digest, ...(dependsOn.length > 0 ? { dependsOn } : {}) }]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return { features: Object.fromEntries(entries) };
}

/** Where the devcontainer CLI reads the lockfile: next to devcontainer.json. */
export function featureLockfilePath(configPath: string): string {
  return join(dirname(configPath), basename(configPath).startsWith(".") ? ".devcontainer-lock.json" : "devcontainer-lock.json");
}

/**
 * Runs `start` with AgentX's lockfile in the place the CLI reads it, then puts back what was there (the repository's own
 * lockfile, or nothing), so the repository is left as it was. Refuses a lockfile path that is not a plain file of the
 * workspace (a link, for example).
 */
async function withFeatureLockfile<T>(target: DevcontainerTarget, lockfile: FeatureLockfile, start: () => Promise<T>): Promise<T> {
  const path = featureLockfilePath(target.configPath);
  const shown = relative(target.rootPath, path);
  const existing = await lstat(path).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  });
  if (hostPathResolver(target.rootPath)(path) !== path || (existing !== undefined && !existing.isFile())) {
    throw agentXError("CONFIG_INVALID", `The dev container lockfile ${shown} is not a plain file in the workspace, so AgentX did not start the dev container`);
  }
  const previous = existing === undefined ? undefined : await readFile(path);
  await writeFile(path, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
  try {
    return await start();
  } finally {
    if (previous === undefined) await rm(path, { force: true });
    else await writeFile(path, previous);
  }
}

async function startedContainerProblems(
  containers: DevcontainerChecks,
  containerId: string,
  target: DevcontainerTarget,
  hidden: readonly string[],
): Promise<{ problems: string[]; volumes: string[] }> {
  let inspection: ContainerInspection;
  try {
    inspection = await containers.inspect(containerId);
  } catch (error) {
    await removeStartedContainer(containers, containerId);
    throw new Error(`AgentX could not check the dev container it started, so it removed it: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512), { cause: error });
  }
  const dockerDataPath = hidden.find((path) => basename(path) === DOCKER_DATA_DIRECTORY);
  const maskedPaths = hidden.filter((path) => path !== dockerDataPath);
  const problems = containerProblems(inspection, {
    rootPath: target.rootPath,
    resolvePath: hostPathResolver(target.rootPath),
    ...(dockerDataPath === undefined ? {} : { dockerDataPath }),
    maskedPaths,
  });
  // The mask volumes this container was given, which go with it.
  const volumes = (inspection.Mounts ?? []).flatMap((mount) => (mount.Type === "volume" && mount.Name !== undefined && isMaskVolumeName(mount.Name) ? [mount.Name] : []));
  return { problems, volumes };
}

async function removeStartedContainer(containers: DevcontainerChecks, containerId: string, volumes: readonly string[] = []): Promise<void> {
  try {
    await containers.remove(containerId);
  } catch (error) {
    // Publication removes every leftover container before it pushes, and fails when it cannot.
    throw new Error(`AgentX could not remove a dev container it does not allow: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512), { cause: error });
  }
  // The volumes are only the container's; one that cannot be removed now is swept later (removeLeftoverMaskVolumes).
  if (volumes.length > 0) await containers.removeVolumes?.(volumes).catch(() => undefined);
}

/**
 * Removes the mask volumes no container uses (a crash or a removal that missed them), by name; Docker lists as unused only
 * a volume no container, running or stopped, refers to, so a resumed workspace's stopped dev container keeps its own. The
 * worker calls it once at startup. Returns how many it removed.
 */
export async function removeLeftoverMaskVolumes(docker: DockerCli = createDockerCli()): Promise<number> {
  const listed = await docker.run(["volume", "ls", "--quiet", "--filter", "dangling=true", "--filter", "name=agentx-"], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  const names = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter(isMaskVolumeName) : [];
  if (names.length === 0) return 0;
  // Docker prints the name of each volume it removed and fails for one still in use, so what it printed is what went.
  const removed = await docker.run(["volume", "rm", ...names], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  const gone = new Set(removed.stdout.split("\n").map((line) => line.trim()));
  return names.filter((name) => gone.has(name)).length;
}

async function startDevcontainer(cli: DevcontainerCli, target: DevcontainerTarget, hidden: readonly string[], frozenLockfile: boolean): Promise<DevcontainerUpResult> {
  const token = randomUUID().replace(/-/gu, "").slice(0, 12);
  const result = await cli.run([
    "up",
    ...targetArgs(target),
    ...(frozenLockfile ? ["--frozen-lockfile"] : []),
    "--mount", `type=bind,source=${target.rootPath},target=${target.rootPath}`,
    ...hidden.flatMap((path) => ["--mount", `type=volume,source=${maskVolume(path, token)},target=${path}`]),
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
  return runContainerCommand(devcontainerExec(cli, target), target.rootPath, command, signal);
}

/**
 * A project command run in any container through `exec`: the devcontainer's, or the task sandbox's. `rootPath` is
 * the workspace, which the container mounts at the same path.
 */
export async function runContainerCommand(
  exec: ContainerExec,
  rootPath: string,
  command: ProjectCommand,
  signal?: AbortSignal,
  options: ContainerCommandOptions = {},
): Promise<CommandResult> {
  const cwd = contained(rootPath, command.cwd);
  const run = await runInContainerGroup(exec, {
    groupFilePrefix: "agentx-command",
    // The executable and its arguments stay positional parameters: no shell reads them again.
    body: 'exec "$@"',
    cwd,
    args: [command.executable, ...command.args],
    timeoutMs: command.timeoutSeconds * 1_000,
    // The command's own variables (#54) reach the command only, never the TERM and KILL execs.
    ...(command.env !== undefined || options.defaultEnvironment !== undefined ? { env: { ...options.defaultEnvironment, ...command.env } } : {}),
    ...(options.unsetEnvironment === undefined ? {} : { unsetEnvironment: options.unsetEnvironment }),
    ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
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

/**
 * What a container's commands must not inherit from the container's own ENV. A project's devcontainer is the project's own
 * image, whose ENV is the project's; the task sandbox is the worker's image, whose ENV is the worker's.
 */
export interface ContainerCommandOptions {
  /**
   * Variables removed from the command's environment before it starts, unless the command sets them itself (a project
   * command's `env`, #54). The agent's shell sets none of them: the project's `env` belongs to its setup and readiness commands.
   */
  unsetEnvironment?: readonly string[];
  /**
   * Variables the command starts with unless it sets them itself (a project command's `env`, #54; the agent's shell sets none of them). The task sandbox uses this for
   * the Python user site.
   */
  defaultEnvironment?: Readonly<Record<string, string>>;
  /** Folders put in front of the command's PATH, unless the command sets its own PATH. The sandbox's Python user bin. */
  pathPrefix?: readonly string[];
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
export function containerBashOperations(exec: ContainerExec, options: ContainerCommandOptions = {}): BashOperations {
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
        env: { ...options.defaultEnvironment, ...sessionEnvironment(env) },
        ...(options.unsetEnvironment === undefined ? {} : { unsetEnvironment: options.unsetEnvironment }),
        ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
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
  /** Names removed from the environment before the command starts, except those `env` sets (see ContainerCommandOptions). */
  unsetEnvironment?: readonly string[];
  /** Folders put in front of PATH before the command starts, unless `env` sets PATH (see ContainerCommandOptions). */
  pathPrefix?: readonly string[];
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

/** `export PATH='dir':"$PATH";` for the folders the command asks to have first on PATH, or "" when it sets its own PATH (or asks for none). */
function pathStatement(command: ContainerGroupCommand): string {
  if ((command.pathPrefix ?? []).length === 0 || Object.hasOwn(command.env ?? {}, "PATH")) return "";
  const quoted = (command.pathPrefix ?? []).map((folder) => `'${folder.replaceAll("'", "'\\''")}'`).join(":");
  return `export PATH=${quoted}:"$PATH"; `;
}

/** `unset NAME ...;` for the names the command does not set itself, or "" when there are none. */
function unsetStatement(command: ContainerGroupCommand): string {
  const names = (command.unsetEnvironment ?? []).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !Object.hasOwn(command.env ?? {}, name));
  return names.length === 0 ? "" : `unset ${names.join(" ")}; `;
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
      `${unsetStatement(command)}${pathStatement(command)}set -m; (cd -- "$1" && shift 2 && ${command.body}) & child=$!; set +m; echo "$child" > "$2"; wait "$child"; status=$?; rm -f "$2"; exit "$status"`,
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
export function createDevcontainerCli(options: { dockerPath?: string } = {}): DevcontainerCli {
  const require = createRequire(import.meta.url);
  const script = resolve(dirname(require.resolve("@devcontainers/cli/package.json")), "devcontainer.js");
  const docker = options.dockerPath ?? "docker";
  const run: DevcontainerCli["run"] = (args, runOptions) => runCollected(process.execPath, [
    script,
    ...(options.dockerPath === undefined || args[0] === undefined ? args : [args[0], "--docker-path", options.dockerPath, ...args.slice(1)]),
  ], runOptions);
  return {
    run,
    // The same `docker` the devcontainer CLI runs.
    checks: {
      async fullConfiguration(target) {
        const result = await run(["read-configuration", ...targetArgs(target), "--include-merged-configuration", "--include-features-configuration", "--log-format", "json"], { timeoutMs: UP_TIMEOUT_MS });
        return fullConfigurationFromOutput(result);
      },
      async inspect(containerId) {
        const { stdout } = await execFile(docker, ["inspect", "--type", "container", containerId], { encoding: "utf8", timeout: DOCKER_CALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        const parsed: unknown = JSON.parse(stdout);
        if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== "object") throw new Error("docker inspect did not describe one container");
        return parsed[0] as ContainerInspection;
      },
      async remove(containerId) {
        await execFile(docker, ["rm", "--force", containerId], { encoding: "utf8", timeout: DOCKER_CALL_TIMEOUT_MS });
      },
      async removeVolumes(names) {
        await execFile(docker, ["volume", "rm", ...names], { encoding: "utf8", timeout: DOCKER_CALL_TIMEOUT_MS });
      },
    },
  };
}

/** `devcontainer read-configuration --include-merged-configuration`'s answer, or why there is none. */
export function fullConfigurationFromOutput(result: DevcontainerProcess): DevcontainerFullConfiguration {
  const answer = lastJsonLine(result.stdout);
  if (result.exitCode !== 0 || answer === undefined || answer.mergedConfiguration === null || typeof answer.mergedConfiguration !== "object") {
    const reason = result.timedOut === true ? "timed out" : (`${result.stdout}\n${result.stderr}`.trim().split("\n").at(-1) ?? "").slice(0, 300);
    throw new Error(`devcontainer read-configuration failed${reason ? `: ${reason}` : ` (exit ${String(result.exitCode)})`}`);
  }
  const workspace = answer.workspace as { workspaceMount?: unknown } | undefined;
  return {
    configuration: answer.configuration,
    mergedConfiguration: answer.mergedConfiguration,
    ...(answer.featuresConfiguration === undefined ? {} : { featuresConfiguration: answer.featuresConfiguration }),
    ...(typeof workspace?.workspaceMount === "string" ? { workspaceMount: workspace.workspaceMount } : {}),
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

/**
 * Where the file-tool helper and a Node to run it live inside a devcontainer: installed root-owned and read-only (mode 0555),
 * so the container's ordinary users cannot change them. What the tools guarantee is that their reads and writes are confined
 * to the container's own mounts and never reach the worker; a container whose `remoteUser` is root can still change what
 * runs inside that container.
 */
export const DEVCONTAINER_FILE_OPS_DIRECTORY = "/opt/agentx-file-ops";
const WORKER_NODE_BINARY = "/usr/local/bin/node";

/**
 * Copies the worker's Node and the compiled file-tool helper into the devcontainer (`docker cp`, root-owned, mode 0555), so the
 * agent's file tools can run there as its `remoteUser` (sandbox-file-tools.ts). Then it probes, as that user, that the bundled
 * Node starts (a musl image cannot run it) and that the helper loads and reaches the workspace folder. Idempotent. A refusal
 * is not an error: the file tools use a task sandbox of their own for this devcontainer, and the reason says why.
 */
export async function installFileOpsHelper(
  docker: DockerCli,
  input: { containerId: string; user: string; workspaceFolder: string; nodeSource?: string; helperSource?: string },
): Promise<{ target: FileOpsTarget } | { refused: string }> {
  const directory = DEVCONTAINER_FILE_OPS_DIRECTORY;
  const node = `${directory}/node`;
  const helper = `${directory}/sandbox-file-ops.js`;
  const nodeSource = input.nodeSource ?? WORKER_NODE_BINARY;
  const helperSource = input.helperSource ?? fileURLToPath(new URL("./sandbox-file-ops.js", import.meta.url));
  const step = async (what: string, args: readonly string[]): Promise<string | undefined> => {
    const result = await docker.run(args, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch((error: unknown) => ({
      exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error),
    }));
    if (result.exitCode === 0) return undefined;
    return `${what}: ${(result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200) || `exit ${String(result.exitCode)}`}`;
  };
  const target: FileOpsTarget = { container: input.containerId, user: input.user, node, helper, root: input.workspaceFolder, docker };
  const failure = await step("making the helper folder", ["exec", "--user", "0", input.containerId, "mkdir", "-p", directory])
    ?? await step("copying Node", ["cp", nodeSource, `${input.containerId}:${node}`])
    ?? await step("copying the helper", ["cp", helperSource, `${input.containerId}:${helper}`])
    ?? await step("locking the helper folder", ["exec", "--user", "0", input.containerId, "chmod", "0555", directory, node, helper])
    ?? await step("starting the copied Node", ["exec", "--user", input.user, input.containerId, node, "--version"]);
  if (failure !== undefined) return { refused: failure };
  // The copied Node runs; the helper must load too, and reach the workspace, as the user the tools run as.
  try {
    const probe = await fileOpsExec(target, { root: input.workspaceFolder, op: "exists", path: input.workspaceFolder });
    if (!probe.ok) return { refused: `running the helper: ${probe.message.slice(0, 200)}` };
  } catch (error) {
    return { refused: `running the helper: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
  return { target };
}
