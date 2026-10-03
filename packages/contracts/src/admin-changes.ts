// packages/contracts/src/admin-changes.ts
// Spec 025 phase 25e: an admin change's request (FR-039), its pending record (E2), its audit record
// (FR-051, E3) and the Slack press that confirms it (E14). Stored records and requests are strict.
// What a client reads (the `...WireSchema` variants) is loose all the way down, like 25d's admin
// answers: a newer control plane may add fields, kinds, statuses, methods, outcomes and refusal
// reasons, and an older CLI must still read the answer (R23), so those are plain strings there.
import { z } from "zod";
import { INDEX_EXPIRY_ATTRIBUTE } from "./admin.js";
import { looseCopy } from "./loose.js";
import { AgentXNameSchema } from "./project.js";
import { SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";

export const ADMIN_CHANGE_TTL_MS = 10 * 60_000;
export const ADMIN_CHANGE_SLACK_WAIT_MS = 5 * 60_000;
export const ADMIN_CHANGE_PROGRESS_MS = 15_000;
export const ADMIN_CHANGE_APPLYING_STALE_MS = 2 * 60_000;
/**
 * 25e re-review: the change routes' answer to an error AgentX did not expect. Fixed words, never the
 * error's own: the request may or may not have taken effect, so a client says to check first.
 */
export const ADMIN_CHANGE_UNEXPECTED_MESSAGE = "AgentX met an unexpected error on this change request, so it may or may not have taken effect; check the change records before asking again";
/** A change whose handler failed: it ended failed, so it is no longer pending. */
export const adminChangeFailedMessage = (changeId: string, message: string): string => `change ${changeId} failed: ${message}`;
export const ADMIN_CHANGE_FAILED_PATTERN = /^change [0-9a-f-]{36} failed: /;
export const ADMIN_CHANGE_RETENTION_DAYS = 30;
export const ADMIN_CHANGES_PARTITION = "CHANGES";
export const ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX = 20;
export const ADMIN_CHANGE_EFFECT_MAX = 4_000;
export const ADMIN_CHANGE_CONFIRM_ACTION = "agentx_admin_change_confirm";
export const ADMIN_CHANGE_CANCEL_ACTION = "agentx_admin_change_cancel";

const Uuid = z.string().uuid();
const Time = z.string().datetime();

export const AdminChangeKindSchema = z.enum([
  "register_project_revision", "bind_channel", "unbind_channel", "register_credential", "stop_workspace",
  "grant_project_access", "revoke_project_access", "revoke_signin", "set_workspace_limits",
  // Issue #205: an agentx config set change the CLI applies itself (a stack update) and records.
  "set_config",
]);
export type AdminChangeKind = z.infer<typeof AdminChangeKindSchema>;
export const ConfirmationMethodSchema = z.enum(["elicitation", "slack", "cli"]);
export type ConfirmationMethod = z.infer<typeof ConfirmationMethodSchema>;

const Channel = z.string().min(1).max(80);
/** E8: a developer ID, an email, or a Slack user ID. */
const DeveloperRef = z.string().min(1).max(254);
export const AdminChangeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register_project_revision"), definition: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("bind_channel"), channel: Channel, project: AgentXNameSchema }).strict(),
  z.object({ kind: z.literal("unbind_channel"), channel: Channel }).strict(),
  z.object({ kind: z.literal("register_credential"), ref: z.string().min(1).max(63), type: z.string().min(1).max(64), secretName: z.string().min(1).max(512), host: z.string().min(1).max(253).optional(), tokenUrl: z.string().min(1).max(2_048).optional(), resource: z.string().min(1).max(2_048).optional() }).strict(),
  z.object({ kind: z.literal("stop_workspace"), workspaceId: Uuid }).strict(),
  z.object({ kind: z.literal("grant_project_access"), project: AgentXNameSchema, developer: DeveloperRef }).strict(),
  z.object({ kind: z.literal("revoke_project_access"), project: AgentXNameSchema, developer: DeveloperRef }).strict(),
  z.object({ kind: z.literal("revoke_signin"), developer: DeveloperRef }).strict(),
  z.object({ kind: z.literal("set_workspace_limits"), perPerson: z.number().int().min(1).max(50).optional(), perOrganization: z.number().int().min(1).max(1_000).optional() }).strict(),
]);
export type AdminChangeInput = z.infer<typeof AdminChangeInputSchema>;

