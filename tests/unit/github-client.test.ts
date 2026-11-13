// Port lane L7a: Cloud's GitHub App client (plugins/code-host/github/client.ts) under the GitHub adapters, run over a fake GitHub HTTP server
// (tests/support/ports/github-fixture-api.ts, never the real GitHub). The same CodeHost and CheckRunner contract suites that the fakes pass run through the real
// client, so its request choreography and its parsing run for real; the adapter specifics that only the real client can show (what a token is minted with, which
// branches are read, what a system scope may do) are checked here; and the client conformance suite (tenant binding, least privilege, no redirects) closes the
// DEFERRED-CHECKS entry written by lane L2.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubActionsCheckRunner } from "../../packages/core/src/plugins/check-runner/github-actions/index.js";
import { githubCodeHost } from "../../packages/core/src/plugins/code-host/github/index.js";
import { GitHubAppCredentialProvider } from "../../packages/core/src/plugins/code-host/github/client.js";
import { githubAppClient } from "../../packages/core/src/plugins/code-host/github/app-client.js";
import { missingGitHubProviderMethods } from "../../packages/core/src/plugins/code-host/github/provider.js";
import { FakeHostModel } from "@rovara-code/core/fakes";
import { checkRunnerChecks, type CheckRunnerWorld } from "../support/ports/check-runner-conformance.js";
import { codeHostChecks, type CodeHostWorld } from "../support/ports/code-host-conformance.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { githubDelivery, githubPayloads, signGithubBody, webhookSecretReader } from "../support/ports/github-deliveries.js";
import { githubClientChecks, runGitHubClientConformance, RecordingNetwork, TenantBinding, type GitHubClientWorld } from "../support/ports/github-client-conformance.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi, providerOver } from "../support/ports/github-fixture-api.js";

const GITHUB_NOW = Date.parse("2026-10-30T10:00:00.000Z");
const WORKING_BRANCH = (n: number) => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function githubModel(): FakeHostModel {
  return new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
}

function codeHostWorld(): CodeHostWorld & { api: GitHubFixtureApi } {
  const model = githubModel();
  const api = new GitHubFixtureApi(model);
  const host = githubCodeHost(providerOver(api), { credentialRef: "github", now: () => GITHUB_NOW, webhookSecret: webhookSecretReader() });
  return {
    host, model, api, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, now: () => GITHUB_NOW, branch: WORKING_BRANCH,
    signedDelivery: (event) => event.kind === "change_request.opened"
      ? githubDelivery("pull_request", githubPayloads.pullRequest("opened", Number(event.id)))
      : githubDelivery("push", githubPayloads.push(`refs/heads/${event.branch}`, event.revision)),
    forgedDelivery: () => githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { signature: signGithubBody("{}") }),
    limitReads: (retryAt) => { api.limitReadsFor((retryAt - GITHUB_NOW) / 1_000); },
  };
}

function actionsWorld(): CheckRunnerWorld {
  const model = githubModel();
  const api = new GitHubFixtureApi(model);
  const runner = githubActionsCheckRunner(providerOver(api));
  return {
    runner, model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, project: "unit",
    changeRequest: () => {
      const revision = model.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n" });
      const { cr } = model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "t" });
      return { ref: { repository: { url: GITHUB_REPO_URL }, id: cr.id, url: model.crUrl(cr.id) }, revision };
    },
    finishRun: () => { throw new Error("GitHub Actions runs are not started by Rovara"); },
  };
}

runContract("GitHub CodeHost adapter over the real GitHub client passes the CodeHost contract", codeHostChecks, codeHostWorld);
runContract("GitHub Actions CheckRunner over the real GitHub client passes the CheckRunner contract", checkRunnerChecks, actionsWorld);

