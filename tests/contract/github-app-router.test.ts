import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { GitHubAppRouter, cachedPrivateKeyLoader } from "../../packages/broker/src/github-app-router.js";
import { parseAdditionalGitHubAppBindings } from "../../packages/contracts/src/github-app-binding.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const demo = "https://github.com/PrepLabsAI/charterarc-integration-demo.git";
const old = "https://github.com/ps06756/personal-website.git";
const binding = {
  credentialRef: "github-charterarc-demo", account: "PrepLabsAI", appId: "5006456", installationId: "163149623",
  privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:demo-AbCd12", repositories: [demo],
};
function fixture(enabled = true, fail = false) {
  const keys: string[] = [];
  const tokens: Array<{ installation: string; permissions: unknown }> = [];
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) {
      const installation = url.split("/")[5]!;
      tokens.push({ installation, permissions: JSON.parse(String(init?.body)).permissions });
      return new Response(JSON.stringify({ token: `token-${installation}` }), { status: fail ? 403 : 201 });
    }
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const repo = url.split("/").slice(4, 6).join("/");
    const details = { number: 4, html_url: `https://github.com/${repo}/pull/4`, state: "open", merged: false,
      head: { ref: "candidate", sha: "a".repeat(40) }, base: { ref: "main" }, title: "Change", body: "", merge_commit_sha: null };
    return new Response(JSON.stringify(url.includes("?") ? [] : details), { status: 200 });
  };
  const legacy = new GitHubAppCredentialProvider({ credentialRef: "legacy", account: "ps06756", appId: "5002502",
    installationId: "163046162", getPrivateKey: async () => { keys.push("legacy"); return pem; }, fetchImplementation });
  const router = new GitHubAppRouter({ legacy,
    bindings: parseAdditionalGitHubAppBindings(enabled ? [binding] : [], "legacy"),
    createProvider: (entry) => new GitHubAppCredentialProvider({ ...entry,
      getPrivateKey: async () => { keys.push(entry.credentialRef); return pem; }, fetchImplementation }),
  });
  return { router, keys, tokens, requests };
}
describe("GitHub App routing", () => {
  it("uses the correct installation and access level for both apps", async () => {
    const f = fixture();
    expect(await f.router.resolve("legacy", old)).toMatchObject({ password: "token-163046162" });
    expect(await f.router.resolve(binding.credentialRef, demo, "push")).toMatchObject({ password: "token-163149623" });
    expect(f.tokens).toEqual([{ installation: "163046162", permissions: { contents: "read" } },
      { installation: "163149623", permissions: { contents: "write" } }]);
  });
  it("rejects wrong references, repo aliases and out-of-scope repos before reading any key", async () => {
    const f = fixture();
    for (const [ref, url] of [["legacy", demo], ["public", demo.toLowerCase().replace(/\.git$/, "")],
      [binding.credentialRef, old], ["public", "https://github.com:443/PrepLabsAI/charterarc-integration-demo.git"]]) {
      await expect(f.router.resolve(ref!, url!)).rejects.toThrow();
    }
    expect(f.keys).toEqual([]);
    expect(f.tokens).toEqual([]);
  });
  it("preserves unrelated public repositories without issuing a credential", async () => {
    const f = fixture();
    expect(await f.router.resolve("public", "https://gitlab.com/example/public.git")).toEqual({});
    expect(await f.router.resolve("public", "https://github.com/github/spec-kit.git")).toEqual({});
    expect(f.keys).toEqual([]);
  });
  it.each([true, false])("routes every PR operation with additional bindings=%s", async (enabled) => {
    const f = fixture(enabled);
    const url = enabled ? demo : old;
    const token = enabled ? "token-163149623" : "token-163046162";
    expect(await f.router.reconcilePullRequest({ repositoryUrl: url, headBranch: "candidate", baseBranch: "main", title: "Change" }))
      .toMatchObject({ number: 4 });
    expect(await f.router.getPullRequest(url, 4)).toMatchObject({ headCommit: "a".repeat(40) });
    expect(await f.router.updatePullRequest(url, 4, { title: "Change" })).toMatchObject({ title: "Change" });
    expect(f.requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
    expect(f.tokens).toHaveLength(3);
  });
  it("does not try the legacy app when the additional installation fails", async () => {
    const f = fixture(true, true);
    await expect(f.router.resolve(binding.credentialRef, demo)).rejects.toThrow(/403/);
    expect(f.keys).toEqual([binding.credentialRef]);
    expect(f.tokens).toHaveLength(1);
  });
  it("keeps legacy grant behavior when no registry is present", async () => {
    const f = fixture(false);
    expect(await f.router.resolve("public", demo)).toEqual({});
    expect(await f.router.resolve("legacy", old)).toMatchObject({ password: "token-163046162" });
  });
});
describe("private key cache", () => {
  it("coalesces concurrent calls but keeps each app independent", async () => {
    let a = 0; let b = 0;
    const first = cachedPrivateKeyLoader(async () => { a++; return "key-a"; });
    const second = cachedPrivateKeyLoader(async () => { b++; return "key-b"; });
    expect(await Promise.all([first(), first(), second()])).toEqual(["key-a", "key-a", "key-b"]);
    expect([a, b]).toEqual([1, 1]);
  });
  it("redacts a failed load, retries it and leaves the other cache usable", async () => {
    let attempts = 0;
    const first = cachedPrivateKeyLoader(async () => { if (++attempts === 1) throw new Error("secret-sentinel"); return "recovered"; });
    const second = cachedPrivateKeyLoader(async () => "other");
    await expect(first()).rejects.toThrow("RUNTIME_UNAVAILABLE: GitHub App key could not be loaded");
    expect(await second()).toBe("other");
    expect(await first()).toBe("recovered");
  });
});
