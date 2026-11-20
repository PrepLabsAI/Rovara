import { describe, expect, it, vi } from "vitest";
import { runConfigSet } from "../../packages/cli/src/config/commands.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { passingChecks } from "../support/init-fakes.js";
import { seeded, services, stacks } from "../support/config-services.js";

// M1.4 Task 4.10A, test 11: agentx config set models.e2eAgent, the customer's choice of AI navigation model.

const ENV = "staging";
const HAIKU_45_GLOBAL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_45_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const runtimeStack = (parameters: Record<string, string>) => stacks({ "agentx-staging-runtime": { ModelId: "us.anthropic.claude-sonnet-4-6", E2eAgentModelId: "default", ...parameters } });

function spies() {
  const converse = vi.fn(async () => undefined);
  const openRouter = vi.fn(async () => undefined);
  const directProvider = vi.fn(async () => undefined);
  return { converse, openRouter, directProvider, checks: () => passingChecks({ converse, openRouter, directProvider }) };
}

describe("the models.e2eAgent config key", () => {

  it("accepts default or a model id, and refuses anything else with what is allowed", () => {
    const entry = configKey("models.e2eAgent");
    expect(entry.parse(" default ")).toBe("default");
    expect(entry.parse(` ${HAIKU_45_GLOBAL} `)).toBe(HAIKU_45_GLOBAL);
    for (const bad of ["", "bad model", "a\"b"]) expect(() => entry.parse(bad), bad).toThrow("models.e2eAgent must be default or a model id; nothing changed");
  });
});

describe("agentx config set models.e2eAgent", () => {

  it("refuses a model Rovara cannot use with the environment's provider and region, before any AWS call", async () => {
    for (const value of ["anthropic.claude-haiku-4-5-20251001-v1:0", "eu.anthropic.claude-haiku-5-5", "claude-haiku-5-5", "us.made-up-v1"]) {
      const cloudFormation = fakeCloudFormation();
      const probe = spies();
      await expect(runConfigSet(services({ store: await seeded(), cloudFormation, stacks: runtimeStack({}), checks: probe.checks }), ENV, { key: "models.e2eAgent", value, yes: true }), value)
        .rejects.toThrow(`models.e2eAgent must be default or a model Rovara can use with Amazon Bedrock in us-east-1; agentx --env staging config set models.e2eAgent default puts the recommendation back; nothing changed`);
      expect(cloudFormation.calls, value).toEqual([]);
      expect(probe.converse).not.toHaveBeenCalled();
    }
  });

  it("holds a keyed provider's environment to that provider's models", async () => {
    const store = await seeded();
    const settings = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...settings, models: { ...settings.models, providers: { orchestrator: "anthropic", classifier: "anthropic", worker: "anthropic" } } });
    const refused = fakeCloudFormation();
    await expect(runConfigSet(services({ store, cloudFormation: refused, stacks: runtimeStack({}) }), ENV, { key: "models.e2eAgent", value: HAIKU_45_US, yes: true }))
      .rejects.toThrow("models.e2eAgent must be default or a model Rovara can use with Anthropic in us-east-1; agentx --env staging config set models.e2eAgent default puts the recommendation back; nothing changed");
    expect(refused.calls).toEqual([]);
    const accepted = fakeCloudFormation({ parameters: { E2eAgentModelId: "default" } });
    expect((await runConfigSet(services({ store, cloudFormation: accepted, stacks: runtimeStack({}) }), ENV, { key: "models.e2eAgent", value: "claude-haiku-4-5", yes: true })).changed).toBe(true);
  });

  it("puts the recommendation back with default, and says nothing changed when it is already so", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { E2eAgentModelId: HAIKU_45_GLOBAL } });
    const reset = services({ store, cloudFormation, stacks: runtimeStack({ E2eAgentModelId: HAIKU_45_GLOBAL }) });
    expect((await runConfigSet(reset, ENV, { key: "models.e2eAgent", value: "default", yes: true })).changed).toBe(true);
    expect(reset.lines).toContain(`models.e2eAgent: E2eAgentModelId ${HAIKU_45_GLOBAL} -> default on agentx-staging-runtime`);
    const same = services({ store, cloudFormation: fakeCloudFormation(), stacks: runtimeStack({}) });
    expect((await runConfigSet(same, ENV, { key: "models.e2eAgent", value: "default", yes: true })).changed).toBe(false);
    expect(same.lines).toContain("models.e2eAgent is already default; nothing to change");
  });

});
