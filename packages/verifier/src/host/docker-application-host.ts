import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2E_EXECUTOR_APP_ORIGIN, E2EExecutorPlanSchema, readE2EApplicationProjectContract, redactText, type E2EApplicationExecutionAdmission,
  type E2ECollection, type E2EExecutorAccount, type E2EExecutorPlan, type E2ELease, type E2ERunInput } from "@agentx/contracts";
import type { E2EActualApplicationRun } from "../application-collection.js";
import type { E2EApplicationRuntimePorts } from "../application-runtime.js";
import { validateE2EApplicationExecutionAdmission } from "../application-scenarios.js";
import { createCredentialRedactor } from "../executor/redact.js";
import { executorContainerArgs } from "./executor-container.js";
import { verifyExecutorSeccompProfile } from "./executor-seccomp.js";
import { openRegularFile, readRegularFileTail } from "./regular-file.js";
import { SINKHOLE_ORIGIN_REF, planApplicationOrigins, mockOriginUrl } from "../application-mocks.js";
import { SINKHOLE_ORIGIN, parseMockLedger, withholdMockLedgerCredentials, type ParsedMockLedger } from "./mock-ledger.js";
import { assembleDockerCollectionInputs, assembleExecutorActualRun, dockerOwnedResourceInventory, readExecutorActionWindows, readExecutorResultFile, snapshotExecutorOutput, validateExecutorResult,
  type DockerCollectionInputs, type ExecutorOutputSnapshot, type ExecutorResultFile } from "./executor-readback.js";

export { dockerOwnedResourceInventory, dockerOwnedResourceInventoryDigest, dockerOwnedCleanupReceipt } from "./executor-readback.js";
export type { DockerCollectionInputs } from "./executor-readback.js";

/**
 * The one way the host talks to Docker. `code` is the process exit code, 124 when `timeoutMs` elapsed first and 130 when
 * `signal` aborted first; in both cases the invoked docker CLI is killed, which does not stop a container it started.
 */
export type DockerCli = { run(args: string[], opts: { signal: AbortSignal; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> };

const OUTPUT_CAP_BYTES = 1024 * 1024;
/**
 * How much of the executor's own `executor.log` is kept in the diagnostics of a run that ended without a trustworthy result. The file is read with some margin
 * and redacted whole before it is cut to this size, so a credential that straddles the cut cannot survive as a fragment.
 */
const EXECUTOR_OWN_LOG_BYTES = 32 * 1024;
const EXECUTOR_OWN_LOG_READ_BYTES = 40 * 1024;
const tailOf = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
};

/** The real `DockerCli`: one `docker` process per call, killed on timeout or abort. */
export function createProcessDockerCli(binary = "docker"): DockerCli {
  return { run: (args, opts) => new Promise((resolve) => {
    let stdout = ""; let stderr = ""; let settled = false;
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const settle = (code: number, extra = "") => {
      if (settled) return;
      settled = true; clearTimeout(timer); opts.signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr: `${stderr}${extra}` });
    };
    // A killed docker CLI is not waited for: a stuck child must not outlive the deadline the caller set.
    const onAbort = () => { child.kill("SIGKILL"); settle(130); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, opts.timeoutMs);
    if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout = tailOf(`${stdout}${chunk.toString("utf8")}`, OUTPUT_CAP_BYTES); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = tailOf(`${stderr}${chunk.toString("utf8")}`, OUTPUT_CAP_BYTES); });
    child.once("error", (error) => settle(127, `\ncould not run ${binary}: ${error.message}`));
    child.once("close", (code) => settle(code ?? 1));
  }) };
}

export const ROVARA_RUN_LABEL = "rovara.run";
export const ROVARA_CREATED_LABEL = "rovara.created";
const SAFE_RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
/**
 * The two per-run networks and their fixed Linux bridge names. The host firewall (`packages/worker/ec2/boot.sh`) walls bridges off by name:
 * `rvb*` (builds: the internet, no host, no private ranges) and `rvi*` (app and executor: internal, no host). The suffix is 8 hex of the run id's
 * digest, so the name is always valid and at most 11 of the 15 characters an interface name may have.
 */
export function e2eRunNetworks(runId: string): { internal: string; build: string; internalBridge: string; buildBridge: string } {
  const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 8);
  return { internal: `rovara-e2e-${runId}`, build: `rovara-e2e-build-${runId}`, internalBridge: `rvi${suffix}`, buildBridge: `rvb${suffix}` };
}
/**
 * A run's resources older than this are swept as stale at the start of every allocation (`sweepStaleRovaraRuns`). Every application group deadline must stay
 * strictly below it, or a run still inside its own deadline could be swept away by a sibling run's allocation.
 */
export const STALE_RUN_SWEEP_AGE_MS = 3_600_000;
/** How long past the plan deadline the host waits for the executor to exit by itself before killing it, unless told otherwise. */
export const DEFAULT_DEADLINE_GRACE_MS = 15_000;
/** The pinned Node base image that builds a web/API candidate and runs it. */
export const WEB_API_BUILD_IMAGE = "public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const ADMIN_TIMEOUT_MS = 30_000;
const MAX_TAIL_BYTES = 64 * 1024;
const APP_PORT = 4317;
const BUILD_COPY_TIMEOUT_MS = 120_000;
const SUPPORTED_SEED_PROFILE = "orders-seed/v1";
const SUPPORTED_AUTH_PROFILE = "orders-auth/v1";
const FORBIDDEN_ENV_NAME = /token|secret/i;
/** Blank on every container, so an ambient proxy or Node option can never reach the candidate, the build or the executor. */
const BLANKED_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_OPTIONS"].flatMap((name) => ["-e", `${name}=`]);
const limits = (memory: string, pids: string, cpus: string) => ["--memory", memory, "--memory-swap", memory, "--pids-limit", pids, "--cpus", cpus];
const IMAGE_PULL_TIMEOUT_MS = 300_000;
const OWNED_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The entry point of the executor image, which has a second mode: an approved origin's mock, or the sinkhole. */
const MOCK_ENTRY_POINT = "/opt/agentx/packages/verifier/dist/executor/entry.js";
const MOCK_LEDGER_READ_BYTES = 4 * 1024 * 1024;
const MOCK_READY_POLL_MS = 50;
const MOCK_READY_TIMEOUT_MS = 15_000;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type DockerApplicationUnavailableReason = "build-failed" | "app-unhealthy" | "app-exited" | "deadline-exceeded" | "executor-failed"
  | "executor-result-mismatch" | "mock-unavailable" | "cancelled";

