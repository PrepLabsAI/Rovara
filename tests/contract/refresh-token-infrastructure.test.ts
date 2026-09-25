import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";

interface Statement { Action: string | string[]; Resource: unknown; Condition?: unknown }

function statements(template: Template): Statement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{ Properties: { PolicyDocument: { Statement: Statement[] } } }>)
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

describe("refresh-token write-back grant (phase 7)", () => {
  it("lets the broker replace only connector secrets tagged agentx-writable: refresh-token, and nothing else", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "RefreshTokenControlPlane"));
    const writes = statements(template).filter((statement) => [statement.Action].flat().some((action) => /^secretsmanager:(Put|Update|Create|Delete|Tag|Restore)/.test(action)));
    expect(writes).toHaveLength(1);
    expect([writes[0]!.Action].flat()).toEqual(["secretsmanager:PutSecretValue"]);
    expect(JSON.stringify(writes[0]!.Resource)).toContain("secret:agentx/connectors/*");
    expect(writes[0]!.Condition).toEqual({ StringEquals: { "secretsmanager:ResourceTag/agentx-writable": "refresh-token" } });
  });
});
