// Learning v2 L3b: what the Lessons tab, the Sources tab and the task page's lessons list read and send (design learning-v2-team-record.md section 1.2, build row L3b).
// Browser-safe: nothing here imports a Node module. Request bodies are strict. Every answer has a forward reader (`*ReaderSchema`) that keeps unknown fields and reads an enum
// value it does not know as "unknown".
//
// What a lesson shows is decided by the server, per viewer: a lesson from a source the viewer cannot see is not in any list (only counted), a person who was erased is
// named "a former member", and an outsider's words are never a lesson. Every text here is plain text; the screens show it as text, never as markup.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { LessonStageSchema, LessonTypeSchema } from "./learned-context.js";

/** The statuses a lesson has in the store (kept equal to the broker's list by a test). */
export const LESSON_VIEW_STATUSES = ["candidate", "pending", "active", "stale", "retired", "rejected", "expired", "withdrawn"] as const;
export const LessonViewStatusSchema = z.enum(LESSON_VIEW_STATUSES);

/** The reasons for a tier, as the classifier writes them. A reason this build does not know is shown with no words (never the raw code). */
export const LESSON_TIER_REASONS = [
  "reviewer_stage", "review_check", "escalation_words", "command_or_url", "encoded_content", "risky_path", "judge_escalate", "not_a_fact", "citations_not_verified",
  "not_plain_declarative", "source_not_trusted", "scope_not_one_repo", "stage_not_allowed", "contradiction", "restricted_source", "supersedes_higher_tier", "cited_fact", "capability_request", "possible_duplicate", "matches_rejected",
] as const;

/**
 * Why learning cannot run for a project or its company right now (lessons in production, "never silent"). A fixed code and a time, nothing else: no model name, no amount, no provider text.
 * One current reason at most per project and per company; it is cleared when a learning call succeeds.
 */
export const LESSONS_PAUSE_CODES = ["no_provider", "all_models_forbidden", "no_suitable_model", "monthly_limit", "no_budget", "cost_too_high", "model_failed"] as const;
export const LessonsPauseCodeSchema = z.enum(LESSONS_PAUSE_CODES);
export type LessonsPauseCode = z.infer<typeof LessonsPauseCodeSchema>;
/** The one line that says it, on the Lessons tab and on Home. */
export const LESSONS_PAUSE_TEXT: Record<LessonsPauseCode, string> = {
  no_provider: "Lessons paused: no AI provider is connected for this project",
  all_models_forbidden: "Lessons paused: every available model is forbidden",
  no_suitable_model: "Lessons paused: no available model can write lessons",
  monthly_limit: "Lessons paused: monthly learning limit reached",
  no_budget: "Lessons paused: the AI budget has run out",
  cost_too_high: "Lessons paused: even the cheapest available model costs too much for one lesson",
  model_failed: "Lessons paused: the AI provider is not answering",
};
export const lessonsPauseText = (code: string): string => (LESSONS_PAUSE_TEXT as Record<string, string | undefined>)[code] ?? "Lessons paused";
/** The one line for a reason, with who it applies to: a company-wide reason (the monthly learning limit) says it is for every project of the company. */
export const lessonsPauseLine = (paused: { code: string; scope?: string | undefined }): string =>
  paused.scope === "company" ? `${lessonsPauseText(paused.code)} (for the whole company, every project)` : lessonsPauseText(paused.code);
export const LessonsPausedSchema = z.object({ code: LessonsPauseCodeSchema, at: z.number(), scope: z.enum(["project", "company"]).optional() }).strict();

export const LESSON_LEARNING_MODES = ["Off", "Collect", "Suggest", "On"] as const;
export const LessonLearningModeSchema = z.enum(LESSON_LEARNING_MODES);

/** A person as the screens may name them: a display name, or "a former member" for someone who was erased or cannot be read. `you` marks the signed-in person. */
export const LessonPersonSchema = z.object({ name: z.string().min(1).max(80), you: z.literal(true).optional() }).strict();
export type LessonPerson = z.infer<typeof LessonPersonSchema>;

export const LessonCitationViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("code"), repo: z.string().min(1).max(200), path: z.string().min(1).max(500), startLine: z.number().int().min(1), endLine: z.number().int().min(1),
    /** Whether the cited code is still where the lesson says: `valid`, `moved` (found elsewhere), `stale` (gone), or `unchecked` (not looked at yet). `checkedAt` is the last look. */
    check: z.enum(["valid", "moved", "stale", "unchecked"]), checkedAt: z.number().optional(),
  }).strict(),
  z.object({ kind: z.literal("pr"), url: z.string().url().max(300) }).strict(),
  z.object({ kind: z.literal("task"), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("record") }).strict(),
]);

