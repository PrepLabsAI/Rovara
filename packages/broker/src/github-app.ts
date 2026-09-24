import { createSign } from "node:crypto";
import { agentXError, type AgentXError } from "@agentx/contracts";
import type { RepositoryAccess, RepositoryCredential } from "./repository-access.js";

export interface GitHubAppCredentialProviderOptions {
  credentialRef: string;
  account: string;
  appId: string;
  installationId: string;
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

export class GitHubAppCredentialProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GitHubAppCredentialProviderOptions) {
    if (!/^[1-9][0-9]*$/.test(options.appId)) throw new Error("GitHub App ID must be numeric");
    if (!/^[1-9][0-9]*$/.test(options.installationId)) {
      throw new Error("GitHub App installation ID must be numeric");
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(options.account)) {
      throw new Error("GitHub App account is invalid");
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolve(
    credentialRef: string,
    repositoryUrl: string,
    access: RepositoryAccess = "clone",
  ): Promise<RepositoryCredential> {
    if (credentialRef !== this.options.credentialRef) return {};
    const repository = parseGitHubRepository(repositoryUrl, this.options.account);
    const token = await this.createInstallationToken(repository.name, {
      contents: access === "push" ? "write" : "read",
    });
    return { username: "x-access-token", password: token };
  }

  async issueCredentials(
    repository: { credentialRef: string; url: string },
    access: "read" | "write",
  ): Promise<{ owner: string; repo: string; token: string }> {
    if (repository.credentialRef !== this.options.credentialRef) {
      throw agentXError("FORBIDDEN", "repository does not use the configured GitHub App");
    }
    const parsed = parseGitHubRepository(repository.url, this.options.account);
    const token = await this.createInstallationToken(parsed.name, { issues: access });
    return { owner: this.options.account, repo: parsed.name, token };
  }

  async reconcilePullRequest(input: GitHubPullRequestInput): Promise<GitHubPullRequestResult> {
    const repository = parseGitHubRepository(input.repositoryUrl, this.options.account);
    // GitHub's pull-request endpoint needs to resolve the private repository's
    // base and head refs. Keep the token repository-scoped, but allow it to
    // read those refs in addition to creating the pull request.
    const token = await this.createInstallationToken(repository.name, {
      contents: "read",
      pull_requests: "write",
    });
    const existing = await this.findOpenPullRequest(repository.name, input, token);
    if (existing) return { ...existing, reconciled: true };

    try {
      const response = await this.fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(this.options.account)}/${encodeURIComponent(repository.name)}/pulls`,
        {
          method: "POST",
          headers: githubHeaders(token),
          body: JSON.stringify({
            title: input.title,
            head: input.headBranch,
            base: input.baseBranch,
            ...(input.body === undefined ? {} : { body: input.body }),
          }),
        },
      );
      if (response.ok) return { ...parsePullRequest(await response.json(), this.options.account, repository.name), reconciled: false };
      const afterFailure = await this.findOpenPullRequest(repository.name, input, token);
      if (afterFailure) return { ...afterFailure, reconciled: true };
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request creation failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const afterFailure = await this.findOpenPullRequest(repository.name, input, token);
      if (afterFailure) return { ...afterFailure, reconciled: true };
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation outcome is unknown");
    }
  }

  async getPullRequest(repositoryUrl: string, number: number): Promise<GitHubPullRequestDetails> {
    const repository = parseGitHubRepository(repositoryUrl, this.options.account);
    const token = await this.createInstallationToken(repository.name, {
      contents: "read",
      pull_requests: "read",
    });
    return this.getPullRequestWithToken(repository.name, number, token);
  }

  async updatePullRequest(
    repositoryUrl: string,
    number: number,
    update: GitHubPullRequestUpdate,
  ): Promise<GitHubPullRequestDetails> {
    if (update.title === undefined && update.body === undefined && update.state === undefined) {
      throw agentXError("CONFIG_INVALID", "pull request update is empty");
    }
    const repository = parseGitHubRepository(repositoryUrl, this.options.account);
    const token = await this.createInstallationToken(repository.name, {
      contents: "read",
      pull_requests: "write",
    });
    try {
      const response = await this.fetchImplementation(
        pullRequestUrl(this.options.account, repository.name, number),
        {
          method: "PATCH",
          headers: githubHeaders(token),
          body: JSON.stringify(update),
        },
      );
      if (response.ok) {
        return parsePullRequestDetails(await response.json(), this.options.account, repository.name);
      }
      const reconciled = await this.getPullRequestWithToken(repository.name, number, token);
      if (matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request update failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const reconciled = await this.getPullRequestWithToken(repository.name, number, token).catch(() => undefined);
      if (reconciled && matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request update outcome is unknown");
    }
  }

  private async getPullRequestWithToken(
    repositoryName: string,
    number: number,
    token: string,
  ): Promise<GitHubPullRequestDetails> {
    const response = await this.fetchImplementation(
      pullRequestUrl(this.options.account, repositoryName, number),
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    return parsePullRequestDetails(await response.json(), this.options.account, repositoryName);
  }

  private async createInstallationToken(
    repositoryName: string,
    permissions: Record<string, "read" | "write">,
  ): Promise<string> {
    const privateKey = await this.options.getPrivateKey();
    const jwt = createGitHubAppJwt(this.options.appId, privateKey, this.now());
    const response = await this.fetchImplementation(
      `https://api.github.com/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "user-agent": "agentx-control-plane",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [repositoryName],
          permissions,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
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
    repositoryName: string,
    input: GitHubPullRequestInput,
    token: string,
  ): Promise<Omit<GitHubPullRequestResult, "reconciled"> | undefined> {
    const query = new URLSearchParams({
      state: "open",
      head: `${this.options.account}:${input.headBranch}`,
      base: input.baseBranch,
      per_page: "2",
    });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(this.options.account)}/${encodeURIComponent(repositoryName)}/pulls?${query.toString()}`,
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
    return parsePullRequest(value[0], this.options.account, repositoryName);
  }
}

function pullRequestUrl(account: string, repositoryName: string, number: number): string {
  if (!Number.isInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "pull request number is invalid");
  return `https://api.github.com/repos/${encodeURIComponent(account)}/${encodeURIComponent(repositoryName)}/pulls/${number}`;
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
  account: string,
  repositoryName: string,
): Omit<GitHubPullRequestResult, "reconciled"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.number) || (candidate.number as number) < 1 || typeof candidate.html_url !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const expected = `https://github.com/${account}/${repositoryName}/pull/${String(candidate.number)}`;
  if (candidate.html_url !== expected) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a non-canonical pull request URL");
  }
  return { number: candidate.number as number, url: candidate.html_url };
}

function parsePullRequestDetails(
  value: unknown,
  account: string,
  repositoryName: string,
): GitHubPullRequestDetails {
  const basic = parsePullRequest(value, account, repositoryName);
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

function parseGitHubRepository(repositoryUrl: string, expectedAccount: string): { name: string } {
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
    owner?.toLowerCase() !== expectedAccount.toLowerCase() ||
    !name ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name)
  ) {
    throw agentXError("FORBIDDEN", "repository is outside the configured GitHub App account");
  }
  return { name };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isAgentXError(error: unknown): error is AgentXError {
  return error instanceof Error && error.name === "AgentXError";
}
