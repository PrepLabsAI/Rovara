import { z } from "zod";

/**
 * ARGUARD: what makes the weekly renewal impossible to switch off silently. Two small rows beside the renewal lock, written by the renewal's own Lambda (and, for the first,
 * by the `requalify-schedule` deploy unit):
 *  - SCHEDULE_ENABLED: the daily schedule was enabled at least once. Written once, never rewritten. With it, a schedule found DISABLED later is an error, not a quiet state.
 *  - LAST_SUCCESS: the time of the last successful renewal, rewritten by each one.
 * The daily check turns them into one number, the age in days of the last success (or, before any success, of the first enable), and `RuntimeRequalifyStale` alarms on it.
 */

/** Same partition key as the lock, so the renewal Lambda's existing `RUNTIME_REQUALIFY*` state grant already covers both rows. */
export const requalifyScheduleEnabledKey = (profileId: string) => ({ pk: `RUNTIME_REQUALIFY#${profileId}`, sk: "SCHEDULE_ENABLED" });
export const requalifyLastSuccessKey = (profileId: string) => ({ pk: `RUNTIME_REQUALIFY#${profileId}`, sk: "LAST_SUCCESS" });

const ISO_MILLIS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
export const RequalifyScheduleEnabledSchema = z.object({ entityType: z.literal("RUNTIME_REQUALIFY_SCHEDULE_ENABLED"), at: ISO_MILLIS }).strict();
export const RequalifyLastSuccessSchema = z.object({ entityType: z.literal("RUNTIME_REQUALIFY_LAST_SUCCESS"), at: ISO_MILLIS, runId: z.string().uuid() }).strict();

/** The metric the daily check emits on every scheduled run: days since the last successful renewal (since the first enable until there is one). */
export const REQUALIFY_AGE_METRIC = "RequalifyAgeDays";
/** `RuntimeRequalifyStale` breaches at this age. The registration lasts seven days and a renewal starts three days before the end, so six means two missed days. */
export const REQUALIFY_STALE_AFTER_DAYS = 6;
