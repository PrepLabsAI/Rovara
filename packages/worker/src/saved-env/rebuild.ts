// Saved project images (SV wiring): the worker's half of a rebuild job. The broker made a read-only preparation PINNED to the job's commits (`pins`) with `savedEnvBuild` in its payload; the worker prepared the
// workspace (the worker's own clone, nothing run on it), and this runs `proveAndBuildSavedImage` on it:
//   - the "fresh sandbox" is a sandbox over that prepared workspace, not started until the build says so (`BuildSandbox`): the build copies each repository's `.git` out of the sandbox's reach first, and refuses a
//     sandbox that has started a process (`not_fresh`). Its project commands go through `executionFor(SANDBOX_TARGET, { sandbox })`, the only way any project command starts here;
//   - `notFrom` is the worker's own live lease and sandbox registry: every other operation active on this machine and every other running task sandbox. Nothing is taken from the job payload. A machine that is doing
//     anything else does not build (the workspace root is shared, so another operation here would share the workspace);
//   - the base image digest in the job is the digest of the image this worker runs project commands in (its own AGENTX_SANDBOX_IMAGE); a worker on another image, or one whose image is not pinned by digest, refuses
//     before it builds anything (`key_mismatch`, `base_image`). The digest is worker-wide: one image for the whole environment, not a project's;
//   - `forbiddenValues` are this machine's secrets: the credential-shaped environment variables, the preparation's grant, callback capability and lease token, and the clone credentials the preparation itself fetched (remembered as
//     it fetched them: nothing is fetched again before the project's code runs);
//   - the push login and the result go to the broker's two lease routes with the operation's callback capability and the job's lease token (a token that only the dispatcher handed over, at delivery).
// The result is posted whatever it is (a failure is a fixed word), and the sandbox, the workspace's checkouts and everything the build made are removed. Nothing about the lease token leaves this file: it is not logged.
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  SAVED_ENV_PUSH_LOGIN_PATH, SAVED_ENV_RESULT_PATH, SavedEnvRegistryAuthSchema, agentXError, imageDigestOfReference,
  type SavedEnvBuildResult, type SavedEnvRegistryAuth, type WorkerInvocation,
} from "@agentx/contracts";
import { SANDBOX_TARGET, executionFor, proveCommandPort } from "../execution-target.js";
import type { PreparationManifest } from "../prepare.js";
import type { RepositoryCredentialProvider } from "../repository-credentials.js";
import { credentialShapedVariables } from "../setup-agent.js";
import { TaskSandbox, TASK_SANDBOX_LABEL } from "../task-sandbox.js";
import type { DockerCli } from "../swebench/containers.js";
import { buildRepositoriesOf, proveAndBuildSavedImage, realBuildPorts, type BuildSandbox, type SavedEnvBuildInput, type SavedEnvBuildPorts } from "./build.js";

/** The most the Prove run may take inside a rebuild (the build's own deadlines add to this). */
export const SAVED_ENV_PROVE_DEADLINE_MS = 40 * 60_000;
const POST_ATTEMPTS = 3;

export interface RebuildSandboxMaker {
  (input: { rootPath: string; operationId: string; docker: DockerCli; environment: NodeJS.ProcessEnv }): TaskSandbox;
}

