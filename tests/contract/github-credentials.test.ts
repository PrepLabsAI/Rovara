import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createGitHubAppCredentials } from "../../packages/broker/src/aws/github-credentials.js";


/** A Secrets Manager double whose secret text can change between reads; counts the reads. */
function fixture(initial: Record<string, unknown>) {
  const state = { current: initial, reads: 0 };
  const client = {
    send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      state.reads += 1;
      return { SecretString: JSON.stringify(state.current) };
    }),
  };
  return { state, credentials: createGitHubAppCredentials(client as never) };
}

describe("GitHub App credentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf");
    vi.stubEnv("GITHUB_APP_CREDENTIAL_REF", "github-app");
    vi.stubEnv("GITHUB_APP_ID", "12345");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("gives the core's code host the same App from the same secret, read once (lane L1b)", async () => {
    const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const { state, credentials } = fixture({ appId: "12345", privateKey: PEM });
    expect(credentials.clientOptions.credentialRef).toBe("github-app");
    expect(credentials.clientOptions.appId).toBe("12345");
    await expect(credentials.clientOptions.getPrivateKey()).resolves.toBe(PEM);
    await expect(credentials.clientOptions.getPrivateKey()).resolves.toBe(PEM);
    expect(JSON.parse(await credentials.clientOptions.getAppSecret())).toEqual({ appId: "12345", privateKey: PEM });
    expect(state.reads).toBe(1);
    // A refresh re-reads the secret (spaced like the webhook key's re-reads).
    state.current = { appId: "12345", privateKey: `${PEM}\n` };
    expect(JSON.parse(await credentials.clientOptions.getAppSecret({ refresh: true }))).toEqual({ appId: "12345", privateKey: `${PEM}\n` });
    expect(state.reads).toBe(2);
  });

  it("throttles re-reads to once per 30 seconds", async () => {
    const { state, credentials } = fixture({ appId: "12345", privateKey: "pem" });
    await expect(credentials.webhookSecret()).rejects.toThrow();
    const afterFirst = state.reads;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(credentials.webhookSecret()).rejects.toThrow();
      await expect(credentials.webhookSecret({ refresh: true })).rejects.toThrow();
    }
    expect(state.reads).toBe(afterFirst);

    vi.advanceTimersByTime(30_000);
    await expect(credentials.webhookSecret({ refresh: true })).rejects.toThrow();
    expect(state.reads).toBe(afterFirst + 1);
  });

});
