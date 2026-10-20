import { join } from "node:path";
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
 * The host's dependencies: the worker's configuration, plus exactly the three things a group supplies. The keys are picked one by one, so nothing a caller
 * adds (another image, run root, Docker, seccomp profile or hook) can reach the host.
 */
export function workflowE2EApplicationHostDeps(config: WorkflowE2EApplicationRuntimeConfig, docker: DockerCli, now: () => number,
  input: Parameters<WorkflowE2EApplicationRuntime["createHost"]>[0]): DockerApplicationHostDeps {
  return { docker, executorImage: config.executorImage, buildImage: config.buildImage, runRoot: config.runRoot, now,
    admission: input.admission, groupId: input.groupId, candidateSourceDir: input.candidateSourceDir };
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

export type WorkflowE2EApplicationChecksAvailability = Readonly<{ status: "ready" } | { status: "unavailable"; reason: "executor-image-not-configured" | "no-shared-runtime-directory" | "executor-image-not-on-host" }>;

const IMAGE_INSPECT_TIMEOUT_MS = 10_000;

/**
 * Whether this worker can run an application round now: EXECUTOR_IMAGE names an image, the host has a shared runtime directory and the host already holds the
 * image (the boot pulled it). The worker lists task.workflowE2EApplicationChecks on /ping only while this is ready, so the dispatcher refuses an application
 * round for a worker that could not run it with the clear reason, instead of the round failing on the worker. It never throws: a Docker that cannot answer is unavailable.
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
