import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ProductionFoundationStack, SUPPORTED_REGIONS, defaultProductionAvailabilityZoneIds } from "../../infra/lib/production-foundation.js";
import { environmentNaming } from "../../infra/lib/naming.js";

describe("supported regions", () => {
  it("are exactly the regions with verified retired runtime availability-zone IDs", () => {
    expect(SUPPORTED_REGIONS).toEqual(["us-east-1", "us-west-2"]);
    for (const region of SUPPORTED_REGIONS) expect(defaultProductionAvailabilityZoneIds(region)).toHaveLength(2);
  });

  it("puts a us-west-2 foundation in the zones the live staging foundation uses", () => {
    expect(defaultProductionAvailabilityZoneIds("us-west-2")).toEqual(["usw2-az1", "usw2-az2"]);
    const template = Template.fromStack(new ProductionFoundationStack(new App(), "Usw2Foundation", {
      deploymentRegion: "us-west-2", naming: environmentNaming("staging"), env: { region: "us-west-2" },
    }));
    const subnets = template.findResources("AWS::EC2::Subnet") as Record<string, { Properties: { AvailabilityZoneId: string } }>;
    expect(Object.fromEntries(Object.entries(subnets).map(([id, subnet]) => [id, subnet.Properties.AvailabilityZoneId]))).toEqual({
      PublicSubnet1: "usw2-az1", PrivateSubnet1: "usw2-az1", PublicSubnet2: "usw2-az2", PrivateSubnet2: "usw2-az2",
    });
  });
});
