import { createSign } from "node:crypto";
import { agentXError, type AgentXError } from "@agentx/contracts";
import type { RepositoryAccess, RepositoryCredential } from "./repository-access.js";

const GITHUB_APP_ID = /^[1-9][0-9]*$/;

export interface GitHubAppCredentialProviderOptions {
  credentialRef: string;
  /** The App's id, or a function that reads it when first needed: an install's control plane
   * deploys before its GitHub App exists, and then reads the id from the App's secret. */
  appId: string | (() => Promise<string>);
  getPrivateKey: () => Promise<string>;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

export interface GitHubPullRequestInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  /** Spec 025 FR-023: opens the pull request as a draft; GitHub's default applies when absent. */
  draft?: boolean;
}

export interface GitHubPullRequestResult {
  number: number;
  url: string;
  reconciled: boolean;
}

export interface GitHubPullRequestDetails {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  mergeCommit?: string;
  title: string;
  body: string;
}

export interface GitHubPullRequestUpdate {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

export interface GitHubWebhookRepositoryScope {
  installationId: number;
  repositoryId: number;
  fullName: string;
}

/** A repository the App can reach: its installation, and the owner as GitHub spells it. */
interface InstalledRepository {
  owner: string;
  name: string;
  installationId: number;
}

/**
 * Credentials from one GitHub App for repositories in every account it is installed on (#123).
 * Each repository's installation is looked up by its owner and cached for the process's
 * lifetime. There is no account allowlist: only administrators register repositories, and an
 * installation's token reaches only that installation's repositories.
 */
export class GitHubAppCredentialProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly installations = new Map<string, Promise<{ id: number; login: string }>>();

