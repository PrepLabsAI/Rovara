// Task actions (owner decision 198): the owner's own words for a round they sent back to coding. A workflow decision keeps only the first 500 characters of a reason, but the instructions may be longer, and a
// finding's per-problem instructions are not in the decision at all. So the full words are kept beside the workflow, under the decision's request id, written in the same transaction as the move; the coding step
// reads them when it starts (`build-step/start.ts`). They are the owner's instructions, shown to the coder outside the untrusted problem tags.
import { INDEX_EXPIRY_ATTRIBUTE, when, type DocumentKey, type DocumentStore, type TransactItem } from "@agentx/contracts";

/** The words are kept this long (a task's records are not read after its end for much longer). */
const KEEP_SECONDS = 400 * 86_400;

export const ownerNoteKey = (taskId: string, requestId: string): DocumentKey => ({ pk: `DEVTASK#${taskId}`, sk: `OWNER_NOTE#${requestId}` });

/**
 * Where the round the decision started stands: the code it starts from and the program step it codes. A retry of that round (after its run failed or stopped) is at the same place; any later round is not
 * (a finished round leaves new code, a program's next build is another step, a fix after the pull request opened has its own source). Empty strings stand for none.
 */
export interface OwnerRoundPlace { candidateDigest: string; programStepId: string }

export const ownerRoundPlaceOf = (workflow: { candidate?: { digest: string } | undefined; programStepId?: string | undefined }): OwnerRoundPlace =>
  ({ candidateDigest: workflow.candidate?.digest ?? "", programStepId: workflow.programStepId ?? "" });

/** A findings answer keeps at most this many per-finding notes (the engine resolves at most `WORKFLOW_RESOLVE_FINDINGS_MAX` findings at once; this is a read bound too). */
export const FINDING_NOTES_MAX = 50;

/**
 * The step that keeps the words. Written once with the decision, so a note exists if and only if its decision does. `place` is where the round the decision started stands. `findingNotes` (a findings answer only) are the
 * person's own per-finding instructions, one entry per finding that has one, kept apart from `text` (which also holds code's fixed lead-in), so lessons can read the person's words and nothing else.
 */
export function ownerNoteItem(input: { taskId: string; requestId: string; text: string; now: Date; place?: OwnerRoundPlace; findingNotes?: readonly string[] }): TransactItem {
  return {
    kind: "put",
    item: {
      ...ownerNoteKey(input.taskId, input.requestId), entityType: "OWNER_NOTE", taskId: input.taskId, requestId: input.requestId, text: input.text,
      ...(input.findingNotes === undefined || input.findingNotes.length === 0 ? {} : { findingNotes: input.findingNotes.slice(0, FINDING_NOTES_MAX) }),
      ...(input.place === undefined ? {} : { candidateDigest: input.place.candidateDigest, programStepId: input.place.programStepId }),
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.now.getTime() / 1000) + KEEP_SECONDS,
    },
    condition: when.absent(),
  };
}

/** Where the round a decision started stands, as its note kept it; undefined when no note or no place was kept. */
export async function readOwnerRoundPlace(store: Pick<DocumentStore, "get">, taskId: string, requestId: string): Promise<OwnerRoundPlace | undefined> {
  const found = await store.get(ownerNoteKey(taskId, requestId));
  return typeof found?.["candidateDigest"] === "string" && typeof found["programStepId"] === "string" ? { candidateDigest: found["candidateDigest"], programStepId: found["programStepId"] } : undefined;
}

/** The words kept for a decision, or undefined (a decision made before notes were kept, or one with none). */
export async function readOwnerNote(store: Pick<DocumentStore, "get">, taskId: string, requestId: string): Promise<string | undefined> {
  const found = await store.get(ownerNoteKey(taskId, requestId));
  return typeof found?.["text"] === "string" ? found["text"] : undefined;
}

/**
 * The person's own per-finding instructions kept for a findings answer, in the order the problems were listed; empty when there were none (an answer from before they were kept, one whose findings had no note, or a row that
 * is not this decision's). Read at runtime: anything but a list of non-empty strings is "none". Never code's lead-in sentence and never the decision's summary.
 */
export async function readOwnerFindingNotes(store: Pick<DocumentStore, "get">, taskId: string, requestId: string): Promise<string[]> {
  const found = await store.get(ownerNoteKey(taskId, requestId));
  if (found === undefined || found["entityType"] !== "OWNER_NOTE" || found["taskId"] !== taskId || found["requestId"] !== requestId) return [];
  const notes = found["findingNotes"];
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is string => typeof note === "string" && note.trim() !== "").slice(0, FINDING_NOTES_MAX);
}
