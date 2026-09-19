import {
  ProjectDefinitionSchema,
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
  type WorkspaceDeploymentMode,
} from "@agentx/contracts";

export interface ProjectRuntimeBinding {
  runtimeArn: string;
  endpointQualifier: string;
  deploymentMode: WorkspaceDeploymentMode;
  capacityProviderArn?: string;
}

export async function registerProject(
  options: {
    controlPlaneUrl: string;
    accessToken: string;
    definition: ProjectDefinition;
    runtimeBinding: ProjectRuntimeBinding;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const definition = ProjectDefinitionSchema.parse(options.definition);
  const deploymentMode = WorkspaceDeploymentModeSchema.parse(options.runtimeBinding.deploymentMode);
  if (deploymentMode === "instances-ebs" && options.runtimeBinding.capacityProviderArn === undefined) {
    throw agentXError("CONFIG_INVALID", "instances-ebs registration requires --capacity-provider-arn");
  }
  if (deploymentMode === "demo-microvm" && options.runtimeBinding.capacityProviderArn !== undefined) {
    throw agentXError("CONFIG_INVALID", "demo-microvm registration does not accept a capacity provider ARN");
  }
  const response = await fetchImplementation(`${options.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ definition, runtimeBinding: options.runtimeBinding }),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw agentXError("CONFIG_INVALID", `project registration failed with HTTP ${response.status}`);
  return result;
}
