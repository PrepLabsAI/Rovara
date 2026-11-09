import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  StoredProjectDefinitionSchema,
  agentXError,
  redactText,
  type PrepareMeta,
  type PrepareRegistry,
  type ProjectCommand,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import { defaultVenvLinkPolicy, isVenvInterpreterLink, type VenvLinkPolicy } from "./workspace-links.js";
import { materializeMetaKnowledge } from "./meta-checkout.js";
import {
  createDevcontainerCli,
  devcontainerTarget,
  ensureDevcontainer,
  runDevcontainerCommand,
  type DevcontainerCli,
} from "./devcontainer.js";
import { runCollected, type CollectedProcess } from "./collected-process.js";
import { describeCommandFailure } from "./command-failure.js";
import { DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY } from "./devcontainer-policy.js";
import { evaluateReadiness, type CommandResult } from "./readiness.js";
import { startPrepareTestServices, type PrepareServices, type PrepareTestServices } from "./test-services-run.js";
import { SANDBOX_TARGET, executionFor } from "./execution-target.js";
import { assertLocalTaskExecutionAllowed, taskSandboxFor, taskShellSelection, type TaskShellSelection } from "./task-sandbox.js";
import { projectCommandEnvironment } from "./git.js";
import { runIsolatedGit, withIsolatedRepository } from "./isolated-repository.js";
import { CHECK_HISTORY_PATH, projectCheckKey, recordPreparedOutcomes } from "./verification/check-history.js";
import { assertCredentialFreeRemote, runGitWithCredential, type CredentialedGitRunner } from "./git-auth.js";
import type {
  RepositoryCloneCredential,
  RepositoryCredentialProvider,
} from "./repository-credentials.js";
import { openRegistrySession, removeLeftoverRegistryConfigs, type RegistrySession } from "./registry-config.js";
import { RegistryTokenLeakError, wipeWorkspaceForTaint } from "./registry-guard.js";
import type { RegistryCredentialProvider } from "./registry-credentials.js";
import { savedEnvMaterializer, type SavedEnvUseOptions } from "./saved-env/use.js";

const MANIFEST_PATH = ".agentx/preparation-manifest.json";
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
/**
 * Docker's data root on an EC2 worker's workspace volume (#121), so images, containers and named
 * volumes survive an idle stop. The boot script puts it there; it is root's, not the workspace's.
 * A dev container gets it hidden (devcontainer-policy.ts).
 */
