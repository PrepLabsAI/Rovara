// The watcher's records. Every key is built from the caller's checked company (`companyScoped`), so a repository, project, pull request number, commit or environment that two companies share is still two
// different rows. Every reader checks that the row says what its key says and names the same company; a row that does not is not read.
//
//   ORG#<company>#AFTER_MERGE        WATCH#<repo>#<number>#<h(environment)>             one watch: a deploy of a merge Rovara made, and its window
//                                    ALARM#<repo>#<number>#<h(environment)>#<signal>    an alarm seen inside a watch's window (at most ten a watch)
//                                    EXPECTED#<repo>#<number>#<signal>                  "It's expected": silences that signal for that pull request
//                                    REVERT#<repo>#<number>                             a person's press on Revert (once a pull request)
//   ORG#<company>#AFTER_MERGE_QUEUE  OPEN#<h(project)>#<repo>#<number>#<h(env)>         the open watches of a project, so an alarm finds them without scanning closed ones
//                                    PENDING#<kind>#<repo>#<number>#<h(env)>#<signal>   a report that has to be sent (written with the change that needs it; deleted when it was sent)
//
// Watches, alarms and queue rows expire 30 days after they were last written (the store's expiry attribute); "It's expected" and the revert press are kept with the task's audit trail (a year and more).
// Names the host or a person chose (project, environment) are hashed in keys, so a long or odd name can never break a key limit or another row's key; the row holds the name and the reader compares it.
import { createHash } from "node:crypto";
import { z } from "zod";
import { companyScoped, type DocumentKey, type OrgId, type StoredDocument } from "@agentx/contracts";

export const WATCH_ENTITY = "AFTER_MERGE_WATCH";
export const ALARM_ENTITY = "AFTER_MERGE_ALARM";
export const EXPECTED_ENTITY = "AFTER_MERGE_EXPECTED";
export const REVERT_ENTITY = "AFTER_MERGE_REVERT";
export const QUEUE_ENTITY = "AFTER_MERGE_QUEUE";

export const WATCH_KEPT_DAYS = 30;
export const EXPECTED_KEPT_DAYS = 400;
/** At most this many different alarms are kept for one watch; the rest are counted, not kept. */
export const ALARMS_PER_WATCH_MAX = 10;
const DAY_SECONDS = 86_400;

const hashed = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
const numberKey = (number: number): string => String(number).padStart(12, "0");

export const mainPartition = (orgId: OrgId): string => companyScoped(orgId, "AFTER_MERGE");
export const queuePartition = (orgId: OrgId): string => companyScoped(orgId, "AFTER_MERGE_QUEUE");

export const watchKey = (orgId: OrgId, repository: string, number: number, environment: string): DocumentKey => ({ pk: mainPartition(orgId), sk: `WATCH#${repository}#${numberKey(number)}#${hashed(environment)}` });
export const watchesOfPullRequest = (orgId: OrgId, repository: string, number: number): { pk: string; prefix: string } => ({ pk: mainPartition(orgId), prefix: `WATCH#${repository}#${numberKey(number)}#` });
export const alarmKey = (orgId: OrgId, repository: string, number: number, environment: string, signalKey: string): DocumentKey => ({ pk: mainPartition(orgId), sk: `ALARM#${repository}#${numberKey(number)}#${hashed(environment)}#${signalKey}` });
export const alarmsOfWatch = (orgId: OrgId, repository: string, number: number, environment: string): { pk: string; prefix: string } => ({ pk: mainPartition(orgId), prefix: `ALARM#${repository}#${numberKey(number)}#${hashed(environment)}#` });
export const alarmsOfPullRequest = (orgId: OrgId, repository: string, number: number): { pk: string; prefix: string } => ({ pk: mainPartition(orgId), prefix: `ALARM#${repository}#${numberKey(number)}#` });
export const expectedKey = (orgId: OrgId, repository: string, number: number, signalKey: string): DocumentKey => ({ pk: mainPartition(orgId), sk: `EXPECTED#${repository}#${numberKey(number)}#${signalKey}` });
export const expectedOfPullRequest = (orgId: OrgId, repository: string, number: number): { pk: string; prefix: string } => ({ pk: mainPartition(orgId), prefix: `EXPECTED#${repository}#${numberKey(number)}#` });
export const revertKey = (orgId: OrgId, repository: string, number: number): DocumentKey => ({ pk: mainPartition(orgId), sk: `REVERT#${repository}#${numberKey(number)}` });
export const openKey = (orgId: OrgId, project: string, repository: string, number: number, environment: string): DocumentKey => ({ pk: queuePartition(orgId), sk: `OPEN#${hashed(project)}#${repository}#${numberKey(number)}#${hashed(environment)}` });
export const openOfProject = (orgId: OrgId, project: string): { pk: string; prefix: string } => ({ pk: queuePartition(orgId), prefix: `OPEN#${hashed(project)}#` });
export const allOpen = (orgId: OrgId): { pk: string; prefix: string } => ({ pk: queuePartition(orgId), prefix: "OPEN#" });
export const allPending = (orgId: OrgId): { pk: string; prefix: string } => ({ pk: queuePartition(orgId), prefix: "PENDING#" });
export const pendingKey = (orgId: OrgId, kind: "watch" | "alarm", repository: string, number: number, environment: string, signalKey: string): DocumentKey =>
  ({ pk: queuePartition(orgId), sk: `PENDING#${kind}#${repository}#${numberKey(number)}#${hashed(environment)}#${signalKey}` });

