import { agentXError, canonicalGitHubRepository, type GitHubAppBinding } from "@agentx/contracts";
import type { GitHubAppCredentialProvider } from "./github-app.js";
export type GitHubAppOperations = Pick<GitHubAppCredentialProvider, "resolve" | "reconcilePullRequest" | "getPullRequest" | "updatePullRequest">;
interface RouterOptions { legacy: GitHubAppOperations; bindings: GitHubAppBinding[]; createProvider: (binding: GitHubAppBinding) => GitHubAppOperations }
export class GitHubAppRouter {
  private readonly repositories = new Map<string, { reference: string; provider: GitHubAppOperations }>();
  private readonly references = new Set<string>();

  /** Bindings have already passed the shared configuration parser. */
  constructor(private readonly options: RouterOptions) {
    for (const binding of options.bindings) {
      if (this.references.has(binding.credentialRef)) throw agentXError("CONFIG_INVALID", "ambiguous GitHub App binding");
      this.references.add(binding.credentialRef);
      const provider = options.createProvider(binding);
      for (const repository of binding.repositories) {
        const key = canonicalGitHubRepository(repository);
        if (this.repositories.has(key)) throw agentXError("CONFIG_INVALID", "ambiguous GitHub App binding");
        this.repositories.set(key, { reference: binding.credentialRef, provider });
      }
    }
  }

  async resolve(...args: Parameters<GitHubAppOperations["resolve"]>) {
    const [reference, repository] = args;
    const binding = this.bindingFor(repository);
    if (binding) {
      if (binding.reference !== reference) throw agentXError("FORBIDDEN", "repository credential reference does not match its GitHub App");
      return binding.provider.resolve(...args);
    }
    if (this.references.has(reference)) throw agentXError("FORBIDDEN", "repository is outside the configured GitHub App binding");
    return this.options.legacy.resolve(...args);
  }
  async reconcilePullRequest(...args: Parameters<GitHubAppOperations["reconcilePullRequest"]>) {
    return this.providerFor(args[0].repositoryUrl).reconcilePullRequest(...args);
  }
  async getPullRequest(...args: Parameters<GitHubAppOperations["getPullRequest"]>) {
    return this.providerFor(args[0]).getPullRequest(...args);
  }
  async updatePullRequest(...args: Parameters<GitHubAppOperations["updatePullRequest"]>) {
    return this.providerFor(args[0]).updatePullRequest(...args);
  }
  private providerFor(repository: string): GitHubAppOperations {
    return this.bindingFor(repository)?.provider ?? this.options.legacy;
  }
  private bindingFor(repository: string) {
    if (this.repositories.size === 0) return undefined;
    let url: URL;
    try { url = new URL(repository); }
    catch { throw agentXError("CONFIG_INVALID", "invalid repository identity"); }
    // Non-GitHub public repositories retain the legacy no-credential behavior.
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    return this.repositories.get(canonicalGitHubRepository(repository));
  }
}
export function cachedPrivateKeyLoader(load: () => Promise<string>): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= Promise.resolve().then(load).catch(() => {
      pending = undefined;
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App key could not be loaded");
    });
    return pending;
  };
}