export { DOCKER_DATA_DIRECTORY };

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
    /** A pull request's head the workspace has checked out (detached, read-only) for an agent-step run that looks at it. */
    checkedOut?: { pullRequest: number; headSha: string };
  }>;
  /**
   * Meta repo lane A3: the project's meta repository, materialized read-only and sparse (meta-checkout.ts). `resolvedCommit` is the `knowledgeCommit` every stage reads.
   * Absent from manifests written before it and for a project with no separate meta repository.
   */
  meta?: { name: string; path: string; defaultBranch: string; resolvedCommit: string; files: number; bytes: number; skipped: number; completedAt: string };
  completedSetupSteps: number[];
  /** The project's devcontainer (#121), recorded once it has started. */
  devcontainer?: {
    repository: string;
    configPath: string;
    containerId: string;
    /** The repository's folder inside the devcontainer, as its config mounts it (#128). */
    containerWorkspaceFolder?: string;
    startedAt: string;
  };
  readinessResults: Array<{
    index: number;
    ready: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /**
   * Spec 051 Ruling J: projectCheckKey of each readiness command this preparation ran, so a task's check knows which
   * commands passed at preparation. Absent from manifests written before it.
   */
  readinessCommandKeys?: string[];
  creationIdentity: string;
  complete: boolean;
  updatedAt: string;
  failure?: string;
  /**
   * N9 (B2, S2): a package registry token was, or may have been, left where the agent can read it. A tainted workspace is never resumed or reused: the next preparation removes everything
   * the project's code made and clones again (`wipeWorkspaceForTaint`).
   */
  tainted?: boolean;
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
  /** Test services (Prove, a candidate check): the plan's dependencies start for this preparation, its readiness test checks run sealed, and the usage record goes to `onUsageRecord`. Absent: today's preparation. */
  testServices?: PrepareTestServices;
  devcontainerCli?: DevcontainerCli;
  /**
   * Where setup and readiness commands run in a project without a devcontainer: the task sandbox (R56), started when the
   * first command runs and removed when preparation ends, or the local shell. Default: chosen from the worker's
   * environment, which is always the sandbox on EC2.
   */
  taskShell?: TaskShellSelection;
  /** Where preparation reports what it does not fail on. Messages arrive redacted. Default: the worker's log. */
  onDiagnostic?: (message: string) => void;
  /** P1: the default-branch head the broker read for each repository (a setup run). The preparation is refused if a repository's own resolution is not exactly its pin, or it has none. */
  pins?: ReadonlyArray<{ repository: string; commit: string }>;
  /** Internal worker-only trust anchor for the fixed top-level verifier backing directory. */
  trustedRuntimeBackingOwner?: Readonly<{ uid: number; gid: number }>;
  /** Where a virtual environment's interpreter links may point (see workspace-links.ts). Default: /usr/bin, /usr/local/bin and uv's managed Pythons, from the environment. */
  venvLinkPolicy?: VenvLinkPolicy;
  /**
   * Pull request heads an agent-step run looks at (Plan 3, Task 22): after a repository is cloned, each of its heads is fetched with the repository's read
   * credential and the first is checked out detached at exactly `headSha` (a head that has moved since the run started fails the preparation: a review
   * never looks at the wrong commit). The run's steps only ever read.
   */
  checkout?: ReadonlyArray<{ repository: string; pullRequest: number; headSha: string }>;
  /**
   * An agent-step run's preparation (Plan 3 final fix wave, runs I-2): clone and checkout only. The repository's own code is not run: no devcontainer,
   * no `project.setup` command and no readiness command, because the checkout may be a contributor's pull request head and the agent's steps only read.
   * The manifest is complete after the checkout, so a head that breaks the project's build can still be reviewed.
   */
  readOnly?: boolean;
  /**
   * Meta repo lane A3: the project's meta repository, which the project's own repositories no longer list. It is cloned like the others (same credential exchange and retries), then only
   * the listed knowledge paths are materialized, read-only, at the default branch's head. The preparation fails if it cannot: a task never runs without the team's rules.
   */
  meta?: PrepareMeta;
  /** Tests only: where a pull request head is fetched from (the repository's own URL by default; a fixture is not an HTTPS URL a project may name). */
  pullRequestRemote?: (repository: StoredProjectDefinition["repositories"][number]) => string;
  /** Tests only: how the credentialed pull request fetch runs Git (the real Git by default). */
  gitRunner?: CredentialedGitRunner;
  /**
   * N9 (INTG2): the project's private package registries. For the setup and readiness commands only, each registry's short-lived token is asked of the broker, its config is written
   * outside every repository, and every command's output is scrubbed for the tokens; the config is removed when the preparation ends (registry-config.ts). Sent only to a worker that lists
   * `prepare.registries.v1`; a project with a devcontainer is refused (the config folder is not mounted there).
   */
  registries?: readonly PrepareRegistry[];
  registryCredentialProvider?: RegistryCredentialProvider;
  /** The waits and log of the "Repository not found" retry (see `retryRepositoryNotFound`); tests replace them. */
  cloneRetry?: CloneRetryOptions;
  /**
   * Setup and test health SH23: the project's saved environment (an image of the repositories with their dependency folders, pulled by digest). Each repository tries it first and any failure clones fresh
   * and reports the failed step (saved-env/use.ts). Sent only to a worker that lists the saved environment feature (SH25).
   */
  savedEnv?: SavedEnvUseOptions;
}

export interface CloneRetryOptions {
  /** Waits before each retry; there are as many retries as waits. Default 2 s, then 5 s. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

const CLONE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
/** GitHub installation tokens last one hour: one this old is asked for again before a retry (the retries wait seconds, so this is the exception). */
const CREDENTIAL_REFRESH_AFTER_MS = 55 * 60_000;

/** Git's answer when GitHub refuses a repository (or, for a few seconds after it is issued, a new token): `remote: Repository not found.` */
function isRepositoryNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return [message, stderr].some((text) => typeof text === "string" && /Repository not found/i.test(text));
}

/** A repository's credential and when it was obtained, so a retry can reuse it and ask again only when it is nearly out of date. */
interface CredentialSession {
  credential: RepositoryCloneCredential;
  /** Runs a clone or fetch; when Git says "Repository not found" (only then) it is run again after each wait, and the last error is thrown as before. */
  retrying: <T>(operation: () => Promise<T>) => Promise<T>;
}

function credentialSession(options: PrepareWorkspaceOptions, repository: { name: string }, first: RepositoryCloneCredential, ask: () => Promise<RepositoryCloneCredential>): CredentialSession {
  const retry = options.cloneRetry ?? {};
  const delays = retry.delaysMs ?? CLONE_RETRY_DELAYS_MS;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const now = retry.now ?? Date.now;
  const log = retry.log ?? ((event: Record<string, unknown>) => { console.log(JSON.stringify({ component: "worker", ...event })); });
  let obtainedAt = now();
  const session: CredentialSession = {
    credential: first,
    async retrying(operation) {
      let failure: unknown;
      try {
        return await operation();
      } catch (error) {
        failure = error;
      }
      for (const [index, delayMs] of delays.entries()) {
        if (!isRepositoryNotFound(failure)) break;
        await sleep(delayMs);
        if (now() - obtainedAt >= CREDENTIAL_REFRESH_AFTER_MS) {
          try { session.credential = await ask(); obtainedAt = now(); } catch { /* keep the credential held; the retry reports Git's own answer */ }
        }
        try {
          const result = await operation();
          log({ event: "workspace.clone_retry", repository: repository.name, attempt: index + 1, delayMs, outcome: "succeeded" });
          return result;
        } catch (error) {
          failure = error;
          log({ event: "workspace.clone_retry", repository: repository.name, attempt: index + 1, delayMs, outcome: isRepositoryNotFound(error) ? "repository_not_found" : "failed" });
        }
      }
      throw failure;
    },
  };
  return session;
}

