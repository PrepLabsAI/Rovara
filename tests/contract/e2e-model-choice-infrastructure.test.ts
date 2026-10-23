import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKER_SETTING_PARAMETERS } from "../../packages/contracts/src/session.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// M1.4 Task 4.10A, tests 9 and 10: where the AI navigation model setting lives, who may read it, and the broker environment variable that was never set (PREFIXGAP).

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action: string | string[]; Resource?: unknown };
const stacksOf = (app: App) => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
const ofType = (template: Template, type: string) => Object.entries(resourcesOf(template)).filter(([, resource]) => resource.Type === type);
const brokerEnvironment = (template: Template) => {
  const [, broker] = ofType(template, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
  return (broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};
const statements = (template: Template): Statement[] => ofType(template, "AWS::IAM::Policy").flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

describe("the AI navigation model setting (named environment)", () => {
  let runtime: Template;
  let controlPlane: Template;
  let legacy: Template[];

  beforeAll(() => {
    const staging = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
    const byName = (name: string) => Template.fromStack(staging.find((stack) => stack.stackName === name)!);
    runtime = byName("agentx-staging-runtime");
    controlPlane = byName("agentx-staging-control-plane");
    legacy = stacksOf(buildAgentXApp()).map((stack) => Template.fromStack(stack));
  }, 240_000);

  it("names the setting worker-e2e-agent-model", () => {
    expect(WORKER_SETTING_PARAMETERS.e2eAgentModel).toBe("worker-e2e-agent-model");
  });

  it("gives the runtime stack the E2eAgentModelId parameter, default 'default', and the SSM setting it fills", () => {
    runtime.hasParameter("E2eAgentModelId", { Type: "String", Default: "default", AllowedPattern: "^(default|[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})$" });
    const setting = ofType(runtime, "AWS::SSM::Parameter").find(([id]) => id.startsWith("WorkerE2eAgentModelParameter"));
    expect(setting).toBeDefined();
    expect(setting![1].Properties).toMatchObject({ Name: "/agentx/staging/worker-e2e-agent-model", Value: { Ref: "E2eAgentModelId" } });
    // The pattern admits a model id and refuses anything else (no spaces, no quotes, at most 200 characters).
    const pattern = new RegExp("^(default|[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})$");
    for (const ok of ["default", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic/claude-haiku-5.5", "gpt-5.4-mini"]) expect(pattern.test(ok), ok).toBe(true);
    for (const bad of ["", "a b", "x\"y", "-lead", "a".repeat(201)]) expect(pattern.test(bad), bad).toBe(false);
  });

  it("lets the broker read the setting with ssm:GetParameters, and no worker boot variable carries it", () => {
    const reads = statements(controlPlane).filter((statement) => [statement.Action].flat().includes("ssm:GetParameters"));
    const arns = JSON.stringify(reads.map((statement) => statement.Resource));
    expect(arns).toContain("/agentx/staging/worker-e2e-agent-model");
  });

  it("sets AGENTX_E2E_AGENT_SETTINGS_PREFIX on the broker to the environment's settings prefix (PREFIXGAP)", () => {
    expect(brokerEnvironment(controlPlane)["AGENTX_E2E_AGENT_SETTINGS_PREFIX"]).toBe("/agentx/staging/");
  });

  it("changes the production templates only by the new parameter and setting, and leaves the broker environment alone", () => {
    const names = legacy.flatMap((template) => ofType(template, "AWS::SSM::Parameter").map(([, resource]) => resource.Properties["Name"]));
    expect(names).toContain("/agentx/production/worker-e2e-agent-model");
    for (const template of legacy) {
      const broker = ofType(template, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
      if (broker !== undefined) expect(brokerEnvironment(template)).not.toHaveProperty("AGENTX_E2E_AGENT_SETTINGS_PREFIX");
    }
  });
});
