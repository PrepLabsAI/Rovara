import { join } from "node:path";
import { E2E_AGENT_STEPS_FEATURE } from "@agentx/contracts";
import { assertE2EEnvironmentCannotRedirect, assertE2ESharedAwsConfigCannotRedirect, deriveE2EAgentRoute, e2eAgentInstallationFromEnvironment } from "@agentx/model-runtime";
import { WEB_API_BUILD_IMAGE, containedRuntimeProfileForHost, createDockerApplicationHost, createProcessDockerCli, type DockerApplicationHostDeps, type DockerCli } from "@agentx/verifier";
import type { WorkflowE2EApplicationRuntime } from "./workflow-e2e-application-checks.js";

/** What the worker's own configuration gives the Docker application host; nothing here comes from an invocation. */
export type WorkflowE2EApplicationRuntimeConfig = Readonly<{ executorImage: string; buildImage: string; runRoot: string }>;

/**
 * Reads the configuration, failing closed when any of it is missing: the executor image is the worker's `EXECUTOR_IMAGE` (the image its boot script pulled), the build
 * image is the pinned Node base, and the run root is a directory the worker shares with the Docker host at the same path.
 */
export function workflowE2EApplicationRuntimeConfig(environment: NodeJS.ProcessEnv, platform: string = process.platform, arch: string = process.arch): WorkflowE2EApplicationRuntimeConfig {
  const executorImage = environment.EXECUTOR_IMAGE?.trim() ?? "";
  if (executorImage === "" || executorImage.length > 512 || /\s/.test(executorImage) || [...executorImage].some((character) => character.charCodeAt(0) < 0x20) || executorImage.startsWith("-")) {
    throw new Error("EXECUTOR_IMAGE is not set to an image reference on this worker, so application E2E checks cannot run here");
  }
  const scratch = containedRuntimeProfileForHost(platform, arch)?.candidateScratchRoot;
  if (scratch === undefined) throw new Error("this host has no shared runtime directory for application E2E runs, so application checks cannot run here");
  return { executorImage, buildImage: WEB_API_BUILD_IMAGE, runRoot: join(scratch, "web-api-runs") };
}

/**
 * The host's dependencies: the worker's configuration, plus exactly the things a group supplies (its admission, its id, its staged source, and the model channel of a group that has an agent step). The keys are picked one by one, so nothing a caller
 * adds (another image, run root, Docker, seccomp profile or hook) can reach the host.
 */
export function workflowE2EApplicationHostDeps(config: WorkflowE2EApplicationRuntimeConfig, docker: DockerCli, now: () => number,
  input: Parameters<WorkflowE2EApplicationRuntime["createHost"]>[0]): DockerApplicationHostDeps {
  return { docker, executorImage: config.executorImage, buildImage: config.buildImage, runRoot: config.runRoot, now,
    admission: input.admission, groupId: input.groupId, candidateSourceDir: input.candidateSourceDir,
    ...(input.modelChannel === undefined ? {} : { modelChannel: input.modelChannel }) };
}

/** The production Docker application runtime: one Docker application host per group, on the real Docker CLI. */
export function createWorkflowE2EApplicationRuntime(environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: string; arch?: string; docker?: DockerCli; now?: () => number } = {}): WorkflowE2EApplicationRuntime {
  const config = workflowE2EApplicationRuntimeConfig(environment, options.platform, options.arch);
  const docker = options.docker ?? createProcessDockerCli();
  const now = options.now ?? (() => Date.now());
  return Object.freeze({ runRoot: config.runRoot,
    createHost: (input) => createDockerApplicationHost(workflowE2EApplicationHostDeps(config, docker, now, input)) });
}

export type WorkflowE2EApplicationChecksAvailability = Readonly<{ status: "ready" } | { status: "unavailable"; reason: "executor-image-not-configured" | "no-shared-runtime-directory" | "executor-image-not-on-host" | "not-yet-checked" }>;

const IMAGE_INSPECT_TIMEOUT_MS = 10_000;