/**
 * Prepares the workspace. With a saved environment, a failure AFTER it was used (the checkout over the seed, or the project's setup and readiness over its dependencies) is not the end: the workspace is wiped,
 * the failed step is reported (`onFallback("checkout" | "setup")`), and the preparation runs once more WITHOUT the saved environment, as it always did. A failure of that second run is the real one.
 */
export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparationManifest> {
  if (options.savedEnv === undefined) return prepareWorkspaceOnce(options);
  try {
    return await prepareWorkspaceOnce(options);
  } catch (error) {
    if (!(error instanceof SeededPreparationFailure)) throw error;
    const root = await realpath(resolve(options.rootPath));
    await wipeWorkspaceForTaint(root);
    await rm(resolve(root, MANIFEST_PATH), { force: true });
    const { savedEnv: _used, ...withoutSavedEnv } = options;
    void _used;
    // Reported only when the fresh run SUCCEEDS: if it fails too, the fault is the project's, not the image's, and the image must not be marked stale (no rebuild storm).
    const manifest = await prepareWorkspaceOnce(withoutSavedEnv);
    (options.savedEnv.onDiagnostic ?? options.onDiagnostic ?? logPreparationDiagnostic)(`fresh setup (saved environment failed at ${error.step})`);
    options.savedEnv.onFallback?.(error.step);
    return manifest;
  }
}

/** A preparation that failed after the saved environment had been used: the caller starts over without it. */
class SeededPreparationFailure extends Error {
  constructor(readonly step: "checkout" | "setup", readonly original: unknown) { super(original instanceof Error ? original.message : "workspace preparation failed"); }
}

