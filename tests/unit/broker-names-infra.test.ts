// ENV-ROOM, the infrastructure side (infra/lib/broker-names.ts): a named environment's broker gets its names and settings packed; a literal or a parameter that could carry a
// separator is refused at synthesis, and a derived variable whose derivation differs from the value the infrastructure has stops synthesis. The legacy install passes each whole.
import { App, CfnParameter, Stack, aws_lambda as lambda } from "aws-cdk-lib";
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

describe("addBrokerName / addBrokerSetting", () => {
  it("passes the whole value in the legacy install, and packs the bare one in a named environment with the account", () => {
    const legacy = broker();
    addBrokerName(legacy.fn, legacyNaming(), "stateTable", "bare", "whole");
    expect(variablesOf(legacy.stack, legacy.fn)).toEqual({ STATE_TABLE_NAME: "whole" });
    const named = broker();
    addBrokerName(named.fn, environmentNaming("staging"), "stateTable", "my-table", "whole");
    addBrokerSetting(named.fn, environmentNaming("staging"), "signInSlack", "enabled");
    const variables = variablesOf(named.stack, named.fn);
    expect(variables).not.toHaveProperty("STATE_TABLE_NAME");
    expect(variables.AGENTX_ACCOUNT_ID).toEqual({ Ref: "AWS::AccountId" });
    expect(variables.AGENTX_NAMES).toEqual("ts=my-table");
    expect(variables.AGENTX_SETTINGS).toEqual("ss=enabled");
  });

  it("gives an empty variable, not an empty Fn::Join, when nothing is packed in it", () => {
    const { stack, fn } = broker();
    addBrokerSetting(fn, environmentNaming("staging"), "signInSlack", "enabled");
    expect(variablesOf(stack, fn).AGENTX_NAMES).toBe("");
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
  it("passes the value whole in the legacy install", () => {
    const { stack, fn } = broker();
    addDerivedBrokerVariable(fn, legacyNaming(), "AGENTX_ALARM_PREFIX", "agentx-");
    expect(variablesOf(stack, fn)).toEqual({ AGENTX_ALARM_PREFIX: "agentx-" });
  });

  it("passes nothing in a named environment when the broker derives exactly that value, and stops synthesis when it would derive another", () => {
    const { stack, fn } = broker();
    addDerivedBrokerVariable(fn, environmentNaming("staging"), "AGENTX_ALARM_PREFIX", "agentx-staging-");
    expect(variablesOf(stack, fn)).not.toHaveProperty("AGENTX_ALARM_PREFIX");
    expect(() => addDerivedBrokerVariable(fn, environmentNaming("staging"), "AGENTX_ALARM_PREFIX", "agentx-other-")).toThrow(/would derive AGENTX_ALARM_PREFIX differently/u);
    expect(() => addDerivedBrokerVariable(fn, environmentNaming("staging"), "STATE_TABLE_NAME", "x")).toThrow(/not a variable the broker derives/u);
  });
});
