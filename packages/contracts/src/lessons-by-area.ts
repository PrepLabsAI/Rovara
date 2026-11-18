// Lead 4 L4-LP3W (lessons phase 3): what Cloud reads to browse the team's lessons by code area, to show "Team lessons for this area" on a wiki page, and to list "Where Rovara learns from". Three additive reads, all
// for ONE project of the caller's own company, all built by code from the lessons' own scope and counts (no model call):
//   GET /v1/dev/projects/{project}/lessons/areas[?repo=&folder=| ?whole=1]   the area tree, and the lessons anchored at one node
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}/lessons               the lessons an agent is told in this page's area (the same units `knowledge_for` answers)
//   GET /v1/dev/projects/{project}/lessons/learning-sources                  one row per source of learning, with seen / suggested / kept counts; PUT .../{key} pauses or resumes one
// Every text field is the team's own words written from tasks and repository text: untrusted DATA. Nothing here can grant a tool, check, approval or limit (the schema has no place for one), and the words are cleaned
// again before they are shown to a person or to an agent.
import { z } from "zod";
import { LessonViewSchema } from "./app-lessons.js";
import { LESSON_TYPES } from "./learned-context.js";

export const LESSON_AREA_FEATURE = "lessons.areas.v1" as const;
const Count = z.number().int().min(0).max(1_000_000);
const Folder = z.string().max(400);

export const LessonAreaFileSchema = z.object({ name: z.string().min(1).max(100), lessons: Count }).strict();
export interface LessonAreaNode { name: string; path: string; lessons: number; children: LessonAreaNode[]; moreChildren?: number | undefined; files: Array<z.infer<typeof LessonAreaFileSchema>>; moreFiles?: number | undefined }
export const LessonAreaNodeSchema: z.ZodType<LessonAreaNode> = z.lazy(() => z.object({
  name: z.string().min(1).max(100), path: Folder, lessons: Count,
  children: z.array(LessonAreaNodeSchema).max(40), moreChildren: Count.optional(),
  files: z.array(LessonAreaFileSchema).max(20), moreFiles: Count.optional(),
}).strict());

export const LessonAreaRepoSchema = z.object({
  /** null: lessons that name paths but no repository. */
  repo: z.string().min(1).max(200).nullable(), lessons: Count,
  children: z.array(LessonAreaNodeSchema).max(40), moreChildren: Count.optional(),
  files: z.array(LessonAreaFileSchema).max(20), moreFiles: Count.optional(),
}).strict();

export const LessonAreasAnswerSchema = z.object({
  project: z.string().min(1).max(100),
  /** The lessons counted: the approved lessons this person may read, up to the page's limit. */
  total: Count,
  /** Lessons with no repository and no path: no area, so they are counted apart ("Whole project"). */
  wholeProject: Count,
  repos: z.array(LessonAreaRepoSchema).max(30),
  /** The tree or the list of lessons was cut by a bound or by the time limit. What is shown is true; more exist. */
  partial: z.literal(true).optional(),
  /** Present when one node was asked for: the lessons anchored at it or below it, in the order the Lessons tab uses. */
  selection: z.object({
    whole: z.literal(true).optional(), repo: z.string().max(200).nullable().optional(), folder: Folder.optional(),
    lessons: z.array(LessonViewSchema).max(50), moreLessons: Count.optional(),
  }).strict().optional(),
}).strict();
export type LessonAreasAnswer = z.infer<typeof LessonAreasAnswerSchema>;

// ---- "Team lessons for this area" (people and agents read the same row) ----------------------------------------------------------------------------------------------------------

