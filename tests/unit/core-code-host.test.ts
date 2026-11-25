// Core switch-on lane L1b: the core's code host on the broker (aws/core-code-host.ts). The App's full client, over a fake GitHub (never the real one), behind the company rules:
// a company reaches only the repositories its OWN projects name (read from its catalog, never from the request), a system scope is refused, and the client's own rules (tenant binding at
// every mint, least privilege, no redirects) still hold. The CodeHost and CheckRunner contracts and the GitHub client conformance suite run through the bridge.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type DocumentStore, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { FakeHostModel } from "@agentx/broker/fakes";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  CATALOG_UNREADABLE, MAX_CATALOG_PAGES, MAX_PROJECTS_PER_PAGE, NOT_A_COMPANY_REPOSITORY, SYSTEM_SCOPE_REFUSED,
  brokerCoreCodeHost, companyRepositoriesFromStore, companyScopedGitHubProvider, githubRepositoryKey,
} from "../../packages/broker/src/aws/core-code-host.js";
import { BROKER_CORE_NOT_CONFIGURED, BROKER_CORE_OWED, brokerCoreModuleDeps, type BrokerCoreModuleParts } from "../../packages/broker/src/aws/core-engine-root.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { githubActionsCheckRunner } from "../../packages/broker/src/plugins/check-runner/github-actions/index.js";
import { GITHUB_CODE_HOST_PROVIDER_METHODS, missingGitHubProviderMethods, type GitHubCodeHostProvider } from "../../packages/broker/src/plugins/code-host/github/provider.js";
import { checkRunnerChecks, type CheckRunnerWorld } from "../support/ports/check-runner-conformance.js";
import { codeHostChecks, type CodeHostWorld } from "../support/ports/code-host-conformance.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { runGitHubClientConformance, RecordingNetwork, TenantBinding, type GitHubClientWorld } from "../support/ports/github-client-conformance.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi } from "../support/ports/github-fixture-api.js";

const GITHUB_NOW = Date.parse("2026-10-30T10:00:00.000Z");
const WORKING_BRANCH = (n: number) => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const A = GITHUB_ORG_SCOPE.orgId as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

function project(name: string, urls: readonly string[]): ProjectDefinition {
  return {
    name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    repositories: urls.map((url, index) => ({ name: `r${String(index)}`, url, path: `repo/r${String(index)}`, defaultBranch: "main", credentialRef: "github" })),
  };
}

