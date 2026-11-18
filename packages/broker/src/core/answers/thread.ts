// Thread memory (lead 4, J1): a thread is one conversation. The last `ANSWER_THREAD_TURNS` turns are kept for `ANSWER_THREAD_HOURS` after the last message, so a follow-up ("and partial refunds?") needs no new
// context. The words live in the answer records (W2: 30 days, app-driven expiry, erased with their asker); the thread row holds only the ids of those records and when the thread was last used. A person's
// thread id is hashed with the person (`answerThreadKey`), so another person who guesses the id reads a different, empty thread. Every row is in the project's own partition.
import { ANSWER_THREAD_HOURS, ANSWER_THREAD_TURNS, answerThreadKey, type DocumentStore, type OrgId, type WikiAnswerRecord, type WikiStore } from "@agentx/contracts";
import { z } from "zod";

const Row = z.object({ entityType: z.literal("WIKI_THREAD"), orgId: z.string(), project: z.string(), answerIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u)).max(ANSWER_THREAD_TURNS), expiresAt: z.number().int() });

export interface ThreadTurn { answerId: string; record: WikiAnswerRecord }

export interface AnswerThreads {
  /** The earlier turns of the thread, oldest first (those whose records are still there). Empty for a thread that is new, expired, or not this person's. */
  turns(project: string, threadId: string, scope: { personId: string } | "shared"): Promise<ThreadTurn[]>;
  /** Adds an answer to the thread (the last turns only are kept) and renews its 24 hours. */
  add(project: string, threadId: string, scope: { personId: string } | "shared", answerId: string): Promise<void>;
}

export function createAnswerThreads(input: { store: DocumentStore; wiki: Pick<WikiStore, "readAnswer">; companyId: OrgId; now: () => number }): AnswerThreads {
  const rowOf = async (project: string, threadId: string, scope: { personId: string } | "shared"): Promise<{ key: { pk: string; sk: string }; ids: string[] }> => {
    const key = answerThreadKey(input.companyId, project, threadId, scope);
    const item = await input.store.get(key);
    const parsed = item === undefined ? undefined : Row.safeParse(item);
    // A row naming another company or project (it cannot be, by key) or past its time reads as an empty thread.
    if (parsed !== undefined && parsed.success && parsed.data.orgId === input.companyId && parsed.data.project === project && parsed.data.expiresAt * 1000 <= input.now()) await input.store.delete({ key }).catch(() => undefined);
    if (parsed === undefined || !parsed.success || parsed.data.orgId !== input.companyId || parsed.data.project !== project || parsed.data.expiresAt * 1000 <= input.now()) return { key, ids: [] };
    return { key, ids: parsed.data.answerIds };
  };
  return {
    async turns(project, threadId, scope) {
      const { ids } = await rowOf(project, threadId, scope);
      const turns: ThreadTurn[] = [];
      for (const answerId of ids) {
        const record = await input.wiki.readAnswer(project, answerId);
        if (record !== undefined) turns.push({ answerId, record });
      }
      return turns;
    },
    async add(project, threadId, scope, answerId) {
      const { key, ids } = await rowOf(project, threadId, scope);
      const answerIds = [...ids.filter((id) => id !== answerId), answerId].slice(-ANSWER_THREAD_TURNS);
      const expiresAt = Math.floor(input.now() / 1000) + ANSWER_THREAD_HOURS * 3_600;
      // The row holds only ids; a read treats it as gone from `expiresAt` on, and the next use of an expired thread (or the project's wiki delete, or the company purge) removes it.
      await input.store.put({ item: { ...key, entityType: "WIKI_THREAD", orgId: input.companyId, project, answerIds, expiresAt } });
    },
  };
}
