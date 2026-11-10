// Port lane L7a: how the merge core reaches a repository's code host through the ONE registry (lane L2), never through a provider's client.
//
// The merge code asks `RepositoryResolver` for the repository of a task's project and gets back the address, the code host that serves it and, where there is one, the check runner for its
// builds. The code host is chosen by the repository record's `host.kind` (`codeHostForRecord`), never by the address and never by a default but the legacy one: a kind with no registered
// adapter is refused with a fixed sentence that does not name the kind, and nothing falls back to another adapter.
import type { CheckRunner, OrgId, PluginKind, RegistryView } from "@agentx/contracts";
import { codeHostForRecord, providerOf } from "../../plugins/routing.js";
import type { ConsumerRepository, RepositoryResolver } from "./host-port.js";

/** A repository as the task's project pins it: its address and the host its record names (a record without one is on the legacy kind). */
export interface PinnedRepository {
  url: string;
  host?: { kind: PluginKind } | undefined;
}

export interface RegistryResolverOptions {
  /** The project's pinned repository, by the project's pinned revision. Undefined where the project has no such repository. */
  pinned(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<PinnedRepository | undefined>;
  /** The check runner that reads this host's builds (their log tails), when one is registered for the kind. */
  checkRunner?(kind: PluginKind, repository: PinnedRepository): CheckRunner | undefined;
  /** Whether a person is in a team of the repository's organization (CODEOWNERS teams). Absent: no team can be told, so a code-owner team is never matched. */
  isTeamMember?(kind: PluginKind, repository: PinnedRepository): ConsumerRepository["isTeamMember"];
}

/** A `RepositoryResolver` over the registry's code-host point. Throws `CONFIG_INVALID` (a fixed sentence) for a record that names a host nobody registered. */
export function registryRepositoryResolver(registry: RegistryView, options: RegistryResolverOptions): RepositoryResolver {
  return async (project, revision, repositoryId, orgId) => {
    const repository = await options.pinned(project, revision, repositoryId, orgId);
    if (repository === undefined) return undefined;
    const codeHost = codeHostForRecord(registry, repository);
    // The runner and the team lookup of a repository are the ones registered under its CONNECTION's own name; only when there is none, the ones of the connection's provider (lane P2, review L2). A second
    // GitHub connection therefore never reads job logs or team membership with another connection's credential unless the install registered the provider's for all of its connections.
    const providerKind = providerOf(codeHost);
    const checkRunner = options.checkRunner?.(codeHost.kind, repository) ?? (providerKind === codeHost.kind ? undefined : options.checkRunner?.(providerKind, repository));
    const isTeamMember = options.isTeamMember?.(codeHost.kind, repository) ?? (providerKind === codeHost.kind ? undefined : options.isTeamMember?.(providerKind, repository));
    return { url: repository.url, codeHost, ...(checkRunner === undefined ? {} : { checkRunner }), ...(isTeamMember === undefined ? {} : { isTeamMember }) };
  };
}
