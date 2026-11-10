// The reflector's subject for a finished task, built from the REAL sources of who did what. `isMeasured` (reflect.ts) counts a send-back or a revert
// only when its actor is known and is neither a lesson author nor the person who started the task, so nothing measured ever counted until a subject carried those ids. This is the
// one place that fills them in:
//   - `initiatorId`: the person who started the task. It comes from the TASK RECORD (`startedBy`, set by the task start), not from a Team record row, so no extra
//     copy of a person's id is stored for it.
//   - `revertedBy`: the person who reverted the change, from the actor on the task's `rovara.reverted_by` person-link row (the revert detector). The revert's
//     OUTCOME rows carry no person; a bot, an outsider, an erased or unknown account has no link row, so the revert has no person and does not count.
//   - A send_back that a lesson cites as a span makes its sender an AUTHOR of that lesson (`reflect.ts`: authors are the member authors of the spans the lesson cites), so that
//     send-back is not independent of the lesson and is not a measured outcome for it. Only send-backs the lesson does not cite count.
//   - each human send-back becomes a `send_back` span whose `authorId` is the person who sent the task back (the actor on its `rovara.send_back` row).
// Every id is a canonical developer id (the identity-linked id, never a Slack or GitHub account), trimmed. A missing id stays missing: the outcome is then not measured.
import type { EvidenceSpan, ReflectSubject } from "./reflect-input.js";
import type { TrustClass } from "./types.js";

/** The part of a task record (`DeveloperTaskRecord`) that says who started it. Structural, so this package does not import the broker's record type. */
export interface TaskStartSource {
  /** The task's creator (the caller who made the record). */
  developerId: string;
  /** Set when the task was prepared as an agent run: the person who pressed Start (or, for a trigger, the member whose act started it). */
  startedBy?: { developerId: string } | undefined;
  /** Set exactly when the task was prepared as an agent run. A task from before agent runs has neither `agent` nor `startedBy`, and its creator is who started it. */
  agent?: unknown;
}

const idOf = (id: string | undefined): string | undefined => {
  const trimmed = id?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Who started the task. A prepared agent run records `startedBy`; when it has none (an autonomous run, or a trigger that no member started) nobody is named, because the creator
 * of such a record is not a person who decided to start it. Only a task that was never prepared as an agent run (no `agent`) falls back to its creator, who started it by hand.
 */
export function taskStartActor(task: TaskStartSource): string | undefined {
  if (task.startedBy !== undefined) return idOf(task.startedBy.developerId);
  return task.agent === undefined ? idOf(task.developerId) : undefined;
}

export interface SendBackFact {
  /** The send-back's id (its row's source id): becomes the span's evidence id. */
  id: string;
  origin: "human" | "automatic";
  /** The person who sent the task back (the actor on the row). Absent for an automatic send-back or an unresolved account. */
  actorDeveloperId?: string | undefined;
  /** The actor's standing in the project; anything but "member" keeps the span out of the lesson (an outsider's words are removed before any model call). */
  actorTrust?: TrustClass | undefined;
  reasonText?: string | undefined;
}

export interface TaskSubjectFacts {
  workspaceId: string;
  project: string;
  taskId: string;
  repositories: readonly string[];
  baseCommit?: string | undefined;
  mergedCommit?: string | undefined;
  outcome?: ReflectSubject["outcome"] | undefined;
  /** The task record's start fields. */
  task: TaskStartSource;
  /** The actor of the task's `rovara.reverted_by` person-link row, when the task's change was reverted. */
  revert?: { actorDeveloperId?: string | undefined } | undefined;
  sendBacks: readonly SendBackFact[];
  /** The rest of the subject, as the caller worked it out (trusts, links, audience, the other spans). Nothing here may set `initiatorId` or `revertedBy`. */
  rest: Omit<ReflectSubject, "kind" | "id" | "workspaceId" | "project" | "repositories" | "baseCommit" | "mergedCommit" | "outcome" | "initiatorId" | "revertedBy" | "spans"> & { spans?: readonly EvidenceSpan[] };
}

/** What the span says when a person sent the task back and gave no reason. Fixed text, chosen by code. */
export const NO_REASON_TEXT = "The task was sent back to the agent without a reason.";

/** The reflector's subject for a finished task. Pure. */
export function buildTaskReflectSubject(facts: TaskSubjectFacts): ReflectSubject {
  const initiatorId = taskStartActor(facts.task);
  // A revert is a measured outcome only for a task that ended reverted: a person named on a revert row of a task that is not reverted counts for nothing.
  const revertedBy = facts.outcome === "reverted" ? idOf(facts.revert?.actorDeveloperId) : undefined;
  const sendBackSpans: EvidenceSpan[] = facts.sendBacks.flatMap((back) => {
    // An automatic send-back carries a fixed code, no person and no words: it is structured data about the run, not evidence a person gave.
    if (back.origin !== "human") return [];
    const authorId = idOf(back.actorDeveloperId);
    const reason = back.reasonText?.trim();
    return [{
      kind: "send_back" as const, text: reason === undefined || reason === "" ? NO_REASON_TEXT : reason,
      // Unknown standing is an outsider's: its words are removed, and it never counts for a lesson.
      trust: authorId === undefined ? "outsider" as const : back.actorTrust ?? "outsider",
      eventId: back.id, ...(authorId === undefined ? {} : { authorId }),
      // The fixed sentence is code's, not the person's: it is never a correction a lesson can rest on (the trial rule reads this).
      ...(reason === undefined || reason === "" ? { fixedText: true as const } : {}),
    }];
  });
  // The caller's own `initiatorId` / `revertedBy` / `kind` / `id` (a field the type forbids but a cast could smuggle in) never reach the subject: only the ones computed above do.
  const rest: Record<string, unknown> = { ...facts.rest };
  for (const forbidden of ["initiatorId", "revertedBy", "kind", "id", "workspaceId", "project", "repositories", "baseCommit", "mergedCommit", "outcome", "spans"]) delete rest[forbidden];
  return {
    ...(rest as Omit<ReflectSubject, "kind" | "id" | "workspaceId" | "project" | "repositories" | "spans">),
    kind: "task", id: facts.taskId, workspaceId: facts.workspaceId, project: facts.project, repositories: facts.repositories,
    ...(facts.baseCommit === undefined ? {} : { baseCommit: facts.baseCommit }), ...(facts.mergedCommit === undefined ? {} : { mergedCommit: facts.mergedCommit }),
    ...(facts.outcome === undefined ? {} : { outcome: facts.outcome }),
    ...(initiatorId === undefined ? {} : { initiatorId }), ...(revertedBy === undefined ? {} : { revertedBy }),
    spans: [...(facts.rest.spans ?? []), ...sendBackSpans],
  };
}