describe("the real GitHub client under the adapters", () => {
  it("has every method the adapters need", () => {
    expect(missingGitHubProviderMethods(providerOver(new GitHubFixtureApi(githubModel())))).toEqual([]);
  });

  it("mints a clone credential with read access to contents and a push credential with write, for this repository only", async () => {
    const world = codeHostWorld();
    await world.host.issueGitCredential(world.repository, "clone", world.scope);
    await world.host.issueGitCredential(world.repository, "push", world.scope);
    const mints = world.api.tokens.filter((token) => token.permissions.contents !== undefined && Object.keys(token.permissions).length === 1);
    expect(mints.map((mint) => mint.permissions.contents)).toEqual(["read", "write"]);
    expect(mints.every((mint) => mint.repositories?.join() === "app")).toBe(true);
  });

  it("only reads Rovara's own working branches", async () => {
    const world = codeHostWorld();
    world.model.commit("feature/x", { "x.txt": "x\n" });
    await expect(world.host.branchHead(world.repository, "feature/x", world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses to list branches under a system scope (the listing is org-scoped)", async () => {
    const world = codeHostWorld();
    await expect(world.host.listBranches(world.repository, 1, { system: "install" })).rejects.toBeDefined();
  });

  it("hands over the expiry GitHub stated for the token, not one of its own; no stated expiry is refused", async () => {
    const world = codeHostWorld();
    const stated = new Date(Date.now() + 50 * 60_000).toISOString();
    world.api.tokenExpiry = stated;
    expect(await world.host.issueGitCredential(world.repository, "clone", world.scope)).toMatchObject({ kind: "basic", expiresAt: stated });
    world.api.tokenExpiry = null;
    await expect(world.host.issueGitCredential(world.repository, "clone", world.scope)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    world.api.tokenExpiry = "2020-01-01T00:00:00Z";
    expect(await world.host.issueGitCredential(world.repository, "clone", world.scope)).toMatchObject({ expiresAt: "2020-01-01T00:00:00.000Z" });
  });

  it("refuses the credential when the client does not serve the reference (an empty answer is never a credential)", async () => {
    const world = codeHostWorld();
    const stub = githubCodeHost({ ...providerOver(world.api), resolveWithExpiry: async () => ({}) } as never, { credentialRef: "other" });
    await expect(stub.issueGitCredential(world.repository, "clone", world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("tells that Rovara's own App account made a change request (item C1), and not that a person's did", async () => {
    const world = codeHostWorld();
    world.model.commit(WORKING_BRANCH(1), { "src/a.ts": "a\n" });
    const mine = await world.host.reconcileChangeRequest({ repository: world.repository, sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Mine" }, world.scope);
    expect((await world.host.getChangeRequest(mine.ref, world.scope)).authoredByRovara).toBe(true);
    world.model.commit(WORKING_BRANCH(2), { "src/b.ts": "b\n" });
    const theirs = world.model.reconcile({ sourceBranch: WORKING_BRANCH(2), targetBranch: "main", title: "Theirs" }, "a-person").cr;
    const read = await world.host.getChangeRequest({ repository: world.repository, id: theirs.id, url: "" }, world.scope);
    expect(read.authoredByRovara).toBe(false);
    expect(read.baseRepositoryId).toBe("4242");
  });

  it("writes lessons files with a token that can write contents only, for this repository only; a read of pull requests asks for pull request read only (item C1)", async () => {
    const world = codeHostWorld();
    const branch = "rovara/lessons-0123456789ab";
    await world.host.commitFiles!({ repository: world.repository, branch, baseBranch: "main", message: "Lessons", files: [{ path: ".rovara/lessons.md", content: "x\n" }], fromBase: true }, world.scope);
    await world.host.changeRequestForBranch!(world.repository, branch, world.scope);
    await world.host.deleteBranch!(world.repository, branch, world.scope);
    const mints = world.api.tokens.map((token) => JSON.stringify(token.permissions));
    expect(mints).toEqual([JSON.stringify({ contents: "write" }), JSON.stringify({ pull_requests: "read" }), JSON.stringify({ contents: "write" })]);
    expect(world.api.tokens.every((token) => token.repositories?.join() === "app")).toBe(true);
  });

  it("is built as the narrow provider by githubAppClient", () => {
    const client = githubAppClient({ credentialRef: "github", appId: "5002502", getPrivateKey: async () => "unused" });
    expect(missingGitHubProviderMethods(client)).toEqual([]);
  });
});

// ---- the client conformance suite, over a recording wrapper of the fake GitHub

/** The request options as a client that never set a redirect mode would pass them. */
function withoutRedirectMode(init: RequestInit | undefined): RequestInit | undefined {
  if (init === undefined) return undefined;
  const copy = { ...init };
  delete copy.redirect;
  return copy;
}

function conformanceWorld(options: { binding?: boolean; stripRedirectMode?: boolean } = {}): GitHubClientWorld {
  const model = githubModel();
  const api = new GitHubFixtureApi(model);
  const net = new RecordingNetwork(api.fetch);
  const binding = new TenantBinding();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetchImplementation: options.stripRedirectMode === true ? ((input, init) => net.fetch(input, withoutRedirectMode(init))) : net.fetch,
    now: () => GITHUB_NOW, ...(options.binding === false ? {} : { requireInstallationBound: binding.hook }),
  });
  return {
    client, net, binding, repositoryUrl: GITHUB_REPO_URL, strangerUrl: GITHUB_OTHER_URL, credentialRef: "github", scope: GITHUB_ORG_SCOPE, otherScope: { orgId: "org_bbbbbbbbbbbbbbbbbbbb" },
    installationId: 77, repositoryId: 4242,
    async prepare() {
      const headSha = model.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n", "src/big.txt": "x".repeat(4_000) });
      model.setAccount("priya", "write");
      const { cr } = model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a", draft: true });
      const comment = model.addReviewComment(cr.id, "priya", "Please rename this.", "src/a.ts", 1);
      let fresh = 100;
      return {
        number: Number(cr.id), headSha, commentId: comment.id, largeFile: "src/big.txt",
        freshBranch: () => { fresh += 1; const branch = `agentx/00000000-0000-4000-8000-${String(fresh).padStart(12, "0")}`; model.commit(branch, { [`src/${String(fresh)}.ts`]: "export const b = 1;\n" }); return branch; },
      };
    },
  };
}

runGitHubClientConformance("the Cloud GitHub client passes the GitHub client conformance suite", conformanceWorld, { describe, it });

describe("the client conformance suite can fail", () => {
  const find = (prefix: string) => githubClientChecks.find((check) => check.name.startsWith(prefix))!;

  it("catches a client that never asks the tenant binding", async () => {
    await expect(find("tenant: every call").run(conformanceWorld({ binding: false }))).rejects.toThrow();
    await expect(find("tenant: a refused binding").run(conformanceWorld({ binding: false }))).rejects.toThrow();
  });

  it("catches a client whose requests would follow a redirect", async () => {
    await expect(find("network: every request refuses redirects").run(conformanceWorld({ stripRedirectMode: true }))).rejects.toThrow();
    await expect(find("network: a redirect answer is never followed to another host").run(conformanceWorld({ stripRedirectMode: true }))).rejects.toThrow();
  });
});
