// Private packages P2a (owner decision 254zzz434, PRIVATE-PACKAGES-PLAN-CHECK-OPUS (c), P2-PLAN): the INSTALL CONTAINER.
//
// ONE Rovara-owned step of the worker's preparation, after the clone and the meta repository and BEFORE any devcontainer, test service, setup or readiness command or sandbox of the workspace:
//   for each repository whose lockfile or `.npmrc` names the company's package registry (GitHub Packages), run the IMAGE's npm or yarn 1 (scripts off) in a throw-away container on its own walled `rvbp` bridge, with the company's
//   token in a file on the host tmpfs `/run/rovara-install/<operation>/` (mounted read-only into that container only), and the node_modules written into the repository and the tarballs into `<workspace>/.agentx-pkgcache`.
// The token then goes: the file and its folder are removed and their absence is asserted, the workspace is scanned for the token (every spelling, and by hash for every token ever issued for it), and only then may any sandbox start
// (`assertNoInstallSecrets` is called by every start path). The project's own commands never see the token; they reinstall from the cache, offline (package-cache.ts).
//
// A per-repository outcome (an unaccepted token, a refused manager) is RECORDED in the manifest (`privateInstall`), never thrown. Only the fail-closed cases throw `RegistryTokenLeakError` and taint the workspace: a token found
// where the agent can read it, a file or container that cannot be removed, a scan that cannot finish, a repository's tracked files or history that changed.
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { REGISTRY_TOKEN_MIN_LENGTH, agentXError, isPrivateRegistryHost, scrubRegistrySecrets, type PrepareRegistry, type RegistryCredential } from "@agentx/contracts";
import { isSlotCollision } from "./setup-network.js";
import {
  GITHUB_PACKAGES_HOST, PRIVATE_INSTALL_SENTENCES, classifyInstallOutput, inspectRepository, isRetryable, parseNpmrc, renderDerivedNpmrc, renderUserNpmrc, renderYarnrc, selectManager,
  type InstallManager, type InstallRunResult, type LockfileKind, type PrivateInstallOutcome, type RepositoryInspection,
} from "./private-install-plan.js";
import {
  INSTALL_LABEL, INSTALL_WORKSPACE_LABEL, assertInstallContainerArgs, installContainerArgs, installContainerName, installNetworkAddresses, installNetworkCreateArgs, installNetworkName, installNetworkSlot, installRepositoryKey,
  type InstallContainerInput,
} from "./private-install-container.js";
import { PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_FOLDERS, PACKAGE_CACHE_MARKER } from "./package-cache.js";
import { INSTALL_SECRETS_ROOT, assertSecureInstallTmpfs, openInstallDirectory, sweepInstallSecrets, type InstallDirectory } from "./install-secrets.js";
import { GIT_CHANGED_MESSAGE, RegistryTokenLeakError, gitStates, gitStatesDiffer, readIssuedTokens, recordIssuedTokens, workspaceHoldsToken, type IssuedTokenRecord } from "./registry-guard.js";
import { runIsolatedGit } from "./isolated-repository.js";
import { TASK_SANDBOX_LABEL, TASK_SANDBOX_WORKSPACE_LABEL, workspaceKey } from "./task-sandbox.js";
import type { RegistryCredentialProvider } from "./registry-credentials.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";

export const REPOSITORY_INSTALL_MS = 10 * 60_000;
export const STEP_INSTALL_MS = 20 * 60_000;
export const NETWORK_RETRY_DELAY_MS = 10_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
/** What a token may be made of for the config files to carry it without quoting or expansion (the same rule as registry-config.ts). */
const SAFE_TOKEN = /^[A-Za-z0-9._~+/=-]+$/u;

export interface PrivateInstallEntry {
  repo: string;
  host: string;
  manager: LockfileKind | "unknown";
  lockfileSha256?: string;
  outcome: PrivateInstallOutcome;
  /** For `refused_npmrc_key`: the KEY that was refused (never its value). */
  detail?: string;
}

