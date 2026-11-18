// What a lesson that is gone for good leaves behind (lessons phase 4): when a lesson is withdrawn or purged (its source was deleted, or a person was erased), the team rule made from it is taken out of use and blanked, its draft check
// task is dropped and blanked and its claim is released. The rows are kept (a retired rule, a dismissed draft); only their use ends, at once. Idempotent: running it again finds nothing more to do, so a retried deletion finishes the work.
import type { DocumentStore } from "@agentx/contracts";
import { blankCheckDraft, draftIdFor, releaseClaim } from "./graduation-store.js";
import { retireTeamRulesFromLesson } from "./team-rules.js";
import type { ScopeKey } from "./store.js";

export function graduatedCleanup(documents: Pick<DocumentStore, "get" | "put" | "query" | "delete">, now: () => number): (key: ScopeKey, lessonId: string) => Promise<void> {
  return async (key, lessonId) => {
    const company = key.workspaceId;
    await retireTeamRulesFromLesson(documents, company, key.project, lessonId, now);
    await blankCheckDraft(documents, company, key.project, draftIdFor(key.workspaceId, key.project, lessonId));
    await releaseClaim(documents, company, key.project, lessonId);
  };
}
