// Setup and test health SH26: what the project's Environment panel reads and sends for the project's saved environment image. Strict shapes for the route `/v1/app/projects/{name}/environment-image`; the readers keep fields a
// newer server adds. Only fixed words, counts and times: no digest, no repository name, no command, no secret. The server decides who may Reset (a maintainer of the project) and says so in `canReset`.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

export const SAVED_ENV_PANEL_REBUILD_REASONS = ["no_image", "key_changed", "max_age", "stale", "reset"] as const;
export const SavedEnvPanelReasonSchema = z.enum(SAVED_ENV_PANEL_REBUILD_REASONS);
export type SavedEnvPanelReason = z.infer<typeof SavedEnvPanelReasonSchema>;

/** The words a failed build may be shown as. The server maps anything else to "failed", so no text of a builder, a log or a person reaches the page. */
export const SAVED_ENV_PANEL_FAILURES = [
  "not_proved", "not_approved", "not_fresh", "not_default_branch", "secrets_found", "unsafe_tree", "no_push_session", "build_failed", "push_failed", "digest_mismatch", "base_not_pinned", "prove_failed", "fresh_sandbox_failed",
  "wrong_commits", "wrong_manifest", "wrong_repository", "repository_mismatch", "failed",
] as const;
export const SavedEnvPanelFailureSchema = z.enum(SAVED_ENV_PANEL_FAILURES);

export const SavedEnvPanelSchema = z.object({
  /** "never_proved": no passing Prove yet; "healthy": a ready image; "needs_repair": the last build failed or the image is gone. */
  health: z.enum(["never_proved", "healthy", "needs_repair"]),
  /** Each of the four below is left out when there is nothing to say. The newest image, when there is one. `ageDays` is whole days. `stale`: a task fell back from it and a rebuild is due. */
  image: z.object({ builtAt: z.string().datetime(), ageDays: z.number().int().min(0), status: z.enum(["ready", "stale"]) }).strict().optional(),
  /** A rebuild that is waiting or running now, and why. */
  rebuild: z.object({ state: z.enum(["queued", "running"]), reason: SavedEnvPanelReasonSchema }).strict().optional(),
  /** Why the last rebuild was queued. */
  lastRebuildReason: SavedEnvPanelReasonSchema.optional(),
  /** The last build that failed, as a fixed word, and when. Cleared by the next one that works. */
  lastFailure: z.object({ at: z.string().datetime(), reason: SavedEnvPanelFailureSchema }).strict().optional(),
  /** The caller may press Reset (a maintainer of the project). */
  canReset: z.boolean(),
  /** SV-1l: the project's own on/off setting (`savedEnv.enabled`, on until a maintainer turns it off). Off: no saved copy is built or used, and every task sets up fresh. Left out by an older server. */
  enabled: z.boolean().optional(),
  /** SV-1l: the caller may turn the setting on or off (a maintainer of the project). The server checks the role again on every change; this only says whether to offer the control. */
  canChangeSetting: z.boolean().optional(),
}).strict();
export type SavedEnvPanel = z.infer<typeof SavedEnvPanelSchema>;
export const SavedEnvPanelReaderSchema = forwardReader(SavedEnvPanelSchema);

export const SavedEnvResetBodySchema = z.object({ action: z.literal("reset"), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u) }).strict();
export type SavedEnvResetBody = z.infer<typeof SavedEnvResetBodySchema>;
/**
 * `queued`: a rebuild is now waiting (also the answer to the same press sent again); `in_flight`: one is already waiting or running, so nothing was written; `cooldown`: a Reset was asked less than 15 minutes ago;
 * `nothing_to_do`: no approved environment, no code to build from, or the project is archived or turned off (the panel says which by what it shows).
 */
export const SavedEnvResetAnswerSchema = z.object({ status: z.enum(["queued", "in_flight", "cooldown", "nothing_to_do"]), panel: SavedEnvPanelSchema }).strict();
export const SavedEnvResetAnswerReaderSchema = forwardReader(SavedEnvResetAnswerSchema);

/** SV-1l: the body of `PUT /v1/app/projects/{name}/environment-image/setting`, and its answer (`changed` is false when the project already had that value; nothing is written then). */
export const SavedEnvSettingBodySchema = z.object({ enabled: z.boolean() }).strict();
export type SavedEnvSettingBody = z.infer<typeof SavedEnvSettingBodySchema>;
export const SavedEnvSettingAnswerSchema = z.object({ enabled: z.boolean(), changed: z.boolean() }).strict();
export const SavedEnvSettingAnswerReaderSchema = forwardReader(SavedEnvSettingAnswerSchema);
