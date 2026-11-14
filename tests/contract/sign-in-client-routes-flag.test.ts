// Spec 065: a registered service's /v1/dev/client/* routes are OFF unless the deployed broker sets
// SIGN_IN_CLIENT_ROUTES to exactly "enabled" (developerConfiguration() in the broker entry). Only the value "enabled"
// opens them: unset, empty, "true", "disabled" and anything else leave them as 404, so a typo or a lookalike never opens them.
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "us-east-1",
  STATE_TABLE_NAME: "unused",
  ARTIFACT_BUCKET_NAME: "unused",
  OIDC_ISSUER: "https://identity.example.test",
  CALLBACK_SIGNING_KEY: "c".repeat(64),
  GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:test",
  GITHUB_APP_CREDENTIAL_REF: "github-app",
  GITHUB_APP_ACCOUNT: "example",
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  DEVELOPER_TOKEN_ISSUER: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth",
  DEVELOPER_IDENTITY_FUNCTION_ARN: "developer-identity",
  DEVELOPER_SIGNIN_TABLE_NAME: "signin",
  DEVELOPER_OIDC_ISSUER: "https://idp.example.test",
  AGENTX_ENV: "staging",
};

/** The real broker entry, loaded fresh with the flag set (or unset), and the status an unsigned client route answers. */
async function clientRouteStatus(flag: string | undefined): Promise<number> {
  vi.resetModules();
  for (const [name, value] of Object.entries(BASE_ENVIRONMENT)) vi.stubEnv(name, value);
  vi.stubEnv("SIGN_IN_CLIENT_ROUTES", flag);
  const { handler } = await import("../../packages/broker/src/aws/broker.js");
  const response = await handler({
    version: "2.0", rawPath: "/v1/dev/client/repositories", headers: {},
    requestContext: { requestId: "r", http: { method: "GET" } },
  });
  return response.statusCode;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the sign-in client routes flag on the deployed broker (spec 065)", () => {
  it("opens the client routes only for exactly \"enabled\": they then ask for the person's token (401) instead of answering 404", async () => {
    expect(await clientRouteStatus("enabled")).toBe(401);
  });

  it.each([undefined, "", "true", "disabled", "ENABLED", "1"])("leaves the client routes off (404) when the flag is %j", async (flag) => {
    expect(await clientRouteStatus(flag)).toBe(404);
  });
});
