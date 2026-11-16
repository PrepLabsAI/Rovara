// The real readers the watcher's seams need (M7 slice 2), each bound to ONE company on every read:
//
//   tasks      the task a merge belongs to: only when the record names the caller's company (a task id alone is not unique to a company), and a project name.
//   settings   the project's `afterMergeWatch` setting, read live from the project's newest saved revision (`ProjectDefinition.afterMergeWatch`). The value is untrusted until `afterMergeSettingsOf` has checked it: a project that
//              does not exist, is archived, or has no setting is off, and so is a record that does not parse.
//   hosts      the code host and repository a task's own pinned project names for a repository (the one place a GitHub repository name is tied to a company's project), in the company's scope.
import type { CodeHost, DocumentStore, OrgId, PluginKind, RegistryView } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import { taskKey } from "../task-flow/keys.js";
import { createStoreProjectSource } from "../task-flow/project-source.js";
import type { ProjectSource } from "../task-flow/deps.js";
import { githubRepositoryOfUrl, type AfterMergeHosts } from "./deploy-source.js";
import type { AfterMergeSettingsReader, AfterMergeTask, AfterMergeTasks } from "./ports.js";

/** The task of this company, or undefined: no such task, another company's task, or a record that has no project name. */
export function createStoreAfterMergeTasks(store: Pick<DocumentStore, "get">): AfterMergeTasks {
  return {
    async read(orgId: OrgId, taskId: string): Promise<AfterMergeTask | undefined> {
      if (typeof taskId !== "string" || taskId === "") return undefined;
      const record = await store.get(taskKey(taskId));
      if (record === undefined) return undefined;
      const company = record["companyId"] ?? record["orgId"];
      const project = record["project"];
      if (company !== orgId || typeof project !== "string" || project === "" || record["taskId"] !== taskId) return undefined;
      return { taskId, orgId, project };
    },
  };
}

/** The project's setting as saved, untrusted. Absent, archived, or a project that does not exist: undefined (off). A store fault throws (the watcher reads that as off and logs a fixed code). */
export function createProjectAfterMergeSettings(store: Pick<DocumentStore, "get" | "query">, projectsOf: (orgId: OrgId) => ProjectSource = (orgId) => createStoreProjectSource(store, orgId)): AfterMergeSettingsReader {
  return {
    async read(orgId: OrgId, project: string): Promise<unknown> {
      const revision = await projectsOf(orgId).latest(project);
      if (revision === undefined || revision.archived === true) return undefined;
      return revision.definition.afterMergeWatch;
    },
  };
}

export interface TaskHostsOptions {
  store: Pick<DocumentStore, "get" | "query">;
  registry: Pick<RegistryView, "get" | "names">;
  /** The project's pinned revision of a task. Default: the company's stored projects. */
  projectsOf?: (orgId: OrgId) => ProjectSource;
}

/**
 * The host binding: the task (this company's) names a project and the revision it started on; that revision's repositories are matched by their GitHub address to the repository the event or the merge named, and the host is the one
 * the repository's own record names (`codeHostForRecord`; a kind nobody registered is refused with fixed words, never another host). A repository the project does not pin has no host here.
 */
export function createTaskHosts(options: TaskHostsOptions): AfterMergeHosts {
  const tasks = createStoreAfterMergeTasks(options.store);
  return {
    async forTask(orgId, taskId, repositoryFullName) {
      const task = await tasks.read(orgId, taskId);
      if (task === undefined) return undefined;
      const record = await options.store.get(taskKey(taskId));
      const startingRevision = record?.["startingRevision"];
      if (typeof startingRevision !== "number" || !Number.isSafeInteger(startingRevision)) return undefined;
      const projects = (options.projectsOf ?? ((org) => createStoreProjectSource(options.store, org)))(orgId);
      const pinned = await projects.revision(task.project, startingRevision);
      if (pinned === undefined) return undefined;
      const wanted = repositoryFullName.toLowerCase();
      const entry = pinned.definition.repositories.find((candidate) => githubRepositoryOfUrl(candidate.url.replace(/\.git$/u, "")) === wanted);
      if (entry === undefined) return undefined;
      let codeHost: CodeHost;
      try {
        codeHost = codeHostForRecord(options.registry as RegistryView, { host: (entry as { host?: { kind: PluginKind } }).host });
      } catch {
        return undefined;
      }
      return { codeHost, repository: { url: entry.url }, scope: { orgId } };
    },
  };
}
