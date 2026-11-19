// The notice the owner gets when an intake source keeps failing. Fixed words and ids only: the source's system name (a checked short name), the project's name and a number of minutes; never a
// tracker's message. One item per recipient, in the recipient's own partition of the company (`intakeNoticeKey`).
import { INDEX_EXPIRY_ATTRIBUTE, intakeNoticeKey, queryAll, type OrgId } from "@agentx/contracts";
import type { IntakeNotice } from "./poll.js";
import type { IntakeTable } from "./store.js";

/** The most recipients one notice goes to. */
export const INTAKE_NOTICE_RECIPIENTS_MAX = 20;
const NOTICE_KEPT_SECONDS = 30 * 86_400;

/** The words of a notice. */
export function intakeNoticeText(notice: Pick<IntakeNotice, "project" | "system" | "failingMinutes">): string {
  return `Rovara can't read the ${notice.system} tickets for ${notice.project}: reading them has failed for ${String(notice.failingMinutes)} minutes. Check the tracker's sign-in. Nothing was started, and nothing will be started twice.`;
}

/** Writes the notice for each recipient (at most `INTAKE_NOTICE_RECIPIENTS_MAX`). Throws if a write fails, so the poll keeps the notice to send again. */
export async function writeIntakeNotice(table: IntakeTable, recipients: readonly string[], notice: IntakeNotice): Promise<number> {
  const at = new Date(table.now()).toISOString();
  const text = intakeNoticeText(notice);
  let written = 0;
  for (const developerId of recipients.slice(0, INTAKE_NOTICE_RECIPIENTS_MAX)) {
    await table.store.put({
      item: {
        ...intakeNoticeKey(notice.orgId, developerId, at, notice.sourceId), entityType: "INTAKE_NOTICE", orgId: notice.orgId, project: notice.project, sourceId: notice.sourceId,
        developerId, code: notice.code, text, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(table.now() / 1000) + NOTICE_KEPT_SECONDS,
      },
    });
    written += 1;
  }
  return written;
}

/** The owner's notices, newest first (what `rovara intake` shows beside the failing sources). */
export async function readIntakeNotices(table: IntakeTable, orgId: OrgId, developerId: string, limit = 20): Promise<Array<{ at: string; project: string; text: string }>> {
  const probe = intakeNoticeKey(orgId, developerId, new Date(0).toISOString(), "0".repeat(24));
  const rows = await queryAll(table.store, { pk: probe.pk, descending: true, limit });
  return rows.slice(0, limit).flatMap((row) => (row["orgId"] === orgId && typeof row["text"] === "string" && typeof row["at"] === "string" && typeof row["project"] === "string" ? [{ at: row["at"], project: row["project"], text: row["text"] }] : []));
}
