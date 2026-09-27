import {
  AgentXErrorCodeSchema,
  Ec2RuntimeBindingSchema,
  ProjectDefinitionSchema,
  WorkspaceDeploymentModeSchema,
  agentXError,
  unhandledDeploymentMode,
  type AgentCoreDeploymentMode,
  type Ec2RuntimeBinding,
  type ProjectDefinition,
} from "@agentx/contracts";
import { readJsonResponse, serverError } from "./http.js";

export type ProjectRuntimeBinding =
  | {
      runtimeArn: string;
      endpointQualifier: string;
      deploymentMode: AgentCoreDeploymentMode;
      capacityProviderArn?: string;
    }
  | Ec2RuntimeBinding;

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
  WorkspaceDeploymentModeSchema.parse(options.runtimeBinding.deploymentMode);
  const binding = options.runtimeBinding;
  switch (binding.deploymentMode) {
    case "instances-ebs":
      if (binding.capacityProviderArn === undefined) {
        throw agentXError("CONFIG_INVALID", "instances-ebs registration requires --capacity-provider-arn");
      }
      break;
    case "demo-microvm":
      if (binding.capacityProviderArn !== undefined) {
        throw agentXError("CONFIG_INVALID", "demo-microvm registration does not accept a capacity provider ARN");
      }
      break;
    case "ec2-ebs":
      Ec2RuntimeBindingSchema.parse(binding);
      break;
    default:
      unhandledDeploymentMode(binding);
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