/** A sandbox over the prepared workspace. Not started until `start()`; `stopProcesses` removes the container and keeps the workspace; `dispose` also removes the checkouts (nothing else uses this workspace). */
export function workspaceBuildSandbox(input: { rootPath: string; operationId: string; checkouts: readonly string[]; sandbox: TaskSandbox; now?: () => number }): BuildSandbox {
  let started = false;
  const commands = executionFor(SANDBOX_TARGET, { sandbox: input.sandbox });
  const unavailable = async (): Promise<never> => { throw agentXError("RUNTIME_UNAVAILABLE", "this worker cannot start an environment's services yet"); };
  return {
    id: `saved-env-build-${input.operationId}`,
    rootPath: input.rootPath,
    ports: {
      runCommand: proveCommandPort(commands),
      startMock: unavailable,
      probePreprod: unavailable,
      mockUnmatched: async () => [],
      buildCoverageMap: async () => undefined,
      now: input.now ?? Date.now,
    },
    hasStarted: () => started,
    async start() { started = true; await input.sandbox.start(); },
    async stopProcesses() { await input.sandbox.dispose(); },
    async dispose() {
      await input.sandbox.dispose().catch(() => undefined);
      for (const directory of input.checkouts) await rm(path.join(input.rootPath, directory), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface SavedEnvRebuildDependencies {
  rootPath: string;
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  /** The preparation's manifest: the commits the worker's own clone is at. */
  manifest: Pick<PreparationManifest, "repositories">;
  docker: DockerCli;
  /** The worker's live lease and sandbox registry: every OTHER operation active on this machine, as `{ id, rootPath }`. */
  otherOperations(): Promise<ReadonlyArray<{ id: string; rootPath: string }>>;
  /** The clone credential values the PREPARATION already fetched (`rememberCredentials` wraps its provider): only to keep them out of the image. No credential is fetched again for the build. */
  cloneCredentialValues?: () => readonly string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  fetchImplementation?: typeof fetch;
  /** Test seams. */
  sandbox?: RebuildSandboxMaker;
  ports?: (base: Pick<SavedEnvBuildPorts, "docker" | "makeFresh" | "pushSession">) => SavedEnvBuildPorts;
  build?: typeof proveAndBuildSavedImage;
  postAttempts?: number;
}

/** The running task sandboxes of this machine, other than `own`, as the registry the build must not share a workspace with. */
export async function liveTaskSandboxes(docker: DockerCli, rootPath: string, own: string): Promise<Array<{ id: string; rootPath: string }>> {
  const listed = await docker.run(["ps", "--filter", `label=${TASK_SANDBOX_LABEL}`, "--format", "{{.Names}}"], { timeoutMs: 30_000 });
  if (listed.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", "the task sandboxes could not be listed");
  return listed.stdout.split("\n").map((name) => name.trim()).filter((name) => name !== "" && name !== own).map((name) => ({ id: name, rootPath }));
}

/** Wraps the preparation's credential provider so the values it hands out are remembered (for the build's secret scan). The wrapped provider is the only thing that ever fetches the clone credential. */
export function rememberCredentials(provider: RepositoryCredentialProvider): { provider: RepositoryCredentialProvider; values(): readonly string[] } {
  const seen = new Set<string>();
  return {
    provider: async (repository) => {
      const credential = await provider(repository);
      for (const value of [credential.password, credential.token, credential.ssh?.privateKey]) if (value !== undefined && value.length >= 8) seen.add(value);
      return credential;
    },
    values: () => [...seen],
  };
}

export function forbiddenValuesOf(deps: Pick<SavedEnvRebuildDependencies, "invocation" | "cloneCredentialValues" | "environment">, leaseToken: string): string[] {
  const environment = deps.environment ?? process.env;
  const values = new Set<string>([deps.invocation.payload.repositoryGrant, deps.invocation.callbackCapability, leaseToken, ...(deps.cloneCredentialValues?.() ?? [])]);
  for (const name of credentialShapedVariables(environment)) {
    const value = environment[name];
    if (value !== undefined && value.length >= 8) values.add(value);
  }
  return [...values];
}

/** Runs the job: builds the image, posts the result to the broker, and returns it. Throws only when there is nothing to post a result with (no lease token). */
export async function runSavedEnvRebuild(deps: SavedEnvRebuildDependencies): Promise<SavedEnvBuildResult> {
  const job = deps.invocation.payload.savedEnvBuild;
  if (job === undefined) throw agentXError("CONFIG_INVALID", "this preparation carries no saved image build");
  const leaseToken = job.leaseToken;
  if (leaseToken === undefined) throw agentXError("CONFIG_INVALID", "the saved image build has no lease");
  const send = deps.fetchImplementation ?? fetch;
  const base = `${deps.controlPlaneUrl.replace(/\/$/, "")}/v1/internal/workspaces/${deps.invocation.workspaceId}/operations/${deps.invocation.operationId}`;
  // The two lease routes answer to the operation's callback capability (it lives as long as the build); the repository grant is 15 minutes and is long gone when the push is done.
  const headers = { "content-type": "application/json", "x-agentx-callback-capability": deps.invocation.callbackCapability };
  const environment = deps.environment ?? process.env;

  const post = async (route: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    const response = await send(`${base}/${route}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("refused"); }
    return response.json();
  };
  const pushSession = async (request: { repository: string }): Promise<SavedEnvRegistryAuth | undefined> => {
    try {
      const answer = await post(SAVED_ENV_PUSH_LOGIN_PATH, { jobId: job.jobId, leaseToken }, 60_000) as { login?: unknown };
      const parsed = SavedEnvRegistryAuthSchema.safeParse(answer.login);
      return parsed.success && parsed.data.repository === request.repository ? parsed.data : undefined;
    } catch { return undefined; }
  };

  const failure = (reason: Extract<SavedEnvBuildResult, { ok: false }>["reason"], step?: string): SavedEnvBuildResult => ({ ok: false, reason, ...(step === undefined ? {} : { step }) });
  let result: SavedEnvBuildResult;
  try {
    const commits = new Map(Object.entries(job.commits));
    // The worker's own clone is at the commits the job was queued for (the preparation was pinned to them): anything else is not built.
    const prepared = new Map(deps.manifest.repositories.map((repository) => [repository.name, repository.resolvedCommit]));
    const sameCommits = prepared.size === commits.size && [...commits].every(([name, commit]) => prepared.get(name) === commit);
    // The key holds the base image's digest; the image THIS worker runs the project's commands in (AGENTX_SANDBOX_IMAGE, the worker image) must be that one. A worker left on another image (after a rollback, say) builds nothing.
    const ownImage = imageDigestOfReference(environment["AGENTX_SANDBOX_IMAGE"]);
    if (!sameCommits) {
      result = failure("not_default_branch", "commits");
    } else if (ownImage === undefined) {
      result = failure("unsafe_tree", "base_image");
    } else if (ownImage !== job.baseImageDigest) {
      result = failure("unsafe_tree", "key_mismatch");
    } else {
      const repositories = buildRepositoriesOf(deps.invocation.payload.project.repositories, commits);
      const others = [...await deps.otherOperations(), ...await liveTaskSandboxes(deps.docker, deps.rootPath, "")];
      const makeSandbox: RebuildSandboxMaker = deps.sandbox ?? ((input) => new TaskSandbox({ rootPath: input.rootPath, taskId: `saved-env-${input.operationId}`, docker: input.docker, environment: input.environment }));
      const makeFresh = async (): Promise<BuildSandbox> => workspaceBuildSandbox({
        rootPath: deps.rootPath, operationId: deps.invocation.operationId, checkouts: repositories.map((repository) => repository.directory),
        sandbox: makeSandbox({ rootPath: deps.rootPath, operationId: deps.invocation.operationId, docker: deps.docker, environment }),
      });
      const builderImage = environment["AGENTX_SAVED_ENV_BUILDER_IMAGE"];
      const input: SavedEnvBuildInput = {
        repository: job.repository, environment: job.environment, approved: job.approved, expectedKey: job.expectedKey, repositories, detectorGlobs: job.detectorGlobs, secretNames: job.secretNames, baseImageDigest: job.baseImageDigest,
        notFrom: others, forbiddenValues: forbiddenValuesOf(deps, leaseToken), signal: deps.signal ?? new AbortController().signal, proveDeadlineMs: SAVED_ENV_PROVE_DEADLINE_MS,
        ...(builderImage === undefined || builderImage === "" ? {} : { builderImage }),
      };
      const baseline = { docker: deps.docker, makeFresh, pushSession };
      result = await (deps.build ?? proveAndBuildSavedImage)(input, deps.ports === undefined ? realBuildPorts(baseline) : deps.ports(baseline));
    }
  } catch {
    result = failure("build_failed", "unexpected");
  }

  // The result goes to the broker whatever it is; a broker that does not answer is tried a few times, and the build's fixed word is all that is logged.
  let posted = false;
  for (let attempt = 0; attempt < (deps.postAttempts ?? POST_ATTEMPTS) && !posted; attempt += 1) {
    try { await post(SAVED_ENV_RESULT_PATH, { jobId: job.jobId, leaseToken, result }, 120_000); posted = true; } catch { /* tried again */ }
  }
  console.log(JSON.stringify({ component: "worker", event: "saved-env.rebuild", jobId: job.jobId, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }), posted }));
  return result;
}
