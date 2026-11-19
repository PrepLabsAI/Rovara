// the test environment's OWN write into the project's settings (the approval adding its commands, or the S2 apply) moves the settings revision. Without a record of it, that move made the look the
// environment was drafted from read as "older than the settings" (stale) and every later change began with "Ask Rovara again", although nothing a person or another path changed had happened.
// The record: the settings revisions the write went from and to. A run of such writes in a row keeps the first `from`. A look based on a revision at or after `from` is not stale while the settings are still at `to`;
// any other settings change (a person's save, a setup draft's apply) moves the revision past `to`, and the look is stale again, as before.
import { projectPk, type DocumentKey, type OrgId } from "@agentx/contracts";
import { documentOf, type StoreOnly } from "./deps.js";

const ownWriteKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: "TESTENV#OWN_SETTINGS_WRITE" });

export interface OwnSettingsWrite { from: number; to: number }

/** The last own write, or undefined (none, or an item that does not read as one). */
export async function readOwnSettingsWrite(client: StoreOnly, orgId: OrgId, project: string): Promise<OwnSettingsWrite | undefined> {
  const item = (await client.store.get(ownWriteKey(orgId, project))) as Record<string, unknown> | undefined;
  const from = item?.["from"], to = item?.["to"];
  return typeof from === "number" && typeof to === "number" && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && from < to && item?.["orgId"] === orgId && item["project"] === project ? { from, to } : undefined;
}

/** Records that the test environment moved the settings from `from` to `to`. Continues the run when the last own write ended at `from`. A failure here is the caller's to swallow: it only costs a stale note. */
export async function recordOwnSettingsWrite(client: StoreOnly, orgId: OrgId, project: string, write: OwnSettingsWrite): Promise<void> {
  if (!(write.from >= 1 && write.to > write.from)) return;
  const last = await readOwnSettingsWrite(client, orgId, project);
  const from = last !== undefined && last.to === write.from ? last.from : write.from;
  await client.store.put({ item: documentOf({ ...ownWriteKey(orgId, project), entityType: "TEST_ENV_OWN_SETTINGS_WRITE", orgId, project, from, to: write.to }) });
}

/** Whether a look based on `basedOnRevision` is older than the settings at `revision` by anything other than the test environment's own writes. */
export function lookIsStale(basedOnRevision: number, revision: number, own: OwnSettingsWrite | undefined): boolean {
  if (basedOnRevision >= revision) return false;
  return !(own !== undefined && own.to === revision && basedOnRevision >= own.from);
}

/** Review M3: the own write a save made, from the revision it was based on to the one read back after it: only when that is exactly the next revision (anything more means someone else saved in between). */
export function ownWriteOf(fromRevision: number, latestRevision: number): OwnSettingsWrite | undefined {
  return Number.isSafeInteger(fromRevision) && fromRevision >= 1 && latestRevision === fromRevision + 1 ? { from: fromRevision, to: fromRevision + 1 } : undefined;
}
