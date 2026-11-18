import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  type CfnTag,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { GCP_PACK_PARAMETER_DEFAULT, GCP_PACK_PARAMETER_VALUES, GCP_PACK_PULL_REGISTRY_HOSTS, NAT_EGRESS_ADDRESSES_OUTPUT, gcpPackPullsFromSource } from "@agentx/contracts";
import { AgentDnsFirewall, EGRESS_ALLOW_DOMAINS_CONTEXT_KEY, installAgentAllowDomains, parseExtraAllowDomains } from "./agent-dns-firewall.js";
import { EgressAlarms, alertsTopicFromName } from "./egress-alarms.js";
import { Ec2WorkerFoundation } from "./ec2-workers.js";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export const AGENTX_PRODUCTION_DEPLOYMENT_MODE = "ec2-ebs";
export const AGENTX_PRODUCTION_VPC_CIDR = "10.42.0.0/16";
export const AGENTX_PRODUCTION_INSTANCE_TYPE = "m6g.large";

const DEFAULT_AZ_IDS: Readonly<Record<string, readonly [string, string]>> = {
  "us-east-1": ["use1-az1", "use1-az2"],
  // The zones the live staging foundation's subnets use (agentx-staging-foundation, 2026-11-15).
  "us-west-2": ["usw2-az1", "usw2-az2"],
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
    const natGateways: Array<{ az: string; natGateway: ec2.CfnNatGateway }> = [];
    const natAddresses: ec2.CfnEIP[] = [];

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
      // L4-EGR: in a named environment the NAT gateways' Elastic IPs ARE Rovara's published outbound addresses (a customer allow-lists them), so a deleted stack or a replaced resource must never
      // release one: Retain sets DeletionPolicy and UpdateReplacePolicy (a named environment's DeletionPolicy becomes RetainExceptOnCreate, infra/lib/retention.ts). The logical ids (NatEip1, NatEip2) never change: a new id would allocate a new address and drop the old one.
      if (naming.env !== undefined) eip.applyRemovalPolicy(RemovalPolicy.RETAIN);
      natAddresses.push(eip);
      const natGateway = new ec2.CfnNatGateway(this, `NatGateway${suffix}`, {
        allocationId: eip.attrAllocationId,
        connectivityType: "public",
        subnetId: publicSubnet.ref,
        tags: resourceTags(`${naming.resourcePrefix}-nat-${suffix}`, naming),
      });
      natGateway.addResourceDependency(publicRoute);
      natGateways.push({ az: configuration.availabilityZoneIds[index], natGateway });

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

    // EC2 worker launch template, role and security groups.
    new Ec2WorkerFoundation(this, "Ec2Workers", {
      naming,
      vpcId: vpc.ref,
      privateSubnets,
      workspaceKey,
      instanceType: configuration.instanceType,
    });

    // Named environments: the machines in the VPC resolve only an allowlist, and unusual egress raises an alarm. The legacy production template stays as it is.
    if (naming.env !== undefined) {
      const baseAllowDomains = installAgentAllowDomains(props.deploymentRegion, Aws.ACCOUNT_ID);
      // L4-E8I (owner DEC 254zzz62): the GCP pack setting, the same parameter and values as the control plane's (`agentx config set testServices.gcpPack` sets both). Here it decides one thing: whether the worker hosts may resolve and
      // reach Google's two image registries to pull the pack's source-pulled image. Off (the default): nothing is added to the DNS firewall.
      const gcpPack = new CfnParameter(this, "TestServicesGcpPack", { type: "String", default: GCP_PACK_PARAMETER_DEFAULT, allowedValues: [...GCP_PACK_PARAMETER_VALUES], description: "GCP test services pack: off (the default), or the groups on (mirrored, pulled, bigquery), colon-separated" });
      const pullsFromSource = new CfnCondition(this, "GcpPackPullsFromSource", {
        expression: Fn.conditionOr(...GCP_PACK_PARAMETER_VALUES.filter((value) => gcpPackPullsFromSource(value)).map((value) => Fn.conditionEquals(gcpPack.valueAsString, value))),
      });
      const dnsFirewall = new AgentDnsFirewall(this, "AgentDnsFirewall", {
        env: naming.env,
        vpcId: vpc.ref,
        baseAllowDomains,
        extraAllowDomains: parseExtraAllowDomains(this.node.tryGetContext(EGRESS_ALLOW_DOMAINS_CONTEXT_KEY), baseAllowDomains),
        pullFromSource: { condition: pullsFromSource, hosts: GCP_PACK_PULL_REGISTRY_HOSTS },
      });
      // The project list's id, for whatever keeps the approved project domains on it (the template never owns its contents).
      new CfnOutput(this, "ProjectAllowListId", { value: dnsFirewall.projectAllowListId });
      new EgressAlarms(this, "EgressAlarms", {
        env: naming.env,
        resourcePrefix: naming.resourcePrefix,
        dnsFirewallLogGroup: dnsFirewall.logGroup,
        natGateways,
        alertsTopic: alertsTopicFromName(this, "OperatorAlerts", naming.alertsTopicName),
      });
    }

    new CfnOutput(this, "VpcId", { value: vpc.ref });
    new CfnOutput(this, "PrivateSubnetIds", {
      value: privateSubnets.map((subnet) => subnet.ref).join(","),
    });
    new CfnOutput(this, "WorkspaceKmsKeyArn", { value: workspaceKey.keyArn });
    new CfnOutput(this, "DeploymentMode", { value: AGENTX_PRODUCTION_DEPLOYMENT_MODE });
    // L4-EGR: the addresses workers and the session functions leave the VPC from (one per zone), for the control plane's parameter of the same name and the company settings line. IPv4 only: the VPC has
    // no IPv6 block and no egress-only gateway (tests/contract/egress-addresses-infrastructure.test.ts), so nothing leaves from another address.
    if (naming.env !== undefined) new CfnOutput(this, NAT_EGRESS_ADDRESSES_OUTPUT, { value: Fn.join(",", natAddresses.map((eip) => eip.attrPublicIp)) });
  }
}

function resourceTags(name: string, naming: AgentXNaming): CfnTag[] {
  return [
    { key: "Name", value: name },
    { key: "Application", value: "AgentX" },
    { key: "Environment", value: naming.environmentTagValue },
  ];
}
