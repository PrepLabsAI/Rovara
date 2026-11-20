import { describe, expect, it } from "vitest";
import { runConfigSet } from "../../packages/cli/src/config/commands.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { passingChecks } from "../support/init-fakes.js";
import { seeded, services, stacks } from "../support/config-services.js";

// M1.4 Task 4.10D, test 41 (MODEL3): the fallback is a choice, made with `agentx config set models.fallback`, held to the pinned Bedrock catalog, tested before it is set, and applied to the
// worker's runtime stack and the Slack stack together.

const ENV = "staging";
const CHOSEN = "us.anthropic.claude-sonnet-4-6";
/** CloudFormation with one fake per stack, so a change to one stack's parameter shows on that stack only; `calls` lists the change sets' stacks in order. */
function perStack(initial: Record<string, string>) {
  const fakes = new Map(Object.entries(initial).map(([stack, value]) => [stack, fakeCloudFormation({ parameters: { ModelFallback: value } })] as const));
  const changeSetStacks: string[] = [];
  return {
    changeSetStacks,
    value: (stack: string) => fakes.get(stack)!.parameters.ModelFallback,
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const stack = String(command.input.StackName);
      if (command.constructor.name === "CreateChangeSetCommand") changeSetStacks.push(stack);
      return fakes.get(stack)!.send(command);
    },
  };
}
const BOTH_NONE = { "agentx-staging-runtime": "none", "agentx-staging-slack": "none" };
const BOTH_CHOSEN = { "agentx-staging-runtime": CHOSEN, "agentx-staging-slack": CHOSEN };

describe("agentx config set models.fallback", () => {

  it("sets none without a test call, and says nothing changed when both stacks already have the value", async () => {
    const checks = passingChecks();
    const known = stacks({ "agentx-staging-runtime": { ModelFallback: CHOSEN }, "agentx-staging-slack": { ModelFallback: CHOSEN } });
    const first = services({ store: await seeded(), checks: () => checks, cloudFormation: perStack(BOTH_CHOSEN), stacks: known });
    expect((await runConfigSet(first, ENV, { key: "models.fallback", value: CHOSEN, yes: true })).changed).toBe(false);
    expect(first.lines.join("\n")).toContain("models.fallback is already");
    const cloudFormation = perStack(BOTH_CHOSEN);
    const off = await runConfigSet(services({ store: await seeded(), checks: () => checks, cloudFormation, stacks: known }), ENV, { key: "models.fallback", value: "none", yes: true });
    expect(off.changed).toBe(true);
    expect(checks.models).toEqual([]);
    expect([cloudFormation.value("agentx-staging-runtime"), cloudFormation.value("agentx-staging-slack")]).toEqual(["none", "none"]);
  });

  it("finishes a stack that is behind even when the other already has the value, and names the stack that did not finish when one fails", async () => {
    const cloudFormation = perStack({ "agentx-staging-runtime": CHOSEN, "agentx-staging-slack": "none" });
    const run = services({ store: await seeded(), cloudFormation, stacks: stacks({ "agentx-staging-runtime": { ModelFallback: CHOSEN }, "agentx-staging-slack": { ModelFallback: "none" } }) });
    expect((await runConfigSet(run, ENV, { key: "models.fallback", value: CHOSEN, yes: true })).changed).toBe(true);
    expect(cloudFormation.changeSetStacks).toEqual(["agentx-staging-slack"]);

    const failing = perStack(BOTH_NONE);
    const broken = { ...failing, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "CreateChangeSetCommand" && command.input.StackName === "agentx-staging-slack") throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      return failing.send(command);
    } };
    const second = services({ store: await seeded(), cloudFormation: broken });
    await expect(runConfigSet(second, ENV, { key: "models.fallback", value: CHOSEN, yes: true })).rejects.toThrow("Rate exceeded");
    expect(second.lines.join("\n")).toContain("models.fallback is now us.anthropic.claude-sonnet-4-6 on agentx-staging-runtime, but not on agentx-staging-slack; run the same agentx config set again to finish it");
  });

  it("refuses a model outside the pinned Bedrock catalog, and one that fails its test call, changing nothing", async () => {
    const cloudFormation = perStack(BOTH_NONE);
    await expect(runConfigSet(services({ store: await seeded(), cloudFormation }), ENV, { key: "models.fallback", value: "us.made-up-model-v1", yes: true })).rejects.toThrow(/models\.fallback must be none or a Bedrock model of this Rovara's model catalog; nothing changed/);
    await expect(runConfigSet(services({ store: await seeded(), cloudFormation }), ENV, { key: "models.fallback", value: "gpt-5.4", yes: true })).rejects.toThrow(/models\.fallback must be none or a Bedrock model/);
    const denied = passingChecks({ converse: async () => { throw Object.assign(new Error("no access"), { name: "AccessDeniedException" }); } });
    await expect(runConfigSet(services({ store: await seeded(), checks: () => denied, cloudFormation }), ENV, { key: "models.fallback", value: CHOSEN, yes: true })).rejects.toThrow(/nothing changed/);
    expect(cloudFormation.changeSetStacks).toEqual([]);
  });
});
