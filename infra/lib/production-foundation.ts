import {
  CfnOutput,
  type CfnTag,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Ec2WorkerFoundation } from "./ec2-workers.js";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export const AGENTX_PRODUCTION_DEPLOYMENT_MODE = "ec2-ebs";
export const AGENTX_PRODUCTION_VPC_CIDR = "10.42.0.0/16";
export const AGENTX_PRODUCTION_INSTANCE_TYPE = "m6g.medium";

const DEFAULT_AZ_IDS: Readonly<Record<string, readonly [string, string]>> = {
  "us-east-1": ["use1-az1", "use1-az2"],
};

/**
 * The regions a release covers: exactly the regions with verified availability-zone IDs above. Adding a region means adding its verified zone IDs to
 * `DEFAULT_AZ_IDS`; nothing else changes.
 */
export const SUPPORTED_REGIONS: readonly string[] = Object.keys(DEFAULT_AZ_IDS).sort();

export interface ProductionFoundationConfiguration {
  region: string;
  availabilityZoneIds: readonly [string, string];
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
      `no verified availability-zone IDs are configured for ${region}`,
    );
  }
  return availabilityZoneIds;
}

export function validateProductionFoundationConfiguration(
  configuration: ProductionFoundationConfiguration,
): ProductionFoundationConfiguration {
  if (
    configuration.availabilityZoneIds.length !== 2 ||
    new Set(configuration.availabilityZoneIds).size !== 2 ||
    configuration.availabilityZoneIds.some((value) => !/^[a-z0-9-]+-az[0-9]+$/.test(value))
  ) {
    throw new Error("production requires two distinct availability-zone IDs");
  }
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(configuration.instanceType)) {
    throw new Error("instance type is invalid");
  }
  return configuration;
}

export class ProductionFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: ProductionFoundationStackProps) {
    super(scope, id, props);
    const naming = props.naming ?? legacyNaming();
    const configuration = validateProductionFoundationConfiguration({
      region: props.deploymentRegion,
      availabilityZoneIds:
        props.configuration?.availabilityZoneIds ??
        defaultProductionAvailabilityZoneIds(props.deploymentRegion),
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

    const flowLogGroup = new logs.LogGroup(this, "VpcFlowLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      // Retained: flow logs are audit data that must outlive a stack deletion.
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
      // Retained: retained workspace volumes and snapshots stay unreadable without this key.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The EC2 workers (#76). The AgentCore capacity provider, its operator role and its worker
    // security group were removed in #118.
    new Ec2WorkerFoundation(this, "Ec2Workers", {
      naming,
      vpcId: vpc.ref,
      privateSubnets,
      workspaceKey,
      instanceType: configuration.instanceType,
    });

    new CfnOutput(this, "VpcId", { value: vpc.ref });
    new CfnOutput(this, "PrivateSubnetIds", {
      value: privateSubnets.map((subnet) => subnet.ref).join(","),
    });
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