  constructor(private readonly options: GitHubAppCredentialProviderOptions) {
    if (typeof options.appId === "string" && !GITHUB_APP_ID.test(options.appId)) throw new Error("GitHub App ID must be numeric");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolve(
    credentialRef: string,
    repositoryUrl: string,
    access: RepositoryAccess = "clone",
  ): Promise<RepositoryCredential> {
    if (credentialRef !== this.options.credentialRef) return {};
    const token = await this.createInstallationToken(parseGitHubRepository(repositoryUrl), {
      contents: access === "push" ? "write" : "read",
    });
    return { username: "x-access-token", password: token };
  }

  /** Refuses, with CONFIG_INVALID, a repository of this App's credential that the App cannot reach. */
  async checkRepository(repository: { credentialRef: string; url: string }): Promise<void> {
    if (repository.credentialRef !== this.options.credentialRef) return;
    await this.installed(parseGitHubRepository(repository.url));
  }

  /** Confirms a signed webhook's repository identity against the App's current installation and GitHub API. */
  async verifyWebhookRepository(repositoryUrl: string, scope: GitHubWebhookRepositoryScope): Promise<boolean> {
    const parsed = parseGitHubRepository(repositoryUrl);
    const expectedFullName = `${parsed.owner}/${parsed.name}`.toLowerCase();
    if (scope.fullName.toLowerCase() !== expectedFullName) return false;
    const installed = await this.installed(parsed);
    if (installed.installationId !== scope.installationId) return false;
    const token = await this.createInstallationToken(installed, { contents: "read" });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(installed.owner)}/${encodeURIComponent(installed.name)}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(5_000), redirect: "error" },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository response");
    }
    const record = body as Record<string, unknown>;
    return Number.isSafeInteger(record.id) && record.id === scope.repositoryId
      && typeof record.full_name === "string" && record.full_name.toLowerCase() === expectedFullName;
  }

  async issueCredentials(
    repository: { credentialRef: string; url: string },
    access: "read" | "write",
  ): Promise<{ owner: string; repo: string; token: string }> {
    if (repository.credentialRef !== this.options.credentialRef) {
      throw agentXError("FORBIDDEN", "repository does not use the configured GitHub App");
    }
    const parsed = parseGitHubRepository(repository.url);
    const installed = await this.installed(parsed);
    const token = await this.createInstallationToken(parsed, { issues: access });
    return { owner: installed.owner, repo: parsed.name, token };
  }

  async reconcilePullRequest(input: GitHubPullRequestInput): Promise<GitHubPullRequestResult> {
    const repository = await this.installed(parseGitHubRepository(input.repositoryUrl));
    // GitHub's pull-request endpoint needs to resolve the private repository's
    // base and head refs. Keep the token repository-scoped, but allow it to
    // read those refs in addition to creating the pull request.
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "write",
    });
    const existing = await this.findOpenPullRequest(repository, input, token);
    if (existing) return { ...existing, reconciled: true };

    try {
      const response = await this.fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls`,
        {
          method: "POST",
          headers: githubHeaders(token),
          body: JSON.stringify({
            title: input.title,
            head: input.headBranch,
            base: input.baseBranch,
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.draft === undefined ? {} : { draft: input.draft }),
          }),
        },
      );
      if (response.ok) return { ...parsePullRequest(await response.json(), repository), reconciled: false };
      const afterFailure = await this.findOpenPullRequest(repository, input, token);
      if (afterFailure) return { ...afterFailure, reconciled: true };
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request creation failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const afterFailure = await this.findOpenPullRequest(repository, input, token);
      if (afterFailure) return { ...afterFailure, reconciled: true };
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation outcome is unknown");
    }
  }

  async getPullRequest(repositoryUrl: string, number: number): Promise<GitHubPullRequestDetails> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "read",
    });
    return this.getPullRequestWithToken(repository, number, token);
  }

  async updatePullRequest(
    repositoryUrl: string,
    number: number,
    update: GitHubPullRequestUpdate,
  ): Promise<GitHubPullRequestDetails> {
    if (update.title === undefined && update.body === undefined && update.state === undefined) {
      throw agentXError("CONFIG_INVALID", "pull request update is empty");
    }
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "write",
    });
    try {
      const response = await this.fetchImplementation(
        pullRequestUrl(repository, number),
        {
          method: "PATCH",
          headers: githubHeaders(token),
          body: JSON.stringify(update),
        },
      );
      if (response.ok) {
        return parsePullRequestDetails(await response.json(), repository);
      }
      const reconciled = await this.getPullRequestWithToken(repository, number, token);
      if (matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request update failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const reconciled = await this.getPullRequestWithToken(repository, number, token).catch(() => undefined);
      if (reconciled && matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request update outcome is unknown");
    }
  }

  private async getPullRequestWithToken(
    repository: InstalledRepository,
    number: number,
    token: string,
  ): Promise<GitHubPullRequestDetails> {
    const response = await this.fetchImplementation(
      pullRequestUrl(repository, number),
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    return parsePullRequestDetails(await response.json(), repository);
  }

  /** The repository's installation, cached by owner; a failed lookup is not cached. */
  private async installed(repository: { owner: string; name: string }): Promise<InstalledRepository> {
    const key = repository.owner.toLowerCase();
    let installation = this.installations.get(key);
    if (installation === undefined) {
      installation = this.lookUpInstallation(repository);
      this.installations.set(key, installation);
      const pending = installation;
      pending.catch(() => {
        if (this.installations.get(key) === pending) this.installations.delete(key);
      });
    }
    const { id, login } = await installation;
    return { owner: login, name: repository.name, installationId: id };
  }

  private async lookUpInstallation(repository: { owner: string; name: string }): Promise<{ id: number; login: string }> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/installation`,
      { headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error" },
    );
    if (response.status === 404) {
      throw agentXError(
        "CONFIG_INVALID",
        `the GitHub App cannot access ${repository.owner}/${repository.name}; install it on ${repository.owner} with access to that repository`,
      );
    }
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installation lookup failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const id = body && typeof body === "object" && "id" in body ? body.id : undefined;
    const account = body && typeof body === "object" && "account" in body ? body.account : undefined;
    const login = account && typeof account === "object" && "login" in account ? account.login : undefined;
    if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof login !== "string" || login.toLowerCase() !== repository.owner.toLowerCase()) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation response");
    }
    return { id: id as number, login };
  }

  /** Spec 025 A13: how many accounts the App is installed on (the first 100), for the health route. */
  async installationCount(): Promise<number> {
    const response = await this.fetchImplementation("https://api.github.com/app/installations?per_page=100", {
      headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installations lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installations response");
    return body.length;
  }

  private async appHeaders(): Promise<Record<string, string>> {
    const appId = typeof this.options.appId === "string" ? this.options.appId : await this.options.appId();
    if (!GITHUB_APP_ID.test(appId)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App ID must be numeric");
    const privateKey = await this.options.getPrivateKey();
    const jwt = createGitHubAppJwt(appId, privateKey, this.now());
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "agentx-control-plane",
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * A token for one repository. When the cached installation is gone (the App was uninstalled
   * and installed again, which gives it a new ID), the installation is looked up once more.
   */
  private async createInstallationToken(
    repository: { owner: string; name: string },
    permissions: Record<string, "read" | "write">,
    retried = false,
  ): Promise<string> {
    const installed = await this.installed(repository);
    const response = await this.fetchImplementation(
      `https://api.github.com/app/installations/${installed.installationId}/access_tokens`,
      {
        method: "POST",
        headers: await this.appHeaders(),
        body: JSON.stringify({
          repositories: [installed.name],
          permissions,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    if (response.status === 404 && !retried) {
      this.installations.delete(installed.owner.toLowerCase());
      return this.createInstallationToken(repository, permissions, true);
    }
    if (!response.ok) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `GitHub App installation token request failed with HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation token response");
    }
    return body.token;
  }

  private async findOpenPullRequest(
    repository: InstalledRepository,
    input: GitHubPullRequestInput,
    token: string,
  ): Promise<Omit<GitHubPullRequestResult, "reconciled"> | undefined> {
    const query = new URLSearchParams({
      state: "open",
      head: `${repository.owner}:${input.headBranch}`,
      base: input.baseBranch,
      per_page: "2",
    });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query.toString()}`,
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
    }
    if (value.length === 0) return undefined;
    return parsePullRequest(value[0], repository);
  }
}

function pullRequestUrl(repository: InstalledRepository, number: number): string {
  if (!Number.isInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "pull request number is invalid");
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`;
}

function matchesUpdate(details: GitHubPullRequestDetails, update: GitHubPullRequestUpdate): boolean {
  return (update.title === undefined || details.title === update.title) &&
    (update.body === undefined || details.body === update.body) &&
    (update.state === undefined || details.state === update.state);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agentx-control-plane",
    "x-github-api-version": "2022-11-28",
  };
}

function parsePullRequest(
  value: unknown,
  repository: InstalledRepository,
): Omit<GitHubPullRequestResult, "reconciled"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.number) || (candidate.number as number) < 1 || typeof candidate.html_url !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${String(candidate.number)}`;
  if (candidate.html_url !== expected) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a non-canonical pull request URL");
  }
  return { number: candidate.number as number, url: candidate.html_url };
}

function parsePullRequestDetails(
  value: unknown,
  repository: InstalledRepository,
): GitHubPullRequestDetails {
  const basic = parsePullRequest(value, repository);
  const candidate = value as Record<string, unknown>;
  const head = candidate.head;
  const base = candidate.base;
  if (
    (candidate.state !== "open" && candidate.state !== "closed") ||
    typeof candidate.merged !== "boolean" ||
    !head || typeof head !== "object" || Array.isArray(head) ||
    !base || typeof base !== "object" || Array.isArray(base) ||
    typeof (head as Record<string, unknown>).ref !== "string" ||
    typeof (head as Record<string, unknown>).sha !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test((head as Record<string, unknown>).sha as string) ||
    typeof (base as Record<string, unknown>).ref !== "string" ||
    typeof candidate.title !== "string" ||
    (candidate.body !== null && typeof candidate.body !== "string") ||
    (candidate.merge_commit_sha !== null && typeof candidate.merge_commit_sha !== "string")
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  return {
    ...basic,
    state: candidate.merged ? "merged" : candidate.state,
    headBranch: (head as Record<string, unknown>).ref as string,
    baseBranch: (base as Record<string, unknown>).ref as string,
    headCommit: (head as Record<string, unknown>).sha as string,
    ...(typeof candidate.merge_commit_sha === "string" ? { mergeCommit: candidate.merge_commit_sha } : {}),
    title: candidate.title,
    body: candidate.body ?? "",
  };
}

export function createGitHubAppJwt(appId: string, privateKey: string, nowMilliseconds: number): string {
  const issuedAt = Math.floor(nowMilliseconds / 1_000) - 60;
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({ iat: issuedAt, exp: issuedAt + 600, iss: appId });
  const signingInput = `${header}.${payload}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
  } catch (error) {
    if (isAgentXError(error)) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private key could not sign a token");
  }
}

export function privateKeyFromSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (
      value &&
      typeof value === "object" &&
      "privateKey" in value &&
      typeof value.privateKey === "string" &&
      value.privateKey.trim().startsWith("-----BEGIN")
    ) {
      return value.privateKey.trim();
    }
  } catch {
    // Report one stable error below without reflecting secret contents.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is not a PEM key");
}

/** The App's id from the secret `agentx init` stores (`{"appId", "privateKey", ...}`). A secret
 * holding only a PEM key has none: its control plane passes GITHUB_APP_ID instead. */
export function appIdFromSecret(secret: string): string {
  try {
    const value = JSON.parse(secret.trim()) as unknown;
    if (value && typeof value === "object" && "appId" in value && typeof value.appId === "string" && GITHUB_APP_ID.test(value.appId)) {
      return value.appId;
    }
  } catch {
    // Report one stable error below without reflecting secret contents.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App secret holds no appId; set the control plane's GitHubAppId parameter");
}

/** Reads the optional webhook HMAC secret from the same protected App secret JSON object. */
export function webhookSecretFromSecret(secret: string): string {
  try {
    const value = JSON.parse(secret.trim()) as unknown;
    if (value && typeof value === "object" && "webhookSecret" in value && typeof value.webhookSecret === "string") {
      const webhookSecret = value.webhookSecret.trim();
      if (webhookSecret.length >= 32 && Buffer.byteLength(webhookSecret, "utf8") <= 4_096) return webhookSecret;
    }
  } catch {
    // Do not include secret material in errors.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App secret does not contain a valid webhook secret");
}

function parseGitHubRepository(repositoryUrl: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw agentXError("CONFIG_INVALID", "GitHub repository URL is invalid");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== 2 ||
    segments.some((segment) => segment.includes("%"))
  ) {
    throw agentXError("CONFIG_INVALID", "credentialed repository must be a canonical GitHub HTTPS URL");
  }
  const [owner, rawName] = segments;
  const name = rawName?.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    !owner ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !name ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name)
  ) {
    throw agentXError("CONFIG_INVALID", "credentialed repository must be a canonical GitHub HTTPS URL");
  }
  return { owner, name };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isAgentXError(error: unknown): error is AgentXError {
  return error instanceof Error && error.name === "AgentXError";
}
