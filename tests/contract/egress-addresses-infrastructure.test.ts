// L4-EGR (lead 4; designs-2026-11-17/static-egress-ip-design.md): Rovara's fixed outbound addresses. The foundation's NAT gateways already have one Elastic IP each; a named environment now
// keeps those two addresses forever (Retain, no logical-id change, no replacement), outputs them, and hands them to the broker. The VPC stays IPv4 only and no worker has a public address,
// so nothing leaves from any other address. Existing templates stay as they were (named-templates.test.ts and legacy-templates.test.ts pin everything else).
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { EGRESS_ADDRESSES_PARAMETER_PATTERN, EGRESS_ADDRESSES_VARIABLE, NAT_EGRESS_ADDRESSES_OUTPUT } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string; DependsOn?: string | string[] };
type TemplateJson = { Parameters?: Record<string, { Type: string; Default?: string; AllowedPattern?: string; MaxLength?: number }>; Resources: Record<string, Resource>; Outputs?: Record<string, { Value: unknown }> };
const stacksOf = (app: ReturnType<typeof buildAgentXApp>) => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const jsonOf = (stacks: Stack[], name: string): TemplateJson => Template.fromStack(stacks.find((stack) => stack.stackName === name)!).toJSON() as TemplateJson;
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

describe("the NAT gateways' Elastic IPs are Rovara's outbound addresses", () => {
  let foundation: TemplateJson;
  let controlPlane: TemplateJson;
  let legacyFoundation: TemplateJson;
  let legacyControlPlane: TemplateJson;

  beforeAll(() => {
    const staging = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
    foundation = jsonOf(staging, "agentx-staging-foundation");
    controlPlane = jsonOf(staging, "agentx-staging-control-plane");
    const legacy = stacksOf(buildAgentXApp());
    legacyFoundation = Template.fromStack(legacy.find((stack) => stack.node.id === "AgentXProductionFoundation")!).toJSON() as TemplateJson;
    legacyControlPlane = Template.fromStack(legacy.find((stack) => stack.node.id === "AgentXControlPlane")!).toJSON() as TemplateJson;
  }, 240_000);

  it("keeps both Elastic IPs when the stack is deleted or a resource is replaced, under the same logical ids, with nothing else changed", () => {
    const eips = ofType(foundation, "AWS::EC2::EIP");
    expect(eips.map(([id]) => id).sort()).toEqual(["NatEip1", "NatEip2"]);
    for (const [id, eip] of eips) {
      // A named environment's DeletionPolicy is RetainExceptOnCreate (infra/lib/retention.ts): a delete keeps it; only a failed FIRST create removes it.
      expect([id, eip.DeletionPolicy, eip.UpdateReplacePolicy]).toEqual([id, "RetainExceptOnCreate", "Retain"]);
      expect(eip.Properties).toMatchObject({ Domain: "vpc" });
      expect(Object.keys(eip.Properties).sort()).toEqual(["Domain", "Tags"]);
    }
    // Each NAT gateway still takes its own address by the same logical id (a new id would allocate a new address and drop the old one).
    const nats = ofType(foundation, "AWS::EC2::NatGateway");
    expect(nats.map(([id]) => id).sort()).toEqual(["NatGateway1", "NatGateway2"]);
    expect(Object.fromEntries(nats.map(([id, nat]) => [id, nat.Properties.AllocationId]))).toEqual({
      NatGateway1: { "Fn::GetAtt": ["NatEip1", "AllocationId"] },
      NatGateway2: { "Fn::GetAtt": ["NatEip2", "AllocationId"] },
    });
  });

  it("outputs both addresses, in zone order, under the name the control plane takes as a parameter", () => {
    expect(NAT_EGRESS_ADDRESSES_OUTPUT).toBe("NatEgressAddresses");
    expect(foundation.Outputs?.NatEgressAddresses).toStrictEqual({ Value: { "Fn::Join": [",", [{ "Fn::GetAtt": ["NatEip1", "PublicIp"] }, { "Fn::GetAtt": ["NatEip2", "PublicIp"] }]] } });
    // The existing outputs are still there, unchanged.
    expect(Object.keys(foundation.Outputs ?? {})).toEqual(expect.arrayContaining(["VpcId", "PrivateSubnetIds", "WorkspaceKmsKeyArn", "DeploymentMode", "ProjectAllowListId"]));
  });

  it("hands the control plane's broker the addresses through one parameter (empty by default), and nothing else gets them", () => {
    expect(controlPlane.Parameters?.NatEgressAddresses).toMatchObject({ Type: "String", Default: "", AllowedPattern: EGRESS_ADDRESSES_PARAMETER_PATTERN, MaxLength: 64 });
    const holders = Object.entries(controlPlane.Resources).filter(([, resource]) => JSON.stringify(resource.Properties).includes(EGRESS_ADDRESSES_VARIABLE));
    expect(holders.map(([id, resource]) => [id.replace(/[0-9A-F]{8}$/u, ""), resource.Type])).toEqual([["Broker", "AWS::Lambda::Function"]]);
    const variables = (holders[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables[EGRESS_ADDRESSES_VARIABLE]).toStrictEqual({ Ref: "NatEgressAddresses" });
    // Only the one parameter and the one variable: nothing else in the template mentions the addresses.
    expect(Object.entries(controlPlane.Resources).filter(([, resource]) => JSON.stringify(resource).includes("NatEgressAddresses")).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""))).toEqual(["Broker"]);
  });

  it("accepts nothing but an empty value or up to four comma-separated addresses", () => {
    const pattern = new RegExp(controlPlane.Parameters!.NatEgressAddresses!.AllowedPattern!, "u");
    for (const good of ["", "203.0.113.195", "203.0.113.195,198.51.100.187", "1.2.3.4,5.6.7.8,9.10.11.12,13.14.15.16"]) expect(pattern.test(good), good).toBe(true);
    for (const bad of [" ", "203.0.113.195, 198.51.100.187", "203.0.113", "203.0.113.256", "203.0.113.195,", ",203.0.113.195", "203.0.113.195;198.51.100.187", "a.b.c.d", "203.0.113.195\n", "1.2.3.4,5.6.7.8,9.10.11.12,13.14.15.16,17.18.19.20",
      "\"203.0.113.195\"", "0203.0.113.195", "203.0.113.195/32", "::1", "2001:db8::1"]) expect(pattern.test(bad), JSON.stringify(bad)).toBe(false);
    expect(controlPlane.Parameters!.NatEgressAddresses!.MaxLength).toBeGreaterThanOrEqual(4 * 15 + 3);
  });

  it("the legacy deployment retains the addresses too (RETAIN, arch ruling 2026-11-24: a released address is gone), with no output, no parameter, no variable", () => {
    const legacyEips = ofType(legacyFoundation, "AWS::EC2::EIP");
    expect(legacyEips.map(([id]) => id).sort()).toEqual(["NatEip1", "NatEip2"]);
    for (const [id, eip] of legacyEips) expect([id, eip.DeletionPolicy, eip.UpdateReplacePolicy]).toEqual([id, "Retain", "Retain"]);
    expect(legacyFoundation.Outputs).not.toHaveProperty("NatEgressAddresses");
    expect(legacyControlPlane.Parameters).not.toHaveProperty("NatEgressAddresses");
    expect(JSON.stringify(legacyControlPlane)).not.toContain(EGRESS_ADDRESSES_VARIABLE);
  });
});

