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
  type WorkspaceDeploymentMode,
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

/** The runtime binding the `admin project register` flags describe; each mode takes only its own flags. */
export function cliRuntimeBinding(
  deploymentMode: WorkspaceDeploymentMode,
  options: {
    runtimeArn?: string;
    endpointQualifier: string;
    capacityProviderArn?: string;
    launchTemplateId?: string;
    subnets?: string;
    volumeSizeGib: string;
    volumeType: string;
  },
): ProjectRuntimeBinding {
  switch (deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      if (options.runtimeArn === undefined) throw agentXError("CONFIG_INVALID", `${deploymentMode} registration requires --runtime-arn`);
      if (options.launchTemplateId !== undefined || options.subnets !== undefined) {
        throw agentXError("CONFIG_INVALID", "--launch-template-id and --subnets apply to ec2-ebs only");
      }
      return {
        runtimeArn: options.runtimeArn,
        endpointQualifier: options.endpointQualifier,
        deploymentMode,
        ...(options.capacityProviderArn === undefined ? {} : { capacityProviderArn: options.capacityProviderArn }),
      };
    case "ec2-ebs": {
      if (options.runtimeArn !== undefined || options.capacityProviderArn !== undefined) {
        throw agentXError("CONFIG_INVALID", "--runtime-arn and --capacity-provider-arn apply to AgentCore modes only");
      }
      if (options.launchTemplateId === undefined || options.subnets === undefined) {
        throw agentXError("CONFIG_INVALID", "ec2-ebs registration requires --launch-template-id and --subnets");
      }
      const subnets = options.subnets.split(",").map((pair) => {
        const [availabilityZone, subnetId, extra] = pair.trim().split("=");
        if (!availabilityZone || !subnetId || extra !== undefined) throw agentXError("CONFIG_INVALID", `--subnets entry ${JSON.stringify(pair)} is not availabilityZone=subnetId`);
        return { availabilityZone, subnetId };
      });
      const parsed = Ec2RuntimeBindingSchema.safeParse({
        deploymentMode,
        launchTemplateId: options.launchTemplateId,
        subnets,
        volumeSizeGiB: Number(options.volumeSizeGib),
        volumeType: options.volumeType,
      });
      if (!parsed.success) {
        throw agentXError("CONFIG_INVALID", `ec2-ebs binding is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
      }
      return parsed.data;
    }
    default:
      return unhandledDeploymentMode(deploymentMode);
  }
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
