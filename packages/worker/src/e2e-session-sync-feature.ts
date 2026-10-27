import { E2E_EXECUTOR_SESSION_SYNC_IMAGE_LABEL, E2E_EXECUTOR_SESSION_SYNC_IMAGE_LABEL_VALUE } from "@agentx/contracts";
import { createProcessDockerCli, type DockerCli } from "@agentx/verifier";

const INSPECT_TIMEOUT_MS = 10_000;

/**
 * Whether the executor image on this host syncs the browser's session values before every model call (MIDSTEPCOOKIE): the image carries the label the build stamps on a client that does.
 * The worker lists `task.workflowE2EMidStepSync.v1` only while this is true, so the control plane never hands an AI navigation round to a worker whose executor would call the model
 * without the sync (the proxy would refuse every call; this refuses the round before compute is spent). It never throws: an image that cannot be inspected does not have the label.
 */
export async function executorImageSyncsSession(image: string, docker: DockerCli = createProcessDockerCli()): Promise<boolean> {
  try {
    const format = `{{index .Config.Labels "${E2E_EXECUTOR_SESSION_SYNC_IMAGE_LABEL}"}}`;
    const inspected = await docker.run(["image", "inspect", "--format", format, image], { signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS), timeoutMs: INSPECT_TIMEOUT_MS });
    return inspected.code === 0 && inspected.stdout.trim() === E2E_EXECUTOR_SESSION_SYNC_IMAGE_LABEL_VALUE;
  } catch {
    return false;
  }
}
