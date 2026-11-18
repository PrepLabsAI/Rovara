// The per-person start box suggestion limit (lead 4, L4-HC): at most `START_SUGGESTS_PER_PERSON_PER_HOUR` classifier calls one person causes on one project in an hour. A STORED counter, one row per company,
// project, person and hour, taken with a conditional write, so two requests at the same moment (on any number of instances) cannot both take the last place. Fails closed: a counter that cannot be read or
// written is no place. The company is the partition, so another company's person with the same id has their own counter. Expiry is the app's: the person's next take on the project removes their counters of
// earlier hours (no table expiry attribute).
import { START_SUGGESTS_PER_PERSON_PER_HOUR, startSuggestRateKey, startSuggestRatePartition, startSuggestRatePrefix, when, type DocumentStore, type OrgId } from "@agentx/contracts";

const HOUR_MS = 3_600_000;

export interface StartSuggestRate {
  /** Takes one place for the person on the project now: true when there was room. Throws when the counter cannot be written (or the names are not ids). */
  take(project: string, personId: string): Promise<boolean>;
}

export function createStartSuggestRate(input: { store: DocumentStore; companyId: OrgId; now: () => number; limit?: number | undefined }): StartSuggestRate {
  // Can only be lowered: no caller can raise the placeholder.
  const limit = Math.min(START_SUGGESTS_PER_PERSON_PER_HOUR, input.limit ?? START_SUGGESTS_PER_PERSON_PER_HOUR);
  const sweep = async (project: string, personId: string, window: number): Promise<void> => {
    const page = await input.store.query({ pk: startSuggestRatePartition(input.companyId), sk: { op: "beginsWith", prefix: startSuggestRatePrefix(project, personId) }, limit: 10 });
    for (const item of page.items) if (Number(item.sk.slice(item.sk.lastIndexOf("#") + 1)) < window) await input.store.delete({ key: item });
  };
  return {
    async take(project, personId) {
      const window = Math.floor(input.now() / HOUR_MS) * HOUR_MS;
      const result = await input.store.update({
        key: startSuggestRateKey(input.companyId, project, personId, window),
        ops: [
          { op: "add", path: ["count"], amount: 1 },
          { op: "set", path: ["entityType"], value: "START_SUGGEST_RATE" },
          { op: "set", path: ["orgId"], value: input.companyId },
          { op: "set", path: ["windowStart"], value: window },
        ],
        condition: when.or(when.absent(), when.lt("count", limit)),
      });
      // Earlier hours' counters are of no use any more: removed here, a few at a time, never failing the suggestion.
      if (result.applied) await sweep(project, personId, window).catch(() => undefined);
      return result.applied;
    },
  };
}
