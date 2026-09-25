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
