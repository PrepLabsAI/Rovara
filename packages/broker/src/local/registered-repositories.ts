// The registered projects' repositories (not archived), as their records state them: the address and the code host connection the record names, if any. Read when asked, so a plug-in storage works too.
import type { DocumentStore, OrgId } from "@agentx/contracts";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { isProjectUnreadable, logProjectLeftOut } from "../core/project-left-out.js";
import { listProjects } from "../core-host/app/projects.js";

export async function registeredRepositoryRecordsOf(store: DocumentStore, companyOrg: OrgId): Promise<Array<{ url: string; host?: { kind: string } | undefined }>> {
  const source = createStoreProjectSource(store, companyOrg);
  // One project whose current revision cannot be read (arch rule 9) names no repository; it never takes the others down.
  const latest = await Promise.all((await listProjects(store, companyOrg)).map(async (project) => {
    try { return await source.latest(project.name); } catch (error) { if (!isProjectUnreadable(error)) throw error; logProjectLeftOut(companyOrg, project.name); return undefined; }
  }));
  return latest.flatMap((revision) => (revision === undefined || revision.archived === true ? [] : revision.definition.repositories.map((repository) => ({ url: repository.url, host: repository.host }))));
}
