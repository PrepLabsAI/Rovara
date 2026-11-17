// L4-DR (DEC 254z c; setup-upkeep-plan.md 2.1, slices U2 and U3): the setup snapshot, saved when a setup is approved, and the broker's own reading of the same files now. Everything is read through the code host
// port (`setupFileVersions`): paths and content ids only, never a file's content, so nothing here can hold a secret value or reach a model. No model runs. The company is the flow's own: the snapshot row sits in
// the project's setup partition (`setupPartition(orgId, project)`), so another company's project of the same name never meets it.
//
//   SNAPSHOT   the project's one snapshot: the commit and watched files of each repository at the approved commit, and the websites the setup allows. A new approval replaces it.
//
// A repository whose listing cannot be read whole is `unreadable` (the comparison then says "unknown" and the caller re-checks); a code host that cannot be reached, or that has no such read, is `not_checked`
// (the task starts, the log says so, and the next task tries again). Neither is ever "no drift".
import {
  AgentXError, agentXError, SETUP_SNAPSHOT_MAX_REPOSITORIES, SETUP_WATCH_MAX_PER_REPOSITORY, SETUP_WATCH_MAX_TOTAL, SETUP_WATCH_PATH_MAX, SetupSnapshotSchema, normalisedHosts, setupWatchClassOf,
  type CodeHost, type CurrentSetupRepository, type DocumentKey, type DocumentStore, type HostScope, type OrgId, type ProjectDefinition, type RegistryView, type SetupSnapshot, type TransactItem,
} from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import { setupPartition } from "./keys.js";

export const setupSnapshotKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "SNAPSHOT" });

const HEAD_SHA = /^[a-f0-9]{40,128}$/u;
const READ_TIMEOUT_MS = 10_000;

export interface SnapshotReadDeps { companyId: OrgId; codeHosts?: RegistryView | undefined }

type Definition = Pick<ProjectDefinition, "repositories"> & { network?: { allowedDomains: readonly string[] } | undefined };

/** The outside websites the setup allows, as the snapshot keeps them. */
export const allowedHostsOf = (definition: Pick<Definition, "network">): string[] => normalisedHosts(definition.network?.allowedDomains);

/** What a read of the repositories came to. `not_checked`: the code host could not be asked at all (fail open: the task goes on, nothing is re-checked for it). */
export type CurrentSetupRead = { status: "read"; repositories: CurrentSetupRepository[] } | { status: "not_checked" };

/**
 * The head of the branch the repository's record names, else the host's own default branch when the record's branch is not there; the same rule as the playbook's pin (`createCodeHostPlaybookSource`). Throws what
 * the host throws; a branch nobody can find is a refusal.
 */
