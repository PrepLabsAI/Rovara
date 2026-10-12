import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type TemplateJson = {
  Parameters?: Record<string, Record<string, unknown>>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, { Type: string; Condition?: string; Properties?: Record<string, unknown> }>;
};

function namedTemplate(env: string, account = "944937319445", region = "us-east-1"): TemplateJson {
  const rendered: unknown = Template.fromStack(new ControlPlaneStack(new App(), `Proof-${env}-${account}-${region}`, {
    env: { account, region }, naming: environmentNaming(env),
  })).toJSON();
  return rendered as TemplateJson;
}

function proofEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([logicalId]) => logicalId.includes("TaskPersonProof"));
}

describe("the named TEST proof-only installation gate", () => {
  it("declares a distinct default-OFF gate only for the approved named environment", () => {
    const approved = namedTemplate("agentxlivetest123");
    const foreign = namedTemplate("staging", "123456789012");
    const wrongAccount = namedTemplate("agentxlivetest123", "123456789012");
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "Legacy")).toJSON() as TemplateJson;

    expect(approved.Parameters?.TaskPersonProofEnabled).toMatchObject({
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(proofEntries(approved).length).toBeGreaterThan(0);
    expect(approved.Parameters?.TaskPeopleChangesEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePublicInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePrivateInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(foreign.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(foreign)).toHaveLength(0);
    expect(wrongAccount.Parameters?.TaskPersonProofEnabled).toMatchObject({ Default: "false" });
    expect(proofEntries(wrongAccount).length).toBeGreaterThan(0);
    expect(legacy.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(legacy)).toHaveLength(0);
  });

  it("conditions the isolated proof resources on the switch, exact account and region", () => {
    const approved = namedTemplate("agentxlivetest123");
    const proofResources = proofEntries(approved);
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const condition = approved.Conditions?.[conditionId!];
    expect(JSON.stringify(condition)).toContain("TaskPersonProofEnabled");
    expect(JSON.stringify(condition)).toContain("944937319445");
    expect(JSON.stringify(condition)).toContain("us-east-1");
    expect(proofResources.map(([id]) => id)).toEqual(expect.arrayContaining([
      expect.stringContaining("Role"), expect.stringContaining("Function"), expect.stringContaining("Version"),
      expect.stringContaining("SecretReadPolicy"), expect.stringContaining("DispatcherPolicy"),
    ]));
    for (const [id, resource] of proofResources.filter(([, resource]) => resource.Type !== "AWS::CloudFormation::Condition")) {
      if (id.includes("Role") || id.includes("Function") || id.includes("Version") || id.includes("Policy")) {
        expect(resource.Condition).toBe(conditionId);
      }
    }
  });

  it("keeps the proof function and role free of unrelated runtime permissions", () => {
    const approved = namedTemplate("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const [functionId, proofFunction] = Object.entries(resources).find(([id, resource]) =>
      id.includes("TaskPersonProofFunction") && resource.Type === "AWS::Lambda::Function",
    )!;
    const properties = proofFunction.Properties!;
    expect(properties).toMatchObject({ MemorySize: 512, Timeout: 7 });
    expect(properties).not.toHaveProperty("TracingConfig");
    expect(properties).not.toHaveProperty("VpcConfig");
    const variables = (properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({ AGENTX_ENV: "agentxlivetest123" });
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ENV", "SLACK_SECRET_ARN", "SLACK_TEAM_ID"]);
    const roleId = ((properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(roleId).toContain("TaskPersonProofRole");
    const role = resources[roleId]!.Properties!;
    expect(role).not.toHaveProperty("ManagedPolicyArns");
    expect(JSON.stringify(role.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
    const rolePolicies = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy"
      && JSON.stringify(resource.Properties?.Roles).includes(roleId));
    expect(rolePolicies).toHaveLength(1);
    const statements = (rolePolicies[0]![1].Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"] });
    expect(JSON.stringify(statements[0]?.Resource)).toContain("SlackSecret");
    expect(JSON.stringify(proofFunction)).not.toMatch(/xray:|logs:|kms:|dynamodb:/);
    expect(functionId).toContain("TaskPersonProofFunction");
  });

  it("limits the dispatcher addition to projected Developer GetItem and the published proof version", () => {
    const approved = namedTemplate("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const policy = Object.entries(resources).find(([id, resource]) => id.includes("TaskPersonProofDispatcherPolicy") && resource.Type === "AWS::IAM::Policy")?.[1];
    expect(policy).toBeDefined();
    const statements = (policy!.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(2);
    const getItem = statements.find((statement) => JSON.stringify(statement.Action).includes("dynamodb:GetItem"));
    const invoke = statements.find((statement) => JSON.stringify(statement.Action).includes("lambda:InvokeFunction"));
    const dispatcher = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::Lambda::Function"
      && JSON.stringify(resource.Properties?.Environment).includes("TASK_PERSON_PROOF_FUNCTION_ARN"));
    expect(dispatcher).toBeDefined();
    const dispatcherRole = ((dispatcher![1].Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(policy!.Properties!.Roles).toEqual([{ Ref: dispatcherRole }]);
    const tableId = Object.keys(resources).find((id) => id.includes("DeveloperSignInTable"));
    expect(tableId).toBeDefined();
    expect(getItem).toEqual({
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [{ "Fn::GetAtt": [tableId, "Arn"] }],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName"] },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    });
    const versionId = Object.keys(resources).find((id) => JSON.stringify(invoke?.Resource).includes(id));
    expect(invoke).toEqual({ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [{ Ref: versionId }] });
    expect(versionId).toContain("TaskPersonProofFunctionCurrentVersion");
    expect(resources[versionId!]?.Type).toBe("AWS::Lambda::Version");
    expect(JSON.stringify(invoke?.Resource)).not.toContain("$LATEST");
    const variables = dispatcher![1].Properties!.Environment as { Variables: Record<string, unknown> };
    expect(Object.keys(variables.Variables).filter((key) => ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"].includes(key)).sort()).toEqual([
      "TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME",
    ].sort());
    expect(JSON.stringify(variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN)).toContain("TaskPersonProofFunctionCurrentVersion");
  });
});
