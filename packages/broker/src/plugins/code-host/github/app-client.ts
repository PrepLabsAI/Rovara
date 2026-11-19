// Port lane L7a: Cloud's GitHub App client (`client.ts`, a copy of Cloud v0.5.11 `packages/broker/src/github-app.ts` with only its relative import paths changed) as the
// `GitHubCodeHostProvider` the GitHub adapters are written against. The assignment below is the seam check: if the client ever stops having a method or a shape the provider
// names, this file stops compiling. The rules the client keeps (tenant binding on every call, least-privilege tokens for one repository, no redirects) are checked by the
// client conformance suite (tests/support/ports/github-client-conformance.ts), which every client put under the adapters must pass.
import { GitHubAppCredentialProvider, type GitHubAppCredentialProviderOptions } from "./client.js";
import type { GitHubCodeHostProvider } from "./provider.js";

export { GitHubAppCredentialProvider, type GitHubAppCredentialProviderOptions } from "./client.js";

/** Builds the GitHub App client and hands it over as the narrow provider the adapters take. */
export function githubAppClient(options: GitHubAppCredentialProviderOptions): GitHubCodeHostProvider {
  const client: GitHubCodeHostProvider = new GitHubAppCredentialProvider(options);
  return client;
}
