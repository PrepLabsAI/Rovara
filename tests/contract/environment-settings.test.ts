import { describe, expect, it } from "vitest";
import { EnvironmentSettingsSchema, LEGACY_SETTINGS_KEYS, readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
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
  models: { orchestrator: "us.anthropic.claude-haiku-4-5-20251001-v1:0", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
  updatedAt: "2026-09-26T00:00:00.000Z",
};

describe("environment settings", () => {
  it("uses the shared fixture", () => {
    expect(stagingSettings).toEqual(expectedFixture);
  });

  it("refuses settings whose env does not match the parameter's environment", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify({ ...stagingSettings, env: "production" }));
    await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  describe("the old monolith's legacy keys (cloud, cloudSignIn)", () => {
    const legacy = { ...stagingSettings, cloud: { enabled: true, gatewayUrl: "https://gw.example.com" }, cloudSignIn: { mode: "hosted" } };

    it("are exactly cloud and cloudSignIn", () => {
      expect(LEGACY_SETTINGS_KEYS).toEqual(["cloud", "cloudSignIn"]);
    });

    it("every other unknown key is still refused, naming it", async () => {
      const store = new MemoryParameterStore();
      for (const key of ["cloudGateway", "Cloud", "signIn", "cloud_sign_in"]) {
        store.values.set("/agentx/staging/settings", JSON.stringify({ ...legacy, [key]: {} }));
        await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      }
      // The schema itself never accepts them, so a write can never store them.
      expect(EnvironmentSettingsSchema.safeParse(legacy).success).toBe(false);
      await expect(writeEnvironmentSettings(store, legacy as EnvironmentSettings)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("a write that fails reports nothing", async () => {
      const store = new MemoryParameterStore();
      store.values.set("/agentx/staging/settings", JSON.stringify(legacy));
      const failing = { ...store, get: store.get.bind(store), put: async () => { throw new Error("ssm down"); }, delete: store.delete.bind(store), list: store.list.bind(store) };
      const reported: string[][] = [];
      await expect(writeEnvironmentSettings(failing, stagingSettings, { onLegacyKeysDropped: (keys) => reported.push(keys) })).rejects.toThrow("ssm down");
      expect(reported).toEqual([]);
    });
  });
});
