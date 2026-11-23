// Webhook lane W3: where the broker's webhook HMAC key comes from. The DEDICATED secret (GITHUB_WEBHOOK_SECRET_ID) once it has a value; the App secret's webhookSecret key ONLY while the
// dedicated secret has no value (not found); never on a throttle, an access or a network error; never both at once; a short value in the dedicated secret is "not configured", not a
// reason to fall back; a missing or failing secret costs at most one read per 30 seconds however many requests arrive; nothing secret reaches an error or a log line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createGitHubAppCredentials } from "../../packages/broker/src/aws/github-credentials.js";
import { isWebhookSecretMissing } from "../../packages/broker/src/github-app.js";

const APP_SECRET_ID = "arn:aws:secretsmanager:us-west-2:123456789012:secret:agentx/staging/github-app-AbCdEf";
const DEDICATED_ID = "agentx/staging/github-webhook-secret";
const OLD = "old-app-json-webhook-secret-".padEnd(48, "o");
const NEW = "dedicated-webhook-secret-".padEnd(64, "n");
const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";

type Reply = { SecretString: string } | { error: string } | "empty";
function world(replies: { app: Reply; dedicated: Reply }) {
  const state = { ...replies, reads: [] as string[] };
  const client = {
    send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      const id = (command as { input: { SecretId: string } }).input.SecretId;
      state.reads.push(id);
      const reply = id === DEDICATED_ID ? state.dedicated : state.app;
      if (reply === "empty") throw Object.assign(new Error(`Secrets Manager can't find the specified secret value for ${id}`), { name: "ResourceNotFoundException" });
      if ("error" in reply) throw Object.assign(new Error(`${reply.error} while reading ${id} with ${OLD} ${NEW}`), { name: reply.error });
      return { SecretString: reply.SecretString };
    }),
  };
  const lines: Array<Record<string, unknown>> = [];
  return { state, lines, credentials: createGitHubAppCredentials(client as never, (entry) => { lines.push(entry); }) };
}
const appJson = (webhookSecret?: string) => ({ SecretString: JSON.stringify({ appId: "12345", privateKey: PEM, ...(webhookSecret === undefined ? {} : { webhookSecret }) }) });

