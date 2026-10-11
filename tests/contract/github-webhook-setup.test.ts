import { describe, expect, it } from "vitest";
import { activeHintLine, ensureGithubWebhook, missingEventsLine } from "../../packages/cli/src/github/webhook-setup.js";
import { GITHUB_WEBHOOK_EVENTS, githubAppSecretName, githubRestApi } from "../../packages/cli/src/init/github-app.js";
import { fakeGitHubApi, memoryInitSecrets, TEST_PRIVATE_KEY } from "../support/init-fakes.js";

const SECRET_ID = githubAppSecretName("staging");
const URL = "https://cp.example.test/v1/github/webhooks";
const HAND_SET = "hand-set-webhook-secret-".padEnd(40, "h");
const BASE = { appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY };

describe("ensureGithubWebhook", () => {
  it("keeps an existing webhook secret and sets the hook URL", async () => {
    const stored = { ...BASE, webhookSecret: HAND_SET };
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify(stored) });
    const api = fakeGitHubApi({ hookUrl: "https://old.example.test/hook" });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(outcome.status).toBe("configured");
    // No rotation: the stored secret is untouched, and GitHub is given that same secret.
    expect(JSON.parse(secrets.values.get(SECRET_ID)!)).toEqual(stored);
    expect(api.hookWrites).toEqual([{ url: URL, secret: HAND_SET }]);
  });

  it("reports unchanged, but still gives GitHub the stored secret, when the secret and the hook look right", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: HAND_SET }) });
    const api = fakeGitHubApi({ hookUrl: URL });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(outcome).toMatchObject({ status: "unchanged", missingEvents: [] });
    // GitHub masks its copy of the secret, so a hook whose secret differs can only be repaired by sending the stored one again.
    expect(api.hookWrites).toEqual([{ url: URL, secret: HAND_SET }]);
  });

  it("generates and stores a webhook secret when none exists, keeping other secret fields", async () => {
    const stored = { ...BASE, futureKey: { nested: true } };
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify(stored) });
    const api = fakeGitHubApi({ hookUrl: URL });
    const outcome = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(outcome.status).toBe("configured");
    const after = JSON.parse(secrets.values.get(SECRET_ID)!) as Record<string, unknown>;
    expect(after).toMatchObject(stored);
    expect(after.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    // The hook is set with the secret that was stored, even though its URL already matched.
    expect(api.hookWrites).toEqual([{ url: URL, secret: after.webhookSecret }]);
  });

  it("replaces a webhook secret that is too short to be used", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: "short" }) });
    const api = fakeGitHubApi();
    await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect((JSON.parse(secrets.values.get(SECRET_ID)!) as { webhookSecret: string }).webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the secret before GitHub is told", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify(BASE) });
    const order: string[] = [];
    const put = secrets.put.bind(secrets);
    secrets.put = async (name, value) => { order.push("store"); await put(name, value); };
    const api = fakeGitHubApi();
    const setHookConfig = api.setHookConfig.bind(api);
    api.setHookConfig = async (jwt, hook) => { order.push("github"); await setHookConfig(jwt, hook); };
    await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(order).toEqual(["store", "github"]);
  });

  it("reports missing events with the settings page", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: HAND_SET }) });
    const outcome = await ensureGithubWebhook({
      appJwt: "jwt", api: fakeGitHubApi({ hookUrl: URL, events: ["pull_request", "issue_comment"] }), secrets, secretId: SECRET_ID, webhookUrl: URL,
    });
    expect(outcome.missingEvents).toEqual(["pull_request_review", "pull_request_review_comment"]);
    expect(outcome.settingsUrl).toBe("https://github.com/organizations/acme/settings/apps/agentx-acme-staging/permissions");
    expect(missingEventsLine(outcome)).toBe(`GitHub webhook: tick these events on ${outcome.settingsUrl}: pull_request_review, pull_request_review_comment`);
    const user = await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi({ hookUrl: URL, ownerType: "User" }), secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(user.settingsUrl).toBe("https://github.com/settings/apps/agentx-acme-staging/permissions");
    expect(missingEventsLine(user)).toBeUndefined();
  });

  it("asks for Active to be turned on when the hook URL was empty or different, on the App's general settings page", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: HAND_SET }) });
    for (const hookUrl of [undefined, "https://old.example.test/hook"]) {
      const outcome = await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi(hookUrl === undefined ? {} : { hookUrl }), secrets, secretId: SECRET_ID, webhookUrl: URL });
      expect(activeHintLine(outcome)).toBe("GitHub webhook: turn on Active at https://github.com/organizations/acme/settings/apps/agentx-acme-staging if it is off");
      expect(activeHintLine(outcome)).not.toContain(HAND_SET);
    }
    const user = await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi({ ownerType: "User" }), secrets, secretId: SECRET_ID, webhookUrl: URL });
    expect(activeHintLine(user)).toBe("GitHub webhook: turn on Active at https://github.com/settings/apps/agentx-acme-staging if it is off");
  });

  it("does not ask about Active when the hook already pointed at the control plane", async () => {
    const kept = memoryInitSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: HAND_SET }) });
    expect(activeHintLine(await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi({ hookUrl: URL }), secrets: kept, secretId: SECRET_ID, webhookUrl: URL }))).toBeUndefined();
    // A new secret alone changes nothing about whether the hook was ever active.
    const fresh = memoryInitSecrets({ [SECRET_ID]: JSON.stringify(BASE) });
    expect(activeHintLine(await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi({ hookUrl: URL }), secrets: fresh, secretId: SECRET_ID, webhookUrl: URL }))).toBeUndefined();
  });

  it("does not echo a failed write of the App secret", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify(BASE) });
    let written = "";
    secrets.put = async (_name, value) => { written = value; throw Object.assign(new Error(`access denied for ${value}`), { name: "AccessDeniedException" }); };
    const failure = await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi(), secrets, secretId: SECRET_ID, webhookUrl: URL }).catch((error: unknown) => error);
    const generated = (JSON.parse(written) as { webhookSecret: string }).webhookSecret;
    expect(String(failure)).toContain(`could not store the webhook secret in ${SECRET_ID} (AccessDeniedException)`);
    expect(String(failure)).not.toContain(generated);
    expect(String(failure)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(failure)).not.toContain(generated);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it("names the four events the broker accepts", () => {
    expect([...GITHUB_WEBHOOK_EVENTS]).toEqual(["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment"]);
  });

  it("refuses a secret that is not JSON without echoing it", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: "not-json-private-text" });
    const failure = await ensureGithubWebhook({ appJwt: "jwt", api: fakeGitHubApi(), secrets, secretId: SECRET_ID, webhookUrl: URL }).catch((error: unknown) => error);
    expect(String(failure)).toContain(SECRET_ID);
    expect(String(failure)).not.toContain("private-text");
  });

  it("never puts the secret in an error from GitHub", async () => {
    const secrets = memoryInitSecrets({ [SECRET_ID]: JSON.stringify({ ...BASE, webhookSecret: HAND_SET }) });
    const api = fakeGitHubApi();
    api.setHookConfig = async () => { throw new Error("GitHub webhook update failed with HTTP 422"); };
    const failure = await ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId: SECRET_ID, webhookUrl: URL }).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(HAND_SET);
  });
});

