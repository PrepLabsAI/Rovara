import { resolve } from "node:path";
import {
  Aws,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  aws_cloudwatch as cloudwatch,
  type aws_cloudwatch_actions as cloudwatchActions,
  type aws_dynamodb as dynamodb,
  aws_iam as iam,
  type aws_kms as kms,
  type aws_lambda as lambda,
  aws_logs as logs,
  aws_stepfunctions as sfn,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { WORKER_SETTING_PARAMETERS } from "@agentx/contracts";
import { packagedFunction } from "./control-plane.js";
import { EC2_WORKER_AMI_PARAMETER } from "./ec2-workers.js";
import type { AgentXNaming } from "./naming.js";
import { deleterDefinition, provisionerDefinition } from "./session-state-machines.js";

export interface SessionLifecycleProps {
  naming: AgentXNaming;
  state: dynamodb.Table;
  invokeSigningKey: kms.IKey;
  notifyOperator: cloudwatchActions.SnsAction;
}

/**
 * The EC2 session lifecycle (issue #83, design in #76): the provisioner and deleter state machines
 * and the step Lambda they call. The foundation's EC2 values arrive as stack parameters (the release
 * and `agentx deploy` pass them from the foundation's outputs), so the control plane takes no
 * cross-stack export on the manually deployed foundation.
 */
export class SessionLifecycle extends Construct {
  readonly provisioner: sfn.StateMachine;
  readonly deleter: sfn.StateMachine;
  readonly steps: lambda.Function;
  private readonly naming: AgentXNaming;

  constructor(scope: Construct, id: string, props: SessionLifecycleProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { naming } = props;
    this.naming = naming;
    // Parameter ids match the foundation outputs they are filled from.
    const parameter = (name: string, description: string) => new CfnParameter(stack, name, { type: "String", description });
    const privateSubnetIds = parameter("PrivateSubnetIds", "Comma-separated private subnet IDs of the foundation VPC");
    const sessionManagerSecurityGroupId = parameter("SessionManagerSecurityGroupId", "The foundation's session manager security group");
    const workspaceKmsKeyArn = parameter("WorkspaceKmsKeyArn", "The foundation's workspace volume KMS key");
    const instanceRoleArn = parameter("Ec2WorkerInstanceRoleArn", "The EC2 workers' instance role");
    const launchTemplateId = parameter("Ec2WorkerLaunchTemplateId", "The EC2 workers' launch template");

    const settingParameterArns = Object.values(WORKER_SETTING_PARAMETERS).map((name) =>
      `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${naming.ec2.workerSettingsPrefix}${name}`);
    this.steps = packagedFunction(this, "Steps", "packages/broker/src/aws/session-steps.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      WORKER_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
      INVOKE_SIGNING_KEY_ARN: props.invokeSigningKey.keyArn,
      WORKER_LOG_GROUP_NAME: naming.ec2.workerLogGroupName,
    }, Duration.seconds(30), [[resolve(process.cwd(), "packages/worker/ec2/boot.sh"), "boot.sh"]]);
    // In the private subnets with the session manager's group: the only way to reach a worker's /ping.
    (this.steps.node.defaultChild as lambda.CfnFunction).vpcConfig = {
      subnetIds: Fn.split(",", privateSubnetIds.valueAsString),
      securityGroupIds: [sessionManagerSecurityGroupId.valueAsString],
    };
    this.steps.role!.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));
    props.state.grantReadWriteData(this.steps);
    this.steps.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: settingParameterArns }));
    this.steps.addToRolePolicy(new iam.PolicyStatement({ actions: ["kms:GetPublicKey"], resources: [props.invokeSigningKey.keyArn] }));

    const definitionProps = {
      stepsFunctionArn: this.steps.functionArn,
      workspaceKeyArn: workspaceKmsKeyArn.valueAsString,
      environmentTag: naming.environmentTagValue,
      resourcePrefix: naming.resourcePrefix,
    };
    const ec2Arn = (resource: string) => `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;
    // Only instances and volumes this environment's session lifecycle created.
    const ownResources = { StringEquals: { "aws:ResourceTag/DeploymentMode": "ec2-ebs", "aws:ResourceTag/Environment": naming.environmentTagValue } };

    this.provisioner = this.stateMachine("Provisioner", provisionerDefinition(definitionProps), Duration.minutes(45), props.notifyOperator, [
      new iam.PolicyStatement({
        sid: "CreateWorkspaceVolume",
        actions: ["ec2:CreateVolume"],
        resources: [ec2Arn("volume/*")],
        conditions: { StringEquals: { "aws:RequestTag/DeploymentMode": "ec2-ebs", "aws:RequestTag/Environment": naming.environmentTagValue } },
      }),
      new iam.PolicyStatement({
        sid: "TagOnCreate",
        actions: ["ec2:CreateTags"],
        resources: [ec2Arn("volume/*"), ec2Arn("instance/*")],
        conditions: { StringEquals: { "ec2:CreateAction": ["CreateVolume", "RunInstances"] } },
      }),
      new iam.PolicyStatement({
        sid: "LaunchFromTemplate",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("instance/*")],
        conditions: { ArnEquals: { "ec2:LaunchTemplate": ec2Arn(`launch-template/${launchTemplateId.valueAsString}`) } },
      }),
      new iam.PolicyStatement({
        sid: "LaunchResources",
        actions: ["ec2:RunInstances"],
        resources: [
          ec2Arn(`launch-template/${launchTemplateId.valueAsString}`),
          ec2Arn("subnet/*"), ec2Arn("security-group/*"), ec2Arn("network-interface/*"), ec2Arn("volume/*"),
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::image/*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "ResolveWorkerAmi",
        actions: ["ssm:GetParameters", "ssm:GetParameter"],
        resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}::parameter${EC2_WORKER_AMI_PARAMETER}`],
      }),
      new iam.PolicyStatement({
        sid: "PassInstanceRole",
        actions: ["iam:PassRole"],
        resources: [instanceRoleArn.valueAsString],
        conditions: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }),
      new iam.PolicyStatement({
        sid: "AttachAndTerminateOwn",
        actions: ["ec2:AttachVolume", "ec2:TerminateInstances"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*")],
        conditions: ownResources,
      }),
      // EBS encrypts the root and workspace volumes with the foundation's key on the caller's behalf.
      new iam.PolicyStatement({
        sid: "EncryptVolumes",
        actions: ["kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*"],
        resources: [workspaceKmsKeyArn.valueAsString],
      }),
    ]);
    this.deleter = this.stateMachine("Deleter", deleterDefinition(definitionProps), Duration.minutes(30), props.notifyOperator, [
      new iam.PolicyStatement({
        sid: "DeleteOwn",
        actions: ["ec2:TerminateInstances", "ec2:DeleteVolume"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*")],
        conditions: ownResources,
      }),
    ]);

    new CfnOutput(stack, "SessionProvisionerArn", { value: this.provisioner.stateMachineArn });
    new CfnOutput(stack, "SessionDeleterArn", { value: this.deleter.stateMachineArn });
  }

  private stateMachine(
    id: string,
    definition: object,
    timeout: Duration,
    notifyOperator: cloudwatchActions.SnsAction,
    statements: iam.PolicyStatement[],
  ): sfn.StateMachine {
    const stack = Stack.of(this);
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
      description: `AgentX EC2 session ${id.toLowerCase()}`,
    });
    for (const statement of statements) role.addToPolicy(statement);
    role.addToPolicy(new iam.PolicyStatement({ sid: "Describe", actions: ["ec2:DescribeVolumes", "ec2:DescribeInstances"], resources: ["*"] }));
    this.steps.grantInvoke(role);
    const machine = new sfn.StateMachine(this, id, {
      definitionBody: sfn.DefinitionBody.fromString(stack.toJsonString(definition)),
      role,
      timeout,
      logs: {
        destination: new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
    // Failed provisioning also marks the session FAILED, but the operator should know; a failed
    // deletion leaves a session DELETING and possibly a volume behind.
    new cloudwatch.Alarm(this, `${id}FailuresAlarm`, {
      alarmName: this.naming.alarmName(`Session${id}Failures`),
      alarmDescription: `An EC2 session ${id.toLowerCase()} execution failed or timed out. Open its execution in Step Functions for the failing step.`,
      metric: new cloudwatch.MathExpression({
        expression: "FILL(failed, 0) + FILL(timedOut, 0)",
        usingMetrics: { failed: machine.metricFailed({ period: Duration.minutes(5) }), timedOut: machine.metricTimedOut({ period: Duration.minutes(5) }) },
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    return machine;
  }
}
