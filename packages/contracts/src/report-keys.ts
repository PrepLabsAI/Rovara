// The cost report's keys (lead 4, slices A1 and A2): ONE partition per company, `ORG#<company>#REPORT`. The company purge deletes every `ORG#<company>#...` partition, so it removes the report with no
// purge change. Every builder checks its parts, so nothing outside the id patterns can move a key boundary. No row here holds a person id (who and when is in the audit record), so a person erase has
// nothing to scrub.
import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";
import { orgScoped } from "./company-scope.js";

const FeatureIdPart = z.string().regex(/^ft_[a-f0-9]{20}$/u);
const TaskIdPart = z.string().uuid();
/** A task's start as the report keys it: `Date.prototype.toISOString`'s form, so text order is time order. */
export const REPORT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const InstantPart = z.string().regex(REPORT_INSTANT);

export interface ReportKey { pk: string; sk: string }

/** The one partition of a company's report records: `ORG#<company>#REPORT`. */
export function reportPartition(orgId: OrgId): string {
  return orgScoped(OrgIdSchema.parse(orgId), "REPORT");
}
/** Sort-key families inside the company's report partition. */
export const REPORT_SK = { feature: "FEATURE#", featureName: "FNAME#", taskFeature: "TASKFEAT#", task: "TASK#" } as const;

/** A feature's record. */
export const reportFeatureKey = (orgId: OrgId, featureId: string): ReportKey => ({ pk: reportPartition(orgId), sk: `${REPORT_SK.feature}${FeatureIdPart.parse(featureId)}` });
/** The row that holds a feature's name (lower case) so two features of one company never share a name. */
export const reportFeatureNameKey = (orgId: OrgId, lowerName: string): ReportKey => {
  if (lowerName === "" || lowerName.length > 400 || /[\p{Cc}\p{Cf}]/u.test(lowerName)) throw new Error("not a feature name key");
  return { pk: reportPartition(orgId), sk: `${REPORT_SK.featureName}${lowerName}` };
};
/** The feature a task is filed under (or filed under no feature on purpose). */
export const reportTaskFeatureKey = (orgId: OrgId, taskId: string): ReportKey => ({ pk: reportPartition(orgId), sk: `${REPORT_SK.taskFeature}${TaskIdPart.parse(taskId)}` });
/** A task's report row: the start time first, so one range read of the partition is "the tasks that started in this range". */
export const reportTaskKey = (orgId: OrgId, startedAt: string, taskId: string): ReportKey => ({ pk: reportPartition(orgId), sk: `${REPORT_SK.task}${InstantPart.parse(startedAt)}#${TaskIdPart.parse(taskId)}` });
/** The part of a task row's sort key after `TASK#` (a read position): `<startedAt>#<taskId>`. */
export const REPORT_TASK_POSITION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
