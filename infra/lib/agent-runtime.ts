import {
  Aws,
  CfnOutput,
  CfnParameter,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_bedrockagentcore as agentcore,
  aws_iam as iam,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { WORKER_SETTING_PARAMETERS } from "@agentx/contracts";
import { type AgentXNaming, legacyNaming } from "./naming.js";

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
  runtimeIdleSeconds: number;
  runtimeMaxLifetimeSeconds: number;
}

export interface AgentRuntimeStackProps extends StackProps {
  deploymentRegion: string;
  configuration?: Partial<Omit<AgentRuntimeConfiguration, "region">>;
  naming?: AgentXNaming;
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
  const lifetimes = [configuration.runtimeIdleSeconds, configuration.runtimeMaxLifetimeSeconds];
  if (lifetimes.some((value) => !Number.isInteger(value) || value < 60 || value > 1_209_600)) {
    throw new Error("AgentCore Instances lifecycle values must be integers from 60 through 1209600 seconds");
  }
  if (configuration.runtimeIdleSeconds > configuration.runtimeMaxLifetimeSeconds) {
    throw new Error("runtime idle timeout cannot exceed its maximum lifetime");
  }
  return configuration;
}

export class AgentRuntimeStack extends Stack {
  readonly runtimeArn: string;
  readonly capacityProviderArn: string;

