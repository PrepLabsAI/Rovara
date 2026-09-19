import { agentXError, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";

export interface RepositoryCloneCredential {
  username?: string;
  password?: string;
  token?: string;
}

export type RepositoryCredentialProvider = (
  repository: ProjectDefinition["repositories"][number],
) => Promise<RepositoryCloneCredential>;

export function createRepositoryCredentialProvider(input: {
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  fetchImplementation?: typeof fetch;
}): RepositoryCredentialProvider {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const base = input.controlPlaneUrl.replace(/\/$/, "");
  const endpoint = `${base}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/repository-credentials`;
  return async (repository) => {
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentx-repository-grant": input.invocation.payload.repositoryGrant,
      },
      body: JSON.stringify({
        credentialRef: repository.credentialRef,
        repositoryUrl: repository.url,
      }),
    });
    if (!response.ok) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `repository credential exchange failed with HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("credential" in body)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "repository credential response is invalid");
    }
    return parseCredential(body.credential);
  };
}

function parseCredential(value: unknown): RepositoryCloneCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "repository credential is invalid");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["username", "password", "token"].includes(key))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains unsupported fields");
  }
  const result: RepositoryCloneCredential = {};
  for (const key of ["username", "password", "token"] as const) {
    const entry = input[key];
    if (entry !== undefined) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 8_192) {
        throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains an invalid value");
      }
      result[key] = entry;
    }
  }
  return result;
}