async function prepareWorkspaceOnce(options: PrepareWorkspaceOptions): Promise<PreparationManifest> {
  const project = StoredProjectDefinitionSchema.parse(options.project);
  const rootPath = resolve(options.rootPath);
  await mkdir(rootPath, { recursive: true });
  const canonicalRoot = await realpath(rootPath);
  const savedEnv = options.savedEnv === undefined ? undefined : savedEnvMaterializer({ ...options.savedEnv, workspaceRoot: canonicalRoot, onDiagnostic: options.savedEnv.onDiagnostic ?? options.onDiagnostic ?? logPreparationDiagnostic }, project.repositories, options.materializer ?? cloneRepository);
  const materializer = savedEnv ?? options.materializer ?? cloneRepository;
  const readOnly = options.readOnly === true;
  const target = readOnly ? undefined : devcontainerTarget(canonicalRoot, project);
  const runtimeBackingPath = options.trustedRuntimeBackingOwner === undefined
    ? undefined
    : resolve(canonicalRoot, RUNTIME_BACKING_DIRECTORY);
  if ((options.registries ?? []).length > 0 && target !== undefined) {
    throw new Error("a project with a devcontainer cannot use private package registries yet");
  }
  if ((options.registries ?? []).length > 0 && options.registryCredentialProvider === undefined) {
    throw new Error("package registries need the broker's credential exchange");
  }
  const devcontainerCli = target === undefined ? undefined : options.devcontainerCli ?? createDevcontainerCli();
  // With a devcontainer, setup and readiness run in it, like the agent's shell; without one, in the task sandbox (R56).
  const sandbox = readOnly || options.commandRunner !== undefined || (target !== undefined && devcontainerCli !== undefined)
    ? undefined
    : taskSandboxFor(options.taskShell ?? taskShellSelection(), { rootPath: canonicalRoot, taskId: options.creationIdentity ?? randomUUID() });
  const commandRunner = options.commandRunner
    ?? (target !== undefined && devcontainerCli !== undefined
      ? (command: ProjectCommand) => runDevcontainerCommand(devcontainerCli, target, command)
      : sandbox !== undefined
        ? (command: ProjectCommand) => executionFor(SANDBOX_TARGET, { sandbox }).runCommand(command)
        : (command: ProjectCommand, index: number, root: string) => runProjectCommand(command, index, root, undefined, true));
  // A crashed preparation may have left a registry config (and a token) behind: removed before anything else runs.
  await removeLeftoverRegistryConfigs(canonicalRoot);
  let registrySession: RegistrySession | undefined;
  let services: PrepareServices | undefined;
  let manifest = await loadOrCreateManifest(
    canonicalRoot,
    project,
    options.creationIdentity ?? "agentx-worker",
  );
  // N9: a tainted workspace is never resumed. Everything the project's code made is removed, and this attempt starts from a fresh clone and a fresh manifest.
  if (manifest.tainted === true) {
    await wipeWorkspaceForTaint(canonicalRoot);
    await rm(resolve(canonicalRoot, MANIFEST_PATH), { force: true });
    manifest = await loadOrCreateManifest(canonicalRoot, project, options.creationIdentity ?? "agentx-worker");
  }

  // A finished workspace is reused as it is, so the meta repository it holds must be the one asked for now (a task never reads a commit the broker did not pin for it).
  if (options.meta !== undefined && manifest.complete) {
    if (manifest.meta === undefined) throw new Error("the workspace was prepared without the meta repository");
    if (manifest.meta.resolvedCommit !== options.meta.commit) throw new Error("the workspace holds the meta repository at another commit than the one asked for");
  }
  // P1: a finished workspace is reused as it is only if it holds each repository at the commit the broker pinned for this preparation (not only by relying on the broker having asked for a new one).
  if (options.pins !== undefined && manifest.complete) {
    for (const repository of project.repositories) {
      const held = manifest.repositories.find((entry) => entry.name === repository.name);
      if (held === undefined || options.pins.find((pin) => pin.repository === repository.name)?.commit !== held.resolvedCommit) throw new Error(`the workspace holds ${repository.name} at another commit than the control plane pinned; try again`);
    }
  }
  if (manifest.complete) {
    await assertContainedSymlinks(canonicalRoot, canonicalRoot, options.trustedRuntimeBackingOwner, options.venvLinkPolicy);
    return manifest;
  }

  try {
    // N9: the registries' tokens exist from here to the end of this preparation, for the setup and readiness commands only. They are asked for FIRST: the repository grant
    // that authorizes the request lives 15 minutes from the invocation, and a slow clone must not outlast it. No token reaches a clone, which runs none of the project's code.
    if ((options.registries ?? []).length > 0) {
      registrySession = await openRegistrySession({
        rootPath: canonicalRoot,
        registries: options.registries!,
        provider: options.registryCredentialProvider!,
        onDiagnostic: options.onDiagnostic ?? logPreparationDiagnostic,
      });
    }
    const run: PreparationCommandRunner = registrySession === undefined ? commandRunner : registrySession.wrap(commandRunner);

    for (const repository of project.repositories) {
      if (manifest.repositories.some((entry) => entry.name === repository.name)) continue;
      const destination = containedPath(canonicalRoot, repository.path);
      assertRepositoryPathDoesNotOverlapRuntimeBacking(destination, runtimeBackingPath);
      const existing = await pathKind(destination);
      const askCredential = async (): Promise<RepositoryCloneCredential> => await options.credentialProvider?.(repository) ?? {};
      let session = credentialSession(options, repository, {}, askCredential);
      if (existing === "missing") {
        await mkdir(resolve(destination, ".."), { recursive: true });
        session = credentialSession(options, repository, await askCredential(), askCredential);
        await session.retrying(() => materializer(repository, destination, session.credential));
      } else {
        if (existing !== "directory" || (await pathKind(resolve(destination, ".git"))) === "missing") {
          throw new Error(`repository path already exists and is not a Git checkout: ${repository.path}`);
        }
      }
      const resolvedCommit = await resolveDefaultBranch(destination, repository.defaultBranch);
      if (options.pins !== undefined && options.pins.find((pin) => pin.repository === repository.name)?.commit !== resolvedCommit) {
        throw new Error(`the default branch of ${repository.name} is not at the commit the control plane pinned; try again`);
      }
      const head = await gitHead(destination);
      let checkedOut: { pullRequest: number; headSha: string } | undefined;
      if (existing === "missing") {
        await checkoutResolvedCommit(destination, resolvedCommit);
        checkedOut = await checkoutPullRequestHeads(destination, options.pullRequestRemote?.(repository) ?? repository.url, (options.checkout ?? []).filter((entry) => entry.repository === repository.name), session, options.gitRunner);
      } else if (head !== resolvedCommit) {
        throw new Error(
          `unrecorded checkout at ${repository.path} has HEAD ${head}; refusing to reset it`,
        );
      }
      await assertContainedSymlinks(canonicalRoot, canonicalRoot, options.trustedRuntimeBackingOwner, options.venvLinkPolicy);
      const now = new Date().toISOString();
      manifest.repositories.push({
        name: repository.name,
        path: repository.path,
        defaultBranch: repository.defaultBranch,
        resolvedCommit,
        resolvedAt: now,
        completedAt: now,
        ...(checkedOut === undefined ? {} : { checkedOut }),
      });
      manifest = await writeManifest(canonicalRoot, withoutFailure(manifest));
    }

    // The broker names the commit (`meta.commit`); a workspace prepared earlier at another one is not reused, so a task never reads a commit the broker did not pin for it.
    if (options.meta !== undefined && manifest.meta !== undefined && manifest.meta.resolvedCommit !== options.meta.commit) {
      throw new Error("the workspace holds the meta repository at another commit than the one asked for");
    }
    if (options.meta !== undefined && manifest.meta === undefined) {
      manifest = await writeManifest(canonicalRoot, withoutFailure({ ...manifest, meta: await prepareMetaRepository(canonicalRoot, options.meta, options, materializer, runtimeBackingPath) }));
    }

    if (readOnly) {
      // Nothing of the repository runs: the checkout is all an agent step reads.
      manifest = await writeManifest(canonicalRoot, withoutFailure({ ...manifest, readinessResults: [], complete: true }));
      return manifest;
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
          ...(started.remoteWorkspaceFolder ? { containerWorkspaceFolder: started.remoteWorkspaceFolder } : {}),
          startedAt: new Date().toISOString(),
        },
      }));
    }

    services = await startPrepareTestServices({ options: options.testServices, sandbox, devcontainer: target !== undefined, operationId: options.creationIdentity ?? "agentx-worker", rootPath: canonicalRoot, repositoryPaths: project.repositories.map((repository) => resolve(canonicalRoot, repository.path)) });
    for (const [index, command] of project.setup.entries()) {
      if (manifest.completedSetupSteps.includes(index)) continue;
      let result: CommandResult;
      try {
        result = await run(command, index, canonicalRoot);
      } catch (error) {
        // A leaked registry token is not a step result: it stops the preparation and taints the workspace.
        if (error instanceof RegistryTokenLeakError) throw error;
        // For example, the step's directory does not exist: still say which step (#154).
        result = { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : "setup command could not run" };
      }
      // A step that its timeout stopped failed, even when it exited 0 on SIGTERM (#170).
      if (result.exitCode !== 0 || result.timedOut === true) {
        throw new Error(describeCommandFailure("setup step", index, command, result));
      }
      await assertContainedSymlinks(canonicalRoot, canonicalRoot, options.trustedRuntimeBackingOwner, options.venvLinkPolicy);
      manifest.completedSetupSteps.push(index);
      manifest = await writeManifest(canonicalRoot, withoutFailure(manifest));
    }

    const readiness = await evaluateReadiness(
      { rootPath: canonicalRoot, commands: project.readiness },
      services?.sealedReadiness(run) ?? run,
    );
    // The readiness runner turns an error into a result; a leak found by a check's scan is thrown here instead.
    const leak = registrySession?.leak();
    if (leak !== undefined) throw leak;
    // VL-1: a readiness command runs code of the repository's as well, after the last check of the setup steps. A link it left to somewhere outside the workspace is refused here,
    // before anything is recorded as the result (a failed readiness included), and before the check history under `.agentx` is written.
    // S4-L2: and made after the sandbox is gone, so a process a readiness command left running cannot make a link after the check. The test-services record is taken first and the sandbox removed
    // (both are safe to do again, as the end of this function does). A devcontainer outlives the preparation: what is read from this workspace later must not follow links either.
    await services?.finish();
    // A sandbox that could not be removed may still run a readiness command's background process, so the check below would prove nothing: the preparation is not complete (the manifest says so).
    if (await sandbox?.dispose() === false) throw new Error("the task sandbox could not be removed after the readiness commands, so the workspace was not checked for links and is not complete");
    await assertContainedSymlinks(canonicalRoot, canonicalRoot, options.trustedRuntimeBackingOwner, options.venvLinkPolicy);
    const readinessFailure = readiness.ready ? undefined : describeReadinessFailure(project.readiness, readiness.results);
    // Spec 051 Ruling M: before the workspace is READY, so a task never plans from an outcome this preparation replaced.
    if (readiness.ready) await resetCheckHistory(canonicalRoot, project.readiness, options.onDiagnostic ?? logPreparationDiagnostic);
    const readinessManifest: PreparationManifest = {
      ...manifest,
      readinessResults: readiness.results,
      readinessCommandKeys: project.readiness.map(projectCheckKey),
      complete: readiness.ready,
      ...(readinessFailure !== undefined ? { failure: readinessFailure } : {}),
    };
    manifest = await writeManifest(
      canonicalRoot,
      readiness.ready ? withoutFailure(readinessManifest) : readinessManifest,
    );
    if (readinessFailure !== undefined) throw new Error(readinessFailure);
    return manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace preparation failed";
    // The manifest is on the workspace disk: a clone, Git or devcontainer error can carry a secret (#170).
    // A leaked registry token taints the workspace: it is not resumed, and the next attempt clones again.
    await writeManifest(canonicalRoot, { ...manifest, complete: false, ...(error instanceof RegistryTokenLeakError ? { tainted: true } : {}), failure: registrySession === undefined ? redactText(message) : registrySession.scrub(redactText(message)) });
    // After the saved environment was used, a failure to check out or to set up is reported to the caller, who wipes and starts over without it (`prepareWorkspace`). A leaked token is never retried.
    if (savedEnv?.used() === true && !(error instanceof RegistryTokenLeakError)) throw new SeededPreparationFailure(manifest.repositories.length < project.repositories.length ? "checkout" : "setup", error);
    throw error;
  } finally {
    // The registries' config first: nothing that fails after it can leave a token on the disk. A config that cannot be removed fails the preparation and taints the workspace (S2).
    let removalFailure: unknown;
    await services?.finish();
    try { await registrySession?.dispose(); } catch (disposeError) { removalFailure = disposeError; }
    await savedEnv?.dispose();
    await sandbox?.dispose();
    if (removalFailure !== undefined) {
      await writeManifest(canonicalRoot, { ...manifest, complete: false, tainted: true, failure: removalFailure instanceof Error ? removalFailure.message : "the package registry config could not be removed" }).catch(() => undefined);
      // Deliberate: a token that could not be removed fails the preparation, whatever the body returned or threw.
      // eslint-disable-next-line no-unsafe-finally
      throw removalFailure instanceof Error ? removalFailure : new RegistryTokenLeakError();
    }
  }
}

