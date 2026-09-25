import { z } from "zod";
import { SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";
import { TaskUsageTelemetrySchema } from "./usage.js";

export const TURN_TEXT_LIMIT = 40_000;
export const TURN_ARGUMENT_LIMIT = 2_048;
export const TURN_CALL_LIMIT = 50;
export const TURN_RETENTION_DAYS = 30;
export const TURN_EXPORT_PAGE = 100;
export const TURN_EXPORT_PARTITION = "TURNS";

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

export const TurnValidationSchema = z.enum(["ok", "schema_error", "policy_denied", "unknown_tool"]);
export const TurnOutcomeSchema = z.enum(["SUCCEEDED", "FAILED", "UNKNOWN", "IN_PROGRESS"]);

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
}).strict();

/** What the orchestrator saw during one turn; the Slack service adds identity and text. */
export const TurnObservationSchema = z.object({
  model: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict().optional(),
  manifestHash: Hex64.optional(),
  offeredTools: z.array(z.object({ name: z.string().min(1).max(128), descriptionHash: Hex64 }).strict()).max(64),
  calls: z.array(TurnCallSchema).max(TURN_CALL_LIMIT),
  callsTruncated: z.boolean().optional(),
  stopReason: z.string().max(32).optional(),
  emptyResponse: z.boolean(),
  usage: TaskUsageTelemetrySchema.optional(),
  usageError: z.string().max(200).optional(),
  workerOperations: z.array(z.string().uuid()).max(TURN_CALL_LIMIT),
}).strict();

export const TurnDispositionSchema = z.enum([
  "answered", "failed", "abandoned", "workspace_close", "workspace_limit", "workspace_closed", "workspace_unavailable",
]);

export const TurnRecordSchema = TurnObservationSchema.extend({
  eventId: z.string().regex(/^Ev[A-Za-z0-9]{4,64}$/),
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
  error: z.object({ name: z.string().max(128), code: z.string().max(64).optional() }).strict().optional(),
}).strict();

export type TurnValidation = z.infer<typeof TurnValidationSchema>;
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
export type TurnCall = z.infer<typeof TurnCallSchema>;
export type TurnObservation = z.infer<typeof TurnObservationSchema>;
export type TurnDisposition = z.infer<typeof TurnDispositionSchema>;
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const EMPTY_TURN_OBSERVATION: TurnObservation = { offeredTools: [], calls: [], emptyResponse: false, workerOperations: [] };

export function capText(text: string, limit = TURN_TEXT_LIMIT): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

export function turnRecordKeys(record: Pick<TurnRecord, "subject" | "receivedAt" | "eventId">) {
  const at = `${record.receivedAt}#${record.eventId}`;
  return {
    pk: `THREAD#${record.subject}`,
    sk: `TURN#${at}`,
    exportPk: TURN_EXPORT_PARTITION,
    exportSk: at,
    expiresAt: Math.floor(Date.parse(record.receivedAt) / 1000) + TURN_RETENTION_DAYS * 86_400,
  } as const;
}
