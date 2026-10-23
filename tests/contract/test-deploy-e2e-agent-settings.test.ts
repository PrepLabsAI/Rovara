import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { E2E_AGENT_SETTINGS_UNIT, assertOnlyExpectedChanges, liftDeclaredSettings, liftResources, planTestDeploy, type CfnTemplate, type DeployStep } from "../../scripts/test-deploy.js";
import { evaluateEnvironmentDrift, evaluateIamDrift } from "../../scripts/test-deploy-check.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// M1.4 Task 4.10A, test 12 (second half): the e2e-agent-settings unit against the control-plane template TEST runs, as head synthesizes it.
// DEPLOYFIX: head (4.10A + 4.10D) puts two worker-setting ARNs in each of the Broker's and the session steps' policies, and the model-fallback-settings unit puts 4.10D's parameter on the runtime stack.

const ENV = "agentxlivetest123";
const PARAMETER = `/agentx/${ENV}/worker-e2e-agent-model`;
const FALLBACK = `/agentx/${ENV}/worker-model-fallback`;
const SETTINGS = [PARAMETER, FALLBACK] as const;

function head(): CfnTemplate {
  const stack = buildAgentXApp({ agentxEnv: ENV, "agentx:e2eQualificationTransport": "enabled" }).node.children
    .filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === `agentx-${ENV}-control-plane`);
  if (stack === undefined) throw new Error("expected the real control-plane stack");
  return Template.fromStack(stack).toJSON();
}

type Policy = { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } } };
const holdsParameter = (entry: unknown) => SETTINGS.some((name) => JSON.stringify(entry).includes(`:parameter${name}`));

