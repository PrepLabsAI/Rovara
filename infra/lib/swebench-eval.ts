// Spec 043 FR-016, FR-017: the optional SWE-bench eval stack. It holds everything a run launches:
// an x86 launch template, the eval instance role and security group, the runner log group, the
// state machine the broker starts per run, and the settings parameter the broker reads. It is not
// part of the foundation, so the foundation-drift check never sees it, and no release deploys it:
// an administrator deploys it with `-c agentxEval=enabled` (docs/swebench-eval.md).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Aws,
  CfnOutput,
  CfnParameter,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Validations,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_logs as logs,
  aws_ssm as ssm,
  aws_stepfunctions as sfn,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { SWEBENCH_SETTING_PARAMETERS, environmentRolePath } from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";
import { grantProviderKeySecrets } from "./model-keys.js";
import { SWEBENCH_DEPLOYMENT_MODE, SWEBENCH_RUN_TAG, swebenchEvalDefinition } from "./swebench-eval-definition.js";

/** Amazon Linux 2023 for x86: SWE-bench publishes x86 task images only. */
export const SWEBENCH_AMI_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";
export const SWEBENCH_INSTANCE_TYPE = "m7i.xlarge";
/** The runner image, a task image, the harness's fresh container and the run's files. */
export const SWEBENCH_ROOT_VOLUME_GIB = 150;

/** Names the control plane grants the broker access to before the eval stack exists. */
export function swebenchNames(naming: AgentXNaming) {
  return {
    stackName: naming.env === undefined ? "AgentXEval" : `agentx-${naming.env}-eval`,
    stateMachineName: `${naming.resourcePrefix}-swebench-eval`,
    logGroupName: naming.ec2.workerLogGroupName.replace(/\/worker$/, "/swebench"),
    settingsParameterName: `${naming.ec2.workerSettingsPrefix}${SWEBENCH_SETTING_PARAMETERS.settings}`,
    runnerImageParameterName: `${naming.ec2.workerSettingsPrefix}${SWEBENCH_SETTING_PARAMETERS.runnerImage}`,
    runnerFeaturesParameterName: `${naming.ec2.workerSettingsPrefix}${SWEBENCH_SETTING_PARAMETERS.runnerFeatures}`,
  };
}

export interface SwebenchEvalStackProps extends StackProps {
  naming: AgentXNaming;
}

