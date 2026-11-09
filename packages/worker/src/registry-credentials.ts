// N9 (INTG2): the worker's request for a project registry's token. It names the registry and presents the preparation's own grant; the broker decides which host, which
// duration and whether the preparation is still running (project-registries/exchange.ts). Nothing but a fixed sentence leaves this file on a failure: the broker's answer
// (which may name a path or a credential reference) is not carried, and a token is never in an error.
import { RegistryCredentialSchema, agentXError, type RegistryCredential, type WorkerInvocation } from "@agentx/contracts";

export type RegistryCredentialProvider = (registry: string) => Promise<RegistryCredential>;

export function createRegistryCredentialProvider(input: {
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  fetchImplementation?: typeof fetch;
}): RegistryCredentialProvider {
  const send = input.fetchImplementation ?? fetch;
  const endpoint = `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/registry-credentials`;
  return async (registry) => {
    const unavailable = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", `Rovara could not get a token for the package registry "${registry}"`); };
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentx-repository-grant": input.invocation.payload.repositoryGrant },
        body: JSON.stringify({ registry }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { return unavailable(); }
    if (!response.ok) return unavailable();
    let body: unknown;
    try { body = await response.json(); } catch { return unavailable(); }
    const parsed = RegistryCredentialSchema.safeParse(typeof body === "object" && body !== null && "credential" in body ? body.credential : undefined);
    return parsed.success ? parsed.data : unavailable();
  };
}
