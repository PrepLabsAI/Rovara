import {
  CfnOutput,
  CfnParameter,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export const AGENTX_SLACK_ORCHESTRATOR_REPOSITORY = "agentx-slack-orchestrator";

export interface SlackOrchestratorStackProps extends StackProps {
  naming?: AgentXNaming;
}

// The task role and every queue, table, bucket, and secret it uses belong to AgentXControlPlane,
// which must know the role before this stack exists. This stack only runs the container.
export class SlackOrchestratorStack extends Stack {
  constructor(scope: Construct, id: string, props?: SlackOrchestratorStackProps) {
    super(scope, id, props);
    const naming = props?.naming ?? legacyNaming();

    const imageUri = new CfnParameter(this, "OrchestratorImageUri", {
      type: "String",
      allowedPattern: "^.+@sha256:[a-f0-9]{64}$",
      description: "Immutable private ECR linux/arm64 Slack orchestrator image URI",
    });
    const taskRoleArn = new CfnParameter(this, "TaskRoleArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[^:]+)?:iam::[0-9]{12}:role/.+$",
      description: "SlackOrchestratorTaskRoleArn output of AgentXControlPlane",
    });
    const controlPlaneUrl = new CfnParameter(this, "ControlPlaneUrl", { type: "String", allowedPattern: "^https://.+$" });
    const queueUrl = new CfnParameter(this, "SlackRequestQueueUrl", { type: "String", allowedPattern: "^https://sqs\\..+\\.fifo$" });
    const threadsTableName = new CfnParameter(this, "SlackThreadsTableName", { type: "String", minLength: 3 });
    const sessionBucketName = new CfnParameter(this, "ThreadSessionBucketName", { type: "String", minLength: 3 });
    const turnRecordsTableName = new CfnParameter(this, "TurnRecordsTableName", {
      type: "String",
      minLength: 3,
      description: "TurnRecordsTableName output of AgentXControlPlane",
    });
    const secretArn = new CfnParameter(this, "SlackSecretArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[^:]+)?:secretsmanager:.+$",
    });
    const vpcId = new CfnParameter(this, "VpcId", { type: "AWS::EC2::VPC::Id" });
    const subnetIds = new CfnParameter(this, "PrivateSubnetIds", {
      type: "List<AWS::EC2::Subnet::Id>",
      description: "Private subnets with NAT egress, such as AgentXProductionFoundation's PrivateSubnetIds",
    });
    const modelProvider = new CfnParameter(this, "ModelProvider", { type: "String", default: "amazon-bedrock" });
    const modelId = new CfnParameter(this, "ModelId", { type: "String", default: "amazon.nova-pro-v1:0" });
    const gateClassifierModelId = new CfnParameter(this, "GateClassifierModelId", {
      type: "String",
      default: "amazon.nova-lite-v1:0",
      description: "Small Bedrock model the action gate asks whether a member asked for a change",
    });

    const securityGroup = new ec2.CfnSecurityGroup(this, "SecurityGroup", {
      groupDescription: "AgentX Slack orchestrator: no ingress and HTTPS-only egress",
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [{
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrIp: "0.0.0.0/0",
        description: "HTTPS to Slack, Amazon Bedrock, the AgentX control plane, and AWS APIs",
      }],
      tags: [{ key: "Application", value: "AgentX" }],
    });
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // The awslogs driver does not extract embedded metric format, so the service logs
    // {"event":"metric","metric":<name>,"count":<n>} lines and these filters publish them.
    const serviceMetrics: ReadonlyArray<{ metric: string; dimensions?: Record<string, string> }> = [
      { metric: "TurnCompleted" },
      { metric: "TurnEmptyResponse" },
      { metric: "ToolUnknownName" },
      { metric: "TurnRecordWriteFailed" },
      { metric: "ToolSchemaError", dimensions: { connector: "$.connector" } },
    ];
    for (const { metric, dimensions } of serviceMetrics) {
      logGroup.addMetricFilter(`${metric}Metric`, {
        filterPattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue("$.event", "=", "metric"),
          logs.FilterPattern.stringValue("$.metric", "=", metric),
        ),
        metricNamespace: "AgentX",
        metricName: metric,
        metricValue: "$.count",
        ...(dimensions === undefined ? {} : { dimensions }),
      });
    }
    // A failure while emitting the lines above would otherwise leave those metrics silently missing.
    logGroup.addMetricFilter("TurnMetricsEmitFailedMetric", {
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", "turn_metrics.emit_failed"),
      metricNamespace: "AgentX",
      metricName: "TurnMetricsEmitFailed",
      metricValue: "1",
    });
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Pulls the AgentX Slack orchestrator image and writes its logs",
    });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      resources: [`arn:${this.partition}:ecr:${this.region}:${this.account}:repository/${AGENTX_SLACK_ORCHESTRATOR_REPOSITORY}`],
    }));
    logGroup.grantWrite(executionRole);

    const cluster = new ecs.CfnCluster(this, "Cluster", {
      clusterSettings: [{ name: "containerInsights", value: "disabled" }],
      tags: [{ key: "Application", value: "AgentX" }],
    });
    const taskDefinition = new ecs.CfnTaskDefinition(this, "TaskDefinition", {
      family: naming.taskFamily,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "512",
      memory: "1024",
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: taskRoleArn.valueAsString,
      containerDefinitions: [{
        name: "orchestrator",
        image: imageUri.valueAsString,
        essential: true,
        stopTimeout: 120,
        environment: [
          { name: "AWS_REGION", value: this.region },
          { name: "CONTROL_PLANE_URL", value: controlPlaneUrl.valueAsString },
          { name: "SLACK_REQUEST_QUEUE_URL", value: queueUrl.valueAsString },
          { name: "SLACK_THREADS_TABLE_NAME", value: threadsTableName.valueAsString },
          { name: "THREAD_SESSION_BUCKET_NAME", value: sessionBucketName.valueAsString },
          { name: "TURN_RECORDS_TABLE_NAME", value: turnRecordsTableName.valueAsString },
          { name: "SLACK_SECRET_ARN", value: secretArn.valueAsString },
          { name: "AGENTX_ORCHESTRATOR_PROVIDER", value: modelProvider.valueAsString },
          { name: "AGENTX_ORCHESTRATOR_MODEL", value: modelId.valueAsString },
          { name: "AGENTX_GATE_CLASSIFIER_MODEL", value: gateClassifierModelId.valueAsString },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup.logGroupName,
            "awslogs-region": this.region,
            "awslogs-stream-prefix": "orchestrator",
          },
        },
      }],
    });
    const service = new ecs.CfnService(this, "Service", {
      cluster: cluster.ref,
      taskDefinition: taskDefinition.ref,
      launchType: "FARGATE",
      desiredCount: 1,
      enableExecuteCommand: false,
      deploymentConfiguration: {
        minimumHealthyPercent: 100,
        maximumPercent: 200,
        deploymentCircuitBreaker: { enable: true, rollback: true },
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnetIds.valueAsList,
          securityGroups: [securityGroup.attrGroupId],
          assignPublicIp: "DISABLED",
        },
      },
    });

    new CfnOutput(this, "ClusterName", { value: cluster.ref });
    new CfnOutput(this, "ServiceName", { value: service.attrName });
  }
}
