import {
  Aws,
  CfnOutput,
  type CfnTag,
  Fn,
  RemovalPolicy,
  Validations,
  aws_ec2 as ec2,
  aws_iam as iam,
  type aws_kms as kms,
  aws_logs as logs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { environmentRolePath } from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";

/** The worker's HTTP port: /ping for health probes, /invocations for signed work (#80). */
export const EC2_WORKER_PORT = 8080;
/** Amazon Linux 2023 for arm64, resolved when each instance launches. The boot script installs Docker. */
export const EC2_WORKER_AMI_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
/** Holds the OS, Docker and the worker image; the workspace lives on its own volume. */
export const EC2_WORKER_ROOT_VOLUME_GIB = 30;

export interface Ec2WorkerFoundationProps {
  naming: AgentXNaming;
  /** The named environment; production has no EC2 workers until the cutover. */
  env: string;
  vpcId: string;
  privateSubnets: readonly ec2.CfnSubnet[];
  workspaceKey: kms.IKey;
  instanceType: string;
}

/**
 * What self-managed EC2 workers need from the foundation (issue #82, design in #76): the launch
 * template, the instance role, the worker security group and the security groups of the two
 * callers allowed to reach it, and the worker log group. Instances are launched by the session
 * provisioner (#83), which passes the subnet and the boot script as user data per launch.
 */
export class Ec2WorkerFoundation extends Construct {
  readonly workerSecurityGroup: ec2.CfnSecurityGroup;
  readonly dispatcherSecurityGroup: ec2.CfnSecurityGroup;
  readonly sessionManagerSecurityGroup: ec2.CfnSecurityGroup;
  readonly launchTemplate: ec2.CfnLaunchTemplate;
  readonly instanceRole: iam.Role;

  constructor(scope: Construct, id: string, props: Ec2WorkerFoundationProps) {
    super(scope, id);
    const { naming } = props;
    const names = naming.ec2;
    const tags = (name: string): CfnTag[] => [
      { key: "Name", value: name },
      { key: "Application", value: "AgentX" },
      { key: "DeploymentMode", value: "ec2-ebs" },
      { key: "Environment", value: naming.environmentTagValue },
    ];

    // Workers take no ingress but the worker port, and only from the two callers below.
    this.workerSecurityGroup = new ec2.CfnSecurityGroup(this, "WorkerSecurityGroup", {
      groupDescription: `AgentX EC2 workers: port ${EC2_WORKER_PORT} from the dispatcher and session manager only, HTTPS egress`,
      groupName: names.workerSecurityGroupName,
      securityGroupEgress: [httpsEgress("HTTPS to ECR, Bedrock, CloudWatch, the control plane, package repositories and Git providers")],
      tags: tags(names.workerSecurityGroupName),
      vpcId: props.vpcId,
    });
    // The dispatcher (#84) posts signed invocations; the session manager's Lambdas (#83, #85, #86) probe /ping.
    this.dispatcherSecurityGroup = this.callerSecurityGroup("DispatcherSecurityGroup", names.dispatcherSecurityGroupName,
      "AgentX dispatcher: signed invocations to EC2 workers, HTTPS to AWS APIs", props.vpcId, tags);
    this.sessionManagerSecurityGroup = this.callerSecurityGroup("SessionManagerSecurityGroup", names.sessionManagerSecurityGroupName,
      "AgentX session manager Lambdas: health probes to EC2 workers, HTTPS to AWS APIs", props.vpcId, tags);

    const logGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: names.workerLogGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Today's AgentCore runtime execution role, minus AgentCore: pull the worker image, call
    // Bedrock models, write container logs.
    this.instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
      description: `AgentX ${naming.environmentTagValue} EC2 worker instances`,
    });
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrImageAccess",
      actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      resources: [`arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/*`],
    }));
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrTokenAccess",
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }));
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrPullThroughCache",
      actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchImportUpstreamImage", "ecr:CreateRepository"],
      resources: [`arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${naming.pullThroughPrefix}/*`],
    }));
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "BedrockModelInvocation",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${Aws.PARTITION}:bedrock:*::foundation-model/*`,
        `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:*`,
      ],
    }));
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "WorkerLogs",
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
    }));
    const instanceProfile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      path: environmentRolePath(props.env),
      roles: [this.instanceRole.roleName],
    });

    this.launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: names.launchTemplateName,
      launchTemplateData: {
        imageId: `resolve:ssm:${EC2_WORKER_AMI_PARAMETER}`,
        instanceType: props.instanceType,
        iamInstanceProfile: { arn: instanceProfile.attrArn },
        securityGroupIds: [this.workerSecurityGroup.attrGroupId],
        // IMDSv2 only, one hop: the worker container shares the host network, so it still reaches
        // the instance role; anything behind another network hop does not.
        metadataOptions: {
          httpEndpoint: "enabled",
          httpTokens: "required",
          httpPutResponseHopLimit: 1,
          instanceMetadataTags: "disabled",
        },
        blockDeviceMappings: [{
          deviceName: "/dev/xvda",
          ebs: {
            volumeSize: EC2_WORKER_ROOT_VOLUME_GIB,
            volumeType: "gp3",
            encrypted: true,
            kmsKeyId: props.workspaceKey.keyArn,
            deleteOnTermination: true,
          },
        }],
        monitoring: { enabled: true },
        // Idle stop terminates the instance (the workspace lives on its own volume), so a shutdown
        // from inside must not leave a stopped instance behind.
        instanceInitiatedShutdownBehavior: "terminate",
        tagSpecifications: [
          { resourceType: "instance", tags: tags(`${naming.resourcePrefix}-worker`) },
          { resourceType: "volume", tags: tags(`${naming.resourcePrefix}-worker-root`) },
        ],
      },
      tagSpecifications: [{ resourceType: "launch-template", tags: tags(names.launchTemplateName) }],
    });

    Validations.of(this.launchTemplate).acknowledge({
      id: "CloudFormation-Validate::E1152",
      reason: "EC2 resolves a resolve:ssm: image ID when each instance launches, so the AMI stays current",
    });

    new CfnOutput(scope, "Ec2WorkerLaunchTemplateId", { value: this.launchTemplate.ref });
    new CfnOutput(scope, "Ec2WorkerSecurityGroupId", { value: this.workerSecurityGroup.attrGroupId });
    new CfnOutput(scope, "DispatcherSecurityGroupId", { value: this.dispatcherSecurityGroup.attrGroupId });
    new CfnOutput(scope, "SessionManagerSecurityGroupId", { value: this.sessionManagerSecurityGroup.attrGroupId });
    new CfnOutput(scope, "Ec2WorkerInstanceRoleArn", { value: this.instanceRole.roleArn });
    new CfnOutput(scope, "Ec2WorkerInstanceProfileArn", { value: instanceProfile.attrArn });
    new CfnOutput(scope, "Ec2WorkerLogGroupName", { value: logGroup.logGroupName });
    // availabilityZone=subnetId pairs, as an ec2-ebs runtime binding lists them.
    new CfnOutput(scope, "Ec2WorkerSubnets", {
      value: Fn.join(",", props.privateSubnets.map((subnet) => Fn.join("=", [subnet.attrAvailabilityZone, subnet.ref]))),
    });
  }

  private callerSecurityGroup(
    id: string,
    name: string,
    description: string,
    vpcId: string,
    tags: (name: string) => CfnTag[],
  ): ec2.CfnSecurityGroup {
    const group = new ec2.CfnSecurityGroup(this, id, {
      groupDescription: description,
      groupName: name,
      securityGroupEgress: [httpsEgress("HTTPS to DynamoDB, SQS, KMS, EC2 and Step Functions APIs")],
      tags: tags(name),
      vpcId,
    });
    // Separate rule resources, so neither group's definition refers to the other.
    new ec2.CfnSecurityGroupEgress(this, `${id}ToWorkers`, {
      groupId: group.attrGroupId,
      ipProtocol: "tcp",
      fromPort: EC2_WORKER_PORT,
      toPort: EC2_WORKER_PORT,
      destinationSecurityGroupId: this.workerSecurityGroup.attrGroupId,
      description: `Worker port ${EC2_WORKER_PORT}`,
    });
    new ec2.CfnSecurityGroupIngress(this, `WorkersFrom${id}`, {
      groupId: this.workerSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: EC2_WORKER_PORT,
      toPort: EC2_WORKER_PORT,
      sourceSecurityGroupId: group.attrGroupId,
      description: `Worker port ${EC2_WORKER_PORT} from ${name}`,
    });
    return group;
  }
}

function httpsEgress(description: string): ec2.CfnSecurityGroup.EgressProperty {
  return { ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0", description };
}
