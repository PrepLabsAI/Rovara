// The per-person answer limit (lead 4, J1): at most `ANSWERS_PER_PERSON_PER_HOUR` answers a person asks in an hour across the company's projects. One counter row per person and hour, taken with a
// conditional write, so two answers asked at the same moment cannot both take the last place. Fails closed: a counter that cannot be read or written is no place.
import { ANSWERS_PER_PERSON_PER_HOUR, answerRateKey, answerRatePartition, type DocumentStore, type OrgId } from "@agentx/contracts";
import { when } from "@agentx/contracts";

const HOUR_MS = 3_600_000;

export interface AnswerRate {
  /** Takes one place for the person now: true when there was room. Throws when the counter cannot be written. */
  take(personId: string): Promise<boolean>;
  /** Gives a place back (an answer that never reached the model). Best effort. */
  give(personId: string): Promise<void>;
}

export function createAnswerRate(input: { store: DocumentStore; companyId: OrgId; now: () => number; limit?: number | undefined }): AnswerRate {
  // Can only be lowered: no caller can raise the placeholder.
  const limit = Math.min(ANSWERS_PER_PERSON_PER_HOUR, input.limit ?? ANSWERS_PER_PERSON_PER_HOUR);
  const windowOf = (): number => Math.floor(input.now() / HOUR_MS) * HOUR_MS;
  const sweep = async (personId: string, window: number): Promise<void> => {
    const prefix = answerRateKey(input.companyId, personId, 0).sk.replace(/0$/u, "");
    const page = await input.store.query({ pk: answerRatePartition(input.companyId), sk: { op: "beginsWith", prefix }, limit: 10 });
    for (const item of page.items) if (Number(item.sk.slice(item.sk.lastIndexOf("#") + 1)) < window) await input.store.delete({ key: item });
  };
  return {
    async take(personId) {
      const window = windowOf();
      const key = answerRateKey(input.companyId, personId, window);
      const result = await input.store.update({
        key,
        ops: [
          { op: "add", path: ["count"], amount: 1 },
          { op: "set", path: ["entityType"], value: "ANSWER_RATE" },
          { op: "set", path: ["orgId"], value: input.companyId },
          { op: "set", path: ["windowStart"], value: window },
        ],
        condition: when.or(when.absent(), when.lt("count", limit)),
      });
      // The person's counters of earlier hours are of no use any more: they are removed here (a few at a time, never failing the answer), so no counter outlives its hour by more than the person's next answer.
      if (result.applied) await sweep(personId, window).catch(() => undefined);
      return result.applied;
    },
    async give(personId) {
      const window = windowOf();
      await input.store.update({ key: answerRateKey(input.companyId, personId, window), ops: [{ op: "add", path: ["count"], amount: -1 }], condition: when.gt("count", 0) }).catch(() => undefined);
    },
  };
}
