import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { withoutBrokerNamesParameter } from "../support/broker-environment-template.js";
import { withoutCompanyImportReads } from "../support/company-import-reads-template.js";

skipLambdaBundling();

// Captured on the assigned base before L1c implementation. No git-history reads in CI.
it("keeps the broker IAM statement tuples byte-identical to the base", () => {
  // ENV-ROOM 2's IAM changes (the names parameter's ARN, two merged statements, two inert actions dropped) are checked exactly and taken out first: they are pinned in
  // broker-names-parameter-infrastructure.test.ts and the broker IAM headroom tests, and these bytes stay the base's.
  const template = withoutBrokerNamesParameter(withoutCompanyImportReads(Template.fromStack(new ControlPlaneStack(new App(), "L1cControlPlane", { naming: environmentNaming("staging") })).toJSON())) as {
    Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  };
  // DEC 254zzz32/35: Slack company mode's conditional broker policy (the company token family and the install's Slack secret, read-only) is asserted in full by
  // slack-company-workspaces-infrastructure.test.ts; its shape is checked here and it is taken out, so these bytes stay the base's.
  const slackBroker = Object.keys(template.Resources).filter((id) => /^SlackCompanyModeBroker[0-9A-F]{8}$/u.test(id));
  expect(slackBroker).toHaveLength(1);
  expect((template.Resources[slackBroker[0]!]!.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: unknown }> }).Statement.map((s) => [s.Sid, s.Action]))
    .toEqual([["ReadSlackWorkspaceTokens", "secretsmanager:GetSecretValue"], ["ReadInstallSlackToken", "secretsmanager:GetSecretValue"]]);
  delete template.Resources[slackBroker[0]!];
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