/** `{ [attribute]: value }`, for spreading into a row: the one place the expiry attribute's name is computed. */
export const expiring = (attribute: string, value: number): Record<string, number> => ({ [attribute]: value });

/** The expiry attribute value for a row kept `days` after `fromMs`. */
export const expiryOf = (fromMs: number, days: number): number => Math.floor(fromMs / 1_000) + days * DAY_SECONDS;

const text = (max: number) => z.string().min(1).max(max);
const base = { orgId: z.string() };
const watchShape = {
  ...base, entityType: z.literal(WATCH_ENTITY), taskId: text(200), project: text(200), repository: text(201), repositoryId: text(200), number: z.number().int().positive(), url: text(300),
  revision: text(128), environment: text(64), source: z.enum(["code_host", "ci_import"]), state: z.enum(["open", "closed"]), outcome: z.enum(["healthy", "alarm", "deploy_failed"]).optional(),
  openedAt: z.string(), windowEndsAt: z.string(), windowMinutes: z.number().int().positive(), closedAt: z.string().optional(), alarmCount: z.number().int().min(0).max(ALARMS_PER_WATCH_MAX), alarmsDropped: z.number().int().min(0).optional(), reportPending: z.literal(true).optional(),
};
export const WatchRowSchema = z.looseObject(watchShape);
export type WatchRow = z.infer<typeof WatchRowSchema>;
export const AlarmRowSchema = z.looseObject({
  ...base, entityType: z.literal(ALARM_ENTITY), taskId: text(200), project: text(200), repository: text(201), number: z.number().int().positive(), url: text(300), environment: text(64),
  signalKey: z.string().regex(/^[0-9a-f]{64}$/u), label: text(400), source: text(40), type: text(80), occurredAt: z.string(), recordedAt: z.string(), reportPending: z.literal(true).optional(), revertOffered: z.boolean(), expectedOffered: z.boolean(),
});
export type AlarmRow = z.infer<typeof AlarmRowSchema>;
export const ExpectedRowSchema = z.looseObject({
  ...base, entityType: z.literal(EXPECTED_ENTITY), taskId: text(200), repository: text(201), number: z.number().int().positive(), signalKey: z.string().regex(/^[0-9a-f]{64}$/u), personId: text(200), at: z.string(), reason: z.string().max(500).optional(),
});
export type ExpectedRow = z.infer<typeof ExpectedRowSchema>;
export const RevertRowSchema = z.looseObject({
  ...base, entityType: z.literal(REVERT_ENTITY), taskId: text(200), repository: text(201), number: z.number().int().positive(), url: text(300), mergeCommit: text(128), requestId: z.string().regex(/^[0-9a-f]{64}$/u),
  requestedBy: text(200), requestedAt: z.string(), state: z.enum(["starting", "started"]), revertTaskId: text(200).optional(),
});
export type RevertRow = z.infer<typeof RevertRowSchema>;
export const OpenRowSchema = z.looseObject({ ...base, entityType: z.literal(QUEUE_ENTITY), queue: z.literal("open"), project: text(200), repository: text(201), number: z.number().int().positive(), environment: text(64), windowEndsAtMs: z.number().int() });
export type OpenRow = z.infer<typeof OpenRowSchema>;
export const PendingRowSchema = z.looseObject({ ...base, entityType: z.literal(QUEUE_ENTITY), queue: z.literal("pending"), kind: z.enum(["watch", "alarm"]), repository: text(201), number: z.number().int().positive(), environment: text(64), signalKey: z.string() });
export type PendingRow = z.infer<typeof PendingRowSchema>;