export interface PrivateInstallOptions {
  docker: DockerCli;
  /** The worker's own image (AGENTX_SANDBOX_IMAGE). */
  image: string | undefined;
  operationId: string;
  /** The broker's credential exchange (P1a). The token is asked for once, after every repository is decided, and only when at least one repository needs it. */
  provider: RegistryCredentialProvider;
  environment?: NodeJS.ProcessEnv;
  /** Tests only; production is `/run/rovara-install`. */
  secretsRoot?: string;
  /** A rebuild of the project's saved environment: the one read-only preparation that installs (an agent-step or review preparation never does). */
  savedEnvBuild?: boolean;
  /** Tests only: replaces the tmpfs check. */
  assertTmpfs?: (root: string) => Promise<void>;
  hostCpus?: number;
  hostMemoryBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}

export interface PrivateInstallInput {
  options: PrivateInstallOptions | undefined;
  readOnly: boolean;
  /** The canonical workspace root. */
  rootPath: string;
  repositories: ReadonlyArray<{ name: string; path: string }>;
  /** The company's registries for the supported host (see `splitRegistries`); empty when the company holds no token. */
  registries: readonly PrepareRegistry[];
  hasDevcontainer: boolean;
  /** The manifest's record from an earlier attempt of this preparation (the resume rule). */
  previous: readonly PrivateInstallEntry[] | undefined;
  onDiagnostic: (message: string) => void;
}

/** The registries of a prepare payload split by who holds the credential: the company's (this step's) and the rest (CodeArtifact, which keeps N9's project-command path). */
export function splitRegistries(registries: readonly PrepareRegistry[] | undefined): { company: PrepareRegistry[]; others: PrepareRegistry[] } {
  const company: PrepareRegistry[] = [];
  const others: PrepareRegistry[] = [];
  for (const registry of registries ?? []) {
    let host: string | undefined;
    try { host = new URL(registry.url).hostname.toLowerCase(); } catch { host = undefined; }
    (host !== undefined && isPrivateRegistryHost(host) ? company : others).push(registry);
  }
  return { company, others };
}

/** Whether a preparation of this shape installs private packages: never a read-only one (a pull request head's lockfile could name any org package), except a saved-environment rebuild. */
export const privateInstallApplies = (readOnly: boolean, options: PrivateInstallOptions | undefined): boolean => options !== undefined && (!readOnly || options.savedEnvBuild === true);

// ---- the plan: decided per repository BEFORE any token is fetched

interface InstallJob {
  repo: string;
  directory: string;
  manager: InstallManager;
  entry: PrivateInstallEntry;
  /** The kept lines of the repository's `.npmrc` (npm only; absent when it has none): the derived copy is made from them. */
  keptNpmrc?: string[];
  githubScopes: string[];
}
type Planned = { kind: "skip" } | { kind: "entry"; entry: PrivateInstallEntry } | { kind: "job"; job: InstallJob };

interface Context {
  input: PrivateInstallInput;
  options: PrivateInstallOptions;
  root: string;
  environment: NodeJS.ProcessEnv;
  companyScopes: string[];
  now: () => number;
  log: (event: Record<string, unknown>) => void;
}

const contained = (root: string, path: string): string | undefined => {
  const candidate = resolve(root, path);
  const from = relative(root, candidate);
  return from === "" || from === ".." || from.startsWith(`..${sep}`) ? undefined : candidate;
};

const entryOf = (repo: string, inspected: RepositoryInspection | undefined, outcome: PrivateInstallOutcome, detail?: string): PrivateInstallEntry => {
  const manager: PrivateInstallEntry["manager"] = inspected?.lockfiles.length === 1 ? inspected.lockfiles[0]! : "unknown";
  return { repo, host: GITHUB_PACKAGES_HOST, manager, ...(inspected?.lockfileSha256 === undefined ? {} : { lockfileSha256: inspected.lockfileSha256 }), outcome, ...(detail === undefined ? {} : { detail }) };
};

async function alreadyInstalled(ctx: Context, repo: string, directory: string, inspected: RepositoryInspection): Promise<PrivateInstallEntry | undefined> {
  const earlier = ctx.input.previous?.find((entry) => entry.repo === repo);
  if (earlier?.outcome !== "installed" || earlier.lockfileSha256 !== inspected.lockfileSha256) return undefined;
  const modules = await lstat(join(directory, "node_modules")).catch(() => undefined);
  return modules?.isDirectory() === true ? earlier : undefined;
}

