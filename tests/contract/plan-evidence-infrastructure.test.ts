// Spec 061 (slice 1.1, task 5): the PlanEvidence function reads a plan's cited code in the background. It exists in named
// environments only (developer tasks do), holds the narrowest grants the broker's own patterns allow, and the broker may start it.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Role: { "Fn::GetAtt": [string, string] }; Timeout: number; MemorySize: number; Runtime: string; Environment?: { Variables?: Record<string, unknown> } } };

const functionNamed = (template: Template, prefix: string) => Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>).find(([id]) => id.startsWith(prefix));
const statementsOf = (template: Template, [, fn]: [string, LambdaFunction]) => {
  const roleId = fn.Properties.Role["Fn::GetAtt"][0];
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
};
const actionsOf = (statement: Statement) => [statement.Action].flat();
const leadingKeys = (statement: Statement) => ((statement.Condition as Record<string, Record<string, string[]>>)["ForAllValues:StringLike"]!)["dynamodb:LeadingKeys"];

describe("the PlanEvidence function's infrastructure", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "PlanEvidenceControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "PlanEvidenceLegacyControlPlane"));
  const planEvidence = functionNamed(named, "PlanEvidence")!;
  const broker = functionNamed(named, "Broker")!;

  it("is a Node 22 function with 150 seconds and 1,024 MB, with only what it reads from the environment", () => {
    expect(planEvidence).toBeDefined();
    expect(planEvidence[1].Properties).toMatchObject({ Timeout: 150, MemorySize: 1024, Runtime: "nodejs22.x" });
    expect(Object.keys(planEvidence[1].Properties.Environment?.Variables ?? {}).sort()).toEqual(
      ["ARTIFACT_BUCKET_NAME", "GITHUB_APP_CREDENTIAL_REF", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_SECRET_ARN", "STATE_TABLE_NAME"]);
  });

  it("reads the task, its evidence pointer, the job rows and the project revision; puts only DEVTASK# items; claims and closes only job rows", () => {
    const dynamo = statementsOf(named, planEvidence).filter((statement) => actionsOf(statement).some((action) => action.startsWith("dynamodb:")));
    const bySid: Record<string, Statement> = Object.fromEntries(dynamo.map((statement) => [statement.Sid ?? "", statement]));
    expect(Object.keys(bySid).sort()).toEqual(["ClaimAndCloseJobRow", "PutEvidencePointer", "ReadTaskJobAndProject"]);
    expect(actionsOf(bySid.ReadTaskJobAndProject!)).toEqual(["dynamodb:GetItem"]);
    expect(leadingKeys(bySid.ReadTaskJobAndProject!)).toEqual(["DEVTASK#*", "PLAN_EVIDENCE", "PROJECT#*"]);
    expect(actionsOf(bySid.PutEvidencePointer!)).toEqual(["dynamodb:PutItem"]);
    expect(leadingKeys(bySid.PutEvidencePointer!)).toEqual(["DEVTASK#*"]);
    expect(actionsOf(bySid.ClaimAndCloseJobRow!)).toEqual(["dynamodb:UpdateItem", "dynamodb:DeleteItem"]);
    expect(leadingKeys(bySid.ClaimAndCloseJobRow!)).toEqual(["PLAN_EVIDENCE"]);
    // The table itself, never its indexes: the sweep that queries the due-time index runs in the broker.
    for (const statement of dynamo) expect(JSON.stringify(statement.Resource)).not.toContain("/index/");
  });

  it("reads S3 under private/ and writes only under private/*/plan-documents/, and reads the GitHub App's secret", () => {
    const statements = statementsOf(named, planEvidence);
    const s3 = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("s3:")));
    expect(s3.map((statement) => [statement.Sid, actionsOf(statement)])).toEqual([["ReadPlanDocuments", ["s3:GetObject"]], ["WriteEvidenceBundles", ["s3:PutObject"]]]);
    expect(JSON.stringify(s3[0]!.Resource)).toContain("/private/*");
    // Only the evidence bundles (`<artifactId>.evidence.<digest>.json`), never the plan document beside them.
    expect(JSON.stringify(s3[1]!.Resource)).toContain("/private/*/plan-documents/*.evidence.*.json");
    const secret = statements.filter((statement) => actionsOf(statement).includes("secretsmanager:GetSecretValue"));
    expect(secret).toHaveLength(1);
    expect(secret[0]!.Resource).toEqual({ Ref: "GitHubAppPrivateKeySecretArn" });
  });

  it("holds no other grant: nothing but the listed actions, no wildcard action, no Query, no Scan, no invoke", () => {
    const actions = statementsOf(named, planEvidence).flatMap(actionsOf).filter((action) => !action.startsWith("xray:") && !action.startsWith("logs:"));
    expect([...new Set(actions)].sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "s3:GetObject", "s3:PutObject", "secretsmanager:GetSecretValue"]);
    for (const statement of statementsOf(named, planEvidence)) expect(statement.Effect).toBe("Allow");
  });

  it("lets the broker start it, and tells the broker its name", () => {
    const statements = statementsOf(named, broker);
    const invoke = statements.filter((statement) => actionsOf(statement).includes("lambda:InvokeFunction") && JSON.stringify(statement.Resource).includes(planEvidence[0]));
    expect(invoke).toHaveLength(1);
    expect(broker[1].Properties.Environment?.Variables).toMatchObject({ PLAN_EVIDENCE_FUNCTION_NAME: { Ref: planEvidence[0] } });
    // Nothing else may start it: no other role in the stack names it in an invoke grant.
    const grants = (Object.values(named.findResources("AWS::IAM::Policy")) as Policy[])
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(planEvidence[0]) && JSON.stringify(policy.Properties.PolicyDocument).includes("lambda:InvokeFunction"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.Properties.Roles).toEqual([{ Ref: broker[1].Properties.Role["Fn::GetAtt"][0] }]);
  });

  it("adds nothing to the legacy templates: developer tasks do not exist there", () => {
    expect(functionNamed(legacy, "PlanEvidence")).toBeUndefined();
    expect(functionNamed(legacy, "Broker")![1].Properties.Environment?.Variables).not.toHaveProperty("PLAN_EVIDENCE_FUNCTION_NAME");
  });
});