export class SwebenchEvalStack extends Stack {
  constructor(scope: Construct, id: string, props: SwebenchEvalStackProps) {
    super(scope, id, props);
    const { naming } = props;
    const names = swebenchNames(naming);
    const parameter = (name: string, description: string) => new CfnParameter(this, name, { type: "String", description });
    const vpcId = parameter("VpcId", "The foundation VPC");
    const privateSubnetIds = new CfnParameter(this, "PrivateSubnetIds", { type: "CommaDelimitedList", description: "The foundation's private subnet IDs" });
    const controlPlaneUrl = parameter("ControlPlaneUrl", "The control plane's HTTPS URL, which the runner reports to");
    const artifactBucketName = parameter("ArtifactBucketName", "The control plane's artifact bucket, which holds evals/<run>/");
    const stateTableName = parameter("StateTableName", "The control plane's state table, which holds the run records");

    const tags = (name: string) => [
      { key: "Name", value: name },
      { key: "Application", value: "AgentX" },
      { key: "DeploymentMode", value: SWEBENCH_DEPLOYMENT_MODE },
      { key: "Environment", value: naming.environmentTagValue },
      ...(naming.env === undefined ? [] : [{ key: "agentx:env", value: naming.env }]),
    ];

    const logGroup = new logs.LogGroup(this, "RunnerLogs", {
      logGroupName: names.logGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // HTTPS only: ECR, Docker Hub, Hugging Face, PyPI, the model provider and the control plane.
    const securityGroup = new ec2.CfnSecurityGroup(this, "SecurityGroup", {
      groupDescription: "AgentX SWE-bench eval instances: no ingress, HTTPS egress",
      groupName: `${naming.resourcePrefix}-swebench-eval`,
      securityGroupEgress: [{ ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0", description: "HTTPS to registries, datasets, packages, the model provider and the control plane" }],
      tags: tags(`${naming.resourcePrefix}-swebench-eval`),
      vpcId: vpcId.valueAsString,
    });

    const bucketArn = `arn:${Aws.PARTITION}:s3:::${artifactBucketName.valueAsString}`;
    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
      description: `AgentX ${naming.environmentTagValue} SWE-bench eval instances`,
    });
    instanceRole.addToPolicy(new iam.PolicyStatement({ sid: "EcrToken", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrRunnerImage",
      actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      resources: [`arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/*`],
    }));
    // The run's launch file and artifacts, under evals/ only (FR-017).
    instanceRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadLaunchFile", actions: ["s3:GetObject"], resources: [`${bucketArn}/evals/*/launch.json`] }));
    instanceRole.addToPolicy(new iam.PolicyStatement({ sid: "WriteArtifacts", actions: ["s3:PutObject"], resources: [`${bucketArn}/evals/*`] }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "BedrockModelInvocation",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [`arn:${Aws.PARTITION}:bedrock:*::foundation-model/*`, `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:*`],
    }));
    // The worker settings' provider keys, when the deployment has them (same parameters as the runtime stack's).
    grantProviderKeySecrets(this, [instanceRole.roleName]);
    instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "RunnerLogs",
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
    }));
    const instanceProfile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      ...(naming.env === undefined ? {} : { path: environmentRolePath(naming.env) }),
      roles: [instanceRole.roleName],
    });

    const bootScript = readFileSync(resolve(process.cwd(), "packages/worker/ec2/swebench-boot.sh"), "utf8").replace(/^#!.*\n/, "");
    const launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: `${naming.resourcePrefix}-swebench-eval`,
      launchTemplateData: {
        imageId: `resolve:ssm:${SWEBENCH_AMI_PARAMETER}`,
        instanceType: SWEBENCH_INSTANCE_TYPE,
        iamInstanceProfile: { arn: instanceProfile.attrArn },
        securityGroupIds: [securityGroup.attrGroupId],
        // IMDSv2, one hop (the runner shares the host network), and tags, for the run ID.
        metadataOptions: { httpEndpoint: "enabled", httpTokens: "required", httpPutResponseHopLimit: 1, instanceMetadataTags: "enabled" },
        blockDeviceMappings: [{
          deviceName: "/dev/xvda",
          ebs: { volumeSize: SWEBENCH_ROOT_VOLUME_GIB, volumeType: "gp3", encrypted: true, deleteOnTermination: true },
        }],
        instanceInitiatedShutdownBehavior: "terminate",
        userData: Fn.base64(Fn.join("", [
          "#!/bin/bash\n# Rendered by the eval stack (infra/lib/swebench-eval.ts).\nexport AGENTX_ARTIFACT_BUCKET='",
          artifactBucketName.valueAsString,
          "'\n",
          bootScript,
        ])),
      },
      tagSpecifications: [{ resourceType: "launch-template", tags: tags(`${naming.resourcePrefix}-swebench-eval`) }],
    });
    Validations.of(launchTemplate).acknowledge({
      id: "CloudFormation-Validate::E1152",
      reason: "EC2 resolves a resolve:ssm: image ID when each instance launches, so the AMI stays current",
    });

    const ec2Arn = (resource: string) => `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;
    const tableArn = `arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${stateTableName.valueAsString}`;
    const machineRole = new iam.Role(this, "StateMachineRole", { assumedBy: new iam.ServicePrincipal("states.amazonaws.com") });
    const statements = [
      new iam.PolicyStatement({
        sid: "LaunchFromTemplate",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("instance/*")],
        conditions: { ArnEquals: { "ec2:LaunchTemplate": ec2Arn(`launch-template/${launchTemplate.ref}`) } },
      }),
      new iam.PolicyStatement({
        sid: "LaunchResources",
        actions: ["ec2:RunInstances"],
        resources: [
          ec2Arn(`launch-template/${launchTemplate.ref}`), ec2Arn("subnet/*"), ec2Arn("security-group/*"),
          ec2Arn("network-interface/*"), ec2Arn("volume/*"), `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::image/*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "TagOnCreate",
        actions: ["ec2:CreateTags"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*")],
        conditions: { StringEquals: { "ec2:CreateAction": "RunInstances" } },
      }),
      new iam.PolicyStatement({
        sid: "ResolveAmi",
        actions: ["ssm:GetParameters", "ssm:GetParameter"],
        resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}::parameter${SWEBENCH_AMI_PARAMETER}`],
      }),
      new iam.PolicyStatement({
        sid: "PassInstanceRole",
        actions: ["iam:PassRole"],
        resources: [instanceRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }),
      new iam.PolicyStatement({ sid: "DescribeInstances", actions: ["ec2:DescribeInstances"], resources: ["*"] }),
      new iam.PolicyStatement({
        sid: "TerminateOwn",
        actions: ["ec2:TerminateInstances"],
        resources: [ec2Arn("instance/*")],
        conditions: { StringEquals: { "aws:ResourceTag/DeploymentMode": SWEBENCH_DEPLOYMENT_MODE, "aws:ResourceTag/Environment": naming.environmentTagValue } },
      }),
      new iam.PolicyStatement({ sid: "RunRecords", actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], resources: [tableArn] }),
    ];
    for (const statement of statements) machineRole.addToPolicy(statement);

    const stateMachine = new sfn.CfnStateMachine(this, "StateMachine", {
      stateMachineName: names.stateMachineName,
      roleArn: machineRole.roleArn,
      definitionString: Stack.of(this).toJsonString(swebenchEvalDefinition({
        launchTemplateId: launchTemplate.ref,
        stateTableName: stateTableName.valueAsString,
        environmentTag: naming.environmentTagValue,
        ...(naming.env === undefined ? {} : { env: naming.env }),
        resourcePrefix: naming.resourcePrefix,
      })),
    });
    stateMachine.node.addDependency(machineRole);

    // What the broker reads per run (SwebenchSettingsSchema). The runner image parameter is written
    // by `npm run swebench:runner-image`, so a stack update never resets it.
    new ssm.CfnParameter(this, "Settings", {
      name: names.settingsParameterName,
      type: "String",
      description: "AgentX SWE-bench eval settings (spec 043), read by the broker",
      // Joined rather than Fn.toJsonString, which cannot hold a list parameter. Every value is an ARN,
      // subnet ID, URL or log group name, none of which contains a quote.
      value: Fn.join("", [
        "{\"stateMachineArn\":\"", stateMachine.attrArn,
        "\",\"subnetIds\":[\"", Fn.join("\",\"", privateSubnetIds.valueAsList),
        "\"],\"controlPlaneUrl\":\"", controlPlaneUrl.valueAsString,
        "\",\"logGroupName\":\"", logGroup.logGroupName, "\"}",
      ]),
    });

    new CfnOutput(this, "SwebenchStateMachineArn", { value: stateMachine.attrArn });
    new CfnOutput(this, "SwebenchLaunchTemplateId", { value: launchTemplate.ref });
    new CfnOutput(this, "SwebenchLogGroupName", { value: logGroup.logGroupName });
    new CfnOutput(this, "SwebenchRunTag", { value: SWEBENCH_RUN_TAG });
  }
}