export type DockerApplicationHostDeps = Readonly<{
  docker: DockerCli;
  /** The executor image (Task 1.3): plan mounted read-only, an empty writable out directory. */
  executorImage: string;
  /** The pinned Node base image that builds the candidate and runs it. */
  buildImage: string;
  /** A directory on the Docker host at the same path inside the worker container; each run gets `<runRoot>/<runId>`. */
  runRoot: string;
  /**
   * The seccomp profile file the executor container runs under (the Docker CLI reads it here, in the worker container, and sends its content to the
   * daemon). Default: the installed `executor-seccomp.json`. The host refuses to be built over any file whose digest is not the one pinned in contracts.
   */
  executorSeccompProfile?: string;
  now(): number;
  /** The admission the round was started from, and the one runnable application group this host owns. */
  admission: E2EApplicationExecutionAdmission;
  groupId: string;
  /** An already-staged tree of the exact candidate commit (the worker writes its blobs from `git ls-tree` and `git cat-file` over a throwaway repository, never `git archive` or a checkout); never written to. */
  candidateSourceDir: string;
  /** How long to wait before pulling a missing image again after a failed pull. Default 2000. */
  imagePullRetryMs?: number;
  /** How long to wait for the mocks and the sinkhole to listen. Default 15000. */
  mockReadyMs?: number;
  /** How often the app container is checked while the executor runs. Default 1000. */
  appPollMs?: number;
  /** How long past the plan deadline the host waits for the executor to exit by itself before killing it. Default 15000. */
  deadlineGraceMs?: number;
  /**
   * Extra files placed next to the seed in the read-only `/app/.owned` mount, by plain file name. Qualification uses it for the
   * seeded defects its negative probes must catch; the recipe's env names the path.
   */
  ownedFiles?: Readonly<Record<string, string | Uint8Array>>;
  /**
   * Called once with the out directory of a run the executor completed (exit 0 or 1, a result file that agrees and names this run and
   * group), before the run's resources are removed. It is never called for a run without a trustworthy result, and never with a
   * credential: `containsCredential` answers whether bytes carry one of the run's account credentials. A call is advisory: it may
   * happen for a run that is then stopped by the deadline or a cancellation, so it never implies a result, let alone PASS.
   */
  onRunOutput?(run: { outDir: string; accountProfileIds: readonly string[]; containsCredential(bytes: Uint8Array): boolean }): Promise<void>;
  /** Test seams: build the lifecycle's readback and the collector's protected inputs once cleanup is confirmed. */
  assemble?: typeof assembleExecutorActualRun;
  assembleCollectionInputs?: typeof assembleDockerCollectionInputs;
}>;

/** One build container's outcome as the host saw it. `exitCode` is the exit code docker returned, or null when the command timed out or the run ended it. */
export type DockerBuildResult = Readonly<{ /** 0 is the source copy; 1 and up are the recipe's commands in order. */ commandIndex: number; exitCode: number | null;
  command: Readonly<{ program: string; args: readonly string[]; cwd: string; timeoutMs: number; env: Readonly<Record<string, string>> }> | null }>;

export type DockerApplicationHost = E2EApplicationRuntimePorts & Readonly<{
  /** Redacted log tails of the run (64 KiB at most each); empty for a run this host did not allocate. */
  readDiagnostics(runId: string): { appLogTail: string; buildLogTail: string; executorLogTail: string };
  /**
   * The structured outcome of the last build container that ran: the failing command for a build that failed, the last command for one that
   * succeeded, null when no build container ran (or for a run this host did not allocate). Read this, never the build log, for an exit code.
   */
  readBuildResult(runId: string): DockerBuildResult | null;
  /**
   * The inputs `collectE2EApplicationRun` needs besides the actual run, the compiled suite, the binding and the round: the
   * observation bindings and assertion assets the executor persisted, the cleanup receipt and inventory digest, the close time
   * (`ownedClosedAt`), and the runner's own environment, limits and usage. Available only after confirmed cleanup of a completed run.
   */
  readCollectionInputs(signal: AbortSignal): Promise<DockerCollectionInputs>;
}>;

type Outcome =
  | Readonly<{ kind: "completed"; exitCode: 0 | 1; snapshot: ExecutorOutputSnapshot }>
  | Readonly<{ kind: "unavailable"; reason: DockerApplicationUnavailableReason }>;

type RunSeed = { accounts: { email: string; passwordDigest: string; subjectId: string; tenantId: string; role: string; displayName: string }[] };

function safeProfileLabel(profileId: string): string {
  const label = profileId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return label.length > 0 ? label : "account";
}

/** One synthetic account per profile the group's cases use; the password reaches only the plan mount and the seed digest. */
function createRunAccounts(profiles: readonly { profileId: string; tenantRef: string; roleRef: string }[]): { accounts: E2EExecutorAccount[]; seed: RunSeed } {
  const accounts: E2EExecutorAccount[] = [];
  const seed: RunSeed = { accounts: [] };
  for (const profile of profiles) {
    const email = `rovara-${safeProfileLabel(profile.profileId)}-${randomBytes(3).toString("hex")}@example.test`;
    const password = randomBytes(24).toString("base64url");
    accounts.push({ profileId: profile.profileId, email, password });
    seed.accounts.push({ email, passwordDigest: sha(password), subjectId: `subject-${randomUUID()}`, tenantId: profile.tenantRef, role: profile.roleRef,
      displayName: `Rovara ${profile.profileId}`.slice(0, 120) });
  }
  return { accounts, seed };
}

const RECIPE_CWD = /^(?:\.|[A-Za-z0-9_@-][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9_@-][A-Za-z0-9._@-]*)*)$/;
function containerCwd(root: string, cwd: string): string {
  if (!RECIPE_CWD.test(cwd) || cwd.split("/").includes("..")) throw new Error("recipe working directory is not a plain relative path");
  return cwd === "." ? root : `${root}/${cwd}`;
}

