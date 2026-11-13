// Task actions (owner decision 198): the owner's own words for a round they sent back to coding. A workflow decision keeps only the first 500 characters of a reason, but the instructions may be longer, and a
// finding's per-problem instructions are not in the decision at all. So the full words are kept beside the workflow, under the decision's request id, written in the same transaction as the move; the coding step
// reads them when it starts (`build-step/start.ts`). They are the owner's instructions, shown to the coder outside the untrusted problem tags.
import { INDEX_EXPIRY_ATTRIBUTE, when, type DocumentKey, type DocumentStore, type TransactItem } from "@agentx/contracts";

/** The words are kept this long (a task's records are not read after its end for much longer). */
const KEEP_SECONDS = 400 * 86_400;

export const ownerNoteKey = (taskId: string, requestId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: `OWNER_NOTE#${requestId}` });

/** The step that keeps the words. Written once with the decision, so a note exists if and only if its decision does. */
export function ownerNoteItem(input: { taskId: string; requestId: string; text: string; now: Date }): TransactItem {
  return {
    kind: "put",
    item: { ...ownerNoteKey(input.taskId, input.requestId), entityType: "OWNER_NOTE", taskId: input.taskId, requestId: input.requestId, text: input.text, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.now.getTime() / 1000) + KEEP_SECONDS },
    condition: when.absent(),
  };
}

/** The words kept for a decision, or undefined (a decision made before notes were kept, or one with none). */
export async function readOwnerNote(store: Pick<DocumentStore, "get">, taskId: string, requestId: string): Promise<string | undefined> {
  const found = await store.get(ownerNoteKey(taskId, requestId));
  return typeof found?.["text"] === "string" ? found["text"] : undefined;
}
