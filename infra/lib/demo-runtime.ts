import {
  CfnOutput,
  CfnParameter,
  Stack,
  type StackProps,
  aws_bedrockagentcore as agentcore,
  aws_iam as iam,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AGENTX_WORKSPACE_MOUNT } from "./agent-runtime.js";

export const AGENTX_DEMO_DEPLOYMENT_MODE = "demo-microvm";
export const AGENTCORE_MICROVM_MAX_LIFETIME_SECONDS = 28_800;

export interface DemoRuntimeConfiguration {
  mountPath: string;
  idleSeconds: number;
  maxLifetimeSeconds: number;
}

export interface DemoRuntimeStackProps extends StackProps {
  deploymentRegion: string;
  configuration?: Partial<DemoRuntimeConfiguration>;
  runtimeName?: string;
}

export function selectDemoRuntime(deploymentMode: string, teamTasks: unknown): { stackId: string; runtimeName: string } {
  if (teamTasks !== undefined && teamTasks !== true && teamTasks !== "true") {
    throw new Error("agentxTeamTasksRuntime must be true or absent");
  }
  if (teamTasks !== undefined && deploymentMode !== "demo-microvm") {
    throw new Error("agentxTeamTasksRuntime requires demo-microvm");
  }
  return teamTasks === undefined
    ? { stackId: "AgentXDemoRuntime", runtimeName: "agentx_demo_worker" }
    : { stackId: "CharterArcTeamTasksRuntime", runtimeName: "charterarc_team_tasks_worker" };
}

export function validateDemoRuntimeConfiguration(
  configuration: DemoRuntimeConfiguration,
): DemoRuntimeConfiguration {
  if (
    configuration.mountPath !== AGENTX_WORKSPACE_MOUNT ||
    !/^\/mnt\/[a-zA-Z0-9._-]+\/?$/.test(configuration.mountPath)
  ) {
    throw new Error("AgentX demo workspace must be mounted at /mnt/workspace");
  }
  if (
    !Number.isInteger(configuration.idleSeconds) ||
    configuration.idleSeconds < 60 ||
    configuration.idleSeconds > AGENTCORE_MICROVM_MAX_LIFETIME_SECONDS ||
    !Number.isInteger(configuration.maxLifetimeSeconds) ||
    configuration.maxLifetimeSeconds < 60 ||
    configuration.maxLifetimeSeconds > AGENTCORE_MICROVM_MAX_LIFETIME_SECONDS
  ) {
    throw new Error("AgentCore microVM lifecycle values must be integers from 60 through 28800 seconds");
  }
  if (configuration.idleSeconds > configuration.maxLifetimeSeconds) {
    throw new Error("microVM idle timeout cannot exceed its maximum lifetime");
  }
  return configuration;
}

export class DemoRuntimeStack extends Stack {
  readonly runtimeArn: string;
  readonly runtimeRoleArn: string;

  constructor(scope: Construct, id: string, props: DemoRuntimeStackProps) {
    super(scope, id, props);
    const runtimeName = props.runtimeName ?? "agentx_demo_worker";
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(runtimeName) || runtimeName.trim() !== runtimeName) {
      throw new Error("invalid AgentCore runtime name");
    }
    const configuration = validateDemoRuntimeConfiguration({
      mountPath: props.configuration?.mountPath ?? AGENTX_WORKSPACE_MOUNT,
      idleSeconds: props.configuration?.idleSeconds ?? 900,
      maxLifetimeSeconds: props.configuration?.maxLifetimeSeconds ?? 28_800,
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

    const executionRole = new iam.Role(this, "RuntimeExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${props.deploymentRegion}:${this.account}:*`,
          },
        },
      }),
      description: "Execution role for the AgentX VPC-free demonstration runtime",
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

    const runtime = new agentcore.CfnRuntime(this, "AgentXDemoRuntime", {
      agentRuntimeName: runtimeName,
      description: "AgentX VPC-free microVM demonstration worker",
      roleArn: executionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: imageUri.valueAsString },
      },
      networkConfiguration: { networkMode: "PUBLIC" },
      filesystemConfigurations: [
        { sessionStorage: { mountPath: configuration.mountPath } },
      ],
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: configuration.idleSeconds,
        maxLifetime: configuration.maxLifetimeSeconds,
      },
      protocolConfiguration: "HTTP",
      environmentVariables: {
        AGENTX_WORKSPACE_ROOT: configuration.mountPath,
        AGENTX_CONTROL_PLANE_URL: controlPlaneUrl.valueAsString,
        AGENTX_MODEL_PROVIDER: modelProvider.valueAsString,
        AGENTX_MODEL_ID: modelId.valueAsString,
      },
      tags: { Application: "AgentX", DeploymentMode: AGENTX_DEMO_DEPLOYMENT_MODE },
    });
    runtime.node.addDependency(runtimePolicy);

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    this.runtimeRoleArn = executionRole.roleArn;
    new CfnOutput(this, "AgentRuntimeArn", { value: this.runtimeArn });
    new CfnOutput(this, "RuntimeExecutionRoleArn", { value: this.runtimeRoleArn });
    new CfnOutput(this, "DeploymentMode", { value: AGENTX_DEMO_DEPLOYMENT_MODE });
    new CfnOutput(this, "WorkspaceMountPath", { value: configuration.mountPath });
  }
}
