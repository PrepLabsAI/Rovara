import {
  CfnOutput,
  type CfnTag,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_bedrockagentcore as agentcore,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  AGENTCORE_INSTANCES_REGIONS,
  AGENTX_WORKSPACE_VOLUME,
} from "./agent-runtime.js";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export const AGENTX_PRODUCTION_DEPLOYMENT_MODE = "instances-ebs";
export const AGENTX_PRODUCTION_VPC_CIDR = "10.42.0.0/16";
export const AGENTX_PRODUCTION_INSTANCE_TYPE = "m6g.medium";
export const AGENTX_PRODUCTION_OPERATING_SYSTEM = "LINUX_ARM64";

const DEFAULT_AZ_IDS: Readonly<Record<string, readonly [string, string]>> = {
  "us-east-1": ["use1-az1", "use1-az2"],
};

export interface ProductionFoundationConfiguration {
  region: string;
  availabilityZoneIds: readonly [string, string];
  providerIdleSeconds: number;
  providerMaxLifetimeSeconds: number;
  volumeSizeGiB: number;
  instanceType: string;
}

export interface ProductionFoundationStackProps extends StackProps {
  deploymentRegion: string;
  configuration?: Partial<Omit<ProductionFoundationConfiguration, "region">>;
  naming?: AgentXNaming;
}

export function defaultProductionAvailabilityZoneIds(
  region: string,
): readonly [string, string] {
  const availabilityZoneIds = DEFAULT_AZ_IDS[region];
  if (!availabilityZoneIds) {
    throw new Error(
      `no verified AgentCore Instances availability-zone IDs are configured for ${region}`,
    );
  }
  return availabilityZoneIds;
}

export function validateProductionFoundationConfiguration(
  configuration: ProductionFoundationConfiguration,
): ProductionFoundationConfiguration {
  if (!AGENTCORE_INSTANCES_REGIONS.has(configuration.region)) {
    throw new Error(`AgentCore Instances is not supported in region ${configuration.region}`);
  }
  if (
    configuration.availabilityZoneIds.length !== 2 ||
    new Set(configuration.availabilityZoneIds).size !== 2 ||
    configuration.availabilityZoneIds.some((value) => !/^[a-z0-9-]+-az[0-9]+$/.test(value))
  ) {
    throw new Error("production requires two distinct availability-zone IDs");
  }
  if (
    !Number.isInteger(configuration.providerIdleSeconds) ||
    configuration.providerIdleSeconds < 60 ||
    configuration.providerIdleSeconds > 1_209_600 ||
    !Number.isInteger(configuration.providerMaxLifetimeSeconds) ||
    configuration.providerMaxLifetimeSeconds < 60 ||
    configuration.providerMaxLifetimeSeconds > 1_209_600
  ) {
    throw new Error("capacity provider lifecycle values must be integers from 60 through 1209600 seconds");
  }
  if (configuration.providerIdleSeconds > configuration.providerMaxLifetimeSeconds) {
    throw new Error("capacity provider idle timeout cannot exceed its maximum lifetime");
  }
  if (!Number.isInteger(configuration.volumeSizeGiB) || configuration.volumeSizeGiB < 1) {
    throw new Error("workspace volume size must be a positive GiB integer");
  }
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(configuration.instanceType)) {
    throw new Error("instance type is invalid");
  }
  return configuration;
}

export class ProductionFoundationStack extends Stack {
  readonly capacityProviderArn: string;

  constructor(scope: Construct, id: string, props: ProductionFoundationStackProps) {
    super(scope, id, props);
    const naming = props.naming ?? legacyNaming();
    const configuration = validateProductionFoundationConfiguration({
      region: props.deploymentRegion,
      availabilityZoneIds:
        props.configuration?.availabilityZoneIds ??
        defaultProductionAvailabilityZoneIds(props.deploymentRegion),
      providerIdleSeconds: props.configuration?.providerIdleSeconds ?? 300,
      providerMaxLifetimeSeconds:
        props.configuration?.providerMaxLifetimeSeconds ?? 1_209_600,
      volumeSizeGiB: props.configuration?.volumeSizeGiB ?? 20,
      instanceType: props.configuration?.instanceType ?? AGENTX_PRODUCTION_INSTANCE_TYPE,
    });

    const vpc = new ec2.CfnVPC(this, "Vpc", {
      cidrBlock: AGENTX_PRODUCTION_VPC_CIDR,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      instanceTenancy: "default",
      tags: resourceTags(naming.resourcePrefix, naming),
    });
    const internetGateway = new ec2.CfnInternetGateway(this, "InternetGateway", {
      tags: resourceTags(`${naming.resourcePrefix}-igw`, naming),
    });
    const gatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, "InternetGatewayAttachment", {
      internetGatewayId: internetGateway.ref,
      vpcId: vpc.ref,
    });

