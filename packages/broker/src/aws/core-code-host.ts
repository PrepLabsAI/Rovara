// Core switch-on lane L1b: the core engine's code host on the deployed BROKER, company-scoped.
//
// The broker's GitHub App is install-wide: one App, one secret, every installation of it. The core engine asks its code host for a company's work only (scope `{ orgId }`), so this bridge
// puts the App's full client (plugins/code-host/github/client.ts, built from the same secret as the broker's own client, aws/github-credentials.ts) behind `GitHubCodeHostProvider` and
// holds two rules on EVERY call, before the client mints a token or reads a repository:
//   1. The company comes from the call's scope, and only an organisation scope is served: a system scope (`webhook`, `install`) names no company and is refused.
//   2. The repository must be one of the company's OWN projects' repositories, read from the company's project catalog in the State table (`ORG#<company>#PROJECT_CATALOG`, then each
//      project's latest revision). The request's URL is only compared with that list, never trusted: a repository no project of the company names is refused (PROJECT_ACCESS_DENIED).
// The client keeps its own rules on top (the GitHub client conformance suite): the installation must be bound to the company at every mint (`requireInstallationBound`, the broker's
// GITHUB_INSTALLATION#<id> binding rows), tokens are least-privilege for the one repository, no redirects, bounded requests.
//
// Reading the catalog is bounded: at most MAX_CATALOG_PAGES pages of MAX_PROJECTS_PER_PAGE projects, and one total time limit (CATALOG_READ_TIMEOUT_MS). A catalog that is larger, slower or
// unreadable refuses the call in fixed words (never a partial list). A company's list is kept for CATALOG_FRESH_MS in this container; a repository not in a kept list is checked once more
// against a fresh read before it is refused, so a project registered a moment ago works at once, and a repository removed from a project stops being served within CATALOG_FRESH_MS.
//
// Methods that take no scope: `installationForRepository` (which installation, if any, serves a repository: no token, no repository content; the adapter calls it only after a scoped
// identity read of the same repository) and `fileDetailsError` (an error mapper) are passed through.
import { agentXError, HostScopeSchema, orgProjectCatalogPk, type DocumentStore, type HostScope, type OrgId } from "@agentx/contracts";
import { parseGitHubRepository } from "../plugins/code-host/github/client.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { githubAppClient, type GitHubAppCredentialProviderOptions } from "../plugins/code-host/github/app-client.js";
import type { GitHubActionsProvider } from "../plugins/check-runner/github-actions/index.js";
import type { GitHubCodeHostProvider } from "../plugins/code-host/github/provider.js";
import type { CodeModuleDeps } from "../core-host/code-modules.js";

/** Projects per catalog page, pages per read, the total time one read may take, and how long a read list is kept. */
export const MAX_PROJECTS_PER_PAGE = 100;
export const MAX_CATALOG_PAGES = 5;
export const CATALOG_READ_TIMEOUT_MS = 5_000;
export const CATALOG_FRESH_MS = 15_000;
/** At most this many companies' lists are kept per container (the oldest is dropped first). */
const MAX_KEPT_COMPANIES = 200;
/** Project reads in flight at once. */
const READ_CONCURRENCY = 8;

export const NOT_A_COMPANY_REPOSITORY = "the repository is not in one of this company's projects";
export const SYSTEM_SCOPE_REFUSED = "the core's code host serves a company's own work only";
export const CATALOG_UNREADABLE = "the company's projects could not be read just now; try again shortly";