/** FR-051: the AgentX CLI running the MCP server, and the MCP client's own name and version. */
export const AdminChangeClientSchema = z.object({
  cliVersion: z.string().min(1).max(40),
  mcpClient: z.object({ name: z.string().min(1).max(200), version: z.string().max(64).optional() }).strict().optional(),
}).strict();
export const ProposeAdminChangeRequestSchema = z.object({
  requestId: Uuid,
  change: AdminChangeInputSchema,
  client: AdminChangeClientSchema,
  /** In the caller's order of preference; the control plane keeps those it allows (E13, E16). */
  methods: z.array(ConfirmationMethodSchema).min(1).max(3),
}).strict();
export type ProposeAdminChangeRequest = z.infer<typeof ProposeAdminChangeRequestSchema>;
/** E4: a Slack press applies through its own path, never this route. */
export const ApplyAdminChangeRequestSchema = z.object({ method: z.enum(["elicitation", "cli"]), requestedAt: Time.optional(), answeredAt: Time.optional() }).strict();
export type ApplyAdminChangeRequest = z.infer<typeof ApplyAdminChangeRequestSchema>;
/** `requestedAt`: when the pop-up or prompt was shown, so a declined confirmation records it too (final review M3). */
export const DeclineAdminChangeRequestSchema = z.object({ method: z.enum(["elicitation", "cli"]), reason: z.enum(["declined", "cancelled", "failed"]), requestedAt: Time.optional(), answeredAt: Time.optional() }).strict();
export type DeclineAdminChangeRequest = z.infer<typeof DeclineAdminChangeRequestSchema>;

/**
 * Issue #205: agentx config set's keys whose value can be a secret (a webhook alert address). Their
 * change records name the key only: never a before or after value.
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(["alerts.address"]);
const ConfigText = z.string().max(300);
/** Issue #205: what a recorded config change holds: the key, where it lives, and before and after (or `valueHidden`). */
export const ConfigChangeSchema = z.object({
  kind: z.literal("set_config"),
  key: z.string().min(3).max(64).regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/),
  target: ConfigText.min(1),
  before: ConfigText.optional(),
  after: ConfigText.optional(),
  /** A secret-bearing key: the value is never recorded, only that it changed. */
  valueHidden: z.literal(true).optional(),
}).strict().superRefine((change, context) => {
  const values = change.before !== undefined || change.after !== undefined;
  // A key this control plane does not know may still be hidden by a newer CLI; one it knows is secret never carries a value.
  if (SECRET_CONFIG_KEYS.has(change.key) && (values || change.valueHidden !== true)) {
    context.addIssue({ code: "custom", message: `${change.key} can hold a secret: record it with valueHidden true and no before or after value` });
  }
  if (change.valueHidden === true ? values : change.before === undefined || change.after === undefined) {
    context.addIssue({ code: "custom", message: `${change.key} is recorded with its before and after values, or with valueHidden true and neither` });
  }
});
export type ConfigChange = z.infer<typeof ConfigChangeSchema>;
/** A secret-bearing key's failure is recorded by these words only: its error may quote the value. */
export const SECRET_CONFIG_ERROR_MESSAGE = "the change did not finish; its error is not recorded, since this setting is secret";
/**
 * Issue #205: POST /v1/admin/changes/config. The CLI asked and got a yes (the cli method), and is
 * about to apply the change itself; the record starts applying. `requestedAt` and `answeredAt` are
 * when the prompt was shown and answered.
 */
export const RecordConfigChangeRequestSchema = z.object({
  /** Makes a repeated record request answer the record it made, so the CLI can ask again safely. */
  requestId: Uuid.optional(),
  change: ConfigChangeSchema,
  client: AdminChangeClientSchema,
  requestedAt: Time.optional(),
  answeredAt: Time.optional(),
}).strict();
export type RecordConfigChangeRequest = z.infer<typeof RecordConfigChangeRequestSchema>;
/** Issue #205: POST /v1/admin/changes/<id>/outcome: how a recorded config change ended, once. */
export const ConfigChangeOutcomeRequestSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("applied") }).strict(),
  z.object({ outcome: z.literal("failed"), error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(1_000) }).strict() }).strict(),
]);
export type ConfigChangeOutcomeRequest = z.infer<typeof ConfigChangeOutcomeRequestSchema>;

