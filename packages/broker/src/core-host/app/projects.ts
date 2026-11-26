// Lane L9-wire: registering and listing projects on the document store, by Cloud's keys (`projectRevisionKey`, `orgProjectCatalogKey`), which `createStoreProjectSource` (L6a) reads.
// A registration that equals the latest revision is a repeat (200); anything else is the next revision (201). Only the owner registers a project (the routes check the principal).
import {
  ProjectDefinitionSchema, agentXError, canonicalJson, noAutomatedTestsOf, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, projectPk, when,
  type DocumentStore, type JsonValue, type NoAutomatedTests, type OrgId, type ProjectDefinition,
} from "@agentx/contracts";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { planLocalProjectIncarnation, projectMetaSnapshot, projectIncarnationRegistration } from "../../core/project-incarnation.js";
import { waitingSetupApply } from "../../core/setup-agent/apply.js";

/** The revision row: the definition, and beside it (not inside it: rollback safety) the no-automated-tests fact when the project has one. */
function revisionRow(companyId: OrgId, definition: ProjectDefinition, fact: NoAutomatedTests | undefined) {
  return { ...projectRevisionKey(companyId, definition.name, definition.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue, ...(fact === undefined ? {} : { noAutomatedTests: JSON.parse(JSON.stringify(fact)) as JsonValue }) };
}

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
  if ((await waitingSetupApply(store, companyId, parsed.data.name)) !== undefined) throw agentXError("WORKSPACE_BUSY", "A setup is waiting for this project. If its check passed, approve or reject it; otherwise discard it. Then try again.");
  const source = createStoreProjectSource(store, companyId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const name = parsed.data.name;
    const [latest, meta, catalog, history] = await Promise.all([
      source.latest(name), store.get(projectMetaKey(companyId, name)), store.get(orgProjectCatalogKey(companyId, name)),
      store.query({ pk: projectPk(companyId, name), sk: { op: "beginsWith", prefix: "REV#" }, limit: 1 }),
    ]);
    const revision = (latest?.definition.revision ?? 0) + 1;
    // The registered revision is compared without its revision number, so sending the same file twice is not a new revision.
    const same = (definition: ProjectDefinition): boolean => canonicalJson({ ...definition, revision: 0 }) === canonicalJson({ ...parsed.data, revision: 0 });
    if (latest !== undefined && same(latest.definition)) return { project: parsed.data.name, revision: latest.definition.revision, duplicate: true };
    const identity = planLocalProjectIncarnation(companyId, name, meta, catalog, catalog !== undefined || history.items.length > 0);
    const definition: ProjectDefinition = { ...parsed.data, revision };
    // DEC 254zzz495 (N3): the no-automated-tests fact is not a definition field, so no registration body carries it. The latest revision's own LIVE fact (still no test command) is carried on the new row, so registering the project file again does not turn the tests-before-a-PR rule back on.
    const fact = noAutomatedTestsOf({ readiness: definition.readiness, noAutomatedTests: latest?.noAutomatedTests });
    const written = await store.transact([
      { kind: "put", item: revisionRow(companyId, definition, fact), condition: when.absent() },
      { kind: "put", item: { ...orgProjectCatalogKey(companyId, definition.name), entityType: "PROJECT_CATALOG", latestRevision: revision, incarnationRevision: identity["incarnationRevision"]! }, condition: projectMetaSnapshot(catalog) },
      projectIncarnationRegistration(companyId, name, meta, identity),
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

/**
 * A repository address the install registers: plain characters only. A backslash, a space or control character, a percent-encoded backslash or a non-ASCII character is where URL
 * parsers part ways about the host, so such an address is refused when the project is registered (not only when a token would be handed out).
 */
function isPlainRepositoryUrl(repositoryUrl: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return !/[\\\s\u0000-\u001f\u007f-\uffff]/u.test(repositoryUrl) && !/%5c/iu.test(repositoryUrl);
}
