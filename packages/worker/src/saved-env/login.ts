// SH25 (review M1): the worker's request for the saved environment pull login. The prepare invocation carries no credential (an invocation is stored); the worker presents the preparation's own grant right before the
// pull and the broker decides whether the preparation is still running and which image it may pull (test-env/saved-env-login.ts). Nothing but a fixed sentence leaves this file on a failure, and the login is returned
// to the caller only: it is never logged or written here.
import { SAVED_ENV_FALLBACK_PATH, SAVED_ENV_LOGIN_PATH, SavedEnvRegistryAuthSchema, agentXError, type SavedEnvRegistryAuth, type SavedEnvUseStep, type WorkerInvocation } from "@agentx/contracts";

export type SavedEnvLoginProvider = () => Promise<SavedEnvRegistryAuth>;

export function createSavedEnvLoginProvider(input: {
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  fetchImplementation?: typeof fetch;
}): SavedEnvLoginProvider {
  const send = input.fetchImplementation ?? fetch;
  const endpoint = `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/${SAVED_ENV_LOGIN_PATH}`;
  return async () => {
    const unavailable = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not get a login for the saved environment"); };
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentx-repository-grant": input.invocation.payload.repositoryGrant },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      });
    } catch { return unavailable(); }
    if (!response.ok) return unavailable();
    let body: unknown;
    try { body = await response.json(); } catch { return unavailable(); }
    const parsed = SavedEnvRegistryAuthSchema.safeParse(typeof body === "object" && body !== null && "login" in body ? body.login : undefined);
    return parsed.success ? parsed.data : unavailable();
  };
}

/**
 * The report of a fallback to a fresh setup (the image failed at `step`): the broker marks the image stale and queues a rebuild. It names the step only (the broker knows which image the preparation was told to pull),
 * is sent with the preparation's own grant, never holds the preparation up (it is not waited for beyond a short timeout) and never throws: a report that does not arrive means the next task falls back again.
 */
export function createSavedEnvFallbackReporter(input: {
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  fetchImplementation?: typeof fetch;
}): (step: SavedEnvUseStep) => Promise<void> {
  const send = input.fetchImplementation ?? fetch;
  const endpoint = `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/${SAVED_ENV_FALLBACK_PATH}`;
  return async (step) => {
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentx-repository-grant": input.invocation.payload.repositoryGrant },
        body: JSON.stringify({ step }),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
    } catch { /* the next task falls back again */ }
  };
}