/**
 * Builds the exact candidate in a build container on its own per-run bridge (internet only, firewalled from the host and private ranges), runs it
 * on a per-run `--internal` network, runs the Rovara executor against it, and removes everything the run created. One host owns one run (the group named in `deps`); concurrent rounds
 * use one host each. Allocation prepares the run's network, workspace, seed and plan; execution builds, starts the app and
 * waits for the executor until the plan deadline; `close` removes every resource labeled `rovara.run=<runId>`.
 */
export function createDockerApplicationHost(deps: DockerApplicationHostDeps): DockerApplicationHost {
  const validated = validateE2EApplicationExecutionAdmission(deps.admission);
  const foundSuite = validated.applicationSuites.find((suite) => suite.group.groupId === deps.groupId);
  const foundBinding = validated.admission.round.groupBindings.find((item) => item.groupId === deps.groupId);
  if (!foundSuite || !foundBinding) throw new Error("docker application host group is not a runnable application group of its admission");
  const compiled = foundSuite;
  const binding = foundBinding;
  if (!SAFE_RUN_ID.test(binding.runId)) throw new Error("docker application host run id is not a plain identifier");
  const runId = binding.runId;
  const applicationIds = compiled.originByApplicationId.map((item) => item.applicationId);
  if (applicationIds.length !== 1) throw new Error("docker application host runs exactly one application per group");
  const applicationId = applicationIds[0]!;
  const approved = compiled.applicationBindings.get(applicationId)?.approval.applications.find((item) => item.applicationId === applicationId);
  if (!approved) throw new Error("docker application host group has no approved recipe for its application");
  const recipe = approved.recipe;
  if (recipe.launch.kind !== "service") throw new Error("docker application host runs service recipes only");
  if (recipe.seedProfileId !== SUPPORTED_SEED_PROFILE) throw new Error(`seed profile ${recipe.seedProfileId} is not supported`);
  const launch = recipe.launch;
  const sourceSnapshot = compiled.runtimeAdmission.sourceSnapshot;
  const contract = readE2EApplicationProjectContract(sourceSnapshot, applicationId);
  if (!contract) throw new Error("docker application host application has no project contract");
  const profileIds = [...new Set(compiled.expectedCases.map((item) => item.accountProfileId))].sort();
  const profiles = profileIds.map((profileId) => {
    const profile = contract.accountProfiles.find((item) => item.profileId === profileId);
    if (!profile || profile.scope !== "synthetic-test" || profile.authProfileId !== SUPPORTED_AUTH_PROFILE) throw new Error(`account profile ${profileId} is not a supported synthetic account`);
    return profile;
  });
  const portEnv = contract.service?.portEnv ?? "APP_PORT";
  // Every approved mock is served as the declared origin whose contract it stands for, and every other declared origin is the sinkhole's. A mock no origin claims cannot be placed: no run.
  const targetIds = new Set(compiled.expectedCases.map((item) => item.targetId));
  const originPlan = planApplicationOrigins({ originBindings: contract.service?.originBindings ?? [], mocks: compiled.group.mocks.filter((mock) => targetIds.has(mock.requestedTargetId)) });
  if (originPlan.unplaced.length > 0) throw new Error("docker application host approved mock has no declared origin of its application");

  const seccompProfile = verifyExecutorSeccompProfile(deps.executorSeccompProfile);
  const { docker } = deps;
  const label = `${ROVARA_RUN_LABEL}=${runId}`;
  const { internal: network, build: buildNetwork, internalBridge, buildBridge } = e2eRunNetworks(runId);
  const appName = `rovara-app-${runId}`;
  const executorName = `rovara-executor-${runId}`;
  const workspace = join(deps.runRoot, runId);
  // The mock fixtures (read-only to the mocks) and the mock ledgers (written by the mocks alone) sit apart from the executor's out directory, which the executor and the app never see.
  const dirs = { app: join(workspace, "app"), owned: join(workspace, "owned"), out: join(workspace, "out"), plan: join(workspace, "plan.json"),
    mock: join(workspace, "mock"), mockOut: join(workspace, "mock-out"), resolv: join(workspace, "resolv.conf") };
  const mockContainers = [{ origin: SINKHOLE_ORIGIN, componentId: null as string | null, fixture: null as (typeof originPlan.mocked)[number]["fixture"] | null },
    ...originPlan.mocked.map((item) => ({ origin: item.originRef, componentId: item.componentId, fixture: item.fixture }))]
    .map((item) => ({ ...item, name: `rovara-mock-${runId}-${item.origin}`, alias: `mock-${item.origin}` }));
  const pollMs = deps.appPollMs ?? 1_000;
  const graceMs = deps.deadlineGraceMs ?? DEFAULT_DEADLINE_GRACE_MS;
  const assemble = deps.assemble ?? assembleExecutorActualRun;
  const deadlineAt = Date.parse(binding.deadlineAt);

  const state = { allocated: false, closed: false, cleanupConfirmed: false, outcome: null as Outcome | null, executing: null as Promise<unknown> | null, startedAt: "", cleanup: null as null | { removedAt: string; containers: string[] },
    appLogTail: "", buildLogTail: "", executorLogTail: "", buildResult: null as DockerBuildResult | null, redactor: createCredentialRedactor([]), createdAt: 0 };
  const redact = (text: string) => tailOf(state.redactor.text(redactText(text)), MAX_TAIL_BYTES);
  const admin = (args: string[], signal: AbortSignal = new AbortController().signal) => docker.run(args, { signal, timeoutMs: ADMIN_TIMEOUT_MS });
  /** A signal that fired at or after the plan deadline is the deadline, not a cancellation. */
  const stopReason = (): DockerApplicationUnavailableReason => (deps.now() >= deadlineAt ? "deadline-exceeded" : "cancelled");
  const appendBuildLog = (text: string) => { state.buildLogTail = redact(`${state.buildLogTail}${text}`); };

  const left = () => Math.max(1, deadlineAt - deps.now());
  const hardening = (extra: string[] = []) => ["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--label", label, "--label", `${ROVARA_CREATED_LABEL}=${state.createdAt}`, ...extra];

  async function removeWorkspace(): Promise<void> {
    try { await rm(workspace, { recursive: true, force: true }); return; } catch { /* files written by the container user may not be removable by this user */ }
    // A throwaway root container with no network and only this directory mounted removes what this user cannot. The executor image
    // is the one image certain to be on the host already.
    await docker.run(["run", "--rm", "--pull=never", "--label", label, "--network", "none", "--user", "0:0", "--entrypoint", "rm", "-v", `${workspace}:/d`, ...BLANKED_ENV,
      deps.executorImage, "-rf", "/d/app", "/d/out", "/d/owned", "/d/mock", "/d/mock-out"],
      { signal: new AbortController().signal, timeoutMs: ADMIN_TIMEOUT_MS }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Removes every container and both networks labeled for this run; true only when none is left. */
  async function removeOwned(): Promise<{ confirmed: boolean; containers: string[] }> {
    const listed = await admin(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]);
    const containers = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (containers.length > 0) await admin(["rm", "-f", ...containers]);
    await admin(["network", "rm", buildNetwork]);
    await admin(["network", "rm", network]);
    await removeWorkspace();
    const containersLeft = await admin(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]);
    const networksLeft = await admin(["network", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]);
    const left = [containersLeft, networksLeft].some((result) => result.code !== 0 || result.stdout.trim() !== "");
    const workspaceGone = await lstat(workspace).then(() => false, () => true);
    return { confirmed: !left && workspaceGone, containers };
  }

  /** The CLI's 124 (timed out) and 130 (stopped) are not exit codes of the command, which never got to finish. */
  const ended = (code: number): number | null => (code === 124 || code === 130 ? null : code);
  /** "deadline" means the plan deadline, not the command, ended the build. */
  async function build(signal: AbortSignal): Promise<"ok" | "failed" | "deadline"> {
    const mounts = ["-v", `${deps.candidateSourceDir}:/src:ro`, "-v", `${dirs.app}:/out`];
    const common = (name: string, on: string) => ["run", "--rm", "--name", name, "--pull=never", ...hardening(["--network", on]), ...limits("2g", "1024", "2"), "--user", "1000:1000", ...mounts];
    const copyTimeout = Math.min(BUILD_COPY_TIMEOUT_MS, left());
    // Copying the source needs no network at all.
    const copy = await docker.run([...common(`rovara-build-${runId}-0`, "none"), ...BLANKED_ENV, "--entrypoint", "cp", deps.buildImage, "-R", "--no-preserve=all", "/src/.", "/out/"],
      { signal, timeoutMs: copyTimeout });
    appendBuildLog(`${copy.stdout}${copy.stderr}`);
    state.buildResult = Object.freeze({ commandIndex: 0, exitCode: ended(copy.code), command: null });
    if (copy.code !== 0) return copy.code === 124 && copyTimeout < BUILD_COPY_TIMEOUT_MS ? "deadline" : "failed";
    let index = 0;
    for (const command of recipe.build) {
      index += 1;
      // The build reaches the internet (package registries) only through its own run bridge, which the host firewall keeps off the host and every
      // private range, and it holds no credential: HOME and the package cache sit in a tmpfs.
      const env = ["-e", "HOME=/tmp/home", "-e", "npm_config_cache=/tmp/home/.npm", "-e", "CI=1", ...Object.entries(command.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]), ...BLANKED_ENV];
      const timeoutMs = Math.min(command.timeoutMs, left());
      const result = await docker.run([...common(`rovara-build-${runId}-${index}`, buildNetwork), "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1g", "-w", containerCwd("/out", command.cwd), ...env,
        deps.buildImage, command.program, ...command.args], { signal, timeoutMs });
      appendBuildLog(`${result.stdout}${result.stderr}`);
      state.buildResult = Object.freeze({ commandIndex: index, exitCode: ended(result.code), command: Object.freeze({ ...command }) });
      if (result.code !== 0) {
        if (result.code === 124) await admin(["rm", "-f", `rovara-build-${runId}-${index}`]);
        const clamped = result.code === 124 && timeoutMs < command.timeoutMs;
        appendBuildLog(`\nbuild command ${index} (${command.program}) ended with ${result.code === 124 ? (clamped ? "the run deadline" : "a timeout") : `exit code ${result.code}`}\n`);
        return clamped ? "deadline" : "failed";
      }
    }
    return "ok";
  }

  /**
   * The images are pulled here, never by `docker run`, so a run can only start what the host already holds. Runs on one host race to pull the same
   * image, and the loser's pull can fail although the image is then there, so every failed pull is followed by a fresh look and, if the image is still
   * missing, up to two more tries. When it never arrives the log carries docker's own words.
   */
  async function ensureImage(image: string, signal: AbortSignal): Promise<boolean> {
    let failure = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if ((await admin(["image", "inspect", image], signal)).code === 0) return true;
      const pulled = await docker.run(["pull", image], { signal, timeoutMs: Math.min(IMAGE_PULL_TIMEOUT_MS, left()) });
      if (pulled.code === 0) return true;
      failure = `${pulled.stderr}${pulled.stdout}`.trim().split("\n").at(-1) ?? "";
      if (signal.aborted || left() <= 1) break;
      if (attempt < 3) await new Promise<void>((done) => setTimeout(done, deps.imagePullRetryMs ?? 2_000));
    }
    if ((await admin(["image", "inspect", image], signal)).code === 0) return true;
    appendBuildLog(`image ${image} is not available on the host${failure === "" ? "" : `: ${failure}`}\n`);
    return false;
  }

  async function appStatus(): Promise<{ running: boolean; exitCode: number | null }> {
    const inspected = await admin(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", appName]);
    if (inspected.code !== 0) return { running: false, exitCode: null };
    const [status, code] = inspected.stdout.trim().split(/\s+/);
    return { running: status === "running" || status === "created", exitCode: code === undefined ? null : Number(code) };
  }

  /**
   * The end of the executor's own log, redacted, or "" when it left none. Only called once the executor has stopped by itself: while its container may still
   * run it could swap the file, so the read is also made on the open handle of a regular file (never a link or FIFO), bounded, and never waits.
   */
  async function readExecutorOwnLog(): Promise<string> {
    try {
      const raw = (await readRegularFileTail(join(dirs.out, "executor.log"), EXECUTOR_OWN_LOG_READ_BYTES)).toString("utf8");
      return tailOf(state.redactor.text(redactText(raw)), EXECUTOR_OWN_LOG_BYTES);
    } catch { return ""; }
  }

  /**
   * Starts the sinkhole and one mock per approved origin from the executor image on the run's internal network alone. Each gets every capability dropped, a read-only root,
   * Docker's default seccomp profile, the `node` user, small limits and no environment but the path of its fixture; the fixture is mounted read-only and the ledger directory is the only
   * writable mount. The sinkhole alone may bind the low ports it answers on (80, 443 and its resolver on 53) through one namespaced sysctl. A container is ready only once its server is
   * listening, which it says by writing `<origin>.ready` last. Returns false when any of them cannot be started or does not become ready.
   */
  async function startMocks(signal: AbortSignal): Promise<boolean> {
    for (const mock of mockContainers) {
      const fixtureArgs = mock.fixture === null ? [] : ["-v", `${join(dirs.mock, mock.origin)}:/mock:ro`, "-e", "ROVARA_MOCK_FIXTURE=/mock/fixture.json"];
      const lowPorts = mock.fixture === null ? ["--sysctl", "net.ipv4.ip_unprivileged_port_start=0"] : [];
      const created = await docker.run(["run", "-d", "--name", mock.name, "--pull=never", ...hardening(["--network", network, "--network-alias", mock.alias]), "--read-only", "--init",
        ...limits("128m", "64", "0.5"), "--user", "node", ...lowPorts, ...fixtureArgs, "-v", `${dirs.mockOut}:/out/mock`, deps.executorImage,
        "node", MOCK_ENTRY_POINT, "--mock", ...(mock.fixture === null ? [] : ["/mock/fixture.json"]), "--origin", mock.origin], { signal, timeoutMs: ADMIN_TIMEOUT_MS });
      if (created.code !== 0) { appendBuildLog(`mock container for ${mock.origin} could not be started: ${created.stderr}${created.stdout}\n`); return false; }
    }
    const readyBy = Math.min(deps.now() + (deps.mockReadyMs ?? MOCK_READY_TIMEOUT_MS), deadlineAt);
    for (const mock of mockContainers) {
      for (;;) {
        if (signal.aborted) return false;
        const opened = await openRegularFile(join(dirs.mockOut, `${mock.origin}.ready`)).then(async ({ handle }) => { await handle.close(); return true; }, () => false);
        if (opened && (await mockRunning(mock.name))) break;
        if (deps.now() >= readyBy) { appendBuildLog(`mock container for ${mock.origin} did not become ready\n`); return false; }
        await new Promise<void>((done) => setTimeout(done, MOCK_READY_POLL_MS));
      }
    }
    return true;
  }
  /** The container's address on the run network, or null when it has none (the host then refuses to trust any ledger line's caller). */
  async function containerAddress(name: string): Promise<string | null> {
    const inspected = await admin(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name]);
    const address = inspected.stdout.trim();
    return inspected.code === 0 && IPV4.test(address) ? address : null;
  }
  async function mockRunning(name: string): Promise<boolean> {
    const inspected = await admin(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name]);
    return inspected.code === 0 && inspected.stdout.trim().startsWith("running");
  }
  /**
   * Called once the executor is done. Every mock and the sinkhole must still be running: one that stopped cannot have recorded every call made to it, and then no ledger is trusted.
   * They are killed before their ledgers are read, so nothing is appended while it is read, and each ledger is read from an open regular file, bounded.
   */
  async function stopMocksAndReadLedgers(appAddress: string): Promise<ParsedMockLedger[] | null> {
    for (const mock of mockContainers) if (!(await mockRunning(mock.name))) return null;
    await admin(["kill", ...mockContainers.map((mock) => mock.name)]);
    const ledgers: ParsedMockLedger[] = [];
    for (const mock of mockContainers) {
      try {
        const { handle, size } = await openRegularFile(join(dirs.mockOut, `${mock.origin}.jsonl`));
        try {
          const length = Math.min(size, MOCK_LEDGER_READ_BYTES);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, 0);
          // What the app asked is its own text, and it has seen the run's passwords: a credential in it is withheld before the line reaches evidence (the call still counts).
          ledgers.push(withholdMockLedgerCredentials(parseMockLedger({ origin: mock.origin, componentId: mock.componentId, fixture: mock.fixture, appAddress, bytes: buffer.subarray(0, bytesRead),
            truncated: size > MOCK_LEDGER_READ_BYTES }), (bytes) => state.redactor.contains(bytes)));
        } finally { await handle.close(); }
      } catch { return null; }
    }
    return ledgers;
  }

  async function execute(signal: AbortSignal): Promise<Outcome> {
    // Environment names that look like credentials are refused outright, whatever the recipe schema let through.
    const envNames = [...recipe.build.flatMap((command) => Object.keys(command.env)), ...Object.keys(launch.start.env)];
    const refused = envNames.find((name) => FORBIDDEN_ENV_NAME.test(name));
    if (refused !== undefined) {
      appendBuildLog(`the recipe sets ${refused}, whose name looks like a credential; recipes may not carry credentials\n`);
      return { kind: "unavailable", reason: "build-failed" };
    }
    for (const image of [deps.buildImage, deps.executorImage]) {
      if (!(await ensureImage(image, signal))) return { kind: "unavailable", reason: signal.aborted ? stopReason() : "executor-failed" };
    }
    // Build, or take the source as it is when the recipe builds nothing; either way the app sees /app read-only.
    if (recipe.build.length > 0) {
      await mkdir(dirs.app, { recursive: true, mode: 0o777 });
      await chmod(dirs.app, 0o777);
      const built = await build(signal);
      if (built !== "ok") return { kind: "unavailable", reason: built === "deadline" ? "deadline-exceeded" : signal.aborted ? stopReason() : "build-failed" };
    } else {
      await cp(deps.candidateSourceDir, dirs.app, { recursive: true, verbatimSymlinks: true });
    }
    // The nested read-only mount needs a mount point that already exists, and it must be a real directory the candidate does not control.
    const ownedMount = join(dirs.app, ".owned");
    const existing = await lstat(ownedMount).catch(() => null);
    if (existing && !existing.isDirectory()) await rm(ownedMount, { force: true });
    await mkdir(ownedMount, { recursive: true });

    if (!(await startMocks(signal))) return { kind: "unavailable", reason: signal.aborted ? stopReason() : "mock-unavailable" };
    // Every name that nothing in the run serves resolves to the sinkhole, so a call to an undeclared host is recorded. The app is not left to Docker's embedded resolver for that: Docker 25 does not
    // forward the queries of a container that is only on internal networks to a `--dns` server, so such a lookup would never reach the sinkhole. The app instead gets a run-owned read-only
    // /etc/resolv.conf that names the sinkhole directly, and the run's own names (every mock alias and the sinkhole's) in its hosts file, which the embedded resolver no longer answers. The app's own alias (`app`) is there too, pointing at itself, so a candidate that calls itself as `http://app:<port>` is not recorded as an unmocked call.
    const addresses: { alias: string; address: string }[] = [];
    for (const mock of mockContainers) {
      const address = await containerAddress(mock.name);
      if (address === null) { appendBuildLog(mock.fixture === null ? "the sinkhole has no address on the run network\n" : `the mock for ${mock.origin} has no address on the run network\n`); return { kind: "unavailable", reason: "mock-unavailable" }; }
      addresses.push({ alias: mock.alias, address });
    }
    const sinkholeAddress = addresses[0]!.address;
    await writeFile(dirs.resolv, `nameserver ${sinkholeAddress}\noptions ndots:0 timeout:2 attempts:2\n`, { mode: 0o644 });
    await chmod(dirs.resolv, 0o644);

    const appCreate = await docker.run(["run", "-d", "--name", appName, "--pull=never", ...hardening(["--network", network, "--network-alias", "app", "--add-host", "app:127.0.0.1", ...addresses.flatMap((item) => ["--add-host", `${item.alias}:${item.address}`])]), "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m", ...limits("1g", "512", "1"), "--user", "1000:1000", "-v", `${dirs.app}:/app:ro`, "-v", `${dirs.owned}:/app/.owned:ro`, "-v", `${dirs.resolv}:/etc/resolv.conf:ro`, "-w", containerCwd("/app", launch.start.cwd),
      // The recipe's literals come first, so the host's own port and seed variables always win.
      ...Object.entries(launch.start.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      // Every declared origin is one of the run's own containers: the approved mock when there is one, the sinkhole otherwise. These come after the recipe's literals, so the recipe cannot point an origin elsewhere.
      ...originPlan.mocked.flatMap((origin) => ["-e", `${origin.envName}=${mockOriginUrl(origin.originRef)}`]),
      ...originPlan.unbound.flatMap((origin) => ["-e", `${origin.envName}=${mockOriginUrl(SINKHOLE_ORIGIN_REF)}`]),
      "-e", `${portEnv}=${APP_PORT}`, "-e", "ORDERS_TEST_SEED_FILE=/app/.owned/seed.json", ...BLANKED_ENV, deps.buildImage, launch.start.program, ...launch.start.args],
    { signal, timeoutMs: ADMIN_TIMEOUT_MS });
    if (appCreate.code !== 0) { state.appLogTail = redact(`${appCreate.stdout}${appCreate.stderr}`); return { kind: "unavailable", reason: signal.aborted ? stopReason() : "app-exited" }; }
    if (!(await appStatus()).running) return { kind: "unavailable", reason: "app-exited" };
    // The only caller whose calls to a mock can be evidence that the application made them.
    const appAddress = await containerAddress(appName);
    if (appAddress === null) {
      // Docker detaches a stopped container from its networks: an app that exited right after it started has no address any more, and that is the app exiting, not a mock failure.
      if (!(await appStatus()).running) {
        const logs = await admin(["logs", "--tail", "400", appName]);
        state.appLogTail = redact(`${logs.stdout}${logs.stderr}`);
        return { kind: "unavailable", reason: "app-exited" };
      }
      appendBuildLog("the app has no address on the run network\n");
      return { kind: "unavailable", reason: "mock-unavailable" };
    }

    const executorStop = new AbortController();
    const executorSignal = AbortSignal.any([signal, executorStop.signal]);
    const remaining = Math.max(1, deadlineAt - deps.now()) + graceMs;
    let appGone = false;
    const watching = new AbortController();
    const executorRun = docker.run(["run", "--name", executorName, "--pull=never", "--label", label, "--label", `${ROVARA_CREATED_LABEL}=${state.createdAt}`, "--network", network,
      // The executor's sandbox and limits are one shared definition (the image smoke test runs with the same). Only the executor leaves Docker's default seccomp
      // profile, and only for the namespace syscalls Chromium's own sandbox needs; no capability is added.
      ...executorContainerArgs(seccompProfile), "-v", `${dirs.plan}:/run/rovara/plan.json:ro`, "-v", `${dirs.out}:/out`, ...BLANKED_ENV,
      deps.executorImage], { signal: executorSignal, timeoutMs: remaining });
    const watch = (async () => {
      while (!watching.signal.aborted && !executorSignal.aborted) {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, pollMs);
          watching.signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
        });
        if (watching.signal.aborted || executorSignal.aborted) return;
        if (!(await appStatus()).running) { appGone = true; executorStop.abort(); await admin(["rm", "-f", executorName]); return; }
      }
    })();
    const executor = await executorRun;
    watching.abort();
    await watch.catch(() => undefined);
    // `docker run` prints nothing of why the executor exited 2: that is in the executor's own log in the out directory. A code other than 0 or 1 is a run
    // without a trustworthy result, so its log tail and the code itself are kept to explain it (a refused or failed `docker run` shows in stderr and the code).
    // 124 and 130 mean the docker CLI was killed (the deadline, the caller) and its container may still be running, so nothing is read from the out directory then.
    const settled = executor.code !== 124 && executor.code !== 130 && !signal.aborted && deps.now() < deadlineAt;
    const ownLog = executor.code === 0 || executor.code === 1 || !settled ? "" : await readExecutorOwnLog();
    state.executorLogTail = redact(`${executor.stdout}${executor.stderr}${ownLog === "" ? "" : `\n--- executor.log (end)\n${ownLog}`}${
      executor.code === 0 || executor.code === 1 ? "" : `\n[docker run exited with code ${executor.code}]`}`);
    const logs = await admin(["logs", "--tail", "400", appName]);
    state.appLogTail = redact(`${logs.stdout}${logs.stderr}`);

    if (signal.aborted) return { kind: "unavailable", reason: stopReason() };
    if (appGone) return { kind: "unavailable", reason: "app-exited" };
    if (executor.code === 124) { await admin(["rm", "-f", executorName]); return { kind: "unavailable", reason: "deadline-exceeded" }; }

    let result: ExecutorResultFile | null = null;
    try { result = await readExecutorResultFile(dirs.out); } catch { /* a crashed executor leaves no result */ }
    if (result !== null && result.exitCode !== executor.code) return { kind: "unavailable", reason: "executor-result-mismatch" };
    if (executor.code === 0 || executor.code === 1) {
      // Exit 0 or 1 is only believed together with a result file that says the same.
      if (result === null) return { kind: "unavailable", reason: "executor-result-mismatch" };
      try { validateExecutorResult(result, binding); } catch { return { kind: "unavailable", reason: "executor-result-mismatch" }; }
      try {
        const mockLedgers = await stopMocksAndReadLedgers(appAddress);
        if (mockLedgers === null) return { kind: "unavailable", reason: signal.aborted ? stopReason() : "mock-unavailable" };
        // The host's own credential predicate (base64 and base64url at any alignment included) keeps a capture that carries a run credential out of the operator's evidence.
        const snapshot = await snapshotExecutorOutput(dirs.out, result, { containsCredential: (bytes) => state.redactor.contains(bytes) });
        // A run that was stopped (the deadline or the caller) while the output was being read has no result, and nothing is handed out.
        if (signal.aborted) return { kind: "unavailable", reason: stopReason() };
        await deps.onRunOutput?.({ outDir: dirs.out, accountProfileIds: profileIds, containsCredential: (bytes) => state.redactor.contains(bytes) });
        // The hook is advisory evidence capture and never implies a result: a run stopped while it ran is still not one.
        if (signal.aborted) return { kind: "unavailable", reason: stopReason() };
        return { kind: "completed", exitCode: executor.code, snapshot: { ...snapshot, mockLedgers: Object.freeze(mockLedgers), actionWindows: await readExecutorActionWindows(dirs.out) } };
      } catch { return { kind: "unavailable", reason: "executor-failed" }; }
    }
    // Exit 2 and every other code mean no trustworthy result: nothing from the out directory is read, whatever the reason.
    if (result?.reason === "app-unhealthy") return { kind: "unavailable", reason: (await appStatus()).running ? "app-unhealthy" : "app-exited" };
    if (result?.reason === "deadline-exceeded") return { kind: "unavailable", reason: "deadline-exceeded" };
    return { kind: "unavailable", reason: "executor-failed" };
  }

  async function allocate(input: E2ERunInput, signal: AbortSignal): Promise<E2ELease> {
    if (state.allocated) throw new Error("docker application host owns one run and was already allocated");
    if (signal.aborted) throw new Error("docker application allocation was cancelled");
    if (input.binding.runId !== runId || input.binding.groupId !== deps.groupId) throw new Error("run input is not the group this docker application host owns");
    if (deps.now() >= deadlineAt) throw new Error("the run deadline elapsed before allocation");
    state.allocated = true;
    state.createdAt = deps.now();
    const run = createRunAccounts(profiles);
    state.redactor = createCredentialRedactor(run.accounts);
    const plan: E2EExecutorPlan = E2EExecutorPlanSchema.parse({ schemaVersion: "e2e-executor-plan/v1", runId, groupId: deps.groupId, admission: validated.admission,
      admissionDigest: validated.admission.admissionDigest, app: { origin: E2E_EXECUTOR_APP_ORIGIN, health: { path: launch.health.path, expectedStatus: launch.health.expectedStatus,
        timeoutMs: Math.min(launch.start.timeoutMs, 120_000) } }, deadlineAt, accounts: run.accounts });
    try {
      await sweepStaleRovaraRuns(docker, STALE_RUN_SWEEP_AGE_MS, { now: deps.now, runRoot: deps.runRoot }).catch(() => 0);
      await mkdir(deps.runRoot, { recursive: true, mode: 0o700 });
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(dirs.owned, { mode: 0o755 }); await mkdir(dirs.out, { mode: 0o755 });
      await mkdir(dirs.mock, { mode: 0o755 }); await mkdir(dirs.mockOut, { mode: 0o755 });
      for (const mock of mockContainers) {
        if (mock.fixture === null) continue;
        await mkdir(join(dirs.mock, mock.origin), { mode: 0o755 });
        await writeFile(join(dirs.mock, mock.origin, "fixture.json"), JSON.stringify(mock.fixture), { mode: 0o644 });
      }
      await writeFile(join(dirs.owned, "seed.json"), JSON.stringify(run.seed), { mode: 0o644 });
      for (const [name, content] of Object.entries(deps.ownedFiles ?? {})) {
        if (!OWNED_FILE_NAME.test(name) || name === "seed.json") throw new Error(`owned file name ${name} is not allowed`);
        await writeFile(join(dirs.owned, name), content, { mode: 0o644 });
      }
      await writeFile(dirs.plan, JSON.stringify(plan), { mode: 0o644 });
      // The executor runs as an unprivileged user that must write its results here.
      await chmod(dirs.out, 0o777); await chmod(dirs.owned, 0o755);
      // The mocks run as an unprivileged user that must create their ledgers here.
      await chmod(dirs.mockOut, 0o777);
      const labels = ["--label", label, "--label", `${ROVARA_CREATED_LABEL}=${state.createdAt}`];
      // Fixed bridge names let the host firewall tell build, app and executor traffic apart; the name of the network stays last.
      const createdBuild = await docker.run(["network", "create", ...labels, "-o", `com.docker.network.bridge.name=${buildBridge}`, buildNetwork], { signal, timeoutMs: ADMIN_TIMEOUT_MS });
      if (createdBuild.code !== 0) throw new Error(`could not create the run build network: ${redact(createdBuild.stderr)}`);
      const created = await docker.run(["network", "create", "--internal", ...labels, "-o", `com.docker.network.bridge.name=${internalBridge}`, network], { signal, timeoutMs: ADMIN_TIMEOUT_MS });
      if (created.code !== 0) throw new Error(`could not create the run network: ${redact(created.stderr)}`);
    } catch (error) {
      await removeOwned().catch(() => undefined);
      throw error;
    }
    return Object.freeze({
      leaseId: `rovara-docker-${runId}`,
      async execute(executeSignal: AbortSignal): Promise<E2ECollection> {
        if (state.closed || state.executing !== null) throw new Error("docker application host runs once and only before it is closed");
        state.startedAt = new Date(deps.now()).toISOString();
        const running = (async (): Promise<Outcome> => {
          try { return await execute(executeSignal); }
          catch { return { kind: "unavailable", reason: executeSignal.aborted ? stopReason() : "executor-failed" }; }
        })();
        state.executing = running;
        let outcome = await running;
        // Whatever finished after the deadline or a cancellation is not a result, however complete it looks.
        if (executeSignal.aborted && outcome.kind === "completed") outcome = { kind: "unavailable", reason: stopReason() };
        state.outcome = outcome;
        const reason = outcome.kind === "unavailable" ? outcome.reason : null;
        return { process: { exitCode: outcome.kind === "completed" ? outcome.exitCode : null, timedOut: reason === "deadline-exceeded", aborted: reason === "cancelled" },
          rawReport: outcome.kind === "completed" ? outcome.snapshot.reportBytes : null,
          observedUpstreamRunId: outcome.kind === "completed" ? outcome.snapshot.result.shards[0]?.upstreamRunId ?? null : null,
          coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: state.startedAt, finishedAt: new Date(deps.now()).toISOString(), cleanup: "confirmed" };
      },
      async close(): Promise<{ confirmed: boolean }> {
        if (state.closed) return { confirmed: state.cleanupConfirmed };
        // An execution still in flight (stopped by the deadline or a cancellation) settles first: it is bounded by its own kills, and
        // nothing may snapshot the out directory or record an outcome while the run's resources are being removed.
        await state.executing?.catch(() => undefined);
        const removed = await removeOwned();
        state.closed = true;
        state.cleanupConfirmed = removed.confirmed;
        state.cleanup = { removedAt: new Date(deps.now()).toISOString(), containers: removed.containers };
        return { confirmed: removed.confirmed };
      },
    });
  }

  /** The completed outcome and cleanup facts of a run whose resources are confirmed gone; every other state is the unavailable reason. */
  function settledRun(signal: AbortSignal, what: string) {
    if (signal.aborted) throw new Error(`${what} was cancelled`);
    if (!state.closed || !state.cleanupConfirmed || state.cleanup === null) throw new Error("owned cleanup is not confirmed");
    const outcome = state.outcome;
    if (outcome === null) throw new Error("the run was never executed");
    if (outcome.kind === "unavailable") throw new Error(outcome.reason);
    // The cleanup receipt names every container of the run's inventory (the app, the executor, the sinkhole and each mock), the very list a broker derives from the run id and the plan.
    const mockOrigins = originPlan.mocked.map((origin) => origin.originRef);
    const inventory = new Set(dockerOwnedResourceInventory(runId, mockOrigins).containers);
    return { snapshot: outcome.snapshot, cleanup: { removedAt: state.cleanup.removedAt, containers: state.cleanup.containers.filter((name) => inventory.has(name)), network, mockOrigins } };
  }

  async function readActualRun(signal: AbortSignal): Promise<E2EActualApplicationRun> {
    const { snapshot, cleanup } = settledRun(signal, "application proof readback");
    return assemble({ snapshot, compiled, binding, cleanup, evidenceDirectory: dirs.out });
  }

  async function readCollectionInputs(signal: AbortSignal): Promise<DockerCollectionInputs> {
    const { snapshot, cleanup } = settledRun(signal, "collection input readback");
    return (deps.assembleCollectionInputs ?? assembleDockerCollectionInputs)({ snapshot, binding, cleanup });
  }

  return Object.freeze({
    allocate, readActualRun, readCollectionInputs,
    readBuildResult: (requestedRunId: string) => (requestedRunId === runId ? state.buildResult : null),
    readDiagnostics: (requestedRunId: string) => requestedRunId === runId
      ? { appLogTail: state.appLogTail, buildLogTail: state.buildLogTail, executorLogTail: state.executorLogTail }
      : { appLogTail: "", buildLogTail: "", executorLogTail: "" },
  });
}

