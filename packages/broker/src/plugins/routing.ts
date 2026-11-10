// Port lane L2: which adapter serves what. These are the lookups Cloud's `plugins/registry.ts` did (its code host router, its check runner and
// tracker tables), written as plain functions over W0's ONE registry (`AdapterRegistry`, decisions 40, 45.5 and 51), so there is no second registry.
//
// What is dropped from Cloud's registry: the edition gate (nothing is Enterprise-only in Code) and the rule that GitHub must be registered. What is
// kept: a kind with no adapter is refused with a fixed sentence that does not echo the kind, and a lookup never falls back to another adapter.
import {
  PluginKindSchema, agentXError,
  type CheckRunner, type CheckRunnerContext, type CodeHost, type PluginKind, type RegistryView, type RepositoryRef, type Tracker,
} from "@agentx/contracts";
import { defaultConnectionOf } from "./code-host/connections.js";

export { providerOf } from "./code-host/connections.js";

export const NO_CODE_HOST_MESSAGE = "No code host is set up for this repository.";
/** Said when a repository record names a code host this install has not registered (the kind is not echoed). */
export const NO_HOST_MESSAGE = "This repository's code host is not available in this install.";
export const AMBIGUOUS_REPOSITORY_HOST_MESSAGE = "This repository is registered with different code host connections, so Rovara cannot tell which one to use.";
export const NO_TRACKER_MESSAGE = "No tracker is set up for this kind of item.";
export const NO_CHECK_RUNNER_MESSAGE = "No check runner is set up for this kind of build.";

/** The provider a repository record without a `host` is on; its default connection serves it (item C2). Records written before the host field name no provider, and the old default is GitHub. */
export const LEGACY_CODE_HOST_KIND: PluginKind = "github";

function requireKind(kind: PluginKind): void {
  if (!PluginKindSchema.safeParse(kind).success) throw agentXError("CONFIG_INVALID", "A plug-in has a name that is not a plug-in name.");
}

/**
 * The code host connection a name stands for (item C2): the connection registered under exactly that name; else, when the name is a provider (`github`), that provider's default connection. Undefined when neither.
 * Throws a `PluginRegistryError` (`ambiguous`) when the provider's connections have no single default.
 */
function connectionNamed(registry: RegistryView, name: PluginKind): CodeHost | undefined {
  return registry.get("code-host", name) ?? defaultConnectionOf(registry, name);
}

/** The default connection of a provider (item C2): the one a repository that names no code host uses. Throws CONFIG_INVALID (a fixed sentence) when the provider has none. */
export function defaultCodeHostFor(registry: RegistryView, provider: PluginKind): CodeHost {
  requireKind(provider);
  const host = defaultConnectionOf(registry, provider);
  if (host === undefined) throw agentXError("CONFIG_INVALID", NO_CODE_HOST_MESSAGE);
  return host;
}

/** The code host registered under this name (a connection), or the default connection of the provider of that name; throws CONFIG_INVALID (a fixed sentence) when there is none. */
export function codeHostForKind(registry: RegistryView, kind: PluginKind): CodeHost {
  requireKind(kind);
  const host = connectionNamed(registry, kind);
  if (host === undefined) throw agentXError("CONFIG_INVALID", NO_CODE_HOST_MESSAGE);
  return host;
}

/**
 * The code host for a repository record, by its `host.kind` (a connection name, or a provider whose default connection serves it). A record without one is on the default connection of
 * `LEGACY_CODE_HOST_KIND`. Throws CONFIG_INVALID with a fixed sentence when that has no registered host; never falls back to another host.
 */
export function codeHostForRecord(registry: RegistryView, repository: { host?: { kind: PluginKind } | undefined }): CodeHost {
  const named = repository.host?.kind;
  if (named === undefined) {
    const standard = defaultConnectionOf(registry, LEGACY_CODE_HOST_KIND);
    if (standard === undefined) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
    return standard;
  }
  const kind = named;
  requireKind(kind);
  const host = connectionNamed(registry, kind);
  if (host === undefined) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  return host;
}

/**
 * The connection that serves a repository, found by its address among the registered repositories' records (lane P2, review M1): the one its record resolves to (`codeHostForRecord`). A repository no record
 * holds is on the default connection of the legacy provider. An address held by records that name different connections is refused (CONFIG_INVALID, a fixed sentence): no guess.
 */
export function codeHostForRepositoryAddress(registry: RegistryView, address: string, records: readonly { url: string; host?: { kind: PluginKind } | undefined }[]): CodeHost {
  // Records that name different hosts but resolve to the SAME connection (no host, and `host: { kind: "github" }` when `github` is the default) agree; only records that resolve to different connections are refused (review N2).
  const resolved = new Map<string, CodeHost>();
  for (const record of records) {
    if (record.url !== address) continue;
    const host = codeHostForRecord(registry, record.host === undefined ? {} : { host: record.host });
    resolved.set(host.kind, host);
  }
  if (resolved.size > 1) throw agentXError("CONFIG_INVALID", AMBIGUOUS_REPOSITORY_HOST_MESSAGE);
  return [...resolved.values()][0] ?? codeHostForRecord(registry, {});
}

/** The code host that serves a bare repository address. `hostKindOf` says which kind an address is on; the default is `LEGACY_CODE_HOST_KIND`. */
export function codeHostForRepository(registry: RegistryView, repository: RepositoryRef, hostKindOf: (repository: RepositoryRef) => PluginKind = () => LEGACY_CODE_HOST_KIND): CodeHost {
  return codeHostForKind(registry, hostKindOf(repository));
}

/** The kinds of code host registered, sorted. */
export function codeHostKinds(registry: RegistryView): readonly PluginKind[] {
  return registry.names("code-host");
}

/** At task start: every repository of the project must have a registered code host, or the start is refused before any work is spent. */
export function assertRepositoryHostsKnown(registry: RegistryView, repositories: readonly { host?: { kind: PluginKind } | undefined }[]): void {
  for (const repository of repositories) {
    const named = repository.host?.kind;
    const found = named === undefined ? defaultConnectionOf(registry, LEGACY_CODE_HOST_KIND) : PluginKindSchema.safeParse(named).success ? connectionNamed(registry, named) : undefined;
    if (found === undefined) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  }
}

/** The tracker registered under this kind; throws CONFIG_INVALID (a fixed sentence, the kind not echoed) when none is registered. Never falls back to another tracker. */
export function trackerForKind(registry: RegistryView, kind: PluginKind): Tracker {
  requireKind(kind);
  const tracker = registry.get("tracker", kind);
  if (tracker === undefined) throw agentXError("CONFIG_INVALID", NO_TRACKER_MESSAGE);
  return tracker;
}

export function trackerKinds(registry: RegistryView): readonly PluginKind[] {
  return registry.names("tracker");
}

/** A check runner of this kind, built for the given context (the repositories the caller's project registered). */
export function checkRunnerForKind(registry: RegistryView, kind: PluginKind, context: CheckRunnerContext): CheckRunner {
  requireKind(kind);
  const adapter = registry.get("check-runner", kind);
  if (adapter === undefined) throw agentXError("CONFIG_INVALID", NO_CHECK_RUNNER_MESSAGE);
  const runner = adapter.create(context);
  if (runner.kind !== kind) throw agentXError("CONFIG_INVALID", "A check runner's name does not match the name it was registered under.");
  return runner;
}

export function checkRunnerKinds(registry: RegistryView): readonly PluginKind[] {
  return registry.names("check-runner");
}