  constructor(scope: Construct, id: string, props: AgentRuntimeStackProps) {
    super(scope, id, props);
    const naming = props.naming ?? legacyNaming();
    const configuration = validateAgentRuntimeConfiguration({
      region: props.deploymentRegion,
      mountPath: props.configuration?.mountPath ?? AGENTX_WORKSPACE_MOUNT,
      runtimeIdleSeconds: props.configuration?.runtimeIdleSeconds ?? 300,
      runtimeMaxLifetimeSeconds: props.configuration?.runtimeMaxLifetimeSeconds ?? 1_209_600,
    });

    const imageUri = new CfnParameter(this, "WorkerImageUri", {
      type: "String",
      allowedPattern: "^.+@sha256:[a-f0-9]{64}$",
      description: "Immutable private ECR linux/arm64 worker image URI",
    });
    const controlPlaneUrl = new CfnParameter(this, "ControlPlaneUrl", {
      type: "String",
      allowedPattern: "^https://.+$",
      description: "HTTPS AgentX callback API URL",
    });
    const modelProvider = new CfnParameter(this, "ModelProvider", {
      type: "String",
      default: "amazon-bedrock",
      description: "pi model provider identifier",
    });
    const modelId = new CfnParameter(this, "ModelId", {
      type: "String",
      description: "pi model identifier available in the deployment region",
    });
    const promptCacheRetention = new CfnParameter(this, "PromptCacheRetention", {
      type: "String",
      default: "long",
      allowedValues: ["short", "long"],
      description: "Bedrock prompt-cache retention mode used by pi",
    });
    const capacityProviderArn = new CfnParameter(this, "CapacityProviderArnParameter", {
      type: "String",
      allowedPattern:
        "^arn:aws(-[^:]+)?:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:capacity-provider/[a-zA-Z][a-zA-Z0-9_]{0,47}-[a-zA-Z0-9]{10}$",
      description: "Stable AgentCore Instances capacity provider for production workspaces",
    });
    capacityProviderArn.overrideLogicalId("CapacityProviderArn");

    const executionRole = new iam.Role(this, "RuntimeExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${props.deploymentRegion}:${this.account}:*`,
          },
        },
      }),
      description: "Execution role for the AgentX production coding runtime",
    });
    const runtimePolicy = new iam.Policy(this, "RuntimeExecutionPolicy", {
      roles: [executionRole],
      statements: [
        new iam.PolicyStatement({
          sid: "EcrImageAccess",
          actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
          resources: [
            `arn:${this.partition}:ecr:${props.deploymentRegion}:${this.account}:repository/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: "EcrTokenAccess",
          actions: ["ecr:GetAuthorizationToken"],
          resources: ["*"],
        }),
        // Under environment naming, the runtime pulls AgentX images through the ECR pull-through
        // cache: the first pull of any tag imports it into the environment's cache prefix, which
        // needs BatchImportUpstreamImage and CreateRepository in addition to the ordinary image-pull
        // actions above. The legacy deployment has no pull-through prefix to scope this to. Aws.REGION,
        // not the synthesis region, so the released template deploys in any region.
        ...(naming.env === undefined
          ? []
          : [
              new iam.PolicyStatement({
                sid: "EcrPullThroughCache",
                actions: [
                  "ecr:BatchGetImage",
                  "ecr:GetDownloadUrlForLayer",
                  "ecr:BatchImportUpstreamImage",
                  "ecr:CreateRepository",
                ],
                resources: [
                  `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${naming.pullThroughPrefix}/*`,
                ],
              }),
            ]),
        new iam.PolicyStatement({
          sid: "BedrockModelInvocation",
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: [
            `arn:${this.partition}:bedrock:*::foundation-model/*`,
            `arn:${this.partition}:bedrock:${props.deploymentRegion}:${this.account}:*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: "RuntimeLogs",
          actions: [
            "logs:CreateLogGroup",
            "logs:DescribeLogGroups",
            "logs:DescribeLogStreams",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:PutResourcePolicy",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "RuntimeTracing",
          actions: [
            "xray:PutTraceSegments",
            "xray:PutTelemetryRecords",
            "xray:GetSamplingRules",
            "xray:GetSamplingTargets",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "RuntimeMetrics",
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
        }),
      ],
    });

    const runtime = new agentcore.CfnRuntime(this, "AgentXRuntime", {
      agentRuntimeName: naming.runtimeName,
      description: "AgentX production remote coding worker",
      roleArn: executionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: imageUri.valueAsString },
      },
      capacityProviderConfiguration: { capacityProviderArn: capacityProviderArn.valueAsString },
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
      environmentVariables: {
        AGENTX_WORKSPACE_ROOT: configuration.mountPath,
        AGENTX_CONTROL_PLANE_URL: controlPlaneUrl.valueAsString,
        AGENTX_MODEL_PROVIDER: modelProvider.valueAsString,
        AGENTX_MODEL_ID: modelId.valueAsString,
        PI_CACHE_RETENTION: promptCacheRetention.valueAsString,
      },
      tags: {
        Application: "AgentX",
        DeploymentMode: "instances-ebs",
        Environment: naming.environmentTagValue,
      },
    });
    runtime.node.addDependency(runtimePolicy);
    // A named environment's runtime holds no data (workspaces live on the capacity provider), so it goes with its stack; legacy keeps Retain unchanged.
    runtime.applyRemovalPolicy(naming.env === undefined ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

    // The EC2 session provisioner (#83) boots workers with the image and model a release last
    // deployed here.
    new ssm.StringParameter(this, "WorkerImageParameter", {
      parameterName: naming.ec2.workerImageParameterName,
      stringValue: imageUri.valueAsString,
      description: "AgentX worker image URI pinned by digest, for EC2 workers",
    });
    const workerSettings: Array<[string, keyof typeof WORKER_SETTING_PARAMETERS, string]> = [
      ["WorkerModelProviderParameter", "modelProvider", modelProvider.valueAsString],
      ["WorkerModelIdParameter", "modelId", modelId.valueAsString],
      ["WorkerPromptCacheRetentionParameter", "promptCacheRetention", promptCacheRetention.valueAsString],
    ];
    for (const [id, setting, value] of workerSettings) {
      new ssm.StringParameter(this, id, {
        parameterName: `${naming.ec2.workerSettingsPrefix}${WORKER_SETTING_PARAMETERS[setting]}`,
        stringValue: value,
        description: `AgentX worker ${setting} for EC2 workers`,
      });
    }

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    this.capacityProviderArn = capacityProviderArn.valueAsString;
    new CfnOutput(this, "AgentRuntimeArn", { value: this.runtimeArn });
    new CfnOutput(this, "CapacityProviderArn", { value: this.capacityProviderArn });
    new CfnOutput(this, "RuntimeExecutionRoleArn", { value: executionRole.roleArn });
    new CfnOutput(this, "DeploymentMode", { value: "instances-ebs" });
    new CfnOutput(this, "WorkspaceMountPath", { value: configuration.mountPath });
  }
}
