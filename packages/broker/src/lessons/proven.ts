// The "proven" band for graduation (lessons phase 4, research doc Q5; start values). A lesson has proved itself when it is live and approved by a person (not on trial), was given to at least 10 tasks (counted, never
// guessed: an uncounted lesson is not proven), is at least 30 days old, was never marked wrong, nothing is open against it (a retire asked for, a contradiction, a possible duplicate, a failed citation), and two
// independent people stand behind it (or one person and a measured result). Pure.
//
// SEAM: the computed band belongs to lessons phase 1/2 (L4-LP12). Graduation asks for it through `ProvenReader`, and this is the default until that band is merged: its owner replaces `provenLesson` with the shared
// function (the same rule, the same start values), and nothing else here changes. Skills (`provenProcedure` in L4-AK3) use the same rule for procedure lessons.
import { hasStaleCitation } from "./load.js";
import { independentSources } from "./value.js";
import type { Lesson } from "./types.js";

export const PROVEN = { tasks: 10, days: 30 } as const;
const DAY_MS = 86_400_000;

export interface ProvenInput { lesson: Lesson; /** The distinct tasks the lesson was given to (`countLessonUses`); undefined when it could not be counted. */ tasks: number | undefined; now: number }
export type ProvenReader = (input: ProvenInput) => boolean;

export function provenLesson(input: ProvenInput): boolean {
  const { lesson, tasks, now } = input;
  if (lesson.status !== "active" || lesson.trial !== undefined || lesson.reviewRequired === true || lesson.became !== undefined || lesson.promotedRuleId !== undefined) return false;
  if (lesson.approvals.length === 0 || lesson.provenance.audience.kind !== "project" || hasStaleCitation(lesson)) return false;
  if (lesson.counters.harmful > 0 || lesson.counters.citationStale > 0 || lesson.retireProposedAt !== undefined || lesson.possibleDuplicateOf !== undefined || lesson.contradictsWith !== undefined) return false;
  if (tasks === undefined || tasks < PROVEN.tasks || now - lesson.createdAt < PROVEN.days * DAY_MS) return false;
  const people = independentSources(lesson.provenance);
  return people >= 2 || (people >= 1 && lesson.provenance.measured);
}