/**
 * Removes the containers and networks of Rovara runs created more than `olderThanMs` ago, and their workspace under `runRoot`.
 * Runs are told apart by their `rovara.run` label and aged by the `rovara.created` label the host sets; a resource without a
 * readable creation time is left alone. Returns how many runs were swept.
 */
export async function sweepStaleRovaraRuns(docker: DockerCli, olderThanMs: number, options: { now?: () => number; runRoot?: string } = {}): Promise<number> {
  const now = (options.now ?? Date.now)();
  const signal = new AbortController().signal;
  const format = `{{.Names}}\t{{.Label "${ROVARA_RUN_LABEL}"}}\t{{.Label "${ROVARA_CREATED_LABEL}"}}`;
  const rows = (stdout: string) => stdout.split("\n").map((line) => line.split("\t")).filter((parts) => parts.length === 3)
    .map(([name, run, created]) => ({ name: name!.trim(), runId: run!.trim(), created: /^\d{1,16}$/.test(created!.trim()) ? Number(created!.trim()) : Number.NaN }))
    .filter((row) => row.name !== "" && SAFE_RUN_ID.test(row.runId) && Number.isFinite(row.created));
  const containers = rows((await docker.run(["ps", "-a", "--filter", `label=${ROVARA_RUN_LABEL}`, "--format", format], { signal, timeoutMs: ADMIN_TIMEOUT_MS })).stdout);
  const networks = rows((await docker.run(["network", "ls", "--filter", `label=${ROVARA_RUN_LABEL}`, "--format", format.replace("{{.Names}}", "{{.Name}}")], { signal, timeoutMs: ADMIN_TIMEOUT_MS })).stdout);
  const stale = (row: { created: number }) => now - row.created > olderThanMs;
  const staleContainers = containers.filter(stale);
  const staleNetworks = networks.filter(stale);
  if (staleContainers.length > 0) await docker.run(["rm", "-f", ...staleContainers.map((row) => row.name)], { signal, timeoutMs: ADMIN_TIMEOUT_MS });
  for (const row of staleNetworks) await docker.run(["network", "rm", row.name], { signal, timeoutMs: ADMIN_TIMEOUT_MS });
  const runIds = new Set([...staleContainers, ...staleNetworks].map((row) => row.runId));
  if (options.runRoot) for (const runId of runIds) await rm(join(options.runRoot, runId), { recursive: true, force: true }).catch(() => undefined);
  return runIds.size;
}
