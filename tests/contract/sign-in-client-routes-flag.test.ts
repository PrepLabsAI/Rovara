// DEC 254zzz81 (owner, 2026-11-18): the SIGN_IN_CLIENT_ROUTES switch is DELETED. A registered service's /v1/dev/client/* routes are always on in the deployed broker entry; every one
// checks the client's token, its route scope and the person's live company and role (the route tests: project-setup-status-routes, project-code-settings-routes, project-lifecycle-routes, client-repositories-company, company-reads-mount). No value of the old variable,
// set or packed, turns them off any more: an unsigned request is refused for its missing token (401), never answered "route not found" (404).
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCallbackSigningKeySecret } from "../support/callback-key.js";

const BASE_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "us-east-1",
  STATE_TABLE_NAME: "unused",
  ARTIFACT_BUCKET_NAME: "unused",
  OIDC_ISSUER: "https://identity.example.test",
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

/** The real broker entry, loaded fresh with the old variable set (or unset), and the status an unsigned client route answers. */
async function clientRouteStatus(flag: string | undefined): Promise<number> {
  vi.resetModules();
  for (const [name, value] of Object.entries(BASE_ENVIRONMENT)) vi.stubEnv(name, value);
  vi.stubEnv("SIGN_IN_CLIENT_ROUTES", flag);
  // The broker reads its callback signing key from Secrets Manager on its first request; a fresh module registry means a fresh copy of the loader, so stub after the reset.
  const secret = stubCallbackSigningKeySecret();
  const { handler } = await import("../../packages/broker/src/aws/broker.js");
  const response = await handler({
    version: "2.0", rawPath: "/v1/dev/client/repositories", headers: {},
    requestContext: { requestId: "r", http: { method: "GET" } },
  });
  secret.restore();
  return response.statusCode;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the sign-in client routes on the deployed broker (DEC 254zzz81: always on)", () => {
  it.each([undefined, "", "disabled", "enabled", "0"])("are served whatever the old variable says (%j): they ask for the person's token (401), never 404", async (flag) => {
    expect(await clientRouteStatus(flag)).toBe(401);
  });
});