describe("the broker's webhook secret source", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_SECRET_ARN", APP_SECRET_ID);
    vi.stubEnv("GITHUB_APP_CREDENTIAL_REF", "github-app");
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET_ID", DEDICATED_ID);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("uses the dedicated secret once it has a value, and never reads the App secret for it", async () => {
    const { credentials, state } = world({ app: appJson(OLD), dedicated: { SecretString: `${NEW}\n` } });
    await expect(credentials.webhookSecret()).resolves.toBe(NEW);
    await expect(credentials.webhookSecret()).resolves.toBe(NEW);
    expect(state.reads).toEqual([DEDICATED_ID]);
  });

  it("falls back to the App secret's key only while the dedicated secret has no value", async () => {
    const { credentials, state } = world({ app: appJson(OLD), dedicated: "empty" });
    await expect(credentials.webhookSecret()).resolves.toBe(OLD);
    expect(state.reads).toEqual([DEDICATED_ID, APP_SECRET_ID]);
  });

  it("picks the dedicated value up on the next refresh after the owner sets it, and then answers with it alone (never two secrets)", async () => {
    const { credentials, state } = world({ app: appJson(OLD), dedicated: "empty" });
    await expect(credentials.webhookSecret()).resolves.toBe(OLD);
    state.dedicated = { SecretString: NEW };
    // Inside the interval a refresh serves the copy it has.
    await expect(credentials.webhookSecret({ refresh: true })).resolves.toBe(OLD);
    vi.advanceTimersByTime(30_000);
    await expect(credentials.webhookSecret({ refresh: true })).resolves.toBe(NEW);
    vi.advanceTimersByTime(30_000);
    await expect(credentials.webhookSecret({ refresh: true })).resolves.toBe(NEW);
    await expect(credentials.webhookSecret()).resolves.toBe(NEW);
  });

  it.each(["ThrottlingException", "AccessDeniedException", "InternalServiceError", "TimeoutError"])("never falls back to the App secret on %s: the receiver is not configured, and the error names no secret", async (name) => {
    const { credentials, state } = world({ app: appJson(OLD), dedicated: { error: name } });
    const failure = await credentials.webhookSecret().then(() => undefined, (error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(OLD);
    expect(String(failure)).not.toContain(NEW);
    expect(String(failure)).not.toContain(DEDICATED_ID);
    expect(JSON.stringify(failure)).not.toContain(name === "TimeoutError" ? "never" : OLD);
    expect(state.reads).toEqual([DEDICATED_ID]);
  });

  it.each([["too short", "short-value"], ["whitespace", "   \n  "], ["too long", "x".repeat(4_097)]])("treats a dedicated value that is %s as not configured, never a reason to fall back", async (_label, value) => {
    const { credentials, state } = world({ app: appJson(OLD), dedicated: { SecretString: value } });
    const failure = await credentials.webhookSecret().then(() => undefined, (error: unknown) => error);
    expect(isWebhookSecretMissing(failure)).toBe(true);
    expect(state.reads).toEqual([DEDICATED_ID]);
  });

  it("with the variable unset, behaves as before (the App secret's key) and says so once", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET_ID", "");
    const { credentials, state, lines } = world({ app: appJson(OLD), dedicated: { SecretString: NEW } });
    await expect(credentials.webhookSecret()).resolves.toBe(OLD);
    await credentials.webhookSecret();
    expect(state.reads).toEqual([APP_SECRET_ID]);
    expect(lines).toEqual([{ event: "github_webhook.secret_source", source: "app_secret_dedicated_not_wired" }]);
  });

  it("tells, once per change and in fixed words, which source answers", async () => {
    const { credentials, state, lines } = world({ app: appJson(OLD), dedicated: "empty" });
    await credentials.webhookSecret();
    await credentials.webhookSecret();
    state.dedicated = { SecretString: NEW };
    vi.advanceTimersByTime(30_000);
    await credentials.webhookSecret({ refresh: true });
    expect(lines).toEqual([{ event: "github_webhook.secret_source", source: "app_secret" }, { event: "github_webhook.secret_source", source: "dedicated" }]);
    expect(JSON.stringify(lines)).not.toContain(NEW);
    expect(JSON.stringify(lines)).not.toContain(OLD);
  });

  it("costs at most one resolution per 30 seconds for any number of forged requests while the secret is missing, erroring or unusable", async () => {
    for (const dedicated of ["empty", { error: "ThrottlingException" }, { SecretString: "short" }] as const) {
      const { credentials, state } = world({ app: appJson(), dedicated });
      const attempt = () => Promise.all(Array.from({ length: 100 }, async (_, index) => { await credentials.webhookSecret(index % 2 === 0 ? { refresh: true } : undefined).catch(() => undefined); }));
      await attempt();
      const first = state.reads.length;
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(3);
      await attempt();
      expect(state.reads.length).toBe(first);
      vi.advanceTimersByTime(30_000);
      await attempt();
      expect(state.reads.length).toBeGreaterThan(first);
      expect(state.reads.length).toBeLessThanOrEqual(first * 2);
    }
  });

  it("serves a good value from the cache and re-reads at most once per 30 seconds on a refresh (a rotation takes effect on the first bad signature after the interval)", async () => {
    const { credentials, state } = world({ app: appJson(OLD), dedicated: { SecretString: NEW } });
    await credentials.webhookSecret();
    for (let attempt = 0; attempt < 10; attempt += 1) await credentials.webhookSecret({ refresh: true });
    expect(state.reads).toEqual([DEDICATED_ID]);
    state.dedicated = { SecretString: "rotated-webhook-secret-".padEnd(64, "r") };
    vi.advanceTimersByTime(30_000);
    await expect(credentials.webhookSecret({ refresh: true })).resolves.toBe("rotated-webhook-secret-".padEnd(64, "r"));
    expect(state.reads).toEqual([DEDICATED_ID, DEDICATED_ID]);
  });
});