describe("the VPC stays IPv4 only and no worker has a public address", () => {
  let foundation: TemplateJson;
  beforeAll(() => { foundation = jsonOf(stacksOf(buildAgentXApp({ agentxEnv: "staging" })), "agentx-staging-foundation"); }, 240_000);

  it("has no IPv6 block, no IPv6 route and no egress-only gateway (an IPv6 path would leave from an address we cannot fix and would skip the NAT)", () => {
    const text = JSON.stringify(foundation);
    expect(text).not.toMatch(/ipv6/iu);
    expect(text).not.toContain("::/0");
    expect(ofType(foundation, "AWS::EC2::EgressOnlyInternetGateway")).toEqual([]);
    expect(ofType(foundation, "AWS::EC2::VPCCidrBlock")).toEqual([]);
    for (const [id, vpc] of ofType(foundation, "AWS::EC2::VPC")) expect(Object.keys(vpc.Properties), id).not.toContain("Ipv6CidrBlock");
    expect(ofType(foundation, "AWS::EC2::VPC")).toHaveLength(1);
  });

  it("gives no subnet a public address on launch, and sends each private subnet's default route to its own NAT gateway (never to the internet gateway)", () => {
    const subnets = ofType(foundation, "AWS::EC2::Subnet");
    expect(subnets).toHaveLength(4);
    for (const [id, subnet] of subnets) expect([id, subnet.Properties.MapPublicIpOnLaunch], id).toEqual([id, false]);
    const routes = ofType(foundation, "AWS::EC2::Route");
    const privateRoutes = routes.filter(([id]) => id.startsWith("PrivateDefaultRoute"));
    expect(privateRoutes.map(([id]) => id).sort()).toEqual(["PrivateDefaultRoute1", "PrivateDefaultRoute2"]);
    for (const [id, route] of privateRoutes) {
      expect(route.Properties.DestinationCidrBlock, id).toBe("0.0.0.0/0");
      expect(route.Properties.NatGatewayId, id).toStrictEqual({ Ref: `NatGateway${id.slice(-1)}` });
      expect(route.Properties).not.toHaveProperty("GatewayId");
    }
    // Only the two public route tables reach the internet gateway.
    expect(routes.filter(([, route]) => "GatewayId" in route.Properties).map(([id]) => id).sort()).toEqual(["PublicDefaultRoute1", "PublicDefaultRoute2"]);
    // The NAT gateways sit in the public subnets, and exactly two exist, so exactly two addresses are published.
    expect(ofType(foundation, "AWS::EC2::NatGateway")).toHaveLength(2);
    expect(ofType(foundation, "AWS::EC2::EIP")).toHaveLength(2);
  });

  it("launches workers into the private subnets with no network interface block and no public IP setting", () => {
    const templates = ofType(foundation, "AWS::EC2::LaunchTemplate");
    expect(templates).toHaveLength(1);
    const data = templates[0]![1].Properties.LaunchTemplateData as Record<string, unknown>;
    expect(data).not.toHaveProperty("NetworkInterfaces");
    expect(JSON.stringify(data)).not.toMatch(/AssociatePublicIpAddress|AssociateCarrierIpAddress|Ipv6/u);
    // The workers' subnet pairs (the binding the broker launches into) name only the two private subnets, never a public one.
    const pairs = JSON.stringify(foundation.Outputs?.Ec2WorkerSubnets);
    expect([...pairs.matchAll(/"Ref":"([A-Za-z0-9]+)"/gu)].map((match) => match[1]).sort()).toEqual(["PrivateSubnet1", "PrivateSubnet2"]);
    expect(pairs).not.toContain("PublicSubnet");
    // No instance, Elastic IP association or other address is allocated to a worker anywhere in the foundation.
    expect(ofType(foundation, "AWS::EC2::Instance")).toEqual([]);
    expect(ofType(foundation, "AWS::EC2::EIPAssociation")).toEqual([]);
  });
});
