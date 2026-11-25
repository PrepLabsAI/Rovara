import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyGithubWebhookSignature } from "../../packages/broker/src/aws/github-webhooks.js";
import { call, createBroker, loadSlackBroker } from "../support/slack-broker.js";


describe("GitHub webhook signature verification", () => {

  it("accepts only the exact body signed with the configured secret", () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
    const secret = "fixture-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

    expect(verifyGithubWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyGithubWebhookSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyGithubWebhookSignature(body, signature, "different-secret")).toBe(false);
  });

  it("accepts only GitHub's own spelling: lower-case prefix and lower-case hex (webhook lane W0)", () => {
    const body = "{}";
    const secret = "fixture-webhook-secret";
    const hex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifyGithubWebhookSignature(body, `sha256=${hex}`, secret)).toBe(true);
    expect(verifyGithubWebhookSignature(body, `SHA256=${hex}`, secret)).toBe(false);
    expect(verifyGithubWebhookSignature(body, `sha256=${hex.toUpperCase()}`, secret)).toBe(false);
    expect(verifyGithubWebhookSignature(body, `sha1=${hex.slice(0, 40)}`, secret)).toBe(false);
    expect(verifyGithubWebhookSignature(body, undefined, secret)).toBe(false);
  });

});

describe("the GitHub webhook route and a changed webhook secret", () => {
  beforeAll(async () => { await loadSlackBroker(); });
  const pullRequestBody = {
    action: "opened", installation: { id: 777 }, repository: { id: 1234, full_name: "acme/payments" },
    pull_request: { number: 9, state: "open", merged: false },
  };
  const signedHeaders = (body: unknown, secret: string) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex")}`,
    "x-github-delivery": "550e8400-e29b-41d4-a716-446655440000",
    "x-github-event": "pull_request",
  });
  const post = (webhookSecret: (options?: { refresh?: boolean }) => Promise<string>, headers: Record<string, string>) => {
    const broker = createBroker({ extra: { githubWebhookSecret: webhookSecret } });
    return call(broker.handler, { method: "POST", path: "/v1/github/webhooks", body: pullRequestBody, headers });
  };

  it("accepts a delivery signed with a secret added after the container started", async () => {
    // The container cached a secret with no webhook secret; the refreshed read finds the one GitHub signs with.
    const webhookSecret = vi.fn(async (options?: { refresh?: boolean }) => {
      if (options?.refresh === true) return "added-after-start-".padEnd(40, "x");
      return "old-secret-before-the-change".padEnd(40, "o");
    });
    const response = await post(webhookSecret, signedHeaders(pullRequestBody, "added-after-start-".padEnd(40, "x")));
    // It gets past the signature check and maps to no core task (nothing is linked in this fixture, and D1 removed the old engine's handler): a signed delivery that is not ours is 202 IGNORED, not a 403.
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ delivery: "IGNORED" });
    expect(webhookSecret.mock.calls).toEqual([[undefined], [{ refresh: true }]]);
  });

  it("answers 503 not configured when the secret holds no webhook secret even after a refresh", async () => {
    const { agentXError } = await import("../../packages/contracts/src/index.js");
    const webhookSecret = vi.fn(async () => { throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App secret does not contain a valid webhook secret"); });
    const response = await post(webhookSecret, signedHeaders(pullRequestBody, "any".padEnd(40, "a")));
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).toContain("GitHub webhook handling is not configured");
  });
});
