// Learning v2 (L4): what the broker sends a worker as `learnedContext` for one stage, and what the worker reports back. The payload field in the
// worker invocation (protocol.ts) and the feature string `task.learnedContext.v1` are added by the record-core lane (R1); the shape lives here so the
// broker's loader and the worker's validator read one definition. Strict: a field this build does not know is refused, never ignored.
import { z } from "zod";
import { isMeaningfulAnchor } from "./lesson-citation.js";

export const LEARNED_CONTEXT_FEATURE = "task.learnedContext.v1" as const;
export const LEARNED_CONTEXT_MAX_LESSONS = 12;
export const LEARNED_CONTEXT_MAX_BYTES = 6 * 1024;
export const LESSON_STAGES = ["UNDERSTAND", "PLAN", "IMPLEMENT", "PLAN_CRITIQUE", "REVIEW"] as const;
export const LessonStageSchema = z.enum(LESSON_STAGES);
export type LessonStage = z.infer<typeof LessonStageSchema>;
export const LESSON_TYPES = ["fact", "convention", "pitfall", "procedure", "preference", "review_check"] as const;
export const LessonTypeSchema = z.enum(LESSON_TYPES);
export type LessonType = z.infer<typeof LessonTypeSchema>;

const RepoName = z.string().min(1).max(200);
const RelativePath = z.string().min(1).max(400).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "the path stays inside the repository");

export const CodeCitationSchema = z.object({
  kind: z.literal("code"), repo: RepoName, path: RelativePath,
  startLine: z.number().int().min(1).max(10_000_000), endLine: z.number().int().min(1).max(10_000_000),
  /** The first cited line, copied from the file. */
  anchor: z.string().min(1).max(400).refine(isMeaningfulAnchor, "the anchor is a meaningful line of code"), commit: z.string().regex(/^[a-f0-9]{7,64}$/u),
}).strict().refine((c) => c.endLine >= c.startLine && c.endLine - c.startLine <= 400, "the range is at most 400 lines");
export type CodeCitation = z.infer<typeof CodeCitationSchema>;

export const LearnedLessonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1),
  type: LessonTypeSchema,
  title: z.string().min(1).max(80), description: z.string().max(160), body: z.string().min(1).max(600),
  /** A short human label of where the lesson applies, built by the broker (repo and paths). */
  scopeLabel: z.string().max(200),
  citations: z.array(CodeCitationSchema).max(6),
}).strict();
export type LearnedLesson = z.infer<typeof LearnedLessonSchema>;

export const LearnedContextSchema = z.object({
  v: z.literal(1), setVersion: z.number().int().min(0), stage: LessonStageSchema,
  lessons: z.array(LearnedLessonSchema).max(LEARNED_CONTEXT_MAX_LESSONS),
  /** For reviewer stages: the lessons the planner or coder loaded, so a reviewer can check whether one drove a bad change. */
  priorLoaded: z.array(z.object({ id: z.string().max(64), type: LessonTypeSchema, title: z.string().max(80) }).strict()).max(40).optional(),
}).strict();
export type LearnedContext = z.infer<typeof LearnedContextSchema>;

export const LESSON_CITATION_RESULTS = ["valid", "moved", "stale_dropped", "unchecked_dropped", "none"] as const;
export const LoadReportSchema = z.object({
  v: z.literal(1), stage: LessonStageSchema,
  lessons: z.array(z.object({
    id: z.string().max(64), version: z.number().int().min(1), citation: z.enum(LESSON_CITATION_RESULTS),
    /** Corrected ranges for a moved citation, by position in the lesson's citations. */
    corrected: z.array(z.object({ index: z.number().int().min(0).max(5), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict()).max(6).optional(),
  }).strict()).max(LEARNED_CONTEXT_MAX_LESSONS),
}).strict();
export type LoadReport = z.infer<typeof LoadReportSchema>;

/** The progress-event field the worker carries its load report in: `{ learnedLoadReport: <report> }`. */
export const LEARNED_LOAD_REPORT_FIELD = "learnedLoadReport";

/** The load report in a worker progress payload, or undefined for anything else (a malformed report is dropped whole, never partly used). */
export function learnedLoadReportOfProgress(payload: unknown): LoadReport | undefined {
  if (payload === null || typeof payload !== "object" || !Object.hasOwn(payload, LEARNED_LOAD_REPORT_FIELD)) return undefined;
  const parsed = LoadReportSchema.safeParse((payload as Record<string, unknown>)[LEARNED_LOAD_REPORT_FIELD]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What is STORED and QUEUED for a stage's lessons (WL-6): ids and versions only, never lesson text. The outbox row, the queue message, its dead-letter copy and a FAILED row carry this; the
 * dispatcher builds the `learnedContext` from the lesson store at delivery, so a lesson erased, retired or edited after the stage was queued is never delivered, and no text sits in any
 * stored copy. `orgId` and `project` name the lesson store; `audience` is who the load was for (a private task's owner, by canonical developer id), so delivery asks the access records for the same
 * reader. Never sent to a worker (delivery removes it).
 */
export const LearnedRefsSchema = z.object({
  v: z.literal(1), orgId: z.string().min(1).max(100), project: z.string().min(1).max(200), setVersion: z.number().int().min(0), stage: LessonStageSchema,
  audience: z.discriminatedUnion("kind", [z.object({ kind: z.literal("shared") }).strict(), z.object({ kind: z.literal("private"), developerId: z.string().min(1).max(100) }).strict()]),
  /**
   * The running task the lessons were loaded for (LV-1 H1). Delivery reads THIS task's live Plan 5 visibility to decide who the reader is; `audience` is only what the load saw and is never trusted for a
   * live check. Absent on a stage queued before this field: delivery then reads as nobody in particular (only lessons whose every source task is project-wide).
   */
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u).optional(),
  /** The file arm: the lessons are delivered as the repository file `.rovara/lessons.md` (for this repository), not as a prompt block. Set only with `snapshotId`. */
  file: z.object({ repository: z.string().min(1).max(200) }).strict().optional(),
  /** The frozen snapshot a replay copy was given. Delivery then reads EXACTLY the listed versions, only if the snapshot names them, and never the live set. */
  snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/u).optional(),
  lessons: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1) }).strict()).max(LEARNED_CONTEXT_MAX_LESSONS),
  priorLoaded: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u) }).strict()).max(40).optional(),
}).strict();
export type LearnedRefs = z.infer<typeof LearnedRefsSchema>;

/** The ids and versions of a loaded context, with who it was loaded for. No text crosses into the result. */
export function learnedRefsOf(context: LearnedContext, scope: { orgId: string; project: string; audience: LearnedRefs["audience"]; taskId?: string | undefined; snapshotId?: string | undefined; file?: { repository: string } | undefined }): LearnedRefs {
  return {
    v: 1, orgId: scope.orgId, project: scope.project, setVersion: context.setVersion, stage: context.stage, audience: scope.audience,
    ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
    ...(scope.snapshotId === undefined ? {} : { snapshotId: scope.snapshotId }),
    ...(scope.file === undefined ? {} : { file: scope.file }),
    lessons: context.lessons.map((lesson) => ({ id: lesson.id, version: lesson.version })),
    ...(context.priorLoaded === undefined ? {} : { priorLoaded: context.priorLoaded.map((prior) => ({ id: prior.id })) }),
  };
}
