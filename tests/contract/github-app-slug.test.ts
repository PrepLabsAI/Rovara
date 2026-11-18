// Naming phase 1: the owner renames the GitHub App in GitHub's settings, which changes its slug. The install address and the
// `<slug>[bot]` login must follow what GitHub reports, not what the install once stored (and never a name written in code).
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

function provider(options: { stored?: string; github: "slug" | "down" | "bad"; reported?: string }) {
  const calls: string[] = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (options.github === "down") return new Response("{}", { status: 503 });
    if (options.github === "bad") return new Response(JSON.stringify({ slug: "not a slug!" }), { status: 200 });
    return new Response(JSON.stringify({ slug: options.reported }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new GitHubAppCredentialProvider({
    credentialRef: "github-app", appId: "4242", getPrivateKey: async () => privateKey,
    ...(options.stored === undefined ? {} : { getAppSecret: async () => JSON.stringify({ slug: options.stored }) }),
    fetchImplementation,
  });
  return { client, calls };
}

describe("the App's slug", () => {
  it("is what GitHub reports now, even when the stored one is the old name", async () => {
    const { client, calls } = provider({ stored: "agentx-acme-staging", github: "slug", reported: "rovara-acme-staging" });
    expect(await client.appSlug()).toBe("rovara-acme-staging");
    expect(calls).toEqual(["https://api.github.com/app"]);
    expect(await client.appSlug()).toBe("rovara-acme-staging");
    expect(calls).toHaveLength(1);
  });

  it("falls back to the stored slug when GitHub cannot be asked or answers with something that is not a slug", async () => {
    expect(await provider({ stored: "agentx-acme-staging", github: "down" }).client.appSlug()).toBe("agentx-acme-staging");
    expect(await provider({ stored: "agentx-acme-staging", github: "bad" }).client.appSlug()).toBe("agentx-acme-staging");
  });

  it("does not keep the stored fallback: the next call asks GitHub again", async () => {
    const { client, calls } = provider({ stored: "agentx-acme-staging", github: "down" });
    expect(await client.appSlug()).toBe("agentx-acme-staging");
    expect(await client.appSlug()).toBe("agentx-acme-staging");
    expect(calls).toEqual(["https://api.github.com/app", "https://api.github.com/app"]);
  });

  it("is refused when GitHub gives none and nothing is stored, or the stored one is not a slug", async () => {
    await expect(provider({ github: "down" }).client.appSlug()).rejects.toThrow("GitHub App lookup failed with HTTP 503");
    await expect(provider({ github: "bad" }).client.appSlug()).rejects.toThrow("GitHub App slug is missing or not valid");
    await expect(provider({ stored: "not a slug!", github: "down" }).client.appSlug()).rejects.toThrow("GitHub App slug is missing or not valid");
  });
});