async function headOf(host: CodeHost, repository: { url: string; defaultBranch: string }, scope: HostScope): Promise<string> {
  const tryBranch = async (branch: string): Promise<string | undefined> => {
    try {
      const sha = await host.baseBranchHead({ url: repository.url }, branch, scope);
      if (!HEAD_SHA.test(sha)) throw agentXError("RUNTIME_UNAVAILABLE", "the code host did not say what the default branch is at");
      return sha;
    } catch (error) {
      if (error instanceof AgentXError && (error.code === "NOT_FOUND" || error.code === "CONFIG_INVALID")) return undefined;
      throw error;
    }
  };
  const found = await tryBranch(repository.defaultBranch);
  if (found !== undefined) return found;
  const identity = await host.repositoryIdentity({ url: repository.url }, scope);
  const other = identity?.defaultBranch !== undefined && identity.defaultBranch !== repository.defaultBranch ? await tryBranch(identity.defaultBranch) : undefined;
  if (other === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the repository's default branch could not be found");
  return other;
}

/** The watched files of one repository at a commit, or `unreadable` when the host cut the list, or a file's path is too long to keep. A host that cannot answer throws. */
async function filesAt(host: CodeHost, repository: { name: string; url: string }, commit: string, scope: HostScope): Promise<CurrentSetupRepository> {
  const read = await host.setupFileVersions!({ url: repository.url }, commit, scope, { match: (path) => setupWatchClassOf(path) !== undefined, max: SETUP_WATCH_MAX_PER_REPOSITORY, timeoutMs: READ_TIMEOUT_MS });
  if (!read.complete || read.files.some((file) => file.path.length > SETUP_WATCH_PATH_MAX)) return { name: repository.name, unreadable: true, commit };
  return { name: repository.name, commit, files: read.files };
}

/**
 * Every repository's watched files now (at its default branch's head, or at `commits` when given: the way the baseline moves to the commit that was re-checked). Never throws. A repository over the limits is
 * `unreadable`; any host fault, an unregistered host or a host with no such read is `not_checked`.
 */
export async function readCurrentSetupFiles(deps: SnapshotReadDeps, definition: Definition, commits?: Readonly<Record<string, string>>): Promise<CurrentSetupRead> {
  if (deps.codeHosts === undefined || definition.repositories.length === 0 || definition.repositories.length > SETUP_SNAPSHOT_MAX_REPOSITORIES) return { status: "not_checked" };
  const scope: HostScope = { orgId: deps.companyId };
  try {
    const repositories = await Promise.all(definition.repositories.map(async (repository) => {
      const host = codeHostForRecord(deps.codeHosts!, repository);
      if (host.setupFileVersions === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the code host cannot list setup files");
      const commit = commits?.[repository.name] ?? await headOf(host, repository, scope);
      return filesAt(host, repository, commit, scope);
    }));
    return { status: "read", repositories };
  } catch {
    return { status: "not_checked" };
  }
}

/** The commits of a read, by repository name: undefined when any repository's commit is not known (nothing to pin). */
export const commitsOf = (repositories: readonly CurrentSetupRepository[]): Record<string, string> | undefined => {
  const commits: Record<string, string> = {};
  for (const repository of repositories) {
    if (repository.commit === undefined) return undefined;
    commits[repository.name] = repository.commit;
  }
  return commits;
};

/**
 * The snapshot of a setup being approved: what is there now (or at `commits`), and the websites the setup allows. Undefined, and nothing saved, when it cannot be read whole or is over the limits: a partial baseline
 * would report a change that did not happen.
 */
export async function takeSetupSnapshot(deps: SnapshotReadDeps, input: { definition: Definition; setupRevision: number; at: string; commits?: Readonly<Record<string, string>> }): Promise<SetupSnapshot | undefined> {
  const read = await readCurrentSetupFiles(deps, input.definition, input.commits);
  if (read.status !== "read" || read.repositories.some((repository) => "unreadable" in repository)) return undefined;
  const repositories = read.repositories.map((repository) => repository as Extract<CurrentSetupRepository, { commit: string }>).map((repository) => ({ name: repository.name, commit: repository.commit, files: [...repository.files] }));
  if (repositories.reduce((total, repository) => total + repository.files.length, 0) > SETUP_WATCH_MAX_TOTAL) return undefined;
  const parsed = SetupSnapshotSchema.safeParse({ setupRevision: input.setupRevision, takenAt: input.at, repositories, hosts: allowedHostsOf(input.definition) });
  return parsed.success ? parsed.data : undefined;
}

/** The write that saves a snapshot (replacing the earlier one), for the caller's transaction. */
export const snapshotItem = (orgId: OrgId, project: string, snapshot: SetupSnapshot): TransactItem => ({
  kind: "put",
  item: { ...setupSnapshotKey(orgId, project), entityType: "SETUP_SNAPSHOT", orgId, project, snapshot: JSON.parse(JSON.stringify(snapshot)) as never },
});

/** The stored snapshot as it was written (for `compareSetupSnapshot`, which validates it), or undefined when there is none. A row that belongs to another company or project reads as none. */
export async function readSetupSnapshot(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string): Promise<unknown> {
  const row = await store.get(setupSnapshotKey(orgId, project));
  if (row === undefined || row["entityType"] !== "SETUP_SNAPSHOT" || row["orgId"] !== orgId || row["project"] !== project) return undefined;
  return row["snapshot"] ?? {};
}
