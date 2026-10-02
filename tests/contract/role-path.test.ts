import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const rolesOf = (stack: Stack) =>
  Object.entries(Template.fromStack(stack).findResources("AWS::IAM::Role") as Record<string, { Properties: Record<string, unknown> }>);

describe("environment role path", () => {
  it("puts every environment role outside the access stack under /agentx/<env>/", () => {
    const stacks = stacksOf(buildAgentXApp({ agentxEnv: "staging" })).filter((s) => s.stackName !== "agentx-staging-access");
    const roles = stacks.flatMap((s) => rolesOf(s).map(([id, role]) => [`${s.stackName}/${id}`, role.Properties.Path] as const));
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter(([, path]) => path !== "/agentx/staging/")).toEqual([]);
  }, 240_000);

  it("leaves legacy roles at their existing path", () => {
    const roles = stacksOf(buildAgentXApp()).flatMap((s) => rolesOf(s).map(([id, role]) => [`${s.stackName}/${id}`, role.Properties.Path] as const));
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter(([, path]) => path !== undefined)).toEqual([]);
  }, 240_000);
});
