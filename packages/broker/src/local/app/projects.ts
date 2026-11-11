// Lane L9-wire: registering and listing projects on the document store, by Cloud's keys (`projectRevisionKey`, `orgProjectCatalogKey`), which `createStoreProjectSource` (L6a) reads.
// A registration that equals the latest revision is a repeat (200); anything else is the next revision (201). Only the owner registers a project (the routes check the principal).
import {
  ProjectDefinitionSchema, agentXError, canonicalJson, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, when,
  type DocumentStore, type JsonValue, type OrgId, type ProjectDefinition,
} from "@agentx/contracts";
import { isPlainRepositoryUrl } from "../github-access.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { waitingSetupApply } from "../../core/setup-agent/apply.js";

export async function registerProject(store: DocumentStore, companyId: OrgId, value: unknown): Promise<{ project: string; revision: number; duplicate: boolean }> {
  const parsed = ProjectDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `project: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  // The addresses as they were SENT: the schema may trim them, and a trimmed address is not the one a worker would have been given by a parser that does not.
  const sent = (value as { repositories?: Array<{ name?: unknown; url?: unknown }> }).repositories ?? [];
  const odd = sent.find((repository) => typeof repository.url !== "string" || !isPlainRepositoryUrl(repository.url));
  if (odd !== undefined) throw agentXError("CONFIG_INVALID", `project: repository ${typeof odd.name === "string" ? odd.name.slice(0, 63) : "?"}: the address has a backslash, a space, a control or non-ASCII character; write it as a plain https address`);
  // A setup waiting for the owner's approval holds the project's next revision number: another revision waits until it is decided or discarded.
  if ((await waitingSetupApply(store, companyId, parsed.data.name)) !== undefined) throw agentXError("WORKSPACE_BUSY", "A setup is waiting for your approval for this project. Decide it, or discard it, first.");
  const source = createStoreProjectSource(store, companyId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await source.latest(parsed.data.name);
    const revision = (latest?.definition.revision ?? 0) + 1;
    // The registered revision is compared without its revision number, so sending the same file twice is not a new revision.
    const same = (definition: ProjectDefinition): boolean => canonicalJson({ ...definition, revision: 0 }) === canonicalJson({ ...parsed.data, revision: 0 });
    if (latest !== undefined && same(latest.definition)) return { project: parsed.data.name, revision: latest.definition.revision, duplicate: true };
    const definition: ProjectDefinition = { ...parsed.data, revision };
    const written = await store.transact([
      { kind: "put", item: { ...projectRevisionKey(companyId, definition.name, revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue }, condition: when.absent() },
      { kind: "put", item: { ...orgProjectCatalogKey(companyId, definition.name), entityType: "PROJECT_CATALOG", latestRevision: revision } },
      ...(latest === undefined ? [{ kind: "put" as const, item: { ...projectMetaKey(companyId, definition.name), entityType: "PROJECT_META", status: "active" }, condition: when.absent() }] : []),
    ]);
    if (written.applied) return { project: definition.name, revision, duplicate: false };
  }
  throw agentXError("WORKSPACE_BUSY", "the project changed while it was being registered; try again");
}

/** The projects of this install with their latest revision. */
export async function listProjects(store: DocumentStore, companyId: OrgId): Promise<Array<{ name: string; latestRevision: number }>> {
  const prefix = orgProjectCatalogKey(companyId, "x");
  const page = await store.query({ pk: prefix.pk, limit: 200 });
  return page.items.flatMap((item) => (typeof item["latestRevision"] === "number" && item.sk.startsWith("PROJECT#") ? [{ name: item.sk.slice("PROJECT#".length), latestRevision: item["latestRevision"] }] : []));
}