async function register(store: DocumentStore, companyId: OrgId, definition: ProjectDefinition): Promise<void> {
  await store.put({ item: { ...projectRevisionKey(companyId, definition.name, definition.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  await store.put({ item: { ...orgProjectCatalogKey(companyId, definition.name), entityType: "PROJECT_CATALOG", latestRevision: definition.revision } });
}

interface BridgeWorld {
  model: FakeHostModel;
  api: GitHubFixtureApi;
  net: RecordingNetwork;
  binding: TenantBinding;
  store: MemoryDocumentStore;
  provider: GitHubCodeHostProvider;
  githubActions: GitHubCodeHostProvider;
  logs: Array<Record<string, unknown>>;
}

/** Company A's project names the fake GitHub's repository; company B's names `bRepositories` (none by default). */
async function bridgeWorld(options: { bRepositories?: readonly string[] } = {}): Promise<BridgeWorld> {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
  const api = new GitHubFixtureApi(model);
  const net = new RecordingNetwork(api.fetch);
  const binding = new TenantBinding();
  const store = new MemoryDocumentStore();
  await register(store, A, project("payments", [`${GITHUB_REPO_URL}.git`]));
  if (options.bRepositories !== undefined) await register(store, B, project("payments", options.bRepositories));
  const logs: Array<Record<string, unknown>> = [];
  const parts = brokerCoreCodeHost({
    credentials: { credentialRef: "github", appId: "5002502", getPrivateKey: async () => KEY },
    requireInstallationBound: binding.hook, storage: async () => store, fetchImplementation: net.fetch, now: () => GITHUB_NOW, log: (entry) => logs.push(entry),
  });
  expect(parts.codeHost.options.credentialRef).toBe("github");
  return { model, api, net, binding, store, provider: parts.codeHost.provider, githubActions: parts.checkRunner!.githubActions as GitHubCodeHostProvider, logs };
}

// ---- the contracts and the client conformance suite, through the bridge

async function codeHostWorld(): Promise<CodeHostWorld> {
  const world = await bridgeWorld();
  const host = githubCodeHost(world.provider, { credentialRef: "github", now: () => GITHUB_NOW });
  return {
    fileEntries: true, host, model: world.model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, now: () => GITHUB_NOW, branch: WORKING_BRANCH,
    limitReads: (retryAt) => { world.api.limitReadsFor((retryAt - GITHUB_NOW) / 1_000); },
  };
}

async function actionsWorld(): Promise<CheckRunnerWorld> {
  const world = await bridgeWorld();
  const runner = githubActionsCheckRunner(world.githubActions);
  return {
    runner, model: world.model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, project: "unit",
    changeRequest: () => {
      const revision = world.model.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n" });
      const { cr } = world.model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "t" });
      return { ref: { repository: { url: GITHUB_REPO_URL }, id: cr.id, url: world.model.crUrl(cr.id) }, revision };
    },
    finishRun: () => { throw new Error("GitHub Actions runs are not started by Rovara"); },
  };
}

runContract("the broker's core code host passes the CodeHost contract", codeHostChecks, codeHostWorld);
runContract("the broker's core check runner passes the CheckRunner contract", checkRunnerChecks, actionsWorld);

// Company B names the same repository in its own project, so its calls pass the bridge and reach the client's installation binding, which must refuse them (the suite's tenant checks).
async function conformanceWorld(): Promise<GitHubClientWorld> {
  const world = await bridgeWorld({ bRepositories: [GITHUB_REPO_URL] });
  return {
    client: world.provider, net: world.net, binding: world.binding, repositoryUrl: GITHUB_REPO_URL, strangerUrl: GITHUB_OTHER_URL, credentialRef: "github", scope: GITHUB_ORG_SCOPE, otherScope: { orgId: B },
    installationId: 77, repositoryId: 4242,
    async prepare() {
      const headSha = world.model.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n", "src/big.txt": "x".repeat(4_000) });
      world.model.setAccount("priya", "write");
      const { cr } = world.model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a", draft: true });
      const comment = world.model.addReviewComment(cr.id, "priya", "Please rename this.", "src/a.ts", 1);
      let fresh = 100;
      return {
        number: Number(cr.id), headSha, commentId: comment.id, largeFile: "src/big.txt",
        freshBranch: () => { fresh += 1; const branch = `agentx/00000000-0000-4000-8000-${String(fresh).padStart(12, "0")}`; world.model.commit(branch, { [`src/${String(fresh)}.ts`]: "export const b = 1;\n" }); return branch; },
      };
    },
  };
}

runGitHubClientConformance("the broker's core code host passes the GitHub client conformance suite", conformanceWorld, { describe, it });

// ---- the company rules

/** Every scoped method of the provider, called for `url` in `scope` (arguments that never get as far as GitHub when refused). */
function scopedCalls(provider: GitHubCodeHostProvider, url: string, scope: unknown): Array<[string, () => Promise<unknown>]> {
  const s = scope as { orgId: string };
  const sha = "a".repeat(40);
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["getRepositoryIdentity", () => provider.getRepositoryIdentity(url, s)],
    ["checkRepository", () => provider.checkRepository({ credentialRef: "github", url }, s)],
    ["getRepositoryStanding", () => provider.getRepositoryStanding(url, "priya", s)],
    ["resolveWithExpiry", () => provider.resolveWithExpiry("github", url, "push", s)],
    ["getFileAtCommit", () => provider.getFileAtCommit(url, "src/a.ts", sha, s)],
    ["getCommitTree", () => provider.getCommitTree(url, sha, s)],
    ["getBranchHead", () => provider.getBranchHead(url, WORKING_BRANCH(1), s)],
    ["listWorkingBranches", () => provider.listWorkingBranches(url, { installationId: 77, repositoryId: 4242 }, s, 1)],
    ["getCommitParents", () => provider.getCommitParents(url, sha, s)],
    ["getDefaultBranchHead", () => provider.getDefaultBranchHead(url, "main", s)],
    ["getPullRequestMergeObservation", () => provider.getPullRequestMergeObservation(url, 1, { maxRequests: 5 } as never, s)],
    ["readCodeOwners", () => provider.readCodeOwners(url, "main", s)],
    ["reconcilePullRequest", () => provider.reconcilePullRequest({ repositoryUrl: url, headBranch: WORKING_BRANCH(1), baseBranch: "main", title: "t" }, s)],
    ["getPullRequest", () => provider.getPullRequest(url, 1, s)],
    ["updatePullRequest", () => provider.updatePullRequest(url, 1, { state: "closed" }, s)],
    ["getPullRequestStatus", () => provider.getPullRequestStatus(url, 1, s)],
    ["listPullRequestFiles", () => provider.listPullRequestFiles(url, 1, { page: 1 }, s)],
    ["getPullRequestFeedback", () => provider.getPullRequestFeedback(url, 1, s)],
    ["replyToReviewThread", () => provider.replyToReviewThread(url, 1, "c1", "Done.", s)],
    ["markPullRequestReady", () => provider.markPullRequestReady(url, 1, s)],
    ["requestReviewers", () => provider.requestReviewers(url, 1, ["priya"], s)],
    ["mergePullRequest", () => provider.mergePullRequest(url, 1, { sha, method: "squash" }, s)],
    ["getJobLogTail", () => provider.getJobLogTail(url, "1", s)],
    ["getPathKindAtCommit", () => provider.getPathKindAtCommit!(url, "src/a.ts", sha, s)],
    ["listTreeAtCommit", () => provider.listTreeAtCommit!(url, sha, s)],
    // Wiki W0: the file map's two other listings.
    ["listDirectoryAtCommit", () => provider.listDirectoryAtCommit!(url, "", sha, s)],
    ["listCommitActivity", () => provider.listCommitActivity!(url, sha, s, { since: "2026-08-01T00:00:00Z", cap: 5 })],
    ["getPullRequestFileRevisions", () => provider.getPullRequestFileRevisions!(url, 1, s)],
    ["getCommitChanges", () => provider.getCommitChanges!(url, sha, s)],
    // Lane L4-LM1b (revert detection): the newest commits of a branch.
    ["listRecentCommits", () => provider.listRecentCommits!(url, "main", 10, s)],
    ["getCompareChanges", () => provider.getCompareChanges!(url, sha, "b".repeat(40), s)],
    ["listPullRequestComments", () => provider.listPullRequestComments!(url, 1, {}, s)],
    ["postPullRequestComment", () => provider.postPullRequestComment!(url, 1, "Done.", s)],
    // L4-EVW6: the eval wrapper pull request (the one narrow write) and its lookup.
    ["openEvalWrapperPullRequest", () => provider.openEvalWrapperPullRequest!(url, { repository: { url }, baseBranch: "main", baseRevision: sha, branch: "rovara/eval-wrapper-0123456789ab", path: "rovara/eval-wrapper.py", content: "x", title: "t", body: "b" }, s)],
    ["findEvalWrapperPullRequest", () => provider.findEvalWrapperPullRequest!(url, "rovara/eval-wrapper-0123456789ab", s)],
    // L4-RC: the "Rovara" Check write.
    ["upsertRovaraCheck", () => provider.upsertRovaraCheck!(url, { headSha: sha, payload: { status: "completed", conclusion: "success", title: "t", summary: "s", text: "x" } }, s)],
  ];
  return calls;
}

/** The refusal a call ends in: its code, and its words without the code in front (an AgentXError's message is `<code>: <words>`). */
async function refusal(call: () => Promise<unknown>): Promise<{ code?: unknown; message?: unknown } | undefined> {
  try { await call(); return undefined; } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { code, message: typeof code === "string" && typeof message === "string" && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
}

describe("the core's code host on the broker: company scope", () => {
  it("has every method the adapters need, and exactly the optional ones the App client has", async () => {
    const world = await bridgeWorld();
    expect(missingGitHubProviderMethods(world.provider)).toEqual([]);
    const names = scopedCalls(world.provider, GITHUB_REPO_URL, GITHUB_ORG_SCOPE).map(([name]) => name);
    // Every method of the bridge is checked below, apart from the three that take no scope (`summaryCheckSource` is the App's own id, which names no repository and no company).
    expect(Object.keys(world.provider).sort()).toEqual([...names, "installationForRepository", "fileDetailsError", "summaryCheckSource"].sort());
    expect(GITHUB_CODE_HOST_PROVIDER_METHODS.every((name) => names.includes(name) || name === "installationForRepository")).toBe(true);
  });

  it("refuses a system scope and a scope that is not one, with no read", async () => {
    const world = await bridgeWorld();
    for (const scope of [{ system: "install" }, { system: "webhook" }, { system: "private-install" }, {}, { orgId: "not-an-org" }, null, { orgId: A, extra: 1 }]) {
      for (const [name, call] of scopedCalls(world.provider, GITHUB_REPO_URL, scope)) {
        const error = await refusal(call);
        expect({ name, code: error?.code, message: error?.message }).toEqual({ name, code: "FORBIDDEN", message: SYSTEM_SCOPE_REFUSED });
      }
    }
    expect(world.net.requests).toEqual([]);
  });

  it("refuses an address that is not a canonical GitHub repository, in fixed words", async () => {
    const world = await bridgeWorld();
    for (const url of ["https://github.com/acme/app/extra", "http://github.com/acme/app", "https://gitlab.com/acme/app", "git@github.com:acme/app.git", "", 42 as unknown as string, "https://github.com/acme/" + "a".repeat(3_000)]) {
      const error = await refusal(() => world.provider.getRepositoryIdentity(url, GITHUB_ORG_SCOPE));
      expect(error?.code).toBe("PROJECT_ACCESS_DENIED");
      expect(error?.message).toBe(NOT_A_COMPANY_REPOSITORY);
    }
    expect(world.net.requests).toEqual([]);
  });
});

describe("the core's code host on the broker: the company's catalog", () => {
  it("reads only the company's own catalog, every page, each project's latest revision", async () => {
    const store = new MemoryDocumentStore();
    for (let index = 0; index < MAX_PROJECTS_PER_PAGE + 3; index += 1) await register(store, A, project(`p${String(index)}`, [`https://github.com/acme/r${String(index)}`]));
    await register(store, B, project("payments", ["https://github.com/bcorp/own"]));
    await store.put({ item: { ...projectRevisionKey(A, "p0", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...project("p0", ["https://github.com/acme/moved"]), revision: 2 })) as JsonValue } });
    await store.put({ item: { ...orgProjectCatalogKey(A, "p0"), entityType: "PROJECT_CATALOG", latestRevision: 2 } });
    const read = companyRepositoriesFromStore(async () => store);
    const repositories = await read(A);
    expect(repositories.size).toBe(MAX_PROJECTS_PER_PAGE + 3);
    expect(repositories.has("acme/moved")).toBe(true);
    expect(repositories.has("acme/r0")).toBe(false);
    expect(repositories.has("bcorp/own")).toBe(false);
    expect([...await read(B)]).toEqual(["bcorp/own"]);
  });

  it("refuses a catalog larger than the page limit allows, never a partial list", async () => {
    const store = new MemoryDocumentStore();
    for (let index = 0; index < 3; index += 1) await register(store, A, project(`p${String(index)}`, [`https://github.com/acme/r${String(index)}`]));
    const pages: number[] = [];
    const paged: Pick<DocumentStore, "get" | "query"> = {
      get: (key) => store.get(key),
      query: async (query) => { pages.push(1); const page = await store.query({ ...query, limit: 1 }); return page; },
    };
    expect(await refusal(() => companyRepositoriesFromStore(async () => paged, { maxPages: 2 })(A))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: CATALOG_UNREADABLE });
    expect(pages.length).toBe(2);
    expect((await companyRepositoriesFromStore(async () => paged, { maxPages: 3 })(A)).size).toBe(3);
    expect(MAX_CATALOG_PAGES).toBe(5);
  });

  it("one project whose current revision cannot be read names no repository and is logged, and every other project of the company still lists (arch rule 9)", async () => {
    const store = new MemoryDocumentStore();
    await register(store, A, project("good", ["https://github.com/acme/good"]));
    await register(store, A, project("also-good", ["https://github.com/acme/also-good"]));
    // A catalogue row whose current revision does not read (a corrupt record, or a field a later release wrote).
    await store.put({ item: { ...projectRevisionKey(A, "bad", 1), entityType: "PROJECT", definition: { name: "bad", revision: 1 } } });
    await store.put({ item: { ...orgProjectCatalogKey(A, "bad"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    // A catalogue that names a revision row that is not there is the same.
    await store.put({ item: { ...orgProjectCatalogKey(A, "dangling"), entityType: "PROJECT_CATALOG", latestRevision: 4 } });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect([...await companyRepositoriesFromStore(async () => store)(A)].sort()).toEqual(["acme/also-good", "acme/good"]);
    } finally { spy.mockRestore(); }
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry["event"] === "project.left_out_unreadable_revision");
    expect(events.map((entry) => entry["project"]).sort()).toEqual(["bad", "dangling"]);
    expect(events[0]).toMatchObject({ rule: "project_revision_unreadable", companyId: A });
    // Only the unreadable project's own repository operations refuse; the bridge still serves the good ones.
    const provider = companyScopedGitHubProvider((await bridgeWorld()).provider, { repositoriesOf: companyRepositoriesFromStore(async () => store) });
    expect(await refusal(() => provider.getRepositoryIdentity("https://github.com/acme/bad", GITHUB_ORG_SCOPE))).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: NOT_A_COMPANY_REPOSITORY });
  });

  it("refuses a malformed catalog row, a page that is not one, and a store failure, in fixed words that echo nothing", async () => {
    const store = new MemoryDocumentStore();
    await register(store, A, project("payments", [GITHUB_REPO_URL]));
    const cases: Array<Pick<DocumentStore, "get" | "query">> = [
      { get: (key) => store.get(key), query: async () => ({ items: [{ pk: "ORG#org_cccccccccccccccccccc#PROJECT_CATALOG", sk: "PROJECT#payments" }] }) },
      { get: (key) => store.get(key), query: async (query) => ({ items: [{ pk: query.pk, sk: "PROJECT#bad name secret-token-123" }] }) },
      { get: (key) => store.get(key), query: async () => ({ items: "nope" }) as never },
      { get: (key) => store.get(key), query: async (query) => ({ items: [{ pk: query.pk, sk: "PROJECT#payments" }], cursor: 7 }) as never },
      { get: (key) => store.get(key), query: async () => { throw new Error("secret-token-123 table missing"); } },
      { get: async () => { throw new Error("secret-token-123"); }, query: (query) => store.query(query) },
    ];
    for (const documents of cases) {
      const error = await refusal(() => companyRepositoriesFromStore(async () => documents)(A));
      expect({ code: error?.code, message: error?.message }).toEqual({ code: "RUNTIME_UNAVAILABLE", message: CATALOG_UNREADABLE });
    }
    // Through the bridge, the refusal is the same and GitHub is not asked.
    const world = await bridgeWorld();
    const provider = companyScopedGitHubProvider(world.provider, { repositoriesOf: companyRepositoriesFromStore(async () => cases[4]!) });
    expect(JSON.stringify(await refusal(() => provider.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE)))).not.toContain("secret-token");
    expect(world.net.requests).toEqual([]);
  });

  it("gives up on a slow catalog within its time limit", async () => {
    const store = new MemoryDocumentStore();
    await register(store, A, project("payments", [GITHUB_REPO_URL]));
    const slow: Pick<DocumentStore, "get" | "query"> = { get: (key) => store.get(key), query: () => new Promise(() => undefined) };
    const started = Date.now();
    expect(await refusal(() => companyRepositoriesFromStore(async () => slow, { timeoutMs: 50 })(A))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: CATALOG_UNREADABLE });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps a company's list for a short while: a new project's repository works at once, a removed one stops within the keep time", async () => {
    const store = new MemoryDocumentStore();
    await register(store, A, project("payments", [GITHUB_REPO_URL]));
    let reads = 0;
    let clock = 1_000;
    const read = companyRepositoriesFromStore(async () => store);
    const client = { getRepositoryIdentity: async () => ({ repositoryId: 1, fullName: "x" }) } as unknown as GitHubCodeHostProvider;
    const provider = companyScopedGitHubProvider(client, { repositoriesOf: async (companyId) => { reads += 1; return read(companyId); }, freshMs: 15_000, now: () => clock });
    await provider.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE);
    await provider.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE);
    expect(reads).toBe(1);
    // A project registered a moment ago: the kept list lacks it, so one fresh read finds it.
    await register(store, A, project("web", ["https://github.com/acme/web"]));
    await provider.getRepositoryIdentity("https://github.com/acme/web", GITHUB_ORG_SCOPE);
    expect(reads).toBe(2);
    // Removed from the project: still served from the kept list until it is old, then refused.
    await register(store, A, { ...project("web", ["https://github.com/acme/elsewhere"]), revision: 2 });
    await provider.getRepositoryIdentity("https://github.com/acme/web", GITHUB_ORG_SCOPE);
    clock += 15_000;
    expect((await refusal(() => provider.getRepositoryIdentity("https://github.com/acme/web", GITHUB_ORG_SCOPE)))?.code).toBe("PROJECT_ACCESS_DENIED");
    // One company's kept list never answers for another.
    expect((await refusal(() => provider.getRepositoryIdentity(GITHUB_REPO_URL, { orgId: B })))?.code).toBe("PROJECT_ACCESS_DENIED");
  });

  it("names repositories canonically", () => {
    expect(githubRepositoryKey("https://github.com/Acme/App.git")).toBe("acme/app");
    expect(githubRepositoryKey("https://github.com/acme/app/")).toBe("acme/app");
    expect(githubRepositoryKey("https://example.com/acme/app")).toBeUndefined();
    expect(githubRepositoryKey(undefined)).toBeUndefined();
  });
});

describe("the core's code host in the broker's adapter inputs", () => {

  it("names the missing adapter builders before validating the composed queue", () => {
    const workers: NonNullable<BrokerCoreModuleParts["workerMachines"]> = () => ({}) as ReturnType<NonNullable<BrokerCoreModuleParts["workerMachines"]>>;
    const codeHost: NonNullable<BrokerCoreModuleParts["codeHost"]> = () => ({}) as ReturnType<NonNullable<BrokerCoreModuleParts["codeHost"]>>;
    expect(() => brokerCoreModuleDeps({}, { workerMachines: workers })).toThrow(`${BROKER_CORE_NOT_CONFIGURED}: it needs ${BROKER_CORE_OWED.codeHost}`);

    const missingWorkers = (() => { try { brokerCoreModuleDeps({}, { codeHost: () => { throw new Error("not built while other inputs are owed"); } }); } catch (error) { return (error as Error).message; } return ""; })();
    expect(missingWorkers).toBe(`${BROKER_CORE_NOT_CONFIGURED}: it needs ${BROKER_CORE_OWED.workerMachines}`);

    expect(() => brokerCoreModuleDeps({}, { codeHost, workerMachines: workers })).toThrow("the broker needs valid core dispatch queue URLs");
  });
});
