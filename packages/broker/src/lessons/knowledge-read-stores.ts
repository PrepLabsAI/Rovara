// The day counter and per-person day limits of team knowledge read outside Rovara, over one company's store. Moved out of `local/app/lessons-routes.ts` so the hosted knowledge API
// (`core-host/knowledge-api.ts`) does not import the laptop's lesson routes (issue #1538). The store's expiry attribute is named here (the TTL guard test lists this file).
import { INDEX_EXPIRY_ATTRIBUTE, change, companyScoped, indexExpiresAt, type DocumentStore } from "@agentx/contracts";
import type { LocalToolsCounter } from "./local-tools.js";
import { knowledgeLimits, type KnowledgeLimits } from "./knowledge-limits.js";

/** The day's counter row: fixed numbers per person, project and day, expired by the store's index retention. Best effort: a failure to count never blocks or changes the answer. */
export function localLessonsDayCounter(store: DocumentStore, now: () => number): LocalToolsCounter {
  return {
    async count(event) {
      const day = new Date(now()).toISOString().slice(0, 10);
      const refused = event.refusal === undefined ? undefined : `refused_${event.refusal.replace(/[^a-z_]/gu, "").slice(0, 40)}`;
      await store.update({
        key: { pk: companyScoped(event.orgId, "LESSON_LOCAL_DAY"), sk: `${event.project}#${event.developerId}#${day}` },
        ops: [
          change.set("entityType", "LESSON_LOCAL_DAY"), change.set("day", day), change.set(INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt(new Date(now()).toISOString())),
          change.add("calls", 1), change.add("lessonsReturned", event.lessons), ...(refused === undefined ? [] : [change.add(refused, 1)]),
        ],
      });
    },
  };
}
/**
 * The per-person day limits and the day counter of team knowledge read outside Rovara, over one company's store. The store's expiry attribute is named HERE, where it is allowed (the TTL guard test lists this file), and
 * handed to the limits; the laptop's lesson routes (`local/app/lessons-routes.ts`) and the hosted twin (`core-host/knowledge-api.ts`) both build theirs from this, so neither names the attribute itself.
 */
export function knowledgeReadStores(store: DocumentStore, now: () => number): { limits: KnowledgeLimits; counter: LocalToolsCounter } {
  return {
    counter: localLessonsDayCounter(store, now),
    limits: knowledgeLimits({ store, now, expiry: { attribute: INDEX_EXPIRY_ATTRIBUTE, expiresAt: (atMs) => indexExpiresAt(new Date(atMs).toISOString()) } }),
  };
}