/** What a lesson waiting for people still needs. */
export const LessonNeedsSchema = z.object({
  /** People in all: 1 (a maintainer), or 2 (a second maintainer or admin, for reviewer, check and security lessons). */
  required: z.union([z.literal(1), z.literal(2)]),
  have: z.number().int().min(0).max(5),
  /** Who approved first, and when. */
  first: LessonPersonSchema.optional(), firstAt: z.number().optional(),
  /** Named groups that must still be among the approvers (Enterprise). */
  groups: z.array(z.string().min(1).max(100)).max(10),
}).strict();

export const LessonViewSchema = z.object({
  id: z.string().min(1).max(64), version: z.number().int().min(1),
  type: LessonTypeSchema, stages: z.array(LessonStageSchema).max(5),
  title: z.string().max(80), description: z.string().max(160), body: z.string().max(600),
  scope: z.object({ repos: z.array(z.string().max(200)).max(10), paths: z.array(z.string().max(200)).max(20), languages: z.array(z.string().max(40)).max(10) }).strict(),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]), tierReasons: z.array(z.string().max(80)).max(12),
  status: LessonViewStatusSchema,
  counters: z.object({ loaded: z.number().int().min(0), helpful: z.number().int().min(0), harmful: z.number().int().min(0) }).strict(),
  createdAt: z.number(), updatedAt: z.number(), expiresAt: z.number(), lastUsedAt: z.number().optional(),
  citations: z.array(LessonCitationViewSchema).max(8),
  /** The people whose words or edits the lesson comes from. */
  from: z.array(LessonPersonSchema).max(20),
  /** Whether the evidence includes a measured outcome (a send-back, a revert or a failed check), and how many tasks back it. */
  measured: z.boolean(), supportTasks: z.number().int().min(0).max(50),
  needs: LessonNeedsSchema.optional(),
  approvals: z.array(z.object({ by: LessonPersonSchema, at: z.number(), mode: z.enum(["one", "second_person", "sole_owner_exception", "auto", "trial"]) }).strict()).max(10),
  /** Live with no approval, on trial for 14 days (approve by exception), or stable after it. Absent: a person approved it. */
  trial: z.enum(["trial", "stable"]).optional(),
  /** Sent back to a person (for example kept on code alone after its sources were deleted), or the lesson it contradicts, or a retire that waits for a person. */
  reviewRequired: z.literal(true).optional(), contradicts: z.string().max(64).optional(), retireProposed: z.literal(true).optional(), supersedes: z.string().max(64).optional(),
  /** The lesson this one may duplicate (kept apart from it, never merged): a person decides to merge, keep both or reject. */
  possibleDuplicate: z.string().max(64).optional(),
  rejectedReason: z.string().max(200).optional(),
  /** What this viewer may do with it, worked out by the server (the routes check again when asked). */
  canApprove: z.boolean(), canReject: z.boolean(), canRetire: z.boolean(),
}).strict();
export type LessonView = z.infer<typeof LessonViewSchema>;

/**
 * A proposal to go back to Standard that waits for a person (lessons leftovers sweep, LT-2). Only people who decide see it: the Lessons tab (`presetProposal`) and the company read below. `mine`: the viewer asked for
 * it. `soleOwner`: the person who asked was the only one who could approve, so only they can (after the short wait the server enforces). The server decides again when someone taps Approve or Cancel.
 */
export const LessonPresetProposalSchema = z.object({ changeId: z.string().min(1).max(100), to: z.enum(["standard", "regulated"]), mine: z.boolean(), soleOwner: z.boolean(), expiresAt: z.number() }).strict();
export type LessonPresetProposal = z.infer<typeof LessonPresetProposalSchema>;

/** A lesson-set version a maintainer can roll back to. */
export const LessonSnapshotSchema = z.object({ setVersion: z.number().int().min(0), at: z.number(), lessons: z.number().int().min(0).max(5_000) }).strict();

