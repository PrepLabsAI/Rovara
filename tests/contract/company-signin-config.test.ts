// DEC 254zg (a): `agentx config set company.signIn` flips the CompanySignIn switch on the control plane and the Slack service's stack with one yes; `company.selfServe`
// flips CompanySelfServe alone. Both are off by default and kept across upgrades (OPERATOR_PARAMETERS).
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, configKey } from "../../packages/cli/src/config/keys.js";
import { runConfigGet, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { seeded, services } from "../support/config-services.js";

const ENV = "staging";
const CONTROL = "agentx-staging-control-plane";
const SLACK = "agentx-staging-slack";

/** One fake per stack; `changeSetStacks` lists the stacks changed, in order. */
function perStack(initial: Record<string, Record<string, string>>) {
  const fakes = new Map(Object.entries(initial).map(([stack, parameters]) => [stack, fakeCloudFormation({ parameters })] as const));
  const changeSetStacks: string[] = [];
  return {
    changeSetStacks,
    parameters: (stack: string) => fakes.get(stack)!.parameters,
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const stack = String(command.input.StackName);
      if (command.constructor.name === "CreateChangeSetCommand") changeSetStacks.push(stack);
      return fakes.get(stack)!.send(command);
    },
    stacks: { describe: async (name: string) => (fakes.has(name) ? { parameters: { ...fakes.get(name)!.parameters } } : undefined) } as never,
  };
}
const OFF = { [CONTROL]: { CompanySignIn: "disabled", CompanySelfServe: "disabled", SlackCompanyWorkspaces: "disabled" }, [SLACK]: { CompanySignIn: "disabled", SlackCompanyWorkspacesState: "disabled" } };

describe("agentx config set company.signIn / company.selfServe", () => {
  it("are documented keys, disabled by default, that an upgrade keeps", async () => {
    expect(configKey("company.signIn")).toMatchObject({ defaultValue: "disabled", target: { kind: "stack-parameter", part: "control-plane", parameter: "CompanySignIn", also: [{ part: "slack", parameter: "CompanySignIn" }] } });
    expect(configKey("company.selfServe")).toMatchObject({ defaultValue: "disabled", target: { kind: "stack-parameter", part: "control-plane", parameter: "CompanySelfServe" } });
    expect(configKey("company.selfServe").target).not.toHaveProperty("also");
    expect(OPERATOR_PARAMETERS["control-plane"]).toEqual(expect.arrayContaining(["CompanySignIn", "CompanySelfServe"]));
    expect(OPERATOR_PARAMETERS.slack).toContain("CompanySignIn");
    const row = await runConfigGet(services({ store: await seeded() }), ENV, "company.signIn");
    expect(row).toMatchObject({ value: "disabled", where: `stack parameter CompanySignIn on ${CONTROL} and ${SLACK}` });
    expect(CONFIG_KEYS.filter((entry) => entry.key.startsWith("company."))).toHaveLength(2);
    expect(configKey("slack.companyWorkspaces")).toMatchObject({ defaultValue: "disabled", target: { kind: "stack-parameter", part: "control-plane", parameter: "SlackCompanyWorkspaces", also: [{ part: "slack", parameter: "SlackCompanyWorkspacesState" }] } });
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("SlackCompanyWorkspaces");
    expect(OPERATOR_PARAMETERS.slack).toContain("SlackCompanyWorkspacesState");
  });

  it.each([["company.signIn"], ["company.selfServe"], ["slack.companyWorkspaces"]])("%s takes exactly enabled or disabled", (key) => {
    expect(configKey(key).parse(" enabled ")).toBe("enabled");
    expect(configKey(key).parse("disabled")).toBe("disabled");
    for (const bad of ["on", "true", "Enabled", ""]) expect(() => configKey(key).parse(bad)).toThrow(`${key} must be one of enabled, disabled; nothing changed`);
  });

  it("company.signIn enabled flips the control plane, then the Slack stack, and leaves self-serve off", async () => {
    const cloudFormation = perStack(OFF);
    const result = await runConfigSet(services({ store: await seeded(), cloudFormation, stacks: cloudFormation.stacks }), ENV, { key: "company.signIn", value: "enabled", yes: true });
    expect(result.changed).toBe(true);
    expect(cloudFormation.changeSetStacks).toEqual([CONTROL, SLACK]);
    expect(cloudFormation.parameters(CONTROL)).toMatchObject({ CompanySignIn: "enabled", CompanySelfServe: "disabled", SlackCompanyWorkspaces: "disabled" });
    expect(cloudFormation.parameters(SLACK)).toMatchObject({ CompanySignIn: "enabled", SlackCompanyWorkspacesState: "disabled" });
  });

  it("company.signIn disabled flips both back", async () => {
    const cloudFormation = perStack({ [CONTROL]: { CompanySignIn: "enabled", CompanySelfServe: "disabled" }, [SLACK]: { CompanySignIn: "enabled" } });
    await runConfigSet(services({ store: await seeded(), cloudFormation, stacks: cloudFormation.stacks }), ENV, { key: "company.signIn", value: "disabled", yes: true });
    expect([cloudFormation.parameters(CONTROL).CompanySignIn, cloudFormation.parameters(SLACK).CompanySignIn]).toEqual(["disabled", "disabled"]);
  });

  it("company.selfServe enabled changes only CompanySelfServe on the control plane", async () => {
    const cloudFormation = perStack(OFF);
    await runConfigSet(services({ store: await seeded(), cloudFormation, stacks: cloudFormation.stacks }), ENV, { key: "company.selfServe", value: "enabled", yes: true });
    expect(cloudFormation.changeSetStacks).toEqual([CONTROL]);
    expect(cloudFormation.parameters(CONTROL)).toMatchObject({ CompanySignIn: "disabled", CompanySelfServe: "enabled" });
    expect(cloudFormation.parameters(SLACK)).toEqual({ CompanySignIn: "disabled", SlackCompanyWorkspacesState: "disabled" });
  });

  it("slack.companyWorkspaces enabled flips the control plane's SlackCompanyWorkspaces, then the Slack service's SlackCompanyWorkspacesState, and nothing else (DEC 254zk)", async () => {
    const cloudFormation = perStack(OFF);
    await runConfigSet(services({ store: await seeded(), cloudFormation, stacks: cloudFormation.stacks }), ENV, { key: "slack.companyWorkspaces", value: "enabled", yes: true });
    expect(cloudFormation.changeSetStacks).toEqual([CONTROL, SLACK]);
    expect(cloudFormation.parameters(CONTROL)).toEqual({ CompanySignIn: "disabled", CompanySelfServe: "disabled", SlackCompanyWorkspaces: "enabled" });
    expect(cloudFormation.parameters(SLACK)).toEqual({ CompanySignIn: "disabled", SlackCompanyWorkspacesState: "enabled" });
  });
});
