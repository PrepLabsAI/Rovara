import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
function statements(stack: Stack): Array<{ Action: string | string[]; Resource: unknown }> {
  return Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: { PolicyDocument?: { Statement: Array<{ Action: string | string[]; Resource: unknown }> }; Policies?: Array<{ PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } }> } }>)
    .flatMap((r) => [...(r.Properties?.PolicyDocument?.Statement ?? []), ...(r.Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument.Statement)]);
}
const grants = (stack: Stack, action: string) => statements(stack).filter((s) => [s.Action].flat().includes(action)).map((s) => JSON.stringify(s.Resource));

describe("pulling AgentX images through the cache", () => {
  const stacks = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
  it.each(["agentx-staging-runtime", "agentx-staging-slack"])("%s may import upstream images into its cache prefix", (name) => {
    const stack = stacks.find((s) => s.stackName === name)!;
    for (const action of ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) {
      expect(grants(stack, action).some((r) => r.includes("repository/agentx-staging/*")), `${name} ${action}`).toBe(true);
    }
  }, 240_000);

  it("adds nothing to the deployment that predates environments", () => {
    for (const stack of stacksOf(buildAgentXApp())) {
      expect(grants(stack, "ecr:BatchImportUpstreamImage"), stack.stackName).toEqual([]);
    }
  }, 240_000);
});