export const AdminChangeStatusSchema = z.enum(["pending", "applying", "applied", "declined", "expired", "failed"]);
export type AdminChangeStatus = z.infer<typeof AdminChangeStatusSchema>;
/** The statuses a change ends in; a pending change item drops its raw input on reaching one (R3). */
export const ADMIN_CHANGE_ENDED: ReadonlySet<AdminChangeStatus> = new Set(["applied", "declined", "expired", "failed"]);
export const AdminChangeOutcomeSchema = z.enum(["confirmed", "declined", "expired", "failed"]);
export type AdminChangeOutcome = z.infer<typeof AdminChangeOutcomeSchema>;
export function outcomeOfStatus(status: AdminChangeStatus): AdminChangeOutcome | undefined {
  switch (status) {
    case "applied": return "confirmed";
    case "declined": return "declined";
    case "expired": return "expired";
    case "failed": return "failed";
    default: return undefined;
  }
}

const ChangeError = z.object({ code: z.string().max(64), message: z.string().max(1_000) }).strict();
export const AdminChangeViewSchema = z.object({
  changeId: Uuid,
  kind: AdminChangeKindSchema,
  status: AdminChangeStatusSchema,
  effect: z.string().max(ADMIN_CHANGE_EFFECT_MAX),
  methodsOffered: z.array(ConfirmationMethodSchema),
  createdAt: z.string(),
  expiresAt: z.string(),
  methodUsed: ConfirmationMethodSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: ChangeError.optional(),
}).strict();
export type AdminChangeView = z.infer<typeof AdminChangeViewSchema>;
export const AdminChangeResponseSchema = z.object({ change: AdminChangeViewSchema }).strict();
export type AdminChangeResponse = z.infer<typeof AdminChangeResponseSchema>;

export const RefusedAttemptReasonSchema = z.enum(["another_person", "wrong_team", "stale_state", "expired", "not_pending", "method_not_offered", "another_admin"]);
export type RefusedAttemptReason = z.infer<typeof RefusedAttemptReasonSchema>;
/** C1: the writer keeps at most 20, and a reader keeps the last 20 of a record that holds more. */
const lastRefusedAttempts = <T extends z.ZodTypeAny>(attempt: T) => z.preprocess(
  (value) => (Array.isArray(value) ? value.slice(-ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX) : value),
  z.array(attempt).max(ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX),
);
const RefusedAttemptSchema = z.object({ at: Time, reason: RefusedAttemptReasonSchema, slackUserId: SlackUserIdSchema.optional() }).strict();
export const AdminChangeAuditRecordSchema = z.object({
  changeId: Uuid,
  kind: AdminChangeKindSchema,
  traceId: z.string().min(1).max(128),
  admin: z.object({ issuer: z.string().min(1).max(512), subject: z.string().min(1).max(256), displayName: z.string().min(1).max(200).optional() }).strict(),
  client: z.object({ cliVersion: z.string().max(40), mcpClientName: z.string().max(200).optional(), mcpClientVersion: z.string().max(64).optional() }).strict(),
  /** The input and the plan's details, through redactSecrets. */
  change: z.record(z.string(), z.unknown()),
  effect: z.string().max(ADMIN_CHANGE_EFFECT_MAX),
  methodsOffered: z.array(ConfirmationMethodSchema),
  methodUsed: ConfirmationMethodSchema.optional(),
  pressedBy: SlackUserIdSchema.optional(),
  status: AdminChangeStatusSchema,
  outcome: AdminChangeOutcomeSchema.optional(),
  proposedAt: Time,
  confirmationRequestedAt: Time.optional(),
  answeredAt: Time.optional(),
  appliedAt: Time.optional(),
  failedAt: Time.optional(),
  expiredAt: Time.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: ChangeError.optional(),
  refusedAttempts: lastRefusedAttempts(RefusedAttemptSchema).optional(),
}).strict();
export type AdminChangeAuditRecord = z.infer<typeof AdminChangeAuditRecordSchema>;
export const AdminChangesResponseSchema = z.object({ changes: z.array(AdminChangeAuditRecordSchema), cursor: z.string().optional() }).strict();
export type AdminChangesResponse = z.infer<typeof AdminChangesResponseSchema>;
/** Issue #205: the recorded config change routes answer with the audit record itself. */
export const RecordedChangeResponseSchema = z.object({ change: AdminChangeAuditRecordSchema }).strict();
export type RecordedChangeResponse = z.infer<typeof RecordedChangeResponseSchema>;

