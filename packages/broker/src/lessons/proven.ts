// The "proven" band (lessons architecture research Q5), ONE function for graduation (`graduate.ts`) and for skills (`skills.ts`). A lesson has proved itself when it is live and approved by a person (not on trial), was given
// to at least `PROVEN_TASKS` tasks (counted, never guessed: an uncounted lesson is not proven), is at least `PROVEN_DAYS` days old, was never marked wrong, nothing is open against it (a retire asked for, a contradiction, a
// possible duplicate, a failed citation), and two independent people stand behind it (or one person and a measured result). Pure.
//
// The numbers are lessons phases 1 and 2's (`scoring-settings.ts`), and "nothing against it" is read from their computed signals (`signals.ts`): a lesson with weight AGAINST it inside the evidence window (a person's direct
// mark, or a correction that came back although the lesson was loaded) or one UNDER QUESTION (a revert overlapped its area, its area is gone or rewritten) is in doubt, not proven. Signals that could not be read are "unreadable":
// a decision is never made on a guess, so such a lesson is not proven now.
import { hasStaleCitation } from "./load.js";
import { PROVEN_DAYS, PROVEN_TASKS } from "./scoring-settings.js";
import type { SignalsReader } from "./signals.js";
import type { ScopeKey } from "./store.js";
import { independentSources } from "./value.js";
import type { Lesson } from "./types.js";

export const PROVEN = { tasks: PROVEN_TASKS, days: PROVEN_DAYS } as const;
const DAY_MS = 86_400_000;

/** What phase 2 knows about ONE lesson: weight against it inside the evidence window, and whether it is under question. "unreadable": the project's signals could not be read now. */
export type ProvenSignal = { againstW: number; underQuestion: boolean } | "unreadable";

export interface ProvenInput {
  lesson: Lesson;
  /** The distinct tasks the lesson was given to (`countLessonUses`); undefined when it could not be counted. */
  tasks: number | undefined;
  now: number;
  /** Phase 2's marks for this lesson. Undefined only where no reader is wired (a test of the plain rule): the production paths always pass one. */
  signal?: ProvenSignal | undefined;
}
export type ProvenReader = (input: ProvenInput) => boolean;

export function provenLesson(input: ProvenInput): boolean {
  const { lesson, tasks, now, signal } = input;
  if (lesson.status !== "active" || lesson.trial !== undefined || lesson.reviewRequired === true || lesson.became !== undefined || lesson.promotedRuleId !== undefined) return false;
  if (lesson.approvals.length === 0 || lesson.provenance.audience.kind !== "project" || hasStaleCitation(lesson)) return false;
  if (lesson.counters.harmful > 0 || lesson.counters.citationStale > 0 || lesson.retireProposedAt !== undefined || lesson.possibleDuplicateOf !== undefined || lesson.contradictsWith !== undefined) return false;
  if (signal === "unreadable" || (signal !== undefined && (signal.underQuestion || !(signal.againstW <= 0)))) return false;
  if (tasks === undefined || tasks < PROVEN.tasks || now - lesson.createdAt < PROVEN.days * DAY_MS) return false;
  const people = independentSources(lesson.provenance);
  return people >= 2 || (people >= 1 && lesson.provenance.measured);
}

/**
 * Reads the project's signals once and answers for each lesson. A reader that gives nothing, or whose read stopped short (`truncated`: some rows were not looked at, so "nothing against it" is not known), makes every
 * lesson "unreadable". Another company's project is never asked (the reader checks the company itself).
 */
export async function provenSignalsOf(reader: SignalsReader, key: ScopeKey): Promise<(lessonId: string) => ProvenSignal> {
  const signals = await reader.read(key).catch(() => undefined);
  if (signals === undefined || signals.truncated) return () => "unreadable";
  return (lessonId) => ({ againstW: signals.evidence.get(lessonId)?.againstW ?? 0, underQuestion: signals.underQuestion.has(lessonId) });
}
