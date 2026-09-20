import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConfiguredGitHubAppRouter } from "../../packages/broker/src/aws/github-app-routing.js";

const legacy = { credentialRef: "legacy", account: "ps06756", appId: "5002502", installationId: "163046162",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:old-AbCd12" };
const additional = { credentialRef: "github-charterarc-demo", account: "PrepLabsAI", appId: "5006456", installationId: "163149623",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:new-AbCd12",
  repositories: ["https://github.com/PrepLabsAI/charterarc-integration-demo.git"] };
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
describe("AWS GitHub credential composition", () => {
  it("uses a separate cached secret for each installation across clone and PR lookup", async () => {
    const reads: string[] = [];
    const calls: string[] = [];
    const router = createConfiguredGitHubAppRouter({ legacy, additionalBindingsJson: JSON.stringify([additional]),
      loadSecret: async (arn) => { reads.push(arn); return JSON.stringify({ privateKey: pem }); },
      fetchImplementation: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: url.split("/")[5] }));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer 163149623");
        return new Response(JSON.stringify({ number: 1, html_url: "https://github.com/PrepLabsAI/charterarc-integration-demo/pull/1",
          state: "open", merged: false, head: { ref: "candidate", sha: "a".repeat(40) }, base: { ref: "main" },
          title: "Demo", body: "", merge_commit_sha: null }));
      },
    });
    await expect(router.resolve("wrong-ref", additional.repositories[0]!)).rejects.toThrow(/FORBIDDEN/);
    expect(reads).toEqual([]);
    expect(await router.resolve(legacy.credentialRef, "https://github.com/ps06756/repo.git")).toMatchObject({ password: "163046162" });
    expect(await router.resolve(additional.credentialRef, additional.repositories[0]!)).toMatchObject({ password: "163149623" });
    expect(await router.getPullRequest(additional.repositories[0]!, 1)).toMatchObject({ headCommit: "a".repeat(40) });
    expect(reads).toEqual([legacy.privateKeySecretArn, additional.privateKeySecretArn]);
    expect(calls.filter((url) => url.includes("163149623/access_tokens"))).toHaveLength(2);
  });
  it.each(["{secret-sentinel", "null", "{}", JSON.stringify([{ ...additional, credentialRef: "legacy" }])])(
    "fails startup on invalid registry without revealing input", (json) => {
      expect(() => createConfiguredGitHubAppRouter({ legacy, additionalBindingsJson: json, loadSecret: async () => pem }))
        .toThrow("CONFIG_INVALID: invalid GitHub App binding configuration");
    },
  );
  it("redacts failed secret reads and does not load a different app key", async () => {
    const reads: string[] = [];
    const router = createConfiguredGitHubAppRouter({ legacy, additionalBindingsJson: JSON.stringify([additional]),
      loadSecret: async (arn) => { reads.push(arn); throw new Error("secret-sentinel"); } });
    await expect(router.resolve(additional.credentialRef, additional.repositories[0]!))
      .rejects.toThrow("RUNTIME_UNAVAILABLE: GitHub App key could not be loaded");
    expect(reads).toEqual([additional.privateKeySecretArn]);
  });
  it("does not read any secret for an unrelated public repository without additional config", async () => {
    const router = createConfiguredGitHubAppRouter({ legacy, loadSecret: async () => { throw new Error("must not load"); } });
    expect(await router.resolve("public", "https://github.com/github/spec-kit.git")).toEqual({});
  });
});