export const LessonsViewSchema = z.object({
  project: z.string().min(1).max(100),
  /** The learning mode in force (the stricter of the project's own choice and the company's lock), and whether the company's lock is the reason. */
  mode: LessonLearningModeSchema, lockedByCompany: z.boolean(),
  /** For people who decide: the install's lessons switch is off (or cannot be read), so whatever `mode` says Rovara only collects evidence, writes no lessons and makes no model calls (owner decision 47). Absent: the switch is on, or the viewer does not decide. */
  lessonsSwitchedOff: z.literal(true).optional(),
  /** How many people each tier needs before a lesson is used. */
  approval: z.object({ tier0: z.enum(["auto", "one", "two"]), tier1: z.enum(["one", "two"]), requiredGroups: z.array(z.string().max(100)).max(10) }).strict(),
  expiryDays: z.number().int().min(14).max(365).optional(),
  /** The learning preset in force: Standard (a low-risk lesson from a member's own correction goes live on trial) or Regulated (every lesson needs a person), and whether the company's preset is the reason. */
  preset: z.enum(["standard", "regulated"]), presetLockedByCompany: z.boolean(),
  /** For people who decide: the proposal to go back to Standard that waits for a person. Absent: none. */
  presetProposal: LessonPresetProposalSchema.optional(),
  /** Whether this viewer may approve, reject, retire and roll back. A viewer who may not still reads the active lessons. */
  canDecide: z.boolean(),
  waiting: z.array(LessonViewSchema).max(100), active: z.array(LessonViewSchema).max(200), removed: z.array(LessonViewSchema).max(50),
  /** Candidates collected and not yet in front of people. Nothing is dropped. */
  queued: z.number().int().min(0),
  /** Lessons left out because this viewer cannot see their source (a count, never a name). */
  hidden: z.number().int().min(0),
  /** For people who decide: lessons left out because the task they were learned from is a legacy task with no session item (started before sessions). Absent: none. */
  legacyHeld: z.number().int().min(1).max(100_000).optional(),
  truncated: z.array(z.enum(["waiting", "active", "removed"])).max(3),
  setVersion: z.number().int().min(0), snapshots: z.array(LessonSnapshotSchema).max(20),
  /** Learning cannot run for this project (or its company) right now, and why. Absent: nothing is known to be wrong. */
  paused: LessonsPausedSchema.optional(),
}).strict();
export type LessonsViewAnswer = z.infer<typeof LessonsViewSchema>;
export const LessonsViewReaderSchema = forwardReader(LessonsViewSchema);

export const LessonHistorySchema = z.object({
  versions: z.array(z.object({
    version: z.number().int().min(1), at: z.number(), status: LessonViewStatusSchema, title: z.string().max(80), body: z.string().max(600),
    approvedBy: z.array(LessonPersonSchema).max(10),
  }).strict()).max(50),
}).strict();
export const LessonHistoryReaderSchema = forwardReader(LessonHistorySchema);

const DigestItemSchema = z.object({
  id: z.string().min(1).max(64), title: z.string().max(80), type: LessonTypeSchema, tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  /** Pull request links the lesson came from (https only). */
  links: z.array(z.string().url().max(300)).max(10),
}).strict();
export const LessonsDigestSchema = z.object({
  since: z.number(),
  /** The most important lessons first: measured outcomes, then recurrence, then severity. */
  top: z.array(DigestItemSchema).max(10), needsReview: z.array(DigestItemSchema).max(50), autoApplied: z.array(DigestItemSchema).max(50), waiting: z.array(DigestItemSchema).max(100),
  retired: z.array(DigestItemSchema).max(100), staleOrRetireProposed: z.array(DigestItemSchema).max(100),
  queued: z.number().int().min(0),
  /** Sources paused because they spiked, named only where the viewer can see every lesson that mentions them. */
  pausedSources: z.array(z.string().max(120)).max(50), pausedSourcesHidden: z.number().int().min(0), hidden: z.number().int().min(0),
}).strict();
export const LessonsDigestReaderSchema = forwardReader(LessonsDigestSchema);

// ---- Sources tab

export const LessonSourceRowSchema = z.object({
  kind: z.string().min(1).max(40),
  /** The channel, repository or tracker project. Absent when the source is kept for maintainers only and this viewer is not one. */
  scope: z.string().min(1).max(300).optional(),
  enabled: z.boolean(), retention: z.string().min(1).max(10), notesOptIn: z.literal(true).optional(),
  health: z.enum(["unknown", "ok", "failing"]),
  /** Who may see items from this source when the source gives no list of its own. */
  audience: z.enum(["maintainers", "project"]),
  excluded: z.number().int().min(0).max(200).optional(),
  updatedAt: z.string().max(40),
  /** Paused by spike detection: its lessons wait until a maintainer resumes it. */
  paused: z.boolean(),
}).strict();
export const LessonSourcesSchema = z.object({
  sources: z.array(LessonSourceRowSchema).max(200),
  /** Sources the learning loop paused that match no row above (a person, CI), counted. */
  otherPaused: z.number().int().min(0),
}).strict();
export const LessonSourcesReaderSchema = forwardReader(LessonSourcesSchema);

// ---- the task page: lessons the agent loaded

