import { openRouterParameters, openRouterRoutingParameter } from "./openrouter.js";
import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_sns as sns,
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
    const openRouter = openRouterParameters(this);
    const openRouterProviders = openRouterRoutingParameter(this);
    const classifierProvider = new CfnParameter(this, "GateClassifierProvider", { type: "String", default: "amazon-bedrock", allowedValues: ["amazon-bedrock", "openrouter"] });
    const modelProvider = new CfnParameter(this, "ModelProvider", { type: "String", default: "amazon-bedrock" });
    const modelId = new CfnParameter(this, "ModelId", { type: "String", default: "amazon.nova-pro-v1:0" });
    const gateClassifierModelId = new CfnParameter(this, "GateClassifierModelId", {
      type: "String",
      default: "amazon.nova-lite-v1:0",
      description: "Small model the action gate asks whether a member asked for a change",
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
    const serviceMetric = (metric: string, dimensions?: Record<string, string>) => {
      logGroup.addMetricFilter(`${metric}Metric`, {
        filterPattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue("$.event", "=", "metric"),
          logs.FilterPattern.stringValue("$.metric", "=", metric),
        ),
        metricNamespace: naming.metricsNamespace,
        metricName: metric,
        metricValue: "$.count",
        ...(dimensions === undefined ? {} : { dimensions }),
      });
    };
    const serviceMetrics: ReadonlyArray<{ metric: string; dimensions?: Record<string, string> }> = [
      { metric: "TurnCompleted" },
      { metric: "TurnEmptyResponse" },
      { metric: "ToolUnknownName" },
      { metric: "TurnRecordWriteFailed" },
      { metric: "ToolSchemaError", dimensions: { connector: "$.connector" } },
    ];
    for (const { metric, dimensions } of serviceMetrics) serviceMetric(metric, dimensions);
    // A failure while emitting the lines above would otherwise leave those metrics silently missing.
    logGroup.addMetricFilter("TurnMetricsEmitFailedMetric", {
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", "turn_metrics.emit_failed"),
      metricNamespace: naming.metricsNamespace,
      metricName: "TurnMetricsEmitFailed",
      metricValue: "1",
    });
    // FR-045, environment naming only, so the legacy template stays byte-identical. The topic is
    // the control plane's; its policy already lets any alarm in this account publish.
    if (naming.env !== undefined) {
      const alertsTopicArn = new CfnParameter(this, "OperatorAlertsTopicArn", {
        type: "String",
        description: "The environment's alert topic, the control plane's OperatorAlertsTopicArn output",
      });
      const slowTurnMinutes = new CfnParameter(this, "SlowTurnMinutes", {
        type: "Number", default: 5, minValue: 1, maxValue: 60,
        description: "A turn slower than this many minutes raises the SlowTurns alarm (alerts.slowTurnMinutes)",
      });
      const notify = new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, "OperatorAlerts", alertsTopicArn.valueAsString));
      const eventMetric = (id: string, event: string, metricName: string) => logGroup.addMetricFilter(id, {
        filterPattern: logs.FilterPattern.stringValue("$.event", "=", event),
        metricNamespace: naming.metricsNamespace, metricName, metricValue: "1",
      });
      eventMetric("TurnFailedMetric", "task.failed", "TurnFailed");
      eventMetric("SlackDeliveryFailedMetric", "request.abandoned", "SlackDeliveryFailed");
      // F18: reuses the same serviceMetric helper as the existing metric filters above, rather than
      // a second copy of the loop, for the two metrics emitTurnMetrics adds (turn-records.ts).
      for (const metric of ["TurnDurationMs", "GateCheckerFailed"]) serviceMetric(metric);
      const agentx = (metricName: string, statistic: string) =>
        new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic, period: Duration.minutes(5) });
      const alarm = (id: string, props: { suffix: string; description: string; metric: cloudwatch.IMetric; threshold: number }) => {
        const created = new cloudwatch.Alarm(this, id, {
          alarmName: naming.alarmName(props.suffix),
          alarmDescription: props.description,
          metric: props.metric,
          threshold: props.threshold,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        created.addAlarmAction(notify);
        return created;
      };
      alarm("TurnErrorsAlarm", { suffix: "TurnErrors", threshold: 1, metric: agentx("TurnFailed", "Sum"),
        description: "An orchestrator turn failed. Export recent turns with agentx admin turns export --since 1h." });
      alarm("SlowTurnsAlarm", {
        suffix: "SlowTurns",
        threshold: slowTurnMinutes.valueAsNumber,
        metric: new cloudwatch.MathExpression({
          expression: "slowest / 60000",
          usingMetrics: { slowest: agentx("TurnDurationMs", "Maximum") },
          period: Duration.minutes(5),
          label: "Slowest turn in minutes",
        }),
        description: "A turn took longer than alerts.slowTurnMinutes. Export recent turns with agentx admin turns export --since 1h.",
      });
      alarm("SlackDeliveryFailedAlarm", { suffix: "SlackDeliveryFailed", threshold: 1, metric: agentx("SlackDeliveryFailed", "Sum"),
        description: "A Slack request was given up after its last attempt, so the member got no answer. Check the Slack service logs for request.abandoned." });
      alarm("CheckerFailuresAlarm", { suffix: "CheckerFailures", threshold: 1, metric: agentx("GateCheckerFailed", "Sum"),
        description: "The action gate could not check a call and refused it. Check the classifier model's access and the Slack service logs." });
      const onBedrock = (id: string, provider: CfnParameter) => new CfnCondition(this, id, { expression: Fn.conditionEquals(provider.valueAsString, "amazon-bedrock") });
      const throttles = (id: string, suffix: string, model: CfnParameter, condition: CfnCondition, what: string) => {
        const created = alarm(id, {
          suffix, threshold: 5,
          metric: new cloudwatch.Metric({ namespace: "AWS/Bedrock", metricName: "InvocationThrottles", dimensionsMap: { ModelId: model.valueAsString }, statistic: "Sum", period: Duration.minutes(5) }),
          description: `Amazon Bedrock throttled the ${what} model at least 5 times in 5 minutes. Ask for a higher quota in Service Quotas, or choose another model.`,
        });
        (created.node.defaultChild as cloudwatch.CfnAlarm).cfnOptions.condition = condition;
      };
      throttles("BedrockThrottlingAlarm", "BedrockThrottling", modelId, onBedrock("OrchestratorOnBedrock", modelProvider), "orchestrator");
      throttles("ClassifierThrottlingAlarm", "ClassifierThrottling", gateClassifierModelId, onBedrock("ClassifierOnBedrock", classifierProvider), "classifier");
      alarm("TestAlarm", { suffix: "TestAlarm", threshold: 1, metric: agentx("TestAlarmNeverEmitted", "Sum"),
        description: "agentx alerts test sets this alarm to ALARM and back to OK. It never fires on its own." });
    }
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
    // Under environment naming, the Slack service pulls AgentX images through the ECR pull-through
    // cache: the first pull of any tag imports it into the environment's cache prefix, which needs
    // BatchImportUpstreamImage and CreateRepository in addition to the ordinary image-pull actions
    // above. The legacy deployment has no pull-through prefix to scope this to. Aws.REGION, not the
    // synthesis region, so the released template deploys in any region.
    if (naming.env !== undefined) {
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: "EcrPullThroughCache",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchImportUpstreamImage",
          "ecr:CreateRepository",
        ],
        resources: [`arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${naming.pullThroughPrefix}/*`],
      }));
    }
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
          { name: "AGENTX_OPENROUTER_SECRET_ARN", value: openRouter.secretArn.valueAsString },
          { name: "AGENTX_OPENROUTER_PROVIDERS", value: openRouterProviders.valueAsString },
          { name: "AGENTX_GATE_CLASSIFIER_PROVIDER", value: classifierProvider.valueAsString },
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
