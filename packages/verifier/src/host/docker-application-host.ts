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
import { assembleDockerCollectionInputs, assembleExecutorActualRun, readExecutorResultFile, snapshotExecutorOutput, validateExecutorResult,
  type DockerCollectionInputs, type ExecutorOutputSnapshot, type ExecutorResultFile } from "./executor-readback.js";

export { dockerOwnedResourceInventory, dockerOwnedResourceInventoryDigest } from "./executor-readback.js";
export type { DockerCollectionInputs } from "./executor-readback.js";

/**
 * The one way the host talks to Docker. `code` is the process exit code, 124 when `timeoutMs` elapsed first and 130 when
 * `signal` aborted first; in both cases the invoked docker CLI is killed, which does not stop a container it started.
 */
export type DockerCli = { run(args: string[], opts: { signal: AbortSignal; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> };

const OUTPUT_CAP_BYTES = 1024 * 1024;
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
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type DockerApplicationUnavailableReason = "build-failed" | "app-unhealthy" | "app-exited" | "deadline-exceeded" | "executor-failed"
  | "executor-result-mismatch" | "cancelled";

export type DockerApplicationHostDeps = Readonly<{
  docker: DockerCli;
  /** The executor image (Task 1.3): plan mounted read-only, an empty writable out directory. */
  executorImage: string;
  /** The pinned Node base image that builds the candidate and runs it. */
  buildImage: string;
  /** A directory on the Docker host at the same path inside the worker container; each run gets `<runRoot>/<runId>`. */
  runRoot: string;
  now(): number;
  /** The admission the round was started from, and the one runnable application group this host owns. */
  admission: E2EApplicationExecutionAdmission;
  groupId: string;
  /** An already-extracted tree of the exact candidate commit (`git archive`); never written to. */
  candidateSourceDir: string;
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
 * Builds the exact candidate in a build container, runs it on a per-run `--internal` network, runs the Rovara executor
 * against it, and removes everything the run created. One host owns one run (the group named in `deps`); concurrent rounds
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

  const { docker } = deps;
  const label = `${ROVARA_RUN_LABEL}=${runId}`;
  const network = `rovara-e2e-${runId}`;
  const appName = `rovara-app-${runId}`;
  const executorName = `rovara-executor-${runId}`;
  const workspace = join(deps.runRoot, runId);
  const dirs = { app: join(workspace, "app"), owned: join(workspace, "owned"), out: join(workspace, "out"), plan: join(workspace, "plan.json") };
  const pollMs = deps.appPollMs ?? 1_000;
  const graceMs = deps.deadlineGraceMs ?? 15_000;
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
      deps.executorImage, "-rf", "/d/app", "/d/out", "/d/owned"],
      { signal: new AbortController().signal, timeoutMs: ADMIN_TIMEOUT_MS }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Removes every container and the network labeled for this run; true only when none is left. */
  async function removeOwned(): Promise<{ confirmed: boolean; containers: string[] }> {
    const listed = await admin(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]);
    const containers = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (containers.length > 0) await admin(["rm", "-f", ...containers]);
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
    const common = (name: string) => ["run", "--rm", "--name", name, "--pull=never", ...hardening(), ...limits("2g", "1024", "2"), "--user", "1000:1000", ...mounts];
    const copyTimeout = Math.min(BUILD_COPY_TIMEOUT_MS, left());
    const copy = await docker.run([...common(`rovara-build-${runId}-0`), ...BLANKED_ENV, "--entrypoint", "cp", deps.buildImage, "-R", "--no-preserve=all", "/src/.", "/out/"],
      { signal, timeoutMs: copyTimeout });
    appendBuildLog(`${copy.stdout}${copy.stderr}`);
    state.buildResult = Object.freeze({ commandIndex: 0, exitCode: ended(copy.code), command: null });
    if (copy.code !== 0) return copy.code === 124 && copyTimeout < BUILD_COPY_TIMEOUT_MS ? "deadline" : "failed";
    let index = 0;
    for (const command of recipe.build) {
      index += 1;
      // The build runs with registry egress only through the default bridge and holds no credential: HOME and the package cache sit in a tmpfs.
      const env = ["-e", "HOME=/tmp/home", "-e", "npm_config_cache=/tmp/home/.npm", "-e", "CI=1", ...Object.entries(command.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]), ...BLANKED_ENV];
      const timeoutMs = Math.min(command.timeoutMs, left());
      const result = await docker.run([...common(`rovara-build-${runId}-${index}`), "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1g", "-w", containerCwd("/out", command.cwd), ...env,
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

  /** The images are pulled here, never by `docker run`, so a run can only start what the host already holds. */
  async function ensureImage(image: string, signal: AbortSignal): Promise<boolean> {
    if ((await admin(["image", "inspect", image], signal)).code === 0) return true;
    return (await docker.run(["pull", image], { signal, timeoutMs: Math.min(IMAGE_PULL_TIMEOUT_MS, left()) })).code === 0;
  }

  async function appStatus(): Promise<{ running: boolean; exitCode: number | null }> {
    const inspected = await admin(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", appName]);
    if (inspected.code !== 0) return { running: false, exitCode: null };
    const [status, code] = inspected.stdout.trim().split(/\s+/);
    return { running: status === "running" || status === "created", exitCode: code === undefined ? null : Number(code) };
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
      if (!(await ensureImage(image, signal))) { appendBuildLog(`image ${image} is not available on the host\n`); return { kind: "unavailable", reason: signal.aborted ? stopReason() : "executor-failed" }; }
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

    const appCreate = await docker.run(["run", "-d", "--name", appName, "--pull=never", ...hardening(["--network", network, "--network-alias", "app"]), "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m", ...limits("1g", "512", "1"), "--user", "1000:1000", "-v", `${dirs.app}:/app:ro`, "-v", `${dirs.owned}:/app/.owned:ro`, "-w", containerCwd("/app", launch.start.cwd),
      // The recipe's literals come first, so the host's own port and seed variables always win.
      ...Object.entries(launch.start.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "-e", `${portEnv}=${APP_PORT}`, "-e", "ORDERS_TEST_SEED_FILE=/app/.owned/seed.json", ...BLANKED_ENV, deps.buildImage, launch.start.program, ...launch.start.args],
    { signal, timeoutMs: ADMIN_TIMEOUT_MS });
    if (appCreate.code !== 0) { state.appLogTail = redact(`${appCreate.stdout}${appCreate.stderr}`); return { kind: "unavailable", reason: signal.aborted ? stopReason() : "app-exited" }; }
    if (!(await appStatus()).running) return { kind: "unavailable", reason: "app-exited" };

    const executorStop = new AbortController();
    const executorSignal = AbortSignal.any([signal, executorStop.signal]);
    const remaining = Math.max(1, deadlineAt - deps.now()) + graceMs;
    let appGone = false;
    const watching = new AbortController();
    const executorRun = docker.run(["run", "--name", executorName, "--pull=never", ...hardening(["--network", network]), "--init", "--read-only", "--shm-size", "1g",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m", ...limits("2g", "1024", "2"), "-v", `${dirs.plan}:/run/rovara/plan.json:ro`, "-v", `${dirs.out}:/out`, ...BLANKED_ENV,
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
    state.executorLogTail = redact(`${executor.stdout}${executor.stderr}`);
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
        const snapshot = await snapshotExecutorOutput(dirs.out, result);
        // A run that was stopped (the deadline or the caller) while the output was being read has no result, and nothing is handed out.
        if (signal.aborted) return { kind: "unavailable", reason: stopReason() };
        await deps.onRunOutput?.({ outDir: dirs.out, accountProfileIds: profileIds, containsCredential: (bytes) => state.redactor.contains(bytes) });
        // The hook is advisory evidence capture and never implies a result: a run stopped while it ran is still not one.
        if (signal.aborted) return { kind: "unavailable", reason: stopReason() };
        return { kind: "completed", exitCode: executor.code, snapshot };
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
      await sweepStaleRovaraRuns(docker, 3_600_000, { now: deps.now, runRoot: deps.runRoot }).catch(() => 0);
      await mkdir(deps.runRoot, { recursive: true, mode: 0o700 });
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(dirs.owned, { mode: 0o755 }); await mkdir(dirs.out, { mode: 0o755 });
      await writeFile(join(dirs.owned, "seed.json"), JSON.stringify(run.seed), { mode: 0o644 });
      for (const [name, content] of Object.entries(deps.ownedFiles ?? {})) {
        if (!OWNED_FILE_NAME.test(name) || name === "seed.json") throw new Error(`owned file name ${name} is not allowed`);
        await writeFile(join(dirs.owned, name), content, { mode: 0o644 });
      }
      await writeFile(dirs.plan, JSON.stringify(plan), { mode: 0o644 });
      // The executor runs as an unprivileged user that must write its results here.
      await chmod(dirs.out, 0o777); await chmod(dirs.owned, 0o755);
      const created = await docker.run(["network", "create", "--internal", "--label", label, "--label", `${ROVARA_CREATED_LABEL}=${state.createdAt}`, network], { signal, timeoutMs: ADMIN_TIMEOUT_MS });
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
    return { snapshot: outcome.snapshot, cleanup: { removedAt: state.cleanup.removedAt, containers: state.cleanup.containers, network } };
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