describe("the GitHub REST client's webhook calls", () => {
  function recordingFetch(replies: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | undefined }> = [];
    const queue = [...replies];
    const fetchImplementation = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      const reply = queue.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    return { calls, fetchImplementation };
  }

  it("reads the hook config with the app token", async () => {
    const { calls, fetchImplementation } = recordingFetch([{ status: 200, body: { url: URL, content_type: "json", insecure_ssl: "0", secret: "********" } }]);
    await expect(githubRestApi(fetchImplementation).getHookConfig("the-jwt")).resolves.toEqual({ url: URL, contentType: "json", insecureSsl: "0" });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/app/hook/config" });
    expect(calls[0]?.headers.authorization).toBe("Bearer the-jwt");
  });

  it("lists a few recent deliveries with the app token and keeps only when, the status and the HTTP code", async () => {
    const { calls, fetchImplementation } = recordingFetch([{ status: 200, body: [
      { id: 1, guid: "g-1", delivered_at: "2026-09-26T23:00:00Z", redelivery: false, duration: 0.2, status: "OK", status_code: 202, event: "issue_comment", action: "created", url: "https://example.test/payload" },
      { id: 2, delivered_at: "2026-09-26T22:00:00Z", status: "Invalid HTTP Response: 0" },
      { id: 3, status_code: "bad" },
    ] }]);
    await expect(githubRestApi(fetchImplementation).listHookDeliveries("the-jwt")).resolves.toEqual([
      { deliveredAt: "2026-09-26T23:00:00Z", status: "OK", statusCode: 202 },
      { deliveredAt: "2026-09-26T22:00:00Z", status: "Invalid HTTP Response: 0", statusCode: 0 },
    ]);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/app/hook/deliveries?per_page=10" });
    expect(calls[0]?.headers.authorization).toBe("Bearer the-jwt");
  });

  it("sets the hook config with a JSON body", async () => {
    const { calls, fetchImplementation } = recordingFetch([{ status: 200, body: {} }]);
    await githubRestApi(fetchImplementation).setHookConfig("the-jwt", { url: URL, secret: HAND_SET });
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "https://api.github.com/app/hook/config" });
    expect(calls[0]?.headers.authorization).toBe("Bearer the-jwt");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ url: URL, content_type: "json", secret: HAND_SET, insecure_ssl: "0" });
  });

  it("never puts a response body in its error", async () => {
    const { fetchImplementation } = recordingFetch([{ status: 422, body: { message: `echo ${HAND_SET}` } }]);
    const failure = await githubRestApi(fetchImplementation).setHookConfig("the-jwt", { url: URL, secret: HAND_SET }).catch((error: unknown) => error);
    expect(String(failure)).toContain("HTTP 422");
    expect(String(failure)).not.toContain(HAND_SET);
  });

  it("reads the App's subscribed events", async () => {
    const { fetchImplementation } = recordingFetch([{ status: 200, body: { slug: "agentx", owner: { login: "acme", type: "Organization" }, events: ["pull_request"] } }]);
    await expect(githubRestApi(fetchImplementation).getApp("the-jwt")).resolves.toMatchObject({ events: ["pull_request"] });
  });
});
