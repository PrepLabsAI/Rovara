import { createSign } from "node:crypto";
import { agentXError, type AgentXError } from "@agentx/contracts";
import type { RepositoryCredential } from "./repository-access.js";

export interface GitHubAppCredentialProviderOptions {
  credentialRef: string;
  account: string;
  appId: string;
  installationId: string;
  getPrivateKey: () => Promise<string>;
  fetchImplementation?: typeof fetch;
  now?: () => number;
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

  async resolve(credentialRef: string, repositoryUrl: string): Promise<RepositoryCredential> {
    if (credentialRef !== this.options.credentialRef) return {};
    const repository = parseGitHubRepository(repositoryUrl, this.options.account);
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
          repositories: [repository.name],
          permissions: { contents: "read" },
        }),
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
    return { username: "x-access-token", password: body.token };
  }
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
