import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";

interface Statement { Effect?: string; Action?: string | string[]; NotAction?: string | string[]; Resource: unknown; Condition?: unknown }
interface PolicyDocument { Statement: Statement | Statement[] }

/** Secrets Manager actions that cannot change a secret; any other secretsmanager action, or a wildcard, counts as a write. */
const SECRETS_READ_ACTIONS = new Set([
  "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:ListSecrets", "secretsmanager:ListSecretVersionIds",
  "secretsmanager:BatchGetSecretValue", "secretsmanager:GetResourcePolicy", "secretsmanager:GetRandomPassword",
]);

/** Every IAM statement in a template: standalone and managed policies, and roles' inline policies. */
function statements(template: Template): Statement[] {
  const documents: PolicyDocument[] = [];
  for (const type of ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"]) {
    for (const resource of Object.values(template.findResources(type)) as Array<{ Properties?: { PolicyDocument?: PolicyDocument } }>) {
      if (resource.Properties?.PolicyDocument) documents.push(resource.Properties.PolicyDocument);
    }
  }
  for (const role of Object.values(template.findResources("AWS::IAM::Role")) as Array<{ Properties?: { Policies?: Array<{ PolicyDocument: PolicyDocument }> } }>) {
    for (const policy of role.Properties?.Policies ?? []) documents.push(policy.PolicyDocument);
  }
  return documents.flatMap((document) => [document.Statement].flat());
}

/** Whether an allowed action could write a secret: "*", any secretsmanager wildcard, or any secretsmanager action outside the read list. */
function isSecretsWriteAction(action: string): boolean {
  const lower = action.toLowerCase();
  if (lower === "*") return true;
  if (!lower.startsWith("secretsmanager:")) return false;
  if (action.includes("*") || action.includes("?")) return true;
  return ![...SECRETS_READ_ACTIONS].some((read) => read.toLowerCase() === lower);
}

function secretsWrites(template: Template): Statement[] {
  return statements(template).filter((statement) => statement.Effect !== "Deny"
    && (statement.NotAction !== undefined || [statement.Action ?? []].flat().some(isSecretsWriteAction)));
}

describe("refresh-token write-back grant (phase 7)", () => {
  it("lets the broker replace only connector secrets tagged agentx-writable: refresh-token, and nothing else", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "RefreshTokenControlPlane"));
    const writes = secretsWrites(template);
    expect(writes).toHaveLength(1);
    expect([writes[0]!.Action].flat()).toEqual(["secretsmanager:PutSecretValue"]);
    expect(JSON.stringify(writes[0]!.Resource)).toContain("secret:agentx/connectors/*");
    expect(writes[0]!.Condition).toEqual({ StringEquals: { "secretsmanager:ResourceTag/agentx-writable": "refresh-token" } });
  });

  it("counts wildcards and any non-read secretsmanager action as a write, in every kind of IAM policy", () => {
    const policy = (Action: string | string[]) => ({ PolicyDocument: { Statement: [{ Effect: "Allow", Action, Resource: "*" }] } });
    const template = Template.fromJSON({
      Resources: {
        Inline: { Type: "AWS::IAM::Policy", Properties: { PolicyName: "p", ...policy(["secretsmanager:GetSecretValue", "secretsmanager:*"]) } },
        Managed: { Type: "AWS::IAM::ManagedPolicy", Properties: policy("secretsmanager:UntagResource") },
        Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: {}, Policies: [{ PolicyName: "r", ...policy("secretsmanager:Put*") }, { PolicyName: "s", ...policy("*") }] } },
        Reads: { Type: "AWS::IAM::Policy", Properties: { PolicyName: "q", ...policy(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "s3:PutObject"]) } },
      },
    });
    expect(secretsWrites(template).map((statement) => statement.Action)).toEqual([
      ["secretsmanager:GetSecretValue", "secretsmanager:*"],
      "secretsmanager:UntagResource",
      "secretsmanager:Put*",
      "*",
    ]);
  });
});
