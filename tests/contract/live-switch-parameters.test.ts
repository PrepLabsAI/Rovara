// Live switches check 2026-11-18 (briefs/watch-logs/live-switches-20261118.md): ROVARA_CORE_AGENT_MODEL_CHOICE (DEC 254n(1), 243c), the per-company agent model choice, was read by the broker
// but set by NOTHING in infra, so no hosted install could turn it on. It is now the stack parameter CoreAgentModelChoice (off/on, default off), packed `mx` for the BROKER only: named
// environments only (the legacy template is unchanged), kept across upgrades (OPERATOR_PARAMETERS), set by `agentx config set coreEngine.agentModelChoice`, no IAM, no other resource. The
// reader is reached from the packed value in tests/unit/offered-models-http.test.ts.
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, CORE_AGENT_MODEL_CHOICE_VARIABLE } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { hydrateBrokerSettings } from "../../packages/broker/src/aws/broker-environment.js";
import { CORE_AGENT_MODEL_CHOICE_VARIABLE as BROKER_CHOICE_VARIABLE } from "../../packages/broker/src/core-host/offered-models-http.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Json = { Parameters: Record<string, Record<string, unknown>>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };
const named = (() => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  return Template.fromStack(stacks.find((candidate) => candidate.stackName === "agentx-staging-control-plane")!).toJSON() as Json;
})();
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LiveSwitchLegacyControlPlane")).toJSON() as Json;
const functionVariables = (template: Json, pattern: RegExp): Record<string, unknown> => {
  const found = Object.entries(template.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(found, String(pattern)).toHaveLength(1);
  return (found[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};
/** A packed AGENTX_SETTINGS (Fn::Join of `code=` and value pieces) as code -> piece. */
function packed(variables: Record<string, unknown>): Map<string, unknown> {
  const parts = (variables.AGENTX_SETTINGS as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
  const out = new Map<string, unknown>();
  for (let index = 0; index < parts.length; index += 2) out.set(/^,?([a-z]{2})=$/u.exec(String(parts[index]))![1]!, parts[index + 1]);
  return out;
}
const users = (template: Json, needle: string) => Object.entries(template.Resources).filter(([, resource]) => JSON.stringify(resource).includes(needle)).map(([id, resource]) => `${id.replace(/[0-9A-F]{8}$/u, "")}:${resource.Type}`);

describe("the per-company agent model choice (CoreAgentModelChoice, DEC 254n(1))", () => {
  it("is declared off by default, off or on only", () => {
    expect(named.Parameters.CoreAgentModelChoice).toMatchObject({ Type: "String", Default: "off", AllowedValues: ["off", "on"] });
  });
  it("is packed for the BROKER only (mx), never a variable of its own; the dispatcher has no piece of it", () => {
    expect(BROKER_SETTINGS.coreAgentModelChoice).toEqual({ code: "mx", variable: CORE_AGENT_MODEL_CHOICE_VARIABLE });
    expect(BROKER_CHOICE_VARIABLE).toBe(CORE_AGENT_MODEL_CHOICE_VARIABLE);
    const broker = functionVariables(named, /^Broker[0-9A-F]{8}$/u);
    expect(packed(broker).get("mx")).toStrictEqual({ Ref: "CoreAgentModelChoice" });
    expect(broker).not.toHaveProperty(CORE_AGENT_MODEL_CHOICE_VARIABLE);
    const dispatcher = functionVariables(named, /^Dispatcher[0-9A-F]{8}$/u);
    expect(packed(dispatcher).has("mx")).toBe(false);
    expect(dispatcher).not.toHaveProperty(CORE_AGENT_MODEL_CHOICE_VARIABLE);
    expect(users(named, '"Ref":"CoreAgentModelChoice"')).toEqual(["Broker:AWS::Lambda::Function"]);
  });
  it("unpacks to exactly the value the broker reads (`on` opens it, `off` does not)", () => {
    for (const value of ["on", "off"]) {
      const env: Record<string, string | undefined> = { AGENTX_SETTINGS: `mx=${value}` };
      hydrateBrokerSettings(env);
      expect(env[CORE_AGENT_MODEL_CHOICE_VARIABLE]).toBe(value);
    }
  });
  it("is absent from the legacy template, kept across an upgrade and set by coreEngine.agentModelChoice", () => {
    expect(legacy.Parameters).not.toHaveProperty("CoreAgentModelChoice");
    expect(JSON.stringify(legacy.Resources)).not.toContain("CoreAgentModelChoice");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreAgentModelChoice");
    expect(configKey("coreEngine.agentModelChoice")).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreAgentModelChoice" }, defaultValue: "off" });
  });
});