export const LoadedLessonRowSchema = z.object({
  stage: z.string().min(1).max(40), round: z.number().int().min(0), lessonId: z.string().min(1).max(64), version: z.number().int().min(1),
  why: z.enum(["scope", "similar", "path"]),
  citation: z.enum(["unchecked", "valid", "moved", "stale_dropped", "unchecked_dropped", "none"]),
  /** False when this viewer cannot see the lesson's source: the row then has no words. */
  visible: z.boolean(), title: z.string().max(80).optional(), type: LessonTypeSchema.optional(), helpful: z.number().int().min(0).optional(), harmful: z.number().int().min(0).optional(),
  canMark: z.boolean(),
  /** Live on trial or stable with no approval: the row offers the one-tap thumbs-down. */
  trial: z.enum(["trial", "stable"]).optional(),
}).strict();
/** `canThumbsDown`: the caller has a role in the project and may write, so the task page offers the one-tap thumbs-down only to someone it will work for. Absent (an older broker): offered, and the broker decides. */
export const LoadedLessonsSchema = z.object({ lessons: z.array(LoadedLessonRowSchema).max(500), canThumbsDown: z.boolean().optional() }).strict();
export const LoadedLessonsReaderSchema = forwardReader(LoadedLessonsSchema);

// ---- request bodies

const Reason = z.string().trim().min(1).max(200);
const Text = z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(160), body: z.string().trim().min(1).max(600) }).strict();
/** `expectedVersion` is the version the person read: an approval of text that changed since is refused. */
export const LessonApproveBodySchema = z.object({ expectedVersion: z.number().int().min(1), edit: Text.optional() }).strict();
export const LessonRejectBodySchema = z.object({ expectedVersion: z.number().int().min(1), reason: Reason }).strict();
/** A person merges a lesson kept apart as a possible duplicate into the lesson it may duplicate: `expectedVersion` is the duplicate's version they read. */
export const LessonMergeBodySchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export const LessonRetireBodySchema = z.object({ reason: Reason.optional() }).strict();
export const LessonRollbackBodySchema = z.object({ targetSetVersion: z.number().int().min(0), expectedSetVersion: z.number().int().min(0) }).strict();
/** UX-4b: a maintainer resumes a source the learning loop paused (the source row's kind and place, as the Sources tab lists it). The lessons held while it was paused are settled again; none goes live from here. */
export const LessonResumeSourceBodySchema = z.object({ source: z.string().min(1).max(40), scope: z.string().min(1).max(300) }).strict();
export const LessonResumeAnswerSchema = z.object({ resumed: z.boolean(), settled: z.number().int().min(0) }).strict();
export const LessonResumeAnswerReaderSchema = forwardReader(LessonResumeAnswerSchema);
export const LessonFeedbackBodySchema = z.object({ kind: z.enum(["helpful", "wrong_here", "thumbs_down"]) }).strict();
/**
 * Sets the preset of a project (a maintainer or admin) or of the company (an admin). Regulated applies at once. Standard is a loosening: it opens a proposal that a different maintainer or admin approves
 * (or the only eligible person, through the sole-owner exception), like the tier-0 approval setting.
 */
export const LessonPresetBodySchema = z.object({ preset: z.enum(["standard", "regulated"]) }).strict();
export const LessonPresetChangeBodySchema = z.object({ changeId: z.string().min(1).max(100) }).strict();
/** `needsApproval` with a `changeId`: the change is a proposal waiting for a second person; `preset` is then the value still in force. */
export const LessonPresetAnswerSchema = z.object({ preset: z.enum(["standard", "regulated"]), changed: z.boolean(), needsApproval: z.boolean().optional(), changeId: z.string().min(1).max(100).optional() }).strict();
export const LessonPresetAnswerReaderSchema = forwardReader(LessonPresetAnswerSchema);
/** The company's preset and the proposal waiting on it (an owner or admin reads it). */
export const LessonCompanyPresetSchema = z.object({ preset: z.enum(["standard", "regulated"]), proposal: LessonPresetProposalSchema.optional() }).strict();
export const LessonCompanyPresetReaderSchema = forwardReader(LessonCompanyPresetSchema);

export const LessonApproveAnswerSchema = z.object({ status: z.enum(["active", "pending"]), needs: z.enum(["nothing", "second_person", "group_member"]) }).strict();
export const LessonApproveAnswerReaderSchema = forwardReader(LessonApproveAnswerSchema);
export const LessonDoneAnswerSchema = z.object({ done: z.literal(true) }).strict();
export const LessonDoneAnswerReaderSchema = forwardReader(LessonDoneAnswerSchema);
export const LessonRollbackAnswerSchema = z.object({ setVersion: z.number().int().min(0), restored: z.number().int().min(0) }).strict();
export const LessonRollbackAnswerReaderSchema = forwardReader(LessonRollbackAnswerSchema);
