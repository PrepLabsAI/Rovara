// DEC 254zzz80 (R2-F1): where a test project lives. A NAMED company's project is in its own partition (`revisionKeyFor`, a schema-valid definition, as the core and
// Code's company layout write it); the built-in company's, and a project with no company, keep the legacy `PROJECT#<name>` row exactly as the test wrote it.
import { ProjectDefinitionSchema } from "@agentx/contracts";
import { namedCompany, revisionKeyFor } from "../../packages/broker/src/aws/company-layout.js";

type Row = Record<string, unknown>;

/** A schema-valid definition with the test's own fields (a repository the test left short gets a path, a default branch and a credential; none at all gets one unrelated repository). */
export function validDefinition(name: string, revision: number, fields: Row = {}): Row {
  const given = Array.isArray(fields.repositories) ? fields.repositories as Row[] : [];
  const names = given.map((repository, index) => typeof repository.name === "string" ? repository.name : `repo-${index}`);
  // Two repositories of one name (or overlapping paths) do not parse: each then gets its own name and path, the URL and the rest kept.
  const distinct = new Set(names).size === names.length && new Set(given.map((repository) => repository.path)).size === given.length;
  const repositories = given.length > 0
    ? given.map((repository, index) => {
      const repoName = distinct ? names[index]! : `${names[index]}-${index}`;
      return { path: `repo/${repoName}`, defaultBranch: "main", credentialRef: "github", ...repository, name: repoName, ...(distinct ? {} : { path: `repo/${repoName}` }) };
    })
    : [{ name: "demo", url: "https://github.com/acme/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github" }];
  const definition = { orchestratorInstructions: "Delegate work.", setup: [], readiness: [], ...fields, name, revision, repositories };
  ProjectDefinitionSchema.parse(definition);
  return definition;
}

/**
 * The stored revision row for `name` at `revision` in `companyId`'s layout. Named company: its own partition, the definition made schema-valid, no company field (the
 * partition names it). Otherwise: the legacy row with `extra` (including any `companyId`) as given.
 */
export function companyProjectRow(companyId: string | undefined, name: string, revision: number, definition: Row = {}, extra: Row = {}): Row {
  if (namedCompany(companyId) !== undefined) return { ...extra, ...revisionKeyFor(companyId, name, revision), entityType: "PROJECT", definition: validDefinition(name, revision, definition) };
  return { pk: `PROJECT#${name}`, sk: `REV#${String(revision).padStart(12, "0")}`, entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }), ...extra, definition: { name, revision, ...definition } };
}
