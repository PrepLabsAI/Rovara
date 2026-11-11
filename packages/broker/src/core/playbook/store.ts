// "How we work" in Rovara Code: the project playbook item, at the SAME key Cloud keeps it (`projectPlaybookKey`). The design review stage reads it and keeps the ONE module that writes it
// (`core/design-review/playbook-store.ts`; a test holds that), so the file's sync is a function of that module and this one only joins it to the playbook service: it passes the file's design review setting and
// digest, and names who wrote (`playbook-file`). The reads are that module's, with its fail-closed rules: a design review setting that is there and cannot be read means Off, never a looser one.
import type { AuditSink, DocumentStore, OrgId, PlaybookFile, ProjectPlaybook } from "@agentx/contracts";
import { readProjectPlaybookDetail, syncPlaybookFromFile, type PlaybookFileSyncResult } from "../design-review/playbook-store.js";

export { designReviewFileRefusal, readProjectPlaybookDetail, readStoredDesignReview, designReviewAuditFacts, type ProjectPlaybookDetail } from "../design-review/playbook-store.js";

/** Who the item says wrote it when the playbook file did. */
export const PLAYBOOK_FILE_WRITER = "playbook-file";

export interface PlaybookSyncDeps {
  store: Pick<DocumentStore, "get" | "transact">;
  companyId: OrgId;
  audit: AuditSink;
  now: () => Date;
}

/** What the sync did: `unchanged`, or `written` with the playbook as it now is. */
export type PlaybookSyncResult = PlaybookFileSyncResult;

/** The playbook item the project has now (the built-in default when it has none). */
export async function readProjectPlaybook(deps: { store: Pick<DocumentStore, "get">; companyId: OrgId }, project: string): Promise<ProjectPlaybook> {
  return (await readProjectPlaybookDetail(deps.store, deps.companyId, project, { lenient: true })).playbook;
}

/**
 * Makes the stored item say what the repository's file says (see `syncPlaybookFromFile`). `file` is the checked file (undefined: there is none, or it says nothing); `digest` its identity.
 */
export function syncProjectPlaybook(deps: PlaybookSyncDeps, project: string, input: { file: PlaybookFile | undefined; digest: string | undefined }): Promise<PlaybookSyncResult> {
  return syncPlaybookFromFile(
    { get: (key) => deps.store.get(key), transact: (items) => deps.store.transact(items), now: () => deps.now().getTime(), audit: deps.audit },
    { orgId: deps.companyId, project, actorId: PLAYBOOK_FILE_WRITER, designReview: input.file?.designReview, fileDigest: input.digest },
  );
}
