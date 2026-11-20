import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { withHostRequests } from "../../packages/broker/src/core/merge/host-requests.js";

function provider(files: unknown) {
  const urls: string[] = [];
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const instance = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), now: () => Date.parse("2026-10-30T10:00:00Z"),
    fetchImplementation: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 9, account: { login: "acme" } }));
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      return new Response(JSON.stringify(files));
    },
  });
  return { instance, urls };
}
const file = (filename: string) => ({ filename, status: "modified", additions: 2, deletions: 1 });

it("charges authorization and data traffic to one invocation allowance across repeated provider reads", async () => {
  const w = provider([file("a.ts")]);
  let requests = 0;
  const budget = { signal: new AbortController().signal, beforeRequest: () => { if (requests >= 3) throw new Error("request cap"); requests++; } };
  await withHostRequests(budget, async () => {
    await w.instance.listPullRequestFiles("https://github.com/acme/demo", 7, { page: 1 }, { orgId: "org_00000000000000000000" });
    await expect(w.instance.listPullRequestFiles("https://github.com/acme/demo", 7, { page: 2 }, { orgId: "org_00000000000000000000" })).rejects.toThrow();
  });
  expect(requests).toBe(3);
  expect(w.urls).toHaveLength(3);
});