/** The row as the schema reads it, only when it names this company and its own key; anything else is not a row of ours. */
function readRow<Schema extends z.ZodType<{ orgId: string }>>(schema: Schema, stored: StoredDocument | undefined, orgId: OrgId, key: (row: z.infer<Schema>) => DocumentKey | undefined): z.infer<Schema> | undefined {
  if (stored === undefined) return undefined;
  const parsed = schema.safeParse(stored);
  if (!parsed.success) return undefined;
  const row = parsed.data;
  const expected = key(row);
  return row.orgId === orgId && expected !== undefined && expected.pk === stored.pk && expected.sk === stored.sk ? row : undefined;
}

export const readWatch = (stored: StoredDocument | undefined, orgId: OrgId): WatchRow | undefined => readRow(WatchRowSchema, stored, orgId, (row) => watchKey(orgId, row.repository, row.number, row.environment));
export const readAlarm = (stored: StoredDocument | undefined, orgId: OrgId): AlarmRow | undefined => readRow(AlarmRowSchema, stored, orgId, (row) => alarmKey(orgId, row.repository, row.number, row.environment, row.signalKey));
export const readExpected = (stored: StoredDocument | undefined, orgId: OrgId): ExpectedRow | undefined => readRow(ExpectedRowSchema, stored, orgId, (row) => expectedKey(orgId, row.repository, row.number, row.signalKey));
export const readRevert = (stored: StoredDocument | undefined, orgId: OrgId): RevertRow | undefined => readRow(RevertRowSchema, stored, orgId, (row) => revertKey(orgId, row.repository, row.number));
export const readOpen = (stored: StoredDocument | undefined, orgId: OrgId): OpenRow | undefined => readRow(OpenRowSchema, stored, orgId, (row) => openKey(orgId, row.project, row.repository, row.number, row.environment));
export const readPending = (stored: StoredDocument | undefined, orgId: OrgId): PendingRow | undefined =>
  readRow(PendingRowSchema, stored, orgId, (row) => pendingKey(orgId, row.kind, row.repository, row.number, row.environment, row.signalKey));


// ---- the reporter's own rows (M7 slice 2): one row per report and surface it was told to, so a report that failed on one surface is sent again to that one only.
//   ORG#<company>#AFTER_MERGE_SENT   <reportId>#<surface>      (watcher's stable 64-hex report id; surface: pull_request, task or chat); expires 30 days after it was written
export const SENT_ENTITY = "AFTER_MERGE_SENT";
export const sentPartition = (orgId: OrgId): string => companyScoped(orgId, "AFTER_MERGE_SENT");
export const SURFACES = ["pull_request", "task", "chat"] as const;
export type Surface = (typeof SURFACES)[number];
export const sentKey = (orgId: OrgId, reportId: string, surface: Surface): DocumentKey => ({ pk: sentPartition(orgId), sk: `${reportId}#${surface}` });
export const SentRowSchema = z.looseObject({ ...base, entityType: z.literal(SENT_ENTITY), reportId: z.string().regex(/^[0-9a-f]{64}$/u), surface: z.enum(SURFACES), state: z.enum(["sending", "done"]), leaseUntil: z.number().optional() });
export type SentRow = z.infer<typeof SentRowSchema>;
export const readSent = (stored: StoredDocument | undefined, orgId: OrgId): SentRow | undefined => readRow(SentRowSchema, stored, orgId, (row) => sentKey(orgId, row.reportId, row.surface));
