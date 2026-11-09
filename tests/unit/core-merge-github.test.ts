// Port lane L7a: the merge core end to end through the registry's code-host point, the GitHub adapter and Cloud's real GitHub client, over a fake GitHub HTTP server.
// Tracking and a press run through every layer: nothing is faked between the core and the (fake) network, so the tenant binding, the tokens and the request options of the whole path
// are the ones a real install makes.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { NO_HOST_MESSAGE } from "../../packages/broker/src/plugins/routing.js";
import { pressMerge, registryRepositoryResolver, trackPullRequest } from "../../packages/broker/src/core/merge/index.js";
import { GitHubFixtureApi } from "../support/ports/github-fixture-api.js";
import { RecordingNetwork, TenantBinding } from "../support/ports/github-client-conformance.js";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";

describe("the merge core over the registry, the GitHub adapter and the real GitHub client", () => {
  async function world() {
    const binding = new TenantBinding();
    let net: RecordingNetwork | undefined;
    const base = await mergeWorld({
      codeHost: (model) => {
        const api = new GitHubFixtureApi(model);
        net = new RecordingNetwork(api.fetch);
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const client = new GitHubAppCredentialProvider({
          credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          fetchImplementation: net.fetch, now: () => Date.parse("2026-11-09T10:00:00.000Z"), requireInstallationBound: binding.hook,
        });
        return githubCodeHost(client, { credentialRef: "github" });
      },
    });
    // The resolver the core is given comes from the registry, by the repository record's host kind.
    const registry = createAdapterRegistry();
    registry.register("code-host", "github", (await base.host.repository("web", 1, "app", ORG))!.codeHost);
    const resolver = registryRepositoryResolver(registry, { pinned: async (_project, _revision, repositoryId) => ({ url: `https://github.com/acme/${repositoryId}`, host: { kind: "github" } }) });
    const host = { ...base.host, repository: resolver };
    return { ...base, host, deps: { ...base.deps, host }, tracking: { ...base.tracking, repository: resolver }, binding, net: () => net! };
  }

  it("tracks the pull request and merges it at the checked head, with the company's scope on every call and no redirect followed", async () => {
    const w = await world();
    await trackPullRequest(w.tracking, TASK_ID);
    const pr = w.prs[0]!;
    expect((await w.trackingOf(pr))).toMatchObject({ ci: "passing", review: "approved" });
    const prepared = await (await import("../../packages/broker/src/core/merge/index.js")).prepareMerge(w.deps, { taskId: TASK_ID, requestId: w.requestId() });
    const result = await pressMerge(w.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: w.proofFor(prepared) });
    expect(result.status).toBe("MERGED");
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("merged");
    // The tenant binding was asked, for this company only, on the path of the whole flow.
    expect(w.binding.calls.length).toBeGreaterThan(3);
    expect(w.binding.calls.every((call) => call.orgId === ORG)).toBe(true);
    // Every request the real client made refused redirects and carried a timeout.
    const net = w.net();
    expect(net.requests.length).toBeGreaterThan(5);
    expect(net.requests.filter((request) => request.redirect !== "error" && request.redirect !== "manual")).toEqual([]);
    expect(net.requests.filter((request) => !request.hasSignal)).toEqual([]);
    // The merge itself was a PUT with the checked head as its sha, and no token was minted for more than one repository.
    expect(net.requests.some((request) => request.method === "PUT" && request.url.pathname.endsWith("/merge") && (JSON.parse(request.body ?? "{}") as { sha?: string }).sha === pr.head)).toBe(true);
    expect(net.tokenRequests().every((mint) => mint.repositories?.join() === "app")).toBe(true);
  });

  it("refuses a repository whose record names a code host nobody registered, with a sentence that does not name it, and falls back to nothing", async () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost((await mergeWorld()).prs[0]!.model));
    const resolver = registryRepositoryResolver(registry, { pinned: async () => ({ url: "https://secret-forge.example.test/a/b", host: { kind: "secretforge" } }) });
    await expect(resolver("web", 1, "app", ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_HOST_MESSAGE) as string });
    const refusal = await resolver("web", 1, "app", ORG).then(() => "", (error: Error) => error.message);
    expect(refusal).not.toContain("secretforge");
    // A record on the registered kind is served by it; a record with no host is on the legacy kind (github), which this registry does not hold.
    const fakeResolver = registryRepositoryResolver(registry, { pinned: async () => ({ url: "https://examplehost.test/a/b", host: { kind: "fake" } }) });
    expect((await fakeResolver("web", 1, "app", ORG))!.codeHost.kind).toBe("fake");
    const legacy = registryRepositoryResolver(registry, { pinned: async () => ({ url: "https://github.com/a/b" }) });
    await expect(legacy("web", 1, "app", ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const none = registryRepositoryResolver(registry, { pinned: async () => undefined });
    expect(await none("web", 1, "nothing", ORG)).toBeUndefined();
  });
});
