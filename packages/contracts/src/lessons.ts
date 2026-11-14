// Lessons (learning v2, design 2026-10-30 section 4.2, 4.5-4.7, 4.13): short, typed, scoped advice with code citations, learned from outcomes.
// A lesson is advice in a labelled block. It has NO field that can grant a tool, change a check, an approval, a model or a budget (control C6):
// every object here is strict, so a field of that kind is a refusal, not an ignored extra. The schema also enforces the hard parts of the tier
// rules (section 4.5.3) as a second guard behind the classifier: an outsider's text is never a lesson, tier 0 is only cited facts from trusted
// sources for the build stages, and anything for a reviewer stage or a check is tier 2.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AudienceSchema, RecordProjectSchema, TRUST_RANK, TrustClassSchema, type TrustClass } from "./record-trust.js";


// The stage and type enums live in learned-context.ts (the learning lane's definition of what a worker receives); lessons use the same ones.
import { LESSON_STAGES, LessonStageSchema, LessonTypeSchema, type LessonStage } from "./learned-context.js";
/** The stages a lesson may reach without two people: the build stages. Reviewer stages are tier 2 only. */
export const LESSON_BUILD_STAGES: readonly LessonStage[] = ["UNDERSTAND", "PLAN", "IMPLEMENT"];
export const LESSON_REVIEWER_STAGES: readonly LessonStage[] = ["PLAN_CRITIQUE", "REVIEW"];

export const LESSON_STATUSES = ["candidate", "pending", "active", "stale", "retired", "rejected", "expired", "withdrawn"] as const;
export const LessonStatusSchema = z.enum(LESSON_STATUSES);
export type LessonStatus = z.infer<typeof LessonStatusSchema>;

// Limits (section 4.5-4.7). Shared so the reflector, curator, loader and tests agree.
export const LESSON_TITLE_MAX = 80;
export const LESSON_DESCRIPTION_MAX = 160;
export const LESSON_BODY_MAX = 600;
export const LESSON_CANDIDATES_PER_TASK_MAX = 3;
export const LESSON_CANDIDATES_PER_PROJECT_PER_DAY_MAX = 20;
export const LESSON_CANDIDATES_PER_AUTHOR_PER_DAY_MAX = 10;
export const LESSONS_PER_STAGE_MAX = 12;
export const LESSONS_PER_STAGE_BYTES_MAX = 6_144;
export const LESSON_EXPIRY_DAYS_DEFAULT = 90;
export const LESSON_EXPIRY_DAYS_MIN = 14;
export const LESSON_EXPIRY_DAYS_MAX = 365;
export const LESSON_CITATION_STALE_LIMIT = 3;
export const LESSON_CITATION_STALE_WINDOW_DAYS = 14;
export const LESSON_REVERT_WINDOW_DAYS = 14;
export const LESSON_AUTO_RETIRE_HARMFUL = 2;
export const LESSON_CITATIONS_MAX = 8;

export const LessonScopeSchema = z.object({
  repos: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Globs relative to the repository root. */
  paths: z.array(z.string().min(1).max(300)).max(20).optional(),
  languages: z.array(z.string().min(1).max(40)).max(10).optional(),
}).strict();
export type LessonScope = z.infer<typeof LessonScopeSchema>;

const Sha = z.string().regex(/^[a-f0-9]{7,64}$/);

export const LessonCodeCitationSchema = z.object({
  kind: z.literal("code"),
  repo: z.string().min(1).max(200),
  path: z.string().min(1).max(500),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  /** The first cited line, used to find the code again when lines move. */
  anchor: z.string().min(1).max(300),
  /** The base or merged commit the citation was made against, never a PR branch head before merge. */
  commit: Sha,
}).strict().refine((citation) => citation.endLine >= citation.startLine, { message: "endLine is before startLine", path: ["endLine"] });
export const LessonCitationSchema = z.union([
  LessonCodeCitationSchema,
  z.object({ kind: z.literal("record"), eventId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("task"), taskId: z.string().min(1).max(100) }).strict(),
]);
export type LessonCitation = z.infer<typeof LessonCitationSchema>;

export const LESSON_TIERS = [0, 1, 2] as const;
export const LessonTierSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type LessonTier = z.infer<typeof LessonTierSchema>;

export const LessonProvenanceSchema = z.object({
  sourceEvents: z.array(z.string().min(1).max(100)).max(50),
  /** The lowest trust of the sources. `outsider` is refused: an outsider's text is never part of a lesson. */
  minTrust: TrustClassSchema,
  /** The narrowest audience of the sources. */
  audience: AudienceSchema,
  reflectorRun: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
}).strict();
export type LessonProvenance = z.infer<typeof LessonProvenanceSchema>;

export const LessonApprovalSchema = z.object({ approvalId: z.string().min(1).max(100), by: z.string().min(1).max(100), at: z.string().datetime() }).strict();

export const LessonCountersSchema = z.object({
  loaded: z.number().int().nonnegative(),
  helpful: z.number().int().nonnegative(),
  harmful: z.number().int().nonnegative(),
  citationStale: z.number().int().nonnegative(),
}).strict();
export type LessonCounters = z.infer<typeof LessonCountersSchema>;

