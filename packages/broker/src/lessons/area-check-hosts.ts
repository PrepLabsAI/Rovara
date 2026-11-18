// Lessons phase 2: the code-host side of the nightly area check (`area-check.ts`), the same for a deployed install and a laptop. The files of a repository come from the code host's own tree read at the head of the default branch, the
// way the wiki's free file map reads it (`core/wiki/file-map.ts`): ONE head, the whole tree or nothing. A repository the host cannot list whole (no listing, a cut list, an unregistered host, a failed read) is "not known", and a
// lesson that depends on it is not marked. "Area rewritten" needs a line count per file that no host port gives today, so `changed` is NOT wired here: that check stays off until a host can answer it (it is a port, not a guess).
import type { CodeHost, HostScope, OrgId, PluginKind } from "@agentx/contracts";
import type { ProjectSource } from "../core/task-flow/deps.js";
import type { AreaCheckPorts } from "./area-check.js";

const READ_TIMEOUT_MS = 8_000;
type RepositoryRecord = { name: string; url: string; defaultBranch: string; host?: { kind: PluginKind } | undefined };
export type AreaCheckHost = Pick<CodeHost, "baseBranchHead" | "repositoryTree">;

export function codeHostAreaPorts(options: { projects: Pick<ProjectSource, "latest">; hostOf: (repository: RepositoryRecord) => AreaCheckHost | undefined; companyId: OrgId }): AreaCheckPorts {
  const scope: HostScope = { orgId: options.companyId };
  const repositoriesOf = async (project: string): Promise<readonly RepositoryRecord[] | undefined> => (await options.projects.latest(project).catch(() => undefined))?.definition.repositories;
  return {
    async repositories(key) { return (await repositoriesOf(key.project))?.map((repository) => repository.name); },
    async files(key, repositoryName) {
      const repository = (await repositoriesOf(key.project))?.find((candidate) => candidate.name === repositoryName);
      const host = repository === undefined ? undefined : options.hostOf(repository);
      if (repository === undefined || host === undefined || host.repositoryTree === undefined) return undefined;
      try {
        const commit = await host.baseBranchHead({ url: repository.url }, repository.defaultBranch, scope);
        if (!/^[a-f0-9]{40}$/u.test(commit)) return undefined;
        const read = await host.repositoryTree({ url: repository.url }, commit, scope, { timeoutMs: READ_TIMEOUT_MS });
        // A cut list is not the whole tree: "no file matches" would be a guess.
        return read.complete ? read.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path) : undefined;
      } catch { return undefined; }
    },
  };
}