/** One lesson as a person sees it on a page and an agent is told it: the same words (`unitOfLesson` builds both). `id` is the id both sides see (`L-<lesson id>`). */
export const TeamLessonRowSchema = z.object({
  id: z.string().regex(/^L-[A-Za-z0-9_-]{4,64}$/u), lessonId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1),
  type: z.enum(LESSON_TYPES),
  statement: z.string().min(1).max(240), why: z.string().max(160), detail: z.string().max(600),
  /** Where it applies, as a short plain label. */
  scopeLabel: z.string().max(200),
  /** The words an agent sees for its trust level. */
  trust: z.literal("team-approved"),
}).strict();
export type TeamLessonRow = z.infer<typeof TeamLessonRowSchema>;

export const TEAM_LESSONS_NOTE = "These are the team's approved lessons for this area. Agents are told them as notes, not commands, and the code wins when they disagree." as const;

export const TeamLessonsAnswerSchema = z.object({
  project: z.string().min(1).max(100), pageId: z.string().min(1).max(120),
  /** The area the page is about: a repository and a folder (`src/billing/`), or the whole repository. Absent: this page has no area of its own (an overview or a how-to page). */
  area: z.object({ repo: z.string().min(1).max(200), folder: Folder }).strict().optional(),
  lessons: z.array(TeamLessonRowSchema).max(30),
  /** Lessons that apply here and are not listed (past the page's limit). */
  moreLessons: Count,
  note: z.literal(TEAM_LESSONS_NOTE),
}).strict();
export type TeamLessonsAnswer = z.infer<typeof TeamLessonsAnswerSchema>;

// ---- "Where Rovara learns from" ------------------------------------------------------------------------------------------------------------------------------------------------

/** The kinds of source one row stands for, in the order the list shows them. The words are fixed here, never taken from stored text. */
export const LEARNING_SOURCE_KEYS = ["task_decisions", "review_comments", "pr_edits", "remember", "after_merge", "ci"] as const;
export type LearningSourceKey = (typeof LEARNING_SOURCE_KEYS)[number];
export const LEARNING_SOURCE_WORDS: Readonly<Record<LearningSourceKey, { label: string; detail: string }>> = {
  task_decisions: { label: "Decisions in tasks", detail: "Send-backs and close reasons" },
  review_comments: { label: "Review comments", detail: "Comments on Rovara's pull requests and its own review findings" },
  pr_edits: { label: "Edits to Rovara's pull requests", detail: "Changes people make before merging" },
  remember: { label: "Things people ask Rovara to remember", detail: "Notes people write on purpose" },
  after_merge: { label: "After merge", detail: "Reverts and what happened to merged work" },
  ci: { label: "Failing checks", detail: "Test and build failures. No log text is kept" },
};

export const LearningSourceRowSchema = z.object({
  key: z.enum(LEARNING_SOURCE_KEYS), label: z.string().min(1).max(80), detail: z.string().min(1).max(160),
  /** The last 30 days. seen: lessons Rovara drafted from this source. suggested: of those, the ones that reached a person (or went live). kept: of those, the ones a person approved or that are in use. */
  seen: Count, suggested: Count, kept: Count,
  /** Paused by a person: Rovara does not read this source while it is paused. Nothing from the paused time is collected or kept, and resuming starts again from then. Lessons already made are not deleted. */
  paused: z.boolean(),
  /** One real example of what this source produced: the newest lesson this person may read. */
  example: z.object({ lessonId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), title: z.string().max(80) }).strict().optional(),
}).strict();
export const LearningSourcesAnswerSchema = z.object({
  project: z.string().min(1).max(100), windowDays: z.literal(30),
  /** Whether this person may pause or resume a source (a project admin, or a company owner or admin). */
  canPause: z.boolean(),
  sources: z.array(LearningSourceRowSchema).max(LEARNING_SOURCE_KEYS.length),
  /** Counting was cut by the time limit or the count limit; the numbers are a floor. */
  partial: z.literal(true).optional(),
}).strict();
export type LearningSourcesAnswer = z.infer<typeof LearningSourcesAnswerSchema>;

export const LearningSourcePauseBodySchema = z.object({ paused: z.boolean() }).strict();