// The wire variants (R1, R23): the same fields, with the closed sets as plain strings and every
// object loose, so a newer control plane's value or field never fails an older client's read.
const WireError = z.object({ code: z.string(), message: z.string() }).passthrough();
// A newer control plane's longer text, times or IDs never fail either: no length, uuid or datetime limits.
const WireOverrides = {
  kind: z.string(),
  status: z.string(),
  effect: z.string(),
  methodsOffered: z.array(z.string()),
  methodUsed: z.string().optional(),
  error: WireError.optional(),
};
export const AdminChangeViewWireSchema = looseCopy(AdminChangeViewSchema.extend({ ...WireOverrides, createdAt: z.string(), expiresAt: z.string() }));
export type AdminChangeViewWire = z.infer<typeof AdminChangeViewWireSchema>;
export const AdminChangeResponseWireSchema = z.object({ change: AdminChangeViewWireSchema }).passthrough();
export type AdminChangeResponseWire = z.infer<typeof AdminChangeResponseWireSchema>;
export const AdminChangeAuditRecordWireSchema = looseCopy(AdminChangeAuditRecordSchema.extend({
  ...WireOverrides,
  traceId: z.string(),
  client: z.object({ cliVersion: z.string(), mcpClientName: z.string().optional(), mcpClientVersion: z.string().optional() }),
  outcome: z.string().optional(),
  pressedBy: z.string().optional(),
  proposedAt: z.string(),
  confirmationRequestedAt: z.string().optional(),
  answeredAt: z.string().optional(),
  appliedAt: z.string().optional(),
  failedAt: z.string().optional(),
  expiredAt: z.string().optional(),
  refusedAttempts: lastRefusedAttempts(z.object({ at: z.string(), reason: z.string(), slackUserId: z.string().optional() }).passthrough()).optional(),
}));
export type AdminChangeAuditRecordWire = z.infer<typeof AdminChangeAuditRecordWireSchema>;
export const AdminChangesResponseWireSchema = z.object({ changes: z.array(AdminChangeAuditRecordWireSchema), cursor: z.string().optional() }).passthrough();
export type AdminChangesResponseWire = z.infer<typeof AdminChangesResponseWireSchema>;
export const RecordedChangeResponseWireSchema = z.object({ change: AdminChangeAuditRecordWireSchema }).passthrough();
export type RecordedChangeResponseWire = z.infer<typeof RecordedChangeResponseWireSchema>;

export function adminChangeKey(changeId: string): { pk: string; sk: "META" } {
  return { pk: `ADMIN_CHANGE#${changeId}`, sk: "META" };
}
export function adminChangeRequestKey(ownerKey: string, requestId: string): { pk: string; sk: string } {
  return { pk: `ADMIN_CHANGE_REQUEST#${ownerKey}`, sk: requestId };
}
/** Epoch seconds, ADMIN_CHANGE_RETENTION_DAYS after the proposal: the audit record's and the pending items' expiry. */
export function adminChangeItemExpiresAt(proposedAt: string): number {
  return Math.floor(Date.parse(proposedAt) / 1000) + ADMIN_CHANGE_RETENTION_DAYS * 86_400;
}
/** E3: the audit record's keys in the TurnRecords table: its own export partition, and the table's TTL. */
export function adminChangeAuditKeys(changeId: string, proposedAt: string) {
  return {
    pk: `CHANGE#${changeId}`,
    sk: "AUDIT" as const,
    exportPk: ADMIN_CHANGES_PARTITION,
    exportSk: `${proposedAt}#${changeId}`,
    expiresAt: adminChangeItemExpiresAt(proposedAt),
  };
}

/**
 * E2: the pending change as stored, `ADMIN_CHANGE#<id>` / `META` in the State table. R2 (D29): it
 * carries the State table's TTL attribute (INDEX_EXPIRY_ATTRIBUTE, set only in named environments,
 * where admin changes exist) at proposedAt plus 30 days, so it outlives the audit's reads of it.
 */
