import { agentXError, parseAdditionalGitHubAppBindings, type GitHubAppBinding } from "@agentx/contracts";
import { GitHubAppCredentialProvider, privateKeyFromSecret } from "../github-app.js";
import { GitHubAppRouter, cachedPrivateKeyLoader } from "../github-app-router.js";

interface ConfiguredRouterOptions {
  legacy: Omit<GitHubAppBinding, "repositories">;
  additionalBindingsJson?: string;
  loadSecret: (arn: string) => Promise<string>;
  fetchImplementation?: typeof fetch;
}

/** Shared production composition, with only the external I/O injected for tests. */
export function createConfiguredGitHubAppRouter(options: ConfiguredRouterOptions): GitHubAppRouter {
  let decoded: unknown;
  try { decoded = JSON.parse(options.additionalBindingsJson ?? "[]"); }
  catch { throw agentXError("CONFIG_INVALID", "invalid GitHub App binding configuration"); }
  const bindings = parseAdditionalGitHubAppBindings(decoded, options.legacy.credentialRef);
  const provider = (binding: Omit<GitHubAppBinding, "repositories">) => new GitHubAppCredentialProvider({
    credentialRef: binding.credentialRef, account: binding.account,
    appId: binding.appId, installationId: binding.installationId,
    getPrivateKey: cachedPrivateKeyLoader(async () => privateKeyFromSecret(await options.loadSecret(binding.privateKeySecretArn))),
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  });
  return new GitHubAppRouter({ legacy: provider(options.legacy), bindings, createProvider: provider });
}
