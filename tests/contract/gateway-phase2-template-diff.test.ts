// The beta gate's comparison (scripts/gateway-phase2-template-diff.ts): the Code-made gateway template against the Cloud-made one. Planted differences must each be caught;
// the real run over both repositories' built trees is recorded in the pull request (it needs a Cloud checkout, which this public repository does not have).
import { describe, expect, it } from "vitest";
import { ADDED_OUTPUT, compareGatewayTemplates } from "../../scripts/gateway-phase2-template-diff.js";

const CODE = "c".repeat(40);
const cloud = {
  Parameters: { ImageDigest: { Type: "String" } },
  Conditions: { CDKMetadataAvailable: { "Fn::Equals": [1, 1] } },
  Resources: { Meter: { Type: "AWS::DynamoDB::GlobalTable", Properties: { Name: "m", Tags: [{ Key: "a", Value: "b" }] } }, ServeTask: { Type: "AWS::ECS::TaskDefinition", Properties: { Image: { Ref: "ImageDigest" } } } },
  Outputs: { ServiceArn: { Value: "arn" }, DeployedCloudSha: { Value: "d".repeat(40) } },
};
const code = (edit: (t: Record<string, Record<string, unknown>>) => void = () => undefined): unknown => {
  const t = structuredClone(cloud) as unknown as Record<string, Record<string, unknown>>;
  delete t.Outputs!.DeployedCloudSha;
  t.Outputs![ADDED_OUTPUT] = { Value: CODE };
  edit(t);
  return t;
};

describe("compareGatewayTemplates", () => {
  it("equal apart from DeployedCloudSha -> DeployedCodeSha: no failure, whatever the key order", () => {
    expect(compareGatewayTemplates(cloud, code(), CODE)).toMatchObject({ failures: [], resources: 2, outputsOnlyDifference: true });
    const reordered = { Outputs: (code() as typeof cloud).Outputs, Resources: { ServeTask: cloud.Resources.ServeTask, Meter: { Properties: { Tags: [{ Value: "b", Key: "a" }], Name: "m" }, Type: "AWS::DynamoDB::GlobalTable" } }, Conditions: cloud.Conditions, Parameters: cloud.Parameters };
    expect(compareGatewayTemplates(cloud, reordered, CODE).failures).toEqual([]);
  });

  it("catches a changed, added or removed resource, a changed parameter or condition, and a new section", () => {
    expect(compareGatewayTemplates(cloud, code((t) => { (t.Resources!.ServeTask as { Properties: unknown }).Properties = { Image: "x" }; }), CODE).failures).toEqual(["Resources: changed ServeTask"]);
    expect(compareGatewayTemplates(cloud, code((t) => { t.Resources!.New = { Type: "AWS::SNS::Topic" }; }), CODE).failures).toEqual(["Resources: added New"]);
    expect(compareGatewayTemplates(cloud, code((t) => { delete t.Resources!.Meter; }), CODE).failures).toEqual(["Resources: removed Meter"]);
    expect(compareGatewayTemplates(cloud, code((t) => { t.Parameters!.ImageDigest = { Type: "Number" }; }), CODE).failures).toEqual(["Parameters: changed ImageDigest"]);
    expect(compareGatewayTemplates(cloud, code((t) => { t.Conditions!.CDKMetadataAvailable = { "Fn::Equals": [1, 2] }; }), CODE).failures).toEqual(["Conditions: changed CDKMetadataAvailable"]);
    expect(compareGatewayTemplates(cloud, code((t) => { t.Rules = {}; }), CODE).failures).toEqual(["section Rules differs"]);
  });

  it("catches an output that goes (other than DeployedCloudSha), one that is new (other than DeployedCodeSha), one that changes, and a wrong or missing DeployedCodeSha", () => {
    expect(compareGatewayTemplates(cloud, code((t) => { delete t.Outputs!.ServiceArn; }), CODE).failures).toEqual(["Outputs: ServiceArn goes"]);
    expect(compareGatewayTemplates(cloud, code((t) => { t.Outputs!.Extra = { Value: "x" }; }), CODE).failures).toEqual(["Outputs: Extra is new"]);
    expect(compareGatewayTemplates(cloud, code((t) => { t.Outputs!.ServiceArn = { Value: "other" }; }), CODE).failures).toEqual(["Outputs: ServiceArn changes"]);
    expect(compareGatewayTemplates(cloud, code(), "e".repeat(40)).failures[0]).toMatch(/DeployedCodeSha is c+, not the Code commit e+/);
    expect(compareGatewayTemplates(cloud, code((t) => { delete t.Outputs![ADDED_OUTPUT]; }), CODE).failures[0]).toMatch(/DeployedCodeSha is undefined/);
    expect(compareGatewayTemplates(cloud, "x", CODE).failures).toEqual(["a template is not a JSON object"]);
  });
});
