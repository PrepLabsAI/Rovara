// What the reflector needs about a finished task beyond the task's own record: who sent it back, and who reverted it. A hosted install reads these from the rows its team record keeps; Code reads them from its own
// records (`local-sources.ts`: the workflow's decision history, and the row the revert detector writes). A send-back without a person is not a measured outcome: only a send-back by a member who is not the task's
// requester counts. Internal reads: the audience of the lesson is the subject's, set by the caller, not by this read.
import type { SendBackFact } from "./task-subject.js";

export interface OutcomeRowReader {
  sendBack(input: { workspaceId: string; project: string; taskId: string; requestId: string }): Promise<SendBackFact | undefined>;
  /** The person who reverted the change. `{}` when a revert is recorded but names no member; undefined when there is no such record. */
  revertedBy(input: { workspaceId: string; project: string; taskId: string }): Promise<{ actorDeveloperId?: string } | undefined>;
}

/** The tasks of one project whose change was reverted since a time (ids only). `truncated`: the project had more than the read allows. */
export interface RevertedTasksReader {
  since(workspaceId: string, project: string, sinceMs: number): Promise<{ taskIds: string[]; truncated: boolean }>;
}

export const MAX_REVERT_PAGES = 30;
export const REVERT_PAGE_ROWS = 500;
