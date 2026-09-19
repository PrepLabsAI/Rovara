import {
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
  type WorkspaceDeploymentMode,
} from "@agentx/contracts";

export interface ConnectedWorkspace {
  id: string;
  projectName: string;
  projectRevision: number;
  deploymentMode: WorkspaceDeploymentMode;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function connectToProject(
  definition: ProjectDefinition,
  accessToken: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ConnectedWorkspace> {
  const url = new URL(`/v1/projects/${encodeURIComponent(definition.name)}/workspace`, definition.controlPlaneUrl);
  url.searchParams.set("revision", String(definition.revision));
  const response = await fetchImplementation(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const value: unknown = await response.json();
  if (!response.ok) throw agentXError("WORKSPACE_NOT_READY", brokerMessage(value, response.status));
  if (!value || typeof value !== "object" || !("workspace" in value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "broker returned an invalid workspace response");
  }
  return parseWorkspace(value.workspace);
}

function parseWorkspace(value: unknown): ConnectedWorkspace {
  if (!value || typeof value !== "object") throw agentXError("RUNTIME_UNAVAILABLE", "invalid workspace");
  const workspace = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "projectName",
    "projectRevision",
    "deploymentMode",
    "status",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(workspace).some((key) => !allowed.has(key))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "broker exposed unsupported workspace routing fields");
  }
  if (
    typeof workspace.id !== "string" ||
    typeof workspace.projectName !== "string" ||
    typeof workspace.projectRevision !== "number" ||
    typeof workspace.deploymentMode !== "string" ||
    typeof workspace.status !== "string" ||
    typeof workspace.createdAt !== "string" ||
    typeof workspace.updatedAt !== "string"
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "broker returned an invalid workspace record");
  }
  return {
    id: workspace.id,
    projectName: workspace.projectName,
    projectRevision: workspace.projectRevision,
    deploymentMode: WorkspaceDeploymentModeSchema.parse(workspace.deploymentMode),
    status: workspace.status,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function brokerMessage(value: unknown, status: number): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return `workspace lookup failed with HTTP ${status}`;
}
