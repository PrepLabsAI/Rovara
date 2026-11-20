// Spec 025 E16, FR-041: which confirmation methods the environment allows, and how an admin turns the pop-up off.
import { describe, expect, it } from "vitest";
import { developerIdentityConfigFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";

describe("the environment's confirmation methods (FR-041)", () => {

  it("reads the switch from the environment", () => {
    const base = { AGENTX_ENV: "live25e", DEVELOPER_TOKEN_ISSUER: "https://x/v1/auth" };
    expect(developerIdentityConfigFromEnvironment({ ...base, MCP_CONFIRM_ELICITATION: "disabled" })).toMatchObject({ confirmElicitation: false });
    expect(developerIdentityConfigFromEnvironment(base)).not.toHaveProperty("confirmElicitation");
    expect(developerIdentityConfigFromEnvironment({ ...base, MCP_CONFIRM_ELICITATION: "enabled" })).not.toHaveProperty("confirmElicitation");
  });
});

