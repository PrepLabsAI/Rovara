// ENV-ROOM 2 (broker 4 KB, owner decision 2026-11-17): a named environment's control plane writes the broker's names (AGENTX_NAMES) to one SSM String parameter and gives the
// function only the parameter's name and the revision it wrote. This pins, on the synthesized templates, exactly what that adds: one Standard String parameter with the v1 value,
// two variables in place of AGENTX_NAMES, the function (not its role) written after the parameter, and one statement that lets only the broker read only that parameter. The
// legacy template gains none of it. The parameter's worst case is held well under a Standard parameter's limit, and the revision in the function is the one the parameter carries.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  BROKER_NAMES_PARAMETER_MAX_BYTES, BROKER_NAMES_PARAMETER_VARIABLE, BROKER_NAMES_REVISION_VARIABLE, BROKER_NAMES_VARIABLE, brokerNamesParameterName, decodeBrokerNamesParameter,
} from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { brokerNamesRevision } from "../../infra/lib/broker-names.js";
import { RESOLVER_ACCOUNT, RESOLVER_REGION, controlPlaneOf } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };

function synthesized(env: string | undefined): { template: { Resources: Record<string, Resource> }; stackName: string } {
  const stack = buildAgentXApp(env === undefined ? {} : { agentxEnv: env }).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  if (stack === undefined) throw new Error("no control plane stack");
  return { template: Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }, stackName: stack.stackName };
}

const ofType = (template: { Resources: Record<string, Resource> }, type: string): Array<[string, Resource]> => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const brokerOf = (template: { Resources: Record<string, Resource> }): [string, Resource] => ofType(template, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id))!;
const actionsOf = (statement: Statement): string[] => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
const resourcesOf = (statement: Statement): unknown[] => (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]);

/** Every IAM statement in the template, with the roles it is attached to (an AWS::IAM::Policy's Roles, or the role whose inline policy it is). */
function statements(template: { Resources: Record<string, Resource> }): Array<{ statement: Statement; roles: unknown[] }> {
  const found: Array<{ statement: Statement; roles: unknown[] }> = [];
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") {
      const document = resource.Properties?.PolicyDocument as { Statement: Statement[] };
      const roles = (resource.Properties?.Roles as unknown[] | undefined) ?? [];
      for (const statement of document.Statement) found.push({ statement, roles });
    }
    if (resource.Type === "AWS::IAM::Role") {
      for (const policy of (resource.Properties?.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }> | undefined) ?? []) {
        for (const statement of policy.PolicyDocument.Statement) found.push({ statement, roles: [{ Ref: id }] });
      }
    }
  }
  return found;
}

/** Whether an IAM action pattern covers a read of a parameter (ssm:GetParameter, GetParameters, GetParameterHistory, GetParametersByPath; ssm:Get* or ssm:* does too). */
const READS = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath"];
const wildcard = (pattern: string, flags = "u"): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, flags);
const coversRead = (action: string): boolean => READS.some((read) => wildcard(action, "iu").test(read));

