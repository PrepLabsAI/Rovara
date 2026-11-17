// Where a deployed function gets the callback signing key: from its one secret, once per container, and never without it. The broker and the reconciler's sweeps are driven for real
// (their entry modules, with Secrets Manager stubbed); the dispatcher's and the eval tick's own tests drive theirs.
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALLBACK_SIGNING_KEY_SECRET_VARIABLE, CALLBACK_SIGNING_KEY_UNAVAILABLE } from "../../packages/broker/src/aws/callback-signing-key.js";
import { stubCallbackSigningKeySecret, TEST_CALLBACK_SIGNING_KEY_SECRET_ID } from "../support/callback-key.js";

const KEY = "kk-broker-signing-key-0123456789-abcdefghijklmnopqrstuvwxyz";
const BROKER_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "us-east-1", STATE_TABLE_NAME: "unused", ARTIFACT_BUCKET_NAME: "unused", OIDC_ISSUER: "https://identity.example.test",
  GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:test", GITHUB_APP_CREDENTIAL_REF: "github-app",
  GITHUB_APP_ACCOUNT: "example", GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456",
};
const unknownRoute = { version: "2.0", rawPath: "/v1/no-such-route", headers: {}, requestContext: { requestId: "r", http: { method: "GET" } } };

async function freshBroker() {
  vi.resetModules();
  for (const [name, value] of Object.entries(BROKER_ENVIRONMENT)) vi.stubEnv(name, value);
  return (await import("../../packages/broker/src/aws/broker.js")) as unknown as { handler: (event: unknown) => Promise<{ statusCode: number; body: string }> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the deployed broker's callback signing key", () => {
  it("loads without the key and without a secret, and refuses every request until the key is read (fail closed)", async () => {
    vi.stubEnv("CALLBACK_SIGNING_KEY", KEY);
    const send = vi.spyOn(SecretsManagerClient.prototype, "send");
    const { handler } = await freshBroker();
    // Nothing named the secret: no request is served, and the plain variable is not a way around that.
    const failure = await handler(unknownRoute).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect(send).not.toHaveBeenCalled();
    expect(`${(failure as Error).stack ?? ""}`).not.toContain(KEY);
  });

  it("refuses every request when the secret cannot be read, says nothing of why, and reads again on the next request", async () => {
    const { handler } = await freshBroker();
    vi.stubEnv(CALLBACK_SIGNING_KEY_SECRET_VARIABLE, TEST_CALLBACK_SIGNING_KEY_SECRET_ID);
    let calls = 0;
    const send = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error(`AccessDeniedException on ${TEST_CALLBACK_SIGNING_KEY_SECRET_ID}`), { name: "AccessDeniedException" });
      return { SecretString: KEY };
    }) as never);
    const failure = await handler(unknownRoute).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toBe(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect((failure as Error).message).not.toContain(TEST_CALLBACK_SIGNING_KEY_SECRET_ID);
    // The next request reads again and, with the key, is served (an unknown route is a 404, as for any request that got past the gate).
    expect((await handler(unknownRoute)).statusCode).toBeGreaterThanOrEqual(400);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("refuses when the secret holds less than 32 bytes", async () => {
    const { handler } = await freshBroker();
    stubCallbackSigningKeySecret("short");
    await expect(handler(unknownRoute)).rejects.toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
  });

  it("reads exactly the named secret, once for the container, then serves from memory", async () => {
    const { handler } = await freshBroker();
    const secret = stubCallbackSigningKeySecret(KEY);
    await Promise.all([handler(unknownRoute), handler(unknownRoute)]);
    await handler(unknownRoute);
    expect(secret.reads).toEqual([{ SecretId: TEST_CALLBACK_SIGNING_KEY_SECRET_ID }]);
  });
});
