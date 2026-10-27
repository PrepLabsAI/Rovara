import { z } from "zod";
import { E2E_MODEL_CHANNEL_SCHEMA_VERSION } from "./e2e-model-channel.js";

/**
 * The session sync of the e2e model channel (MIDSTEPCOOKIE).
 *
 * The worker's credential scan must know every session value (a cookie, a token kept in local storage) the browser holds BEFORE each model call, not only at the start of an agent step. So
 * the executor sends a sync (`POST /v1/sync`) before every model call: the session values it has learned since the last acknowledged sync. The worker answers with a fresh random
 * `syncToken` (and its `epoch`, a random id of this proxy). The call then names that token (`syncToken` on the request). The worker keeps only the newest token and spends it on the next
 * `/v1/generate` request whatever that request is, so a call is served only under the sync that directly preceded it; a missing, older, unknown or already used token is refused with a fixed
 * code and the call never reaches the provider. The token is issued by the worker, so several executor clients (one for each shard of a group, all on one proxy) never share a counter
 * and cannot collide; each client simply syncs before each of its calls.
 *
 * Both parts are strict, so a part that predates this protocol cannot take part in it: an older worker refuses the unknown `syncToken` and `/v1/sync`, and a newer worker refuses an older
 * executor's call that names no sync. Neither runs a model call unprotected. The control plane also never dispatches an agent round to a worker that does not list the feature below.
 */

/** The worker feature string: the worker runs a proxy that requires the sync, and its executor image sends it. The broker dispatches an agent round only to a worker that lists it. */
export const E2E_MODEL_SESSION_SYNC_FEATURE = "task.workflowE2EMidStepSync.v1" as const;
/** The label the executor image carries when its model channel client syncs before every call. A worker lists the feature only while its executor image has it. */
export const E2E_EXECUTOR_SESSION_SYNC_IMAGE_LABEL = "io.rovara.e2e.session-sync" as const;
export const E2E_EXECUTOR_SESSION_SYNC_IMAGE_LABEL_VALUE = "v1" as const;

/** The path a sync is posted to, on the same socket as `/v1/generate` and `/v1/step`. */
export const E2E_MODEL_CHANNEL_SYNC_PATH = "/v1/sync" as const;
/** The most session values one sync carries; a longer delta is sent as several syncs. */
export const E2E_MODEL_SESSION_SYNC_MAX_VALUES = 32;
/** The longest value a sync carries. A longer value is sent as its first and last `E2E_MODEL_SESSION_SYNC_SLICE_CHARS` characters (see `boundSessionValue`). */
export const E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS = 4_096;
export const E2E_MODEL_SESSION_SYNC_SLICE_CHARS = 1_024;
/** The most bytes of one sync body; the proxy reads a marker of up to 262 144 bytes, so this leaves room. */
export const E2E_MODEL_SESSION_SYNC_MAX_BODY_BYTES = 200_000;
/**
 * What a run may teach the worker in all: values, and their UTF-8 bytes. Past either the sync is refused (`too-many-values`), so every later call is refused too (fail closed), rather
 * than the worker's memory and its scan of every prompt growing without bound.
 */
export const E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES = 512;
export const E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES = 65_536;

/** What the executor sends for one value: the value, or for one over the bound its head and its tail (any prompt that shows the whole value shows both). */
export function boundSessionValue(value: string): string[] {
  if (value.length <= E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS) return [value];
  return [value.slice(0, E2E_MODEL_SESSION_SYNC_SLICE_CHARS), value.slice(-E2E_MODEL_SESSION_SYNC_SLICE_CHARS)];
}

export const E2EModelSessionSyncSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  runId: z.string().uuid(),
  /** Session values (cookie values, tokens) the browser holds that the worker has not been told. May be empty: a sync is still the proof that the executor looked. */
  values: z.array(z.string().min(1).max(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS)).max(E2E_MODEL_SESSION_SYNC_MAX_VALUES),
}).strict();
export type E2EModelSessionSync = z.infer<typeof E2EModelSessionSyncSchema>;

export const E2E_MODEL_SESSION_SYNC_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
export const E2EModelSessionSyncReplySchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  status: z.literal("ok"),
  syncToken: z.string().regex(E2E_MODEL_SESSION_SYNC_TOKEN_PATTERN),
  /** A random id of this proxy. If it changes between two syncs, the proxy was replaced and the executor sends every value again. */
  epoch: z.string().regex(/^[a-f0-9]{16}$/),
}).strict();
export type E2EModelSessionSyncReply = z.infer<typeof E2EModelSessionSyncReplySchema>;

/** Why the worker refused a sync. Fixed codes; the executor never learns more. */
export const E2E_MODEL_SESSION_SYNC_REFUSAL_CODES = ["closing", "too-large", "unreadable", "not-json", "invalid-sync", "other-run", "too-many-values"] as const;
export type E2EModelSessionSyncRefusalCode = (typeof E2E_MODEL_SESSION_SYNC_REFUSAL_CODES)[number];

/** Why the worker refused a model call for its sync. They are the receipt's `refused-protocol` outcome with these fixed sentences, and nothing the executor sent is in them. */
export const E2E_MODEL_SESSION_SYNC_CALL_REFUSALS = Object.freeze({
  missing: "session-sync-missing: the request names no session sync",
  stale: "session-sync-stale: the request names a session sync that is not the newest, or that an earlier call already used",
} as const);
