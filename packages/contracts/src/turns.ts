import { z } from "zod";
import { redactSecrets, redactText } from "./redaction.js";
import { SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";
import { TaskUsageTelemetrySchema } from "./usage.js";

export const TURN_TEXT_LIMIT = 40_000;
export const TURN_ARGUMENT_LIMIT = 2_048;
export const TURN_CALL_LIMIT = 50;
export const TURN_RETENTION_DAYS = 30;
export const TURN_EXPORT_PAGE = 100;
export const TURN_EXPORT_PARTITION = "TURNS";
/** At most this many distinct recording-failure categories per turn. */
export const TURN_RECORDING_ERROR_LIMIT = 8;

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

export const TurnValidationSchema = z.enum(["ok", "schema_error", "policy_denied", "unknown_tool"]);
export const TurnOutcomeSchema = z.enum(["SUCCEEDED", "FAILED", "UNKNOWN", "IN_PROGRESS"]);

/** Longest gate reason a turn record keeps (spec 014 FR-021). */
export const TURN_GATE_REASON_LIMIT = 200;

/**
 * The action gate's decision on one call (spec 014 FR-021): the outcome, what decided it, why it
 * asks, the 1-based administrator rule as text, and a short reason that carries no argument value.
 * Optional on a call, so records written before the gate still parse.
 */
export const TurnGateSchema = z.object({
  outcome: z.enum(["allow", "ask", "deny"]),
  source: z.enum(["confirmation", "rule", "default", "yes_to_all", "classifier", "classifier_unavailable", "gate_error"]),
  kind: z.enum(["classifier", "destructive", "admin", "bulk", "hint", "read", "create", "allowed"]).optional(),
  rule: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
  reason: z.string().max(TURN_GATE_REASON_LIMIT),
}).strict();

export const TurnCallSchema = z.object({
  name: z.string().min(1).max(128),
  connector: z.string().max(20).optional(),
  /** Redacted JSON text of the model's arguments, capped at TURN_ARGUMENT_LIMIT characters. */
  arguments: z.string().max(TURN_ARGUMENT_LIMIT),
  argumentsFingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  validation: TurnValidationSchema,
  outcome: TurnOutcomeSchema,
  reason: z.string().max(64).optional(),
  durationMs: z.number().int().nonnegative(),
  requestId: z.string().max(64).optional(),
  operationId: z.string().max(64).optional(),
  /** The action gate's decision on this call (spec 014 FR-021); absent in records written before the gate. */
  gate: TurnGateSchema.optional(),
}).strict();

/** What the orchestrator saw during one turn; the Slack service adds identity and text. */
export const TurnObservationSchema = z.object({
  model: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict().optional(),
  manifestHash: Hex64.optional(),
  offeredTools: z.array(z.object({ name: z.string().min(1).max(128), descriptionHash: Hex64 }).strict()).max(64),
  calls: z.array(TurnCallSchema).max(TURN_CALL_LIMIT),
  /** Present and true when the turn made more than TURN_CALL_LIMIT calls and only the first were kept. */
  callsTruncated: z.boolean().optional(),
  stopReason: z.string().max(32).optional(),
  emptyResponse: z.boolean(),
  usage: TaskUsageTelemetrySchema.optional(),
  usageError: z.string().max(200).optional(),
  /** Fixed category strings naming recorder failures (never raw error messages), so a broken recorder is not silent. */
  recordingErrors: z.array(z.string().min(1).max(64)).max(TURN_RECORDING_ERROR_LIMIT).optional(),
  workerOperations: z.array(z.string().uuid()).max(TURN_CALL_LIMIT),
}).strict();

/**
 * How a turn ended. `confirmation_refused` (spec 014 FR-021): the message answered a confirmation
 * that could not be used (another member's, no longer pending, expired, or claimed by another
 * event), so nothing ran. `confirmation_cancelled`: the requester cancelled a pending confirmation.
 * `yes_to_all_granted`: a "yes to all" with no pending confirmation only granted it. Like the
 * workspace dispositions, none of these ran the orchestrator or counts in turn metrics.
 */
export const TurnDispositionSchema = z.enum([
  "answered", "failed", "abandoned", "workspace_close", "workspace_limit", "workspace_closed", "workspace_unavailable",
  "confirmation_refused", "confirmation_cancelled", "yes_to_all_granted",
  "model_list", "model_switch",
]);

export const TurnRecordSchema = TurnObservationSchema.extend({
  eventId: z.string().regex(/^Ev[A-Za-z0-9]{4,64}$/),
  origin: z.literal("slack").optional(),
  subject: z.string().min(1).max(128),
  receivedAt: z.string().datetime(),
  requestedBy: z.object({ teamId: SlackTeamIdSchema, userId: SlackUserIdSchema }).strict(),
  /** Added at export from the workspace record; never stored. */
  project: z.string().max(63).optional(),
  settingsRevision: z.number().int().positive().optional(),
  workspaceId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  disposition: TurnDispositionSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  requestText: z.string().max(TURN_TEXT_LIMIT),
  responseText: z.string().max(TURN_TEXT_LIMIT),
  textTruncated: z.boolean().optional(),
  /** Present and true when every call's arguments became "[omitted]" to fit the storage budget. Optional, so older records still parse. */
  argumentsOmitted: z.boolean().optional(),
  error: z.object({ name: z.string().max(128), code: z.string().max(64).optional() }).strict().optional(),
}).strict();

export type TurnValidation = z.infer<typeof TurnValidationSchema>;
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
export type TurnGate = z.infer<typeof TurnGateSchema>;
export type TurnCall = z.infer<typeof TurnCallSchema>;
export type TurnObservation = z.infer<typeof TurnObservationSchema>;
export type TurnDisposition = z.infer<typeof TurnDispositionSchema>;
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const EMPTY_TURN_OBSERVATION: TurnObservation = { offeredTools: [], calls: [], emptyResponse: false, workerOperations: [] };

export function capText(text: string, limit = TURN_TEXT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // Back off one unit if the cut would split a surrogate pair (a high surrogate at the boundary).
  const code = text.charCodeAt(limit - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return { text: text.slice(0, cut), truncated: true };
}

/** How much raw text redactAndCap looks at, as a multiple of the limit. Redaction can shrink
 * text (a long secret becomes a short marker), so it reads more than the limit, but never an
 * unbounded amount. */
export const REDACTION_CEILING_FACTOR = 4;

/** Redacts before capping, so a secret that would straddle the cut cannot leak a truncated
 * fragment: capping first and redacting afterward can leave a partial credential in the output.
 * Raw input past REDACTION_CEILING_FACTOR times the limit is dropped before redacting, and so is
 * the partial token at that cut (back to the last character outside the token alphabet), because
 * a secret cut short may no longer match its pattern. Text made only of token characters up to the
 * ceiling is dropped whole. */
export function redactAndCap(text: string, limit = TURN_TEXT_LIMIT): { text: string; truncated: boolean } {
  const ceiling = limit * REDACTION_CEILING_FACTOR;
  if (text.length <= ceiling) return capText(redactText(text), limit);
  let cut = ceiling;
  while (cut > 0 && TOKEN_ALPHABET.test(text[cut] ?? "")) cut -= 1;
  const bounded = text.slice(0, cut);
  return { text: capText(redactText(bounded), limit).text, truncated: true };
}

const TOKEN_ALPHABET = /[A-Za-z0-9+/=_.~%:@-]/;
export const UNRECORDABLE_ARGUMENTS = "[unrecordable arguments]";

/** Tool arguments for a turn record: the parsed object is redacted by key and value with
 * redactSecrets, then serialized and capped. Callers must use this rather than text-redacting
 * a JSON string, which cannot see keys and escapes reliably. A value that cannot be redacted or
 * serialized (circular, too deeply nested, BigInt) gives UNRECORDABLE_ARGUMENTS instead of
 * throwing, so the turn record is still written. */
export function redactArguments(value: unknown, limit = TURN_ARGUMENT_LIMIT): string {
  try {
    return capText(JSON.stringify(redactSecrets(value)) ?? "", limit).text;
  } catch {
    return UNRECORDABLE_ARGUMENTS.slice(0, limit);
  }
}

/** The sk, export and expiry shape every turn record key shares; only pk differs between a
 * Slack record's THREAD# and an AI-tool record's TASK#. */
function timeIndexedKeys(pk: string, at: string, receivedAt: string) {
  return {
    pk,
    sk: `TURN#${at}`,
    exportPk: TURN_EXPORT_PARTITION,
    exportSk: at,
    expiresAt: Math.floor(Date.parse(receivedAt) / 1000) + TURN_RETENTION_DAYS * 86_400,
  } as const;
}

export function turnRecordKeys(record: Pick<TurnRecord, "subject" | "receivedAt" | "eventId">) {
  const at = `${record.receivedAt}#${record.eventId}`;
  return timeIndexedKeys(`THREAD#${record.subject}`, at, record.receivedAt);
}

/** Spec 025 FR-037: one developer action from an AI tool, keyed by task, in the same table and export. */
export const AiToolTurnRecordSchema = z.object({
  origin: z.literal("ai_tool"),
  taskId: z.string().uuid(),
  turnId: z.string().uuid(),
  action: z.enum(["start", "continue", "pull_request", "cancel", "close"]),
  phase: z.enum(["accepted", "completed", "refused"]),
  developer: z.object({
    developerId: Hex64,
    provider: z.enum(["slack", "oidc"]),
    displayName: z.string().min(1).max(200),
    slackUserId: SlackUserIdSchema.optional(),
  }).strict(),
  client: z.string().min(1).max(40),
  receivedAt: z.string().datetime(),
  /** Added at export from the workspace record; never stored. */
  project: z.string().max(63).optional(),
  settingsRevision: z.number().int().positive().optional(),
  workspaceId: z.string().uuid().optional(),
  operationId: z.string().uuid().optional(),
  outcome: z.enum(["accepted", "refused", "succeeded", "failed", "cancelled", "interrupted"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  requestText: z.string().max(TURN_TEXT_LIMIT),
  responseText: z.string().max(TURN_TEXT_LIMIT),
  textTruncated: z.boolean().optional(),
  error: z.object({ code: z.string().max(64) }).strict().optional(),
}).strict();
export type AiToolTurnRecord = z.infer<typeof AiToolTurnRecordSchema>;
export type ExportedTurnRecord = TurnRecord | AiToolTurnRecord;

/**
 * Narrows a page of ExportedTurnRecord to the Slack shape: true unless origin is "ai_tool".
 * A caller that only reads Slack turns (eventId, disposition, calls, and so on) filters with
 * this first, rather than asserting the type or disabling the lint rule that would otherwise
 * catch a Slack-only field read off an AI-tool record.
 */
export function isSlackTurnRecord(turn: ExportedTurnRecord): turn is TurnRecord {
  return turn.origin !== "ai_tool";
}

export function aiToolTurnRecordKeys(record: Pick<AiToolTurnRecord, "taskId" | "receivedAt" | "turnId">) {
  const at = `${record.receivedAt}#${record.turnId}`;
  return timeIndexedKeys(`TASK#${record.taskId}`, at, record.receivedAt);
}
