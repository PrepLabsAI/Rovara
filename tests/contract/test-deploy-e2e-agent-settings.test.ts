import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { E2E_AGENT_SETTINGS_UNIT, liftDeclaredSettings, planTestDeploy, type CfnTemplate, type DeployStep } from "../../scripts/test-deploy.js";
import { evaluateEnvironmentDrift, evaluateIamDrift } from "../../scripts/test-deploy-check.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// M1.4 Task 4.10A, test 12 (second half): the e2e-agent-settings unit against the control-plane template TEST runs, as head synthesizes it.

const ENV = "agentxlivetest123";
const PARAMETER = `/agentx/${ENV}/worker-e2e-agent-model`;

function head(): CfnTemplate {
  const stack = buildAgentXApp({ agentxEnv: ENV, "agentx:e2eQualificationTransport": "enabled" }).node.children
    .filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === `agentx-${ENV}-control-plane`);
  if (stack === undefined) throw new Error("expected the real control-plane stack");
  return Template.fromStack(stack).toJSON();
}

type Policy = { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } } };
const holdsParameter = (entry: unknown) => JSON.stringify(entry).includes(`:parameter${PARAMETER}`);

/** The template as TEST has it deployed before this unit: head without the variable and without the parameter's ARN in the role policies. */
function beforeTheUnit(template: CfnTemplate): CfnTemplate {
  const copy = JSON.parse(JSON.stringify(template)) as CfnTemplate;
  const variables = (copy.Resources!["BrokerE1355FD6"]!.Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;
  delete variables["AGENTX_E2E_AGENT_SETTINGS_PREFIX"];
  for (const id of E2E_AGENT_SETTINGS_UNIT.policies) {
    for (const statement of (copy.Resources![id] as unknown as Policy).Properties.PolicyDocument.Statement) {
      if (Array.isArray(statement.Resource)) statement.Resource = statement.Resource.filter((entry) => !holdsParameter(entry));
    }
  }
  return copy;
}

describe("the e2e-agent-settings unit against head's control-plane template", () => {
  const headTemplate = head();
  const plan = planTestDeploy({
    env: ENV, only: ["e2e-agent-settings"], artifacts: { revision: "0123456789ab", outputDir: "/tmp/x" },
    previous: { "control-plane": { OidcIssuer: "https://issuer.example" }, runtime: {} },
  });
  const changeSet = plan.find((step): step is Extract<DeployStep, { kind: "create-change-set" }> => step.kind === "create-change-set")!;
  const declared = changeSet.template as Extract<typeof changeSet.template, { source: "lift-declared" }>;

  it("names exactly the policies that carry the parameter's ARN in head: each in exactly one statement, and no other policy", () => {
    const carrying = Object.entries(headTemplate.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource).includes(`:parameter${PARAMETER}`)).map(([id]) => id).sort();
    expect(carrying).toEqual([...E2E_AGENT_SETTINGS_UNIT.policies].sort());
    for (const id of carrying) {
      const holders = (headTemplate.Resources![id] as unknown as Policy).Properties.PolicyDocument.Statement.filter((statement) => Array.isArray(statement.Resource) && statement.Resource.some(holdsParameter));
      expect(holders, id).toHaveLength(1);
      expect(holders[0]!.Action, id).toEqual("ssm:GetParameters");
    }
    expect((headTemplate.Resources!["BrokerE1355FD6"]!.Properties as { Environment: { Variables: Record<string, string> } }).Environment.Variables["AGENTX_E2E_AGENT_SETTINGS_PREFIX"]).toBe(`/agentx/${ENV}/`);
  });

  it("lifts exactly the variable and the three grants, so the deployed template becomes head's in those resources and in no other", () => {
    const deployed = beforeTheUnit(headTemplate);
    expect(evaluateEnvironmentDrift(headTemplate, deployed).map((finding) => [finding.kind, finding.subject])).toEqual([["lambda-env-missing", "BrokerE1355FD6"]]);
    expect(evaluateIamDrift(headTemplate, deployed).filter((finding) => finding.kind === "iam-missing-grant").map((finding) => finding.policyLogicalId).sort()).toEqual([...E2E_AGENT_SETTINGS_UNIT.policies].sort());
    const lifted = liftDeclaredSettings(deployed, headTemplate, { environment: declared.environment, grants: declared.grants });
    const changed = Object.keys(lifted.Resources!).filter((id) => JSON.stringify(lifted.Resources![id]) !== JSON.stringify(deployed.Resources![id])).sort();
    expect(changed).toEqual(["BrokerE1355FD6", ...E2E_AGENT_SETTINGS_UNIT.policies].sort());
    // Nothing is left for the drift check to find, and the broker's code and role are the deployed ones.
    expect(evaluateEnvironmentDrift(headTemplate, lifted)).toEqual([]);
    expect(evaluateIamDrift(headTemplate, lifted).filter((finding) => finding.kind === "iam-missing-grant")).toEqual([]);
    expect((lifted.Resources!["BrokerE1355FD6"]!.Properties as { Code: unknown }).Code).toEqual((deployed.Resources!["BrokerE1355FD6"]!.Properties as { Code: unknown }).Code);
    // Re-running it changes nothing.
    expect(liftDeclaredSettings(lifted, headTemplate, { environment: declared.environment, grants: declared.grants })).toEqual(lifted);
  });

  it("refuses when TEST's deployed policy also lacks some other grant head has (a second declared change must not ride along)", () => {
    const deployed = beforeTheUnit(headTemplate);
    const statements = (deployed.Resources![E2E_AGENT_SETTINGS_UNIT.policies[0]] as unknown as Policy).Properties.PolicyDocument.Statement;
    const other = statements.find((statement) => statement.Action !== "ssm:GetParameters" && Array.isArray(statement.Resource));
    expect(other, "the policy has another statement with a resource list").toBeDefined();
    (other!.Resource as unknown[]).pop();
    expect(() => liftDeclaredSettings(deployed, headTemplate, { environment: declared.environment, grants: declared.grants })).toThrow(/more than the declared grant/);
  });

  it("is declared for the TEST installation's own settings prefix and parameter", () => {
    expect(declared.environment).toEqual([{ logicalId: "BrokerE1355FD6", variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX" }]);
    expect(declared.grants.every((grant) => grant.parameterName === PARAMETER)).toBe(true);
  });
});
