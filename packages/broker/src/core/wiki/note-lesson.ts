// Lead 4 C1 (DEC 254zh/254zi): "Suggest as a lesson" for a wiki note that reads like a rule. There is no route that proposes a lesson (lessons are only ever learned), so this is the one seam that
// does: it writes ONE lesson, status `pending`, with `reviewRequired`, and nothing else. It is never approved here, never on trial, never applied: the lessons library's own approval (the existing
// approve route and its rules about who may decide) is the only way it goes live.
//
//  - The text is cleaned and screened exactly as an edit at approval is (`cleanForLearning`, `requestsCapabilityChange`); a note that asks for a change of tools, permissions, budgets or approvals is refused.
//  - The lesson's id comes from the company, the project and the note, so suggesting the same note twice is the same lesson (`already_proposed`), never a second card.
//  - The project's learning mode must allow lessons (not Off); the install's lessons switch is checked by the caller (`lessonsOf(company)` is undefined where it is off).
//  - The company and the project come from the caller's live membership (the route), never from the note.
import { createHash } from "node:crypto";
import type { OrgId } from "@agentx/contracts";
import { WIKI_LESSON_BODY_MAX } from "@agentx/contracts";
import { firstExpiry, pendingExpiry } from "../../lessons/expiry.js";
import { cleanForLearning, requestsCapabilityChange } from "../../lessons/guards.js";
import { emitAudit, modeAllows, resolveLearning, type LearningSettingsReader } from "../../lessons/policy.js";
import type { LessonAuditSink } from "../../lessons/ports.js";
import type { LessonStore } from "../../lessons/store.js";
import { LessonSchema, type Lesson } from "../../lessons/types.js";

export interface WikiNoteLessonInput {
  companyId: OrgId;
  project: string;
  noteId: string;
  /** The person who wrote the note (the lesson names them as its author, so erasing them deletes it). */
  authorId: string;
  text: string;
  /** The file the note is tied to; it becomes the lesson's scope. */
  file?: { repo: string; path: string } | undefined;
}
export type WikiNoteLessonResult =
  | { state: "proposed" | "already_proposed"; lessonId: string }
  | { state: "off" | "too_long" | "refused" };

export interface WikiNoteLessonDeps {
  store: LessonStore;
  settings: LearningSettingsReader;
  audit: LessonAuditSink;
  now: () => number;
}

/** The lesson id for a note: the same note in the same project and company is always the same lesson. */
export const lessonIdOfNote = (companyId: string, project: string, noteId: string): string =>
  `wn_${createHash("sha256").update(`wiki-note-lesson\u0000${companyId}\u0000${project}\u0000${noteId}`).digest("hex").slice(0, 24)}`;

const firstLine = (text: string, max: number): string => {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? text;
  const points = [...line];
  return points.length <= max ? line : `${points.slice(0, max - 1).join("").trimEnd()}.`;
};

/** Writes the pending lesson for a note. Throws when the lessons store cannot be read or written (the route then answers its fixed "try again"). */
export async function proposeLessonFromNote(deps: WikiNoteLessonDeps, input: WikiNoteLessonInput): Promise<WikiNoteLessonResult> {
  const key = { workspaceId: input.companyId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return { state: "off" };
  const body = cleanForLearning(input.text, WIKI_LESSON_BODY_MAX + 1);
  if ([...body].length > WIKI_LESSON_BODY_MAX) return { state: "too_long" };
  const title = cleanForLearning(firstLine(input.text, 80), 80);
  if (body === "" || title === "" || requestsCapabilityChange(title, body)) return { state: "refused" };
  const id = lessonIdOfNote(input.companyId, input.project, input.noteId);
  if ((await deps.store.getHead(key, id)) !== undefined) return { state: "already_proposed", lessonId: id };

  const now = deps.now();
  const lesson: Lesson = LessonSchema.parse({
    id, version: 1, workspaceId: key.workspaceId, project: key.project,
    scope: input.file === undefined ? {} : { repos: [input.file.repo], paths: [input.file.path] },
    type: "convention", stages: ["PLAN", "IMPLEMENT", "REVIEW"],
    title, description: "", body, citations: [],
    // A person's own words, from a note a person wrote: member trust, a strong signal, but NOT a "member correction" (nothing here lets it go live on trial) and not proved against any code.
    provenance: {
      sourceEvents: [], sourceKinds: [], authors: [input.authorId], supportTasks: [], sources: [`member:${input.authorId}`], inputSources: [`member:${input.authorId}`], measured: false,
      minTrust: "member", audience: { kind: "project" }, reflectorRun: "wiki-note", model: "none", memberSignal: true,
    },
    tier: 1, tierReasons: ["wiki_note"], status: "pending", reviewRequired: true, pendingExpiresAt: pendingExpiry(now),
    counters: { loaded: 0, helpful: 0, harmful: 0, citationStale: 0 }, staleAt: [], expiresAt: firstExpiry("convention", now, resolved.expiryDays), approvals: [], createdAt: now, updatedAt: now,
  });
  const setVersion = await deps.store.setVersion(key);
  const written = await deps.store.commit(key, setVersion, [lesson], now);
  if (!written.ok) {
    // A lost race: if it was the same note suggested at the same moment, the lesson is there now.
    if ((await deps.store.getHead(key, id)) !== undefined) return { state: "already_proposed", lessonId: id };
    throw new Error("the lesson could not be written");
  }
  await emitAudit(deps.audit, { action: "lesson.candidate_created", workspaceId: key.workspaceId, project: key.project, lessonId: id, actor: input.authorId, facts: { type: "convention" } });
  return { state: "proposed", lessonId: id };
}