export const AdminChangePendingRecordSchema = z.object({
  pk: z.string(),
  sk: z.literal("META"),
  entityType: z.literal("ADMIN_CHANGE"),
  changeId: Uuid,
  kind: AdminChangeKindSchema,
  /**
   * The raw input the apply re-plans from (R3). Removed in the transition that ends the change
   * (applied, declined, expired, failed), so a pending or applying change always has it and an
   * ended one never keeps it.
   */
  input: AdminChangeInputSchema.optional(),
  effect: z.string().max(ADMIN_CHANGE_EFFECT_MAX),
  /** R4 (B4): the effect naming a private channel to a member planning admin; shown only to them, never audited. */
  confirmationEffect: z.string().max(ADMIN_CHANGE_EFFECT_MAX).optional(),
  details: z.record(z.string(), z.unknown()),
  stateHash: z.string().min(1).max(128),
  admin: z.object({ issuer: z.string().min(1).max(512), subject: z.string().min(1).max(256), ownerKey: z.string().min(1).max(256), displayName: z.string().min(1).max(200).optional() }).strict(),
  slackUserId: SlackUserIdSchema.optional(),
  methodsOffered: z.array(ConfirmationMethodSchema),
  status: AdminChangeStatusSchema,
  createdAt: Time,
  proposedAt: Time,
  expiresAt: Time,
  traceId: z.string().min(1).max(128),
  claimedAt: Time.optional(),
  slackRequestedAt: Time.optional(),
  /** E13: the direct message. `editedAt` is unused and kept only so the strict object still reads any record carrying it; the edit time is the top-level `dmEditedAt` (ruling B2). */
  dm: z.object({ channel: z.string().min(1).max(64), ts: z.string().min(1).max(64), postedAt: Time, editedAt: Time.optional() }).strict().optional(),
  /** E13: the notifier's claim on posting the direct message, so two deliveries never both post it. */
  dmClaimedAt: Time.optional(),
  /** E13: when the notifier edited the message with the outcome (top level, ruling B2). */
  dmEditedAt: Time.optional(),
  methodUsed: ConfirmationMethodSchema.optional(),
  pressedBy: SlackUserIdSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: ChangeError.optional(),
  [INDEX_EXPIRY_ATTRIBUTE]: z.number().int().positive(),
}).strict().refine(
  (record) => (record.input === undefined ? ADMIN_CHANGE_ENDED.has(record.status) : record.input.kind === record.kind) && record.pk === adminChangeKey(record.changeId).pk,
  { message: "the pending change's key, kind and input disagree, or a change not yet ended has no input" },
); // The refine pins pk exactly.
export type AdminChangePendingRecord = z.infer<typeof AdminChangePendingRecordSchema>;
/** The broker's and notifier's name for a stored pending change (Tasks 7, 8, 9). */
export type PendingChange = AdminChangePendingRecord;

/** E2: `ADMIN_CHANGE_REQUEST#<ownerKey>` / `<requestId>`, so a repeated request ID answers the change it made. */
export const AdminChangeRequestRecordSchema = z.object({
  pk: z.string().startsWith("ADMIN_CHANGE_REQUEST#"),
  sk: Uuid,
  entityType: z.literal("ADMIN_CHANGE_REQUEST"),
  changeId: Uuid,
  /** A hash of the change asked for, so the same request ID with another change is refused (final review I2); absent on older items. */
  changeHash: z.string().min(1).max(128).optional(),
  [INDEX_EXPIRY_ATTRIBUTE]: z.number().int().positive(),
}).strict();
export type AdminChangeRequestRecord = z.infer<typeof AdminChangeRequestRecordSchema>;

/** E14: the ingress hands a Confirm or Cancel press to the broker by a direct, asynchronous invoke. */
export const AdminChangePressEventSchema = z.object({
  source: z.literal("agentx.slack-ingress"),
  action: z.literal("admin-change-press"),
  changeId: Uuid,
  click: z.enum(["confirm", "cancel"]),
  slackUserId: SlackUserIdSchema,
  teamId: SlackTeamIdSchema.optional(),
}).strict();
export type AdminChangePressEvent = z.infer<typeof AdminChangePressEventSchema>;
export function isAdminChangePressEvent(value: unknown): value is AdminChangePressEvent {
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return typeof value === "object" && value !== null && (value as { requestContext?: unknown }).requestContext === undefined && AdminChangePressEventSchema.safeParse(value).success;
}

/** FR-041: which methods the environment allows, reported in agentx-configuration (E16). */
export const AgentXConfigurationConfirmSchema = z.object({ elicitation: z.boolean(), slack: z.boolean() });
export type AgentXConfigurationConfirm = z.infer<typeof AgentXConfigurationConfirmSchema>;
