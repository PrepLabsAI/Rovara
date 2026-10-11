import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createGitHubAppCredentials } from "../../packages/broker/src/aws/github-credentials.js";

const WEBHOOK_SECRET = "w".repeat(40);
const NEWER_WEBHOOK_SECRET = "n".repeat(40);

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

  it("re-reads the App secret when the cached copy has no webhook secret", async () => {
    const { state, credentials } = fixture({ appId: "12345", privateKey: "pem" });
    await expect(credentials.webhookSecret()).rejects.toThrow(/valid webhook secret/);
    expect(state.reads).toBe(2);

    // The secret gains a webhook secret while the container keeps running.
    state.current = { appId: "12345", privateKey: "pem", webhookSecret: WEBHOOK_SECRET };
    vi.advanceTimersByTime(31_000);
    await expect(credentials.webhookSecret()).resolves.toBe(WEBHOOK_SECRET);
    expect(state.reads).toBe(3);

    // Once it holds a valid key the cached copy is used.
    await expect(credentials.webhookSecret()).resolves.toBe(WEBHOOK_SECRET);
    expect(state.reads).toBe(3);
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

  it("returns a changed webhook secret when a refresh is asked for", async () => {
    const { state, credentials } = fixture({ appId: "12345", privateKey: "pem", webhookSecret: WEBHOOK_SECRET });
    await expect(credentials.webhookSecret()).resolves.toBe(WEBHOOK_SECRET);
    state.current = { appId: "12345", privateKey: "pem", webhookSecret: NEWER_WEBHOOK_SECRET };
    await expect(credentials.webhookSecret()).resolves.toBe(WEBHOOK_SECRET);
    await expect(credentials.webhookSecret({ refresh: true })).resolves.toBe(NEWER_WEBHOOK_SECRET);
  });

  it("never puts secret text in the error for a missing webhook secret", async () => {
    const { credentials } = fixture({ appId: "12345", privateKey: "pem-secret-text", webhookSecret: "short" });
    const failure = await credentials.webhookSecret().catch((error: unknown) => error);
    expect(String(failure)).not.toContain("pem-secret-text");
    expect(String(failure)).not.toContain("short");
  });
});