/**
 * Meta repo lane A3: clones the meta repository (once; a resumed preparation finds it recorded) and materializes its knowledge paths. The repository entry is the request's, whose
 * folder must not overlap another repository's or the reserved backing directory, as for any repository.
 */
async function prepareMetaRepository(
  canonicalRoot: string,
  meta: PrepareMeta,
  options: PrepareWorkspaceOptions,
  materializer: RepositoryMaterializer,
  runtimeBackingPath: string | undefined,
): Promise<NonNullable<PreparationManifest["meta"]>> {
  const entry = meta.repository;
  if (options.project.repositories.some((other) => other.name === entry.name || other.path === entry.path || other.path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${other.path}/`))) {
    throw new Error("the meta repository's name or folder is also another repository's");
  }
  const destination = containedPath(canonicalRoot, entry.path);
  assertRepositoryPathDoesNotOverlapRuntimeBacking(destination, runtimeBackingPath);
  const repository = { ...entry } as StoredProjectDefinition["repositories"][number];
  const askCredential = async (): Promise<RepositoryCloneCredential> => await options.credentialProvider?.(repository) ?? {};
  // A folder here is the leftover of an attempt that stopped before the manifest recorded it (the manifest is written after the files are in place): it is ours, contained in the
  // workspace, and read-only knowledge only, so it is removed and cloned again rather than trusted.
  if (await pathKind(destination) !== "missing") await rm(destination, { recursive: true, force: true });
  await mkdir(resolve(destination, ".."), { recursive: true });
  const session = credentialSession(options, repository, await askCredential(), askCredential);
  await session.retrying(() => materializer(repository, destination, session.credential));
  // The commit is the broker's. It must be in the clone and on the default branch (the head the broker read, or an ancestor of the head the clone sees), or nothing is read.
  const head = await resolveDefaultBranch(destination, entry.defaultBranch);
  const commit = meta.commit;
  const present = await runIsolatedGit(destination, ["cat-file", "-e", `${commit}^{commit}`], { timeout: 30_000, maxBuffer: 4_096 }).then(() => true, () => false);
  const onBranch = present && (commit === head || await runIsolatedGit(destination, ["merge-base", "--is-ancestor", commit, head], { timeout: 30_000, maxBuffer: 4_096 }).then(() => true, () => false));
  if (!onBranch) throw new Error("the meta repository does not hold the commit asked for on its default branch");
  const done = await materializeMetaKnowledge(destination, commit, meta);
  await assertContainedSymlinks(canonicalRoot, canonicalRoot, options.trustedRuntimeBackingOwner, options.venvLinkPolicy);
  return { name: entry.name, path: entry.path, defaultBranch: entry.defaultBranch, resolvedCommit: commit, files: done.files, bytes: done.bytes, skipped: done.skipped, completedAt: new Date().toISOString() };
}

/**
 * Spec 051 Ruling N: a history that cannot be written must not outlive preparation, or its stale outcomes would set a
 * later task's before. So a failed write removes the file and is reported; only a failed removal fails preparation.
 */
async function resetCheckHistory(rootPath: string, readiness: readonly ProjectCommand[], onDiagnostic: (message: string) => void): Promise<void> {
  try {
    await recordPreparedOutcomes(rootPath, readiness);
    return;
  } catch (error) {
    try {
      // Recursive: the path may not be a file. rm removes a symbolic link itself, never its target.
      await rm(resolve(rootPath, CHECK_HISTORY_PATH), { recursive: true, force: true });
    } catch (removalError) {
      throw new Error(redactText(
        `AgentX could neither write nor remove the workspace's check history (${CHECK_HISTORY_PATH}): ${errorMessage(removalError)}`,
      ), { cause: removalError });
    }
    try {
      onDiagnostic(redactText(
        `AgentX could not write the workspace's check history, so it removed it; the next task's checks start without earlier results: ${errorMessage(error)}`,
      ));
    } catch { /* Reporting must not fail preparation. */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logPreparationDiagnostic(message: string): void {
  console.log(JSON.stringify({ component: "worker", event: "prepare.diagnostic", message }));
}

/** #154: the first failed readiness check, and how many more failed. */
function describeReadinessFailure(
  commands: readonly ProjectCommand[],
  results: ReadonlyArray<CommandResult & { index: number; ready: boolean }>,
): string {
  const failed = results.filter((result) => !result.ready);
  const first = failed[0];
  const command = first === undefined ? undefined : commands[first.index];
  if (first === undefined || command === undefined) return "one or more readiness checks failed";
  const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
  return describeCommandFailure("readiness check", first.index, command, first, more);
}

async function loadOrCreateManifest(
  rootPath: string,
  project: StoredProjectDefinition,
  creationIdentity: string,
): Promise<PreparationManifest> {
  const path = resolve(rootPath, MANIFEST_PATH);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PreparationManifest;
    // A tainted manifest is wiped by the caller, whatever revision it was pinned to.
    if (parsed.tainted === true) return parsed;
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
  // The clone above is the only thing that has touched `destination`: nothing else exists there yet (the caller clones only a path that was missing, and the
  // agent and the project's commands start after every repository is prepared), so its config holds what `git clone` wrote. Read as a value, in the same
  // way as every other read of a workspace repository's config.
  const remote = await withIsolatedRepository(destination, "read", {}, (repository) => repository.remoteUrl("origin"));
  assertCredentialFreeRemote(remote ?? "");
}

async function resolveDefaultBranch(directory: string, branch: string): Promise<string> {
  try {
    const stdout = await runIsolatedGit(directory, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], { timeout: 30_000, maxBuffer: 4_096 });
    return stdout.trim();
  } catch {
    throw new Error(`repository default branch does not exist: ${branch}`);
  }
}

