import {
  CfnOutput,
  CfnParameter,
  Stack,
  Token,
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
  permissionProfile?: "team-tasks";
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
    const teamTasks = props.permissionProfile === "team-tasks";
    if (teamTasks && (runtimeName !== "charterarc_team_tasks_worker" || props.deploymentRegion !== "us-east-1" || Token.isUnresolved(this.account) || !/^\d{12}$/.test(this.account))) {
      throw new Error("Team Tasks permissions require the named runtime, us-east-1 and a concrete account");
    }
    const partition = teamTasks ? "aws" : this.partition;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(runtimeName) || runtimeName.trim() !== runtimeName) {
      throw new Error("invalid AgentCore runtime name");
    }
    const configuration = validateDemoRuntimeConfiguration({
      mountPath: props.configuration?.mountPath ?? AGENTX_WORKSPACE_MOUNT,
      idleSeconds: props.configuration?.idleSeconds ?? 900,
      maxLifetimeSeconds: props.configuration?.maxLifetimeSeconds ?? (teamTasks ? 3600 : 28_800),
    });

    const imageUri = new CfnParameter(this, "WorkerImageUri", {
      type: "String",
      allowedPattern: teamTasks
        ? `^${this.account}\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/charterarc-team-tasks-worker@sha256:[a-f0-9]{64}$`
        : "^.+@sha256:[a-f0-9]{64}$",
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
      ...(teamTasks ? { allowedValues: ["amazon-bedrock"] } : {}),
      description: "pi model provider identifier",
    });
    const modelId = new CfnParameter(this, "ModelId", {
      type: "String",
      description: "pi model identifier available in the deployment region",
      ...(teamTasks ? { allowedValues: ["amazon.nova-pro-v1:0"] } : {}),
    });

    const executionRole = new iam.Role(this, "RuntimeExecutionRole", {
      ...(teamTasks ? {
        roleName: "CharterArcTeamTasksRuntimeWorker",
        permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "RuntimeBoundary",
          `arn:aws:iam::${this.account}:policy/CharterArcTeamTasksRuntimeBoundary`),
      } : {}),
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": teamTasks
              ? `arn:aws:bedrock-agentcore:${props.deploymentRegion}:${this.account}:runtime/${runtimeName}-*`
              : `arn:${this.partition}:bedrock-agentcore:${props.deploymentRegion}:${this.account}:*`,
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
          `arn:${partition}:ecr:${props.deploymentRegion}:${this.account}:repository/${teamTasks ? "charterarc-team-tasks-worker" : "*"}`,
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
        resources: teamTasks ? ["arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0"] : [
          `arn:${this.partition}:bedrock:*::foundation-model/*`,
          `arn:${this.partition}:bedrock:${props.deploymentRegion}:${this.account}:*`,
        ],
        }),
        new iam.PolicyStatement({
        sid: "RuntimeLogs",
        actions: [
          "logs:CreateLogGroup",
          ...(teamTasks ? [] : ["logs:DescribeLogGroups"]),
          "logs:DescribeLogStreams",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          ...(teamTasks ? [] : ["logs:PutResourcePolicy"]),
        ],
        resources: teamTasks ? [
          `arn:aws:logs:us-east-1:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*`,
        ] : ["*"],
        }),
        ...(teamTasks ? [new iam.PolicyStatement({
          sid: "RuntimeLogDiscovery",
          actions: ["logs:DescribeLogGroups"],
          resources: ["*"],
        })] : []),
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
        ...(teamTasks ? { AGENTX_DEMO_RUN_LIMITS: "1" } : {}),
        AGENTX_WORKSPACE_ROOT: configuration.mountPath,
        AGENTX_CONTROL_PLANE_URL: controlPlaneUrl.valueAsString,
        AGENTX_MODEL_PROVIDER: modelProvider.valueAsString,
        AGENTX_MODEL_ID: modelId.valueAsString,
      },
      tags: { Application: "AgentX", DeploymentMode: AGENTX_DEMO_DEPLOYMENT_MODE,
        ...(teamTasks ? { CharterArcScope: "TeamTasksDemo" } : {}),
      },
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
