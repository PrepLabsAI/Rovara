// ENV-ROOM, the infrastructure side (infra/lib/broker-names.ts): a named environment's broker gets its names and settings packed; a literal or a parameter that could carry a
// separator is refused at synthesis, and a derived variable whose derivation differs from the value the infrastructure has stops synthesis. The legacy install passes each whole.
import { App, CfnParameter, Stack, aws_lambda as lambda } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { decodeBrokerNamesParameter } from "../../packages/contracts/src/broker-environment.js";
import { describe, expect, it } from "vitest";
import { addBrokerName, addBrokerSetting, addDerivedBrokerVariable } from "../../infra/lib/broker-names.js";
import { environmentNaming, legacyNaming } from "../../infra/lib/naming.js";

function broker(): { stack: Stack; fn: lambda.Function } {
  const stack = new Stack(new App(), "S");
  const fn = new lambda.Function(stack, "Broker", { runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {}") });
  return { stack, fn };
}
const variablesOf = (stack: Stack, fn: lambda.Function): Record<string, unknown> =>
  (stack.resolve((fn.node.defaultChild as lambda.CfnFunction).environment) as { variables: Record<string, unknown> }).variables;
/**
 * Batch 12 (#863, ENV-ROOM 2): a named broker's AGENTX_NAMES list is written to its one SSM String parameter, not the environment; the environment holds the parameter's name and
 * the revision, which must equal the one in the parameter's value. Returns the list after checking all of that.
 */
function namesOf(stack: Stack, fn: lambda.Function, env = "staging"): unknown {
  const variables = variablesOf(stack, fn);
  expect(variables).not.toHaveProperty("AGENTX_NAMES");
  expect(variables.AGENTX_NAMES_PARAMETER).toBe(`/agentx/${env}/broker-names`);
  const parameters = Object.values((Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties: { Name: string; Value: unknown } }> }).Resources)
    .filter((resource) => resource.Type === "AWS::SSM::Parameter");
  expect(parameters).toHaveLength(1);
  expect(parameters[0]!.Properties.Name).toBe(`/agentx/${env}/broker-names`);
  const decoded = decodeBrokerNamesParameter(parameters[0]!.Properties.Value as string);
  if ("error" in decoded) throw new Error(decoded.error);
  expect(variables.AGENTX_NAMES_REVISION).toBe(decoded.revision);
  return decoded.list;
}

describe("addBrokerName / addBrokerSetting", () => {
  it("packs the bare value with the account, in a named environment and (#1149) in the legacy install, which keeps a role's ARN whole and says it is the legacy layout", () => {
    const legacy = broker();
    addBrokerName(legacy.fn, legacyNaming(), "stateTable", "bare", "whole");
    addBrokerName(legacy.fn, legacyNaming(), "slackOrchestratorRole", "role-name", "role-arn-whole");
    addBrokerSetting(legacy.fn, legacyNaming(), "signInSlack", "enabled");
    const legacyVariables = variablesOf(legacy.stack, legacy.fn);
    expect(legacyVariables).not.toHaveProperty("STATE_TABLE_NAME");
    expect(legacyVariables.SLACK_ORCHESTRATOR_ROLE_ARN).toBe("role-arn-whole");
    expect(legacyVariables.AGENTX_ACCOUNT_ID).toEqual({ Ref: "AWS::AccountId" });
    expect(namesOf(legacy.stack, legacy.fn, "production")).toEqual("ts=bare");
    expect(legacyVariables.AGENTX_SETTINGS).toEqual("ly=legacy,ss=enabled");
    const named = broker();
    addBrokerName(named.fn, environmentNaming("staging"), "stateTable", "my-table", "whole");
    addBrokerSetting(named.fn, environmentNaming("staging"), "signInSlack", "enabled");
    const variables = variablesOf(named.stack, named.fn);
    expect(variables).not.toHaveProperty("STATE_TABLE_NAME");
    expect(variables.AGENTX_ACCOUNT_ID).toEqual({ Ref: "AWS::AccountId" });
    expect(namesOf(named.stack, named.fn)).toEqual("ts=my-table");
    expect(variables.AGENTX_SETTINGS).toEqual("ss=enabled");
  });

  it("refuses a literal that could carry a separator, and a name added twice", () => {
    const { fn } = broker();
    expect(() => addBrokerName(fn, environmentNaming("staging"), "stateTable", "a,b", "whole")).toThrow(/not plain text/u);
    expect(() => addBrokerSetting(fn, environmentNaming("staging"), "slackTeamId", 'T"1')).toThrow(/not plain text/u);
    addBrokerName(fn, environmentNaming("staging"), "stateTable", "t", "whole");
    expect(() => addBrokerName(fn, environmentNaming("staging"), "stateTable", "t", "whole")).toThrow(/added twice/u);
  });

  it("refuses, at synthesis, a setting from a parameter that is not constrained to plain text", () => {
    const { stack, fn } = broker();
    const open = new CfnParameter(stack, "Open", { type: "String" });
    const closed = new CfnParameter(stack, "Closed", { type: "String", allowedValues: ["on", "off"] });
    addBrokerSetting(fn, environmentNaming("staging"), "signInSlack", closed.valueAsString);
    addBrokerSetting(fn, environmentNaming("staging"), "slackTeamId", open.valueAsString);
    expect(() => variablesOf(stack, fn)).toThrow(/comes from the parameter Open, which has no AllowedPattern or AllowedValues/u);
  });
});

describe("addDerivedBrokerVariable", () => {
  it("passes the value whole in the legacy install, unless (#1149) the entry is marked legacy and derives exactly that value for production", () => {
    const { stack, fn } = broker();
    // Not marked legacy: whole, whatever the value.
    addDerivedBrokerVariable(fn, legacyNaming(), "AGENTX_ALARM_PREFIX", "agentx-");
    // Marked legacy, and identical: nothing passed (the broker derives it).
    addDerivedBrokerVariable(fn, legacyNaming(), "SWEBENCH_SETTINGS_PREFIX", "/agentx/production/");
    // Marked legacy, but a different value: whole.
    addDerivedBrokerVariable(fn, legacyNaming(), "CHANNEL_ADAPTER_SECRET_PREFIX", "agentx/elsewhere/");
    const variables = variablesOf(stack, fn);
    expect(variables.AGENTX_ALARM_PREFIX).toBe("agentx-");
    expect(variables).not.toHaveProperty("SWEBENCH_SETTINGS_PREFIX");
    expect(variables.CHANNEL_ADAPTER_SECRET_PREFIX).toBe("agentx/elsewhere/");
  });

  it("passes nothing in a named environment when the broker derives exactly that value, and stops synthesis when it would derive another", () => {
    const { stack, fn } = broker();
    addDerivedBrokerVariable(fn, environmentNaming("staging"), "AGENTX_ALARM_PREFIX", "agentx-staging-");
    expect(variablesOf(stack, fn)).not.toHaveProperty("AGENTX_ALARM_PREFIX");
    expect(() => addDerivedBrokerVariable(fn, environmentNaming("staging"), "AGENTX_ALARM_PREFIX", "agentx-other-")).toThrow(/would derive AGENTX_ALARM_PREFIX differently/u);
    expect(() => addDerivedBrokerVariable(fn, environmentNaming("staging"), "STATE_TABLE_NAME", "x")).toThrow(/not a variable the broker derives/u);
  });
});
