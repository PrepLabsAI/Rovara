import { describe, expect, it } from "vitest";
import {
  AGENTX_CLI_CLIENT_ID,
  AgentXConfigurationSchema,
  ChannelMembersRequestSchema,
  DEVELOPER_API_VERSION,
  DEVELOPER_TOKEN_AUDIENCE,
  DeveloperProjectsResponseSchema,
  DeveloperTokenResponseSchema,
  apiVersionCompatible,
  developerIssuer,
  isLoopbackRedirectUri,
} from "@agentx/contracts";

const configuration = {
  env: "staging",
  apiVersion: "1.0",
  issuer: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth",
  authorizationEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/authorize",
  tokenEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/token",
  revocationEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/revoke",
  clientId: "agentx-cli",
  methods: { slack: true, oidc: { displayName: "Okta" } },
};

describe("developer sign-in contracts", () => {
  it("names the public client, audience and API version", () => {
    expect([AGENTX_CLI_CLIENT_ID, DEVELOPER_TOKEN_AUDIENCE, DEVELOPER_API_VERSION]).toEqual(["agentx-cli", "agentx-developer", "1.1"]);
  });

  it.each([
    ["http://127.0.0.1:8765/callback", true],
    ["http://127.0.0.1:1/callback", true],
    ["http://127.0.0.1:65535/callback", true],
    ["http://127.0.0.1:65536/callback", false],
    ["http://127.0.0.1:0/callback", false],
    ["http://127.0.0.1:08765/callback", false],
    ["http://localhost:8765/callback", false],
    ["https://127.0.0.1:8765/callback", false],
    ["http://127.0.0.1:8765/callback/", false],
    ["http://127.0.0.1:8765/callback?x=1", false],
    ["http://127.0.0.1:8765/other", false],
    ["http://127.0.0.1.evil.test:8765/callback", false],
    ["http://[::1]:8765/callback", false],
  ])("accepts only loopback callbacks on 127.0.0.1: %s is %s", (uri, expected) => {
    expect(isLoopbackRedirectUri(uri)).toBe(expected);
  });

  it("derives the issuer from the API endpoint, with or without a trailing slash", () => {
    expect(developerIssuer("https://abc.execute-api.us-east-1.amazonaws.com")).toBe("https://abc.execute-api.us-east-1.amazonaws.com/v1/auth");
    expect(developerIssuer("https://abc.execute-api.us-east-1.amazonaws.com/")).toBe("https://abc.execute-api.us-east-1.amazonaws.com/v1/auth");
  });

  it("compares API versions by major (refuse) and minor (notice)", () => {
    expect(apiVersionCompatible("1.0", "1.0")).toEqual({ compatible: true, upgradeNotice: false });
    expect(apiVersionCompatible("1.3", "1.0")).toEqual({ compatible: true, upgradeNotice: true });
    expect(apiVersionCompatible("1.0", "1.3")).toEqual({ compatible: true, upgradeNotice: false });
    expect(apiVersionCompatible("2.0", "1.9")).toEqual({ compatible: false, upgradeNotice: true });
    expect(apiVersionCompatible("garbage", "1.0")).toEqual({ compatible: false, upgradeNotice: true });
  });

  it("parses the agentx configuration and ignores fields a newer control plane adds", () => {
    const parsed = AgentXConfigurationSchema.parse({ ...configuration, confirm: { elicitation: true } });
    expect(parsed).toEqual(configuration);
    expect(AgentXConfigurationSchema.safeParse({ ...configuration, clientId: "other" }).success).toBe(false);
    expect(AgentXConfigurationSchema.safeParse({ ...configuration, methods: { slack: false, oidc: null } }).success).toBe(true);
  });

  it("parses a token response and refuses one without a refresh token", () => {
    const token = { access_token: "a.b.c", token_type: "Bearer", expires_in: 3600, refresh_token: `agxr_${"x".repeat(43)}` };
    expect(DeveloperTokenResponseSchema.parse(token)).toEqual(token);
    expect(DeveloperTokenResponseSchema.safeParse({ ...token, refresh_token: undefined }).success).toBe(false);
  });

  it("parses the projects response", () => {
    const response = {
      developer: { id: "a".repeat(64), name: "Maya Chen", provider: "slack", slackUserId: "U0123ABCD" },
      projects: [{ name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0123ABCD" }] }],
      notices: [],
    };
    expect(DeveloperProjectsResponseSchema.parse(response)).toEqual(response);
    expect(DeveloperProjectsResponseSchema.safeParse({ ...response, notices: ["slack_unavailable"] }).success).toBe(true);
  });

  it("bounds the channel-members invoke", () => {
    expect(ChannelMembersRequestSchema.safeParse({ kind: "channel-members", slackUserId: "U0123ABCD", channelIds: ["C0123ABCD"] }).success).toBe(true);
    expect(ChannelMembersRequestSchema.safeParse({ kind: "channel-members", slackUserId: "U0123ABCD", channelIds: Array.from({ length: 501 }, () => "C0123ABCD") }).success).toBe(false);
    expect(ChannelMembersRequestSchema.safeParse({ kind: "channel-members", slackUserId: "not-a-user", channelIds: [] }).success).toBe(false);
  });
});
