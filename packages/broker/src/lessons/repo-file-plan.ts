// What a weekly pass proposes for ONE repository's `.rovara/lessons.md`. Pure: it reads lessons and the merged file it is handed and
// calls no model, no store, no host, no clock.
//
// Rules, each pinned by a test:
//   - ONLY lessons that `isRepoFileEligible` for this repository's place go in (every input repo-visible, no names, stable or person-approved, active, sound). Under the Regulated preset only person-approved ones are ADDED.
//   - The order of the proposal is removals, then edits, then adds. A removal always carries a reason code.
//   - Rovara changes only blocks it owns: ids it merged before (`rendered`) or ids of its own stored lessons for this repository. A block with no id line, an unknown id, a duplicated id is the team's and is never touched.
//   - One home per lesson (50a): the text in the merged file is the team's. A block whose text or section no longer matches what Rovara rendered was edited by a person: it is left exactly as written and that lesson is HELD
//     (no edit, no removal) until read-back takes the team's text in. It is recorded, never silently skipped.
//   - A block a person removed is `declined`: never proposed back.
//   - After 3 weekly pull requests in a row that nobody merged, additions and edits stop; removals go on.
//   - Caps: 300 lessons and 64 KB; adds stop at a cap, removals are never blocked.
import { createHash } from "node:crypto";
import { LESSON_FILE_MAX_BYTES, LESSON_FILE_MAX_LESSONS } from "@agentx/contracts";
import { hasStaleCitation } from "./trial.js";
import { hasPersonApproval, repoFileBlockers, type RepoFileBlocker } from "./repo-eligibility.js";
import {
  WHOLE_REPOSITORY, applyFileChanges, blockOf, byteLength, cleanLessonLine, compareIds, normalizeBlockText, parseLessonsFile, textHash, type ParsedFile,
} from "./repo-file-format.js";
import type { Lesson } from "./types.js";

export const REMOVAL_REASONS = ["faded", "harm", "retired", "withdrawn", "lesson_erased", "stale_citation", "names_a_person", "no_longer_repo_only", "needs_review", "no_longer_approved"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];
/** The sentence for a reason in the pull request body (fixed words). Only the two reasons that are plainly about the code say why; every other reason is one neutral sentence, so the body tells repo readers nothing about Rovara's people or feedback . */
export const NEUTRAL_REMOVAL_TEXT = "Rovara no longer proposes this lesson";
export const REMOVAL_REASON_TEXT: Record<RemovalReason, string> = {
  faded: "it has not helped for a long time", stale_citation: "the code it points to has changed or is gone",
  harm: NEUTRAL_REMOVAL_TEXT, retired: NEUTRAL_REMOVAL_TEXT, withdrawn: NEUTRAL_REMOVAL_TEXT, lesson_erased: NEUTRAL_REMOVAL_TEXT, names_a_person: NEUTRAL_REMOVAL_TEXT,
  no_longer_repo_only: NEUTRAL_REMOVAL_TEXT, needs_review: NEUTRAL_REMOVAL_TEXT, no_longer_approved: NEUTRAL_REMOVAL_TEXT,
};

