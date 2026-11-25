// L4-SF (follow-up (c) of L4-D, #899): the old broker's project registry after a hosted setup approval.
//
// An approved setup moves the CORE's project to the candidate revision (apply.ts): the company's catalog row now names revision N+1. The old broker's registry (`PROJECT#<name>` / `REV#...`, its
// own catalog row) stayed at N, so the next operator or admin registration for the project was refused ("core project copy refused", aws/core-project-backfill.ts `planCoreProjectWrites`: a core
// catalog ahead of the legacy history must be justified by a legacy row and a matching core row for that revision). The fix is to mirror the approved revision into the old registry IN THE SAME
// TRANSACTION as the approval, so the two never differ for longer than the decision itself.
//
// What the mirror writes (all conditional, all in the decision's transaction):
//   - the legacy revision N+1: the legacy base record N, carried forward whole (runtime binding, who registered it, company), with the candidate's definition. It is put only where the key is absent, and
//     only when the base record belongs to THIS company (an old row of another company, or of the implicit company when this is another one, is never read as ours and never written beside);
//   - the core candidate row, given the same extra fields, so the legacy row and the core row of revision N+1 are the same content (the check `planCoreProjectWrites` makes for the next registration);
//   - the legacy catalog row: latestRevision N -> N+1, only while it still says N. A legacy catalog that does not name a revision is left (it is repaired by the next registration) and checked absent.
// A legacy registry that is not at the revision the setup was made from (moved, damaged, or another company's) refuses the approval in fixed words; it never writes a guess. A project with no old
// registry row (made by the core alone) has nothing to mirror.
import { IMPLICIT_COMPANY_ID, OrgIdSchema, change, projectCatalogKey, projectRevisionKey, when, type DocumentStore, type JsonValue, type OrgId, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { SubjectRefusal } from "../core/decisions/approval-gate.js";
import { projectKey } from "./project-records.js";

/** The fixed words of a refusal: the old registry no longer matches what the setup was made from. */
export const SETUP_REGISTRY_MOVED = "The project's older registry changed since this setup was made, so it cannot be approved. Discard it and set the project up again.";

/** What the decision needs from a mirror: the extra transaction steps for approving this candidate, or a `SubjectRefusal`. */
export interface SetupRegistryMirror {
  itemsFor(row: { project: string; baseRevision: number; candidateRevision: number }, at: string): Promise<TransactItem[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** The no-automated-tests fact is a revision-row attribute beside `definition`; the hosted checklist reads it from the old PROJECT# row for a project not in a named company, so the mirrored row carries it as the core row has it. */
const noTestsFactOf = (core: Record<string, unknown>): { noAutomatedTests?: JsonValue } => (core["noAutomatedTests"] === undefined ? {} : { noAutomatedTests: core["noAutomatedTests"] as JsonValue });
const moved = (): SubjectRefusal => new SubjectRefusal("invalid", SETUP_REGISTRY_MOVED);

/** The mirror for one company's decisions (reads and writes only through `store`, the registry's table). */
export function createSetupRegistryMirror(options: { store: Pick<DocumentStore, "get">; companyId: OrgId }): SetupRegistryMirror {
  const { store, companyId } = options;
  return {
    async itemsFor(row, at) {
      const { project, baseRevision, candidateRevision } = row;
      if (candidateRevision !== baseRevision + 1 || !Number.isSafeInteger(baseRevision) || baseRevision < 1) throw moved();
      let base: Record<string, unknown> | undefined;
      let catalog: Record<string, unknown> | undefined;
      let legacyCandidate: Record<string, unknown> | undefined;
      let core: Record<string, unknown> | undefined;
      try {
        [base, catalog, legacyCandidate, core] = await Promise.all([
          store.get(projectKey(project, baseRevision)), store.get(projectCatalogKey(project)),
          store.get(projectKey(project, candidateRevision)), store.get(projectRevisionKey(companyId, project, candidateRevision)),
        ]);
      } catch { throw moved(); }
      // No old registry row for the base revision: a project the core made on its own, nothing to mirror.
      if (base === undefined) {
        // Old names are global: rows that are there may be ANOTHER company's (the catalog row names no company, so the newest revision it names tells whose it is). Theirs never block this company.
        const foreign = async (row: Record<string, unknown> | undefined): Promise<boolean> => {
          const parsed = OrgIdSchema.safeParse(row?.["companyId"] === undefined ? IMPLICIT_COMPANY_ID : row["companyId"]);
          return row !== undefined && parsed.success && parsed.data !== companyId;
        };
        if (legacyCandidate !== undefined) { if (await foreign(legacyCandidate)) return []; throw moved(); }
        if (catalog === undefined) return [];
        const named = catalog["latestRevision"];
        if (typeof named !== "number" || !Number.isSafeInteger(named) || named < 1) throw moved();
        let newest: Record<string, unknown> | undefined;
        try { newest = await store.get(projectKey(project, named)); } catch { throw moved(); }
        if (await foreign(newest)) return [];
        throw moved();
      }
      // Whose old row is it? One that names no company is the implicit company's. Another company's is never touched, and never blocks this one.
      const owner = OrgIdSchema.safeParse(base["companyId"] === undefined ? IMPLICIT_COMPANY_ID : base["companyId"]);
      if (!owner.success) throw moved();
      if (owner.data !== companyId) return [];
      const definition = base["definition"];
      const baseKey = projectKey(project, baseRevision);
      const coreDefinition = core?.["definition"];
      if (base["entityType"] !== "PROJECT" || base["pk"] !== baseKey.pk || base["sk"] !== baseKey.sk || !isRecord(definition) || definition["name"] !== project || definition["revision"] !== baseRevision
        || !isRecord(base["runtimeBinding"]) || typeof base["registeredBy"] !== "string" || legacyCandidate !== undefined
        || core === undefined || core["entityType"] !== "PROJECT" || !isRecord(coreDefinition) || coreDefinition["name"] !== project || coreDefinition["revision"] !== candidateRevision) throw moved();
      if (catalog !== undefined && (catalog["entityType"] !== "PROJECT_CATALOG" || catalog["name"] !== project || (catalog["latestRevision"] !== undefined && catalog["latestRevision"] !== baseRevision))) throw moved();

      const carried = { runtimeBinding: base["runtimeBinding"] as JsonValue, registeredBy: base["registeredBy"], registeredAt: at };
      const legacyRow = {
        ...projectKey(project, candidateRevision), entityType: "PROJECT", ...(base["companyId"] === undefined ? {} : { companyId: base["companyId"] as string }),
        ...(core["candidate"] === undefined ? {} : { candidate: core["candidate"] as JsonValue }), definition: coreDefinition as JsonValue, ...carried,
        ...noTestsFactOf(core),
      } as StoredDocument;
      const sameCompany = base["companyId"] === undefined ? when.notExists("companyId") : when.eq("companyId", base["companyId"] as string);
      return [
        // The legacy revision N+1: only where it is absent. The base row it was made from must still be there, unchanged in whose it is.
        { kind: "put", item: legacyRow, condition: when.absent() },
        { kind: "check", key: baseKey, condition: when.and(when.eq("entityType", "PROJECT"), sameCompany) },
        // The core's own row of revision N+1 now carries the same fields, so the two copies are one content.
        { kind: "update", key: projectRevisionKey(companyId, project, candidateRevision), ops: [change.set("runtimeBinding", carried.runtimeBinding), change.set("registeredBy", carried.registeredBy), change.set("registeredAt", at)], condition: when.eq("entityType", "PROJECT") },
        // The legacy catalog: moved to N+1 only while it says N; one that names no revision stays as it is.
        catalog?.["latestRevision"] === baseRevision
          ? { kind: "update", key: projectCatalogKey(project), ops: [change.set("latestRevision", candidateRevision)], condition: when.and(when.eq("entityType", "PROJECT_CATALOG"), when.eq("latestRevision", baseRevision)) }
          : catalog === undefined
            ? { kind: "check", key: projectCatalogKey(project), condition: when.absent() }
            : { kind: "check", key: projectCatalogKey(project), condition: when.and(when.eq("entityType", "PROJECT_CATALOG"), when.notExists("latestRevision")) },
      ];
    },
  };
}
