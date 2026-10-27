import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { REQUALIFY_AGE_METRIC } from "@agentx/contracts";
import { renewalAgeDays } from "./runtime-requalify-heartbeat.js";

/**
 * ARGUARD: the sessions reconciler runs every 10 minutes whether or not the renewal's daily schedule is on, so it carries the age of the last successful renewal to `RuntimeRequalifyStale`.
 * A schedule switched off after it was enabled then still ends in the alarm after six days. Nothing is reported until the schedule was enabled once (the renewal's own record says so), so an
 * installation without the renewal, or one that never switched it on, is unchanged. The reconciler already reads and writes the state table; no grant is added.
 */

/** The reader the handler wires; reads two rows by key. */
export const readRenewalAgeDays = (documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, now: Date): Promise<number | undefined> =>
  renewalAgeDays({ documentClient, tableName }, now.getTime());

/** The metrics to add to the reconciler's run. Never throws: an unreadable record is counted (`ReconcilerRenewalAgeReadFailures`) and logged by error name only. Empty where the reader is not wired. */
export async function renewalAgeMetrics(
  read: ((now: Date) => Promise<number | undefined>) | undefined, now: Date, log: (entry: Record<string, unknown>) => void,
): Promise<Record<string, number>> {
  if (read === undefined) return {};
  try {
    const days = await read(now);
    return days === undefined ? {} : { [REQUALIFY_AGE_METRIC]: days, ReconcilerRenewalAgeReadFailures: 0 };
  } catch (error) {
    log({ event: "reconciler.renewal_age_unreadable", errorName: error instanceof Error ? error.name : "unknown" });
    return { ReconcilerRenewalAgeReadFailures: 1 };
  }
}