const PATH_TOKEN = /^[A-Za-z0-9_./*@-]{1,100}$/u;
const LANGUAGE = /^[a-z][a-z0-9+#-]{0,19}$/u;
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The section a lesson goes under: its paths sorted and joined, its languages after them, the whole repository when it has neither. Undefined when a path or language is not a plain token (the lesson is not rendered). */
export function sectionOf(scope: Lesson["scope"]): string | undefined {
  const paths = [...new Set(scope.paths ?? [])].sort(byBytes);
  const languages = [...new Set(scope.languages ?? [])].sort(byBytes);
  if (!paths.every((path) => PATH_TOKEN.test(path) && !path.includes("..")) || !languages.every((language) => LANGUAGE.test(language))) return undefined;
  const where = paths.join(", ");
  const langs = languages.join(", ");
  if (paths.length === 0) return languages.length === 0 ? WHOLE_REPOSITORY : `Languages: ${langs}`;
  return languages.length === 0 ? where : `${where} (${langs})`;
}

export interface RenderedLesson { id: string; heading: string; text: string; title: string; fingerprint: string }
/** What Rovara would put in the file for a lesson: undefined when it cannot be rendered (no text, a scope that is not plain tokens, a scope that names only other repositories). */
export function renderLesson(lesson: Pick<Lesson, "id" | "body" | "title" | "scope">, repoName: string): RenderedLesson | undefined {
  const text = cleanLessonLine(lesson.body);
  const heading = sectionOf(lesson.scope);
  if (text === "" || heading === undefined) return undefined;
  if ((lesson.scope.repos ?? []).length > 0 && !(lesson.scope.repos ?? []).includes(repoName)) return undefined;
  return { id: lesson.id, heading, text, title: cleanLessonLine(lesson.title).slice(0, 80), fingerprint: fingerprintOf(text, heading) };
}
/** The fingerprint of a block as Rovara rendered it: its text in comparison form and its section. A formatter's reflow does not change it; a person's wording or move does. */
export const fingerprintOf = (text: string, heading: string): string => `${textHash(normalizeBlockText(text))}:${createHash("sha256").update(heading).digest("hex").slice(0, 8)}`;

export interface PlanRemoval {
  id: string; reason: RemovalReason; /** From the file's own block text, so it is repo content already. */ title: string;
  /** The team reworded this block: it is proposed for removal anyway (a privacy reason), and the pull request says so. */
  edited?: true;
}
export interface PlanEdit { id: string; title: string; heading: string; text: string; fingerprint: string; moved: boolean }
export interface PlanAdd { id: string; title: string; heading: string; text: string; fingerprint: string }
export interface RepoFilePlan {
  removals: PlanRemoval[]; edits: PlanEdit[]; adds: PlanAdd[];
  /** Ids whose block the team edited: left exactly as written. */
  held: string[];
  /** Owned ids no longer in the file: the team removed them, so they are never proposed back. */
  newlyDeclined: string[];
  /** Ids already in the file with exactly the text Rovara would render: they are Rovara's (recorded as rendered). */
  adopted: Record<string, string>;
  skipped: { unrenderable: number; capped: number; ambiguous: number };
  addsPaused: boolean;
  /** Why additions and edits stopped: three pull requests nobody merged, or a pull request the team took over is still open. */
  pausedBy?: "unmerged" | "team_pr";
  /** The file after the changes; undefined when nothing changes in it. */
  nextText: string | undefined;
  digest: string;
}

export interface PlanInput {
  place: string; repoName: string;
  /** Every lesson of the project that could matter (any status); lessons of other repositories are ignored. */
  lessons: readonly Lesson[];
  /** The people the lessons could name (display names), as for `isRepoFileEligible`. */
  names: readonly string[];
  /** The merged file's text, or undefined when there is none. */
  fileText: string | undefined;
  rendered: Readonly<Record<string, string>>;
  declined: readonly string[];
  /** Which of the ids in the file are gone for good in Rovara (the lesson store's own tombstone, one durable row per erased or withdrawn lesson): a block with one of these ids is proposed for removal however it got into the file. */
  gone?: ReadonlySet<string>;
  addsPaused: boolean;
  /** A Rovara pull request a person pushed to is still open: only removals are proposed until it is closed or merged. */
  teamPr?: boolean;
  preset: "standard" | "regulated";
}

/** Why a lesson that is in the file should come out, from the lesson's own state. First match wins. */
export function removalReasonOf(lesson: Lesson | undefined, blockers: readonly RepoFileBlocker[]): RemovalReason {
  // A privacy reason is named first, whatever quality reasons are also present: it is the one that decides whether the team's wording can keep the lesson in the file.
  const privacy = privacyReasonOf(lesson, blockers);
  if (privacy !== undefined) return privacy;
  if (lesson === undefined) return "lesson_erased";
  if (lesson.status === "expired") return "faded";
  if (lesson.status !== "active") return lesson.counters.harmful > 0 || lesson.retiredByHarm !== undefined ? "harm" : "retired";
  if (lesson.counters.harmful > 0 || lesson.retireProposedAt !== undefined) return "harm";
  if (hasStaleCitation(lesson)) return "stale_citation";
  if (blockers.includes("needs_review")) return "needs_review";
  return "no_longer_approved";
}

/** The privacy reason a lesson has for leaving a repository's file, if it has one: gone from Rovara (erased), withdrawn, now names a person, or no longer rests only on this repository's own words. A SET in effect: any one is enough. */
export function privacyReasonOf(lesson: Lesson | undefined, blockers: readonly RepoFileBlocker[]): RemovalReason | undefined {
  if (lesson === undefined) return "lesson_erased";
  if (lesson.status === "withdrawn") return "withdrawn";
  if (blockers.includes("names_a_person")) return "names_a_person";
  if (blockers.some((b) => b === "not_repo_only" || b === "other_repo" || b === "restricted_audience" || b === "repo_unknown")) return "no_longer_repo_only";
  return undefined;
}

const titleOfBlock = (text: string): string => cleanLessonLine(text).slice(0, 80);

/** Builds the proposal. Pure and deterministic: the same inputs give the same plan, whatever order the lessons come in. */
export function planRepoFile(input: PlanInput): RepoFilePlan {
  const file: ParsedFile | undefined = input.fileText === undefined ? undefined : parseLessonsFile(input.fileText);
  const mine = (lesson: Lesson): boolean => lesson.provenance.repoOnly?.place === input.place || input.rendered[lesson.id] !== undefined;
  const everyLesson = new Map(input.lessons.map((lesson) => [lesson.id, lesson]));
  const goneIds = input.gone ?? new Set<string>();
  const byId = new Map(input.lessons.filter(mine).map((lesson) => [lesson.id, lesson]));
  const paused = input.addsPaused || input.teamPr === true;
  const skipped = { unrenderable: 0, capped: 0, ambiguous: 0 };
  const removals: PlanRemoval[] = [];
  const edits: PlanEdit[] = [];
  const held: string[] = [];
  const adopted: Record<string, string> = {};
  const newlyDeclined: string[] = [];
  const inFile = new Set((file?.blocks ?? []).map((block) => block.id));
  skipped.ambiguous = file?.duplicates.length ?? 0;

  // Erasure is driven by the FILE: every block that carries a marker of a lesson Rovara knows (or knew and erased) is looked at, however it got there. An id nobody knows is a team block and is left alone.
  const known = [...inFile].filter((id) => !file!.duplicates.includes(id) && (input.rendered[id] !== undefined || everyLesson.has(id) || goneIds.has(id))).sort(compareIds);
  for (const id of known) {
    const block = blockOf(file!, id)!;
    const lesson = everyLesson.get(id);
    if (input.rendered[id] === undefined && !byId.has(id)) {
      // Not Rovara's to edit or hold: only a privacy reason acts (a lesson of another repository, one that is not repo-only, or one that is gone).
      const reason = privacyReasonOf(lesson, lesson === undefined ? [] : repoFileBlockers(lesson, input.place, input.names));
      if (reason !== undefined) removals.push({ id, reason, title: titleOfBlock(block.text) });
      continue;
    }
    const desired = lesson === undefined ? undefined : renderLesson(lesson, input.repoName);
    const baseline = input.rendered[id] ?? desired?.fingerprint;
    const now = fingerprintOf(block.text, block.heading);
    // A block that is not what Rovara rendered is the team's.
    if (baseline === undefined || now !== baseline) {
      // The team's wording is theirs, except that a privacy reason (erased, withdrawn, names a person, no longer repo-only) still proposes the removal .
      const blockers = lesson === undefined ? [] : repoFileBlockers(lesson, input.place, input.names);
      const reason = privacyReasonOf(lesson, blockers);
      if (reason !== undefined) { removals.push({ id, reason, title: titleOfBlock(block.text), edited: true }); continue; }
      held.push(id);
      continue;
    }
    if (input.rendered[id] === undefined) adopted[id] = now;
    const blockers = lesson === undefined ? [] : repoFileBlockers(lesson, input.place, input.names);
    const stays = lesson !== undefined && blockers.length === 0 && desired !== undefined;
    if (!stays) {
      // A lesson that is only unrenderable now (its scope became odd) is left alone rather than removed on a guess; every other doubt is a removal with its reason.
      if (lesson !== undefined && blockers.length === 0 && desired === undefined) { skipped.unrenderable += 1; continue; }
      removals.push({ id, reason: removalReasonOf(lesson, blockers), title: titleOfBlock(block.text) });
      continue;
    }
    if (!paused && desired !== undefined && desired.fingerprint !== now) {
      edits.push({ id, title: desired.title, heading: desired.heading, text: desired.text, fingerprint: desired.fingerprint, moved: desired.heading !== block.heading });
    }
  }

  // Owned ids Rovara merged before that are gone from the file: the team removed them.
  // (Only when there is a file to compare with: a repository the team deleted the file of and resumed starts from nothing, and nothing is "removed by the team".)
  if (file !== undefined) for (const id of Object.keys(input.rendered)) if (!inFile.has(id)) newlyDeclined.push(id);
  const declined = new Set([...input.declined, ...newlyDeclined]);

  // Adds.
  let adds: PlanAdd[] = [];
  if (!paused) {
    const candidates = [...byId.values()]
      .filter((lesson) => !inFile.has(lesson.id) && !declined.has(lesson.id) && !goneIds.has(lesson.id) && lesson.provenance.repoOnly?.place === input.place)
      .filter((lesson) => repoFileBlockers(lesson, input.place, input.names).length === 0 && (input.preset !== "regulated" || hasPersonApproval(lesson)))
      .sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
    for (const lesson of candidates) {
      const rendered = renderLesson(lesson, input.repoName);
      if (rendered === undefined) { skipped.unrenderable += 1; continue; }
      adds.push({ id: rendered.id, title: rendered.title, heading: rendered.heading, text: rendered.text, fingerprint: rendered.fingerprint });
    }
  }

  // Apply, and keep within the caps by dropping adds from the end (removals are never blocked).
  const change = (list: readonly PlanAdd[]): string => applyFileChanges(input.fileText, {
    remove: [...removals.map((r) => r.id), ...edits.filter((e) => e.moved).map((e) => e.id)],
    replace: edits.filter((e) => !e.moved).map((e) => ({ id: e.id, text: e.text })),
    add: [...edits.filter((e) => e.moved).map((e) => ({ id: e.id, heading: e.heading, text: e.text })), ...list.map((a) => ({ id: a.id, heading: a.heading, text: a.text }))],
  });
  const within = (text: string): boolean => byteLength(text) <= LESSON_FILE_MAX_BYTES && parseLessonsFile(text).blocks.length <= LESSON_FILE_MAX_LESSONS;
  let next = removals.length + edits.length + adds.length === 0 ? undefined : change(adds);
  if (next !== undefined && adds.length > 0 && !within(next)) {
    // The most adds that fit, by bisection: at most a few dozen applies.
    let low = 0, high = adds.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (within(change(adds.slice(0, mid)))) low = mid; else high = mid - 1;
    }
    skipped.capped = adds.length - low;
    adds = adds.slice(0, low);
    next = removals.length + edits.length + adds.length === 0 ? undefined : change(adds);
  }
  if (next !== undefined && next === input.fileText) next = undefined;

  const digest = createHash("sha256").update(JSON.stringify({
    r: removals.map((r) => [r.id, r.reason]), e: edits.map((e) => [e.id, e.fingerprint]), a: adds.map((a) => [a.id, a.fingerprint]),
  })).digest("hex").slice(0, 32);
  const pausedBy = input.teamPr === true ? "team_pr" as const : input.addsPaused ? "unmerged" as const : undefined;
  return { removals, edits, adds, held, newlyDeclined, adopted, skipped, addsPaused: input.addsPaused || input.teamPr === true, ...(pausedBy === undefined ? {} : { pausedBy }), nextText: next, digest };
}