/** The refusal that does not need a token, in the plan's order; undefined when the repository can join the install set. */
function refusalFor(ctx: Context, inspected: RepositoryInspection): { outcome: PrivateInstallOutcome; detail?: string } | undefined {
  if (ctx.input.registries.length === 0) return { outcome: "untested_missing" };
  if (ctx.input.hasDevcontainer) return { outcome: "refused_devcontainer" };
  if (ctx.environment["AGENTX_RUNTIME"] !== "ec2" || ctx.options.image === undefined || ctx.options.image === "") return { outcome: "refused_not_ec2" };
  if (inspected.npmrc.kind === "other") return { outcome: "refused_npmrc_key", detail: "(not a regular file)" };
  return undefined;
}

async function planRepository(ctx: Context, repository: { name: string; path: string }): Promise<Planned> {
  const directory = contained(ctx.root, repository.path);
  if (directory === undefined) return { kind: "skip" };
  let inspected: RepositoryInspection;
  try { inspected = await inspectRepository(directory); } catch { return { kind: "skip" }; }
  if (!inspected.namesHost) return { kind: "skip" };
  const refused = refusalFor(ctx, inspected);
  if (refused !== undefined) return { kind: "entry", entry: entryOf(repository.name, inspected, refused.outcome, refused.detail) };
  const selection = selectManager(inspected.lockfiles);
  if (!selection.ok) return { kind: "entry", entry: entryOf(repository.name, inspected, selection.outcome) };
  const reading = inspected.npmrc.kind === "file" ? parseNpmrc(inspected.npmrc.text, ctx.companyScopes) : undefined;
  if (reading?.ok === false) return { kind: "entry", entry: entryOf(repository.name, inspected, "refused_npmrc_key", reading.key) };
  const earlier = await alreadyInstalled(ctx, repository.name, directory, inspected);
  if (earlier !== undefined) return { kind: "entry", entry: earlier };
  const entry = entryOf(repository.name, inspected, "installed");
  return { kind: "job", job: { repo: repository.name, directory, manager: selection.manager, entry, githubScopes: reading?.githubScopes ?? [], ...(reading === undefined || selection.manager !== "npm" ? {} : { keptNpmrc: reading.kept }) } };
}

// ---- the run

const refusedAll = (jobs: readonly InstallJob[], outcome: PrivateInstallOutcome): PrivateInstallEntry[] => jobs.map((job) => ({ ...job.entry, outcome }));

