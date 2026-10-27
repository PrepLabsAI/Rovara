import { z } from "zod";
import { E2E_MODEL_CHANNEL_SCHEMA_VERSION } from "./e2e-model-channel.js";

/**
 * The session sync of the e2e model channel (MIDSTEPCOOKIE).
 *
 * The worker's credential scan must know every session value (a cookie, a local storage token) the browser holds BEFORE each model call, not only at the start of an agent step. So the
 * executor sends a sync (`POST /v1/sync`) before every model call: a strictly increasing sequence number and the session values it has learned since the last acknowledged sync. The call
 * then names the sequence it was made under (`syncSeq` on the request). The worker refuses a call that names no sync, a sync that is not the newest, or one an earlier call already used,
 * with a fixed code, and never sends it to the provider.
 *
 * Both parts are strict, so a part that predates this protocol cannot take part in it: an older worker refuses the unknown `syncSeq` and `/v1/sync`, and a newer worker refuses an older
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
/** The most session values a run may teach the worker in all. Past it the sync is refused, so a call is refused too (fail closed), rather than the scan growing without bound. */
export const E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES = 2_048;
export const E2E_MODEL_SESSION_SYNC_MAX_SEQ = 2_147_483_647;

export const E2EModelSessionSyncSchema = z.object({
  schemaVersion: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
  runId: z.string().uuid(),
  syncSeq: z.number().int().min(1).max(E2E_MODEL_SESSION_SYNC_MAX_SEQ),
  /** Session values (cookie values, tokens) the browser holds that the worker has not been told. May be empty: a sync is still the proof that the executor looked. */
  values: z.array(z.string().min(1).max(4_096)).max(E2E_MODEL_SESSION_SYNC_MAX_VALUES),
}).strict();
export type E2EModelSessionSync = z.infer<typeof E2EModelSessionSyncSchema>;

/** Why the worker refused a sync. Fixed codes; the executor never learns more. */
export const E2E_MODEL_SESSION_SYNC_REFUSAL_CODES = ["closing", "too-large", "unreadable", "not-json", "invalid-sync", "other-run", "stale-sync", "too-many-values"] as const;
export type E2EModelSessionSyncRefusalCode = (typeof E2E_MODEL_SESSION_SYNC_REFUSAL_CODES)[number];

/** Why the worker refused a model call for its sync. They are the receipt's `refused-protocol` outcome with these fixed sentences, and nothing the executor sent is in them. */
export const E2E_MODEL_SESSION_SYNC_CALL_REFUSALS = Object.freeze({
  missing: "session-sync-missing: the request names no session sync",
  stale: "session-sync-stale: the request names a session sync that is not the newest, or that an earlier call already used",
} as const);