    const publicCidrs = ["10.42.0.0/20", "10.42.16.0/20"] as const;
    const privateCidrs = ["10.42.128.0/20", "10.42.144.0/20"] as const;
    const privateSubnets: ec2.CfnSubnet[] = [];
    const privateRouteTables: ec2.CfnRouteTable[] = [];
    const privateRoutes: ec2.CfnRoute[] = [];

    for (const index of [0, 1] as const) {
      const suffix = index + 1;
      const publicSubnet = new ec2.CfnSubnet(this, `PublicSubnet${suffix}`, {
        availabilityZoneId: configuration.availabilityZoneIds[index],
        cidrBlock: publicCidrs[index],
        mapPublicIpOnLaunch: false,
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-public-${suffix}`, naming),
      });
      const publicRouteTable = new ec2.CfnRouteTable(this, `PublicRouteTable${suffix}`, {
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-public-${suffix}`, naming),
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PublicAssociation${suffix}`, {
        routeTableId: publicRouteTable.ref,
        subnetId: publicSubnet.ref,
      });
      const publicRoute = new ec2.CfnRoute(this, `PublicDefaultRoute${suffix}`, {
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.ref,
        routeTableId: publicRouteTable.ref,
      });
      publicRoute.addResourceDependency(gatewayAttachment);

      const eip = new ec2.CfnEIP(this, `NatEip${suffix}`, { domain: "vpc" });
      eip.addResourceDependency(gatewayAttachment);
      const natGateway = new ec2.CfnNatGateway(this, `NatGateway${suffix}`, {
        allocationId: eip.attrAllocationId,
        connectivityType: "public",
        subnetId: publicSubnet.ref,
        tags: resourceTags(`${naming.resourcePrefix}-nat-${suffix}`, naming),
      });
      natGateway.addResourceDependency(publicRoute);

      const privateSubnet = new ec2.CfnSubnet(this, `PrivateSubnet${suffix}`, {
        availabilityZoneId: configuration.availabilityZoneIds[index],
        cidrBlock: privateCidrs[index],
        mapPublicIpOnLaunch: false,
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-private-${suffix}`, naming),
      });
      const privateRouteTable = new ec2.CfnRouteTable(this, `PrivateRouteTable${suffix}`, {
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-private-${suffix}`, naming),
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateAssociation${suffix}`, {
        routeTableId: privateRouteTable.ref,
        subnetId: privateSubnet.ref,
      });
      const privateRoute = new ec2.CfnRoute(this, `PrivateDefaultRoute${suffix}`, {
        destinationCidrBlock: "0.0.0.0/0",
        natGatewayId: natGateway.ref,
        routeTableId: privateRouteTable.ref,
      });
      privateRoute.addResourceDependency(natGateway);
      privateSubnets.push(privateSubnet);
      privateRouteTables.push(privateRouteTable);
      privateRoutes.push(privateRoute);
    }

    new ec2.CfnVPCEndpoint(this, "S3GatewayEndpoint", {
      serviceName: `com.amazonaws.${props.deploymentRegion}.s3`,
      vpcEndpointType: "Gateway",
      vpcId: vpc.ref,
      routeTableIds: privateRouteTables.map((routeTable) => routeTable.ref),
    });

    const workerSecurityGroup = new ec2.CfnSecurityGroup(this, "WorkerSecurityGroup", {
      groupDescription: "AgentX production workers: no ingress and HTTPS-only egress",
      groupName: naming.workerSecurityGroupName,
      securityGroupEgress: [
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIp: "0.0.0.0/0",
          description: "HTTPS to Git providers, package registries, AWS APIs, and documentation",
        },
      ],
      tags: resourceTags(naming.workerSecurityGroupName, naming),
      vpcId: vpc.ref,
    });

    const flowLogGroup = new logs.LogGroup(this, "VpcFlowLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const flowLogRole = new iam.Role(this, "VpcFlowLogRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
      description: "Delivers AgentX production VPC flow logs to CloudWatch Logs",
    });
    flowLogGroup.grantWrite(flowLogRole);
    new ec2.CfnFlowLog(this, "VpcFlowLog", {
      deliverLogsPermissionArn: flowLogRole.roleArn,
      logDestinationType: "cloud-watch-logs",
      logGroupName: flowLogGroup.logGroupName,
      maxAggregationInterval: 60,
      resourceId: vpc.ref,
      resourceType: "VPC",
      trafficType: "ALL",
    });

    const workspaceKey = new kms.Key(this, "WorkspaceKey", {
      alias: naming.workspaceKeyAlias,
      description: `Encrypts AgentX ${naming.environmentTagValue} root and per-session workspace EBS volumes`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const operatorRole = new iam.Role(this, "CapacityProviderOperatorRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${props.deploymentRegion}:${this.account}:*`,
          },
        },
      }),
      description: "Allows AgentCore to operate the AgentX production capacity provider",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "BedrockAgentCoreRuntimeInstancesOperatorRolePolicy",
        ),
      ],
    });
    workspaceKey.grant(
      operatorRole,
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    );

    const capacityProvider = new agentcore.CfnCapacityProvider(
      this,
      "AgentXProductionCapacityProvider",
      {
        name: naming.capacityProviderName,
        description: "Stable AgentX production compute and per-session EBS workspace boundary",
        permissionsConfiguration: {
          capacityProviderOperatorRoleArn: operatorRole.roleArn,
        },
        computeConfiguration: {
          ec2Configuration: {
            launchTemplateSource: {
              launchParameters: {
                operatingSystem: AGENTX_PRODUCTION_OPERATING_SYSTEM,
                instanceRequirements: {
                  allowedInstanceTypes: [configuration.instanceType],
                },
                monitoring: "DETAILED",
                propagatedTags: {
                  Application: "AgentX",
                  DeploymentMode: AGENTX_PRODUCTION_DEPLOYMENT_MODE,
                  Environment: naming.environmentTagValue,
                },
              },
            },
            vpcConfiguration: {
              subnets: privateSubnets.map((subnet) => subnet.ref),
              securityGroups: [workerSecurityGroup.attrGroupId],
            },
            rootVolume: {
              encrypted: true,
              freeSpaceGiB: 30,
              kmsKeyId: workspaceKey.keyArn,
              volumeType: "gp3",
            },
            volumes: [
              {
                ebsConfiguration: {
                  name: AGENTX_WORKSPACE_VOLUME,
                  sizeGiB: configuration.volumeSizeGiB,
                  volumeType: "gp3",
                  encrypted: true,
                  kmsKeyId: workspaceKey.keyArn,
                },
              },
            ],
            lifecycleConfiguration: {
              idleInstanceTimeout: configuration.providerIdleSeconds,
              maxLifetime: configuration.providerMaxLifetimeSeconds,
            },
          },
        },
        tags: [
          { key: "Application", value: "AgentX" },
          { key: "DeploymentMode", value: AGENTX_PRODUCTION_DEPLOYMENT_MODE },
          { key: "Environment", value: naming.environmentTagValue },
        ],
      },
    );
    for (const privateRoute of privateRoutes) {
      capacityProvider.addResourceDependency(privateRoute);
    }
    capacityProvider.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.capacityProviderArn = capacityProvider.attrArn;
    new CfnOutput(this, "CapacityProviderArn", { value: this.capacityProviderArn });
    new CfnOutput(this, "VpcId", { value: vpc.ref });
    new CfnOutput(this, "PrivateSubnetIds", {
      value: privateSubnets.map((subnet) => subnet.ref).join(","),
    });
    new CfnOutput(this, "WorkerSecurityGroupId", { value: workerSecurityGroup.attrGroupId });
    new CfnOutput(this, "WorkspaceKmsKeyArn", { value: workspaceKey.keyArn });
    new CfnOutput(this, "DeploymentMode", { value: AGENTX_PRODUCTION_DEPLOYMENT_MODE });
  }
}

function resourceTags(name: string, naming: AgentXNaming): CfnTag[] {
  return [
    { key: "Name", value: name },
    { key: "Application", value: "AgentX" },
    { key: "Environment", value: naming.environmentTagValue },
  ];
}