/** A task sandbox of this workspace that is alive: the step does not begin (its token would be reachable from it). */
async function assertNoLiveSandboxes(docker: DockerCli, workspace: string): Promise<void> {
  const listed = await docker.run(["ps", "--quiet", "--filter", `label=${TASK_SANDBOX_LABEL}`, "--filter", `label=${TASK_SANDBOX_WORKSPACE_LABEL}=${workspace}`], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  if (listed.exitCode !== 0 || listed.stdout.trim() !== "") throw agentXError("RUNTIME_UNAVAILABLE", "Rovara did not install private packages because a sandbox of this workspace is already running");
}

async function fetchToken(ctx: Context): Promise<{ token: string } | { outcome: PrivateInstallOutcome }> {
  let credential: RegistryCredential;
  try { credential = await ctx.options.provider(ctx.input.registries[0]!.name); } catch { return { outcome: "failed_token_unavailable" }; }
  const expired = credential.expiresAt !== undefined && Date.parse(credential.expiresAt) <= ctx.now();
  if (!SAFE_TOKEN.test(credential.token) || credential.token.length < REGISTRY_TOKEN_MIN_LENGTH || expired) return { outcome: "refused_unsafe_token" };
  return { token: credential.token };
}

interface RunState {
  ctx: Context;
  token: string;
  workspace: string;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
}

const call = (docker: DockerCli, args: string[]) => docker.run(args, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
const NO_SUCH = /no such (?:container|object|network)/iu;

/** `docker rm --force`, and a look that it is gone. False when the container may still run. */
async function removeContainer(docker: DockerCli, name: string): Promise<boolean> {
  await call(docker, ["kill", name]);
  await call(docker, ["rm", "--force", name]);
  const found = await call(docker, ["inspect", "--format", "{{.Id}}", name]);
  return found.exitCode !== 0 && NO_SUCH.test(`${found.stderr}${found.stdout}`);
}

async function createNetwork(docker: DockerCli, operationId: string, workspace: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const created = await call(docker, installNetworkCreateArgs(operationId, workspace, installNetworkAddresses(installNetworkSlot(operationId, attempt))));
    if (created.exitCode === 0) return installNetworkName(operationId);
    if (!isSlotCollision(`${created.stderr}${created.stdout}`)) break;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not set up the network for the package install");
}

async function runOnce(state: RunState, args: string[]): Promise<InstallRunResult> {
  const left = Math.min(REPOSITORY_INSTALL_MS, state.deadline - state.ctx.now());
  if (left <= 0) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  const result = await state.ctx.options.docker.run(args, { timeoutMs: left }).catch(() => ({ exitCode: -1, stdout: "", stderr: "", timedOut: false }));
  // The output is scrubbed for the token in memory before ANYTHING else reads it.
  const scrub = (text: string): string => scrubRegistrySecrets(text, [state.token]);
  return { exitCode: result.exitCode, stdout: scrub(result.stdout), stderr: scrub(result.stderr), timedOut: result.timedOut === true };
}

async function runJob(state: RunState, job: InstallJob, directory: InstallDirectory): Promise<PrivateInstallOutcome> {
  const { ctx } = state;
  const input: InstallContainerInput = {
    operationId: ctx.options.operationId, repository: job.repo, workspace: state.workspace, image: ctx.options.image!, rootPath: ctx.root, repositoryDirectory: job.directory, manager: job.manager, secretsDirectory: directory.directory,
    ...(job.keptNpmrc === undefined ? {} : { derivedNpmrc: true }), hostCpus: ctx.options.hostCpus ?? availableParallelism(), hostMemoryBytes: ctx.options.hostMemoryBytes ?? totalmem(),
  };
  const args = installContainerArgs(input);
  assertInstallContainerArgs(args, input);
  const name = installContainerName(ctx.options.operationId, job.repo);
  let outcome: PrivateInstallOutcome = "failed_unknown";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runOnce(state, args);
    outcome = classifyInstallOutput(result);
    // A stop that did not stop: the container may still hold the token and write the workspace.
    if (!await removeContainer(ctx.options.docker, name)) throw new RegistryTokenLeakError("Rovara could not confirm that the package install container stopped, so the workspace was set aside and will be set up again from a fresh clone");
    if (!isRetryable(outcome) || attempt === 1) break;
    await state.sleep(NETWORK_RETRY_DELAY_MS);
  }
  return outcome;
}

/** The token files: the npm userconfig, the yarn rc, an empty global config, and for an npm repository with an `.npmrc` its derived copy. */
async function writeTokenFiles(directory: InstallDirectory, jobs: readonly InstallJob[], scopes: readonly string[], token: string, operationId: string): Promise<void> {
  await directory.write("npmrc", renderUserNpmrc(scopes, token));
  await directory.write("yarnrc", renderYarnrc(scopes, token));
  await directory.write("empty", "");
  for (const job of jobs) {
    if (job.keptNpmrc !== undefined) await directory.write(`${installRepositoryKey(operationId, job.repo)}.npmrc`, renderDerivedNpmrc(job.keptNpmrc, scopes, token));
  }
}

/** The cache folders, real directories of the worker's with a `.gitignore` of `*` (a link or file a task left in their place is removed first, never followed). */
async function prepareCache(root: string, managers: ReadonlySet<InstallManager>): Promise<void> {
  const base = join(root, PACKAGE_CACHE_DIRECTORY);
  const info = await lstat(base).catch(() => undefined);
  if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory())) await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  await writeFile(join(base, ".gitignore"), "*\n");
  for (const manager of managers) await mkdir(join(base, PACKAGE_CACHE_FOLDERS[manager]), { recursive: true });
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error("the package install failed"));

