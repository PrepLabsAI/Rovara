// Spec 025 E16, FR-041: which confirmation methods the environment allows, and how an admin turns the pop-up off.
import { describe, expect, it } from "vitest";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { developerIdentityConfigFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { httpEvent, identityHarness } from "../support/developer-fakes.js";

describe("the environment's confirmation methods (FR-041)", () => {
  it("reports the pop-up on by default, and Slack when a team is set up", async () => {
    const harness = identityHarness({});
    expect(JSON.parse((await harness.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ confirm: { elicitation: true, slack: true } });
    const noTeam = identityHarness({ teamId: undefined });
    expect(JSON.parse((await noTeam.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ confirm: { elicitation: true, slack: false } });
  });

  // Controller ruling R5: the Slack Confirm button needs the team, not Slack sign-in (FR-041 matches the admin's verified email to one Slack user of the team).
  it("reports Slack whenever a team is set up, whatever Slack sign-in says", async () => {
    const signInOff = identityHarness({ slack: false });
    expect(JSON.parse((await signInOff.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ methods: { slack: false }, confirm: { elicitation: true, slack: true } });
    const signInOffNoTeam = identityHarness({ slack: false, teamId: undefined });
    expect(JSON.parse((await signInOffNoTeam.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ confirm: { elicitation: true, slack: false } });
  });

  it("reads the switch from the environment", () => {
    const base = { AGENTX_ENV: "live25e", DEVELOPER_TOKEN_ISSUER: "https://x/v1/auth" };
    expect(developerIdentityConfigFromEnvironment({ ...base, MCP_CONFIRM_ELICITATION: "disabled" })).toMatchObject({ confirmElicitation: false });
    expect(developerIdentityConfigFromEnvironment(base)).not.toHaveProperty("confirmElicitation");
    expect(developerIdentityConfigFromEnvironment({ ...base, MCP_CONFIRM_ELICITATION: "enabled" })).not.toHaveProperty("confirmElicitation");
  });
});

describe("agentx config set mcp.confirmElicitation (E16, Q1)", () => {
  it("is a control-plane stack parameter that upgrades keep", () => {
    const entry = configKey("mcp.confirmElicitation");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "McpConfirmElicitation" });
    expect(entry.parse("disabled")).toBe("disabled");
    expect(() => entry.parse("off")).toThrow("mcp.confirmElicitation must be one of enabled, disabled; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("McpConfirmElicitation");
  });
});