const LessonIdSchema = z.string().regex(/^les_[0-9a-f]{20}$/);
export { LessonIdSchema };

const trustedForTierZero = (trust: TrustClass): boolean => TRUST_RANK[trust] >= TRUST_RANK.member;

/** The fields every lesson version carries, before the cross-field rules. */
const LessonBaseSchema = z.object({
  id: LessonIdSchema,
  version: z.number().int().min(1),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  scope: LessonScopeSchema,
  type: LessonTypeSchema,
  stages: z.array(LessonStageSchema).min(1).max(LESSON_STAGES.length).refine((stages) => new Set(stages).size === stages.length, "stages are unique"),
  title: z.string().min(1).max(LESSON_TITLE_MAX),
  description: z.string().min(1).max(LESSON_DESCRIPTION_MAX),
  body: z.string().min(1).max(LESSON_BODY_MAX),
  citations: z.array(LessonCitationSchema).max(LESSON_CITATIONS_MAX),
  provenance: LessonProvenanceSchema,
  tier: LessonTierSchema,
  tierReasons: z.array(z.string().min(1).max(200)).max(10),
  status: LessonStatusSchema,
  counters: LessonCountersSchema,
  lastValidatedAt: z.string().datetime().optional(),
  lastHelpfulAt: z.string().datetime().optional(),
  /** Epoch seconds. When the lesson fades: its trial period plus N days (90 by default) without helping; a validated helpful use resets it. */
  expiresAt: z.number().int().nonnegative(),
  approvals: z.array(LessonApprovalSchema).max(10),
  /** Set when a sole owner approved a tier-2 lesson alone (audited): one approval is then enough. */
  soleOwnerException: z.literal(true).optional(),
  supersedes: z.string().min(1).max(100).optional(),
  promotedRuleId: z.string().min(1).max(100).optional(),
}).strict();

export const LessonSchema = LessonBaseSchema.superRefine((lesson, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (lesson.provenance.minTrust === "outsider") issue("provenance", "an outsider's text is never a lesson");
  const reviewer = lesson.stages.some((stage) => LESSON_REVIEWER_STAGES.includes(stage)) || lesson.type === "review_check";
  if (reviewer && lesson.tier !== 2) issue("tier", "a lesson for a reviewer stage or a review check needs two people (tier 2)");
  if (lesson.tier === 0) {
    if (lesson.type !== "fact") issue("tier", "tier 0 is for facts only");
    if (!trustedForTierZero(lesson.provenance.minTrust)) issue("tier", "tier 0 needs member or rovara trust");
    if (lesson.provenance.audience.kind !== "project") issue("tier", "tier 0 needs the project audience");
    if (!lesson.stages.every((stage) => LESSON_BUILD_STAGES.includes(stage))) issue("tier", "tier 0 reaches build stages only");
    if ((lesson.scope.repos?.length ?? 0) > 1) issue("tier", "tier 0 is scoped to one repository");
    if (lesson.citations.length === 0 || !lesson.citations.every((citation) => citation.kind === "code")) issue("tier", "tier 0 needs code citations only");
  }
  const needed = lesson.soleOwnerException === true && lesson.tier === 2 ? 1 : lesson.tier;
  if (lesson.status === "active" && lesson.approvals.length < needed) issue("approvals", "an active lesson has the approvals its tier needs");
  if (lesson.soleOwnerException === true && lesson.tier !== 2) issue("soleOwnerException", "the sole-owner exception is for tier 2");
});
export type Lesson = z.infer<typeof LessonSchema>;

/** What the reflector may propose: no id, no tier, no status. Code fills those after it has checked the evidence spans. */
export const LessonCandidateSchema = z.object({
  type: LessonTypeSchema,
  title: z.string().min(1).max(LESSON_TITLE_MAX),
  description: z.string().min(1).max(LESSON_DESCRIPTION_MAX),
  body: z.string().min(1).max(LESSON_BODY_MAX),
  scope: LessonScopeSchema,
  stages: LessonBaseSchema.shape.stages,
  citations: z.array(LessonCitationSchema).max(LESSON_CITATIONS_MAX),
  /** The input spans the lesson rests on. Code checks each exists and is not `outsider`. */
  evidenceSpanIds: z.array(z.string().min(1).max(100)).min(1).max(20),
}).strict();
export type LessonCandidate = z.infer<typeof LessonCandidateSchema>;
export const ReflectorOutputSchema = z.object({ candidates: z.array(LessonCandidateSchema).max(LESSON_CANDIDATES_PER_TASK_MAX) }).strict();
export type ReflectorOutput = z.infer<typeof ReflectorOutputSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Learned skills (`SKILL#`): no tools, grants, commands or allowed domains, by construction

