// Port lane P2 (item C2): code-host CONNECTIONS. A connection is one registered code-host adapter: it has a name (`github`, `github-company`, equal to its `kind` and to the name it is registered under) and a provider
// (the kind of host it is: `github`). Several connections can share a provider, and ONE of them is the default connection of that provider: the one a repository that names no code host uses.
//
// A repository record names a connection by `host.kind`. When no connection has that exact name but the name is a provider, the provider's default connection serves it. Nothing falls back to a connection of another provider,
// and two default connections of one provider, or several connections with no default, are refused with a fixed sentence (never a guess).
import { PluginRegistryError, type CodeHost, type PluginKind, type RegistryView } from "@agentx/contracts";

export const AMBIGUOUS_CONNECTION_MESSAGE = "This install has several code host connections of one kind and none is set as the default.";
export const TWO_DEFAULT_CONNECTIONS_MESSAGE = "This install has two default code host connections of one kind.";

/** The provider a connection is of: its `provider`, else its own name. */
export const providerOf = (host: Pick<CodeHost, "kind" | "provider">): PluginKind => host.provider ?? host.kind;

function connectionsOf(registry: RegistryView): CodeHost[] {
  const out: CodeHost[] = [];
  for (const name of registry.names("code-host")) {
    const host = registry.get("code-host", name);
    if (host !== undefined) out.push(host);
  }
  return out;
}

/** The default connection of a provider, or undefined when no connection is of that provider. Throws a `PluginRegistryError` (`ambiguous`) when there are several and the default is not exactly one. */
export function defaultConnectionOf(registry: RegistryView, provider: PluginKind): CodeHost | undefined {
  const ofProvider = connectionsOf(registry).filter((host) => providerOf(host) === provider);
  if (ofProvider.length === 0) return undefined;
  const flagged = ofProvider.filter((host) => host.defaultConnection === true);
  if (flagged.length > 1) throw new PluginRegistryError("ambiguous", TWO_DEFAULT_CONNECTIONS_MESSAGE);
  if (flagged.length === 1) return flagged[0];
  if (ofProvider.length === 1) return ofProvider[0];
  throw new PluginRegistryError("ambiguous", AMBIGUOUS_CONNECTION_MESSAGE);
}

/**
 * Whether the registered connections are well formed: no provider has two default connections, and no provider has several connections without one. Returns the problems in words (a name, never a setting).
 * The config loader refuses a config that has any, so it fails when the process starts and not at a repository's first use.
 */
export function connectionProblems(registry: RegistryView): string[] {
  const problems: string[] = [];
  const providers = new Set(connectionsOf(registry).map(providerOf));
  for (const provider of providers) {
    try {
      defaultConnectionOf(registry, provider);
    } catch (error) {
      problems.push(error instanceof PluginRegistryError ? `${provider}: ${error.message}` : `${provider}: the connections cannot be told apart`);
    }
  }
  return problems;
}
