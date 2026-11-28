// #1614: company mode is the only mode. The company layer once shipped behind CompanySignIn and CompanySelfServe, and Slack company mode behind SlackCompanyWorkspaces, so an install
// could run with them off; the off state could not run a task (#1612). Here: no template declares any of them, the company grants exist unconditionally, no function is handed a
// switch variable, the broker packs no switch (its codes are reserved), and `agentx config set` has no key for them.
import { type App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { RESERVED_PACKED_CODES } from "../../packages/contracts/src/settings/index.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONFIG_KEYS } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

const SWITCH_PARAMETERS = ["CompanySignIn", "CompanySelfServe", "SlackCompanyWorkspaces", "SlackCompanyWorkspacesState"];
const SWITCH_VARIABLES = ["COMPANY_SIGNIN", "COMPANY_SELF_SERVE", "SLACK_COMPANY_WORKSPACES"];
const stacksOf = (app: App) => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const synth = (app: App, name: string): TemplateJson => Template.fromStack(stacksOf(app).find((stack) => stack.stackName === name)!).toJSON() as TemplateJson;

let templates: Array<[string, TemplateJson]>;
beforeAll(() => {
  const named = buildAgentXApp({ agentxEnv: "staging" });
  const legacy = buildAgentXApp();
  templates = [
    ["agentx-staging-control-plane", synth(named, "agentx-staging-control-plane")], ["agentx-staging-slack", synth(named, "agentx-staging-slack")],
    ["AgentXControlPlane", synth(legacy, "AgentXControlPlane")], ["AgentXSlackOrchestrator", synth(legacy, "AgentXSlackOrchestrator")],
  ];
}, 300_000);

describe("company mode is the only mode (#1614)", () => {
  it("no template declares a company mode switch or a condition on one", () => {
    for (const [name, template] of templates) {
      for (const parameter of SWITCH_PARAMETERS) expect(template.Parameters, `${name} ${parameter}`).not.toHaveProperty(parameter);
      expect(Object.keys(template.Conditions ?? {}).filter((id) => /^(CompanySignInSwitch|SlackCompanyMode)/u.test(id)), name).toEqual([]);
    }
  });

  it("no function or container is handed a switch variable", () => {
    for (const [name, template] of templates) {
      for (const [id, resource] of Object.entries(template.Resources)) {
        const lambda = resource.Type === "AWS::Lambda::Function" ? Object.keys((resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {}) : [];
        const containers = resource.Type === "AWS::ECS::TaskDefinition" ? (resource.Properties.ContainerDefinitions as Array<{ Environment?: Array<{ Name: string }> }>).flatMap((c) => (c.Environment ?? []).map((e) => e.Name)) : [];
        for (const variable of SWITCH_VARIABLES) expect([...lambda, ...containers], `${name} ${id}`).not.toContain(variable);
      }
    }
  });

  it("the company layer's and Slack company mode's grants are policies of their own, never conditional", () => {
    for (const [name, template] of templates.filter(([stack]) => stack.endsWith("ControlPlane") || stack.endsWith("control-plane"))) {
      const own = Object.entries(template.Resources).filter(([id]) => /^(CompanySignInSwitch|SlackCompanyMode)/u.test(id));
      expect(own.length, name).toBeGreaterThan(0);
      for (const [id, resource] of own) {
        expect(resource.Type, `${name} ${id}`).toBe("AWS::IAM::Policy");
        expect(resource.Condition, `${name} ${id}`).toBeUndefined();
      }
      // The sign-in function's Add to Slack token grant is there with no switch.
      expect(own.map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""))).toContain("CompanySignInSwitchSlackWorkspaceTokens");
    }
  });

  it("the broker packs no switch, and the switches' packed codes stay reserved", () => {
    for (const [name, template] of templates.filter(([stack]) => stack.endsWith("ControlPlane") || stack.endsWith("control-plane"))) {
      const broker = Object.entries(template.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")![1];
      const settings = JSON.stringify((broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables.AGENTX_SETTINGS);
      expect(settings, name).not.toMatch(/[",](si|cw)=/u);
    }
    expect(Object.keys(RESERVED_PACKED_CODES)).toEqual(expect.arrayContaining(["si", "cw"]));
  });

  it("`agentx config set` has no key for them, and an upgrade keeps none", () => {
    const keys = CONFIG_KEYS.map((entry) => entry.key);
    for (const key of ["company.signIn", "company.selfServe", "slack.companyWorkspaces"]) expect(keys).not.toContain(key);
    for (const parameters of Object.values(OPERATOR_PARAMETERS)) for (const parameter of SWITCH_PARAMETERS) expect(parameters).not.toContain(parameter);
  });
});
