// The words of the close refusals, in ONE place. Four different answers share status 409 and code WORKSPACE_BUSY, so a client can never tell them apart by the code: it matches the EXACT sentence
// (and the transient "try again" one is never final: it can follow effects). The Cloud close dialog, the retention lane and the MCP tool read these strings, and a test pins every byte
// (`tests/unit/core-close-words.test.ts` and the shared fixture `tests/fixtures/close-envelopes.json`).

/** The workspace holds a retained inspection: the person reviews the Close preview and closes with its digest. */
export const retainedCloseWords = (taskId: string): string => `This workspace is retained. Review the Close preview at /v1/dev/tasks/${taskId}/close before closing it.`;

/** A check for unpublished work is queued or already running; nothing was closed. */
export const CLOSE_CHECKING_WORDS = "Rovara is checking this task's workspace for unpublished work, so nothing was closed yet. Press Close again in a minute.";

/** No check can be started (an old worker, a session that cannot be proven empty, a running step, no provider): nothing was closed, and nothing is promised. */
export const CLOSE_CANNOT_CHECK_WORDS = "Rovara can't check this task's workspace for unpublished work, so nothing was closed. If this keeps happening, ask your admin for help.";

/** The close's own transaction lost a race (a dispatch or a session re-created between the read and the commit). NOT final: the outcome is unknown to a client that cannot see the task. */
export const CLOSE_TRY_AGAIN_WORDS = "Rovara could not close the task just now; try again";

/** The four 409 refusals a close can answer, by the reason the guard gives. */
export type CloseRefusalReason = "retained" | "checking" | "cannot_check";

export function closeRefusalWords(reason: CloseRefusalReason, taskId: string): string {
  switch (reason) {
    case "retained": return retainedCloseWords(taskId);
    case "checking": return CLOSE_CHECKING_WORDS;
    case "cannot_check": return CLOSE_CANNOT_CHECK_WORDS;
  }
}
