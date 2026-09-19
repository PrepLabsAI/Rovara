import {
  CfnOutput,
  CfnParameter,
  Stack,
  type StackProps,
  aws_bedrockagentcore as agentcore,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export const AGENTX_WORKSPACE_MOUNT = "/mnt/workspace";
export const AGENTX_WORKSPACE_VOLUME = "workspace";
export const AGENTCORE_INSTANCES_REGIONS = new Set([
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "eu-central-1",
  "eu-west-1",
  "us-east-1",
  "us-east-2",
  "us-west-2",
]);

export interface AgentRuntimeConfiguration {
  region: string;
  mountPath: string;
  providerIdleSeconds: number;
  providerMaxLifetimeSeconds: number;
  runtimeIdleSeconds: number;
  runtimeMaxLifetimeSeconds: number;
  volumeSizeGiB: number;
}

export interface AgentRuntimeStackProps extends StackProps {
  deploymentRegion: string;
  configuration?: Partial<Omit<AgentRuntimeConfiguration, "region">>;
}

export function validateAgentRuntimeConfiguration(
  configuration: AgentRuntimeConfiguration,
): AgentRuntimeConfiguration {
  if (!AGENTCORE_INSTANCES_REGIONS.has(configuration.region)) {
    throw new Error(`AgentCore Instances is not supported in region ${configuration.region}`);
  }
  if (configuration.mountPath !== AGENTX_WORKSPACE_MOUNT || !/^\/mnt\/[a-zA-Z0-9._-]+\/?$/.test(configuration.mountPath)) {
    throw new Error("AgentX workspace must be mounted at /mnt/workspace");
  }
  const lifetimes = [
    configuration.providerIdleSeconds,
    configuration.providerMaxLifetimeSeconds,
    configuration.runtimeIdleSeconds,
    configuration.runtimeMaxLifetimeSeconds,
  ];
  if (lifetimes.some((value) => !Number.isInteger(value) || value < 60 || value > 1_209_600)) {
    throw new Error("AgentCore Instances lifecycle values must be integers from 60 through 1209600 seconds");
  }
  if (configuration.providerIdleSeconds > configuration.providerMaxLifetimeSeconds) {
    throw new Error("capacity provider idle timeout cannot exceed its maximum lifetime");
  }
  if (configuration.runtimeIdleSeconds > configuration.runtimeMaxLifetimeSeconds) {
    throw new Error("runtime idle timeout cannot exceed its maximum lifetime");
  }
  if (configuration.runtimeMaxLifetimeSeconds > configuration.providerMaxLifetimeSeconds) {
    throw new Error("runtime maximum lifetime cannot exceed capacity provider maximum lifetime");
  }
  if (!Number.isInteger(configuration.volumeSizeGiB) || configuration.volumeSizeGiB < 1) {
    throw new Error("workspace volume size must be a positive GiB integer");
  }
  return configuration;
}

export class AgentRuntimeStack extends Stack {
  readonly runtimeArn: string;
  readonly capacityProviderArn: string;

  constructor(scope: Construct, id: string, props: AgentRuntimeStackProps) {
    super(scope, id, props);
    const configuration = validateAgentRuntimeConfiguration({
      region: props.deploymentRegion,
      mountPath: props.configuration?.mountPath ?? AGENTX_WORKSPACE_MOUNT,
      providerIdleSeconds: props.configuration?.providerIdleSeconds ?? 900,
      providerMaxLifetimeSeconds: props.configuration?.providerMaxLifetimeSeconds ?? 28_800,
      runtimeIdleSeconds: props.configuration?.runtimeIdleSeconds ?? 900,
      runtimeMaxLifetimeSeconds: props.configuration?.runtimeMaxLifetimeSeconds ?? 28_800,
      volumeSizeGiB: props.configuration?.volumeSizeGiB ?? 100,
    });

    const subnets = new CfnParameter(this, "InstanceSubnets", {
      type: "List<AWS::EC2::Subnet::Id>",
      description: "Private subnets with repository, ECR, model, and control-plane egress",
    });
    const securityGroups = new CfnParameter(this, "InstanceSecurityGroups", {
      type: "List<AWS::EC2::SecurityGroup::Id>",
    });
    const operatorRoleArn = new CfnParameter(this, "CapacityProviderOperatorRoleArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[^:]+)?:iam::[0-9]{12}:role/.+$",
    });
    const runtimeRoleArn = new CfnParameter(this, "RuntimeExecutionRoleArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[^:]+)?:iam::[0-9]{12}:role/.+$",
    });
    const imageUri = new CfnParameter(this, "WorkerImageUri", {
      type: "String",
      allowedPattern: "^.+@sha256:[a-f0-9]{64}$",
      description: "Immutable private ECR image URI",
    });
    const instanceTypes = new CfnParameter(this, "AllowedInstanceTypes", {
      type: "CommaDelimitedList",
      default: "m5.large",
    });

    const capacityProvider = new agentcore.CfnCapacityProvider(this, "AgentXCapacityProvider", {
      name: "agentx_capacity_provider",
      description: "Isolated AgentX development workspace capacity",
      permissionsConfiguration: {
        capacityProviderOperatorRoleArn: operatorRoleArn.valueAsString,
      },
      computeConfiguration: {
        ec2Configuration: {
          launchTemplateSource: {
            launchParameters: {
              operatingSystem: "LINUX_X86_64",
              instanceRequirements: { allowedInstanceTypes: instanceTypes.valueAsList },
              monitoring: "DETAILED",
              propagatedTags: { Application: "AgentX" },
            },
          },
          vpcConfiguration: {
            subnets: subnets.valueAsList,
            securityGroups: securityGroups.valueAsList,
          },
          volumes: [
            {
              ebsConfiguration: {
                name: AGENTX_WORKSPACE_VOLUME,
                sizeGiB: configuration.volumeSizeGiB,
                volumeType: "gp3",
                encrypted: true,
              },
            },
          ],
          lifecycleConfiguration: {
            idleInstanceTimeout: configuration.providerIdleSeconds,
            maxLifetime: configuration.providerMaxLifetimeSeconds,
          },
        },
      },
    });

    const runtime = new agentcore.CfnRuntime(this, "AgentXRuntime", {
      agentRuntimeName: "agentx_worker",
      description: "AgentX remote coding worker",
      roleArn: runtimeRoleArn.valueAsString,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: imageUri.valueAsString },
      },
      capacityProviderConfiguration: { capacityProviderArn: capacityProvider.attrArn },
      filesystemConfigurations: [
        {
          capacityProviderVolume: {
            volumeName: AGENTX_WORKSPACE_VOLUME,
            mountPath: configuration.mountPath,
          },
        },
      ],
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: configuration.runtimeIdleSeconds,
        maxLifetime: configuration.runtimeMaxLifetimeSeconds,
      },
      protocolConfiguration: "HTTP",
      environmentVariables: { AGENTX_WORKSPACE_ROOT: configuration.mountPath },
    });
    runtime.addResourceDependency(capacityProvider);

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    this.capacityProviderArn = capacityProvider.attrArn;
    new CfnOutput(this, "AgentRuntimeArn", { value: this.runtimeArn });
    new CfnOutput(this, "CapacityProviderArn", { value: this.capacityProviderArn });
    new CfnOutput(this, "WorkspaceMountPath", { value: configuration.mountPath });
  }
}