for (const env of ["staging", "a1234567890123456789"] as const) {
  describe(`environment ${env}: the broker's names are in one SSM String parameter`, () => {
    const built = synthesized(env);
    const { template, resolver } = controlPlaneOf(env, built);
    const named = built.template;
    const parameters = ofType(named, "AWS::SSM::Parameter");
    const [parameterId, parameter] = parameters[0] ?? ["", { Type: "", Properties: {} }];
    const [brokerId, broker] = brokerOf(named);
    const variables = (broker.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    const expectedArn = `arn:aws:ssm:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:parameter${brokerNamesParameterName(env)}`;

    it("adds exactly one parameter: Standard, a plain String, named for the environment, holding only names", () => {
      expect(parameters).toHaveLength(1);
      expect(parameterId).toBe("BrokerNamesParameter");
      expect(parameter.Properties).toMatchObject({ Type: "String", Tier: "Standard", Name: `/agentx/${env}/broker-names` });
      expect(Object.keys(parameter.Properties!).sort()).toEqual(["Description", "Name", "Tags", "Tier", "Type", "Value"]);
      expect(parameter.Properties!.Description).not.toMatch(/—/u);
    });

    it("writes v1, the revision and the names list, the revision being that of the list it writes", () => {
      const join = (parameter.Properties!.Value as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
      expect(join[0]).toBe("");
      const head = String(join[1][0]);
      const match = /^v1:([0-9a-f]{64}):(.*)$/u.exec(head);
      expect(match, "the value starts with the format and the revision").not.toBeNull();
      // The list as the control plane packs it: the rest of the Join after the prefix.
      const list = { "Fn::Join": ["", [match![2]!, ...join[1].slice(1)]] };
      expect(match![1]).toBe(brokerNamesRevision(list));
      expect(variables[BROKER_NAMES_REVISION_VARIABLE]).toBe(match![1]);
    });

    it("gives the function the parameter's name and the revision in place of AGENTX_NAMES, and the account it builds ARNs with", () => {
      expect(variables).not.toHaveProperty(BROKER_NAMES_VARIABLE);
      expect(variables[BROKER_NAMES_PARAMETER_VARIABLE]).toBe(brokerNamesParameterName(env));
      expect(variables[BROKER_NAMES_REVISION_VARIABLE]).toMatch(/^[0-9a-f]{64}$/u);
      expect(variables).toHaveProperty("AGENTX_ACCOUNT_ID");
    });

    it("updates the function only after the parameter, and nothing else of the broker waits on it", () => {
      expect(broker.DependsOn).toContain(parameterId);
      const waiting = Object.entries(named.Resources).filter(([, resource]) => (resource.DependsOn ?? []).includes(parameterId)).map(([id]) => id);
      expect(waiting).toEqual([brokerId]);
    });

    it("lets only the broker's role read it, with only ssm:GetParameters (its existing statement for its settings), on exactly that parameter", () => {
      const brokerRole = (broker.Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
      const reaching = statements(named).filter(({ statement }) => statement.Effect === "Allow" && actionsOf(statement).some(coversRead)
        && resourcesOf(statement).some((resource) => wildcard(resolver.text(resource)).test(expectedArn)));
      expect(reaching).toHaveLength(1);
      const [{ statement, roles }] = reaching as [{ statement: Statement; roles: unknown[] }];
      expect(roles).toEqual([{ Ref: brokerRole }]);
      expect(statement.Action).toBe("ssm:GetParameters");
      expect(statement).not.toHaveProperty("Condition");
      const arns = resourcesOf(statement).map((resource) => resolver.text(resource));
      // Exactly once, and every resource of the statement is one exact parameter: no wildcard, no path.
      expect(arns.filter((arn) => arn === expectedArn)).toHaveLength(1);
      for (const arn of arns) expect(arn).toMatch(/^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter\/agentx\/[a-z0-9]+\/[a-z0-9/-]+$/u);
      for (const arn of arns) expect(arn).not.toContain("*");
    });

    it("keeps its worst case, the longest names CloudFormation can generate, over 1 KB under a Standard parameter's limit, and it reads back as a v1 value", () => {
      const value = resolver.text(parameter.Properties!.Value);
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(BROKER_NAMES_PARAMETER_MAX_BYTES - 1024);
      const decoded = decodeBrokerNamesParameter(value);
      expect(decoded).toMatchObject({ revision: variables[BROKER_NAMES_REVISION_VARIABLE] });
      expect((decoded as { list: string }).list.split(",")).toHaveLength(20);
      // The measure the size test uses sees the same function: it carries no list.
      expect(controlPlaneOf(env, built).functions.find((entry) => entry.logicalId === brokerId)!.variables).not.toHaveProperty(BROKER_NAMES_VARIABLE);
      expect(template.Resources[parameterId]).toBeDefined();
    });
  });
}

describe("the revision", () => {
  it("is the same for the same list and different when a code, a reference or the order changes", () => {
    const list = { "Fn::Join": ["", ["ar=", { Ref: "Artifacts" }, ",ts=", { Ref: "State" }]] };
    expect(brokerNamesRevision(list)).toBe(brokerNamesRevision(JSON.parse(JSON.stringify(list)) as unknown));
    expect(brokerNamesRevision(list)).toMatch(/^[0-9a-f]{64}$/u);
    for (const changed of [
      { "Fn::Join": ["", ["ar=", { Ref: "Artifacts" }, ",tr=", { Ref: "State" }]] },
      { "Fn::Join": ["", ["ar=", { Ref: "Artifacts" }, ",ts=", { Ref: "State2" }]] },
      { "Fn::Join": ["", ["ts=", { Ref: "State" }, ",ar=", { Ref: "Artifacts" }]] },
      { "Fn::Join": ["", ["ar=", { Ref: "Artifacts" }]] },
      "",
    ]) expect(brokerNamesRevision(changed)).not.toBe(brokerNamesRevision(list));
  });
});

describe("the legacy template", () => {
  const legacy = synthesized(undefined).template;
  // #1149: production's broker keeps its names in the parameter too, under "production" (tests/contract/legacy-broker-packed-environment.test.ts proves it boots with the same values).
  it("has the one names parameter, /agentx/production/broker-names, which its broker points at and may read", () => {
    const parameters = ofType(legacy, "AWS::SSM::Parameter");
    expect(parameters.map(([, resource]) => resource.Properties!.Name)).toEqual(["/agentx/production/broker-names"]);
    const variables = (brokerOf(legacy)[1].Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables[BROKER_NAMES_PARAMETER_VARIABLE]).toBe("/agentx/production/broker-names");
    expect(variables).toHaveProperty(BROKER_NAMES_REVISION_VARIABLE);
    expect(JSON.stringify(legacy)).toContain(":parameter/agentx/production/broker-names");
  });
});