/**
 * Whether this worker can run an application round now: EXECUTOR_IMAGE names an image, the host has a shared runtime directory and the host already holds the
 * image (the boot pulled it). The worker lists task.workflowE2EApplicationChecks on /ping only while this is ready, so the dispatcher refuses an application
 * round for a worker that could not run it with the clear reason, instead of the round failing on the worker. It never throws: a Docker that cannot answer is unavailable.
 * It can take seconds, so /ping never calls it: createApplicationChecksFeatureMonitor runs it in the background.
 */
export async function workflowE2EApplicationChecksAvailability(environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: string; arch?: string; docker?: DockerCli } = {}): Promise<WorkflowE2EApplicationChecksAvailability> {
  let config: WorkflowE2EApplicationRuntimeConfig;
  try { config = workflowE2EApplicationRuntimeConfig(environment, options.platform, options.arch); } catch (error) {
    return { status: "unavailable", reason: /shared runtime directory/.test(error instanceof Error ? error.message : "") ? "no-shared-runtime-directory" : "executor-image-not-configured" };
  }
  try {
    const inspected = await (options.docker ?? createProcessDockerCli()).run(["image", "inspect", config.executorImage],
      { signal: AbortSignal.timeout(IMAGE_INSPECT_TIMEOUT_MS), timeoutMs: IMAGE_INSPECT_TIMEOUT_MS });
    return inspected.code === 0 ? { status: "ready" } : { status: "unavailable", reason: "executor-image-not-on-host" };
  } catch {
    return { status: "unavailable", reason: "executor-image-not-on-host" };
  }
}

/**
 * Whether the executor can drive an `agent` step. Task 4.3a built the model channel (the worker's half and the executor's client) but no driver loads the client, so the feature
 * stays withheld with the reason `agent-driver-not-installed`; Task 4.3b installs the driver and removes this reason.
 */
export const AGENT_DRIVER_INSTALLED = false as boolean;

/** Why `task.workflowE2EAgentSteps.v1` is not on /ping now, in the order it is judged. Each reason is a fixed code; the detail, where there is one, names a variable or a file and never a value. */
export type AgentStepsAvailability = Readonly<
  | { status: "available" }
  | { status: "unavailable"; reason: "agent-checks-unavailable"; detail: string }
  | { status: "unavailable"; reason: "model-environment-unsafe"; detail: string }
  | { status: "unavailable"; reason: "agent-route-not-derivable"; detail: string }
  | { status: "unavailable"; reason: "agent-driver-not-installed" }>;

/**
 * The agent step feature is listed only when every one of these holds: application CHECKS run here, nothing in the process environment or the shared AWS files can redirect
 * or re-authenticate a model call, the worker's own settings make a route, and the executor has a driver for the step. The first that fails is the reason.
 */
export function agentStepsAvailability(input: { checks: WorkflowE2EApplicationChecksAvailability; environment: NodeJS.ProcessEnv; sharedConfigCheck?: () => void; driverInstalled?: boolean }): AgentStepsAvailability {
  if (input.checks.status !== "ready") return { status: "unavailable", reason: "agent-checks-unavailable", detail: input.checks.reason };
  try {
    assertE2EEnvironmentCannotRedirect(input.environment);
    (input.sharedConfigCheck ?? (() => assertE2ESharedAwsConfigCannotRedirect()))();
  } catch (error) {
    return { status: "unavailable", reason: "model-environment-unsafe", detail: (error instanceof Error ? error.message : "the environment can redirect model calls").slice(0, 400) };
  }
  const derived = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(input.environment));
  if (derived.status === "unavailable") return { status: "unavailable", reason: "agent-route-not-derivable", detail: derived.detail };
  return (input.driverInstalled ?? AGENT_DRIVER_INSTALLED) ? { status: "available" } : { status: "unavailable", reason: "agent-driver-not-installed" };
}