/** The template as TEST has it deployed before this unit: head without the variable and without either setting's ARN in the role policies. */
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

  it("names exactly the policies that carry each setting's ARN in head: both ARNs in the same one statement of each, and no other policy (the eval batch tick carries neither)", () => {
    for (const name of SETTINGS) {
      const carrying = Object.entries(headTemplate.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource).includes(`:parameter${name}`)).map(([id]) => id).sort();
      expect(carrying, name).toEqual([...E2E_AGENT_SETTINGS_UNIT.policies].sort());
    }
    expect(JSON.stringify(headTemplate.Resources!["EvalBatchTickServiceRoleDefaultPolicyC35492F8"])).not.toMatch(/worker-e2e-agent-model|worker-model-fallback/);
    for (const id of E2E_AGENT_SETTINGS_UNIT.policies) {
      const holders = (headTemplate.Resources![id] as unknown as Policy).Properties.PolicyDocument.Statement.filter((statement) => Array.isArray(statement.Resource) && statement.Resource.some(holdsParameter));
      expect(holders, id).toHaveLength(1);
      expect(holders[0]!.Action, id).toEqual("ssm:GetParameters");
      for (const name of SETTINGS) expect((holders[0]!.Resource as unknown[]).filter((entry) => JSON.stringify(entry).includes(`:parameter${name}`)), `${id} ${name}`).toHaveLength(1);
    }
    expect((headTemplate.Resources!["BrokerE1355FD6"]!.Properties as { Environment: { Variables: Record<string, string> } }).Environment.Variables["AGENTX_E2E_AGENT_SETTINGS_PREFIX"]).toBe(`/agentx/${ENV}/`);
  });

  it("lifts exactly the variable and the four grants (two settings in each of two policies), so the deployed template becomes head's in those resources and in no other", () => {
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

  it("lifts onto a deployed policy whose statements and resource lists are in another order than head's (TEST's Broker policy was synthesized with the same statements in a different order), and still refuses a real difference", () => {
    // RED before the fix: the comparison was by position, and refused TEST's deployed Broker policy at head although the two held the same statements.
    const reordered = (template: CfnTemplate): CfnTemplate => {
      const copy = JSON.parse(JSON.stringify(template)) as CfnTemplate;
      for (const id of E2E_AGENT_SETTINGS_UNIT.policies) {
        const document = (copy.Resources![id] as unknown as Policy).Properties.PolicyDocument;
        document.Statement.reverse();
        for (const statement of document.Statement) if (Array.isArray(statement.Resource)) statement.Resource.reverse();
      }
      return copy;
    };
    const deployed = reordered(beforeTheUnit(headTemplate));
    const lifted = liftDeclaredSettings(deployed, headTemplate, { environment: declared.environment, grants: declared.grants });
    for (const id of E2E_AGENT_SETTINGS_UNIT.policies) expect(lifted.Resources![id], id).toEqual(headTemplate.Resources![id]);
    const different = reordered(beforeTheUnit(headTemplate));
    const statements = (different.Resources![E2E_AGENT_SETTINGS_UNIT.policies[0]] as unknown as Policy).Properties.PolicyDocument.Statement;
    const other = statements.find((statement) => statement.Action !== "ssm:GetParameters" && Array.isArray(statement.Resource));
    (other!.Resource as unknown[]).pop();
    expect(() => liftDeclaredSettings(different, headTemplate, { environment: declared.environment, grants: declared.grants })).toThrow(/more than the declared grant/);
  });

  it("refuses when the policies carry a setting ARN the unit does not declare (the refusal at df5a5a1e: only worker-e2e-agent-model was lifted)", () => {
    const deployed = beforeTheUnit(headTemplate);
    const onlyFirst = declared.grants.filter((grant) => grant.parameterName === PARAMETER);
    expect(() => liftDeclaredSettings(deployed, headTemplate, { environment: declared.environment, grants: onlyFirst })).toThrow(/more than the declared grant for \/agentx\/agentxlivetest123\/worker-e2e-agent-model/);
  });

  it("refuses when TEST's deployed policy differs from head by something besides the declared ARNs, in either policy", () => {
    for (const id of E2E_AGENT_SETTINGS_UNIT.policies) {
      const deployed = beforeTheUnit(headTemplate);
      (deployed.Resources![id] as unknown as Policy).Properties.PolicyDocument.Statement.pop();
      expect(() => liftDeclaredSettings(deployed, headTemplate, { environment: declared.environment, grants: declared.grants }), id).toThrow(/more than the declared grant/);
    }
  });

  it("is declared for the TEST installation's own settings prefix and both parameters, in each policy", () => {
    expect(declared.environment).toEqual([{ logicalId: "BrokerE1355FD6", variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX" }]);
    expect(declared.grants).toHaveLength(E2E_AGENT_SETTINGS_UNIT.policies.length * SETTINGS.length);
    for (const logicalId of E2E_AGENT_SETTINGS_UNIT.policies) expect(declared.grants.filter((grant) => grant.logicalId === logicalId).map((grant) => grant.parameterName).sort()).toEqual([...SETTINGS].sort());
  });
});

type Runtime = { Parameters: Record<string, { Default?: string; AllowedPattern?: string }>; Resources: Record<string, { Type: string; Properties: { Name: string; Value: unknown } }> };

describe("the model-fallback-settings unit against head's runtime template", () => {
  const headRuntime = (): CfnTemplate => {
    const stack = buildAgentXApp({ agentxEnv: ENV }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === `agentx-${ENV}-runtime`);
    if (stack === undefined) throw new Error("expected the real runtime stack");
    return Template.fromStack(stack).toJSON();
  };
  const head = headRuntime();
  const plan = planTestDeploy({
    env: ENV, only: ["model-fallback-settings"], artifacts: { revision: "0123456789ab", outputDir: "/tmp/x" },
    previous: { "control-plane": {}, runtime: { ModelId: "m", ModelProvider: "amazon-bedrock", WorkerImageUri: "i" } },
  });
  const changeSet = plan.find((step): step is Extract<DeployStep, { kind: "create-change-set" }> => step.kind === "create-change-set")!;
  const lift = changeSet.template as Extract<typeof changeSet.template, { source: "lift-resources" }>;

  /** The runtime stack as TEST has it before the unit: head without the parameter and its SSM setting. */
  const beforeTheUnit = (): CfnTemplate => {
    const copy = JSON.parse(JSON.stringify(head)) as CfnTemplate;
    delete copy.Parameters!["ModelFallback"];
    for (const id of Object.keys(copy.Resources!)) if (id.startsWith("WorkerModelFallbackParameter")) delete copy.Resources![id];
    return copy;
  };

  it("lifts exactly the ModelFallback parameter (default none) and the one SSM setting it fills, so the deployed template becomes head's and no other resource or parameter moves", () => {
    const deployed = beforeTheUnit();
    const lifted = liftResources(deployed, head, lift.logicalIdPrefix, lift.parameterNames);
    const added = Object.keys(lifted.Resources!).filter((id) => !(id in deployed.Resources!));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^WorkerModelFallbackParameter/);
    expect(Object.keys(lifted.Parameters!).filter((name) => !(name in deployed.Parameters!))).toEqual(["ModelFallback"]);
    const runtime = lifted as unknown as Runtime;
    expect(runtime.Parameters["ModelFallback"]).toMatchObject({ Default: "none" });
    expect(new RegExp(runtime.Parameters["ModelFallback"]!.AllowedPattern!).test("none")).toBe(true);
    expect(runtime.Resources[added[0]!]).toMatchObject({ Type: "AWS::SSM::Parameter", Properties: { Name: FALLBACK, Value: { Ref: "ModelFallback" } } });
    expect(lifted).toEqual(head);
    // Nothing else of the deployed template moved.
    for (const id of Object.keys(deployed.Resources!)) expect(lifted.Resources![id], id).toEqual(deployed.Resources![id]);
    // The change set the plan expects is exactly that one Add.
    expect(() => assertOnlyExpectedChanges([{ action: "Add", logicalId: added[0]!, type: "AWS::SSM::Parameter" }], changeSet.expect)).not.toThrow();
    expect(changeSet.parameters.find((parameter) => parameter.key === "ModelFallback")).toEqual({ key: "ModelFallback", literal: "none" });
  });

  it("keeps the worker settings of 4.10A and the other readers' names exactly as head has them (the SSM name is the one the IAM grants name)", () => {
    const names = Object.values((head as unknown as Runtime).Resources).filter((resource) => resource.Type === "AWS::SSM::Parameter").map((resource) => resource.Properties.Name);
    expect(names).toContain(FALLBACK);
    expect(names).toContain(PARAMETER);
  });

  it("refuses a lift whose synth would also add something else the deployed stack lacks, and a change set that holds another change", () => {
    const deployed = beforeTheUnit();
    const extra = JSON.parse(JSON.stringify(head)) as CfnTemplate;
    const fallbackId = Object.keys(extra.Resources!).find((id) => id.startsWith("WorkerModelFallbackParameter"))!;
    const properties = extra.Resources![fallbackId]!.Properties as Record<string, unknown>;
    properties["Value"] = { Ref: "SomethingTheDeployedStackLacks" };
    expect(() => liftResources(deployed, extra, lift.logicalIdPrefix, lift.parameterNames)).toThrow(/SomethingTheDeployedStackLacks/);
    expect(() => assertOnlyExpectedChanges([{ action: "Add", logicalId: fallbackId, type: "AWS::SSM::Parameter" }, { action: "Modify", logicalId: "WorkerImageParameter", type: "AWS::SSM::Parameter", attributes: ["Properties.Value"] }], changeSet.expect)).toThrow(/Modify WorkerImageParameter/);
  });
});
