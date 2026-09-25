import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENVIRONMENT,
  EnvironmentNameSchema,
  STACK_PARTS,
  environmentConnectorSecretPrefix,
  environmentSettingsPrefix,
  environmentStackName,
} from "@agentx/contracts";

describe("environment names", () => {
  it.each(["production", "staging", "dev-2", "a", "a1", "abcdefghijklmnopqrst"])("accepts %s", (name) => {
    expect(EnvironmentNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(["", "Prod", "prod-", "-prod", "1prod", "pro_d", "pro.d", "a--b", "abcdefghijklmnopqrstu", "prod/x"])(
    "refuses %j",
    (name) => {
      expect(EnvironmentNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it("defaults to production", () => {
    expect(DEFAULT_ENVIRONMENT).toBe("production");
  });

  it("names stacks, settings and connector secrets with the environment", () => {
    expect(STACK_PARTS).toEqual(["foundation", "runtime", "control-plane", "slack"]);
    expect(environmentStackName("staging", "control-plane")).toBe("agentx-staging-control-plane");
    expect(environmentSettingsPrefix("staging")).toBe("/agentx/staging/");
    expect(environmentConnectorSecretPrefix("staging")).toBe("agentx/staging/connectors/");
  });

  it("refuses to build a name from an invalid environment", () => {
    expect(() => environmentStackName("Bad", "slack")).toThrow(/environment name/);
    expect(() => environmentSettingsPrefix("a--b")).toThrow(/environment name/);
  });
});