async function executeJobs(state: RunState, jobs: readonly InstallJob[], scopes: readonly string[]): Promise<PrivateInstallEntry[]> {
  const { ctx } = state;
  const secretsRoot = ctx.options.secretsRoot ?? INSTALL_SECRETS_ROOT;
  const docker = ctx.options.docker;
  let directory: InstallDirectory | undefined;
  let network: string | undefined;
  const results: PrivateInstallEntry[] = [];
  let failure: unknown;
  try {
    await prepareCache(ctx.root, new Set(jobs.map((job) => job.manager)));
    directory = await openInstallDirectory(secretsRoot, ctx.options.operationId);
    await writeTokenFiles(directory, jobs, scopes, state.token, ctx.options.operationId);
    network = await createNetwork(docker, ctx.options.operationId, state.workspace);
    for (const job of jobs) results.push({ ...job.entry, outcome: await runJob(state, job, directory) });
  } catch (error) {
    failure = error;
  }
  // The token goes FIRST, whatever happened: the file and its folder, and their absence asserted. A removal that fails is a leak and wins over any other failure.
  let removalFailure: unknown;
  try { await directory?.remove(); } catch (error) { removalFailure = error; }
  for (const job of jobs) if (!await removeContainer(docker, installContainerName(ctx.options.operationId, job.repo))) removalFailure ??= new RegistryTokenLeakError("Rovara could not remove the package install container, so the workspace was set aside and will be set up again from a fresh clone");
  if (network !== undefined) await call(docker, ["network", "rm", network]);
  if (removalFailure !== undefined) throw asError(removalFailure);
  if (failure !== undefined) throw asError(failure);
  return results;
}

/** After the run: the repositories' tracked files and history are as before, a log the package manager left is removed. */
async function assertRepositoriesUntouched(root: string, jobs: readonly InstallJob[], before: Map<string, string>): Promise<void> {
  if (gitStatesDiffer(before, await gitStates(root))) throw new RegistryTokenLeakError(GIT_CHANGED_MESSAGE);
  for (const job of jobs) {
    for (const log of ["npm-debug.log", "yarn-error.log"]) await rm(join(job.directory, log), { force: true }).catch(() => undefined);
    const status = await runIsolatedGit(job.directory, ["status", "--porcelain=v1", "--untracked-files=no"], { timeout: 120_000, maxBuffer: 1_048_576 }).catch(() => "unreadable");
    if (status.trim() !== "") throw new RegistryTokenLeakError(GIT_CHANGED_MESSAGE);
  }
}

async function scanWorkspace(root: string, token: string, issued: readonly IssuedTokenRecord[], sinceMs: number): Promise<void> {
  if (await workspaceHoldsToken({ rootPath: root, skip: [], secrets: [token], issued, changedSinceMs: sinceMs })) throw new RegistryTokenLeakError();
}

async function installAll(ctx: Context, jobs: readonly InstallJob[]): Promise<PrivateInstallEntry[]> {
  const { options } = ctx;
  const workspace = workspaceKey(ctx.root);
  await assertNoLiveSandboxes(options.docker, workspace);
  try { await (options.assertTmpfs ?? assertSecureInstallTmpfs)(options.secretsRoot ?? INSTALL_SECRETS_ROOT); } catch { return refusedAll(jobs, "refused_no_secure_tmpfs"); }
  const fetched = await fetchToken(ctx);
  if ("outcome" in fetched) return refusedAll(jobs, fetched.outcome);
  const issued = await readIssuedTokens(ctx.root);
  await recordIssuedTokens(ctx.root, [fetched.token]);
  const startedAt = ctx.now();
  const before = await gitStates(ctx.root);
  const state: RunState = { ctx, token: fetched.token, workspace, deadline: startedAt + STEP_INSTALL_MS, sleep: options.sleep ?? ((ms) => new Promise<void>((done) => { setTimeout(done, ms); })) };
  const scopes = [...new Set([...ctx.companyScopes, ...jobs.flatMap((job) => job.githubScopes)])];
  const results = await executeJobs(state, jobs, scopes);
  await assertRepositoriesUntouched(ctx.root, jobs, before);
  await scanWorkspace(ctx.root, fetched.token, issued, startedAt - 2_000);
  if (results.some((entry) => entry.outcome === "installed")) await writeFile(join(ctx.root, PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_MARKER), "installed\n");
  return results;
}

