// Nightly upkeep (lead 4 N1): the rows. ONE partition per company AND project, `ORG#<company>#UPKEEP#<project>` (companyScoped), built only from a checked company id and project name, so the company purge removes
// them by key and no read of one project reaches another's. Rows only, never files; no person's id or words are kept (who switched it is in the audit record), so the person erase has no step here.
//   SETTINGS               the switch: `enabled` and when it changed (off by default: no row, or any row that does not read, is OFF)
//   LAST                   the last night that ran: the day, the default-branch commits it saw (so a night with nothing new is skipped), and how it ended (fixed words)
//   NIGHT#<day>            one row per night that was decided (fixed outcome words only; the setup page lists the last seven)
//   NOTICE#<month>#<why>   the one admins' notice of a pause per month and reason (the dedupe marker)
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, AGENTX_NAME_PATTERN, UPKEEP_PAUSE_REASONS, UpkeepMonthSchema, companyScoped, type DocumentKey, type OrgId, type UpkeepPauseReason } from "@agentx/contracts";

export interface UpkeepScope { orgId: OrgId; project: string }

/** The kept rows live this long (a pause marker must outlive its month). */
export const UPKEEP_KEEP_SECONDS = 62 * 86_400;

export function upkeepPartition(scope: UpkeepScope): string {
  const orgId = OrgIdSchema.parse(scope.orgId);
  if (!AGENTX_NAME_PATTERN.test(scope.project)) throw new Error("not a project name");
  return companyScoped(orgId, `UPKEEP#${scope.project}`);
}
export const upkeepSettingsKey = (scope: UpkeepScope): DocumentKey => ({ pk: upkeepPartition(scope), sk: "SETTINGS" });
export const upkeepLastKey = (scope: UpkeepScope): DocumentKey => ({ pk: upkeepPartition(scope), sk: "LAST" });
export function upkeepNightKey(scope: UpkeepScope, day: string): DocumentKey {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("not a day");
  return { pk: upkeepPartition(scope), sk: `NIGHT#${day}` };
}
export function upkeepNoticeKey(scope: UpkeepScope, month: string, reason: UpkeepPauseReason): DocumentKey {
  if (!UpkeepMonthSchema.safeParse(month).success || !UPKEEP_PAUSE_REASONS.includes(reason)) throw new Error("not an upkeep notice");
  return { pk: upkeepPartition(scope), sk: `NOTICE#${month}#${reason}` };
}
export const upkeepExpiryOf = (nowMs: number): { [INDEX_EXPIRY_ATTRIBUTE]: number } => ({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + UPKEEP_KEEP_SECONDS });
