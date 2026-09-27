import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  StoredProjectDefinitionSchema,
  agentXError,
  type ProjectCommand,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import {
  createDevcontainerCli,
  devcontainerTarget,
  ensureDevcontainer,
  runDevcontainerCommand,
  type DevcontainerCli,
} from "./devcontainer.js";
import { evaluateReadiness, type CommandResult } from "./readiness.js";
import { gitSafeEnvironment } from "./git.js";
import { assertCredentialFreeRemote, runGitWithCredential } from "./git-auth.js";
import type {
  RepositoryCloneCredential,
  RepositoryCredentialProvider,
} from "./repository-credentials.js";

const execFileAsync = promisify(execFile);
const MANIFEST_PATH = ".agentx/preparation-manifest.json";
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
/**
 * Docker's data root on an EC2 worker's workspace volume (#121), so images, containers and named
 * volumes survive an idle stop. The boot script puts it there; it is root's, not the workspace's.
 */
export const DOCKER_DATA_DIRECTORY = ".docker";

export interface PreparationManifest {
  schemaVersion: 2;
  projectName: string;
  projectRevision: number;
  /** Written by workers that predate the removal of the project's environment pin. */
  environmentDigest?: string;
  repositories: Array<{
    name: string;
    path: string;
    defaultBranch: string;
    resolvedCommit: string;
    resolvedAt: string;
    completedAt: string;
  }>;
  completedSetupSteps: number[];
  /** The project's devcontainer (#121), recorded once it has started. */
  devcontainer?: {
    repository: string;
    configPath: string;
    containerId: string;
    startedAt: string;
  };
  readinessResults: Array<{
    index: number;
    ready: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  creationIdentity: string;
  complete: boolean;
  updatedAt: string;
  failure?: string;
}

export type RepositoryMaterializer = (
  repository: StoredProjectDefinition["repositories"][number],
  destination: string,
  credential: RepositoryCloneCredential,
) => Promise<void>;

export type PreparationCommandRunner = (
  command: ProjectCommand,
  index: number,
  rootPath: string,
) => Promise<CommandResult>;

export interface PrepareWorkspaceOptions {
  rootPath: string;
  /** A definition already on record: its `integrations.connectors`, unused here, may contain an
   * entry of a type this release does not know (see `StoredProjectDefinitionSchema`). */
  project: StoredProjectDefinition;
  creationIdentity?: string;
  materializer?: RepositoryMaterializer;
  credentialProvider?: RepositoryCredentialProvider;
  commandRunner?: PreparationCommandRunner;
  devcontainerCli?: DevcontainerCli;
}

export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparationManifest> {
  const project = StoredProjectDefinitionSchema.parse(options.project);
  const rootPath = resolve(options.rootPath);
  await mkdir(rootPath, { recursive: true });
  const canonicalRoot = await realpath(rootPath);
  const materializer = options.materializer ?? cloneRepository;
  const target = devcontainerTarget(canonicalRoot, project);
  const devcontainerCli = target === undefined ? undefined : options.devcontainerCli ?? createDevcontainerCli();
  // With a devcontainer, setup and readiness run in it, like the agent's shell.
  const commandRunner = options.commandRunner
    ?? (target === undefined || devcontainerCli === undefined
      ? runProjectCommand
      : (command: ProjectCommand) => runDevcontainerCommand(devcontainerCli, target, command));
  let manifest = await loadOrCreateManifest(
    canonicalRoot,
    project,
    options.creationIdentity ?? "agentx-worker",
  );

  if (manifest.complete) {
    await assertContainedSymlinks(canonicalRoot);
    return manifest;
  }

  try {
    for (const repository of project.repositories) {
      if (manifest.repositories.some((entry) => entry.name === repository.name)) continue;
      const destination = containedPath(canonicalRoot, repository.path);
      const existing = await pathKind(destination);
      if (existing === "missing") {
        await mkdir(resolve(destination, ".."), { recursive: true });
        const credential = await options.credentialProvider?.(repository) ?? {};
        await materializer(repository, destination, credential);
      } else {
        if (existing !== "directory" || (await pathKind(resolve(destination, ".git"))) === "missing") {
          throw new Error(`repository path already exists and is not a Git checkout: ${repository.path}`);
        }
      }
      const resolvedCommit = await resolveDefaultBranch(destination, repository.defaultBranch);
      const head = await gitHead(destination);
      if (existing === "missing") {
        await checkoutResolvedCommit(destination, resolvedCommit);
      } else if (head !== resolvedCommit) {
        throw new Error(
          `unrecorded checkout at ${repository.path} has HEAD ${head}; refusing to reset it`,
        );
      }
      await assertContainedSymlinks(canonicalRoot);
      const now = new Date().toISOString();
      manifest.repositories.push({
        name: repository.name,
        path: repository.path,
        defaultBranch: repository.defaultBranch,
        resolvedCommit,
        resolvedAt: now,
        completedAt: now,
      });
      manifest = await writeManifest(canonicalRoot, withoutFailure(manifest));
    }

    if (target !== undefined && devcontainerCli !== undefined && project.devcontainer !== undefined) {
      // Also on a resumed preparation: a new instance starts with the containers stopped.
      const started = await ensureDevcontainer(devcontainerCli, target);
      manifest = await writeManifest(canonicalRoot, withoutFailure({
        ...manifest,
        devcontainer: {
          repository: project.devcontainer.repository,
          configPath: relative(canonicalRoot, target.configPath),
          containerId: started.containerId,
          startedAt: new Date().toISOString(),
        },
      }));
    }

    for (const [index, command] of project.setup.entries()) {
      if (manifest.completedSetupSteps.includes(index)) continue;
      const result = await commandRunner(command, index, canonicalRoot);
      if (result.exitCode !== 0) {
        throw new Error(`setup step ${index} exited ${result.exitCode}: ${result.stderr}`);
      }
      await assertContainedSymlinks(canonicalRoot);
      manifest.completedSetupSteps.push(index);
      manifest = await writeManifest(canonicalRoot, withoutFailure(manifest));
    }

    const readiness = await evaluateReadiness(
      { rootPath: canonicalRoot, commands: project.readiness },
      commandRunner,
    );
    const readinessManifest: PreparationManifest = {
      ...manifest,
      readinessResults: readiness.results,
      complete: readiness.ready,
      ...(!readiness.ready ? { failure: "one or more readiness checks failed" } : {}),
    };
    manifest = await writeManifest(
      canonicalRoot,
      readiness.ready ? withoutFailure(readinessManifest) : readinessManifest,
    );
    if (!readiness.ready) throw new Error("one or more readiness checks failed");
    return manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace preparation failed";
    await writeManifest(canonicalRoot, { ...manifest, complete: false, failure: message });
    throw error;
  }
}

async function loadOrCreateManifest(
  rootPath: string,
  project: StoredProjectDefinition,
  creationIdentity: string,
): Promise<PreparationManifest> {
  const path = resolve(rootPath, MANIFEST_PATH);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PreparationManifest;
    if (
      parsed.schemaVersion !== 2 ||
      parsed.projectName !== project.name ||
      parsed.projectRevision !== project.revision
    ) {
      throw agentXError(
        "CONFIG_INVALID",
        "existing workspace manifest is pinned to a different project revision",
      );
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return writeManifest(rootPath, {
        schemaVersion: 2,
        projectName: project.name,
        projectRevision: project.revision,
        repositories: [],
        completedSetupSteps: [],
        readinessResults: [],
        creationIdentity,
        complete: false,
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function writeManifest(rootPath: string, manifest: PreparationManifest): Promise<PreparationManifest> {
  const directory = resolve(rootPath, ".agentx");
  await mkdir(directory, { recursive: true });
  const next: PreparationManifest = { ...manifest, updatedAt: new Date().toISOString() };
  if (next.failure === undefined) delete next.failure;
  const temporary = resolve(directory, `preparation-manifest.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, resolve(rootPath, MANIFEST_PATH));
  return next;
}

async function cloneRepository(
  repository: StoredProjectDefinition["repositories"][number],
  destination: string,
  credential: RepositoryCloneCredential,
): Promise<void> {
  assertCredentialFreeRemote(repository.url);
  await runGitWithCredential({
    directory: destination,
    args: ["clone", "--no-checkout", "--branch", repository.defaultBranch, "--", repository.url, destination],
    credential,
    timeout: 300_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  const remote = await execFileAsync("git", ["-C", destination, "remote", "get-url", "origin"], {
    timeout: 30_000,
    maxBuffer: 4_096,
    env: gitSafeEnvironment(destination),
  });
  assertCredentialFreeRemote(remote.stdout.trim());
}

async function resolveDefaultBranch(directory: string, branch: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", directory, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
      {
        timeout: 30_000,
        maxBuffer: 4_096,
        env: gitSafeEnvironment(directory),
      },
    );
    return result.stdout.trim();
  } catch {
    throw new Error(`repository default branch does not exist: ${branch}`);
  }
}

async function checkoutResolvedCommit(directory: string, commit: string): Promise<void> {
  // A --no-checkout clone can report the requested commit from HEAD while its
  // working tree is still empty. Always materialize the resolved branch head.
  await execFileAsync("git", ["-C", directory, "checkout", "--detach", "--force", commit], {
    timeout: 120_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: gitSafeEnvironment(directory),
  });
  const resolved = await gitHead(directory);
  if (resolved !== commit) throw new Error("repository did not check out the resolved branch commit");
}

async function gitHead(directory: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], {
    timeout: 30_000,
    maxBuffer: 4_096,
    env: gitSafeEnvironment(directory),
  });
  return result.stdout.trim();
}

export async function runProjectCommand(
  command: ProjectCommand,
  _index: number,
  rootPath: string,
): Promise<CommandResult> {
  const cwd = containedPath(rootPath, command.cwd);
  const cwdStat = await stat(cwd);
  if (!cwdStat.isDirectory()) throw new Error(`command cwd is not a directory: ${command.cwd}`);
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd,
      timeout: command.timeoutSeconds * 1_000,
      killSignal: "SIGTERM",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      encoding: "utf8",
      env: gitSafeEnvironment(cwd),
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const processError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      exitCode: typeof processError.code === "number" ? processError.code : -1,
      stdout: processError.stdout ?? "",
      stderr: processError.stderr ?? processError.message,
    };
  }
}

function containedPath(rootPath: string, configuredPath: string): string {
  if (isAbsolute(configuredPath)) throw new Error("workspace path must be relative");
  const candidate = resolve(rootPath, configuredPath);
  const fromRoot = relative(rootPath, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("workspace path escapes its root");
  }
  return candidate;
}

async function assertContainedSymlinks(rootPath: string, directory = rootPath): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const workspaceRelativePath = relative(rootPath, directory);
    if (
      workspaceRelativePath === "lost+found" &&
      isNodeError(error) &&
      (error.code === "EACCES" || error.code === "EPERM")
    ) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (directory === rootPath && entry.name === DOCKER_DATA_DIRECTORY) continue;
    const entryPath = resolve(directory, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(entryPath);
      } catch {
        throw new Error(`broken symlink is not allowed in workspace: ${relative(rootPath, entryPath)}`);
      }
      containedPath(rootPath, relative(rootPath, target));
    } else if (metadata.isDirectory() && entry.name !== ".git") {
      await assertContainedSymlinks(rootPath, entryPath);
    }
  }
}

async function pathKind(path: string): Promise<"missing" | "directory" | "other"> {
  try {
    const value = await lstat(path);
    return value.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function withoutFailure(manifest: PreparationManifest): PreparationManifest {
  const next = { ...manifest };
  delete next.failure;
  return next;
}
