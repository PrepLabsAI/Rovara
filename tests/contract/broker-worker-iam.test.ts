import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// Captured on the assigned base before L1c implementation. No git-history reads in CI.
it("keeps the broker IAM statement tuples byte-identical to the base", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "L1cControlPlane", { naming: environmentNaming("staging") })).toJSON() as {
    Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  };
  const broker = Object.entries(template.Resources).find(([id, value]) => id.startsWith("Broker") && value.Type === "AWS::Lambda::Function")![1];
  const roleId = (broker.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
  const role = template.Resources[roleId]!;
  expect(role.Properties.Policies).toBeUndefined();
  expect(role.Properties.ManagedPolicyArns).toEqual([{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]] }]);
  const statements = Object.values(template.Resources)
    .filter((value) => value.Type === "AWS::IAM::Policy" && JSON.stringify(value.Properties.Roles).includes(`"${roleId}"`))
    .flatMap((value) => (value.Properties.PolicyDocument as { Statement: unknown[] }).Statement);
  expect(statements.length).toBeGreaterThan(0);
  // Keep duplicates too: any new action, condition, resource or repeated statement changes these bytes.
  expect(statements.map((statement) => JSON.stringify(statement)).sort()).toMatchSnapshot();
});
