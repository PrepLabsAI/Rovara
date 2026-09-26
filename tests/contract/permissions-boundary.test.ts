import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));

describe("permission boundary", () => {
  it("is a parameter on every environment stack and conditionally on every role", () => {
    for (const stack of stacksOf(buildAgentXApp({ agentxEnv: "staging" }))) {
      const json = Template.fromStack(stack).toJSON() as { Parameters: Record<string, { Default?: string; AllowedPattern?: string }>; Conditions: Record<string, unknown>; Resources: Record<string, { Type: string; Properties: { PermissionsBoundary?: unknown } }> };
      expect(json.Parameters.PermissionsBoundaryArn, stack.stackName).toMatchObject({ Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$" });
      expect(json.Conditions.HasPermissionsBoundary, stack.stackName).toBeDefined();
      for (const [id, resource] of Object.entries(json.Resources).filter(([, r]) => r.Type === "AWS::IAM::Role")) {
        expect(resource.Properties.PermissionsBoundary, `${stack.stackName} ${id}`).toEqual({ "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }] });
      }
    }
  }, 300_000);

  it("is absent from the deployment that predates environments", () => {
    for (const stack of stacksOf(buildAgentXApp())) {
      expect(JSON.stringify(Template.fromStack(stack).toJSON()), stack.stackName).not.toContain("PermissionsBoundaryArn");
    }
  }, 300_000);
});