/**
 * The step. Answers the manifest's part (`{}` when the step does not apply or found nothing to do), and throws only the fail-closed cases (RegistryTokenLeakError, a sandbox already running, a network that could not be made).
 */
export async function runPrivateInstallStep(input: PrivateInstallInput): Promise<{ privateInstall?: PrivateInstallEntry[] }> {
  const options = input.options;
  if (options === undefined || !privateInstallApplies(input.readOnly, options)) return {};
  const environment = options.environment ?? process.env;
  const log = options.log ?? ((event: Record<string, unknown>) => { console.log(JSON.stringify({ component: "worker", ...event })); });
  const ctx: Context = { input, options, root: resolve(input.rootPath), environment, companyScopes: [...new Set(input.registries.flatMap((registry) => (registry.scope === undefined ? [] : [registry.scope])))], now: options.now ?? Date.now, log };
  const entries: PrivateInstallEntry[] = [];
  const jobs: InstallJob[] = [];
  for (const repository of input.repositories) {
    const planned = await planRepository(ctx, repository);
    if (planned.kind === "entry") entries.push(planned.entry);
    else if (planned.kind === "job") jobs.push(planned.job);
  }
  const results = jobs.length === 0 ? [] : await installAll(ctx, jobs);
  const all = [...entries, ...results];
  for (const entry of all) {
    log({ event: "private-install.repository", repository: entry.repo, manager: entry.manager, outcome: entry.outcome });
    if (entry.outcome !== "installed") input.onDiagnostic(`${entry.repo}: ${PRIVATE_INSTALL_SENTENCES[entry.outcome]}`);
  }
  return all.length === 0 ? {} : { privateInstall: all };
}

// ---- the worker's wiring

/** The options main.ts gives a prepare invocation: the host Docker, the worker's own image, the broker's credential exchange. */
export function privateInstallOptionsFor(input: { operationId: string; provider: RegistryCredentialProvider; savedEnvBuild: boolean; docker?: DockerCli; environment?: NodeJS.ProcessEnv }): PrivateInstallOptions {
  const environment = input.environment ?? process.env;
  return { docker: input.docker ?? createDockerCli(), image: environment["AGENTX_SANDBOX_IMAGE"], operationId: input.operationId, provider: input.provider, environment, ...(input.savedEnvBuild ? { savedEnvBuild: true } : {}) };
}

// ---- worker start, and the credential's memory

/** At worker start: what a crashed step left (its token folder, its containers and bridge). Answers what went; throws RegistryTokenLeakError when the token folder cannot be cleared. */
export async function removeLeftoverPrivateInstall(workspace: string, docker: DockerCli, secretsRoot: string = INSTALL_SECRETS_ROOT): Promise<{ files: number; containers: number; networks: number }> {
  const files = await sweepInstallSecrets(secretsRoot);
  const filters = ["--filter", `label=${INSTALL_LABEL}`, "--filter", `label=${INSTALL_WORKSPACE_LABEL}=${workspace}`];
  const ids = async (args: string[]): Promise<string[]> => {
    const listed = await call(docker, args);
    return listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(line)) : [];
  };
  const containers = await ids(["ps", "--all", "--quiet", ...filters]);
  if (containers.length > 0) await call(docker, ["rm", "--force", ...containers]);
  const networks = await ids(["network", "ls", "--quiet", ...filters]);
  for (const id of networks) await call(docker, ["network", "rm", id]);
  return { files, containers: containers.length, networks: networks.length };
}

/** Wraps the credential provider so the tokens it hands out are remembered for the saved-image build's secret scan (the install token is gone from the machine by then, but a copy in an image layer must still be found). */
export function rememberRegistryTokens(provider: RegistryCredentialProvider): { provider: RegistryCredentialProvider; values(): readonly string[] } {
  const seen = new Set<string>();
  return {
    provider: async (registry) => {
      const credential = await provider(registry);
      if (credential.token.length >= 8) seen.add(credential.token);
      return credential;
    },
    values: () => [...seen],
  };
}
