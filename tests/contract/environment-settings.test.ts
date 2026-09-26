import { describe, expect, it } from "vitest";
import { EnvironmentSettingsSchema, listEnvironments, readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

// tests/support/environment-fixtures.ts holds exactly this value:
const expectedFixture: EnvironmentSettings = {
  schemaVersion: 1,
  env: "staging",
  account: "123456789012",
  region: "us-east-1",
  engine: "templates",
  version: "1.0.0",
  naming: "environment",
  stacks: { foundation: "agentx-staging-foundation", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
  controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
  identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", audience: "client", clientId: "client" },
  models: { orchestrator: "us.anthropic.claude-haiku-4-5-20251001-v1:0", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  updatedAt: "2026-09-26T00:00:00.000Z",
};

describe("environment settings", () => {
  it("uses the shared fixture", () => {
    expect(stagingSettings).toEqual(expectedFixture);
  });

  it("round-trips through /agentx/<env>/settings", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    expect(settingsParameterName("staging")).toBe("/agentx/staging/settings");
    expect(store.values.has("/agentx/staging/settings")).toBe(true);
    expect(await readEnvironmentSettings(store, "staging")).toEqual(stagingSettings);
  });

  it("returns undefined for an environment that does not exist", async () => {
    expect(await readEnvironmentSettings(new MemoryParameterStore(), "staging")).toBeUndefined();
  });

  it("refuses stored settings that do not match the schema, naming the environment", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify({ ...stagingSettings, engine: "terraform" }));
    await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("staging") as unknown });
  });

  it("refuses stored settings that are not valid JSON, naming the environment", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", "not json");
    await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("staging") as unknown,
    });
  });

  it("refuses settings whose env does not match the parameter's environment", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify({ ...stagingSettings, env: "production" }));
    await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses to write invalid settings", async () => {
    const store = new MemoryParameterStore();
    await expect(writeEnvironmentSettings(store, { ...stagingSettings, account: "12" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(store.values.size).toBe(0);
  });

  it("never stores a field outside the schema", () => {
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, slackBotToken: "xoxb-1" }).success).toBe(false);
  });

  it("round-trips settings with an identity stack", async () => {
    const store = new MemoryParameterStore();
    const withIdentity: EnvironmentSettings = { ...stagingSettings, stacks: { ...stagingSettings.stacks, identity: "agentx-staging-identity" } };
    await writeEnvironmentSettings(store, withIdentity);
    expect(await readEnvironmentSettings(store, "staging")).toEqual(withIdentity);
  });

  it("still parses settings with no identity stack (the legacy fixture)", () => {
    expect(EnvironmentSettingsSchema.safeParse(stagingSettings).success).toBe(true);
    expect(stagingSettings.stacks.identity).toBeUndefined();
  });

  it("round-trips settings with an access block", async () => {
    const store = new MemoryParameterStore();
    const withAccess: EnvironmentSettings = {
      ...stagingSettings,
      access: {
        artifactBucket: "agentx-staging-access-artifactbucket-abc",
        cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
        operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator",
        pullThroughPrefix: "agentx-staging",
        permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/agentx-boundary",
      },
    };
    await writeEnvironmentSettings(store, withAccess);
    expect(await readEnvironmentSettings(store, "staging")).toEqual(withAccess);
  });

  it("still parses settings with no access block (the legacy fixture)", () => {
    expect(EnvironmentSettingsSchema.safeParse(stagingSettings).success).toBe(true);
    expect(stagingSettings.access).toBeUndefined();
  });

  it("never stores an access field outside its own schema", () => {
    const withUnknownAccessField = {
      ...stagingSettings,
      access: {
        artifactBucket: "b",
        cloudFormationRoleArn: "arn:aws:iam::123456789012:role/r",
        operatorRoleArn: "arn:aws:iam::123456789012:role/o",
        pullThroughPrefix: "p",
        extra: "nope",
      },
    };
    expect(EnvironmentSettingsSchema.safeParse(withUnknownAccessField).success).toBe(false);
  });

  const validAccess = {
    artifactBucket: "agentx-staging-access-artifactbucket-abc",
    cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
    operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator",
    pullThroughPrefix: "agentx-staging",
  };

  it("refuses an access block whose role or boundary fields are not the right kind of ARN", () => {
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, access: validAccess }).success).toBe(true);
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, access: { ...validAccess, cloudFormationRoleArn: "not-an-arn" } }).success).toBe(false);
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, access: { ...validAccess, operatorRoleArn: "arn:aws:iam::123456789012:policy/wrong-resource-type" } }).success).toBe(false);
    expect(
      EnvironmentSettingsSchema.safeParse({ ...stagingSettings, access: { ...validAccess, permissionsBoundaryArn: "arn:aws:iam::123456789012:role/wrong-resource-type" } }).success,
    ).toBe(false);
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, access: { ...validAccess, artifactBucket: "" } }).success).toBe(false);
  });

  it("refuses an access block with an empty pullThroughPrefix", () => {
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, access: { ...validAccess, pullThroughPrefix: "" } }).success).toBe(false);
  });

  it("lists environments that have settings", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    await writeEnvironmentSettings(store, { ...stagingSettings, env: "production", stacks: { ...stagingSettings.stacks } });
    store.values.set("/agentx/orphan/lock", "{}");
    expect(await listEnvironments(store)).toEqual(["production", "staging"]);
  });
});