async function checkoutResolvedCommit(directory: string, commit: string): Promise<void> {
  // A --no-checkout clone can report the requested commit from HEAD while its
  // working tree is still empty. Always materialize the resolved branch head.
  await runIsolatedGit(directory, ["checkout", "--detach", "--force", commit], { timeout: 120_000, maxBuffer: MAX_COMMAND_OUTPUT_BYTES });
  const resolved = await gitHead(directory);
  if (resolved !== commit) throw new Error("repository did not check out the resolved branch commit");
}

/**
 * Fetches each pull request head named for the repository and checks the first out, detached, at exactly the commit the run recorded. The commit is fetched by
 * its sha, so a head the author moved since the run started is still the commit the run was asked to look at; a commit the repository no longer holds falls back to
 * the pull request's own ref, and a head that is not the recorded commit fails: the run reviews what it was asked to review or nothing.
 */
async function checkoutPullRequestHeads(
  directory: string,
  remoteUrl: string,
  heads: ReadonlyArray<{ pullRequest: number; headSha: string }>,
  session: CredentialSession,
  run?: CredentialedGitRunner,
): Promise<{ pullRequest: number; headSha: string } | undefined> {
  for (const head of heads) {
    const ref = `refs/remotes/origin/pull/${String(head.pullRequest)}/head`;
    assertCredentialFreeRemote(remoteUrl);
    const hasCommit = async (): Promise<boolean> => (await runIsolatedGit(directory, ["cat-file", "-e", `${head.headSha}^{commit}`], { timeout: 30_000, maxBuffer: 4_096 }).then(() => true, () => false));
    // The repository's own URL, as every other network call of the worker names it (a hardened Git ignores the clone's `origin`).
    try {
      await runGitWithCredential({ directory, args: ["fetch", "--no-tags", remoteUrl, head.headSha], cwd: directory, credential: session.credential, timeout: 300_000, maxBuffer: MAX_COMMAND_OUTPUT_BYTES, ...(run === undefined ? {} : { run }) });
    } catch {
      // A server that does not serve a commit by its sha: the pull request's ref is read instead, and must name that commit.
    }
    if (!await hasCommit()) {
      await session.retrying(() => runGitWithCredential({
        directory,
        args: ["fetch", "--no-tags", remoteUrl, `+refs/pull/${String(head.pullRequest)}/head:${ref}`],
        cwd: directory,
        credential: session.credential,
        timeout: 300_000,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        ...(run === undefined ? {} : { run }),
      }));
      const fetched = (await runIsolatedGit(directory, ["rev-parse", "--verify", `${ref}^{commit}`], { timeout: 30_000, maxBuffer: 4_096 })).trim();
      if (fetched !== head.headSha) throw new Error(`pull request ${String(head.pullRequest)} has a new commit since the run started; start the run again`);
    }
  }
  const first = heads[0];
  if (first === undefined) return undefined;
  await checkoutResolvedCommit(directory, first.headSha);
  return { pullRequest: first.pullRequest, headSha: first.headSha };
}

