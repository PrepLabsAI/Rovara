// Webhook lane W3: once the environment's DEDICATED webhook secret has a value (the owner put it there and in GitHub), `agentx upgrade` and `agentx init` must never touch the secret
// again: they send GitHub the hook URL and NO secret, generate nothing, store nothing in the App's secret, and read no secret value to decide (DescribeSecret only). Until the dedicated
// secret has a value, the old behaviour stands (the App secret's key, sent every time).
import { describe, expect, it } from "vitest";
import { githubWebhookSecretName } from "@agentx/contracts";
import { ensureGithubWebhook, storedWebhookSecret } from "../../packages/cli/src/github/webhook-setup.js";
import { GITHUB_WEBHOOK_EVENTS, githubAppSecretName, githubRestApi } from "../../packages/cli/src/init/github-app.js";
import { fakeGitHubApi, memoryInitSecrets, TEST_PRIVATE_KEY } from "../support/init-fakes.js";

const SECRET_ID = githubAppSecretName("staging");
const DEDICATED = githubWebhookSecretName("staging");
const URL = "https://cp.example.test/v1/github/webhooks";
const OWNER_SET = "owner-set-dedicated-secret-".padEnd(48, "d");
const OLD_APP_KEY = "old-app-json-webhook-secret-".padEnd(48, "o");
const BASE = { appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY };

/** Secrets whose every value read is recorded: a read of the dedicated secret's value is a failure of the contract. */
function spiedSecrets(initial: Record<string, string>) {
  const secrets = memoryInitSecrets(initial);
  const valueReads: string[] = [];
  const writes: string[] = [];
  const get = secrets.get.bind(secrets);
  const put = secrets.put.bind(secrets);
  secrets.get = async (name) => { valueReads.push(name); return get(name); };
  secrets.put = async (name, value) => { writes.push(name); return put(name, value); };
  return { secrets, valueReads, writes };
}

describe("ensureGithubWebhook with the dedicated secret holding a value", () => {
  it("sends GitHub the URL only: no secret, not the App secret's old key, not the dedicated one", async () => {
    const { secrets, valueReads, writes } = spiedSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: OLD_APP_KEY }), [DEDICATED]: OWNER_SET });
    const api = fakeGitHubApi({ hookUrl: "https://old.example.test/hook" });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, dedicatedSecretId: DEDICATED, webhookUrl: URL });
    expect(api.hookWrites).toEqual([{ url: URL }]);
    expect(JSON.stringify(api.hookWrites)).not.toContain(OLD_APP_KEY);
    expect(JSON.stringify(api.hookWrites)).not.toContain(OWNER_SET);
    expect(api.hookWrites[0]).not.toHaveProperty("secret");
    expect(outcome).toMatchObject({ secretSource: "dedicated", status: "configured", urlChanged: true });
    // It reads no value at all (the owner's secret is decided by DescribeSecret), and writes nothing.
    expect(valueReads).toEqual([]);
    expect(writes).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(OWNER_SET);
  });

  it("leaves a hook that already points at the control plane alone (no GitHub write at all), and reports it unchanged", async () => {
    const { secrets, writes } = spiedSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: OLD_APP_KEY }), [DEDICATED]: OWNER_SET });
    const api = fakeGitHubApi({ hookUrl: URL });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, dedicatedSecretId: DEDICATED, webhookUrl: URL });
    expect(api.hookWrites).toEqual([]);
    expect(writes).toEqual([]);
    expect(outcome).toMatchObject({ secretSource: "dedicated", status: "unchanged", urlChanged: false });
  });

  it("generates and stores no key in the App's secret, even when that secret has none, and does not even need to read it", async () => {
    const { secrets, valueReads, writes } = spiedSecrets({ [SECRET_ID]: JSON.stringify(BASE), [DEDICATED]: OWNER_SET });
    const api = fakeGitHubApi({ hookUrl: URL });
    await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, dedicatedSecretId: DEDICATED, webhookUrl: URL });
    expect(writes).toEqual([]);
    expect(valueReads).toEqual([]);
    expect(storedWebhookSecret(JSON.parse(secrets.values.get(SECRET_ID)!) as Record<string, unknown>)).toBeUndefined();
  });

  it("still reports the events the App lacks (the new event set), with the settings page", async () => {
    const { secrets } = spiedSecrets({ [SECRET_ID]: JSON.stringify(BASE), [DEDICATED]: OWNER_SET });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi({ hookUrl: URL, events: ["pull_request", "issue_comment"] }), secrets, secretId: SECRET_ID, dedicatedSecretId: DEDICATED, webhookUrl: URL });
    expect(outcome.missingEvents).toEqual(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_suite", "check_run"]);
    expect(GITHUB_WEBHOOK_EVENTS).toEqual(["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment", "check_suite", "check_run"]);
  });
});

describe("ensureGithubWebhook while the dedicated secret has no value", () => {
  it("keeps the old behaviour: the App secret's key is sent every time", async () => {
    const { secrets } = spiedSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: OLD_APP_KEY }) });
    // The stack creates the slot empty: it exists, it has no value.
    await secrets.reserve(DEDICATED);
    const api = fakeGitHubApi({ hookUrl: URL });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, dedicatedSecretId: DEDICATED, webhookUrl: URL });
    expect(api.hookWrites).toEqual([{ url: URL, secret: OLD_APP_KEY }]);
    expect(outcome).toMatchObject({ secretSource: "app-secret", status: "unchanged" });
  });

  it("with no dedicated name at all (an older caller), behaves exactly as before and stores a generated key once", async () => {
    const { secrets, writes } = spiedSecrets({ [SECRET_ID]: JSON.stringify(BASE) });
    const api = fakeGitHubApi();
    await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(writes).toEqual([SECRET_ID]);
    const stored = storedWebhookSecret(JSON.parse(secrets.values.get(SECRET_ID)!) as Record<string, unknown>)!;
    expect(api.hookWrites).toEqual([{ url: URL, secret: stored }]);
  });
});

describe("the GitHub REST client without a secret", () => {
  it("sends the hook config with no secret key at all when none is given, so GitHub keeps the one it has", async () => {
    const calls: Array<{ body: string | undefined }> = [];
    const fetchImplementation = (async (_url: string, init: RequestInit) => { calls.push({ body: init.body as string | undefined }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await githubRestApi(fetchImplementation).setHookConfig("the-jwt", { url: URL });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ url: URL, content_type: "json", insecure_ssl: "0" });
    expect(calls[0]?.body).not.toContain("secret");
  });
});
