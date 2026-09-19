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
  ProjectDefinitionSchema,
  agentXError,
  type ProjectCommand,
  type ProjectDefinition,
} from "@agentx/contracts";
import { evaluateReadiness, type CommandResult } from "./readiness.js";
import { gitSafeEnvironment } from "./git.js";

const execFileAsync = promisify(execFile);
const MANIFEST_PATH = ".agentx/preparation-manifest.json";
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;

export interface PreparationManifest {
  schemaVersion: 1;
  projectName: string;
  projectRevision: number;
  environmentDigest: string;
  repositories: Array<{
    name: string;
    path: string;
    initialCommit: string;
    completedAt: string;
  }>;
  completedSetupSteps: number[];
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
  repository: ProjectDefinition["repositories"][number],
  destination: string,
) => Promise<void>;

export type PreparationCommandRunner = (
  command: ProjectCommand,
  index: number,
  rootPath: string,
) => Promise<CommandResult>;

export interface PrepareWorkspaceOptions {
  rootPath: string;
  project: ProjectDefinition;
  creationIdentity?: string;
  materializer?: RepositoryMaterializer;
  commandRunner?: PreparationCommandRunner;
}

export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparationManifest> {
  const project = ProjectDefinitionSchema.parse(options.project);
  const rootPath = resolve(options.rootPath);
  await mkdir(rootPath, { recursive: true });
  const canonicalRoot = await realpath(rootPath);
  const materializer = options.materializer ?? cloneRepository;
  const commandRunner = options.commandRunner ?? runProjectCommand;
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
        await materializer(repository, destination);
        await checkoutInitialCommit(destination, repository.initialCommit);
      } else {
        if (existing !== "directory" || (await pathKind(resolve(destination, ".git"))) === "missing") {
          throw new Error(`repository path already exists and is not a Git checkout: ${repository.path}`);
        }
        const head = await gitHead(destination);
        if (head !== repository.initialCommit) {
          throw new Error(
            `unrecorded checkout at ${repository.path} has HEAD ${head}; refusing to reset it`,
          );
        }
      }
      await assertContainedSymlinks(canonicalRoot);
      manifest.repositories.push({
        name: repository.name,
        path: repository.path,
        initialCommit: repository.initialCommit,
        completedAt: new Date().toISOString(),
      });
      manifest = await writeManifest(canonicalRoot, withoutFailure(manifest));
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
  project: ProjectDefinition,
  creationIdentity: string,
): Promise<PreparationManifest> {
  const path = resolve(rootPath, MANIFEST_PATH);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PreparationManifest;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.projectName !== project.name ||
      parsed.projectRevision !== project.revision ||
      parsed.environmentDigest !== project.environment.image
    ) {
      throw agentXError(
        "CONFIG_INVALID",
        "existing workspace manifest is pinned to a different project revision or environment",
      );
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return writeManifest(rootPath, {
        schemaVersion: 1,
        projectName: project.name,
        projectRevision: project.revision,
        environmentDigest: project.environment.image,
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
  repository: ProjectDefinition["repositories"][number],
  destination: string,
): Promise<void> {
  await execFileAsync("git", ["clone", "--no-checkout", "--", repository.url, destination], {
    timeout: 300_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: gitSafeEnvironment(destination),
  });
}

async function checkoutInitialCommit(directory: string, commit: string): Promise<void> {
  // A --no-checkout clone can report the requested commit from HEAD while its
  // working tree is still empty. Always materialize the pinned tree.
  await execFileAsync("git", ["-C", directory, "checkout", "--detach", "--force", commit], {
    timeout: 120_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: gitSafeEnvironment(directory),
  });
  const resolved = await gitHead(directory);
  if (resolved !== commit) throw new Error("repository did not resolve to the configured initial commit");
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
  for (const entry of await readdir(directory, { withFileTypes: true })) {
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