/**
 * Before an agent step runs: each repository the step's payload names a pull request head for must be checked out at exactly that commit (the first head of the
 * repository, which is the one preparation checks out). A workspace moved off the commit, or one that never held it, does not run the step: a review never looks
 * at the wrong code.
 */
export async function verifyCheckedOutHeads(
  rootPath: string,
  manifest: Pick<PreparationManifest, "repositories">,
  checkout: ReadonlyArray<{ repository: string; pullRequest: number; headSha: string }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const head of checkout) {
    if (seen.has(head.repository)) continue;
    seen.add(head.repository);
    const repository = manifest.repositories.find((entry) => entry.name === head.repository);
    const mismatch = new Error(`the workspace is not at the recorded commit of pull request ${String(head.pullRequest)}; start the run again`);
    if (repository === undefined) throw mismatch;
    const directory = containedPath(rootPath, repository.path);
    if (await gitHead(directory).catch(() => undefined) !== head.headSha) throw mismatch;
  }
}

async function gitHead(directory: string): Promise<string> {
  const stdout = await runIsolatedGit(directory, ["rev-parse", "HEAD"], { timeout: 30_000, maxBuffer: 4_096 });
  return stdout.trim();
}

/** A project command (`setup` or `readiness`) as a child of the worker: tests and a developer's machine only. Spec 051: `signal` stops it, as a check rerun needs. */
export async function runProjectCommand(
  command: ProjectCommand,
  _index: number,
  rootPath: string,
  signal?: AbortSignal,
  /** The caller was told to use the local shell (taskShell: local); otherwise AGENTX_TASK_SHELL=local must say so. */
  explicitLocal = false,
): Promise<CommandResult> {
  // A child of the worker: refused on the EC2 runtime, and unless asked for, so project commands run in the task sandbox (R56).
  assertLocalTaskExecutionAllowed(process.env, { explicit: explicitLocal });
  const cwd = containedPath(rootPath, command.cwd);
  // The workspace-relative path only: Node's own error would show the worker's absolute path (#154).
  const cwdStat = await stat(cwd).catch(() => undefined);
  if (cwdStat === undefined) throw new Error(`directory does not exist in this workspace: ${command.cwd}`);
  if (!cwdStat.isDirectory()) throw new Error(`command cwd is not a directory: ${command.cwd}`);
  let result: CollectedProcess;
  try {
    result = await runCollected(command.executable, command.args, {
      cwd,
      timeoutMs: command.timeoutSeconds * 1_000,
      // A project command is the project's own code: it keeps the worker's Git settings.
      env: projectCommandEnvironment(cwd, command.env),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    // The command could not start (for example, its executable does not exist).
    return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : "command could not start" };
  }
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    ...(result.timedOut === true ? { timedOut: true } : {}),
  };
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

function pathContains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function assertRepositoryPathDoesNotOverlapRuntimeBacking(repositoryPath: string, runtimeBackingPath: string | undefined): void {
  if (runtimeBackingPath !== undefined
    && (pathContains(runtimeBackingPath, repositoryPath) || pathContains(repositoryPath, runtimeBackingPath))) {
    throw new Error("repository path overlaps the reserved verifier runtime backing directory");
  }
}

async function assertTrustedRuntimeBacking(
  rootPath: string,
  runtimeBackingOwner: Readonly<{ uid: number; gid: number }>,
): Promise<void> {
  const backingPath = resolve(rootPath, RUNTIME_BACKING_DIRECTORY);
  const metadata = await lstat(backingPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== runtimeBackingOwner.uid || metadata.gid !== runtimeBackingOwner.gid
    || (metadata.mode & 0o777) !== 0o755 || await realpath(backingPath) !== backingPath) {
    throw new Error("trusted verifier runtime backing directory is not the fixed private root");
  }
}

async function assertContainedSymlinks(
  rootPath: string,
  directory = rootPath,
  runtimeBackingOwner?: Readonly<{ uid: number; gid: number }>,
  venvLinkPolicy?: VenvLinkPolicy,
): Promise<void> {
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
    if (directory === rootPath && runtimeBackingOwner !== undefined && entry.name === RUNTIME_BACKING_DIRECTORY) {
      await assertTrustedRuntimeBacking(rootPath, runtimeBackingOwner);
      continue;
    }
    const entryPath = resolve(directory, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(entryPath);
      } catch {
        // A virtual environment's interpreter link may point at an interpreter this process cannot see (the task sandbox's filesystem differs): judged by its text alone.
        if (await isVenvInterpreterLink(entryPath, venvLinkPolicy ?? defaultVenvLinkPolicy())) continue;
        throw new Error(`broken symlink is not allowed in workspace: ${relative(rootPath, entryPath)}`);
      }
      // Likewise one that resolves outside the workspace, to /usr/bin/python3 for example. Nothing else may leave it.
      if (!pathContains(rootPath, target) && await isVenvInterpreterLink(entryPath, venvLinkPolicy ?? defaultVenvLinkPolicy())) continue;
      containedPath(rootPath, relative(rootPath, target));
    } else if (metadata.isDirectory() && entry.name !== ".git") {
      await assertContainedSymlinks(rootPath, entryPath, runtimeBackingOwner, venvLinkPolicy);
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

/**
 * The prepare result's record of where each repository was checked out, before any agent runs: the broker keeps it
 * as the task's base. Omitted unless every repository has a 40-hex commit (the broker's `baseCommitSha` is 40-hex only, so a 64-hex commit could not be stored; a setup run's pins may be 64-hex and then keep
 * no `preparedBase`, which fails closed).
 */
export function preparedBaseResult(manifest: PreparationManifest): { preparedBase?: Array<{ repositoryId: string; baseCommitSha: string }>; knowledgeCommit?: string } {
  // Meta repo lane A3: the meta repo's commit, reported beside the code bases (the broker keeps it as the task's `knowledgeCommit`).
  const knowledge = manifest.meta !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.meta.resolvedCommit) ? { knowledgeCommit: manifest.meta.resolvedCommit } : {};
  if (manifest.repositories.length === 0 || !manifest.repositories.every((repository) => /^[a-f0-9]{40}$/.test(repository.resolvedCommit))) return knowledge;
  return { preparedBase: manifest.repositories.map((repository) => ({ repositoryId: repository.name, baseCommitSha: repository.resolvedCommit })), ...knowledge };
}
