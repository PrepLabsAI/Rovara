// The repositories of a project as lessons see them: each one's PLACE (`<host kind>:repo/<the host's own repository id>`, the name capture gives a repository's words and the lessons file gives its watch row), the code host
// that serves it and the scope to call it in. The id is the host's immutable one, asked of the host (`repositoryIdentity`), never the project's name for it, so a rename or a repository another project calls the same cannot
// stand in for it. An answer is kept for a few minutes; a host that cannot say leaves the repository out (nothing is then treated as a project repository).
import { PROJECT_REVISION_SK_PREFIX, codeRepositoriesOf, orgProjectCatalogKey, projectPk, type CodeHost, type HostScope, type OrgId, type RegistryView, type RepositoryRef } from "@agentx/contracts";
import { providerOf } from "../../plugins/routing.js";
import type { ProjectRepoScopesPort } from "../../lessons/project-repo-audience.js";
import type { RepoFileTarget } from "../../lessons/repo-file-pass.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { createRepositoryResolver } from "./tracking.js";
import { normalizeRemote } from "../../lessons/repo-remote.js";

export interface LessonRepository {
  /** The project's name for the repository. */
  name: string;
  /** The address the project pins. */
  url: string;
  /** `<host kind>:repo/<id>`. */
  place: string;
  /** The host's full name for the repository (`owner/name`), as the host says it. */
  fullName: string;
  private: boolean | undefined;
  codeHost: CodeHost;
  repository: RepositoryRef;
  scope: HostScope;
}

const KEEP_MS = 5 * 60_000;

export interface LessonRepositories {
  /** Every code repository of the project's latest revision whose host answered. Throws when the project cannot be read. */
  ofProject(project: string): Promise<LessonRepository[]>;
  /** The repository a task's pull request is in, by the project's name for it in the revision the task started on. Undefined when it cannot be placed. */
  ofTask(project: string, startingRevision: number, name: string): Promise<LessonRepository | undefined>;
  /** The project's repositories as places (the port the lessons' audience rules read). */
  scopes(): ProjectRepoScopesPort;
  /** The repositories as targets for the lessons file pass. */
  targets(project: string): Promise<RepoFileTarget[]>;
}

export function createLessonRepositories(input: { flow: Pick<TaskFlowDeps, "projects" | "store">; registry: RegistryView; companyId: OrgId; now: () => number }): LessonRepositories {
  const resolver = createRepositoryResolver(input.flow, input.registry);
  const scope: HostScope = { orgId: input.companyId };
  const kept = new Map<string, { at: number; value: LessonRepository | undefined }>();

  async function place(project: string, revision: number, name: string): Promise<LessonRepository | undefined> {
    const key = `${project}\u0000${String(revision)}\u0000${name}`;
    const known = kept.get(key);
    if (known !== undefined && input.now() - known.at < KEEP_MS) return known.value;
    let value: LessonRepository | undefined;
    try {
      const home = await resolver(project, revision, name, input.companyId);
      if (home !== undefined) {
        const repository: RepositoryRef = { url: home.url };
        const identity = await home.codeHost.repositoryIdentity(repository, scope);
        if (identity !== undefined && /^[A-Za-z0-9_.-]{1,100}$/u.test(identity.id)) {
          value = { name, url: home.url, place: `${providerOf(home.codeHost)}:repo/${identity.id}`, fullName: identity.fullName, private: identity.private, codeHost: home.codeHost, repository, scope };
        }
      }
    } catch { value = undefined; }
    // A failure is not remembered for long: the next ask looks again.
    kept.set(key, { at: value === undefined ? input.now() - KEEP_MS + 30_000 : input.now(), value });
    return value;
  }

  async function ofProject(project: string): Promise<LessonRepository[]> {
    const latest = await input.flow.projects.latest(project);
    if (latest === undefined) throw new Error("the project cannot be read");
    // The newest revision's number: the catalog row names it; a project registered before the pointer existed is found by its newest revision row.
    const catalog = await input.flow.store.get(orgProjectCatalogKey(input.companyId, project));
    let revision = typeof catalog?.["latestRevision"] === "number" ? catalog["latestRevision"] : undefined;
    if (revision === undefined) {
      const page = await input.flow.store.query({ pk: projectPk(input.companyId, project), sk: { op: "beginsWith", prefix: PROJECT_REVISION_SK_PREFIX }, descending: true, limit: 1 });
      const found = page.items[0]?.["revision"];
      revision = typeof found === "number" ? found : undefined;
    }
    if (revision === undefined) throw new Error("the project's revision cannot be read");
    const found: LessonRepository[] = [];
    for (const entry of codeRepositoriesOf(latest.definition)) {
      const repository = await place(project, revision, entry.name);
      if (repository !== undefined) found.push(repository);
    }
    return found;
  }

  return {
    ofProject, ofTask: place,
    scopes: () => ({
      async read(_orgId, project) { return new Set((await ofProject(project)).map((repository) => repository.place)); },
      async byRemote(_orgId, project, remote) {
        // The project's registered addresses, by its latest revision: the tool's remote is only a claim, matched against what the project pins. A repository whose host could not say its id has no place.
        const latest = await input.flow.projects.latest(project);
        if (latest === undefined) throw new Error("the project cannot be read");
        const entry = codeRepositoriesOf(latest.definition).find((candidate) => normalizeRemote(candidate.url) === remote);
        if (entry === undefined) return undefined;
        const placed = (await ofProject(project)).find((repository) => repository.name === entry.name);
        return placed === undefined ? { name: entry.name } : { name: entry.name, place: placed.place };
      },
      async placeOf(_orgId, project, name, startingRevision) {
        if (startingRevision === undefined) return undefined;
        const home = await place(project, startingRevision, name);
        if (home === undefined) return undefined;
        return (await ofProject(project)).find((repository) => repository.place === home.place)?.place;
      },
    }),
    async targets(project) {
      return (await ofProject(project)).map((repository) => ({ name: repository.name, place: repository.place, repository: repository.repository, scope: repository.scope, host: repository.codeHost }));
    },
  };
}
