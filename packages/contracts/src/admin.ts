// packages/contracts/src/admin.ts
// Spec 025 phase 25d: the admin read routes' shapes (FR-038) and the records of the derived
// failure and usage indexes (A5). The wire schemas are not strict: a newer control plane may add
// fields, and an older CLI must still read the answer. zod 4 strips unknown keys from a plain
// object, so each top-level response schema is `.passthrough()` to keep them.
import { z } from "zod";
import { DeveloperTaskFailureCategorySchema } from "./developer-tasks.js";
import { looseCopy } from "./loose.js";
import { DeveloperTaskPolicySchema } from "./project.js";
import { SlackChannelIdSchema, SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";
import { WorkspaceStatusSchema } from "./workspace.js";

/** A1 (Q1): the admin API's own version, reported beside DEVELOPER_API_VERSION. */
export const ADMIN_API_VERSION = "1.0";
export const ADMIN_LIST_MAX = 100;
export const ADMIN_FAILURES_DEFAULT_LIMIT = 25;
export const ADMIN_WORKSPACES_DEFAULT_LIMIT = 50;
export const ADMIN_FAILURES_DEFAULT_HOURS = 24;
/** FR-038: index days are kept 30 days, like turn records (A6). */
export const ADMIN_INDEX_RETENTION_DAYS = 30;
export const ADMIN_ERROR_TEXT_MAX = 1_000;
/** A9: the most usage items, and the most turn records, one usage answer reads. */
export const ADMIN_USAGE_READ_MAX = 5_000;
/** A8: the most index pages one filtered turn read takes. */
export const ADMIN_TURN_FILTER_PAGES = 10;
export const PROJECT_CATALOG_PK = "PROJECT_CATALOG";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const Uuid = z.string().uuid();
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * An ISO instant written one way (millisecond precision), so index keys sort by time whatever
 * precision the caller used. Refuses a time that only looks like ISO, such as month 13 or 30
 * February (Date would roll it over, so the date and time must round-trip unchanged).
 */
function canonicalInstant(at: string): string {
  const refuse = (): never => {
    throw new Error("an index key needs an ISO time such as 2026-09-30T08:15:00.000Z");
  };
  if (!ISO.test(at)) return refuse();
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return refuse();
  const canonical = new Date(ms).toISOString();
  if (canonical.slice(0, 19) !== at.slice(0, 19)) return refuse();
  return canonical;
}

/** The UTC day an index item belongs to. */
export function indexDay(at: string): string {
  return canonicalInstant(at).slice(0, 10);
}
export function failureIndexKey(endedAt: string, operationId: string): { pk: string; sk: string } {
  const at = canonicalInstant(endedAt);
  return { pk: `FAILURE#${indexDay(at)}`, sk: `${at}#${operationId}` };
}
export function usageIndexKey(at: string, operationId: string): { pk: string; sk: string } {
  const time = canonicalInstant(at);
  return { pk: `USAGE#${indexDay(time)}`, sk: `${time}#${operationId}` };
}
/**
 * A6 (Q5, owner answer 2026-09-30): the TTL attribute of every failure and usage item. Named
 * environments' State table expires items on it; the legacy deployment's reconciler deletes them.
 */
export const INDEX_EXPIRY_ATTRIBUTE = "indexExpiresAt";
export function indexExpiresAt(at: string): number {
  return Math.floor(Date.parse(canonicalInstant(at)) / 1000) + ADMIN_INDEX_RETENTION_DAYS * 86_400;
}
/** A3: one row per registered project, written with each registration from 25d on. */
export function projectCatalogKey(name: string): { pk: string; sk: string } {
  return { pk: PROJECT_CATALOG_PK, sk: `PROJECT#${name}` };
}

export const AdminOriginSchema = z.enum(["slack", "ai_tool"]);
export type AdminOrigin = z.infer<typeof AdminOriginSchema>;

const RequesterSlackShape = { kind: z.literal("slack"), teamId: SlackTeamIdSchema, userId: SlackUserIdSchema };
const RequesterDeveloperShape = { kind: z.literal("developer"), developerId: Hex64, provider: z.enum(["slack", "oidc"]), name: z.string().min(1).max(200).optional() };
const RequesterNoneShape = { kind: z.literal("none") };

/** A5: who asked for the operation, as the operation record says. Strict: the index side. */
export const AdminRequesterSchema = z.discriminatedUnion("kind", [
  z.object(RequesterSlackShape).strict(),
  z.object(RequesterDeveloperShape).strict(),
  z.object(RequesterNoneShape).strict(),
]);
export type AdminRequester = z.infer<typeof AdminRequesterSchema>;

/** The same requester on the wire: the kinds stay closed, a newer control plane may add fields. */
const AdminRequesterWireSchema = z.discriminatedUnion("kind", [
  z.object(RequesterSlackShape).passthrough(),
  z.object(RequesterDeveloperShape).passthrough(),
  z.object(RequesterNoneShape).passthrough(),
]);

const IndexIdentity = {
  operationId: Uuid,
  workspaceId: Uuid,
  project: z.string().min(1).max(63),
  origin: AdminOriginSchema,
  requester: AdminRequesterSchema,
  /** The turn record link: a developer task's ID, or a Slack thread's subject. */
  taskId: Uuid.optional(),
  thread: z.string().min(1).max(128).optional(),
};

export const FailureIndexRecordSchema = z.object({
  ...IndexIdentity,
  kind: z.string().min(1).max(32),
  status: z.enum(["FAILED", "INTERRUPTED"]),
  category: DeveloperTaskFailureCategorySchema,
  /** Redacted, then cut to 1,000 characters (redactAndCap). */
  error: z.string().max(ADMIN_ERROR_TEXT_MAX),
  endedAt: z.string().regex(ISO),
});
export type FailureIndexRecord = z.infer<typeof FailureIndexRecordSchema>;

/** A failure as the failures answer carries it: the stored record's fields, loose all the way down. */
const AdminFailureSchema = FailureIndexRecordSchema.extend({ requester: AdminRequesterWireSchema }).passthrough();

export const UsageIndexRecordSchema = z.object({
  ...IndexIdentity,
  at: z.string().regex(ISO),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** spec 011: null when the provider gave no cost. */
  costUsd: z.number().nonnegative().nullable(),
});
export type UsageIndexRecord = z.infer<typeof UsageIndexRecordSchema>;

export const AdminProjectSchema = z.object({
  name: z.string(),
  latestRevision: z.number().int().positive(),
  registeredAt: z.string(),
  repositories: z.array(z.object({ name: z.string(), url: z.string() })),
  runtimeMode: z.string(),
  connectors: z.array(z.object({ name: z.string(), type: z.string() })),
  /** A loose copy (looseCopy), so a new policy field at any depth does not fail the answer. */
  developerTasks: looseCopy(DeveloperTaskPolicySchema),
});
export const AdminProjectsResponseSchema = z.object({ projects: z.array(AdminProjectSchema) }).passthrough();
export type AdminProjectsResponse = z.infer<typeof AdminProjectsResponseSchema>;

export const AdminBindingSchema = z.object({
  teamId: SlackTeamIdSchema,
  channelId: SlackChannelIdSchema,
  /** A public channel's name only (A11). */
  channelName: z.string().optional(),
  private: z.boolean().optional(),
  projectName: z.string(),
  updatedAt: z.string(),
});
export const AdminBindingsResponseSchema = z.object({ bindings: z.array(AdminBindingSchema), notices: z.array(z.string()) }).passthrough();
export type AdminBindingsResponse = z.infer<typeof AdminBindingsResponseSchema>;

export const AdminFailuresResponseSchema = z.object({
  failures: z.array(AdminFailureSchema),
  since: z.string(),
  until: z.string(),
  skipped: z.number().int().nonnegative().optional(),
}).passthrough();
export type AdminFailuresResponse = z.infer<typeof AdminFailuresResponseSchema>;

export const AdminUsageGroupBySchema = z.enum(["project", "requester", "origin", "day"]);
export type AdminUsageGroupBy = z.infer<typeof AdminUsageGroupBySchema>;
export const AdminUsageGroupSchema = z.object({
  key: z.string(),
  turns: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  taskDurationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  costUnknown: z.number().int().nonnegative(),
});
export const AdminUsageResponseSchema = z.object({
  groupBy: AdminUsageGroupBySchema,
  since: z.string(),
  until: z.string(),
  groups: z.array(AdminUsageGroupSchema),
  truncated: z.boolean(),
}).passthrough();
export type AdminUsageResponse = z.infer<typeof AdminUsageResponseSchema>;

export const AdminWorkspaceSchema = z.object({
  id: Uuid,
  project: z.string(),
  origin: AdminOriginSchema,
  owner: z.object({ threadUrl: z.string().optional(), taskId: Uuid.optional(), developerName: z.string().optional() }),
  status: WorkspaceStatusSchema,
  busy: z.boolean(),
  lastActivityAt: z.string(),
});
export const AdminWorkspacesResponseSchema = z.object({
  workspaces: z.array(AdminWorkspaceSchema),
  limits: z.object({ perPerson: z.number().int().positive(), perOrganization: z.number().int().positive(), source: z.enum(["setting", "parameters"]) }),
  counts: z.object({ organization: z.number().int().nonnegative(), developerOrganization: z.number().int().nonnegative().optional() }),
  truncated: z.boolean(),
}).passthrough();
export type AdminWorkspacesResponse = z.infer<typeof AdminWorkspacesResponseSchema>;

export const AdminHealthCheckSchema = z.object({ status: z.enum(["ok", "warn", "failed", "unknown"]), detail: z.string().max(300).optional() });
export type AdminHealthCheck = z.infer<typeof AdminHealthCheckSchema>;
export const AdminHealthResponseSchema = z.object({
  version: z.object({ developerApi: z.string(), adminApi: z.string(), release: z.string().optional() }),
  alarms: z.array(z.object({ name: z.string(), state: z.string() })),
  alarmsCheck: AdminHealthCheckSchema,
  deadLetterQueues: z.array(z.object({ name: z.string(), depth: z.number().int().nonnegative().nullable() })),
  slack: AdminHealthCheckSchema,
  github: AdminHealthCheckSchema,
  workerModes: z.array(z.object({
    mode: z.string(),
    configured: z.boolean(),
    latestDispatchFailure: z.object({ at: z.string(), operationId: z.string(), error: z.string() }).optional(),
  })),
  workspaces: z.record(z.string(), z.number().int().nonnegative()),
  workspacesTruncated: z.boolean(),
}).passthrough();
export type AdminHealthResponse = z.infer<typeof AdminHealthResponseSchema>;

export const AdminMeResponseSchema = z.object({
  issuer: z.string(),
  subject: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  slack: z.object({
    linked: z.boolean(),
    userId: SlackUserIdSchema.optional(),
    reason: z.enum(["no_email", "no_match", "slack_unavailable", "not_set_up"]).optional(),
  }),
}).passthrough();
export type AdminMeResponse = z.infer<typeof AdminMeResponseSchema>;
