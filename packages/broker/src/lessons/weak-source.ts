// Lead 4 L4-SRC-TK: the "seen twice" gate for WEAK sources (a ticket comment, and later a Slack thread reply or a CI pattern). A strong source (a person's edit to Rovara's pull request, an explicit "remember", a send-back
// with a reason) can put a lesson in front of people at once. A weak source cannot: a lesson that rests on weak evidence and on no strong correction stays a candidate (collected, never shown, never applied) until it has been seen twice, on two
// different tasks and from two different comments. A lesson that also rests on any strong kind is judged by the ordinary rules. A person still approves every lesson from a weak source: it never goes live on trial and
// never applies by itself, however often it is seen (`process.ts`). Pure.
import type { LessonProvenance } from "./types.js";

/** The kinds of evidence that wait for a second sighting. One place, so a new weak source is added here and nowhere else. */
export const WEAK_SPAN_KINDS: ReadonlySet<string> = new Set(["ticket_comment"]);
/** How many separate sightings (tasks AND comments) a weak-only lesson needs before a person is asked. */
export const WEAK_SIGHTINGS_NEEDED = 2;

/**
 * The kinds of evidence that are a person's own correction or a measured result: a lesson that rests on any of these is judged by the ordinary rules. Every other kind (the task's own wording, Rovara's plan, an outcome row,
 * a fact, CI text, a loaded lesson) is NEUTRAL: it is not a correction, so citing it beside a weak kind does not make the lesson strong. A kind this build does not know (`other`) is neutral too: fail closed.
 */
export const STRONG_SPAN_KINDS: ReadonlySet<string> = new Set(["send_back", "human_edit", "remembered", "close_reason", "review_finding", "plan_comment", "design_comment", "pr_comment"]);

/** Whether a lesson rests on at least one weak kind (a ticket comment). Such a lesson is never applied without a person, whatever else it cites. */
export const hasWeakKind = (provenance: Pick<LessonProvenance, "sourceKinds">): boolean => provenance.sourceKinds.some((kind) => WEAK_SPAN_KINDS.has(kind));

/** Whether a lesson rests on weak evidence and on NO strong kind (a neutral kind beside it, the task's own words or Rovara's plan, does not make it strong). */
export const isWeakOnly = (provenance: Pick<LessonProvenance, "sourceKinds">): boolean =>
  hasWeakKind(provenance) && !provenance.sourceKinds.some((kind) => STRONG_SPAN_KINDS.has(kind));

/** Whether a weak-only lesson has been seen on enough separate tasks AND from enough separate comments (one task counted twice, or one comment read by two tasks, is one sighting). */
export const seenEnoughTimes = (provenance: Pick<LessonProvenance, "supportTasks" | "sourceEvents">): boolean =>
  new Set(provenance.supportTasks).size >= WEAK_SIGHTINGS_NEEDED && new Set(provenance.sourceEvents).size >= WEAK_SIGHTINGS_NEEDED;

/** True when the lesson must keep waiting for a second sighting. */
export const weakSourceWaits = (provenance: Pick<LessonProvenance, "sourceKinds" | "supportTasks" | "sourceEvents">): boolean =>
  isWeakOnly(provenance) && !seenEnoughTimes(provenance);

// Batch b18 (rule F, #1036 beside #1023): the Slack thread reply source keeps its own reviewed rule (two tasks; it never goes live by itself). Both weak sources live in this one file.
// Lead 4 L4-SRC-SL: weak sources. A reply in a chat thread is the one source today whose words were not written TO Rovara as a correction (a teammate talking in a thread), so it is weak evidence:
//   - it is shown to people only after the same point is seen twice, from two different tasks (`earnedAttention`, `process.ts`; the owner's decision names no measured-result exception): nothing waits in front of people on one sighting;
//   - it never goes live by itself, whatever else backs it: not on trial and not by the automatic path (DEC 24: chat text never goes live without a person).
// Pure; reads only a lesson's provenance. `sourceKinds` are the kinds of the spans the lesson CITES, and a merge keeps the union (`curate.ts`).

/** Kinds that are a person's own correction or choice made to Rovara (or in its review of the work): a lesson that cites one of these is not weak because of a chat reply beside it. */
const SLACK_STRONG_KINDS: ReadonlySet<string> = new Set(["remembered", "human_edit", "send_back", "close_reason", "plan_comment", "design_comment", "pr_comment"]);

/** Whether a lesson cites a reply in a chat thread. Such a lesson never goes live without a person. */
export const citesSlackReply = (provenance: Pick<LessonProvenance, "sourceKinds">): boolean => provenance.sourceKinds.includes("slack_reply");

/** Whether a chat reply is the ONLY kind of person's evidence a lesson cites: it then waits for a second sighting. */
export const isWeakSlackOnly = (provenance: Pick<LessonProvenance, "sourceKinds">): boolean =>
  citesSlackReply(provenance) && !provenance.sourceKinds.some((kind) => SLACK_STRONG_KINDS.has(kind));