const APPLICATION_CHECKS_FEATURE = "task.workflowE2EApplicationChecks" as const;
/** M1.3 Task 3.7b: running the baseline round needs exactly what an application round needs (the executor image on the host), so the two are listed, and withheld, together. */
const BASELINE_CHECKS_FEATURE = "task.workflowE2EBaselineChecks" as const;
/** A check that has not answered by then is an unavailable answer, so one hung Docker cannot stop the refresh for good. */
const AVAILABILITY_CHECK_LIMIT_MS = IMAGE_INSPECT_TIMEOUT_MS + 5_000;
export const APPLICATION_CHECKS_REFRESH_MS = 30_000;

/**
 * Keeps the last known availability of application CHECKS, checked at boot and again on an interval, and gives the worker server what it needs to list the feature on
 * /ping from that value alone. It starts as unavailable ("not-yet-checked") until the first check answers, so a worker never advertises what it has not proved.
 */
export function createApplicationChecksFeatureMonitor(input: { environment?: NodeJS.ProcessEnv; platform?: string; arch?: string; docker?: DockerCli; intervalMs?: number;
  /** Test seams for the agent step feature (Task 4.3a): the shared AWS files check, and whether the executor has a driver. */
  sharedConfigCheck?: () => void; driverInstalled?: boolean }) {
  let latest: WorkflowE2EApplicationChecksAvailability = { status: "unavailable", reason: "not-yet-checked" };
  const judgeAgentSteps = (checks: WorkflowE2EApplicationChecksAvailability): AgentStepsAvailability => {
    // A judgement that fails is never "available".
    try {
      return agentStepsAvailability({ checks, environment: input.environment ?? process.env,
        ...(input.sharedConfigCheck === undefined ? {} : { sharedConfigCheck: input.sharedConfigCheck }), ...(input.driverInstalled === undefined ? {} : { driverInstalled: input.driverInstalled }) });
    } catch { return { status: "unavailable", reason: "agent-checks-unavailable", detail: "availability-check-failed" }; }
  };
  // Judged with the check, never per ping: it reads two small files, and /ping is asked often. Until the first check answers, the checks are not known to run here.
  let agentSteps: AgentStepsAvailability = judgeAgentSteps(latest);
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let limit: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        workflowE2EApplicationChecksAvailability(input.environment ?? process.env, { ...(input.platform === undefined ? {} : { platform: input.platform }),
          ...(input.arch === undefined ? {} : { arch: input.arch }), ...(input.docker === undefined ? {} : { docker: input.docker }) }),
        new Promise<WorkflowE2EApplicationChecksAvailability>((resolve) => { limit = setTimeout(() => resolve({ status: "unavailable", reason: "executor-image-not-on-host" }), AVAILABILITY_CHECK_LIMIT_MS); }),
      ]).finally(() => clearTimeout(limit));
      latest = answer;
    } catch {
      latest = { status: "unavailable", reason: "executor-image-not-on-host" };
    } finally { running = false; }
    agentSteps = judgeAgentSteps(latest);
  };
  return {
    current: (): WorkflowE2EApplicationChecksAvailability => latest,
    /** Starts the first check now (not awaited) and the refresh; the timer does not keep the process alive. */
    start(): void {
      if (timer !== undefined) return;
      void check();
      timer = setInterval(() => { void check(); }, input.intervalMs ?? APPLICATION_CHECKS_REFRESH_MS);
      timer.unref?.();
    },
    stop(): void { if (timer !== undefined) { clearInterval(timer); timer = undefined; } },
    /** The parts of a WorkerExecutor that keep the feature off /ping while it is unavailable. */
    /** Why the agent step feature is on or off /ping now (Task 4.3a). */
    agentSteps: (): AgentStepsAvailability => agentSteps,
    executor: {
      withholdableInvocationFeatures: [APPLICATION_CHECKS_FEATURE, BASELINE_CHECKS_FEATURE, E2E_AGENT_STEPS_FEATURE] as const,
      withheldInvocationFeatures: () => ({
        ...(latest.status === "ready" ? {} : { [APPLICATION_CHECKS_FEATURE]: latest, [BASELINE_CHECKS_FEATURE]: latest }),
        ...(agentSteps.status === "available" ? {} : { [E2E_AGENT_STEPS_FEATURE]: agentSteps }),
      }),
    },
  };
}
