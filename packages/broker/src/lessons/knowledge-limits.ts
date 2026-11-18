// Team knowledge read OUTSIDE Rovara (owner decisions 2026-11-17): the per-person limits. Counters hold numbers and unit ids, never text, keyed by company and person (and day):
//   KNOWLEDGE_READ_DAY       one row per person: the calls of the UTC day (a fixed window, `takeRate`); the 301st is refused
//   KNOWLEDGE_UNIT_DAY       one row per person, day, project and unit id served: written once (a conditional put), so a unit served twice counts once
//   KNOWLEDGE_DISTINCT_DAY   one row per person and day: how many distinct units were served, and whether the admin was already told (set once, by a conditional write, so two calls that cross together tell once)
// Every row expires on the store's own expiry attribute, which the CALLER names (this file does not write the attribute itself: the files that may are listed by the TTL guard test). The writes are best effort for
// the answer (a store fault never changes what is returned), but the call limit fails closed: a counter that cannot be read refuses the call.
import { LOCAL_KNOWLEDGE_DAY_CALLS_MAX, LOCAL_KNOWLEDGE_DISTINCT_ALERT, change, companyScoped, when, type DocumentStore } from "@agentx/contracts";
import { takeRate } from "../core/script-tokens/rate.js";

const DAY_MS = 86_400_000;

export interface KnowledgeLimitDeps {
  store: DocumentStore;
  now: () => number;
  /** The store's expiry attribute and the time a row written now expires (seconds since the epoch). */
  expiry: { attribute: string; expiresAt: (atMs: number) => number };
}
export interface KnowledgeLimits {
  /** Counts one call for the person and answers whether it is within the day's limit. A store fault throws (the caller refuses). */
  takeCall(companyId: string, developerId: string): Promise<boolean>;
  /** Counts the units an answer carried. `crossed` is true on the one call that took the person's distinct count above the alert line (once a day). */
  noteServed(input: { companyId: string; project: string; developerId: string; unitIds: readonly string[] }): Promise<{ distinct: number; crossed: boolean }>;
}

export function knowledgeLimits(deps: KnowledgeLimitDeps): KnowledgeLimits {
  const day = (): string => new Date(deps.now()).toISOString().slice(0, 10);
  const expires = (): Record<string, number> => Object.fromEntries([[deps.expiry.attribute, deps.expiry.expiresAt(deps.now())]]);
  return {
    takeCall: (companyId, developerId) => takeRate(deps.store, { pk: companyScoped(companyId, "KNOWLEDGE_READ_DAY"), sk: `${developerId}` }, LOCAL_KNOWLEDGE_DAY_CALLS_MAX, DAY_MS, deps.now),
    async noteServed({ companyId, project, developerId, unitIds }) {
      const today = day();
      const counter = { pk: companyScoped(companyId, "KNOWLEDGE_DISTINCT_DAY"), sk: `${today}#${developerId}` };
      let fresh = 0;
      for (const unitId of new Set(unitIds)) {
        const marker = await deps.store.put({
          item: { pk: companyScoped(companyId, "KNOWLEDGE_UNIT_DAY"), sk: `${today}#${developerId}#${project}#${unitId}`, entityType: "KNOWLEDGE_UNIT_DAY", day: today, ...expires() },
          condition: when.absent(),
        });
        if (marker.applied) fresh += 1;
      }
      const after = await deps.store.update({
        key: counter,
        ops: [change.set("entityType", "KNOWLEDGE_DISTINCT_DAY"), change.set("day", today), change.set(deps.expiry.attribute, deps.expiry.expiresAt(deps.now())), change.add("distinct", fresh)],
        return: "new",
      });
      const distinct = after.applied && typeof after.item?.["distinct"] === "number" ? after.item["distinct"] : 0;
      if (fresh === 0 || distinct <= LOCAL_KNOWLEDGE_DISTINCT_ALERT) return { distinct, crossed: false };
      // Told once a day: the first writer to find the line crossed and no "told" mark sets it; every other writer's condition fails.
      const told = await deps.store.update({ key: counter, ops: [change.set("alerted", true)], condition: when.and(when.gt("distinct", LOCAL_KNOWLEDGE_DISTINCT_ALERT), when.notExists("alerted")) });
      return { distinct, crossed: told.applied };
    },
  };
}