export const SKILL_BODY_MAX_BYTES = 16_384;
/** Front-matter keys that would grant a capability. A skill that names one is refused by the parser, not trimmed. */
export const SKILL_FORBIDDEN_FRONT_MATTER = [
  "tools", "allowed-tools", "allowedtools", "grants", "grant", "commands", "command", "allowed-domains", "alloweddomains", "domains", "mcp", "permissions",
  "model", "models", "budget", "budgets", "approvals", "approval", "hooks", "env", "secrets",
] as const;

/** The first forbidden key in a Markdown skill's front matter, or undefined when it has none. Case-insensitive; a front matter that never closes counts as all front matter. */
export function skillFrontMatterRefusal(markdown: string): string | undefined {
  const text = markdown.replace(/^\uFEFF/u, "");
  if (!/^---[ \t]*\r?\n/u.test(text)) return undefined;
  const rest = text.replace(/^---[ \t]*\r?\n/u, "");
  const end = rest.search(/^---[ \t]*$/mu);
  const block = end === -1 ? rest : rest.slice(0, end);
  for (const line of block.split(/\r?\n/u)) {
    const key = /^\s*"?([A-Za-z][A-Za-z0-9_-]*)"?\s*:/u.exec(line)?.[1]?.toLowerCase();
    if (key !== undefined && (SKILL_FORBIDDEN_FRONT_MATTER as readonly string[]).includes(key)) return key;
  }
  return undefined;
}

export const LearnedSkillSchema = z.object({
  id: z.string().regex(/^lsk_[0-9a-f]{20}$/),
  version: z.number().int().min(1),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  description: z.string().min(1).max(LESSON_DESCRIPTION_MAX),
  body: z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= SKILL_BODY_MAX_BYTES, `body exceeds ${String(SKILL_BODY_MAX_BYTES)} UTF-8 bytes`)
    .refine((value) => skillFrontMatterRefusal(value) === undefined, "a learned skill cannot carry tools, grants, commands, domains, models or budgets"),
  fromLessons: z.array(LessonIdSchema).min(1).max(50),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "active", "retired", "rejected"]),
  tier: z.union([z.literal(1), z.literal(2)]),
  approvals: z.array(LessonApprovalSchema).max(10),
}).strict();
export type LearnedSkill = z.infer<typeof LearnedSkillSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// The load manifest (`LOAD#`), the eval memory input and snapshots (section 4.13)

export const CITATION_CHECKS = ["valid", "moved", "stale_dropped"] as const;
export const CitationCheckSchema = z.enum(CITATION_CHECKS);
export type CitationCheck = z.infer<typeof CitationCheckSchema>;

export const MEMORY_MODES = ["off", "snapshot", "live"] as const;
/** Set only by an eval batch row; the broker refuses it on a production dispatch. */
export const MemoryInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z.object({ mode: z.literal("snapshot"), snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/) }).strict(),
  z.object({ mode: z.literal("live") }).strict(),
]);
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

export const LoadManifestSchema = z.object({
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  taskId: z.string().min(1).max(100),
  stage: LessonStageSchema,
  round: z.number().int().min(0),
  lessonSetVersion: z.number().int().min(0),
  memory: z.enum(MEMORY_MODES),
  snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/).optional(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  lessons: z.array(z.object({
    id: LessonIdSchema,
    version: z.number().int().min(1),
    score: z.number().min(0).max(1),
    why: z.enum(["scope", "similar", "path"]),
    citation: CitationCheckSchema,
  }).strict()).max(LESSONS_PER_STAGE_MAX),
  pastTasks: z.array(z.string().min(1).max(100)).max(20),
  recordHits: z.array(z.string().min(1).max(100)).max(40),
  skills: z.array(z.object({ id: z.string().min(1).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20),
  bytes: z.number().int().nonnegative().max(LESSONS_PER_STAGE_BYTES_MAX),
  at: z.string().datetime(),
}).strict();
export type LoadManifest = z.infer<typeof LoadManifestSchema>;

export const MemorySnapshotSchema = z.object({
  snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1).max(100),
  lessonSetVersion: z.number().int().min(0),
  lessons: z.array(z.object({ id: LessonIdSchema, version: z.number().int().min(1) }).strict()).max(2_000),
  skills: z.array(z.object({ id: z.string().min(1).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(200),
  /** Record and past-work rows after this instant are invisible to a run on the snapshot. */
  recordCutoff: z.string().datetime().optional(),
  embeddingModelId: z.string().min(1).max(200),
  /** sha256 over the canonical JSON of every included item. */
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Set when an erase or a source delete removed an item the snapshot named: privacy wins over reproducibility. */
  incomplete: z.boolean().optional(),
}).strict();
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// What the worker reports back (feature `task.learnedContext.v1`; the payload itself is `LearnedContextSchema` in learned-context.ts)

/** What the worker reports back for each lesson it was given; the broker writes `LOAD#` from it. */
export const LearnedLoadReportSchema = z.array(z.object({ id: LessonIdSchema, version: z.number().int().min(1), citation: CitationCheckSchema }).strict()).max(LESSONS_PER_STAGE_MAX);
export type LearnedLoadReport = z.infer<typeof LearnedLoadReportSchema>;
