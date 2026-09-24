import {
  AgentXErrorCodeSchema,
  ProjectDefinitionSchema,
  WorkspaceDeploymentModeSchema,
  agentXError,
  type ProjectDefinition,
  type WorkspaceDeploymentMode,
} from "@agentx/contracts";
import { readJsonResponse, serverError } from "./http.js";

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
    // Asks the control plane to check each connector with its vendor; older control planes ignore it.
    body: JSON.stringify({ definition, runtimeBinding: options.runtimeBinding, preflight: true }),
  });
  const { ok, status, body } = await readJsonResponse(response);
  if (!ok) {
    // The server names what to fix (a tool budget, a presented name, a target conflict); pass it on.
    const { code, message } = serverError(body);
    const parsedCode = AgentXErrorCodeSchema.safeParse(code);
    // An unlabeled body (an HTTP API gateway's own error shape, say) is classified by its status:
    // 5xx is the control plane's own fault, not a problem with what the administrator sent.
    const fallback = status >= 500 ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID";
    throw agentXError(parsedCode.success ? parsedCode.data : fallback, `project registration failed with HTTP ${status}${message ? `: ${message}` : ""}`);
  }
  if (body === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid response");
  return body;
}
