// Wiki W4: the two seams W3b left to the hosting side, built once for both the hosted core and `rovara up`:
//   - `wikiBuildCallbackWiring`: what the worker's `wiki-build` callback needs (the requester's live standing, the project's own code host read for the citation re-read, THIS company's wiki store
//     as the page sink and the build record writer). Nothing here is read from a request: the company is the runtime's, the project is the run's own (taken from the operation by the callback).
//   - `wikiBuildEndedHook`: told when a build run's task ended, so the wiki store's build record says how it ended (state, stop reason, counts).
// Both are keyed by company AND project through the store; neither can reach another company's or project's rows.
import { agentXError, type DocumentStore, type OrgId, type PluginKind } from "@agentx/contracts";
import type { CitationFileReader } from "../citations/citation-check.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { createWikiStore } from "../wiki/store.js";
import type { WikiBuildCallbackDeps } from "./callback.js";
import { readWikiBuildPointer, wikiBuildRecordOf, type WikiBuildStanding } from "./run.js";

interface WikiWiringBase { store: DocumentStore; companyId: OrgId; now: () => number }

/** A repository of a project, as the code host read needs it. */
export interface ProjectRepositoryRecord { name: string; url: string; host?: { kind: PluginKind } | undefined }

/**
 * The citation file reader for ONE project: a repository name must be one of the project's own repositories now (its latest revision), or the read is refused; the file is read through the
 * company's code host at the commit. Throws when the host cannot answer (the check reads that as "could not read", never as found).
 */
export function projectCitationReader(options: {
  projects: { latest(project: string): Promise<{ definition: { repositories: readonly ProjectRepositoryRecord[] } } | undefined> };
  fileAt(repository: ProjectRepositoryRecord, path: string, commit: string, read: { untilLine?: number; timeoutMs: number; maxBytes: number }): Promise<string | undefined>;
  maxBytes?: number;
}, project: string): CitationFileReader {
  return async (repository, path, commit, read) => {
    const latest = await options.projects.latest(project);
    const record = latest?.definition.repositories.find((entry) => entry.name === repository);
    if (record === undefined) throw agentXError("CONFIG_INVALID", "that repository is not in this project");
    return await options.fileAt(record, path, commit, { ...(read.untilLine === undefined ? {} : { untilLine: read.untilLine }), timeoutMs: read.timeoutMs, maxBytes: options.maxBytes ?? 262_144 });
  };
}

/** The worker callback's seams for this company's wiki builds. */
export function wikiBuildCallbackWiring(options: WikiWiringBase & {
  standing(personId: string, project: string): Promise<WikiBuildStanding>;
  readFor(project: string): CitationFileReader;
}): Omit<WikiBuildCallbackDeps, "store" | "companyId" | "now"> {
  const wiki = createWikiStore({ store: options.store, companyId: options.companyId, now: options.now });
  return {
    standing: options.standing, read: undefined, readFor: options.readFor,
    sinkFor: (project) => wiki.pageSink(project),
    recordBuild: async (project, record) => { await wiki.writeBuild(project, record); },
  };
}

/** `TaskFlowDeps.wikiBuildEnded`: writes the build record from the run's pointer as it stands (its end word is already written). A newer run's pointer is never written for an older task. */
export function wikiBuildEndedHook(options: WikiWiringBase): NonNullable<TaskFlowDeps["wikiBuildEnded"]> {
  const wiki = createWikiStore({ store: options.store, companyId: options.companyId, now: options.now });
  return async (scope) => {
    if (scope.orgId !== options.companyId) return;
    const pointer = await readWikiBuildPointer(options.store, options.companyId, scope.project);
    if (pointer === undefined || pointer.taskId !== scope.taskId) return;
    await wiki.writeBuild(scope.project, wikiBuildRecordOf(pointer));
  };
}