/** The canonical name a GitHub repository is compared by (`owner/name`, lower case). Undefined: not a canonical GitHub repository address. */
export function githubRepositoryKey(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length > 2_048) return undefined;
  try {
    const parsed = parseGitHubRepository(url);
    return `${parsed.owner}/${parsed.name}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Reads the repositories (canonical GitHub names) of every project of one company. */
export type CompanyRepositories = (companyId: OrgId) => Promise<ReadonlySet<string>>;

const PROJECT_SK_PREFIX = "PROJECT#";
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * The repositories of a company's projects, from its own catalog in the store: every catalog row, then each project's latest revision (an archived project included: its tasks may still
 * be merged). Bounded (pages, time); anything malformed, too large or too slow throws in fixed words, so no partial list is ever returned.
 */
export function companyRepositoriesFromStore(store: () => Promise<Pick<DocumentStore, "get" | "query">>, options: { timeoutMs?: number; maxPages?: number } = {}): CompanyRepositories {
  const timeoutMs = options.timeoutMs ?? CATALOG_READ_TIMEOUT_MS;
  const maxPages = options.maxPages ?? MAX_CATALOG_PAGES;
  const read = async (companyId: OrgId, expired: () => boolean): Promise<ReadonlySet<string>> => {
    const documents = await store();
    const pk = orgProjectCatalogPk(companyId);
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= maxPages || expired()) throw new Error("catalog too large or too slow");
      const listed = await documents.query({ pk, sk: { op: "beginsWith", prefix: PROJECT_SK_PREFIX }, limit: MAX_PROJECTS_PER_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      if (!Array.isArray(listed?.items) || listed.items.length > MAX_PROJECTS_PER_PAGE) throw new Error("catalog page unreadable");
      for (const row of listed.items) {
        const name = typeof row?.sk === "string" && row.sk.startsWith(PROJECT_SK_PREFIX) ? row.sk.slice(PROJECT_SK_PREFIX.length) : "";
        if (row?.pk !== pk || !PROJECT_NAME.test(name)) throw new Error("catalog row unreadable");
        names.push(name);
      }
      if (listed.cursor === undefined) break;
      if (typeof listed.cursor !== "string") throw new Error("catalog cursor unreadable");
      cursor = listed.cursor;
    }
    const source = createStoreProjectSource(documents, companyId);
    const repositories = new Set<string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < names.length) {
        if (expired()) throw new Error("catalog too slow");
        const name = names[next]!;
        next += 1;
        const revision = await source.latest(name);
        // A catalog row whose project has no readable revision names no repository.
        for (const repository of revision?.definition.repositories ?? []) {
          const key = githubRepositoryKey(repository.url);
          if (key !== undefined) repositories.add(key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, names.length) }, worker));
    if (expired()) throw new Error("catalog too slow");
    return repositories;
  };
  return async (companyId) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("catalog too slow")), timeoutMs); });
    try {
      return await Promise.race([read(companyId, () => Date.now() - started > timeoutMs), limit]);
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", CATALOG_UNREADABLE);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Keeps each company's list for `freshMs`; a repository missing from a kept list is looked for once more in a fresh read. */
function keptRepositories(read: CompanyRepositories, freshMs: number, now: () => number): (companyId: OrgId, key: string) => Promise<boolean> {
  const kept = new Map<string, { at: number; repositories: ReadonlySet<string> }>();
  const fresh = async (companyId: OrgId): Promise<ReadonlySet<string>> => {
    const repositories = await read(companyId);
    kept.delete(companyId);
    if (kept.size >= MAX_KEPT_COMPANIES) kept.delete(kept.keys().next().value!);
    kept.set(companyId, { at: now(), repositories });
    return repositories;
  };
  return async (companyId, key) => {
    const found = kept.get(companyId);
    if (found !== undefined && now() - found.at < freshMs && found.repositories.has(key)) return true;
    return (await fresh(companyId)).has(key);
  };
}

export interface CompanyScopedProviderOptions {
  /** The company's repositories (`companyRepositoriesFromStore`). */
  repositoriesOf: CompanyRepositories;
  /** How long a company's list is kept. Default CATALOG_FRESH_MS; 0 reads it on every call. */
  freshMs?: number;
  now?: () => number;
  /** Told of each refusal, in fixed words (the company and the reason, never the address). */
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * The App client behind the company rules (see the top of this file). Only the methods named here exist on the result: a method the client gains later is not served until it is
 * added here with its check.
 */
export function companyScopedGitHubProvider(client: GitHubCodeHostProvider, options: CompanyScopedProviderOptions): GitHubCodeHostProvider {
  const owns = keptRepositories(options.repositoriesOf, options.freshMs ?? CATALOG_FRESH_MS, options.now ?? Date.now);
  const log = options.log ?? (() => undefined);
  /** The company scope of a call whose repository is one of the company's own; anything else throws before the client is asked. */
  const companyScope = async (repositoryUrl: unknown, scope: HostScope): Promise<{ orgId: OrgId }> => {
    const parsed = HostScopeSchema.safeParse(scope);
    if (!parsed.success || !("orgId" in parsed.data)) {
      log({ event: "core_engine.code_host_refused", reason: "system_scope" });
      throw agentXError("FORBIDDEN", SYSTEM_SCOPE_REFUSED);
    }
    const companyId = parsed.data.orgId;
    const key = githubRepositoryKey(repositoryUrl);
    if (key === undefined || !(await owns(companyId, key))) {
      log({ event: "core_engine.code_host_refused", companyId, reason: "not_a_company_repository" });
      throw agentXError("PROJECT_ACCESS_DENIED", NOT_A_COMPANY_REPOSITORY);
    }
    return { orgId: companyId };
  };

  const scoped: GitHubCodeHostProvider = {
    async getRepositoryIdentity(url, scope) { const s = await companyScope(url, scope); return client.getRepositoryIdentity(url, s); },
    async checkRepository(repository, scope) {
      const given = { credentialRef: repository?.credentialRef, url: repository?.url };
      const s = await companyScope(given.url, scope);
      return client.checkRepository(given, s);
    },
    async getRepositoryStanding(url, login, scope, budget) { const s = await companyScope(url, scope); return client.getRepositoryStanding(url, login, s, budget); },
    async resolveWithExpiry(credentialRef, url, access, scope) { const s = await companyScope(url, scope); return client.resolveWithExpiry(credentialRef, url, access, s); },
    async getFileAtCommit(url, path, commit, scope, fileOptions) { const s = await companyScope(url, scope); return client.getFileAtCommit(url, path, commit, s, fileOptions); },
    async getCommitTree(url, commit, scope) { const s = await companyScope(url, scope); return client.getCommitTree(url, commit, s); },
    async getBranchHead(url, branch, scope) { const s = await companyScope(url, scope); return client.getBranchHead(url, branch, s); },
    async listWorkingBranches(url, expected, scope, page) { const s = await companyScope(url, scope); return client.listWorkingBranches(url, expected, s, page); },
    async getCommitParents(url, commit, scope) { const s = await companyScope(url, scope); return client.getCommitParents(url, commit, s); },
    async getDefaultBranchHead(url, branch, scope) { const s = await companyScope(url, scope); return client.getDefaultBranchHead(url, branch, s); },
    async getPullRequestMergeObservation(url, number, budget, scope) { const s = await companyScope(url, scope); return client.getPullRequestMergeObservation(url, number, budget, s); },
    // No scope, no token, no repository content: which installation serves a repository (see the top of this file).
    async installationForRepository(owner, name, lookup) { return client.installationForRepository(owner, name, lookup); },
    async readCodeOwners(url, branch, scope) { const s = await companyScope(url, scope); return client.readCodeOwners(url, branch, s); },
    async reconcilePullRequest(input, scope) {
      const given = { ...input };
      const s = await companyScope(given.repositoryUrl, scope);
      return client.reconcilePullRequest(given, s);
    },
    async getPullRequest(url, number, scope) { const s = await companyScope(url, scope); return client.getPullRequest(url, number, s); },
    async updatePullRequest(url, number, update, scope) { const s = await companyScope(url, scope); return client.updatePullRequest(url, number, update, s); },
    async getPullRequestStatus(url, number, scope, budget) { const s = await companyScope(url, scope); return client.getPullRequestStatus(url, number, s, budget); },
    async listPullRequestFiles(url, number, page, scope) { const s = await companyScope(url, scope); return client.listPullRequestFiles(url, number, page, s); },
    async getPullRequestFeedback(url, number, scope) { const s = await companyScope(url, scope); return client.getPullRequestFeedback(url, number, s); },
    async replyToReviewThread(url, number, commentId, body, scope, budget) { const s = await companyScope(url, scope); return client.replyToReviewThread(url, number, commentId, body, s, budget); },
    async markPullRequestReady(url, number, scope, budget) { const s = await companyScope(url, scope); return client.markPullRequestReady(url, number, s, budget); },
    async requestReviewers(url, number, reviewers, scope, budget) { const s = await companyScope(url, scope); return client.requestReviewers(url, number, reviewers, s, budget); },
    async mergePullRequest(url, number, input, scope) { const s = await companyScope(url, scope); return client.mergePullRequest(url, number, input, s); },
    async getJobLogTail(url, jobId, scope, budget) { const s = await companyScope(url, scope); return client.getJobLogTail(url, jobId, s, budget); },
  };
  // The optional methods, only where the client has them (the adapter then offers the matching CodeHost method), each with the same check.
  const getPathKindAtCommit = client.getPathKindAtCommit?.bind(client);
  if (getPathKindAtCommit !== undefined) scoped.getPathKindAtCommit = async (url, path, commit, scope, kindOptions) => getPathKindAtCommit(url, path, commit, await companyScope(url, scope), kindOptions);
  const commitFilesToBranch = client.commitFilesToBranch?.bind(client);
  if (commitFilesToBranch !== undefined) scoped.commitFilesToBranch = async (url, request, scope) => commitFilesToBranch(url, request, await companyScope(url, scope));
  const findLessonsPullRequest = client.findLessonsPullRequest?.bind(client);
  if (findLessonsPullRequest !== undefined) scoped.findLessonsPullRequest = async (url, branch, scope) => findLessonsPullRequest(url, branch, await companyScope(url, scope));
  const deleteLessonsBranch = client.deleteLessonsBranch?.bind(client);
  if (deleteLessonsBranch !== undefined) scoped.deleteLessonsBranch = async (url, branch, scope) => deleteLessonsBranch(url, branch, await companyScope(url, scope));
  const listTreeAtCommit = client.listTreeAtCommit?.bind(client);
  if (listTreeAtCommit !== undefined) scoped.listTreeAtCommit = async (url, commit, scope, treeOptions) => listTreeAtCommit(url, commit, await companyScope(url, scope), treeOptions);
  const fileDetailsError = client.fileDetailsError?.bind(client);
  if (fileDetailsError !== undefined) scoped.fileDetailsError = (error) => fileDetailsError(error);
  const getPullRequestFileRevisions = client.getPullRequestFileRevisions?.bind(client);
  if (getPullRequestFileRevisions !== undefined) scoped.getPullRequestFileRevisions = async (url, number, scope) => getPullRequestFileRevisions(url, number, await companyScope(url, scope));
  const getCommitChanges = client.getCommitChanges?.bind(client);
  if (getCommitChanges !== undefined) scoped.getCommitChanges = async (url, commit, scope, beforePage) => getCommitChanges(url, commit, await companyScope(url, scope), beforePage);
  const getCompareChanges = client.getCompareChanges?.bind(client);
  if (getCompareChanges !== undefined) scoped.getCompareChanges = async (url, base, head, scope, beforePage) => getCompareChanges(url, base, head, await companyScope(url, scope), beforePage);
  const listPullRequestComments = client.listPullRequestComments?.bind(client);
  if (listPullRequestComments !== undefined) scoped.listPullRequestComments = async (url, number, page, scope, budget) => listPullRequestComments(url, number, page, await companyScope(url, scope), budget);
  const postPullRequestComment = client.postPullRequestComment?.bind(client);
  if (postPullRequestComment !== undefined) scoped.postPullRequestComment = async (url, number, text, scope, budget) => postPullRequestComment(url, number, text, await companyScope(url, scope), budget);
  return scoped;
}

export interface BrokerCoreCodeHostInputs {
  /** The App's credentials, from the same secret as the broker's own client (`GitHubAppCredentials.clientOptions`). */
  credentials: Pick<GitHubAppCredentialProviderOptions, "credentialRef" | "appId" | "getPrivateKey" | "getAppSecret">;
  /** Whether an installation is bound to a company, asked by the client before every mint (`GithubInstallationBindings.requireBound`). */
  requireInstallationBound: NonNullable<GitHubAppCredentialProviderOptions["requireInstallationBound"]>;
  /** Guided onboarding PR 3: whether the company's connection for a repository owner is uninstalled or suspended (`GithubInstallationBindings.disconnectedFor`). */
  disconnectedFor?: GitHubAppCredentialProviderOptions["disconnectedFor"];
  /** The core's own store (the registry's storage), where the company's project catalog is. */
  storage: () => Promise<Pick<DocumentStore, "get" | "query">>;
  log?: (entry: Record<string, unknown>) => void;
  /** Tests: the network and the clock. */
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

/** The broker's code host and check runner for the core (`CodeModuleDeps.codeHost` and `.checkRunner`): one company-scoped provider over the App's full client. Makes no call when built. */
export function brokerCoreCodeHost(inputs: BrokerCoreCodeHostInputs): Pick<CodeModuleDeps, "codeHost" | "checkRunner"> {
  const client = githubAppClient({
    credentialRef: inputs.credentials.credentialRef,
    appId: inputs.credentials.appId,
    getPrivateKey: inputs.credentials.getPrivateKey,
    ...(inputs.credentials.getAppSecret === undefined ? {} : { getAppSecret: inputs.credentials.getAppSecret }),
    requireInstallationBound: inputs.requireInstallationBound,
    ...(inputs.disconnectedFor === undefined ? {} : { disconnectedFor: inputs.disconnectedFor }),
    ...(inputs.fetchImplementation === undefined ? {} : { fetchImplementation: inputs.fetchImplementation }),
    ...(inputs.now === undefined ? {} : { now: inputs.now }),
  });
  const provider = companyScopedGitHubProvider(client, {
    repositoriesOf: companyRepositoriesFromStore(inputs.storage),
    ...(inputs.now === undefined ? {} : { now: inputs.now }),
    ...(inputs.log === undefined ? {} : { log: inputs.log }),
  });
  const githubActions: GitHubActionsProvider = provider;
  return { codeHost: { provider, options: { credentialRef: inputs.credentials.credentialRef } }, checkRunner: { githubActions } };
}
